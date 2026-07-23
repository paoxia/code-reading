# pi 源码架构与 Agent Harness 实现

> 源码版本：`earendil-works/pi main@3a40794ea14c`
>
> 包版本：`@earendil-works/pi-* 0.80.10`；仓库根版本 `0.0.3`
>
> 研究重点：`packages/ai`、`packages/agent`、`packages/coding-agent` 和
> `packages/tui`。`packages/orchestrator` 的包描述明确标注为 experimental，本文只说明
> 它的边界，不把它当成主运行时。

## 1. 先给结论

pi 最值得学习的不是某一个工具，而是它把 Coding Agent 拆成了三层：

```text
runAgentLoop()       纯执行循环：LLM → tool → LLM
       ▲
       │
Agent                进程内有状态包装：消息、队列、事件、取消
       ▲
       │
AgentHarness         应用编排：持久 Session、快照、资源、Hook、Compaction
       ▲
       │
coding-agent         产品层：CLI/TUI、配置、扩展、内置工具、认证
```

这里的 **Harness** 可以理解为“让 Agent Loop 成为一个可嵌入、可持久化、可观察、可在
运行时安全修改的应用运行时”。它不负责替模型思考，也不应该把所有逻辑塞进循环；它负责
规定状态的所有权、何时可以变更状态、什么必须持久化、模型请求使用哪一份快照，以及错误
和取消如何收口。

但阅读时必须区分“已经运行在产品里的架构”和“正在建设的新架构”：

- 新的 [`AgentHarness`](../../code/pi/packages/agent/src/harness/agent-harness.ts) 已有独立实现和
  测试；它直接调用 `runAgentLoop()`，不再依赖 `Agent`。
- 当前 [`pi-coding-agent`](../../code/pi/packages/coding-agent/src/core/sdk.ts) 仍创建
  `Agent + AgentSession`，尚未迁移到新 `AgentHarness`。
- 迁移计划、通用 Hook、自动 Compaction、Retry、完整可恢复 Harness 等仍在
  [`agent-harness.md`](../../code/pi/packages/agent/docs/agent-harness.md) 中标为 Planned 或
  In progress，不能视为完成能力。

## 2. Monorepo 分层

根 [`package.json`](../../code/pi/package.json) 的构建顺序直接表达了依赖方向：

```text
pi-tui → pi-ai → pi-agent-core → pi-coding-agent → pi-orchestrator
```

| 包 | 核心职责 | 关键入口 |
|---|---|---|
| `packages/ai` | 统一模型、Provider、流式事件、认证与模型目录 | [`src/models.ts`](../../code/pi/packages/ai/src/models.ts)、[`src/providers`](../../code/pi/packages/ai/src/providers) |
| `packages/agent` | 通用 Agent Loop、`Agent`、新 `AgentHarness` | [`src/agent-loop.ts`](../../code/pi/packages/agent/src/agent-loop.ts)、[`src/agent.ts`](../../code/pi/packages/agent/src/agent.ts) |
| `packages/coding-agent` | Coding Agent 产品能力、工具、会话、扩展、CLI/TUI/RPC | [`src/main.ts`](../../code/pi/packages/coding-agent/src/main.ts)、[`src/core/sdk.ts`](../../code/pi/packages/coding-agent/src/core/sdk.ts) |
| `packages/tui` | 终端组件和差量渲染 | [`src`](../../code/pi/packages/tui/src) |
| `packages/orchestrator` | 实验性编排包 | [`README.md`](../../code/pi/packages/orchestrator/README.md) |

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
| `nextTurn` | 下一次显式 `prompt()` 之前，仅 `AgentHarness` 提供 | 为未来一轮预置上下文 |

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

## 5. 第三层：`AgentHarness` 如何实现 Harness

### 5.1 Harness 的四类状态必须分开

新 [`AgentHarness`](../../code/pi/packages/agent/src/harness/agent-harness.ts) 最重要的设计是
不再用一个可变对象同时代表“当前配置”和“正在执行的请求”。它分成四类状态：

| 状态 | 内容 | 读取/变更语义 |
|---|---|---|
| Harness config | model、thinking、tools、resources、system prompt provider、stream options | getter 总是读最新配置；setter 影响未来快照 |
| Turn snapshot | 本轮消息、解析后的 system prompt、活动工具、模型、资源、流参数、session id | `createTurnState()` 一次创建；当前 Provider 请求不可变 |
| Persisted Session | 已落盘的追加式会话树 | 构建模型上下文和恢复分支 |
| Pending writes | 忙碌期间由扩展/监听器请求的会话写入 | save point 或 settlement 时按序刷入 |

如果不做这层分离，一个 Hook 在流式响应期间切换模型或工具，很容易出现“请求前半段使用旧
配置，后半段读取新配置”的撕裂状态。

