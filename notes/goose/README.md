# Goose：MCP-first 本地 Agent 架构

> 原始研究版本：`aaif-goose/goose main@5f4b7cc`（2026-08-14）
>
> 2026-08-19 增量复核版本：`main@9f941fbfc5f4`（Desktop `1.47.0`）
>
> 2026-08-24 增量复核版本：`main@2eb3ab1001de`（Desktop `1.47.0`）

## 研究范围

Goose 是 Rust 实现的本地可扩展 Agent。本文重点分析它如何把 Provider、MCP Extension、Recipe、Skills、会话和多入口组织到同一个运行时中。当前源码仍处于快速演进期，并同时保留传统 `Agent` 与新的状态机抽象，阅读时需要区分现行调用路径和迁移中的结构。

增量版本没有切换这条主链，但补强了多入口能力：CLI `--with-extension`
现在可显式指定 extension 名称，Desktop 在聊天输入区显示并可操作当前 Git 分支，并发 subagent 的通知也改为按调用隔离。Recipe 参数值同时增加校验，不应再把 UI 输入当成已可信的 recipe 参数。

2026-08-24 的更新集中在可审计工具生命周期与可见性：Hook 新增 `PreToolUseResult`，同一个稳定 `tool_call_id` 会贯穿调用生命周期；Code Mode 会遵守 MCP tool 的 model visibility，Skill discovery 也必须遵守 plugin enablement。实现和测试见 [`hooks/mod.rs`](../../code/goose/crates/goose/src/hooks/mod.rs)、[`ops_toolcalling.rs`](../../code/goose/crates/goose/src/agents/state_machine/ops_toolcalling.rs) 与 [`hooks_lifecycle.rs`](../../code/goose/crates/goose/src/agents/state_machine/tests/hooks_lifecycle.rs)。Provider 侧新增多种 declarative gateway，并补充 GPT-5.6 Responses follow-up，但 `Agent → Provider/Extension/Session` 主拓扑未改变。

## 整体架构

```text
CLI / Desktop / ACP / Gateway / Scheduler
                  │
             AgentManager
                  │
                Agent
      ┌───────────┼────────────┐
      │           │            │
  Provider    Extensions    Session
                  │            │
             MCP clients    persistence
      │
  context management / permission / hooks
```

核心 crate 分工如下：

| Crate | 职责 |
|---|---|
| [`crates/goose`](../../code/goose/crates/goose) | 产品级 Agent、会话、扩展、Recipe、权限、ACP 和调度 |
| [`crates/goose-agent`](../../code/goose/crates/goose-agent) | 可组合 Operation/Effect 状态机 |
| [`crates/goose-mcp`](../../code/goose/crates/goose-mcp) | 内置 MCP Server 与运行支持 |
| [`crates/goose-providers`](../../code/goose/crates/goose-providers) | Provider 实现 |
| [`crates/goose-provider-types`](../../code/goose/crates/goose-provider-types) | 跨 Provider 会话与消息格式 |
| [`crates/goose-sdk`](../../code/goose/crates/goose-sdk) | SDK/ACP 接口 |

## Agent Loop

产品级入口是 [`Agent`](../../code/goose/crates/goose/src/agents/agent.rs)。`reply()` 接收用户消息、Session 配置和取消令牌，组装 Provider、Extensions、Prompt、权限与上下文管理，然后持续处理模型输出和工具请求。

新抽象位于 [`goose-agent/src/machine.rs`](../../code/goose/crates/goose-agent/src/machine.rs)：

```text
StateMachine.run()
  → load(session)
  → 依次尝试 Operation / Inference
  → 第一个 Applied 结果产生 Effects
  → EffectHandler.apply_effects()
  → 重新加载持久化 Session
  → 直到无步骤可应用或 yield_to_client
```

`Operation` 定义在 [`operation.rs`](../../code/goose/crates/goose-agent/src/operation.rs)。每个操作可以贡献工具、Prompt 片段和消息元数据，并返回显式 Effect。它强调重放：已经完成的动作应记录在消息 metadata 中，使从持久化 Conversation 重建的管线得到同样判断。

当前 `crates/goose/src/agents/state_machine`](../../code/goose/crates/goose/src/agents/state_machine) 已有 Provider、Tool、Compaction、Hook、Skill 等生命周期测试，但旧 `Agent` 仍承担大量装配逻辑。因此状态机应标为正在落地的架构方向，而不是已完全替代旧实现。

### 现行 `Agent.reply()` 的阶段划分

[`agent.rs`](../../code/goose/crates/goose/src/agents/agent.rs) 体量很大，适合按控制阶段阅读：

1. `reply()` 建立 tracing/错误边界并进入 `reply_impl()`，后者处理 session 级准备与生命周期 hook。
2. `prepare_reply_context()` 装配 Provider、模型配置、项目 instructions、extension tools、permission 与 prompt，形成 `ReplyContext`。
3. `reply_internal()` 持续处理推理流、工具请求、steering、compaction、retry 和终止。
4. `categorize_tools()` 区分前端工具、Extension 工具与平台工具；`handle_approved_and_denied_tools()` 把权限决定映射回调用结果。
5. `dispatch_tool_call()` 路由单次调用，pre/post tool hooks 与 inspection manager 包围实际执行。
6. 完成后 usage 附加到最后一个 assistant message，session 与 extension state 分别持久化。

`steer()` 写入 session 对应的 `SteerQueue`，loop 在安全边界消费；它不会并发篡改已经提交给 Provider 的输入。空响应、输出上限、拒答、transient error 和 hook block 也有不同 retry 语义。测试 `zero_content_output_limit_is_persisted_without_empty_response_retry`、`refusal_exits_turn_without_recipe_retry` 与 `stop_hook_block_cap_*` 覆盖了这些边界。

