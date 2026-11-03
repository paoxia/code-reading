# Codex 源码分析

## 2026-11-02 复核与当前定位

- 本地源码：`aef7d276a4518ad9cb2805a8ddc634eef6f3e7dc`（提交日期 2026-11-02）。
- 核对方式：本地源码、调用入口与测试材料静态阅读；未运行上游构建或测试。下文早期日期与版本号保留作研究历史，本节记录本轮基线与修订边界。

当前主线仍由 Core Thread/Turn、工具路由与 App Server 分层构成。工具 handler 已出现命名迁移，异步用户消息的现行路径是 send_message_to_user_async.rs；Rollout 恢复和产品 JSON-RPC 不能被等同于单一模型消息流。

当前入口：[codex-rs/core/src/session/session.rs](../../code/codex/codex-rs/core/src/session/session.rs)、[codex-rs/core/src/tools/handlers/send_message_to_user_async.rs](../../code/codex/codex-rs/core/src/tools/handlers/send_message_to_user_async.rs)。

> 当前笔记以本地 `code/codex` 为依据。仓库演进很快，各专题标注的源码版本优先于产品层泛化描述。

## 专题笔记

- [Codex Open Agent Harness](./agent-harness-platform.md)：2026-08-19 平台化发布、核心架构、Codex SDK/app-server 集成层，以及与 Agents SDK、AgentKit 的边界。
- [Turn Loop](./turn-loop.md)：Session、TurnContext、sampling step、steering、compaction 与终止语义。
- [Tool Runtime](./tool-runtime.md)：工具规格规划、registry/router、审批、沙箱、并发与 MCP/Extension。
- [Rollout](./rollout.md)：JSONL canonical items、恢复、rollback/fork、SQLite 投影与崩溃边界。
- [App Server](./app-server.md)：JSON-RPC initialize gate、thread/turn processors、事件投影和多连接生命周期。
- [大模型 API 差异适配](./model-api-adaptation.md)：Provider 配置、认证、Responses 请求、SSE/WebSocket、重试与 Bedrock 特例。
- [Windows、Linux 与 macOS 跨平台适配](./cross-platform-adaptation.md)：发行包选择、统一沙箱策略及三类平台执行隔离。

## 当前覆盖与缺口

现有专题已经覆盖 Core turn loop、tool runtime、rollout、app-server、模型接入和跨平台安全。仍可继续拆分 MCP/Skills/Plugins、multi-agent、compaction 和 Guardian；这里明确记录缺口，避免把“尚未形成笔记”误读成源码不存在对应能力。
