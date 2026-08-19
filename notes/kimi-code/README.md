# kimi-code 源码架构概览

相关专题：[Windows、Linux 与 macOS 跨平台适配](./cross-platform-adaptation.md)

> 上游仓库：`MoonshotAI/kimi-code`
>
> 原始研究版本：`main@bf8e967d5c5c5dd458acd3319031993b8c53a44c`
>
> 2026-08-19 增量复核版本：`main@2ea2ef62e42b`（`@moonshot-ai/kimi-code 0.37.2`）
>
> 本文以终端 TUI 的现行 v1 主链为重点，同时说明 `agent-core-v2` 与
> `kap-server` 的演进路径。浏览器 UI、ACP 协议细节和可视化调试工具只做架构定位。

## 1. 一句话认识

Kimi Code 不是“一个 Agent 类加几个工具”，而是一套产品级 Coding Agent 系统：

```text
CLI / TUI / Web / ACP
        │
        ▼
SDK、会话与事件协议
        │
        ▼
Agent Runtime ── 模型抽象（kosong）
        │        执行环境（kaos）
        │        工具、权限、Skill、Plugin、MCP
        ▼
持久化记录、上下文压缩、子 Agent、Goal / Plan / Swarm
```

它同时保留两条运行路径：

1. 终端 TUI 通过 `@moonshot-ai/kimi-code-sdk` 内嵌现行
   [`KimiCore`](../../code/kimi-code/packages/agent-core/src/rpc/core-impl.ts)；
2. `kimi web` 启动基于 DI × Scope 架构的
   [`kap-server`](../../code/kimi-code/packages/kap-server/src/start.ts)，后者使用
   [`agent-core-v2`](../../code/kimi-code/packages/agent-core-v2/src/)。

因此阅读源码时必须区分 v1 与 v2，不能把两套实现拼成一条实际调用链。

## 2. 仓库分层

| 层次 | 主要目录 | 职责 |
|---|---|---|
| 终端产品层 | [`apps/kimi-code`](../../code/kimi-code/apps/kimi-code/) | 命令解析、TUI、交互对话框、会话回放和事件渲染 |
| 浏览器入口 | [`apps/kimi-code/src/cli/sub/web`](../../code/kimi-code/apps/kimi-code/src/cli/sub/web) | 启动 REST/WebSocket server 并服务预构建 Web UI；UI 源码位于独立 code-app 仓库 |
| 公共 SDK | [`packages/node-sdk`](../../code/kimi-code/packages/node-sdk/) | 用 `KimiHarness`、`Session` 隔离 UI 与核心实现 |
| v1 Agent 引擎 | [`packages/agent-core`](../../code/kimi-code/packages/agent-core/) | Session、Agent、Loop、工具、权限、上下文、持久化和扩展 |
| v2 Agent 引擎 | [`packages/agent-core-v2`](../../code/kimi-code/packages/agent-core-v2/) | 基于 App / Session / Agent Scope 的新引擎 |
| Server | [`packages/kap-server`](../../code/kimi-code/packages/kap-server/) | Fastify、REST、WebSocket、鉴权、Transcript 和 v2 引擎宿主 |
| 模型适配层 | [`packages/kosong`](../../code/kimi-code/packages/kosong/) | 统一消息、流式生成、工具调用、用量和 Provider 错误 |
| 执行环境层 | [`packages/kaos`](../../code/kimi-code/packages/kaos/) | 抽象文件系统、进程、工作目录和本地执行环境 |
| Transcript | [`packages/transcript`](../../code/kimi-code/packages/transcript/) | 与引擎解耦的会话时间线、增量操作和分页数据模型 |

根目录 [`package.json`](../../code/kimi-code/package.json) 要求 Node.js
`>=24.15.0` 和 pnpm `10.33.0`。这是一个多应用、多 Package 的 TypeScript
monorepo，而不是只发布一个 CLI 文件。

### 增量变化

v2 的 background task 现在有了模型可见的 `WaitFor` 工具，可按 task 等待后台完成，而不需要前台 loop 自行忙轮询，实现见
[`taskWaitTool.ts`](../../code/kimi-code/packages/agent-core-v2/src/agent/tools/task/task-wait/taskWaitTool.ts)。`subagent.spawned` 事件改为在 task 注册后发送，确保事件中的 task id 已可查；MCP 服务需要鉴权时，authenticate tool 也不再受 settle 时序竞态影响。

