# Codex Turn Loop：Session、TurnContext 与采样循环

> 研究版本：`code/codex@28aacbb`

## 1. 结论

Codex 的主循环不是一个裸 `while tool_calls`。`Session` 持有 thread 级长期状态，`TurnContext` 冻结本轮配置与环境快照，task 负责不同类型工作，`run_turn()` 才驱动普通用户轮次中的多次模型采样。模型事件、工具执行、持久化和客户端通知在同一轮中协作，但由不同模块负责。

## 2. 对象与生命周期

| 对象 | 生命周期 | 主要职责 |
|---|---|---|
| `CodexThread` | 一个可由客户端持有的 thread | 对外 submit/事件订阅，包装内部 session |
| `Session` | thread runtime | history、rollout、active task、配置、MCP、环境和事件发送 |
| `TurnContext` | 一次 turn | model、cwd、权限、sandbox、tools、环境、feature 与 telemetry 快照 |
| `RegularTask` | 一次普通任务 | 调用 `run_turn()` 并处理 task 生命周期 |
| sampling step | 一次模型请求 | request input、stream、tool calls 和 post-sampling state |

源码入口分别见 [`codex_thread.rs`](../../code/codex/codex-rs/core/src/codex_thread.rs)、[`session/session.rs`](../../code/codex/codex-rs/core/src/session/session.rs)、[`session/turn_context.rs`](../../code/codex/codex-rs/core/src/session/turn_context.rs)、[`tasks/regular.rs`](../../code/codex/codex-rs/core/src/tasks/regular.rs) 和 [`session/turn.rs`](../../code/codex/codex-rs/core/src/session/turn.rs)。

`TurnContext` 的关键价值是隔离并发配置变化：本轮开始后，model、cwd、approval、sandbox 和环境选择不能随着全局配置被悄悄替换。需要改变后续行为时，客户端通过 thread settings/新 turn 形成新的 context。

## 3. 从用户输入到 task

```text
client submit Op
  → CodexThread / Session handlers
  → 验证当前 active task 与输入类型
  → 构造 TurnContext
  → spawn RegularTask
  → run_turn(session, turn_context, input)
```

Session 的 handler 不只处理普通 user input，还处理 interrupt、compact、review、user shell、steer、配置更新和 elicitation response。不同操作映射到不同 task 或直接更新 session；不能把所有 `Op` 都理解为“发一次模型请求”。相关分派见 [`session/handlers.rs`](../../code/codex/codex-rs/core/src/session/handlers.rs) 与 [`tasks`](../../code/codex/codex-rs/core/src/tasks)。

## 4. `run_turn()` 阶段

[`run_turn()`](../../code/codex/codex-rs/core/src/session/turn.rs) 大致分为：

1. 记录 `TurnStarted`，把输入和 `TurnContextItem` 写入历史/rollout。
2. 处理 turn 前 compaction、上下文预算和需要注入的项目规则/环境信息。
3. 创建本轮 sampling step，准备模型请求输入与可见工具规格。
4. 调用 `ModelClientSession.stream()` 消费 Responses 事件。
5. 固化 assistant/reasoning/output items；发现 function/custom tool call 时交给 tool runtime。
6. 等待本 step 的工具完成，把 tool outputs 写入会话。
7. 若模型仍需继续，则以更新后的 history 开始下一 sampling step。
8. 无待处理工具时执行 stop hooks，并根据 hook 结果完成、阻止或继续。
9. 发送 `TurnComplete`；异常/interrupt 则发送错误或 `TurnAborted`。

```text
Turn
 ├─ Step 1: model stream → tool calls
 ├─ tools: approval → sandbox → execution → outputs
 ├─ Step 2: model stream → assistant text
 └─ stop hooks → complete/continue/block
```

## 5. 历史与事件不是同一数据集

模型 history 只包含下次采样需要的 Responses input items；客户端事件还包含 progress、approval、hook、token usage、environment 和 terminal lifecycle。`EventMsg` 中存在并不表示一定会回放给模型。

`Session` 发送事件时还要决定是否持久化为 `RolloutItem`。用户消息、raw response item、turn context 与 terminal event 对重建有意义；纯 UI 增量或可重新派生的通知可能采用不同策略。完整恢复应走 rollout reconstruction，而不是把客户端事件数组直接当 prompt。

## 6. Steering 与 Interrupt

Steer 是把新输入排入活动 turn 可消费的安全边界，不等于修改已经发送的 HTTP/WebSocket request。当前 sampling 完成或 loop 到达检查点后，新输入才能进入后续请求。Interrupt 则取消 active task，并要求产生明确的 `TurnAborted` 终态。

测试特别验证 interrupted、replaced 与 shutdown 等 abort reason，以及 interrupt 后 raw response item 的保存顺序，见 [`session/tests.rs`](../../code/codex/codex-rs/core/src/session/tests.rs)。因此客户端不应只凭连接断开推断 turn 结束。

## 7. Compaction 与上下文窗口

turn 前预检查位于 [`session/context_window.rs`](../../code/codex/codex-rs/core/src/session/context_window.rs) 和 `turn.rs` 相关函数。达到阈值时可先执行 compaction task，再开始正常 sampling step。远程/本地 compaction 有不同实现，摘要会成为新的模型上下文事实，但原始 rollout 仍用于审计。

上下文预算还受工具 schema、system instructions、项目规则和图片影响，不能只用消息文本 token 判断。模型返回 context overflow 时也可能触发恢复策略；它和主动阈值 compaction 是不同路径。

## 8. 终止与失败语义

- 正常完成：没有待执行工具，stop hooks 允许结束，发送 `TurnComplete`。
- 用户中断：取消 task，发送 `TurnAborted(Interrupted)`。
- 模型/传输错误：按错误类型重试；耗尽后发 `Error` 并结束 task。
- 工具拒绝/失败：通常作为 tool output 回给模型，由模型决定下一步；不一定终止 turn。
- stop hook 阻止：将 hook 反馈加入上下文后继续，受连续阻止上限约束。
- 上下文溢出：可能 compact/retry，也可能变成 terminal error。

## 9. 推荐阅读顺序

1. [`session/turn.rs`](../../code/codex/codex-rs/core/src/session/turn.rs) 的 `run_turn()`。
2. [`session/session.rs`](../../code/codex/codex-rs/core/src/session/session.rs) 的状态与持久化方法。
3. [`tasks/regular.rs`](../../code/codex/codex-rs/core/src/tasks/regular.rs) 和 [`tasks/lifecycle.rs`](../../code/codex/codex-rs/core/src/tasks/lifecycle.rs)。
4. [`session/turn_context.rs`](../../code/codex/codex-rs/core/src/session/turn_context.rs)。
5. [`client.rs`](../../code/codex/codex-rs/core/src/client.rs) 的 `ModelClientSession::stream()`。
6. [`session/turn_tests.rs`](../../code/codex/codex-rs/core/src/session/turn_tests.rs) 与 `session/tests.rs` 的 terminal event 测试。
