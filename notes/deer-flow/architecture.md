# DeerFlow 2.0 深度架构与执行链分析

> 原始研究版本：`main@c542185a7f71`
>
> 2026-08-24 增量复核版本：`main@cc6a2657e7ba`
>
> 本文只描述当前 2.0 主线已落地的实现。`docs/plans/`、RFC 和 `TODO` 中尚未进入主链的内容不作为现状。

## 1. 从“Agent 框架”到“长任务运行平台”

DeerFlow 的核心 Agent 并不庞大：[`make_lead_agent()`](../../code/deer-flow/backend/packages/harness/deerflow/agents/lead_agent/agent.py) 最终仍调用 LangChain `create_agent()`。复杂性主要来自 Agent 外围的运行保障：Gateway 接收请求、RunManager 争抢执行权、Worker 构造运行上下文、Checkpointer 恢复线程状态、Middleware 改写模型与工具阶段、StreamBridge 发布事件，最后再把产物和交付信息固化。

本轮新增 managed subagent store、delegation scope、tool receipt ledger 与 sandbox acquisition authorization，进一步强化“运行控制层决定所有权和审计，Agent 能力层执行模型循环”的分层；`make_lead_agent()` 仍是装配入口，没有被新的独立 orchestrator 取代。

因此，理解 DeerFlow 应分成三层：

```text
产品接入层：Frontend / Gateway / IM Channels / Nginx
运行控制层：RunManager / Worker / Checkpointer / EventStore / StreamBridge
Agent 能力层：Lead Agent / Middleware / Tools / Sandbox / Skills / Sub-Agent / Memory
```

只读 `lead_agent/agent.py` 会低估 Run 恢复、并发所有权和事件交付；只读 Gateway 则看不到模型循环如何被 Middleware 改写。

## 2. 服务与进程拓扑

默认入口是 Nginx `:2026`。页面请求进入 Next.js，普通 API 与 LangGraph-compatible API 进入同一个 FastAPI Gateway。Gateway 内嵌 Agent Runtime，而不是再启动一个独立 LangGraph Server。

```text
                         ┌──────── Frontend :3000
Client → Nginx :2026 ────┤
                         └──────── Gateway :8001
                                      │
                         ┌────────────┼────────────┐
                         ▼            ▼            ▼
                    REST Routers  Run Runtime  IM Channels
                                      │
                         Checkpoint / Event / Stream
                                      │
                              optional Redis/DB
```

这个部署结构的收益是前端、SDK 与消息渠道共享同一 Run 语义；代价是 Gateway 同时承担控制面和长任务数据面，生产配置必须认真处理进程重启、Redis 桥接、数据库存储与 worker ownership。

## 3. RunManager：运行生命周期而非简单 Task Map

[`RunManager`](../../code/deer-flow/backend/packages/harness/deerflow/runtime/runs/manager.py) 管理 `RunRecord`。记录中不只包含状态，还包含 thread、assistant、模型、输入、流模式、取消策略、worker identity、heartbeat 和持久化版本等信息。

概念上的状态流为：

```text
pending/queued
      │ claim + ownership
      ▼
   running ───── cancel request ────┐
      │                             │
      ▼                             ▼
 finalizing                    cancelling
      │                             │
      └──────────┬──────────────────┘
                 ▼
       completed / failed / cancelled
```

具体枚举和转换以 [`runs/schemas.py`](../../code/deer-flow/backend/packages/harness/deerflow/runtime/runs/schemas.py) 与 Manager 方法为准。Manager 的关键职责包括：

- 创建 Run，并阻止同一 thread 出现不允许的并行 active run；
- 为执行进程分配 worker ID，并通过 lease/heartbeat 判断所有权；
- 将内存 task 与持久记录协调，处理重启后的孤儿 Run；
- 发布状态变化，同时容忍部分非关键持久化失败；
- 将 cancellation 映射为中断、回滚或保留现状等策略；
- 对可重试存储错误应用有界退避，而不是无限重试。

这里的核心不变量是“只有当前 owner 可以提交该 Run 的终态”。若 worker 已失去 lease，即便后台协程最终返回，也不能覆盖新 owner 或恢复流程写入的状态。

## 4. `run_agent()` 的阶段拆解

主 Worker 在 [`runtime/runs/worker.py`](../../code/deer-flow/backend/packages/harness/deerflow/runtime/runs/worker.py)。函数很长，但可以按责任拆成以下阶段：

### 4.1 建立运行资源

Worker 取得 checkpointer、store、event store、stream bridge、extension task store 和 frozen app config。配置在 Run 开始时冻结，避免一次长任务执行过程中读取到互相矛盾的热更新值。

### 4.2 发布元数据并安装 Runtime Context

