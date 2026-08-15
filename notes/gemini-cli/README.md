# Gemini CLI 架构与横向对照

> 源码版本：`google-gemini/gemini-cli main@c0d1924`（2026-08-13）

## 研究范围

本文分析 Gemini CLI 的终端入口、模型循环、工具调度、策略与沙箱，并与本仓库已有的 Codex、Kimi Code 和 OpenCode 建立对照。结论以当前 TypeScript monorepo 源码为准。

## 分层结构

| 包 | 职责 |
|---|---|
| [`packages/cli`](../../code/gemini-cli/packages/cli) | React/Ink TUI、命令行参数、交互与 headless 入口 |
| [`packages/core`](../../code/gemini-cli/packages/core) | 模型会话、Turn、工具、Scheduler、Policy、MCP、沙箱和服务 |
| [`packages/sdk`](../../code/gemini-cli/packages/sdk) | 可嵌入调用接口 |
| [`packages/a2a-server`](../../code/gemini-cli/packages/a2a-server) | A2A 服务入口 |
| [`packages/vscode-ide-companion`](../../code/gemini-cli/packages/vscode-ide-companion) | IDE 伴随扩展 |

CLI 和 Core 分离是关键：交互式路径在 [`useGeminiStream.ts`](../../code/gemini-cli/packages/cli/src/ui/hooks/useGeminiStream.ts)，非交互路径在 [`nonInteractiveCli.ts`](../../code/gemini-cli/packages/cli/src/nonInteractiveCli.ts)，二者最终复用 Core 的 `GeminiClient` 和 `Scheduler`。

## 主调用链

```text
用户输入
  → CLI prompt processor
  → GeminiClient.sendMessageStream()
  → GeminiChat / Turn 解析模型流
  → tool call 列表
  → Scheduler.schedule()
       → PolicyEngine
       → confirmation / hooks
       → ToolExecutor
  → tool response 写回会话
  → 下一次模型请求，直到无工具调用或停止
```

[`client.ts`](../../code/gemini-cli/packages/core/src/core/client.ts) 组织一轮请求，[`geminiChat.ts`](../../code/gemini-cli/packages/core/src/core/geminiChat.ts) 管理与模型的聊天历史和流式调用，[`turn.ts`](../../code/gemini-cli/packages/core/src/core/turn.ts) 将模型流转换为文本、工具调用和状态事件。

Loop 没有被封装为一个孤立的 `while`：交互 UI 需要边消费 stream 边显示，并在工具完成后继续请求，因此 UI hook 与 Core Turn/Scheduler 共同组成完整循环。Headless 路径显式重复 `sendMessageStream()` 和工具调度。

### `GeminiClient`、`GeminiChat` 与 `Turn` 的边界

| 对象 | 生命周期 | 持有的状态 | 主要输出 |
|---|---|---|---|
| `GeminiClient` | 整个 CLI session | chat、tool registry、loop detection、当前模型、telemetry | 一轮 `ServerGeminiStreamEvent` 流 |
| `GeminiChat` | 可恢复模型会话 | 规范化后的 Gemini `Content` 历史、system instruction、重试状态 | provider 内容流 |
| `Turn` | 单次模型请求 | response fragments、pending function calls、debug responses | text/thought/tool/finish/error 事件 |

`GeminiClient.initialize()` 初始化内容生成器和聊天，`startChat()`/`resumeChat()` 决定新建或恢复，`setTools()` 把 registry 转成模型声明。发送前后还会注入 IDE context、触发 agent hooks、选择本轮模型，并在需要时执行 `tryCompressChat()`。

[`geminiChat.ts`](../../code/gemini-cli/packages/core/src/core/geminiChat.ts) 不会无条件保留 provider 原始历史。`validateHistory()`、`extractCuratedHistory()`、`coalesceConsecutiveRoles()`、`stripThoughts()` 和 `stripToolCallIdPrefixes()` 会处理角色交替、无效 part、thought 与跨 provider 兼容。恢复后历史变化时，应先检查这些规范化路径。

`Turn` 将流中的 part 转换为 `GeminiEventType`。`handlePendingFunctionCall()` 聚合函数名、参数和 call id，避免把未完整到达的调用交给 Scheduler。`getResponseText()` 只聚合文本；thought、citation、tool call、compression 与停止原因仍在独立事件中。

## 工具调度与权限

工具先进入 Core 的注册表，再由 [`scheduler.ts`](../../code/gemini-cli/packages/core/src/scheduler/scheduler.ts) 调度。Scheduler 维护工具调用状态，支持并行调用、取消、等待确认和完成回调；实际执行委托给 [`tool-executor.ts`](../../code/gemini-cli/packages/core/src/scheduler/tool-executor.ts)。

安全判断不是散落在每个 UI 按钮中。[`policy-engine.ts`](../../code/gemini-cli/packages/core/src/policy/policy-engine.ts) 根据 tool call 和策略规则给出 allow、deny 或 ask-user 决策。内置 TOML 策略位于 [`policy/policies`](../../code/gemini-cli/packages/core/src/policy/policies)，包括 plan、read-only、write、sandbox、non-interactive 和 yolo 等模式。

这意味着“Plan Mode”不仅是 Prompt 约定，而是可由 Policy 层限制可执行工具；但具体强度仍取决于规则覆盖和底层沙箱。

