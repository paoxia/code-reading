# OpenClaw 源码解析

## 研究范围

- 上游仓库：<https://github.com/openclaw/openclaw>
- 本地源码：[code/openclaw](../../code/openclaw/)
- 原始研究版本：`1bfd207a5405c38d04b052c8eb7291cadabce99e`
- 2026-08-19 增量复核版本：`3587158a0e385f696e8162a7b1752c101143d3fc`
- 增量复核时 `package.json` 版本：`2026.8.1`
- 研究重点：Gateway、渠道入站路由、Agent Runtime、工具系统、会话持久化、插件与子 Agent

本文只描述上述版本中已经落地的实现。OpenClaw 仍在快速演进，源码中保留的兼容分支、迁移逻辑和实验接口不应视为稳定 API。

## 一句话结论

OpenClaw 的核心不是一个聊天界面，而是一个**常驻 Gateway 控制面**：它统一接入消息渠道和客户端，把每个入站事件路由到会话，再交给可选择的 Agent Runtime 执行；内置 runtime 最终落到 `@openclaw/agent-core` 的模型—工具循环，插件、会话数据库和子 Agent 都围绕这条窄腰扩展。

增量复核后这条窄腰仍成立，但权限与状态语义更严格：嵌套 session 工具会保留 caller scope，防止子调用获得比父调用更宽的能力；Skill Workshop proposal 内容变更后必须重新 review；Gateway `activeRunIds` 一旦出现就表示完整的精确集合，客户端不应再把它当成局部增量。

## 整体架构

```mermaid
flowchart TD
    Channel[Discord / Telegram / Slack / Web 等渠道]
    Client[CLI / Web UI / macOS / Node 客户端]
    Gateway[Gateway<br/>WebSocket + typed RPC + event bus]
    Turn[Inbound Turn Kernel<br/>classify / admission / route]
    Command[agentCommand]
    Runtime[Agent Runtime 选择<br/>openclaw / plugin harness]
    Attempt[Embedded Attempt<br/>prompt / tools / lock / stream]
    Core[@openclaw/agent-core<br/>LLM ↔ Tool Loop]
    Store[(SQLite Session Store<br/>transcript / route / metadata)]
    Plugin[Plugin Registry<br/>channels / tools / providers / harness]
    Subagent[sessions_spawn<br/>subagent / ACP]

    Channel --> Turn
    Client --> Gateway
    Turn --> Gateway
    Gateway --> Command
    Command --> Runtime
    Runtime --> Attempt
    Attempt --> Core
    Core --> Attempt
    Attempt --> Gateway
    Gateway --> Channel
    Gateway <--> Store
    Plugin --> Gateway
    Plugin --> Runtime
    Plugin --> Core
    Core --> Subagent
    Subagent --> Store
```

官方架构说明把 Gateway 定义为消息面的单一所有者；客户端和节点通过 WebSocket 使用带类型的请求、响应和事件协议。Gateway 默认只监听本机地址，客户端连接后必须先发送 `connect`，而事件不会被服务端重放，客户端发现序号缺口时需要主动刷新状态。参见 [Gateway 架构文档](../../code/openclaw/docs/concepts/architecture.md)。

## 核心边界

