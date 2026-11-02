# OpenCode：Session 执行、持久化准入与插件分层

> 本轮复核：2026-11-02；本地源码 `67139d6827af3a337c80472c33f9cb7c6c2ce500`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 当前架构与旧笔记的变化

当前源码已把原来的 `packages/opencode` 拆分为 `packages/core`、`packages/cli`、`packages/server`、`packages/ai` 等包。原来的 `SessionPrompt.loop()`、`SessionProcessor` 与 `packages/llm` 不能继续作为当前版本的入口；本篇按现行 Session 服务重建调用链。

```text
CLI / TUI / Client → Server
  → Session 服务：记录输入与事件
  → SessionInbox / SessionStore
  → SessionExecution：进程内所有权与唤醒
  → SessionRunner.drain：消费已持久化工作
  → SessionStep：模型请求、工具结算、重试与压缩
  → Event / Store / Projection → 客户端
```

## 核心抽象

| 对象 | 源码 | 职责 |
| --- | --- | --- |
| Session | [session.ts](../../code/opencode/packages/core/src/session.ts) | 会话服务边界 |
| SessionPrompt | [prompt.ts](../../code/opencode/packages/core/src/session/prompt.ts) | prompt hook、附件与 Skill 材料准备 |
| SessionInbox | [inbox.ts](../../code/opencode/packages/core/src/session/inbox.ts) | 输入准入及下一轮/steer 工作 |
| SessionExecution | [execution.ts](../../code/opencode/packages/core/src/session/execution.ts) | resume、wake、interrupt、awaitIdle |
| SessionRunner | [runner/index.ts](../../code/opencode/packages/core/src/session/runner/index.ts) | 从已记录历史继续执行 |
| SessionStep | [runner/step.ts](../../code/opencode/packages/core/src/session/runner/step.ts) | 单次尝试、模型事件与工具结果 |
| SessionStore | [store.ts](../../code/opencode/packages/core/src/session/store.ts) | 持久化会话状态及执行 claim |
| AI | [ai/llm.ts](../../code/opencode/packages/ai/src/llm.ts) | 模型请求与协议抽象 |

## 执行所有权与恢复

`SessionExecution` 明确区分进程内活跃执行与数据库中的执行意图。`resume()` 在空闲时开始，已有执行时加入；`wake()` 可以合并重复唤醒。`interrupt()` 只表示中断已被接受，结算异步完成，需要等待空闲时还要调用 `awaitIdle()`。

执行开始时，在记录 started event 的同一事务中写入 claim。普通终态释放 claim；shutdown interruption 保留它，下一次启动据此恢复。没有 terminal 的残留 claim 也是异常退出的证据，因此恢复不依赖 shutdown hook 一定执行。

这并不保证外部工具副作用 exactly-once。数据库事件、工具结果和文件/网络副作用仍有不同原子性边界，恢复时应查看具体工具和 Step 的结算逻辑。

## Runner 与错误处理

Runner 的 `drain()` 消费已经记录的工作，并可返回 Complete、Moved 或 Reloaded。后两者说明执行可能需要在新的 Location 继续，不能把进程内循环当作整个 Session 生命周期。

`SessionStep.Outcome` 区分 Completed、Retry、Continue、RecoverFull、Compacted 和 OutputLimit。工具失败与整个 step 失败、重试与压缩恢复因此是不同分支。模型已经产生可持久化输出后，重试必须考虑已发生的工具和消息事实。

## 工具、权限和压缩

工具运行时见 [tool/runtime.ts](../../code/opencode/packages/core/src/tool/runtime.ts)，Shell 工具见 [tool/plugin/shell.ts](../../code/opencode/packages/core/src/tool/plugin/shell.ts)。Shell 同时处理参数、工作目录、权限、超时、后台任务及截断输出；它不是直接把模型文本交给 `exec()`。

压缩由 [compaction.ts](../../code/opencode/packages/core/src/session/compaction.ts) 管理，包含摘要和 native compaction 等策略。压缩产生的模型可见历史与原始事件记录是不同层次，不能用一次请求的 messages 当作完整会话审计。

## 验证材料与阅读顺序

先读 Session、Execution、Runner 和 Step，再读工具及压缩。回归材料包括 [工具事件测试](../../code/opencode/packages/core/test/session-runner-tool-events.test.ts)、[重试测试](../../code/opencode/packages/core/test/session-runner-retry.test.ts) 和 [native compaction 测试](../../code/opencode/packages/core/test/session-native-compaction.test.ts)。本轮阅读这些测试，未执行。

专题：[模型 API 适配](./model-api-adaptation.md)、[跨平台适配](./cross-platform-adaptation.md)。