### 5.2 显式 phase 是结构操作的互斥门

Harness phase 定义在
[`types.ts`](../../code/pi/packages/agent/src/harness/types.ts)：

```text
idle | turn | compaction | branch_summary | retry
```

`prompt`、`skill`、`promptFromTemplate`、`compact`、`navigateTree` 是结构操作，只能从
`idle` 开始，并在第一次 `await` 之前同步切换 phase。这样两个并发调用不会都越过检查。

运行中允许的操作更窄：

- `steer`、`followUp`、`nextTurn`；
- `abort`；
- model、thinking、tools、resources、stream options 等未来轮配置更新；
- 通过 `appendMessage()` 排队会话写入。

### 5.3 一次 `prompt()` 的完整时序

```text
prompt(text)
  │
  ├─ assert phase=idle；phase=turn
  ├─ startRunPromise()
  ├─ createTurnState()
  │    ├─ Session.buildContext()
  │    ├─ 复制 resources/streamOptions/tools
  │    └─ 调用 systemPrompt provider 一次
  │
  └─ executeTurn()
       ├─ 合并 nextTurnQueue
       ├─ before_agent_start Hook
       ├─ 建立 AbortController
       └─ runAgentLoop(...)
            ├─ handleAgentEvent(message_end)
            │    └─ 先 Session.appendMessage，再通知订阅者
            ├─ handleAgentEvent(turn_end)
            │    ├─ 通知订阅者
            │    ├─ flushPendingSessionWrites()
            │    └─ 发布 save_point
            ├─ prepareNextTurn()
            │    ├─ 再刷 pending writes
            │    ├─ createTurnState() 生成新快照
            │    └─ 替换下一 Provider turn 的 context/model/thinking
            └─ agent_end
                 ├─ 刷写
                 ├─ phase=idle
                 └─ settled
```

关键不变量是：**Agent 自己产生的消息先持久化，监听器在本事件内追加的写入随后落盘**。
否则插件日志、标签或自定义消息可能跑到触发它们的 assistant message 前面。

### 5.4 Save point 是动态配置生效的边界

低层循环每个 assistant turn 和工具结果结束后调用 `prepareNextTurn()`。Harness 在这里：

1. 刷新 pending writes；
2. 重新从 Session 构建 context；
3. 再求值 system prompt provider；
4. 快照最新模型、thinking、工具、资源和流参数；
5. 把新快照用于下一次 Provider 请求。

因此运行中的 `setModel()` 不会改变正在传输的请求，却可以改变同一次 Agent Run 里的下一
Provider turn。这是实现可重入 Harness 时最值得借鉴的模式。

### 5.5 Harness 不再包着 `Agent`

当前 `AgentHarness` 直接调用 `runAgentLoop()`。如果它包一层 `Agent`，消息状态、队列、
取消和监听 settlement 会产生两个所有者。现在 Harness 自己拥有：

- run 生命周期和 AbortController；
- 三种队列；
- Session 持久化；
- Provider stream wrapper；
- Hook 归约；
- save-point 快照。

`Agent` 仍适合只需要内存态的嵌入；`AgentHarness` 面向应用级运行时。两者是并列上层，
不是必须叠在一起。

## 6. Session：追加日志加树形游标

[`Session`](../../code/pi/packages/agent/src/harness/session/session.ts) 并不直接绑定文件，而是
依赖 `SessionStorage`。仓库提供：

- [`InMemorySessionStorage`](../../code/pi/packages/agent/src/harness/session/memory-storage.ts)；
- [`JsonlSessionStorage`](../../code/pi/packages/agent/src/harness/session/jsonl-storage.ts)；
- 对应的内存与 JSONL Repo，用于 create/open/list/delete/fork。

每个 entry 有 `id`、`parentId`、`timestamp`，类型包括：

- message；
- model/thinking/active-tools change；
- compaction、branch summary；
- custom、custom message、label、session info；
- leaf。

因此 Session 是一棵追加式树：

```text
root
 └─ user A
     └─ assistant A
         ├─ user B ─ assistant B      ← leaf 1
         └─ user C ─ assistant C      ← leaf 2
```

切分支不是删除后面的消息，而是持久化 leaf 移动，再从新 leaf 追加。JSONL 重开时从最新会
影响 leaf 的 entry 恢复游标。

`buildContext()` 分两步：

1. 沿 leaf 到 root 取得当前分支，并从完整分支归约 model/thinking/active tools；
2. 应用 Compaction transform 和应用自定义 transforms，再把 entry 投影成
   `AgentMessage[]`。

默认 custom entry 不发给模型；只有 custom message 或显式 projector 才进入上下文。这将
“审计/控制数据”和“模型可见数据”分开。