### Scheduler 状态机

`schedule()` 先把 `ToolCallRequestInfo` 放入 request queue。`_startBatch()` 建立同批完成边界，`_validateAndCreateToolCall()` 解析工具并校验参数；工具不存在时生成 terminal error response 供模型纠正，而不是让整个 Agent 直接崩溃。

```text
validating → awaiting_approval → scheduled → executing → success/error/cancelled
     └──────────────── policy deny ───────────────→ error
```

`_processQueue()`/`_processNextItem()` 驱动队列；`_isParallelizable()` 决定同批工具能否并发，不可并行调用形成执行栅栏；`_processValidatingCall()` 完成 policy 与 confirmation 判断，`_execute()` 才委托 `ToolExecutor`。`cancelAll()` 还要覆盖排队、待确认和执行中的调用，并不只是 abort 当前子进程。

上下文接近限制时，Client 通过 `tryCompressChat()` 产生摘要，并发出 compression event；工具输出过大还可能触发 `tryMaskToolOutputs()`。此外，终止事件包括 cancelled、max turns、context overflow、invalid stream、execution stopped/blocked 和 loop detected。`_recoverFromLoop()` 说明 loop event 后仍可能恢复，调用方行为需要继续沿事件处理链确认。

## 沙箱

[`sandboxManagerFactory.ts`](../../code/gemini-cli/packages/core/src/services/sandboxManagerFactory.ts) 按平台选择实现：Linux 使用 Bubblewrap，macOS 使用 Seatbelt，Windows 使用独立的 Windows Sandbox Manager。对应源码分别位于 [`sandbox/linux`](../../code/gemini-cli/packages/core/src/sandbox/linux)、[`sandbox/macos`](../../code/gemini-cli/packages/core/src/sandbox/macos) 和 [`sandbox/windows`](../../code/gemini-cli/packages/core/src/sandbox/windows)。

Policy 与 OS 沙箱是两层机制：前者决定某个工具调用是否应执行，后者约束获准进程能访问什么。不能把 approval mode 与强制隔离视为同一件事。

## 扩展、MCP 与子 Agent

MCP 负责发现外部工具和 Prompt，认证代码位于 [`core/src/mcp`](../../code/gemini-cli/packages/core/src/mcp)。Extensions 则是更高层的分发单元，可携带 MCP 配置、命令和上下文，说明见 [`docs/extensions`](../../code/gemini-cli/docs/extensions)。

子 Agent 由 [`agent-scheduler.ts`](../../code/gemini-cli/packages/core/src/agents/agent-scheduler.ts) 调度，并与主工具 Scheduler 区分。A2A 客户端管理位于 [`a2a-client-manager.ts`](../../code/gemini-cli/packages/core/src/agents/a2a-client-manager.ts)。这些能力仍在快速演进，不能假设所有 agent 类型共享完全相同的工具或生命周期。

## 与 Codex、Kimi Code、OpenCode 对照

| 维度 | Gemini CLI | Codex | Kimi Code | OpenCode |
|---|---|---|---|---|
| 主实现 | TypeScript | Rust | TypeScript | TypeScript |
| 前端 | Ink TUI | Rust TUI | TUI + SDK | Server + TUI/Web/Desktop |
| 调度核心 | Turn + Scheduler | Turn/Session runtime | TurnFlow/runTurn | Session Prompt processor |
| 权限 | TOML Policy + confirmation | Approval + sandbox policy | permission service | Permission rules |
| 沙箱 | Linux/macOS/Windows 分平台实现 | 平台沙箱与审批 | Host/远程执行抽象 | 权限为主，可接外部执行环境 |
| 扩展 | Extensions + MCP + Skills | MCP + Skills | Extensions/Skills/MCP | Plugin + MCP + Skills |

该表描述当前源码的主要抽象，不代表安全强度或功能完备度排名。

## 限制与注意事项

- 交互和 headless 路径复用核心组件，但控制流并非逐行相同，研究行为时需同时看两条路径。
- 策略文件、实验开关和模型路由持续变化，文档描述需要与当前配置代码核对。
- `YOLO` 等模式会显著改变确认行为，不能以默认模式推断所有运行方式。
- Sandbox 在不同操作系统上的底层机制不同，不应声称具有完全等价的隔离语义。

## 推荐阅读顺序

1. [`packages/core/src/core/client.ts`](../../code/gemini-cli/packages/core/src/core/client.ts)。
2. [`packages/core/src/core/turn.ts`](../../code/gemini-cli/packages/core/src/core/turn.ts)。
3. [`packages/core/src/scheduler/scheduler.ts`](../../code/gemini-cli/packages/core/src/scheduler/scheduler.ts)。
4. [`packages/core/src/policy/policy-engine.ts`](../../code/gemini-cli/packages/core/src/policy/policy-engine.ts)。
5. [`packages/cli/src/ui/hooks/useGeminiStream.ts`](../../code/gemini-cli/packages/cli/src/ui/hooks/useGeminiStream.ts)。
6. [`packages/cli/src/nonInteractiveCli.ts`](../../code/gemini-cli/packages/cli/src/nonInteractiveCli.ts)。
7. 按需阅读 Tools、MCP、Agents 和各平台 Sandbox。
