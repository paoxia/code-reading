# OpenCode 源码架构与 Agent Harness 主链

相关专题：[Windows、Linux 与 macOS 跨平台适配](./cross-platform-adaptation.md)

> 原始研究版本：`anomalyco/opencode dev@d36a2d8981ba`
>
> 2026-08-19 增量复核版本：`dev@da4730e4a41d`（`1.18.18`）
>
> 2026-08-24 增量复核版本：`dev@03521003fafd`（`1.18.21`）
>
> 研究重点：默认 V1 产品主链，以及 `packages/core/src/session` 中正在演进的 V2
> durable Session Runner。两者并存，本文会明确区分，不把 V2 规划当成默认产品行为。

> 增量复核说明：本次 pull 主要是 Console/Web 生成内容、Zen 模型名和促销页调整；本文直接引用的 V2 `session/runner/llm.ts` 只有局部同步，未发现足以改写 V1/V2 边界的新默认路径。

> 2026-08-24 复核说明：默认 V1/V2 边界仍未切换，但 V1 Session 主链补齐了网络 finish variant 重试、unknown finish 继续处理、subagent tool error 上抛，以及 headless run 中代答 subagent permission。对应实现见 [`ai-sdk.ts`](../../code/opencode/packages/opencode/src/session/llm/ai-sdk.ts)、[`prompt.ts`](../../code/opencode/packages/opencode/src/session/prompt.ts)、[`task.ts`](../../code/opencode/packages/opencode/src/tool/task.ts) 和 [`run.ts`](../../code/opencode/packages/opencode/src/cli/cmd/run.ts)。

## 1. 先给结论

OpenCode 的 Harness 不是一个名为 `Harness` 的类，而是一组协作服务：

```text
CLI / TUI / Desktop / SDK
          │ HTTP + Event stream
          ▼
Session API / SessionPrompt
          │
          ├─ Session：消息与 Part 持久化
          ├─ SessionRunState：同 Session 串行、取消
          ├─ Agent / SystemPrompt / Instruction
          ├─ ToolRegistry / Permission / MCP / Plugin
          ├─ LLM：Provider 请求与统一 LLMEvent
          ├─ SessionProcessor：流事件归约、工具结算、快照
          └─ SessionCompaction / Summary / Revert
```

相比 pi 的显式 `AgentHarness`，OpenCode 把 Harness 横向拆进 Effect service graph，并通过
Server API 把 UI 与执行内核分开。即使 `opencode run` 在本进程执行，它也创建 SDK client，
通过内存 `fetch` 调用同一套 HTTP API，而不是让 CLI 直接调用 Agent Loop。

当前仓库还在建设第二套更耐久的 V2 Session 架构。V2 的核心变化是：

> “接受用户输入”先写入 durable inbox；“执行模型”由按 Session 串行的 Runner 在安全点
> 提升输入。Provider 流不持久化为一个可续传任务，但消息、工具调用、结算和 Context
> Epoch 以事件投影持久化。

## 2. Monorepo 和依赖边界

OpenCode 是 Bun/TypeScript Monorepo。与 Harness 最相关的包有：

| 包 | 职责 |
|---|---|
| [`packages/opencode`](../../code/opencode/packages/opencode) | 当前 CLI、Server、V1 Session、工具、权限、Provider、插件等产品主实现 |
| [`packages/core`](../../code/opencode/packages/core) | 数据库、Effect 节点、V2 Session/Runner、Location、工具注册等核心能力 |
| [`packages/llm`](../../code/opencode/packages/llm) | 统一 LLM request/event/client 抽象 |
| [`packages/schema`](../../code/opencode/packages/schema) | 公共数据 schema |
| [`packages/protocol`](../../code/opencode/packages/protocol) | 公共协议 |
| [`packages/server`](../../code/opencode/packages/server) | Server 公共基础能力 |
| [`packages/client`](../../code/opencode/packages/client) 与 [`packages/sdk`](../../code/opencode/packages/sdk) | 客户端与生成 SDK |
| [`packages/tui`](../../code/opencode/packages/tui)、[`packages/app`](../../code/opencode/packages/app)、[`packages/desktop`](../../code/opencode/packages/desktop) | 不同前端 |
| [`packages/plugin`](../../code/opencode/packages/plugin) | 插件公共 API |