## 3. 终端 TUI 启动链

入口由 [`apps/kimi-code/src/main.ts`](../../code/kimi-code/apps/kimi-code/src/main.ts)
解析并分发命令。普通交互模式最终进入
[`runShell`](../../code/kimi-code/apps/kimi-code/src/cli/run-shell.ts)：

```text
main.ts
  └─ createProgram() / handleMainCommand()
       └─ runShell()
            ├─ 加载 TUI 配置和主题
            ├─ createKimiHarness()
            ├─ 读取核心配置和迁移状态
            ├─ new KimiTUI(harness, ...)
            └─ tui.start()
```

`runShell()` 不直接导入 `agent-core`。它只依赖 SDK 暴露的
[`createKimiHarness`](../../code/kimi-code/packages/node-sdk/src/sdk-rpc-client.ts)。
工厂在同一进程内创建：

```text
SDKRpcClient
  ├─ createRPC<CoreAPI, SDKAPI>()
  ├─ new KimiCore(coreRpc, ...)
  └─ new KimiHarness(rpc, ...)
```

这层 RPC 即使在同一进程也保留协议边界，使 TUI 不需要知道 Agent、工具和 Provider
的内部对象结构。SDK 的
[`KimiHarness`](../../code/kimi-code/packages/node-sdk/src/kimi-harness.ts)
负责创建、恢复、分叉和关闭会话；
[`Session`](../../code/kimi-code/packages/node-sdk/src/session.ts)
则向上提供 `prompt()`、`steer()`、`cancel()`、`setModel()`、`compact()` 等 API。

## 4. 一次 Prompt 的主调用链

从 TUI 提交 Prompt 后，v1 主链可以缩写为：

```text
SDK Session.prompt()
  │
  ▼
SDKRpcClientBase.prompt()
  │
  ▼
KimiCore.prompt()
  │
  ▼
SessionAPIImpl.prompt()
  │
  ▼
Agent.prompt() → TurnFlow.prompt()
  │
  ▼
runOneTurn()
  ├─ 写入用户消息和 turn.started
  ├─ 执行 UserPromptSubmit Hook
  └─ runStepLoop()
       │
       ▼
     runTurn()
       └─ executeLoopStep()
            ├─ 调用 LLM
            ├─ 流式分发内容与 tool.call
            ├─ 校验、授权并执行工具
            ├─ 写入 tool.result
            └─ 根据 stop reason 决定下一 Step
```

关键入口分别位于：

- [`KimiCore.prompt`](../../code/kimi-code/packages/agent-core/src/rpc/core-impl.ts)；
- [`SessionAPIImpl.prompt`](../../code/kimi-code/packages/agent-core/src/session/rpc.ts)；
- [`TurnFlow`](../../code/kimi-code/packages/agent-core/src/agent/turn/index.ts)；
- [`runTurn`](../../code/kimi-code/packages/agent-core/src/loop/run-turn.ts)；
- [`executeLoopStep`](../../code/kimi-code/packages/agent-core/src/loop/turn-step.ts)；
- [`runToolCallBatch`](../../code/kimi-code/packages/agent-core/src/loop/tool-call.ts)。

### 4.1 Turn 与 Step

一个用户 Prompt 对应一个逻辑 Turn；Turn 内可以包含多个 Step。每个 Step 通常是一次
模型请求以及紧随其后的工具调用批次：

```text
Turn
  Step 1: LLM → Read / Grep
  Step 2: LLM → Edit
  Step 3: LLM → Bash(test)
  Step 4: LLM → 最终文本
```

[`runTurn`](../../code/kimi-code/packages/agent-core/src/loop/run-turn.ts) 是循环的窄腰：

- 在 Step 边界检查取消和最大步数；
- 每一步重新读取消息与工具表，允许上下文压缩或动态加载工具立即生效；
- `tool_use` 会自然进入下一 Step；
- 普通文本停止后，可由 Hook、Goal 或后台任务请求继续；
- 将取消、超限和错误统一映射为 Turn 结果。

### 4.2 工具批次

