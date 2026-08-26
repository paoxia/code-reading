# pi 源码架构与 Agent Harness 实现

> 原始研究版本：`earendil-works/pi main@3a40794ea14c`
>
> 2026-08-19 增量复核版本：`main@ed867e909479`（`@earendil-works/pi-* 0.84.2`）
>
> 2026-08-24 增量复核版本：`main@4af9d21d3b4d`（`@earendil-works/pi-coding-agent 0.84.2`）
>
> 研究重点：`packages/ai`、`packages/agent`、`packages/coding-agent` 和
> `packages/tui`。`packages/orchestrator` 的包描述明确标注为 experimental，本文只说明
> 它的边界，不把它当成主运行时。

相关专题：

- [基于 pi 构建自有 Coding Agent：架构与实施方案](./build-your-own-coding-agent.md)
- [大模型 API 差异适配](./model-api-adaptation.md)
- [Windows、Linux 与 macOS 跨平台适配](./cross-platform-adaptation.md)

## 1. 先给结论

pi 最值得学习的不是某一个工具，而是它把 Coding Agent 拆成了三层：

本轮没有改变三层主线或 `AgentHarness` 的 scaffold 边界，但产品分发明显增强：Coding Agent bundle 开始携带 Node runtime，托管安装可原地升级；`/model` 与 thinking level 的修改保持 session-scoped，只有显式保存才进入设置；模型配置可覆盖 finish reason compatibility。实现见 [`build-coding-agent-bundle.mjs`](../../code/pi/scripts/build-coding-agent-bundle.mjs)、[`package-manager-cli.ts`](../../code/pi/packages/coding-agent/src/package-manager-cli.ts)、[`agent-session.ts`](../../code/pi/packages/coding-agent/src/core/agent-session.ts) 与 [`model-config.ts`](../../code/pi/packages/coding-agent/src/core/model-config.ts)。

```text
runAgentLoop()       纯执行循环：LLM → tool → LLM
       ▲
       │
Agent                进程内有状态包装：消息、队列、事件、取消
       ▲
       │
AgentHarness         目标应用编排层；当前新版本仍是公开 API scaffold
       ▲
       │
coding-agent         产品层：CLI/TUI、配置、扩展、内置工具、认证
```

这里的 **Harness** 可以理解为“让 Agent Loop 成为一个可嵌入、可持久化、可观察、可在
运行时安全修改的应用运行时”。它不负责替模型思考，也不应该把所有逻辑塞进循环；它负责
规定状态的所有权、何时可以变更状态、什么必须持久化、模型请求使用哪一份快照，以及错误
和取消如何收口。

但阅读时必须区分“默认 CLI/TUI 产品路径”和“正在重写的 durable Harness 路径”：

- 新的 [`AgentHarness`](../../code/pi/packages/agent/src/harness/agent-harness.ts) 已公开完整接口，
  但当前类名和方法签名先于执行器落地：`prompt()`、队列、Hook、Compaction、lane、恢复和
  watch API 都会显式抛出 `HarnessNotImplemented`。已落地的是 Session/Storage、记录类型、
  reducer、工具和 Compaction helper 等基础设施。
- 默认 [`pi-coding-agent`](../../code/pi/packages/coding-agent/src/core/sdk.ts) 仍创建
  `Agent + AgentSession`；同时 server 已有 [`create-harness.ts`](../../code/pi/packages/coding-agent/src/server/create-harness.ts)
  负责组装新 Harness 的工具和 system prompt，但它返回的仍是上述 scaffold，不能作为可运行
  Agent 使用。目标契约见 [`harness.md`](../../code/pi/packages/agent/docs/harness.md)，不能把规范
  文档中的流程当成当前实现。

## 2. Monorepo 分层

根 [`package.json`](../../code/pi/package.json) 的构建顺序直接表达了依赖方向：

```text
pi-tui → pi-ai → pi-agent-core → session-backends/protocol/client → pi-coding-agent → pi-server
```