仓库约束给出的新依赖方向是：

```text
Schema → Core / Protocol → Server
Client 可依赖 Schema / Protocol，但不能依赖 Core / Server
sdk-next 在最外层组合 Client、Core、Server
```

这说明项目正在把早期集中在 `packages/opencode` 的实现拆成可复用的内核与协议层。

## 3. 启动：CLI 不是执行内核

[`packages/opencode/src/index.ts`](../../code/opencode/packages/opencode/src/index.ts) 只负责：

- 配置 yargs 命令；
- 设置日志和运行环境变量；
- 分发 `run`、`tui`、`serve`、`web`、`acp`、`mcp` 等命令；
- 统一格式化错误和退出。

以非交互 [`run.ts`](../../code/opencode/packages/opencode/src/cli/cmd/run.ts) 为例，它创建
`@opencode-ai/sdk/v2` client，再调用 `client.session.prompt()` 或
`client.session.command()`。本地模式把 client 的 `fetch` 指向
[`Server.Default().app.fetch`](../../code/opencode/packages/opencode/src/server/server.ts)，远程
模式则走实际 HTTP。

```text
opencode run
  → createOpencodeClient()
  → POST /session/:id/prompt
  → HTTP handler
  → SessionPrompt.prompt()
  → SessionPrompt.loop()
```

这个“本地也走 API”设计有三个价值：

1. CLI、TUI、Desktop 和远程客户端共用协议；
2. UI 生命周期不拥有 Agent Loop；
3. Server 能独立处理权限响应、事件订阅、PTY 与多个 Session。

## 4. Server 和 Location 作用域

[`server/server.ts`](../../code/opencode/packages/opencode/src/server/server.ts) 用 Effect HttpApi
组装路由。`Server.Default()` 暴露内存 fetch；`listen()` 再叠加 Node HTTP listener、CORS、
WebSocket 跟踪和 mDNS。

请求经 workspace/directory routing 进入相应 instance context。当前代码大量使用
[`InstanceState`](../../code/opencode/packages/opencode/src/effect/instance-state.ts)：需要按目录
隔离的服务放进 `ScopedCache`，目录实例释放时自动清理订阅、进程和后台 fiber。

这相当于 Harness 的资源作用域：

```text
进程全局：Server、全局数据库/事件、跨 Location 路由
Location/目录：Config、Provider、ToolRegistry、Plugin、Session Runner 依赖
Session：消息、运行状态、权限请求、模型/Agent 选择
Provider turn：一次不可变 request 与其流事件
```

## 5. 当前默认 V1 主链

### 5.1 `prompt()` 先持久化用户消息

HTTP Session handler 位于
[`handlers/session.ts`](../../code/opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)。
它把请求交给
[`SessionPrompt.prompt()`](../../code/opencode/packages/opencode/src/session/prompt.ts)：

1. 读取 Session；
2. 清理 revert 状态；
3. `createUserMessage()` 解析 text、file、agent、MCP resource 等 part；
4. 持久化 message 与 parts；
5. 合并本次工具开关到 Session permission；
6. 若不是 `noReply`，进入 `loop()`。

输入首先成为 durable Session 数据，再开始模型调用。这比把用户消息只放进某个内存
`messages[]` 更适合 Server/多前端架构。

### 5.2 `SessionRunState` 保证一个 Session 只有一个 Runner

[`SessionRunState`](../../code/opencode/packages/opencode/src/session/run-state.ts) 按 instance 保存
`Map<SessionID, Runner>`：

- `ensureRunning()`：已有同 Session 运行就复用/协调，否则启动；
- `startShell()`：与 Agent Run 互斥地运行 Session Shell；
- `cancel()`：取消 Session Runner 和关联 background jobs；
- Runner idle 时删除映射并发布 idle status。

不同 Session 可以并行；同一 Session 的历史和工具结算保持串行。这是 Harness 的最低并发
不变量。

### 5.3 `runLoop()` 每轮从持久历史重新投影

[`SessionPrompt.runLoop()`](../../code/opencode/packages/opencode/src/session/prompt.ts) 的骨架是：