[`runToolCallBatch`](../../code/kimi-code/packages/agent-core/src/loop/tool-call.ts)
先解析参数并进行 Schema 校验，再执行 Prepare、权限判断和结果收尾 Hook。
批次内工具任务可以并行完成，但 `tool.result` 仍按 Provider 返回的调用顺序写入，
保证消息历史稳定。

即使工具不存在、参数无效或流式响应中断，实现也尽量生成配对的错误结果，避免留下
只有 `tool.call`、没有 `tool.result` 的非法上下文。

## 5. `Agent` 是能力聚合根

v1 [`Agent`](../../code/kimi-code/packages/agent-core/src/agent/index.ts)
在构造时组合多个职责对象：

| 组件 | 职责 |
|---|---|
| `ContextMemory` | 消息历史投影、记录恢复和 Provider 兼容修复 |
| `TurnFlow` | Prompt、Steer、取消和 Turn 生命周期 |
| `ToolManager` | 内置工具、用户工具、MCP 工具及动态披露 |
| `PermissionManager` | 工具调用前的规则判断与交互审批 |
| `FullCompaction` / `MicroCompaction` | 上下文预算管理和溢出恢复 |
| `BackgroundManager` | 后台进程和子 Agent 任务 |
| `GoalMode` / `PlanMode` / `SwarmMode` | 长任务、计划和多 Agent 协作状态 |
| `AgentRecords` | 追加式运行记录与恢复 |
| `UsageRecorder` | Turn 和模型维度的 Token 用量 |

这种设计仍以 `Agent` 为聚合根，但循环、权限、压缩、工具与状态已被拆成独立对象，
比把所有逻辑塞进一个 `run()` 方法更适合长期演进。

## 6. 模型与执行环境抽象

### 6.1 `kosong`

[`ChatProvider`](../../code/kimi-code/packages/kosong/src/provider.ts)
定义统一的生成接口；
[`generate`](../../code/kimi-code/packages/kosong/src/generate.ts)
负责消费流式事件并组装标准响应。内置 Provider 实现包括：

- Kimi；
- OpenAI Chat Completions / Responses；
- Anthropic；
- Google GenAI。

Provider 负责原生协议与统一消息结构之间的转换，Agent Loop 不直接依赖任一厂商 SDK。
模型能力还会影响工具调用、Thinking、动态工具和媒体处理策略。

### 6.2 `kaos`

[`packages/kaos`](../../code/kimi-code/packages/kaos/) 将当前目录、文件访问和进程执行
从 Agent 中抽离。Session 创建 Agent 时为其提供带工作目录的执行环境，因此工具实现
不必把本机 `fs` 和 `child_process` 写死在 Agent Loop 中。

## 7. 工具、权限与扩展

### 7.1 工具来源

[`ToolManager`](../../code/kimi-code/packages/agent-core/src/agent/tool/index.ts)
统一聚合三类工具：

1. 内置文件、Shell、Web、计划、Goal 和协作工具；
2. Host 在运行期注册的用户工具；
3. MCP Server 动态发现的工具。

当模型能力和实验开关允许时，系统使用 `select_tools` 做渐进式披露：模型先看到核心
工具和工具目录，选中的动态工具才在后续 Step 中加入可执行表。这是在长工具列表下
控制 Prompt 体积的优化。

### 7.2 权限

工具执行并非直接调用 `execute()`。循环会先经过
[`PermissionManager`](../../code/kimi-code/packages/agent-core/src/agent/permission/index.ts)
及策略规则，必要时通过 SDK 反向请求 UI 显示 Approval。权限层与 TUI 展示层分离，
因此同一核心可以由终端、Web 或其他 Host 提供审批界面。

### 7.3 Skill、Plugin、Hook 与 MCP

- [`Skill`](../../code/kimi-code/packages/agent-core/src/skill/) 提供可发现的指令包；
- [`PluginManager`](../../code/kimi-code/packages/agent-core/src/plugin/manager.ts)
  可从 Manifest 聚合 Skill、命令、MCP Server、Hook 和 Session Start 注入；
- [`MCP`](../../code/kimi-code/packages/agent-core/src/mcp/) 支持外部工具服务；
- Hook 可以介入用户 Prompt、工具使用、停止与失败等生命周期。

插件不是简单的“新增一个工具”，而是跨越 Agent Prompt、工具源、命令和生命周期的
扩展单元。