| 包 | 核心职责 | 关键入口 |
|---|---|---|
| `packages/ai` | 统一模型、Provider、流式事件、认证与模型目录 | [`src/models.ts`](../../code/pi/packages/ai/src/models.ts)、[`src/providers`](../../code/pi/packages/ai/src/providers) |
| `packages/agent` | 通用 Agent Loop、`Agent`、新 `AgentHarness` | [`src/agent-loop.ts`](../../code/pi/packages/agent/src/agent-loop.ts)、[`src/agent.ts`](../../code/pi/packages/agent/src/agent.ts) |
| `packages/coding-agent` | Coding Agent 产品能力、工具、会话、扩展、CLI/TUI/RPC | [`src/main.ts`](../../code/pi/packages/coding-agent/src/main.ts)、[`src/core/sdk.ts`](../../code/pi/packages/coding-agent/src/core/sdk.ts) |
| `packages/tui` | 终端组件和差量渲染 | [`src`](../../code/pi/packages/tui/src) |
| `packages/session-backends` | SQLite 等 Session 持久化后端 | [`session-backends`](../../code/pi/packages/session-backends) |
| `packages/protocol` / `client` / `server` | 服务协议、客户端与服务端入口 | [`protocol`](../../code/pi/packages/protocol)、[`client`](../../code/pi/packages/client)、[`server`](../../code/pi/packages/server) |

这个拆分让 `packages/agent` 不知道文件编辑器、终端 UI 或具体 Provider；`coding-agent`
则把通用内核产品化。

## 3. 第一层：`runAgentLoop()` 才是真正的循环

核心实现是
[`runAgentLoop()`](../../code/pi/packages/agent/src/agent-loop.ts)，它接收：

- 新输入 `prompts`；
- 当前 `AgentContext`，包含 system prompt、消息和工具；
- `AgentLoopConfig`，包含模型、上下文转换、队列、工具 Hook 等策略；
- 一个事件接收器 `emit`；
- `AbortSignal` 和可替换的 `streamFn`。

主循环可以压缩成：

```text
追加并发布新 user message
          │
          ▼
┌──────────────── provider turn ────────────────┐
│ 注入 steer 消息                               │
│ transformContext → convertToLlm               │
│ streamFn(model, context, options)              │
│ 流式发布 message_start/update/end             │
│                                               │
│ 有 tool calls？                               │
│   ├─ 否：结束当前 turn                         │
│   └─ 是：校验 → beforeToolCall → 执行 →        │
│           afterToolCall → toolResult message   │
└──────────────────────┬────────────────────────┘
                       │
             prepareNextTurn 刷新下一轮快照
                       │
       ┌───────────────┴────────────────┐
       │仍有工具/steer                  │否则检查 followUp
       └──────▶ 下一 provider turn       └──────▶ 继续或 agent_end
```

### 3.1 两层循环对应两类排队语义

[`runLoop()`](../../code/pi/packages/agent/src/agent-loop.ts) 有内外两层循环：

- 内层处理 tool call 与 steering message；steer 会在当前 Agent 原本还要继续时，于下一次
  Provider 请求前注入。
- 外层在 Agent 原本准备停止时检查 follow-up；有 follow-up 才重新进入内层。

这不是 UI 细节，而是 Harness API 的语义合同：

| API | 插入位置 | 适合用途 |
|---|---|---|
| `steer` | 当前运行的下一个安全 Provider 边界 | 纠正正在进行的任务 |
| `followUp` | Agent 原本将结束以后 | 排队一个后续任务 |
| `nextRun` | 下一次显式 `prompt()` 之前；新 `AgentHarness` 已声明但尚未实现 | 为未来一轮预置上下文 |

队列模式支持 `one-at-a-time` 和 `all`。前者每个安全点只取一条，让模型有机会逐条响应；
后者一次注入全部。

### 3.2 模型边界保持单一

内部一直保存 `AgentMessage[]`，只在
[`streamAssistantResponse()`](../../code/pi/packages/agent/src/agent-loop.ts) 中执行：

```text
AgentMessage[]
  → transformContext()
  → convertToLlm()
  → pi-ai Context
  → streamFn()/streamSimple()
```

自定义消息、Compaction 消息和产品层消息可以留在 Agent 语义中，不必污染每个 Provider
适配器。`convertToLlm` 是统一的降级边界。

### 3.3 流不是简单字符串流

Provider 流被转换成 `message_start`、`message_update`、`message_end`。增量事件覆盖 text、
thinking 和 tool call 三类内容。循环会把 partial assistant message 暂时放进 context，并随
delta 原位更新；结束时再替换为 final message。

这带来两个好处：

1. UI 只订阅统一事件，不需要理解各 Provider 的 SSE/WebSocket 格式。
2. Harness 可以在完整消息结束时做持久化，而不是尝试持久化每一个不稳定 delta。

### 3.4 工具并发与确定性顺序