```text
while (true)
  ├─ status = busy
  ├─ 从数据库读取并过滤 compacted messages
  ├─ 找 lastUser / lastAssistant / lastFinished / pending task
  ├─ 已有正常最终 assistant？break
  ├─ 处理 subtask 或 compaction task
  ├─ 检查 context overflow，必要时插入 compaction task
  ├─ 解析 agent 与 model
  ├─ 应用 reminders
  ├─ 创建并持久化新的 assistant message
  ├─ SessionTools.resolve()
  ├─ 组装 system + model messages
  ├─ SessionProcessor.process()
  └─ stop / compact / continue
```

每轮不是继续使用长期可变的内存 context，而是重新从 Session 投影消息。这让工具结果、
Compaction 和插件修改能在下一轮重新进入权威历史。

退出判断不只看 `finish`。有些 Provider 即使响应里含 tool call 也返回 `stop`，因此代码还会
扫描 assistant parts；只有没有未处理 tool call 时才真正结束。

### 5.4 Agent、模型和系统上下文按轮解析

每轮根据最后一个 user message 的 `agent` 与 `model` 重新解析：

- Agent 来自 [`agent/agent.ts`](../../code/opencode/packages/opencode/src/agent/agent.ts)，携带
  mode、system prompt、permission、step limit 等配置；
- model 由 Provider service 解析；
- reminders 可插入 plan/build 切换等运行时提示；
- System Prompt 合并环境、指令、MCP 指令和 skill guidance；
- `MessageV2.toModelMessagesEffect()` 将持久化的 Message/Part 降级为 Provider 消息。

当达到 Agent `steps` 上限，最后请求附加 `MAX_STEPS_PROMPT`，要求模型收口，而不是无界
继续工具循环。

## 6. `SessionProcessor`：把流变成持久状态

[`SessionProcessor`](../../code/opencode/packages/opencode/src/session/processor.ts) 是 V1 Harness
中最关键的流归约器。`create()` 为一个 assistant message 创建局部 context，然后
`process()` 消费统一 `LLMEvent` stream。

### 6.1 事件到 Part 的映射

| LLMEvent | 持久化行为 |
|---|---|
| `text-start/delta/end` | 创建 text part，delta 发布增量，结束时保存最终文本 |
| `reasoning-start/delta/end` | 创建 reasoning part，保存 provider metadata 与时间 |
| `tool-input-*` | 创建/更新 pending tool part |
| `tool-call` | tool part 进入 running，检查 doom loop |
| `tool-result` | tool part 进入 completed，规范化附件 |
| `tool-error` | tool part 进入 error |
| `step-start` | 保存开始 snapshot |
| `step-finish` | 记录 usage、cost、结束 snapshot 与文件 patch |
| `provider-error` | 进入统一错误处理和重试策略 |

流式 delta 主要服务实时 UI；完整 part 和 durable event 才是恢复与重放边界。

### 6.2 工具调用的状态机

```text
pending（开始接收参数）
   → running（完整 tool-call）
       → completed（结果、附件、metadata、时间）
       → error（错误、保留进度 metadata、时间）
```

Processor 用 `Deferred` 跟踪每个 tool call。Provider stream 关闭后，它最多等待短暂结算；
仍未完成的调用会被写成 `Tool execution aborted`，并标记
`metadata.interrupted = true`。下一次 loop 会忽略这种 orphan，不会把它当成待继续工具。

### 6.3 Retry、Compaction 与停止

`process()` 用 [`SessionRetry`](../../code/opencode/packages/opencode/src/session/retry.ts) 对
Provider 错误应用策略，并把 Session status 切成 retry。检测到 context overflow 时返回
`compact`；权限/问题拒绝、assistant error 则返回 `stop`；正常工具结算返回 `continue`。

每次 process 都在 `ensuring(cleanup())` 中收尾，保证中断时完成当前 text/reasoning、结算
工具、更新时间和持久 assistant message。

## 7. LLM 层：两个 Runtime 收敛成同一种事件

[`session/llm.ts`](../../code/opencode/packages/opencode/src/session/llm.ts) 是 Session 与 Provider
之间的唯一完整边界。它负责：

- Provider/model/auth/config 解析；
- 插件参数和 header 变换；
- Provider 特定消息转换、缓存与 telemetry；
- 每请求选择 Runtime；
- 最终输出 `Stream<LLMEvent>`。