## 8. 持久化、恢复与上下文管理

Agent 默认将追加式记录写入 Session 下的 `wire.jsonl`，入口见
[`FileSystemAgentRecordPersistence`](../../code/kimi-code/packages/agent-core/src/agent/records/)。
恢复时不会只反序列化一个巨型状态对象，而是重放记录并重建 Context、工具状态、
Goal、后台任务等投影。

上下文管理同时包含：

- Provider 消息合法性投影；
- 工具调用与结果配对修复；
- Micro Compaction；
- Full Compaction；
- Context Overflow 后压缩并重试；
- 图片、视频和超长工具结果的预算控制。

这说明 Kimi Code 的核心难点已经从“能否循环调用模型”转向“长会话如何持续、可恢复
且对多种 Provider 保持合法”。

## 9. 子 Agent 与长任务机制

Session 可以创建主 Agent 和子 Agent。子 Agent 共享 Session 级 Skill、MCP 和部分
权限上下文，但拥有独立 Agent 目录、消息、记录和运行状态。相关组装位于
[`Session.instantiateAgent`](../../code/kimi-code/packages/agent-core/src/session/index.ts)
和
[`SessionSubagentHost`](../../code/kimi-code/packages/agent-core/src/session/subagent-host.ts)。

源码中还存在三个不同层次的长任务抽象：

- Background Task：后台运行进程或 Agent；
- Goal：跨多个 Turn 自动续跑，并带预算和终止状态；
- Swarm：由多个 Agent 协作执行。

它们不是普通 Tool Call 的别名，而是会影响 Turn 是否继续、何时空闲以及如何持久化。

## 10. v2 与 `kap-server`

[`agent-core-v2`](../../code/kimi-code/packages/agent-core-v2/src/)
正在把 v1 聚合对象迁移为 DI Service，并按生命周期划分：

```text
App Scope
  └─ Session Scope
       └─ Agent Scope
```

新的
[`AgentLoopService`](../../code/kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts)
把 Turn 建模为 FIFO Job，每个 Turn 拥有自己的 `StepRequestQueue`。Loop 本身只负责
执行请求；Prompt、Goal、Hook、重试和压缩等方面通过向队列加入新的 Step Request
驱动后续执行。这比 v1 的回调式 `shouldContinueAfterStop` 更偏向显式调度模型。

[`kap-server/start.ts`](../../code/kimi-code/packages/kap-server/src/start.ts)
启动 v2 App Scope，并在 Fastify 上提供：

- REST 与 WebSocket；
- Bearer Token 鉴权；
- Session、Prompt、Approval、Question、Tool、Terminal、文件和工作区接口；
- Transcript 增量推送与补偿；
- 本地 Server 实例注册和发现。

当前源码同时存在完整 v1 路径和活跃的 v2 路径，说明迁移尚未收敛。研究时适合先掌握
v1 的行为语义，再阅读 v2 如何用 Scope、Service、State 和 Wire Op 重新表达它们。

## 11. 测试与可验证性

测试按层次分布：

- Loop 生命周期与错误路径：
  [`packages/agent-core/test/loop`](../../code/kimi-code/packages/agent-core/test/loop/)；
- Agent Turn、权限、恢复与动态工具：
  [`packages/agent-core/test/agent`](../../code/kimi-code/packages/agent-core/test/agent/)；
- Session 与子 Agent：
  [`packages/agent-core/test/session`](../../code/kimi-code/packages/agent-core/test/session/)；
- v2 DI/Scope 各领域：
  [`packages/agent-core-v2/test`](../../code/kimi-code/packages/agent-core-v2/test/)；
- TUI 事件与组件：
  [`apps/kimi-code/test`](../../code/kimi-code/apps/kimi-code/test/)。

尤其值得阅读
[`turn-lifecycle.e2e.test.ts`](../../code/kimi-code/packages/agent-core/test/loop/turn-lifecycle.e2e.test.ts)、
[`tool-call.e2e.test.ts`](../../code/kimi-code/packages/agent-core/test/loop/tool-call.e2e.test.ts)
和
[`resume.test.ts`](../../code/kimi-code/packages/agent-core/test/agent/resume.test.ts)。

本文未运行测试；结论来自上述本地源码和测试定义。

## 12. 与 trae-agent 的横向对比