## 7. Compaction 和树导航

Harness 已提供手动 `compact()` 和 `navigateTree()`：

- Compaction 先计算切点，生成或接受 Hook 提供的摘要，再追加 `compaction` entry；
- 构建上下文时只选最新 Compaction、保留区间和其后消息，完整旧历史仍在 Session；
- 树导航可以对离开的分支生成 branch summary，再持久化新 leaf；
- 摘要的 token usage 也随 entry 持久化。

相关实现位于
[`harness/compaction`](../../code/pi/packages/agent/src/harness/compaction)，测试位于
[`test/harness/compaction.test.ts`](../../code/pi/packages/agent/test/harness/compaction.test.ts)。

当前限制是 `AgentHarness` 还没有把自动 Compaction 决策点和 Retry 接好；产品层旧
`AgentSession` 有自己的相关实现，不能据此推断新 Harness 已完成。

## 8. Hook、事件与错误边界

Harness 有两类观察点：

- `subscribe()` 观察所有 Agent/Harness 事件；
- `on(type, handler)` 为特定 Hook 返回结果，例如改 context、阻止工具、修改工具结果、
  改 Provider payload 或提供 Compaction。

典型扩展链：

```text
before_agent_start → context → before_provider_request
→ before_provider_payload → provider
→ tool_call → execute → tool_result
→ save_point → settled
```

Provider request Hook 按注册顺序合并 patch；header/metadata 中显式 `undefined` 表示删除。
Provider transport 读取已经由流对象解耦，所以 Harness 可以顺序 `await` Hook 和持久化，
不必另造一个 fire-and-forget 事件队列。

错误分层也有意区分：

- 文件、Shell、资源和 Compaction helper 使用 `Result<T, E>` 表达预期失败；
- Session 和 Harness 的高层 mutation 直接 reject/throw typed error；
- 公共错误尽量归一到 `AgentHarnessError`，原错误放在 `cause`；
- 事件已经提交后，订阅者失败不会回滚提交，只会让调用者收到 `hook` 错误。

不过通用 Hook 机制和安全的 session facade 仍未完成。源码文档还明确警告：监听器如果闭包
拿到原始 Harness，并在活跃 run 内 `await waitForIdle()`，可能自锁；未来计划用
`runWhenIdle()` 一类 facade 约束它。

## 9. 当前 `pi-coding-agent` 如何组装产品

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
产品层已经承担了大量 Harness 职责。新的 `packages/agent/AgentHarness` 正是在尝试把其中可
复用、与 UI 无关的部分下沉，但迁移还没发生。

CLI 的 [`main()`](../../code/pi/packages/coding-agent/src/main.ts) 创建 cwd-bound services 和
[`AgentSessionRuntime`](../../code/pi/packages/coding-agent/src/core/agent-session-runtime.ts)，
再选择 interactive、print 或 RPC mode。`AgentSessionRuntime` 在 `/new`、`/resume`、
`/fork` 时销毁旧 session 与扩展上下文，重建 cwd-bound services，然后让 UI rebind；这比
只替换一个消息数组更安全。

## 10. 工具、扩展与执行环境

Coding Agent 内置 read、bash、edit、write、grep、find、ls 等工具，入口在
[`core/tools`](../../code/pi/packages/coding-agent/src/core/tools)。SDK 支持 allowlist、denylist
和 `noTools`，并在创建实际 cwd-bound 工具后再应用过滤。

扩展系统位于
[`core/extensions`](../../code/pi/packages/coding-agent/src/core/extensions)，能注册工具、命令、
Provider 和 UI 行为。产品层的 `ExtensionRunner` 被接入 context、Provider headers/payload、
工具调用、Session 生命周期等位置。

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
| steer/follow-up 队列、安全点 | [`agent-harness.test.ts`](../../code/pi/packages/agent/test/harness/agent-harness.test.ts) |
| Provider options 与 Hook 链 | [`agent-harness-stream.test.ts`](../../code/pi/packages/agent/test/harness/agent-harness-stream.test.ts) |
| Session 树和持久 leaf | [`session.test.ts`](../../code/pi/packages/agent/test/harness/session.test.ts) |
| JSONL 恢复 | [`storage.test.ts`](../../code/pi/packages/agent/test/harness/storage.test.ts) |
| 工具顺序/并发/终止 | [`agent-loop.test.ts`](../../code/pi/packages/agent/test/agent-loop.test.ts) |

最有价值的调试点依次是：

1. `AgentHarness.prompt()`；
2. `createTurnState()`；
3. `executeTurn()`；
4. `runLoop()`；
5. `handleAgentEvent()`；
6. `prepareNextTurn()` 回调。

### 11.2 跑官方的最小 Harness 脚本