当前默认路径使用 Vercel AI SDK `streamText()`；
[`llm/ai-sdk.ts`](../../code/opencode/packages/opencode/src/session/llm/ai-sdk.ts) 把
`fullStream` 转成 `@opencode-ai/llm` 的事件。

实验性 native 路径由
[`llm/native-runtime.ts`](../../code/opencode/packages/opencode/src/session/llm/native-runtime.ts)
判断请求是否支持；支持时调用 `LLMClient`，不支持就给出具体原因并回退 AI SDK。两条路径
都向 Processor 发相同 `LLMEvent`，所以下游不需要两套状态机。

```text
SessionProcessor
      │ LLM.stream(input)
      ▼
request normalization
      │
      ├─ native supported → @opencode-ai/llm → LLMEvent
      └─ fallback/default → AI SDK fullStream → adapter → LLMEvent
```

## 8. 工具注册、执行与权限

### 8.1 `Tool.Def` 是内核工具合同

[`tool/tool.ts`](../../code/opencode/packages/opencode/src/tool/tool.ts) 定义：

- `id`、description、Effect Schema parameters；
- `execute(args, Tool.Context)`；
- result 的 title、metadata、output、attachments；
- `ctx.metadata()` 实时更新工具展示；
- `ctx.ask()` 请求权限。

`Tool.define()` 在初始化时编译参数 decoder；执行时统一：

1. Schema 校验；
2. 调用真实工具；
3. 对输出做截断并记录完整输出路径；
4. 附加 tracing attributes。

### 8.2 Registry 按模型动态选择工具

[`ToolRegistry`](../../code/opencode/packages/opencode/src/tool/registry.ts) 在 Location 内初始化
内置工具、项目目录自定义工具和插件工具。每个 Provider turn 调用 `tools()` 时还会：

- 根据 Provider 启用 web search；
- 对新 GPT 系列优先暴露 `apply_patch`，隐藏 edit/write；
- 按实验 flags 暴露 code mode、LSP、plan 工具；
- 动态补 task/subagent 描述；
- 允许插件修改工具定义。

因此“注册的全部工具”和“本轮发给模型的工具”不是同一个集合。

### 8.3 `SessionTools.resolve()` 完成产品适配

[`session/tools.ts`](../../code/opencode/packages/opencode/src/session/tools.ts) 把内核 `Tool.Def`
包装成 AI SDK tool，并注入本次 Session 的 context：

```text
registry tool
  → ProviderTransform.schema()
  → plugin tool.execute.before
  → Tool.Context(session/message/call/agent/abort)
  → permission ask / metadata updates
  → execute
  → plugin tool.execute.after
  → Processor 完成 tool part
```

它还把 MCP tools/resources 并入 catalog。MCP binary resource 有 MIME allowlist 和 10 MiB 限制，
不支持或过大的内容只给模型文本说明，不直接塞入附件。

### 8.4 权限规则是“最后一个匹配项生效”

[`Permission.evaluate()`](../../code/opencode/packages/opencode/src/permission/index.ts) 合并 Agent
规则、Session 规则和运行中批准，使用 wildcard 匹配，最后一个匹配规则生效；没有匹配时
默认 `ask`。

`ask()` 的流程是：

```text
allow → 直接继续
deny  → typed DeniedError
ask   → 保存 pending Deferred → 发布 Asked event
          → UI/API reply once/always/reject
          → resolve/reject Deferred
```

`always` 会把批准规则加入当前 instance 的内存 approved 集合，并自动放行同 Session 中已
满足的新 pending 请求。它是应用门禁，不等于 OS sandbox；Shell 仍以宿主用户权限执行。

## 9. Plugin、MCP、Skill 与 Subagent

插件公共 Hook 定义在
[`packages/plugin/src/index.ts`](../../code/opencode/packages/plugin/src/index.ts)，当前产品链支持：

- config、event、auth；
- `tool.definition`；
- `tool.execute.before/after`；
- `command.execute.before`；
- Provider request/header/response；
- experimental message/system/text transforms 等。

[`Plugin.Service`](../../code/opencode/packages/opencode/src/plugin/index.ts) 按 Location 加载插件，
把内部 EventV2 转发给插件，并在配置解析后通知插件。