工具默认并行执行；只要全局配置为 `sequential`，或其中一个工具声明
`executionMode: "sequential"`，整批就顺序执行。相关代码在
[`executeToolCalls()`](../../code/pi/packages/agent/src/agent-loop.ts)。

并行模式有一个很好的确定性设计：

- `tool_execution_end` 可以按真实完成先后发布，便于 UI 实时展示；
- 最终 tool-result messages 仍按模型原始 tool-call 顺序写回上下文。

因此“观察顺序”可以反映并发，“持久历史顺序”仍可复现。测试
[`agent-loop.test.ts`](../../code/pi/packages/agent/test/agent-loop.test.ts) 专门覆盖了这一点。

如果 assistant 因输出 token 上限以 `length` 结束，循环不会执行看似已经能解析的工具
参数。流式 JSON 的容错解析可能把截断参数修补成合法但不完整的对象，因此所有该消息中的
tool call 都会收到错误结果，要求模型重新发起；这是很重要的安全细节。

## 4. 第二层：`Agent` 是轻量的进程内状态机

[`Agent`](../../code/pi/packages/agent/src/agent.ts) 在低层循环上增加：

- 当前消息、模型、thinking level、工具等内存状态；
- steer/follow-up 队列；
- 事件订阅；
- 单活跃运行约束；
- AbortController 与 `waitForIdle()`；
- 把 loop event 归约到当前状态。

`prompt()` 的关键路径很短：

```text
normalizePromptInput()
  → createContextSnapshot()
  → createLoopConfig()
  → runAgentLoop()
  → processEvents() 归约 AgentState
```

`Agent` 会拒绝并发 `prompt()`，要求调用者用 steer、follow-up 或等待结束。事件监听器按订阅
顺序逐个 `await`；`agent_end` 发出后也要等监听器完成，运行才真正 idle。

它仍然不是完整 Harness：消息只在内存中，资源发现、持久化树、Compaction、分支导航和
扩展写入顺序都不由它负责。

## 5. 第三层：`AgentHarness` 正在经历不兼容重写

### 5.1 当前落地的是 scaffold，不是执行器

当前 [`AgentHarness`](../../code/pi/packages/agent/src/harness/agent-harness.ts) 的公开接口已经按
新规范展开，但实现刻意 fail closed。源码和
[`agent-harness-scaffold.test.ts`](../../code/pi/packages/agent/test/harness/agent-harness-scaffold.test.ts)
共同确认：

| 能力 | 当前状态 |
|---|---|
| `create()` 打开无 operation record 的 Session | 已实现；返回空 `suspended` |
| model、thinking、tools、resources、stream/retry/compaction 配置 getter/setter | 已实现；数组和对象做 defensive copy |
| `getLeafId()`、`close()` | 已实现 |
| 恢复已有 operation record | 未实现；`create.restore` 抛 `HarnessNotImplemented` |
| `prompt`、skill/template、steer/follow-up/nextRun、abort | 未实现 |
| compact、navigate、resume、lane、watch、manual drive | 未实现 |
| Hook 和 Event 注册 | 未实现；注册时直接抛错 |

因此不能沿 `AgentHarness.prompt()` 追踪一次真实模型调用，也不能根据方法签名声称 Retry、
Compaction 或恢复已经连入运行主链。

### 5.2 已实现的底座比 facade 更靠前

这次重写并非只有接口占位。以下底层组件已有源码和确定性测试：

- Session 的 entry tree、lane pointer、operation/queue/tool/usage record；
- 内存与 JSONL Storage/Repository，以及共用 conformance suite；
- [`reducer.ts`](../../code/pi/packages/agent/src/harness/reducer.ts) 中的纯状态归约；
- Compaction、branch summary、Skill、prompt template、system prompt helper；
- Node `ExecutionEnv`、read/bash/edit/write/image 工具及文件写入串行化；
- telemetry schema 和事件类型。

这些组件说明了新方向，也能独立验证，但尚缺把它们串成可执行 operation interpreter 的那一层。

### 5.3 `harness.md` 是实现规格

[`harness.md`](../../code/pi/packages/agent/docs/harness.md) 定义了三类持久数据、operation program
counter、effect sandwich、lane、checkpoint、恢复和 Hook 契约。文档标题也明确写着
`implementation specification`；当前应把它用于理解目标与审查实现进度，而不是作为功能已经
可用的证据。

## 6. Session：已落地的 entry、record 与 lane

