# Goose：平台服务、SessionRuntime 与状态机执行

> 本轮复核：2026-11-02；本地源码 `0909288ed4a2053b10540bfcf6dbee3b0de66126`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 当前源码变化

旧的 `crates/goose/src/agents/agent.rs` 已拆除。当前入口 [agents/mod.rs](../../code/goose/crates/goose/src/agents/mod.rs) 导出 GoosePlatform、StateMachineServices、SessionRuntime、ActiveRunRegistry 等对象，执行主线应从平台服务及状态机装配阅读。

```text
CLI / Desktop / Server
  → GoosePlatform / SessionRuntime
  → active run + steer + confirmation
  → state machine builder
  → 模型请求 / tool calling / compaction
  → 会话存储与 AgentEvent
```

## 关键对象

| 对象 | 源码 | 职责 |
| --- | --- | --- |
| Platform / Services | [services.rs](../../code/goose/crates/goose/src/agents/services.rs) | Provider、工具、会话和执行依赖组合 |
| SessionRuntime | [session_runtime.rs](../../code/goose/crates/goose/src/agents/session_runtime.rs) | 连接 attachment、常驻会话、steer 与确认 |
| ActiveRunRegistry | [active_run.rs](../../code/goose/crates/goose/src/agents/active_run.rs) | 活跃 run 的所有权与状态 |
| 状态机装配 | [state_machine_builder.rs](../../code/goose/crates/goose/src/agents/state_machine_builder.rs) | 构建运行依赖与状态机 |
| Tool calling | [ops_toolcalling.rs](../../code/goose/crates/goose/src/agents/state_machine/ops_toolcalling.rs) | 工具调用、检查、事件和结果 |
| Extensions | [extension_manager](../../code/goose/crates/goose/src/agents/extension_manager) | MCP/扩展客户端管理 |

## Session 不是一份消息数组

SessionRuntime 记录哪些客户端打开会话、谁是当前 attachment、待消费 steer、工具确认和当前 run。它按 LRU 管理常驻会话，但忙碌会话不被淘汰；所有其他会话都忙时，可以暂时超过配置上限。

因此 max_sessions 是常驻容量策略，不能等同于立即拒绝超额请求的并发硬上限。连接生命周期、模型历史和运行任务也各有独立状态。

## 工具与扩展

MCP/Extension 仍是关键扩展面，但模型工具 schema 还会经过归一化、权限检查和结果大小处理。工具进度、确认及完成结果要通过状态机回到会话，不能将 MCP 返回的任意消息都当作一次成功工具结果。

相关实现可继续看 [tool_execution.rs](../../code/goose/crates/goose/src/agents/tool_execution.rs)、[tool_schema_normalize.rs](../../code/goose/crates/goose/src/agents/tool_schema_normalize.rs) 和 [large_response_handler.rs](../../code/goose/crates/goose/src/agents/large_response_handler.rs)。Hooks 与 Recipe 分别提供运行阶段扩展和可重用任务配置。

## Provider、Recipe 和调度边界

模型适配位于 [providers](../../code/goose/crates/goose/src/providers)；Recipe 位于 [recipe](../../code/goose/crates/goose/src/recipe)。调度器已在 [scheduler](../../code/goose/crates/goose/src/scheduler) 目录，并有 feature gate；不能把某个可选构建能力描述成所有发行配置都必然启用。

## 推荐阅读与限制

从 agents/mod、services、SessionRuntime、builder 进入，再读状态机各 operation 与 ExtensionManager。测试材料集中在 [goose tests](../../code/goose/crates/goose/tests)。本轮未运行 Rust 构建或 MCP 服务；当前平台对象与旧 `Agent.reply()` 讲解不应混用。