Subagent 不是另一套 Loop。`task` 工具创建子 Session/任务上下文，再走同一套 prompt、工具、
权限和持久化服务。用户消息中的 `subtask` part 由 `SessionPrompt.handleSubtask()` 处理，并把
执行过程表现为父 Session 的 tool part。

## 10. Session 数据、Compaction、Snapshot 与 Revert

当前 V1 Session 把 message 与不同类型 part 存入数据库。Part 不只是 UI 片段，也是运行
状态：text、reasoning、tool、step-start/end、patch、file、subtask、compaction 等都在其中。

每轮工具执行前后由 Snapshot service 捕获工作区状态；`step-finish` 比较快照并持久化文件
patch。这使 Session 能展示“本轮改了哪些文件”，也为 revert 提供基础。

Compaction 位于
[`session/compaction.ts`](../../code/opencode/packages/opencode/src/session/compaction.ts)：

- 根据模型窗口和 token usage 判断 overflow；
- 插入 compaction task；
- 用专用 Agent 生成摘要；
- 后续 `MessageV2.filterCompactedEffect()` 选择模型可见历史；
- 完整历史仍留在数据库；
- 结束后异步 prune 过大的旧工具输出。

## 11. V2：更耐久的 Harness 正在如何重构

V2 代码位于
[`packages/core/src/session`](../../code/opencode/packages/core/src/session)，设计说明在
[`specs/v2/session.md`](../../code/opencode/specs/v2/session.md)。它不是默认 V1 主链的简单改名，
而是把“记录输入、执行、事件投影、Location 归属”重新分离。

### 11.1 Prompt admission 与执行分离

[`SessionV2.prompt()`](../../code/opencode/packages/core/src/session.ts) 不直接调用 Provider：

```text
校验 Session
  → SessionInput.admit()
  → 发布 durable PromptAdmitted event
  → projector 写 session_input inbox
  → execution.wake(sessionID)
  → 立即返回 admission receipt
```

调用者可传稳定 message ID。相同 ID、Session、prompt、delivery 的精确重试返回同一 admission；
复用 ID 但内容冲突会失败。`resume: false` 只入队不唤醒执行。

这解决了 Server API 中一个关键问题：HTTP 请求成功与 Provider 执行成功不再是同一个事务。
只要 admission 已持久化，客户端就知道输入被接受。

### 11.2 Durable inbox 有 steer 和 queue 两种 delivery

[`SessionInput`](../../code/opencode/packages/core/src/session/input.ts) 保存 `admitted_seq` 和
`promoted_seq`：

- `steer` 在下一个安全 Provider turn 边界批量提升；
- `queue` 只有当前 drain 原本要 idle 时才 FIFO 提升一条；
- `Prompted` event 同时把输入投影成模型可见 user message，并标记 promoted；
- durable event sequence 决定顺序，不依赖调用者时间戳或随机 ID。

这比纯内存队列更接近可恢复 Harness。进程退出后，未提升 inbox row 仍在。

### 11.3 全局 Execution 路由，Location 内 Runner

[`SessionExecution`](../../code/opencode/packages/core/src/session/execution.ts) 只接收 Session ID：

```text
SessionExecution.resume/wake(sessionID)
  → SessionStore.get(sessionID)
  → 读取 session.location
  → LocationServiceMap.get(location)
  → 在该 Location layer 中 SessionRunner.run()
```

`SessionExecution` 和 read-side store 是进程全局；Runner、模型解析、ToolRegistry、Permission
和文件系统是 Location scoped。这里没有把 Session ID 注入全局 ambient context，减少跨
Session 污染。

### 11.4 `SessionRunCoordinator` 的并发语义

[`run-coordinator.ts`](../../code/opencode/packages/core/src/session/run-coordinator.ts) 为每个
Session 维护一个 entry：

- 显式 `run` 在活跃时 join 同一个 Deferred；
- 多次 `wake` 合并为一个 `pendingWake`；
- 当前 drain 成功后若有 wake，启动 successor；
- `interrupt` 中断 owner，并等待 cleanup；
- 不同 Session key 仍可并发。

这是 V2 Harness 的进程内调度器，不是 durable job queue。进程重启后 active registry 为空。

### 11.5 V2 Runner 一次只显式调用一个 Provider turn