详细的 Trae Agent 分析见
[`notes/trae-agent/README.md`](../trae-agent/README.md)。

| 维度 | Kimi Code | Trae Agent |
|---|---|---|
| 主要定位 | 产品级终端/Web Coding Agent 平台 | 研究友好的软件工程 Agent 与评测框架 |
| 技术栈 | TypeScript monorepo | Python Package |
| 核心循环 | Turn / Step、流式事件、Hook、Goal 与多种续跑来源 | `max_steps` 控制的顺序 ReAct 循环 |
| 会话 | 持久化、恢复、分叉、回放和 Transcript | 单次任务对象；交互模式重复运行任务 |
| 工具 | 内置、用户、Plugin、Skill、MCP、动态披露 | 固定 Registry、MCP 和少量内置工具 |
| 权限 | 独立 Permission 策略与 UI Approval | 本地工具默认直接执行；可选 Docker 隔离 |
| 多 Agent | 子 Agent、后台任务、Goal、Swarm | 核心仅有一种 `TraeAgent` |
| Provider | `kosong` 统一流式协议和能力模型 | 每个 Provider 一个 Client Adapter |
| 可观测性 | Event、Wire Record、Transcript、Telemetry | JSON Trajectory 和 Lakeview 摘要 |
| Server | 可运行的本地 `kap-server` | `server/` 只有建设中的规划说明 |
| 评测 | 仓库内以单元/E2E 测试为主 | 带 SWE-bench、SWE-bench-Live、Multi-SWE-bench Harness |
| 学习成本 | 高，适合研究产品化和长会话工程 | 较低，适合快速理解软件工程 Agent 闭环 |

如果目标是学习“最小可理解的软件工程 Agent”，Trae Agent 更容易切入；如果目标是
研究权限、长会话、恢复、多前端、多 Agent 与扩展生态，Kimi Code 提供的工程样本更完整。

## 13. 限制与注意事项

1. v1 与 v2 并存，阅读任何类之前都要先确认它属于哪条运行路径。
2. v2 仍在迁移中，不能仅根据 v2 中出现的接口推断所有 v1 能力已完成迁移。
3. Server 暴露文件、终端和 Agent 操作；源码默认做鉴权、Host/Origin 检查及远程绑定
   限制，部署时不应随意关闭这些保护。
4. 多 Provider 支持不等于行为完全一致。Thinking、工具调用、动态工具、媒体和错误
   恢复都受 Provider 能力影响。
5. 持久化记录与 Transcript 包含大量会话事实，接入外部存储、日志或遥测时要重新
   审视隐私边界。

## 14. 推荐阅读顺序

1. [`apps/kimi-code/src/main.ts`](../../code/kimi-code/apps/kimi-code/src/main.ts)
   与
   [`run-shell.ts`](../../code/kimi-code/apps/kimi-code/src/cli/run-shell.ts)；
2. [`SDKRpcClient`](../../code/kimi-code/packages/node-sdk/src/sdk-rpc-client.ts)、
   [`KimiHarness`](../../code/kimi-code/packages/node-sdk/src/kimi-harness.ts)
   和 [`Session`](../../code/kimi-code/packages/node-sdk/src/session.ts)；
3. [`KimiCore`](../../code/kimi-code/packages/agent-core/src/rpc/core-impl.ts)
   与 [`Session`](../../code/kimi-code/packages/agent-core/src/session/index.ts)；
4. [`Agent`](../../code/kimi-code/packages/agent-core/src/agent/index.ts)
   和 [`TurnFlow`](../../code/kimi-code/packages/agent-core/src/agent/turn/index.ts)；
5. [`runTurn`](../../code/kimi-code/packages/agent-core/src/loop/run-turn.ts)、
   [`turn-step.ts`](../../code/kimi-code/packages/agent-core/src/loop/turn-step.ts)
   与 [`tool-call.ts`](../../code/kimi-code/packages/agent-core/src/loop/tool-call.ts)；
6. `ContextMemory`、`ToolManager`、`PermissionManager` 和 Compaction；
7. `kosong` 与 `kaos`；
8. 最后对照
   [`AgentLoopService`](../../code/kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts)
   和
   [`kap-server/start.ts`](../../code/kimi-code/packages/kap-server/src/start.ts)
   阅读 v2 的重构方向。