| 边界 | 主要职责 | 关键源码 |
| --- | --- | --- |
| 启动入口 | Node 版本检查、快速处理帮助/版本、加载构建产物 | [openclaw.mjs](../../code/openclaw/openclaw.mjs)、[src/entry.ts](../../code/openclaw/src/entry.ts) |
| Gateway | 配置与密钥快照、鉴权、插件引导、渠道管理、RPC 与事件 | [src/gateway/server-start.ts](../../code/openclaw/src/gateway/server-start.ts) |
| 入站 Turn Kernel | 分类、准入、路由、组装、执行与收尾 | [src/channels/turn/run-channel-turn.ts](../../code/openclaw/src/channels/turn/run-channel-turn.ts)、[src/channels/turn/execution.ts](../../code/openclaw/src/channels/turn/execution.ts) |
| Agent 命令层 | 解析 agent、模型、会话和运行参数，建立执行尝试 | [src/agents/agent-command.ts](../../code/openclaw/src/agents/agent-command.ts) |
| Embedded Runner | fallback、队列、会话锁、prompt、工具与流式事件 | [src/agents/embedded-agent-runner/run-entry.ts](../../code/openclaw/src/agents/embedded-agent-runner/run-entry.ts)、[attempt.ts](../../code/openclaw/src/agents/embedded-agent-runner/run/attempt.ts) |
| Agent Core | 模型流、工具调用、steering、follow-up 和事件生命周期 | [packages/agent-core/src/agent-loop.ts](../../code/openclaw/packages/agent-core/src/agent-loop.ts) |
| 工具装配 | 核心工具、会话工具、Web/媒体工具和插件工具 | [src/agents/openclaw-tools.ts](../../code/openclaw/src/agents/openclaw-tools.ts) |
| 会话存储 | SQLite/文件兼容层、转录、分支、恢复 | [src/agents/sessions/session-manager.ts](../../code/openclaw/src/agents/sessions/session-manager.ts) |
| 插件 | manifest、发现、加载、事务激活和扩展注册 | [src/plugins/discovery.ts](../../code/openclaw/src/plugins/discovery.ts)、[src/plugins/loader-runtime-load.ts](../../code/openclaw/src/plugins/loader-runtime-load.ts) |

这组边界体现了两个重要设计选择：

1. 渠道适配器不直接运行模型，而是先归一化为共享的入站 turn。
2. Agent Core 不承担 Gateway、插件发现或会话路由，它只处理模型上下文、工具执行和事件。

## 主调用链

### 1. 渠道事件进入 Gateway

[`run-channel-turn.ts`](../../code/openclaw/src/channels/turn/run-channel-turn.ts) 把一次入站处理拆成稳定阶段：

```text
ingest
  → classify
  → preflight admission（drop / observe / allow）
  → resolve route
  → assemble turn
  → prepared / routed dispatch
  → finalize
```

[turn/execution.ts](../../code/openclaw/src/channels/turn/execution.ts) 处理更贴近执行的工作，包括：

- 丢弃出站回声和机器人循环；
- 合并已有 transcript 上下文；
- 记录入站会话；
- 选择正常 dispatch 或只观察；
- 清理 pending history 并发出诊断事件。

因此，“消息接收”和“运行 Agent”之间存在明确的准入与路由层，渠道插件只需要适配统一协议。

### 2. Gateway 调用 `agentCommand`

[agent-command.ts](../../code/openclaw/src/agents/agent-command.ts) 的 `agentCommand` 是受信任的本地/CLI 包装器。它解析依赖和执行配置后进入内部命令流程。源码特别区分了：

- 本地受信任调用可默认允许 owner/model override；
- 消息入口必须显式传递 `allowModelOverride`；
- 非明确授权的发送者不会被当作 owner。

这是一个重要安全边界：模型或外部渠道不能因为复用了同一命令函数就自然获得本地调用者权限。

### 3. Runtime 选择和 fallback

Agent Runtime 的布局与选择规则见 [agent-runtime-architecture.md](../../code/openclaw/docs/agent-runtime-architecture.md)：

- 内置 runtime 的规范 ID 是 `openclaw`；
- `auto` 只有在插件 harness 支持当前有效路由时才选择插件，否则回退内置 runtime；
- 旧 ID 会经过兼容映射，例如 `pi` 映射到 `openclaw`；
- 模型、凭据和 runtime 会先形成一次 prepared snapshot，避免同一轮中读取到漂移配置。

[run-entry.ts](../../code/openclaw/src/agents/embedded-agent-runner/run-entry.ts) 用 `runWithModelFallback` 包装单次执行，并在每个候选 provider/model 上确认所需 harness 插件。一个关键保护是：如果尝试已经提交了不可安全重放的副作用，就不会继续模型 fallback，以免重复执行工具。

### 4. 准备 Embedded Attempt

[attempt.ts](../../code/openclaw/src/agents/embedded-agent-runner/run/attempt.ts) 是运行前装配中心，主要准备：