[`Session`](../../code/pi/packages/agent/src/harness/session/session.ts) 依赖 `SessionStorage`，仓库提供：

- [`InMemorySessionStorage` / `InMemorySessionRepo`](../../code/pi/packages/agent/src/harness/session/memory.ts)；
- [`JsonlSessionStorage`](../../code/pi/packages/agent/src/harness/session/jsonl/storage.ts) 与
  [`JsonlSessionRepo`](../../code/pi/packages/agent/src/harness/session/jsonl/repo.ts)。

当前持久模型把数据分成三类：

- `Entry`：message、model/thinking/tool change、compaction、branch summary、custom；
- `LaneRecord`：operation start/finish、step/tool attempt、queue、deferred write、usage；
- lane pointer 与 name/label 等可变事实。

Entry 通过 `parentId` 形成追加树，lane 保存各自游标。`Session.view(lane)` 暴露限定 lane 的树
视图，Storage 保证同一 lane 同时最多一个 open operation。JSONL codec、重开、fork 和内存/
文件后端一致性都有对应测试；这是当前最成熟的 durable 部分。

## 7. Reducer、Compaction 与工具：算法已在，编排未接

[`reducer.ts`](../../code/pi/packages/agent/src/harness/reducer.ts) 能根据 entry/record 归约 operation、
队列、pending write 和 fault 状态；Compaction helper 能计算切点、生成摘要并构建压缩后的上下文。
但是 `AgentHarness.compact()`、`navigateTree()` 和 `resume()` 仍直接走 `unavailable()`。

同样，`harness/tools` 已实现可复用工具和 `ExecutionEnv`，而
[`create-harness.ts`](../../code/pi/packages/coding-agent/src/server/create-harness.ts) 已能把 coding-agent
的 system prompt 与这些工具装进 `AgentHarness.create()`；这证明产品适配层已经开始迁移，
不等于新 server runtime 已能执行 prompt。

## 8. Hook、事件与错误边界

`HookName`、`Events` 和 telemetry schema 已定义目标观察面，但 `hooks`/`events` 当前由
`UnavailableRegistry` 实现。未完成操作统一抛 `HarnessNotImplemented`，关闭后则抛
`HarnessClosed`。这是有意的显式失败边界，避免 facade 在状态机尚未接通时表现成“调用成功但
什么也没做”。

## 9. 当前 `pi-coding-agent` 如何组装产品

### 9.1 启动装配

[`createAgentSession()`](../../code/pi/packages/coding-agent/src/core/sdk.ts) 是当前最重要的产品
组装入口：

```text
解析 cwd / agentDir
  ├─ ModelRuntime：认证、模型目录、Provider
  ├─ SettingsManager：用户/项目设置
  ├─ SessionManager：当前旧版 JSONL 会话
  └─ ResourceLoader：扩展、skills、prompt/context files
          │
          ▼
创建 Agent
  ├─ streamFn → ModelRuntime.streamSimple
  ├─ transformContext → ExtensionRunner
  ├─ Provider payload/response hooks
  └─ steer/follow-up/runtime options
          │
          ▼
创建 AgentSession
  ├─ 内置 coding tools
  ├─ active tool 过滤
  ├─ system prompt
  ├─ extensions
  ├─ compaction/retry/tree navigation
  └─ 暴露给 interactive/print/RPC mode
```

[`AgentSession`](../../code/pi/packages/coding-agent/src/core/agent-session.ts) 超过三千行，说明
产品层已经承担了大量 Harness 职责。新的 `packages/agent/AgentHarness` 正在尝试把其中可
复用、与 UI 无关的部分下沉；server 组装代码已经出现，但可执行 runtime 尚未接通。

CLI 的 [`main()`](../../code/pi/packages/coding-agent/src/main.ts) 创建 cwd-bound services 和
[`AgentSessionRuntime`](../../code/pi/packages/coding-agent/src/core/agent-session-runtime.ts)，
再选择 interactive、print 或 RPC mode。`AgentSessionRuntime` 在 `/new`、`/resume`、
`/fork` 时销毁旧 session 与扩展上下文，重建 cwd-bound services，然后让 UI rebind；这比
只替换一个消息数组更安全。

### 9.2 一次产品级 Prompt 的完整调用链

真正的产品调用并不是直接执行 `runAgentLoop()`。从用户输入到运行收口，路径是：