仓库已有
[`test/scratch/simple.ts`](../../code/pi/packages/agent/test/scratch/simple.ts)，展示了
`NodeExecutionEnv + Session + Models + AgentHarness + skills` 的完整组装。配置好脚本使用的
Provider 凭据后可从 `code/pi` 运行：

```powershell
npx tsx packages/agent/test/scratch/simple.ts
```

建议第一次实验把 `InMemorySessionStorage` 保留不变，只观察事件；第二次再换
`JsonlSessionRepo`，避免同时调试模型与持久化。

### 11.3 从零组一个最小 Harness

最小组成只有五项：

```ts
const harness = new AgentHarness({
  env: new NodeExecutionEnv({ cwd: process.cwd() }),
  session: new Session(new InMemorySessionStorage()),
  models,
  model,
  systemPrompt: "You are a helpful assistant.",
  tools: [],
})

harness.subscribe((event) => console.log(event.type))
const answer = await harness.prompt("List the responsibilities of a harness")
```

然后按这个顺序增加复杂度，最容易看懂每层为什么存在：

1. 加一个无副作用计算工具，观察 tool call → result → 下一 Provider turn；
2. 在 `message_start` 时调用 `steer()`，观察消息只在安全点注入；
3. 在工具运行时 `setModel()`，确认当前请求不变、下一轮使用新模型；
4. 在事件监听器调用 `appendMessage()`，检查它排在 assistant/tool result 后；
5. 换 JSONL storage，结束进程后重新打开并检查 branch/leaf；
6. 手动 `compact()`，比较完整 entry log 与 `buildContext()` 的差异。

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

源码已明确标注的主要限制包括：

1. 新 `AgentHarness` 的自动 Compaction 和 Retry 决策点未接入。
2. 通用 Hook 系统已设计但未完成；当前 handler 的结果归约仍较简单。
3. session facade 与 pending-write 公共 API 未实现。
4. 完整 listener/hook 重入、settled 时序和 abort barrier 仍待审计。
5. 新 Harness 尚未替代 `pi-coding-agent` 的 `AgentSession`。
6. 完全 durable Harness 不现实：工具函数、Provider、Hook、资源 loader 等 JavaScript 运行时
   依赖无法直接序列化。
7. Provider stream 不能续传；崩溃恢复只能从持久边界重新开始或标记 interrupted。
8. 未完成工具调用不能默认重试，除非工具声明幂等/可重试。

半持久化目标和崩溃场景见
[`durable-harness.md`](../../code/pi/packages/agent/docs/durable-harness.md)。

## 14. 推荐阅读顺序

1. [`packages/agent/src/types.ts`](../../code/pi/packages/agent/src/types.ts)：先认识消息、工具和事件。
2. [`agent-loop.ts`](../../code/pi/packages/agent/src/agent-loop.ts)：掌握两层循环和工具结算。
3. [`agent.ts`](../../code/pi/packages/agent/src/agent.ts)：看内存状态如何归约事件。
4. [`harness/types.ts`](../../code/pi/packages/agent/src/harness/types.ts)：理解 Session entry、phase、Hook 契约。
5. [`harness/agent-harness.ts`](../../code/pi/packages/agent/src/harness/agent-harness.ts)：沿 `prompt → executeTurn → handleAgentEvent` 阅读。
6. [`harness/session/session.ts`](../../code/pi/packages/agent/src/harness/session/session.ts)：理解追加树与 context 投影。
7. [`test/harness`](../../code/pi/packages/agent/test/harness)：用测试验证时序不变量。
8. [`coding-agent/src/core/sdk.ts`](../../code/pi/packages/coding-agent/src/core/sdk.ts)：对比当前产品组装。
9. [`coding-agent/src/core/agent-session.ts`](../../code/pi/packages/coding-agent/src/core/agent-session.ts)：按 prompt、工具、Compaction、extension、tree navigation 分段读，不建议从第一行顺读。
10. [`coding-agent/src/main.ts`](../../code/pi/packages/coding-agent/src/main.ts) 和 modes：最后补齐 CLI/TUI/RPC。

## 15. 核心结论

pi 给出的 Harness 答案是：

> 把 Agent Loop 保持为消息和工具的纯编排，把应用复杂度放到明确的 Harness 边界；用
> turn snapshot 隔离运行中配置变化，用 save point 刷新下一轮，用追加式 Session 保留
> 可恢复历史，用显式 phase、队列语义和 awaited event settlement 保证时序。

它目前仍处在“新通用 Harness 已可测试、旧产品 Harness 尚待迁移”的阶段。正因为新旧两套
代码同时存在，这个仓库非常适合学习 Harness 为什么会从一个简单 `Agent` 演化出 Session、
快照、事件、资源和恢复边界。