Worker 先发布包含 `run_id`、`thread_id` 的 metadata 事件。随后 `_build_runtime_context()` 组装 thread、run、user、authorization、task store 等上下文，并手动安装进 RunnableConfig/LangGraph `Runtime`。

这是因为当前执行路径直接驱动 `agent.astream()`，不能依赖 langgraph-cli 自动注入 context。工具和 Middleware 从同一 Runtime Context 获取用户身份、线程目录和内部服务。

### 4.3 构造 Agent

Worker 在 extension build binding 中调用 Agent Factory。Factory 解析实际 Agent 配置、模型、Skills 和 Middleware，然后创建 LangGraph Runnable。模型名还会在构建后回写 Run 元数据，避免“请求模型”和授权回退后的“实际模型”不一致。

### 4.4 捕获回滚点与处理 Resume

如果启用 Checkpointer，Worker 在修改线程前捕获 `RollbackPoint`：它包含物化消息、checkpoint config 和 pending writes。仅保存原始 checkpoint blob 不够，因为 delta channel 模式可能不在 blob 中保存完整 `channel_values`。

从旧 checkpoint 恢复在语义上是一次 fork。Worker 会把 delta fork 线性化到当前 head，防止废弃 sibling 的 writes 被错误物化回来。捕获失败时宁可禁用回滚，也不会用不完整快照截断线程历史。

### 4.5 流式执行与事件转换

Agent 的 LangGraph stream item 经 `_unpack_stream_item()` 和 `_publish_stream_item()` 转换为 SSE。根图和 Subgraph namespace 被保留：子 Agent 的 `values|namespace` 不能伪装成根 `values`，否则客户端会用子图快照替换整个 thread view。

大文件工具参数增量会被 `_LargeFileToolChunkBatcher` 有界合并，降低 SSE 事件量；仅订阅 messages 的旧消费者仍保留原始逐 chunk 行为。

### 4.6 最终化、交付和失败恢复

执行结束后，Worker 汇总输出文件、token、duration 和 delivery receipt。取消或 edit replay 失败时，它可以使用预先捕获的 rollback point 恢复 checkpoint，并重新发布恢复后的 values，让客户端视图与持久状态重新一致。

## 5. Lead Agent 的构建决策

[`_make_lead_agent()`](../../code/deer-flow/backend/packages/harness/deerflow/agents/lead_agent/agent.py) 先合并 `configurable` 与 `context`，再按照请求覆盖、自定义 Agent 配置、全局默认的优先级解析选项。

模型选择还经过授权过滤：

```text
requested model
  → 是否存在，否则回退默认模型
  → authorization model:use
  → 被拒绝时尝试第一个可见且可使用模型
  → fail_closed 下无候选则拒绝 Run
```

Tool 也经过类似授权过滤。这里不是仅隐藏 UI 列表，而是在 Agent 构建路径再次执行使用权限，防止绕过 Gateway 列表 API 直接提交 model/tool 名称。

## 6. Middleware 链与顺序语义

[`build_middlewares()`](../../code/deer-flow/backend/packages/harness/deerflow/agents/lead_agent/agent.py) 根据模型能力、Plan Mode、Memory 和扩展配置创建 Middleware。链中存在几类不同责任：

| 阶段 | 代表实现 | 作用 |
|---|---|---|
| 线程准备 | thread data、uploads、sandbox | 建立工作目录、上传文件和执行环境 |
| 请求上下文 | memory、skills、summarization | 注入长期知识并压缩历史 |
| 行为控制 | todo、subagent limit、loop detection | 限制委托数量和重复循环 |
| 工具安全 | tool error、output budget、authorization | 规范化错误、限制输出和过滤能力 |
| 响应修复 | safety/length finish reason、terminal response | 将异常停止转换为可理解的最终结果 |
| 观测 | token usage、title、tracing | 记录成本和会话元数据 |

Middleware 并非无序订阅者。例如 summarization 必须在模型请求前改变消息；Sandbox wrapper 必须在工具返回后把 lazy acquire 的 ID 写入 LangGraph state；TerminalResponse 需要观察完整执行结果。调整顺序会改变状态归约和错误处理。

## 7. ThreadState 与 reducer

[`ThreadState`](../../code/deer-flow/backend/packages/harness/deerflow/agents/thread_state.py) 扩展 `AgentState`，包含 sandbox、artifacts、todos、goal、delegations、promoted tools、skill context 和 viewed images 等字段。

字段不是简单的 last-write-wins：

- `merge_artifacts` 去重并保留顺序；
- `merge_viewed_images` 按路径合并；
- `merge_delegations` 根据委托 identity 更新状态；
- `merge_skill_context` 规范化 Skill 条目；
- `merge_message_writes` 支持 delta 写入、替换、删除和周期性完整 snapshot。

`get_thread_state_schema()` 根据 checkpoint channel mode 选择普通或 Delta schema。Delta 模式降低重复保存完整消息历史的成本，但让恢复、fork 和 rollback 更复杂，这也是 Worker 中存在专门线性化逻辑的原因。