[`runner/llm.ts`](../../code/opencode/packages/core/src/session/runner/llm.ts) 的每个
`runTurnAttempt()` 只调用一次 `llm.stream(request)`：

1. 校验 Session 仍属于当前 Location；
2. 选择 Agent，初始化或更新 Context Epoch；
3. 在安全点提升 inbox；
4. 解析 model、history、tool definitions；
5. 必要时先 Compaction；
6. 捕获起始 snapshot；
7. 消费一次 Provider stream，并把事件串行持久化；
8. 每个完整本地 tool call 先 durable publish，再 eager 启动 child fiber；
9. 流关闭后等待所有已启动工具结算；
10. 记录 step end 和文件变化；
11. 外层 loop 重新加载投影历史，决定下一 Provider turn。

```text
while Session drain has work
  while needsContinuation
    promote safe input
    reload durable history
    reconcile System Context
    compact if needed
    exactly one llm.stream(request)
    durably publish assistant/tool events
    await local tool settlements
```

Provider tool calls的 child execution 可以并行，但 event publication 用 `Semaphore(1)` 串行，
保证同一 turn 的 durable 投影顺序。

### 11.6 崩溃边界更保守

Runner 开始时扫描历史中仍是 pending/running 的工具，持久化为
`Tool execution interrupted`，不会自动重放副作用。Provider stream 本身也不声称可续传。

目前未完成的 post-crash continuation recovery 需要额外区分：输入已提升、Provider 是否已
发出、是否已有 durable assistant output、工具是否幂等。源码明确把它留作未来设计。

### 11.7 Context Epoch 持久化特权上下文

V2 不只持久消息，还持久“当时发给模型的系统上下文基线”：环境、日期、AGENTS.md、skill
guidance 等先由独立 Context Source 观察，再形成 immutable Context Epoch。

安全边界发现上下文变化时，Runner 写一条 chronological system message，并原子更新 epoch
snapshot。Compaction 后重新生成完整 baseline；Session 移动 Location 时清空 epoch。

它解决了常见的不可复现问题：会话恢复后 AGENTS.md 已变化，如果只重新读取当前文件，就
无法知道历史请求看到了什么。

## 12. V1 与 V2 不要混淆

| 维度 | 当前默认 V1 | 正在演进的 V2 |
|---|---|---|
| 主入口 | `SessionPrompt.prompt/loop` | `SessionV2.prompt` + `SessionExecution` |
| 输入排队 | 主要依赖当前消息/运行状态 | durable `session_input` inbox |
| Loop | `SessionPrompt` 大编排循环 | Location-scoped `SessionRunner` |
| 并发 | `SessionRunState` + Runner | process-global `SessionRunCoordinator` |
| 流归约 | `SessionProcessor` 更新 message/parts | LLMEvent publisher + durable event projector |
| 工具 | 完整 built-in/MCP/plugin 产品能力 | core registry 已能结算部分工具，仍缺 V1 parity |
| 系统上下文 | 每轮组装 | Context Epoch baseline + chronological update |
| Compaction | 产品能力较完整 | 自动/overflow compaction 已实现，手动 API 未完成 |
| Plugin/Reminder/structured output | 已有 | 多项仍 missing |
| 崩溃恢复 | 依赖持久消息，运行态有限 | durable inbox/event 更强，但 continuation recovery 仍未完成 |

V2 规格中的 parity 表明确列出 provider-specific base prompt、插件 transforms、结构化输出、
原生 template/@ mention 等缺口。因此现在学习产品行为应读 V1，学习 durable Harness 方向再
读 V2。

## 13. OpenCode 与 pi 的 Harness 对比

| 维度 | pi 新 `AgentHarness` | OpenCode V1/V2 |
|---|---|---|
| 组织形式 | 一个显式 class 加低层函数 | 多个 Effect service 组成运行时图 |
| 最小 Loop | `runAgentLoop()` 很独立 | V1 Loop 在 `SessionPrompt`，V2 下沉到 `SessionRunner` |
| UI 边界 | SDK 对象与事件订阅 | Server/API-first，前端普遍通过 SDK/HTTP |
| 状态快照 | 明确 `TurnState` + save point | 每轮从 durable history 和 scoped service 重新物化 |
| 队列 | steer/follow-up/nextTurn，当前在内存 | V2 steer/queue durable inbox |
| 会话 | JSONL 追加树和 leaf | SQLite/event projection，V2 以 aggregate sequence 排序 |
| 扩展 | 新通用 Hook 未完成，coding-agent 旧 extension 丰富 | V1 plugin/MCP 完整，V2 parity 未完成 |
| 并发模型 | 单 Harness 单 phase/run | 同 Session 串行，多 Session/Location 并行 |
| 恢复目标 | 文档定义 semi-durable | durable admission/event/context，更偏 Server runtime |
| 学习优势 | 边界清晰，容易从零复刻 | 展示生产级多前端、权限、事件和持久调度复杂度 |