- Skills 和 bootstrap 上下文；
- 基础工具、插件工具、MCP/LSP bundle；
- 最终 tool catalog 和 system prompt；
- 会话写锁；
- session runtime 和 transcript；
- 流式运行、hook、liveness 与清理函数。

实际流式阶段由 [attempt-execution-phase.ts](../../code/openclaw/src/agents/embedded-agent-runner/run/attempt-execution-phase.ts) 继续组装受保护的 stream runtime。无论成功还是失败，运行级 catalog、runtime 资源、会话锁和诊断状态都会进入统一清理路径。

### 5. `@openclaw/agent-core` 执行模型—工具循环

[agent-loop.ts](../../code/openclaw/packages/agent-core/src/agent-loop.ts) 的核心状态流可以概括为：

```text
追加用户消息
  → 发出 agent/turn/message start 事件
  → streamAssistantResponse
  → 有 tool call？
      ├─ 否：结束或处理 follow-up
      └─ 是：校验参数
              → beforeToolCall
              → 执行工具
              → afterToolCall
              → 追加 toolResult
              → 下一轮模型调用
```

值得注意的实现细节：

- 每次模型调用前都会把内部上下文转换为供应商需要的格式，并解析本轮有效 API key；
- 工具默认按顺序执行，也可依据配置和工具的 `executionMode` 并行；
- `beforeToolCall` 可以阻止执行，`afterToolCall` 可以变换结果；
- 延迟工具通过 `resolveDeferredTool` 在真正调用时补全；
- steering 消息和 follow-up 消息都在同一个循环内消费；
- abort 会形成明确的失败或中断结果，而不是悄悄截断 transcript。

## 工具系统

[createOpenClawTools](../../code/openclaw/src/agents/openclaw-tools.ts) 组装一次 Agent 运行可见的能力：

- 核心 shell、文件、浏览和媒体工具；
- conversation/session 管理工具；
- `sessions_spawn`、`yield`、`subagents`、`session_status`；
- Web、图像和 PDF 工具；
- 插件注册工具；
- 基于客户端能力、allow/deny 和调用者身份的过滤包装。

工具列表不是全局裸露给每个调用者。装配阶段会结合 Agent、sandbox、客户端能力、插件 hook 和 Gateway caller identity 形成最终目录。

## 会话和持久化

当前会话设计见 [session.md](../../code/openclaw/docs/concepts/session.md) 和 [SessionManager](../../code/openclaw/src/agents/sessions/session-manager.ts)：

- 每个 Agent 默认使用 `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`；
- 会话元数据、路由和 transcript 以 SQLite 为主；
- `SessionManager` 同时保留显式独立文件/旧格式兼容入口；
- 分支、文件访问、编解码和持久化被拆到 `session-manager-*` 模块；
- 会话写入的并发协调已下沉到 session/plugin runtime 的存储边界，不再由原先的单一 `src/agents/session-write-lock.ts` 文件代表。

默认 DM scope 可能让多个私聊进入 main session。文档明确建议多用户部署按 channel/peer 隔离，否则会产生上下文串话风险。`incognito` 只保证会话存储留在内存，并不阻止工具把内容写到其他持久化位置。

## 子 Agent 与多运行时协作

[sessions-spawn-tool.ts](../../code/openclaw/src/agents/tools/sessions-spawn-tool.ts) 的 `sessions_spawn` 支持两类 runtime：

- `subagent`：启动原生 OpenClaw 子 Agent；
- `acp`：启动 ACP 运行时会话。

它还显式区分：

- `run` 与长生命周期 `session` 模式；
- `isolated` 与 `fork` 上下文；
- sandbox 继承或强制要求；
- 单任务、collect 和 swarm；
- 可选线程绑定。

子 Agent 继承的是经过限制的工具策略和 workspace/delivery 上下文，而不是无条件复制父 Agent 权限。[`subagent-registry.ts`](../../code/openclaw/src/agents/subagents/registry/subagent-registry.ts) 负责运行注册、持久化恢复、孤儿任务处理、完成通知和重试定时器。

## 插件体系

插件分为“发现控制面”和“运行时加载”两个阶段：