## 8. Sandbox 生命周期的细节

[`SandboxMiddleware`](../../code/deer-flow/backend/packages/harness/deerflow/sandbox/middleware.py) 支持 eager 和 lazy acquisition。默认 lazy 模式在第一次相关工具调用时才创建环境，避免纯对话请求付出容器启动成本。

难点在于 Sandbox Tool 的初始化函数会先修改当前 `runtime.state`，但这类直接 mutation 不一定被 LangGraph reducer 捕获。Middleware 因此包装 tool call：

```text
读取调用前 sandbox_id
  → 执行 Tool Handler
  → 若本次刚创建 sandbox
  → 把 ToolMessage 包装成 Command(update={sandbox, messages})
  → 交给 LangGraph 正式归约
```

对于本来就返回 `Command` 的工具，它合并 `sandbox` update，并保留 messages、goto、graph、resume 等字段。若 update 不是可理解的 dict，则不擅自覆盖，避免静默丢数据。

Fork 恢复的 Sandbox 还有特殊所有权：子线程回放父线程 sandbox state 时，结束后不能释放父线程的 warm sandbox。

## 9. Sub-Agent 并发模型

[`SubagentExecutor`](../../code/deer-flow/backend/packages/harness/deerflow/subagents/executor.py) 使用隔离 event loop 和 thread pool 驱动后台 Sub-Agent。每个执行有 `SubagentResult`，终态包括 completed、failed、cancelled 和 timed_out。

关键并发保护包括：

- `task_id` 是服务器 execution ID，`external_task_id` 只用于 Provider/UI 关联；
- `try_set_terminal()` 在锁下只允许一次终态转换；
- timeout/cancel 与正常 worker race 时，失败的一方不能覆写结果；
- token collector 在运行中发布累计快照，终态时一次性固化；
- Registry 清理使用服务器 ID，避免不同 Run 的重复 tool call ID 串扰；
- Sub-Agent 继承受控的 thread data、sandbox 和授权属性，而不是复制全部父 Runtime 内部对象。

Sub-Agent 的可用工具会按 Agent config 过滤，且受单 Run 总数、并发、turn/token/loop cap 限制。被 cap 结束并不总等同 failed：如果已有可用部分结果，可保持 completed 并在 `stop_reason` 标注截断原因。

## 10. Memory、Skills 与 Context Engineering

Memory 与 Skills 的生命周期不同：Memory 是跨 Turn/Thread 的事实检索与更新，Skill 是按需加载的工作流说明和资源包。

Skills 先以精简 catalog 暴露，模型需要时再读取 `SKILL.md` 和资源，实现 progressive disclosure。安装链还包含 frontmatter 校验、路径权限、安全扫描和 review；但通过扫描不代表代码天然可信，Operator Extension 与可执行 Skill 仍应作为受信代码管理。

Memory Manager 抽象多种后端。内置 DeerMem 将消息过滤、事实抽取、检索、合并和陈旧性审查拆分。不同后端只共享高层接口，并不保证召回、删除、一致性和隐私语义完全相同。

## 11. 可靠性与安全边界

| 风险 | 当前措施 | 剩余注意点 |
|---|---|---|
| Gateway/worker 重启 | 持久 Run、lease、checkpoint、event store | 内存 provider 只适合单进程开发 |
| 同线程并发执行 | active Run admission 与 DB 约束 | 自定义存储实现必须保持原子性 |
| 取消导致状态半写 | rollback point、pending writes、恢复事件 | snapshot 捕获失败会禁用安全回滚 |
| Host 命令执行 | Sandbox Provider、默认关闭不安全 local bash | Local Provider 不构成安全隔离 |
| 扩展越权 | Operator-controlled plugin 配置、授权过滤 | Python Extension 与 Hook 拥有 Gateway 权限 |
| Sub-Agent 泄漏 | 数量/cap/timeout/cancel/registry cleanup | 长任务仍需设置资源预算 |
| 模型错误终止 | finish-reason Middleware 与 fallback message | Provider 返回格式异常仍需适配层处理 |

## 12. 测试证据与推荐验证

源码结论应结合 `backend/tests/`：优先搜索 `run_manager`、`worker`、`checkpoint`、`sandbox_middleware`、`subagent`、`stream` 和 `authorization`。这些测试覆盖的不是单纯 happy path，而是 lease 丢失、重复终态、恢复旧 checkpoint、namespace stream、lazy sandbox persistence 和取消竞争。

推荐阅读路径：

```text
gateway thread_runs router
  → RunManager.create/start
  → runs/worker.run_agent
  → lead_agent.make_lead_agent
  → middleware + ThreadState reducers
  → agent.astream
  → stream bridge + event store
  → finalization / rollback / delivery
```