二者的共同原则比 API 更重要：

1. Provider turn 是不可变边界；
2. 工具副作用前后要有可观察、最好可持久化的状态；
3. 同一 Session 必须串行，不同 Session 可以并行；
4. UI 不应成为消息历史或运行生命周期的唯一所有者；
5. 崩溃后不自动重放未知是否完成的非幂等工具。

## 14. 如何亲手试 OpenCode Harness

### 14.1 启动默认产品主链

按仓库要求用 Bun，并从根启动开发 CLI：

```powershell
cd code/opencode
bun install
bun dev
```

也可以直接从包目录启动：

```powershell
cd code/opencode/packages/opencode
bun dev
```

这会进入实际 TUI，需要已配置 Provider。建议在一个临时项目目录运行，避免模型工具修改
OpenCode 源码仓库。

### 14.2 用非交互 `run` 观察 API-first 链路

从已构建/可运行环境调用：

```powershell
opencode run "只列出当前目录，不修改文件"
```

调试时按以下位置打断点：

1. [`cli/cmd/run.ts`](../../code/opencode/packages/opencode/src/cli/cmd/run.ts) 中
   `client.session.prompt()`；
2. [`handlers/session.ts`](../../code/opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)
   的 prompt handler；
3. `SessionPrompt.prompt()` 和 `runLoop()`；
4. `SessionTools.resolve()`；
5. `SessionProcessor.process()`/`handleEvent()`；
6. `LLM.stream()`。

这样可以看到同进程 SDK → HTTP → Effect service → Provider 的完整跳转。

### 14.3 跑小范围测试，不从仓库根跑全量测试

仓库明确禁止从根运行测试。可从包目录运行聚焦用例：

```powershell
cd code/opencode/packages/opencode
bun test test/session/llm.test.ts
bun test test/session/message-v2.test.ts
bun test test/permission/next.test.ts
```

V2 Runner 的测试在 core 包：

```powershell
cd code/opencode/packages/core
bun test test/session-runner.test.ts
bun test test/session-runner-recorded.test.ts
bun test test/session-projector.test.ts
```

这些测试比直接跑 TUI 更适合观察 durable event 顺序、工具结算、输入提升和恢复边界。

### 14.4 建议做四个对照实验

1. **权限实验**：配置同一工具的 wildcard allow 和具体 deny，验证最后匹配规则生效。
2. **取消实验**：工具运行中 abort，检查 tool part 是否变成 interrupted error，Session 是否 idle。
3. **Compaction 实验**：构造较长历史，比较数据库完整 parts 与发给模型的 compacted messages。
4. **V2 inbox 实验**：阅读/改单元测试，先 `prompt(..., resume:false)`，确认只 admission；再
   `resume()`，观察 `PromptAdmitted → Prompted → assistant/tool events`。

## 15. 从两套实现提炼 Harness 设计方法

如果自己实现 Coding Agent Harness，可以按这个顺序：

```text
1. 定义统一消息和 LLMEvent
2. 写“一次 Provider turn”的纯执行器
3. 写外层 continuation/tool loop
4. 给同 Session 加串行 coordinator 和 abort
5. 把用户输入先 admission，再执行
6. 在副作用前 durable 记录 tool call，之后 durable settle
7. 将 UI 放在事件/API 外侧
8. 把工具、模型、文件系统放进 Location/Workspace scope
9. 加权限 Deferred 和人工响应 API
10. 最后加入 compaction、context epoch、retry 和恢复策略
```

需要始终回答四个问题：