```text
AgentSession.prompt(text, options)
  ├─ input extension：handled / transform / continue
  ├─ 处理 extension command
  ├─ 展开 /skill:name 与 prompt template
  ├─ 运行中输入显式映射为 steer 或 followUp
  ├─ 校验 model/auth，并在必要时先做 compaction
  ├─ 合并 nextTurn custom messages
  ├─ before_agent_start 可追加消息或覆盖本轮 system prompt
  └─ _runAgentPrompt(messages)
          │
          ▼
Agent.prompt()
  ├─ 拒绝第二个并发普通 prompt
  ├─ createContextSnapshot()
  ├─ createLoopConfig()
  └─ runAgentLoop()
          │
          ▼
模型流 → Tool batch → ToolResult → 下一 Provider turn
          │
          ▼
Agent.processEvents()
  ├─ 归约 messages / streamingMessage / pendingToolCalls
  └─ 按订阅顺序等待 listener
          │
          ▼
AgentSession._handleAgentEvent()
  ├─ 转发 extension 与产品事件
  ├─ message_end 写入 SessionManager
  └─ 收集 retry / compaction 所需状态
          │
          ▼
_handlePostAgentRun()
  ├─ retryable error → 准备重试
  ├─ threshold/overflow → 自动 compaction
  ├─ agent_end Hook 新增了队列消息 → continue
  └─ _emitAgentSettled()
```

对应入口是
[`AgentSession.prompt()`](../../code/pi/packages/coding-agent/src/core/agent-session.ts)、
[`Agent.prompt()`](../../code/pi/packages/agent/src/agent.ts) 和
[`runAgentLoop()`](../../code/pi/packages/agent/src/agent-loop.ts)。这条链说明 `AgentSession`
不是一个薄 SDK Facade：它负责输入准入和产品后处理，`Agent` 负责单次内存运行，Loop 才负责
模型与工具的纯编排。

### 9.3 四层状态所有权

| 层 | 拥有的状态 | 生命周期 | 不负责什么 |
|---|---|---|---|
| `runAgentLoop()` | 本次调用的 context、config、new messages、当前 Tool batch | 单次运行 | 持久化、UI、资源发现 |
| `Agent` | 内存 transcript、流式消息、Tool pending set、steer/follow-up 队列、AbortController | 进程内 Agent 实例 | Session tree、Compaction、工作区恢复 |
| `AgentSession` | 产品队列视图、Tool Registry、Extension、Retry/Compaction、System Prompt、模型切换 | 当前产品 Session | 跨进程 operation 恢复、强制沙箱 |
| `SessionManager` | 追加式 Entry tree、当前 branch、模型/Thinking/Compaction 等持久事实 | Session 文件 | 运行到一半的完整程序计数器、文件/Git 状态 |

`Agent` 在开始运行时复制 message/tool 数组形成 Turn Snapshot；`AgentSession` 又安装
`prepareNextTurnWithContext`，在下一个安全 Turn 边界刷新当前 model、thinking、system prompt
和 tools。因此运行中配置可以变化，但不会修改已经发出的 Provider Request。

当前旧产品链是“事件驱动 + `message_end` 时追加 Session”：`AgentSession._handleAgentEvent()`
先调用 Extension 和产品监听器，再由 `SessionManager.appendMessage()` 落盘。它不是严格的
“先提交 durable event，再通知所有观察者”模型；这也是新 Harness 要把 operation record、
Reducer 和恢复协议下沉到通用运行时的原因之一。

## 10. 工具、扩展与执行环境

### 10.1 Tool Registry 与调用拦截

Coding Agent 内置 read、bash、edit、write、grep、find、ls 等工具，入口在
[`core/tools`](../../code/pi/packages/coding-agent/src/core/tools)。SDK 支持 allowlist、denylist
和 `noTools`，并在创建实际 cwd-bound 工具后再应用过滤。

`AgentSession` 把 Extension 的 `tool_call`/`tool_result` 事件安装到 `Agent.beforeToolCall` 和
`afterToolCall`。它们可以阻断调用、修改结果和规范化图片，但仍是进程内应用门禁，不等于
OS 沙箱或远端系统权限。

### 10.2 Skill 与 Extension 不是同一种扩展

当前产品路径中的 Skill 更接近可发现的 Prompt 资源。用户输入 `/skill:name args` 后，
`AgentSession` 找到对应文件、去掉 frontmatter，将正文包装成带 name/location 的 `<skill>`
块，再把参数附在后面送入普通 Prompt。Skill 本身不会注册执行器，也不会自动获得新 Tool
权限。