### 新状态机的执行合同

`StateMachine.step()` 依声明顺序检查 `Step::Operation`/`Step::Inference`，第一个返回 `Applied` 的步骤取得控制权；只有 `NotApplicable` 才继续。`Yielded` 表示交回客户端，即使同时带有 effects，也不同于没有步骤可执行。

Operation 产出 `ConversationEffect`，`EffectHandler.apply_effects()` 落地后再由 `SessionLoader.load()` 重读 session，使下一步以持久化事实为输入。Operation 还可贡献 tools、system prompt 和 metadata。重放正确性依赖 metadata：如果仅靠内存 flag 判断“做过没有”，恢复后便可能重复执行。

## MCP-first 扩展模型

Goose 把外部能力优先建模为 MCP Extension。Agent 不需要为每个服务写专用工具循环，而是连接 MCP Server、读取工具 schema，并把调用转换为 `ToolRequest` / `ToolResponse`。插件发现与格式适配位于 [`plugins`](../../code/goose/crates/goose/src/plugins)，MCP 辅助逻辑见 [`mcp_utils.rs`](../../code/goose/crates/goose/src/mcp_utils.rs)。

内置 Extension 与第三方 Extension 最终都需要进入统一工具命名和权限流程。工具名可能包含扩展前缀；解析与展示不应简单按裸工具名处理。

Extension 存在配置和运行连接两层生命周期。`add_extension_inner()` 启动/注册连接，`list_tools()` 读取工具，`remove_extension()` 同步派生状态；`save_extension_state()`/`load_extensions_from_session()` 负责恢复。前端工具经 `insert_frontend_extension()` 与 `rebuild_frontend_derived_state()` 进入单独集合，其执行端可能位于客户端。

扩展进程退出、工具未注册、用户拒绝和工具返回业务错误是四类不同失败源，应分别检查连接层、registry、permission 与 `CallToolResult`，不能统一归因于“工具调用失败”。

## Provider 与消息模型

Provider 注册集中在 [`provider_registry.rs`](../../code/goose/crates/goose/src/providers/provider_registry.rs)，具体适配位于 [`providers`](../../code/goose/crates/goose/src/providers) 和独立 `goose-providers` crate。不同厂商的 stream、reasoning、tool call 和 usage 先归一到 [`goose-provider-types`](../../code/goose/crates/goose-provider-types)，Agent 再消费统一 Conversation。

源码仍保留若干 Provider 专用分支和格式转换。这说明“统一接口”降低了主循环耦合，但没有消除模型协议差异。

## Recipe、Skills 与自动化

Recipe 是可参数化工作流清单，不只是 Prompt 文件。定义与校验位于 [`recipe`](../../code/goose/crates/goose/src/recipe)，可声明 extensions、settings、parameters、sub-recipes、retry 和 success checks。Scheduler 能保存并定时执行 Recipe，入口见 [`scheduler.rs`](../../code/goose/crates/goose/src/scheduler.rs)。

Skills 位于 [`skills`](../../code/goose/crates/goose/src/skills)，负责发现和加载按需知识；Hooks 位于 [`hooks`](../../code/goose/crates/goose/src/hooks)，可在生命周期节点执行额外动作。三者职责不同：Recipe 编排一次任务，Skill 提供上下文能力，Hook 拦截生命周期。

## 会话、多入口与子 Agent

[`session_manager.rs`](../../code/goose/crates/goose/src/session/session_manager.rs) 管理会话持久化与查询。Goose 还支持导入 Codex、Claude Code 和 Pi 会话，转换代码位于 [`session/import_formats`](../../code/goose/crates/goose/src/session/import_formats)。

同一 Agent 可由 CLI、ACP Server、Gateway 或 Scheduler 驱动。ACP 入口位于 [`acp/server.rs`](../../code/goose/crates/goose/src/acp/server.rs)，Gateway 位于 [`gateway`](../../code/goose/crates/goose/src/gateway)。子 Agent 执行见 [`subagent_handler.rs`](../../code/goose/crates/goose/src/agents/subagent_handler.rs) 和 [`subagent_execution_tool`](../../code/goose/crates/goose/src/agents/subagent_execution_tool)。

## 限制与风险

- MCP 扩展在本地启动进程或访问远程服务，信任边界取决于 Extension 配置和权限策略。
- Provider 归一化无法保证所有模型对工具调用、缓存和 reasoning 的语义一致。
- Recipe 的重试和成功检查会触发额外执行，自动化环境必须设置资源与权限边界。
- 新状态机和旧 Agent 并存，直接从某一套抽象推断全局行为容易遗漏兼容路径。
- 本地运行不自动等于沙箱运行；命令执行的安全性需要结合 Extension 和宿主配置判断。

## 推荐阅读顺序

1. [`crates/goose/src/agents/agent.rs`](../../code/goose/crates/goose/src/agents/agent.rs)：现行产品 Agent。
2. [`crates/goose-agent/src/machine.rs`](../../code/goose/crates/goose-agent/src/machine.rs)：新的状态机窄腰。
3. [`crates/goose-agent/src/operation.rs`](../../code/goose/crates/goose-agent/src/operation.rs)：Operation/Effect 协议。
4. [`crates/goose/src/plugins`](../../code/goose/crates/goose/src/plugins)：MCP Extension 装配。
5. [`crates/goose/src/providers`](../../code/goose/crates/goose/src/providers)：模型适配。
6. [`crates/goose/src/recipe`](../../code/goose/crates/goose/src/recipe)：工作流描述与校验。
7. [`crates/goose/src/session`](../../code/goose/crates/goose/src/session)：持久化与迁移。