- 当前权威状态在内存、JSONL 还是数据库投影？
- 一个 Hook/客户端重入时，写入排在当前 assistant/tool result 前还是后？
- 进程在这一行崩溃，重启后能区分“未开始”和“可能已产生副作用”吗？
- 同 Session 的第二个请求是 join、steer、queue、reject，还是并发执行？

如果这四个问题没有明确答案，Harness 还只是一个 Demo Loop。

## 16. 限制、风险和源码标注

### 当前 V1

1. `SessionPrompt` 仍是较大的编排模块，Agent Loop、任务、Compaction、Prompt expansion 等关注
   点集中，项目正通过 Effect services/V2 拆分。
2. 权限系统是应用层审批，不是操作系统沙箱；bash 拥有宿主用户权限。
3. AI SDK 与 native LLM runtime 并存，native 仍是实验性按请求 gate。
4. Plugin Effect V2 API 仍有 PLAN 文档和未完成项。
5. 部分工具和模式由 experimental flags 控制，不能当成稳定默认能力。

### V2

1. 多节点/集群 Session ownership 与 stale-runtime fencing 未完成。
2. durable busy/retry/idle/terminal status 尚未完整实现。
3. Provider timeout、retry 和 watchdog policy 有意延后。
4. V1 的 Plugin、structured output、reminders、完整工具 catalog 和 prompt expansion 尚未全部迁移。
5. post-crash continuation recovery 未实现；`wake` 不会猜测已提升的 Provider 工作是否安全重试。
6. 本地工具 eager 并发当前无界，未来需要 call limit、输出 backpressure 和并发策略。
7. V2 `shell`、`skill`、手动 `compact`、`wait` 的 Session facade 当前直接返回
   `OperationUnavailableError`。

## 17. 推荐阅读顺序

### 先读当前产品链

1. [`src/index.ts`](../../code/opencode/packages/opencode/src/index.ts) 和
   [`cli/cmd/run.ts`](../../code/opencode/packages/opencode/src/cli/cmd/run.ts)。
2. [`server/server.ts`](../../code/opencode/packages/opencode/src/server/server.ts) 与 Session handler。
3. [`session/prompt.ts`](../../code/opencode/packages/opencode/src/session/prompt.ts)，重点读
   `prompt()`、`runLoop()`、`loop()`。
4. [`session/processor.ts`](../../code/opencode/packages/opencode/src/session/processor.ts)。
5. [`session/llm.ts`](../../code/opencode/packages/opencode/src/session/llm.ts) 和两个 Runtime adapter。
6. [`session/tools.ts`](../../code/opencode/packages/opencode/src/session/tools.ts)、
   [`tool/registry.ts`](../../code/opencode/packages/opencode/src/tool/registry.ts)、
   [`permission/index.ts`](../../code/opencode/packages/opencode/src/permission/index.ts)。
7. `message-v2`、Compaction、Snapshot、Revert。
8. Plugin、MCP、task/subagent。

### 再读 V2 durable Harness

1. [`specs/v2/session.md`](../../code/opencode/specs/v2/session.md)：先掌握已完成/缺失清单。
2. [`packages/core/src/session.ts`](../../code/opencode/packages/core/src/session.ts)：Session facade。
3. [`session/input.ts`](../../code/opencode/packages/core/src/session/input.ts)：admit/promote。
4. [`session/execution/local.ts`](../../code/opencode/packages/core/src/session/execution/local.ts) 和
   [`session/run-coordinator.ts`](../../code/opencode/packages/core/src/session/run-coordinator.ts)。
5. [`session/runner/llm.ts`](../../code/opencode/packages/core/src/session/runner/llm.ts)。
6. Session events、projector、history、Context Epoch 和 Compaction。
7. 最后用 core Session Runner 测试验证时序。

## 18. 核心结论

OpenCode 当前给出的 Harness 答案有两层：

> V1 用 API-first Server、持久 Session、按 Session 串行的运行状态、统一 LLMEvent、
> SessionProcessor、动态工具/权限/插件组成完整产品运行时；V2 则进一步把输入 admission、
> Location-scoped execution、durable event projection、Context Epoch 和工具副作用边界拆开。

学习时最关键的不是记住所有 Effect service，而是沿一条消息追踪它如何经历“接受、提升、
请求、流式归约、工具结算、持久化、继续或停止”。这条链就是 OpenCode 的 Harness。