扩展系统位于
[`core/extensions`](../../code/pi/packages/coding-agent/src/core/extensions)，能注册工具、命令、
Provider 和 UI 行为。产品层的 `ExtensionRunner` 被接入 context、Provider headers/payload、
工具调用、Session 生命周期等位置。

因此两者的可信边界不同：

| 机制 | 本质 | 能力范围 | 安全含义 |
|---|---|---|---|
| Skill | 被注入上下文的指令和参考材料 | 影响模型规划，使用当前已开放 Tool | 不是权限边界，正文应视为 Prompt 输入 |
| Extension | 进程内可信插件代码 | 注册 Tool/命令/Provider，拦截输入、请求、Tool 和 Session 事件 | 与宿主进程同权限，需要可信来源和加载策略 |

### 10.3 ExecutionEnv 是可替换执行边界

新 Harness 又抽象出
[`ExecutionEnv`](../../code/pi/packages/agent/src/harness/types.ts)，把文件系统和 Shell 能力放进
接口；Node 实现在
[`NodeExecutionEnv`](../../code/pi/packages/agent/src/harness/env/nodejs.ts)。这使通用 Harness
本身不直接依赖 Node 全局对象，也为测试、浏览器或远程执行环境留下替换点。

## 11. 如何亲手试 Harness 架构

### 11.1 先跑确定性的 Harness 测试

在仓库根执行：

```powershell
cd code/pi
npm install
npm --prefix packages/agent run test:harness
```

这套测试使用 pi-ai 的 faux Provider，不需要 API Key，也不访问真实模型。建议重点对照：

| 想观察的机制 | 测试文件/用例 |
|---|---|
| Scaffold 的可用/未实现边界 | [`agent-harness-scaffold.test.ts`](../../code/pi/packages/agent/test/harness/agent-harness-scaffold.test.ts) |
| operation、队列、Retry 状态归约 | [`reducer.test.ts`](../../code/pi/packages/agent/test/harness/reducer.test.ts) |
| Session 树和内存后端 | [`session/memory.test.ts`](../../code/pi/packages/agent/test/harness/session/memory.test.ts) |
| JSONL 恢复与存储契约 | [`session/jsonl-storage.test.ts`](../../code/pi/packages/agent/test/harness/session/jsonl-storage.test.ts) |
| 工具顺序/并发/终止 | [`agent-loop.test.ts`](../../code/pi/packages/agent/test/agent-loop.test.ts) |

最有价值的调试点依次是 `AgentHarness.create()` 的 restore guard、`Session`/`SessionState`、
JSONL codec、`reduceLaneState()` 与 Compaction helper。当前没有 `createTurnState()`、
`executeTurn()` 或 `handleAgentEvent()` 可供追踪。

### 11.2 从可维护的 Scaffold 用例开始

旧的 `test/scratch/simple.ts` 已删除，不再是官方入口。现在应从
[`agent-harness-scaffold.test.ts`](../../code/pi/packages/agent/test/harness/agent-harness-scaffold.test.ts)
和 [`create-harness.ts`](../../code/pi/packages/coding-agent/src/server/create-harness.ts) 学习当前边界：
前者验证 scaffold 会明确拒绝未完成操作，后者只展示 coding-agent 工具和 system prompt 怎样
准备接入；不要把二者当成端到端运行示例。

### 11.3 当前能亲手验证什么

现在可以独立创建 `Session(new InMemorySessionStorage(...))`，验证 entry、record、lane、branch
query，再换成 JSONL repo 检查重开与 fork。也可以直接测试 reducer 和 Compaction helper。

不能用新 `AgentHarness` 做真实 `prompt()` 实验；调用会得到 `HarnessNotImplemented("prompt")`。
需要观察完整 LLM → tool → LLM 主链时，应使用低层 `Agent` 或下一节的现有产品 SDK。

### 11.4 体验当前产品层

要试现在实际运行的 Coding Agent SDK，应从官方
[`examples/sdk/01-minimal.ts`](../../code/pi/packages/coding-agent/examples/sdk/01-minimal.ts) 开始。
它走的是 `createAgentSession() → AgentSession → Agent`，不是新 `AgentHarness`：

```powershell
cd code/pi
npm run build
npx tsx packages/coding-agent/examples/sdk/01-minimal.ts
```