1. [discovery.ts](../../code/openclaw/src/plugins/discovery.ts) 从显式配置路径、受约束的 workspace 扩展根和 bundled overlay 中发现候选，不会无界扫描任意工作区。
2. [loader-runtime-load.ts](../../code/openclaw/src/plugins/loader-runtime-load.ts) 读取 manifest，创建 registry 事务，按需加载模块和 runtime；失败时回滚，成功后才缓存并激活 registry。

插件可扩展渠道、Provider、工具和 Agent harness，但宿主核心仍通过受控的 registry/SDK 边界调用它们。对理解插件控制面，建议同时阅读 [docs/plugins/architecture.md](../../code/openclaw/docs/plugins/architecture.md)。

## 可靠性与安全设计

### 已明确实现的保护

- Gateway 启动时预检状态库和 Agent 数据库 schema，拒绝比当前程序更新的 schema。
- 每条连接都要先完成 connect/auth；设备配对和鉴权由 Gateway 统一处理。
- 渠道 turn 有准入、drop、observe 和 route 阶段，不会直接把原始事件送入模型。
- 模型 override 与 owner 身份在入口处显式传递。
- Agent 尝试持有会话写锁，并在统一清理路径释放。
- 已提交副作用的尝试不会被模型 fallback 自动重放。
- 插件加载使用事务和回滚，工具还会经过 caller identity 与 hook 包装。

更完整的部署威胁面应结合 [Gateway 安全文档](../../code/openclaw/docs/gateway/security/index.md) 阅读。

### 限制和注意事项

- Gateway 事件不重放，客户端必须在序号缺口后重新获取状态。
- 单 Gateway 是消息面的中心协调点，也意味着高可用部署需要额外的进程监督和状态恢复设计。
- 多用户环境若沿用共享 main DM session，存在上下文泄漏风险。
- `incognito` 不是全局“零落盘”保证，工具仍可能产生文件或外部副作用。
- 插件和工具横跨信任边界；启用第三方扩展前需要检查 manifest、加载路径和权限策略。
- 项目包含大量兼容映射与迁移逻辑；笔记中的 runtime 名称和存储布局应随版本复核。

## 推荐阅读顺序

1. [docs/concepts/architecture.md](../../code/openclaw/docs/concepts/architecture.md)：先理解 Gateway 为什么是控制中心。
2. [src/channels/turn/run-channel-turn.ts](../../code/openclaw/src/channels/turn/run-channel-turn.ts)：理解消息如何进入统一 turn。
3. [src/agents/agent-command.ts](../../code/openclaw/src/agents/agent-command.ts)：理解路由结果如何变成 Agent 执行。
4. [docs/agent-runtime-architecture.md](../../code/openclaw/docs/agent-runtime-architecture.md)：理解内置 runtime 与插件 harness 的选择。
5. [src/agents/embedded-agent-runner/run/attempt.ts](../../code/openclaw/src/agents/embedded-agent-runner/run/attempt.ts)：理解一次执行需要装配哪些资源。
6. [packages/agent-core/src/agent-loop.ts](../../code/openclaw/packages/agent-core/src/agent-loop.ts)：阅读最核心的模型—工具循环。
7. [src/agents/openclaw-tools.ts](../../code/openclaw/src/agents/openclaw-tools.ts)：理解工具目录如何形成。
8. [src/agents/tools/sessions-spawn-tool.ts](../../code/openclaw/src/agents/tools/sessions-spawn-tool.ts)：理解子 Agent 和 ACP 会话。
9. [src/agents/sessions/session-manager.ts](../../code/openclaw/src/agents/sessions/session-manager.ts)：理解持久化、分支和兼容层。
10. [src/plugins/loader-runtime-load.ts](../../code/openclaw/src/plugins/loader-runtime-load.ts)：最后研究扩展加载与事务边界。

## 可继续深入的主题

- Gateway RPC schema、事件序号和客户端状态恢复。
- prompt/bootstrap/Skill 的分层及上下文压缩。
- sandbox、exec approval 与工具权限的完整调用链。
- ACP runtime 与原生 subagent 的生命周期差异。
- SQLite 会话 schema、迁移和 transcript 修复策略。
- Provider 凭据刷新、prepared runtime snapshot 与模型 fallback。