这个对照实验很重要：可以直观看到“产品级旧 Harness”中已有的资源/扩展/UI 行为，以及新
通用 Harness 当前尚缺的部分。

## 12. 如何自己设计一个 Harness

结合 pi 源码，可以提炼出一条实现顺序：

1. **先写纯 Loop**：输入 context/config，输出事件；不要让 Loop 拥有数据库和 UI。
2. **定义模型边界**：内部消息只在 Provider 调用前转换。
3. **统一事件协议**：模型流、工具生命周期和 Agent 生命周期共用一种事件流。
4. **确定状态所有者**：消息、队列、取消、持久 Session 各自只能有一个写入者。
5. **加入 turn snapshot**：运行中 setter 只影响下一个安全点。
6. **加入 phase/operation lock**：结构操作在第一次异步让出前完成抢占。
7. **先持久化再通知**：观察者看到的是 committed state。
8. **用 pending writes 解决重入顺序**：不要让 Hook 直接插入当前消息中间。
9. **显式定义 steer/queue/follow-up 语义**：不能只叫“消息队列”。
10. **最后做恢复**：Provider 流和非幂等工具不能假装能从任意指令恢复。

Harness 的难点不在 `while`，而在这些时序不变量。

## 13. 未完成与风险

当前真正的边界是：

1. 新 `AgentHarness` 的执行器尚未实现，核心 public operation 都会显式失败。
2. restore、Hook/Event registry、watch 和多 lane facade 仍是占位。
3. `harness.md` 里的 effect sandwich、checkpoint 和恢复策略是实现规格；reducer/storage 已为其
   铺路，但没有端到端主链证明这些语义已经成立。
4. 默认 CLI/TUI 仍在 `AgentSession` 路径；server 的 `createCodingAgentHarness()` 也只完成组装。
5. 即使目标状态机完成，外部副作用 exactly-once 和 Provider stream 中途续传仍明确是 non-goal。

完整状态机、崩溃窗口与恢复策略见
[`harness.md`](../../code/pi/packages/agent/docs/harness.md)。

## 14. 推荐阅读顺序

1. [`packages/agent/src/types.ts`](../../code/pi/packages/agent/src/types.ts)：先认识消息、工具和事件。
2. [`agent-loop.ts`](../../code/pi/packages/agent/src/agent-loop.ts)：掌握两层循环和工具结算。
3. [`agent.ts`](../../code/pi/packages/agent/src/agent.ts)：看内存状态如何归约事件。
4. [`harness/session/types.ts`](../../code/pi/packages/agent/src/harness/session/types.ts)：理解 entry、record 与 lane 契约。
5. [`harness/session/session.ts`](../../code/pi/packages/agent/src/harness/session/session.ts) 和后端：理解当前已实现的持久层。
6. [`harness/reducer.ts`](../../code/pi/packages/agent/src/harness/reducer.ts)：看目标 operation 怎样被纯归约。
7. [`harness/agent-harness.ts`](../../code/pi/packages/agent/src/harness/agent-harness.ts)：确认 facade 已实现与未实现的边界。
8. [`harness.md`](../../code/pi/packages/agent/docs/harness.md)：最后对照实现规格，不倒推功能完成度。
9. [`test/harness`](../../code/pi/packages/agent/test/harness)：用测试区分 storage/reducer 能力与 scaffold。
10. [`coding-agent/src/core/sdk.ts`](../../code/pi/packages/coding-agent/src/core/sdk.ts)：对比当前产品组装。
11. [`coding-agent/src/core/agent-session.ts`](../../code/pi/packages/coding-agent/src/core/agent-session.ts)：按 prompt、工具、Compaction、extension、tree navigation 分段读，不建议从第一行顺读。
12. [`coding-agent/src/main.ts`](../../code/pi/packages/coding-agent/src/main.ts) 和 modes：最后补齐 CLI/TUI/RPC。

## 15. 核心结论

pi 当前给出的 Harness 方向是：

> 把 Agent Loop 保持为消息和工具的纯编排，用持久 entry/record/lane 保存事实，用纯 reducer
> 描述下一步，再由尚待完成的 interpreter 负责 Provider、工具和 Hook 效果。

它目前处在“新 storage/reducer/tool 底座可测试，`AgentHarness` 执行 facade 尚未完成，旧
`AgentSession` 继续承载产品”的阶段。当前源码最重要的阅读纪律，是把 specification、底层
组件和可运行产品三种完成度分开。
