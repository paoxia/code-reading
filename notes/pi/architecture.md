# pi Agent 架构设计详解

> 研究源码：`code/pi`
>
> 源码版本：`main@4af9d21d3b4d664e4a29fcabfec85171077248e3`
>（`@earendil-works/pi-* 0.84.2`）
>
> 研究范围：`packages/ai`、`packages/agent`、`packages/coding-agent`、
> `packages/tui`，以及与远程运行相关的 `packages/protocol`、`packages/client`、
> `packages/server`。
>
> 本文只描述上述提交中的本地源码。尤其要注意：当前 CLI 的真实主链仍是
> `AgentSession + Agent`；新版 durable `AgentHarness` 还不是可执行主链。

## 1. 先用一句话理解 pi

pi 没有把 Coding Agent 写成一个巨大的循环，而是把它拆成了五层：

```text
交互层          CLI / TUI / print / JSON / RPC
                  │
产品运行时      AgentSessionRuntime / AgentSession
                  │
进程内 Agent    Agent
                  │
纯执行循环      runAgentLoop()
                  │
模型适配层      Models / Provider / streamSimple()
```

这五层分别回答五个不同问题：

1. 用户从哪里输入，结果怎样展示？
2. 当前工作区、配置、扩展、工具和会话由谁组装？
3. 消息、队列、取消和流式状态由谁持有？
4. 一轮 `LLM → Tool → LLM` 怎样执行？
5. Anthropic、OpenAI、Google 等不同 API 怎样统一？

最关键的设计思想是：**Loop 只负责执行，产品层负责策略，Provider 层负责协议差异。**

如果把 pi 比作一个操作系统：

- `runAgentLoop()` 像 CPU 执行循环；
- `Agent` 像进程控制块，保存运行状态和取消信号；
- `AgentSession` 像应用运行时，加入配置、插件、持久化和上下文管理；
- `AgentSessionRuntime` 像进程管理器，负责切换、销毁和重建完整 Session；
- `pi-ai` 像设备适配层，把不同模型协议统一成同一种上层事件。

## 2. 先分清几个容易混淆的概念

| 概念 | 在 pi 中的含义 | 典型边界 |
|---|---|---|
| Session | 一段可保存、恢复、分支的长期对话 | 一个 JSONL 会话文件 |
| Run | 一次 `prompt()` 启动后，连同 Tool、steer、follow-up、重试等，直到真正 idle 的完整运行 | `agent_start → agent_end`，产品层还会继续做 post-run |
| Turn | 一次模型响应，加上该响应触发的整批 Tool 执行 | `turn_start → assistant → tools → turn_end` |
| Model request | 一次对具体 Provider 的网络请求 | `streamFn(model, context, options)` |
| Tool batch | 同一条 AssistantMessage 中的所有 Tool Call | 可顺序或并行执行 |
| Context | 某次请求真正发给模型的 system prompt、messages 和 tools | 每次请求前重新投影 |

一个 Run 可以包含多个 Turn。例如：

```text
用户：修复失败测试
  │
  ├─ Turn 1：模型决定 read + grep
  │            └─ 执行 Tool batch
  ├─ Turn 2：模型决定 edit
  │            └─ 执行 Tool batch
  ├─ Turn 3：模型决定 bash 跑测试
  │            └─ 执行 Tool batch
  └─ Turn 4：模型给出最终回答，Run 结束
```

这种术语区分很重要。比如“Turn 结束”不等于“Agent 已空闲”，因为后面可能还有
steer、follow-up、自动重试、自动压缩或等待中的事件监听器。

## 3. Monorepo 如何分层

根 [`package.json`](../../code/pi/package.json) 的构建顺序反映了主要依赖方向：

```text
pi-tui        pi-telemetry
   │               │
   │           pi-ai
   │               │
   │        pi-agent-core
   │               │
   └────── pi-coding-agent

pi-protocol ← pi-client
     ↑
 pi-server
```

更完整的职责如下：

| 包 | 角色 | 不应该承担的职责 |
|---|---|---|
| [`packages/ai`](../../code/pi/packages/ai) | 模型目录、认证、Provider、协议转换、统一流事件 | 文件编辑、Session UI、Agent 决策 |
| [`packages/agent`](../../code/pi/packages/agent) | 通用 Agent Loop、内存 `Agent`、新版 Harness 基础设施 | CLI、TUI、项目规则发现 |
| [`packages/coding-agent`](../../code/pi/packages/coding-agent) | 把通用 Agent 产品化：工具、Session、扩展、配置、模式 | 各家模型 wire protocol 的具体解析 |
| [`packages/tui`](../../code/pi/packages/tui) | 终端组件、输入、布局、差量渲染 | Agent 执行语义 |
| [`packages/telemetry`](../../code/pi/packages/telemetry) | 与厂商无关的 telemetry contract | 业务运行时 |
| [`packages/protocol`](../../code/pi/packages/protocol) | 远程 Session 的 CBOR schema 与 framing | 具体网络传输和 Agent 实现 |
| [`packages/client`](../../code/pi/packages/client) | transport-neutral 远程客户端 | 服务端 Session 所有权 |
| [`packages/server`](../../code/pi/packages/server) | 实验性的 Session server 框架 | 完整的独立 Coding Agent 服务 |
| [`packages/session-backends`](../../code/pi/packages/session-backends) | 新 Harness 的 Session 存储后端 | 当前 CLI 的全部 Session 逻辑 |

这里有两条同时存在的演进线：

- **当前产品线**：`coding-agent/AgentSession → agent/Agent → runAgentLoop()`，已经被 CLI、TUI、
  print 和 RPC 使用；
- **新版 Harness 线**：`agent/AgentHarness → Session/Record/Reducer/ExecutionEnv`，底座已出现，
  但执行器还没有接通。

阅读时必须把“现在能运行什么”和“未来准备怎样运行”分开。

## 4. 当前真实运行架构

### 4.1 总体组件图

```text
┌────────────────────── 输入与展示 ───────────────────────┐
│ CLI args / stdin / TUI / JSON output / JSONL RPC         │
└──────────────────────────┬───────────────────────────────┘
                           ▼
┌──────────────── AgentSessionRuntime ─────────────────────┐
│ 当前 Session + cwd-bound services                        │
│ new / resume / fork / import / teardown / UI rebind      │
└──────────────────────────┬───────────────────────────────┘
                           ▼
┌─────────────────── AgentSession ─────────────────────────┐
│ 输入准入、模型认证、System Prompt、Tool Registry         │
│ Extension、SessionManager、Retry、Compaction、Tree       │
└───────────────┬───────────────────────┬──────────────────┘
                │                       │
                ▼                       ▼
┌──────────── Agent ────────────┐   SessionManager JSONL
│ 内存消息、队列、流式状态       │   追加式 Entry Tree
│ AbortController、事件订阅      │
└───────────────┬───────────────┘
                ▼
┌─────────── runAgentLoop() ───────────────────────────────┐
│ request → assistant stream → tool batch → next request   │
└──────────────┬────────────────────────┬──────────────────┘
               │                        │
               ▼                        ▼
       ModelRuntime / pi-ai       read/bash/edit/write/...
               │
               ▼
      Anthropic / OpenAI / Google / Bedrock / ...
```

### 4.2 为什么需要这么多层

把这些层合并当然能少写一些类，但会迅速出现几个问题：

- Provider 代码需要知道 TUI 和文件工具；
- Tool 执行代码需要知道 Session 文件格式；
- 切换工作区后，旧扩展和旧配置仍可能残留；
- SDK 使用者无法只复用 Loop 或模型适配；
- 流式 UI、JSON 输出和 RPC 会各自复制运行逻辑。

pi 的分层让同一条执行主链可以被多种宿主复用，同时把变化频率不同的部分隔开。

## 5. 启动阶段：产品是怎样被装配出来的

主入口是 [`main()`](../../code/pi/packages/coding-agent/src/main.ts)，SDK 入口是
[`createAgentSession()`](../../code/pi/packages/coding-agent/src/core/sdk.ts)。

### 5.1 CLI 启动主线

```text
main(args)
  → 解析 auth/package/config 等一次性命令
  → parseArgs()
  → 判断 interactive / print / json / rpc
  → 运行配置迁移
  → 定位新建、恢复或 fork 的 SessionManager
  → 确定 Session 真正的 cwd
  → 处理 project trust
  → 创建 cwd-bound services
       ├─ SettingsManager
       ├─ ModelRuntime
       └─ ResourceLoader
  → createAgentSession()
  → 包成 AgentSessionRuntime
  → 进入 InteractiveMode / PrintMode / RpcMode
```

“先确定 Session cwd，再创建服务”是一个重要设计。恢复另一个项目的 Session 时，项目设置、
`AGENTS.md`、扩展、模型和工具都必须按目标项目重新加载，不能继续使用启动目录的结果。

### 5.2 `createAgentSession()` 的装配顺序

[`createAgentSession()`](../../code/pi/packages/coding-agent/src/core/sdk.ts) 主要做六件事：

1. 规范化 `cwd` 与 `agentDir`；
2. 创建或接收 `ModelRuntime`、`SettingsManager`、`SessionManager`、`ResourceLoader`；
3. 从已有 Session、设置和模型能力中恢复 model 与 thinking level；
4. 创建 `Agent`，注入模型流、上下文转换、Provider Hook、队列策略；
5. 从 Session 恢复消息，或为新 Session 记录初始 model/thinking；
6. 创建 `AgentSession`，再由它组装工具、Extension 和 System Prompt。

核心依赖采用注入方式，而不是在 `Agent` 内部直接 `new`：

```text
Agent({
  streamFn: ModelRuntime.streamSimple,
  convertToLlm,
  transformContext: ExtensionRunner.emitContext,
  beforeToolCall,
  afterToolCall,
  ...
})
```

因此 `packages/agent` 不需要依赖 Coding Agent 的配置系统，也不需要知道认证文件放在哪里。

## 6. 一次 Prompt 的完整调用链

下面以“修复失败测试”为例，追踪真实产品链。

### 6.1 产品层先做输入准入

入口是 [`AgentSession.prompt()`](../../code/pi/packages/coding-agent/src/core/agent-session.ts)：

```text
prompt(text, options)
  │
  ├─ 识别 Extension command
  ├─ 拒绝与手动 Compaction 冲突的输入
  ├─ input Extension：handled / transform / continue
  ├─ 展开 /skill:name 和 Prompt Template
  ├─ 若 Agent 正在运行：显式转为 steer 或 followUp
  ├─ 刷入此前的用户 Bash 记录
  ├─ 校验 model 和 auth
  ├─ 必要时在新请求前做 Compaction
  ├─ 构造 UserMessage，并合并 next-turn custom messages
  ├─ before_agent_start：追加消息或覆盖本轮 System Prompt
  └─ _runAgentPrompt(messages)
```

这一层没有直接调用 Provider。它先把用户输入转换成一个“可运行、可记录、满足当前策略”的
请求。

### 6.2 `Agent` 建立本次 Run

[`Agent.prompt()`](../../code/pi/packages/agent/src/agent.ts) 会：

1. 拒绝第二个并发普通 `prompt()`；
2. 规范化文本、图片或自定义 `AgentMessage`；
3. 创建 `AbortController` 和 idle Promise；
4. 复制当前 system prompt、messages、tools，形成运行快照；
5. 创建 Loop Config；
6. 调用 `runAgentLoop()`；
7. 把 Loop Event 归约回 `AgentState`。

快照意味着：已经发出的请求不会被 UI 中途修改。运行中的模型、工具或 System Prompt 变化，
由 `AgentSession` 安装的 `prepareNextTurnWithContext` 在下一个安全 Turn 边界刷新。

### 6.3 Loop 执行模型与工具

[`runAgentLoop()`](../../code/pi/packages/agent/src/agent-loop.ts) 的主线是：

```text
agent_start
  → turn_start
  → 发布新 UserMessage
  → transformContext(AgentMessage[])
  → convertToLlm(Message[])
  → streamFn(model, context, options)
  → 发布 assistant message_start/update/end
  → 提取 Tool Calls
  → 参数准备与校验
  → beforeToolCall
  → 执行 Tool
  → afterToolCall
  → 写回 ToolResultMessage
  → turn_end
  → prepareNextTurn
  → steer / follow-up / 下一 Tool Turn / 结束
  → agent_end
```

### 6.4 产品层收尾

`AgentSession` 是 `Agent` 的第一个内部订阅者。它收到事件后会：

- 把事件转换为 Extension 事件；
- 向 TUI、print 或 RPC 的订阅者发布产品事件；
- 在 `message_end` 时追加到 `SessionManager`；
- 记录最近一次 AssistantMessage，供重试和压缩判断使用。

一次低层 `agent_end` 后，[`_handlePostAgentRun()`](../../code/pi/packages/coding-agent/src/core/agent-session.ts)
还会依次判断：

1. 是否为可重试错误；
2. 是否发生上下文溢出或达到自动压缩阈值；
3. Extension 是否在 `agent_end` 时又加入了消息；
4. 是否需要调用 `agent.continue()`。

只有这些都结束并发出 `agent_settled`，产品层的 Run 才真正完成。

## 7. `runAgentLoop()` 为什么有内外两层循环

Loop 的两层 `while` 不是普通的代码结构，而是在实现两种不同的消息队列语义。

```text
外层循环：Agent 原本准备停止时，接收 follow-up
  │
  └─ 内层循环：Tool 继续执行，或在下一请求前接收 steer
```

| API | 消费时机 | 用户意图 |
|---|---|---|
| `steer` | 当前 Turn 的工具结束后、下一次模型请求前 | “正在做的方向需要调整” |
| `followUp` | Agent 原本已经准备结束时 | “做完当前任务后，再处理这件事” |
| `nextTurn` | 下一次显式用户 Prompt 一起进入上下文 | “给未来一次输入附加上下文，但现在不要唤醒 Agent” |

`steer` 不会打断已经开始的模型响应，也不会跳过当前响应中的 Tool Call。它在下一个安全边界
注入，这避免了半条 AssistantMessage 或半批 Tool Result 进入历史。

steer 和 follow-up 都支持两种 drain 模式：

- `one-at-a-time`：每个消费点只取最早的一条，让模型逐条响应；
- `all`：一次取出当前全部排队消息。

## 8. 消息转换与模型边界

pi 内部使用 `AgentMessage[]`，它不仅可以包含标准 user/assistant/toolResult，还允许产品通过
TypeScript declaration merging 增加自定义消息。

但 Provider 只理解标准 [`Message`](../../code/pi/packages/ai/src/types.ts)。因此转换被集中在
唯一边界：

```text
AgentMessage[]
  → transformContext()    # 仍是 Agent 语义，可裁剪或注入
  → convertToLlm()        # 过滤 UI-only 消息，转换自定义消息
  → pi-ai Context
  → Provider request
```

这个设计有三个好处：

- Session 中可以保留 UI、Compaction、Branch Summary 等产品语义；
- Provider adapter 不需要认识产品自定义消息；
- Extension 可以在不修改底层模型协议的情况下调整上下文。

需要注意，`transformContext` 和 `convertToLlm` 的合同要求调用者提供安全降级，不应抛错。
否则低层 Loop 会被异常中断，无法形成正常的终止事件序列。

## 9. 流式响应不是字符串拼接

[`pi-ai`](../../code/pi/packages/ai) 把各 Provider 的流统一成结构化事件：

```text
start
text_start / text_delta / text_end
thinking_start / thinking_delta / thinking_end
toolcall_start / toolcall_delta / toolcall_end
done / error
```

Agent Loop 再映射为：

```text
message_start
message_update × N
message_end
```

流式期间，partial AssistantMessage 会临时进入当前 context，并随 delta 原位替换；终止事件到达后
才替换为 final AssistantMessage。这样：

- TUI 可以实时显示文本、思考和正在生成的 Tool Call；
- JSON/RPC 可以消费同一种事件；
- Session 只在完整 `message_end` 时追加稳定消息，而不是持久化每个字符。

Provider-specific reasoning metadata 也可能是下一次请求重放所需的信息，不只是 UI 展示数据，
因此不能把统一流理解成“最终只保留文本”。

## 10. Tool Runtime：从模型输出到确定性历史

### 10.1 一次 Tool Call 的阶段

Tool Call 会经过以下步骤：

```text
模型输出 name + arguments
  → 按 name 查找 AgentTool
  → prepareArguments（兼容性修正，可选）
  → TypeBox 参数校验
  → beforeToolCall（可阻断）
  → tool.execute(signal, onUpdate)
  → afterToolCall（可替换结果字段）
  → tool_execution_end
  → ToolResultMessage
```

未知工具、参数错误、Hook 阻断和 Tool 抛错都会物化为 Tool Result，而不是让整条 Loop 无结果地
崩溃。Tool 的 `onUpdate` 用于发布长任务的中间进度；Tool Promise 结束后的迟到 update 会被忽略。

### 10.2 并行执行，但按模型顺序写历史

默认 `toolExecution` 是 `parallel`。如果全局指定 `sequential`，或同一批中任意 Tool 声明
`executionMode: "sequential"`，整批改为顺序执行。

并行模式有意区分两种顺序：

```text
模型调用顺序： read(A), grep(B), read(C)
实际完成顺序： B, C, A

实时事件：      B end → C end → A end
历史写入：      A result → B result → C result
```

实时完成顺序适合 UI 展示，模型原始顺序适合生成确定、可复现的对话历史。相关行为由
[`agent-loop.test.ts`](../../code/pi/packages/agent/test/agent-loop.test.ts) 覆盖。

### 10.3 几个容易忽略的安全细节

- AssistantMessage 若因输出 Token 上限以 `length` 结束，当前消息中的所有 Tool Call 都不会执行。
  流式 JSON 可能被容错解析成“合法但缺字段”的对象，继续执行会有副作用风险。
- `beforeToolCall` 的阻断会生成错误 Tool Result，让模型知道调用没有发生。
- 一批 Tool 只有在每个最终结果都带 `terminate: true` 时才提前结束，避免单个 Tool 意外吞掉同批结果。
- [`withFileMutationQueue()`](../../code/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts)
  让同一路径的 edit/write 串行，不同文件仍可并行，降低并发覆盖风险。
- Tool Hook 是进程内策略门禁，不是操作系统沙箱。Extension 与宿主拥有相同进程权限。

## 11. `Agent`：轻量的进程内状态机

[`Agent`](../../code/pi/packages/agent/src/agent.ts) 在 Loop 上增加以下状态：

- 当前 system prompt、model、thinking level、tools；
- 已完成消息和当前流式消息；
- 正在执行的 Tool Call ID；
- steer/follow-up 队列；
- 当前 Run 的 AbortController；
- 事件监听器和真正的 idle Promise。

它刻意不负责：

- JSONL 持久化；
- Session 分支；
- Skills 和项目规则发现；
- 自动 Compaction；
- TUI；
- Provider 凭据文件。

### 11.1 单活跃 Run

`Agent.prompt()` 会拒绝并发普通 Prompt。调用者必须选择：

- `steer()`；
- `followUp()`；
- 或等待 `waitForIdle()`。

这让 transcript 只有一个明确写入者，避免两个 Loop 同时追加 AssistantMessage 和 ToolResult。

### 11.2 事件就是状态机输入

Agent 不从多个异步任务随意修改状态，而是把 Loop Event 归约为状态：

| 事件 | 状态变化 |
|---|---|
| `message_start/update` | 更新 `streamingMessage` |
| `message_end` | 清空流式消息并追加正式消息 |
| `tool_execution_start` | 加入 `pendingToolCalls` |
| `tool_execution_end` | 移除对应 ID |
| `turn_end` | 保存最近错误文本 |
| `agent_end` | 清空流式状态 |

监听器按订阅顺序逐个 `await`。`agent_end` 只是“不再产生新 Loop Event”，监听器全部完成且
`finishRun()` 执行后，`Agent` 才真正 idle。

## 12. `AgentSession`：当前真正的产品 Harness

虽然类名不是 `Harness`，[`AgentSession`](../../code/pi/packages/coding-agent/src/core/agent-session.ts)
实际上承担了当前产品的大部分 Harness 职责：

```text
输入策略       command / input hook / skill / template / queue
模型策略       model selection / auth / thinking / retry
上下文策略     system prompt / context hook / compaction
工具策略       registry / active set / extension tools / hooks
会话策略       persist / branch / navigate / export / stats
产品事件       TUI / print / RPC / extension lifecycle
```

这也是该文件超过三千行的根本原因：可复用的 Loop 很小，产品级边界和异常路径远比 `while`
循环复杂。

### 12.1 动态配置只在安全边界生效

Agent 在 Run 开始时复制 context。AgentSession 又安装 `prepareNextTurnWithContext`，在每个
`turn_end` 后刷新：

- System Prompt；
- Active Tools；
- Model；
- Thinking Level。

所以运行中切换模型或工具，不会篡改已经发出的请求，但可以影响下一个 Provider Turn。

### 12.2 Retry 与 Compaction 在 Loop 外层

低层 Loop 遇到 error/aborted 会正常发出终止事件。AgentSession 在 post-run 阶段判断：

- 错误是否可重试；
- 重试次数和退避是否允许；
- 是否需要因 context overflow 先压缩再继续；
- 当前 context 是否超过主动压缩阈值。

把这些策略放在产品层，避免 Loop 固化某一种错误分类、费用策略或上下文管理方案。

## 13. Session：追加式树，而不是可变消息数组

当前 CLI 使用 [`SessionManager`](../../code/pi/packages/coding-agent/src/core/session-manager.ts)。
会话文件以 header 开始，后续每行是一个 JSON Entry。

### 13.1 Entry 通过 `parentId` 形成树

```text
u1 → a1 → tool1 → u2 → a2
                 └────→ u2' → a2'
```

分支时不会删除旧路径，只移动当前 leaf，然后把新 Entry 作为目标节点的孩子追加。这样可以：

- 在同一 Session 中保留多个探索方向；
- 回到旧节点继续；
- 将一条选定路径复制为新 Session；
- 给节点加 label，而不重写旧消息。

除消息外，Entry 还包括：

- model change；
- thinking level change；
- compaction；
- branch summary；
- custom message / custom entry；
- session info / label。

### 13.2 持久历史与模型上下文不是一回事

Session 保存完整追加历史，但每次发给模型的是当前 leaf 对应路径的投影：

```text
完整 Entry Tree
  → 从 leaf 沿 parentId 回溯
  → 得到当前 branch
  → 应用最新 Compaction
  → Entry 转 AgentMessage
  → transformContext / convertToLlm
  → Provider Context
```

因此“压缩上下文”不会删除早期 Entry。最新 Compaction Entry 保存摘要与
`firstKeptEntryId`，投影时使用“摘要 + 保留区间 + 压缩后的新消息”。

### 13.3 当前持久化边界的局限

当前路径主要在 `message_end` 时追加稳定消息。它可以恢复对话、模型选择、分支和压缩结果，
但不是完整的 operation journal：

- Provider 流到一半时，没有通用程序计数器可从精确位置恢复；
- 非幂等 Tool 是否已经产生外部副作用，不能仅由消息历史完全判断；
- 事件观察发生在追加持久化之前，尚不是严格的“先提交 durable fact，再通知所有观察者”。

这些正是新版 durable Harness 尝试解决的问题。

## 14. `AgentSessionRuntime`：为什么切 Session 要重建

[`AgentSessionRuntime`](../../code/pi/packages/coding-agent/src/core/agent-session-runtime.ts) 持有：

- 当前 `AgentSession`；
- 与当前 cwd 绑定的 Settings、Model、Resource 等服务；
- 一个可为目标 cwd 重新创建完整运行时的 factory；
- UI rebind 回调。

`new`、`resume`、`fork`、`import` 的切换流程大致是：

```text
session_before_switch / session_before_fork
  → abort 当前响应并等待其落盘收口
  → session_shutdown
  → 同步拆除宿主持有的旧 UI
  → dispose 旧 Session 和 Extension Context
  → 按目标 cwd 重建 services + AgentSession
  → UI rebind 到新 Session
  → session_start
```

如果只替换 `agent.state.messages`，旧项目的这些状态可能泄漏到新项目：

- 项目级设置；
- `AGENTS.md`；
- Extension；
- Tool cwd；
- Project Trust；
- 模型或 Provider 注册。

所以“重建”不是多余开销，而是在维护工作区隔离和生命周期正确性。

## 15. 资源系统：Prompt 资源和代码扩展要分开看

[`DefaultResourceLoader`](../../code/pi/packages/coding-agent/src/core/resource-loader.ts) 统一发现：

- Extensions；
- Skills；
- Prompt Templates；
- Themes；
- `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md` 等上下文文件；
- System Prompt 与追加 Prompt。

项目上下文按“全局目录 + 从祖先目录到当前 cwd”收集，同一目录按
`AGENTS.override.md → AGENTS.md → AGENTS.MD → CLAUDE.md → CLAUDE.MD` 选择第一个存在的文件。

### 15.1 Project Trust 是加载前置条件

首次遇到需要信任的项目资源时，Loader 会先在“不信任项目”的状态加载全局和临时 CLI
Extension，再由宿主解决 Project Trust，之后重新加载最终资源集。

这是为了避免出现循环：为了询问“是否信任项目”，却先执行了项目里的 Extension 代码。

### 15.2 Skill 与 Extension 的本质不同

| 机制 | 本质 | 能做什么 | 可信边界 |
|---|---|---|---|
| Skill | 带 frontmatter 的 Prompt 资源 | 给模型增加任务方法、知识和步骤 | 影响模型输入，但不直接增加进程权限 |
| Prompt Template | 参数化文本模板 | 快速生成用户 Prompt | 与普通 Prompt 相同 |
| Extension | 在宿主进程内运行的代码 | 注册工具、命令、Provider、UI，并拦截运行阶段 | 与宿主进程同权限，必须信任来源 |

Skill 不会因为出现在上下文中就自动获得 Tool；它只能使用当前 Agent 已经开放的能力。

## 16. Extension 如何横切主链

[`ExtensionRunner`](../../code/pi/packages/coding-agent/src/core/extensions/runner.ts) 被接入多个阶段：

```text
用户输入
  → input
  → before_agent_start
  → context transform
  → before_provider_request / before_provider_headers
  → message lifecycle
  → tool_call
  → Tool body
  → tool_result
  → turn_end / agent_end / agent_settled
  → session compact / switch / fork / shutdown / start
```

Extension 可以：

- 把输入标记为已处理，阻止普通 Prompt；
- 转换输入、上下文、Header 或 Provider payload；
- 注册 Tool、Command 和 Provider；
- 阻断 Tool Call 或改写 Tool Result；
- 在每轮前追加自定义消息或临时覆盖 System Prompt；
- 参与 Session 切换、分支和压缩；
- 提供 TUI renderer、快捷键和状态展示。

但 Extension Hook 不是 durable transaction，也不是安全沙箱。一个 Hook 已经执行外部副作用后
进程崩溃，当前产品链不能保证 exactly-once。

## 17. System Prompt 是动态组装结果

[`buildSystemPrompt()`](../../code/pi/packages/coding-agent/src/core/system-prompt.ts) 的输入包括：

- cwd；
- 当前 Skills；
- 项目上下文文件；
- 自定义或追加 System Prompt；
- 当前 Active Tools；
- Tool 自己贡献的 snippet 与 guideline。

Tool Registry 变化时，AgentSession 会重新构建 System Prompt。因此“开放一个 Tool”不只是在
request 中多一个 schema，还可能改变模型看到的使用说明。

可以把最终请求理解为：

```text
System Prompt = 产品基础说明
              + 项目规则
              + Skill 索引/说明
              + Active Tool 使用规则
              + Extension 追加内容
```

Extension 还可通过 `before_agent_start` 为单个 Run 临时覆盖 System Prompt；Run 收口后覆盖会被
清除，不自动变成持久设置。

## 18. 模型适配层：Provider 拥有协议差异

[`packages/ai/src/models.ts`](../../code/pi/packages/ai/src/models.ts) 中的 `Provider` 是具体运行单元，
负责：

- Provider ID、名称、base URL 和 Header；
- API Key 或 OAuth 认证；
- 静态或动态模型目录；
- `stream()` / `streamSimple()`；
- 可选的 deferred fetch/cancel。

`Models` 集合负责：

- 注册和查找 Provider；
- 查找 Model；
- 并发刷新动态模型目录；
- 解析凭据；
- 把请求分派给拥有该 Model 的 Provider；
- 应用最终 Header transform。

上层看到的模型请求保持统一：

```text
Model(provider, api, id, capabilities)
  + Context(systemPrompt, messages, tools)
  + SimpleStreamOptions
  → AssistantMessageEventStream
```

真正的 wire protocol 由 `packages/ai/src/api/` 中的 adapter 处理，例如 Anthropic Messages、
OpenAI Responses、OpenAI Chat Completions、Google Generative AI 和 Bedrock Converse。

这种设计没有强行抹平所有差异。thinking signature、reasoning metadata、compat flag、transport、
context window 和 thinking level mapping 仍保留在 Model 或 Message 元数据中，保证后续请求能够
正确回放。

## 19. 多种交互模式如何复用同一运行时

[`main()`](../../code/pi/packages/coding-agent/src/main.ts) 最终选择三类宿主：

| 模式 | 入口 | 输出特点 |
|---|---|---|
| Interactive | [`InteractiveMode`](../../code/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts) | TUI、编辑器、选择器、流式 Tool 展示 |
| Print / JSON | [`runPrintMode()`](../../code/pi/packages/coding-agent/src/modes/print-mode.ts) | 单次运行后输出最终文本，或逐行输出结构化事件 |
| RPC | [`runRpcMode()`](../../code/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts) | stdin/stdout JSONL 控制当前运行时 |

它们都订阅 `AgentSessionEvent`，而不是各自实现一套 Agent Loop。

[`packages/tui`](../../code/pi/packages/tui) 本身也保持通用：Component 只负责按宽度渲染文本行、
处理输入和失效缓存；`TuiMainScreen` 再做差量刷新、光标定位、overlay 合成和图片区域处理。
Agent 状态到具体组件的映射留在 Coding Agent 的 InteractiveMode 中。

## 20. 远程 Client/Server 是独立的实验演进线

[`packages/protocol`](../../code/pi/packages/protocol) 定义 transport-neutral 的 CBOR 消息、版本、
Session Snapshot、Transcript Event 和命令；[`packages/client`](../../code/pi/packages/client) 提供
连接状态、SessionHandle 和 ByteTransport 抽象；[`packages/server`](../../code/pi/packages/server)
提供 listener 与 Session server 骨架。

这条线的设计目标是：

```text
Client API
  → framed CBOR
  → Transport（Unix socket 或宿主自定义）
  → PiServer
  → 宿主提供的 PiServerService
  → Session runtime
```

认证和授权由具体 listener 在把连接交给 `PiServer` 之前完成，核心 server 不绑定某一种网络协议。

但源码明确把 `pi-server` 标为 experimental。它不提供独立 Coding Agent 服务；宿主仍需实现
`PiServerService`。Coding Agent 的
[`createCodingAgentHarness()`](../../code/pi/packages/coding-agent/src/server/create-harness.ts) 已展示怎样
把工具和 System Prompt 装进新版 `AgentHarness`，但后者的 `prompt()` 尚未实现，所以不能把
这条组装代码视为已可用的远程执行主链。

## 21. 新版 durable `AgentHarness` 想解决什么

当前 `AgentSession + SessionManager` 能很好地保存对话，但运行到模型或 Tool 中间时崩溃，缺少
通用的 operation 级恢复信息。新版设计希望把 Harness 从产品层下沉到 `packages/agent`。

目标结构可以概括为：

```text
AgentHarness facade
       │
       ├─ Session：持久事实
       │    ├─ Entry tree
       │    ├─ operation / queue / tool / usage records
       │    └─ lane pointers + facts
       │
       ├─ Reducer：纯函数归约当前状态和下一动作
       │
       └─ Interpreter：执行 Provider / Tool / Hook effect
```

其中：

- **Entry** 表示对话和配置等长期事实；
- **Record** 表示 Run、Step、Tool attempt、队列消费、usage 等操作事实；
- **Lane** 是指向 Entry Tree 某个 leaf 的命名游标；
- **Reducer** 只根据持久数据推导状态，不直接访问网络和文件；
- **Interpreter** 才负责执行外部效果，并把结果重新写成事实。

目标规范位于
[`packages/agent/docs/harness.md`](../../code/pi/packages/agent/docs/harness.md)。它描述了 operation
program counter、effect sandwich、pending write、lane、checkpoint、resume 和 Hook 合同。

### 21.1 当前已经实现的部分

- `Session`、`SessionTree` 和 Entry/Record 类型；
- 内存、JSONL 和 SQLite 相关存储基础；
- Session conformance tests；
- `SessionState` 与 [`reduceLaneState()`](../../code/pi/packages/agent/src/harness/reducer.ts)；
- Compaction、Branch Summary、Skill、Template、System Prompt helper；
- `ExecutionEnv`、Node 环境和 read/bash/edit/write/image 工具；
- telemetry schema；
- `AgentHarness` 的配置 getter/setter 和公开接口形状。

### 21.2 当前明确没有实现的部分

[`AgentHarness`](../../code/pi/packages/agent/src/harness/agent-harness.ts) 当前会对以下操作抛出
`HarnessNotImplemented`：

- `prompt()`、`skill()`、`promptFromTemplate()`；
- `steer()`、`followUp()`、`nextRun()`、`abort()`；
- `compact()`、`navigateTree()`、`resume()`；
- lane 管理、watch、manual drive；
- Hook 和 Event 注册；
- 从已有 operation record 恢复创建。

也就是说，现在是“数据模型、存储、Reducer 和工具先落地，执行 Interpreter 尚未落地”。
接口和设计文档表达的是方向，不能反推成当前功能。

## 22. 四层状态所有权

理解 pi 架构最有效的方法，是看谁拥有哪一份状态：

| 层 | 拥有的状态 | 生命周期 | 主要写入时机 |
|---|---|---|---|
| `runAgentLoop()` | 当前 context、config、new messages、Tool batch | 单次低层 Run | 执行过程中 |
| `Agent` | 内存 transcript、流式消息、pending Tool、队列、AbortController | 一个 Agent 实例 | 归约 Loop Event |
| `AgentSession` | Tool Registry、Extension、Prompt、Retry/Compaction、产品队列视图 | 当前产品 Session | 产品命令和 Agent Event |
| `SessionManager` | Entry Tree、当前 leaf、模型/Thinking/Compaction 等持久事实 | Session 文件 | `message_end` 和显式 Session 操作 |
| 新 `Session`/Reducer | Entry、operation record、lane、usage、pending write | 目标 durable Session | 尚未接通的 Interpreter 将负责 |

最容易出现问题的是让两个层同时拥有同一事实。例如：

- UI 直接修改 Agent 消息，同时 SessionManager 也追加消息；
- Tool Registry 已变化，但 System Prompt 仍描述旧工具；
- 切换 Session 只换消息，没有重建 cwd-bound Tool；
- `agent_end` 已发出，宿主却误以为 Retry 和持久化都完成。

pi 的许多代码复杂度，本质上都在维护这些所有权和时序边界。

## 23. 架构中值得学习的设计

### 23.1 小 Loop，大 Harness

模型与 Tool 的基本循环保持独立，复杂策略留给产品层。这样 Loop 可测试、可嵌入，产品又能加入
认证、扩展和持久化。

### 23.2 内部语义只在边界降级

`AgentMessage` 到 Provider `Message` 的转换只在请求前发生。自定义消息不会污染全部 Provider。

### 23.3 实时顺序与持久顺序分离

Tool 可以并行完成，UI 按真实完成顺序更新，但历史按模型调用顺序写入。

### 23.4 Session 使用追加和投影

分支、压缩、模型切换都追加新事实；当前上下文通过投影得到，避免原地重写历史。

### 23.5 工作区服务整体重建

Session 切换把 cwd-bound 配置、资源、Tool 和 Extension 当成一个一致性单元，而不是零散更新。

### 23.6 未完成能力显式失败

新版 Harness 没有用空实现假装成功，而是抛 `HarnessNotImplemented`。这使调用者不会误以为操作
已经持久化或执行。

## 24. 当前架构的代价和风险

### 24.1 `AgentSession` 职责过重

输入、模型、工具、扩展、持久化、Retry、Compaction 和导航集中在一个大类中。好处是产品行为
集中，代价是修改时容易跨越多个状态边界。新版 Harness 正在尝试下沉通用部分。

### 24.2 当前持久化不是完整恢复协议

JSONL 对话树可以恢复“已经完成的事实”，但不能保证从任意 Provider delta 或非幂等 Tool 中点
继续，也不能证明外部副作用 exactly-once。

### 24.3 Extension 是可信代码

Project Trust 降低了误加载风险，但一旦加载，Extension 仍与宿主同权限。Tool Hook、allowlist 和
提示词都不能替代 OS、容器或远端权限隔离。

### 24.4 动态更新增加时序复杂度

模型、Tools、Prompt、Extension 和队列都能在运行期间变化。`prepareNextTurn` 提供了安全边界，
但扩展作者仍需理解“当前请求快照”和“下一 Turn 配置”的区别。

### 24.5 新旧 Session/Harness 架构并存

当前 Coding Agent SessionManager 与新版 `packages/agent/harness/session` 是两套不同成熟度的实现。
不能把新 Harness 的 operation record 能力误写成现有 CLI 已经具备，也不能因为 facade 未完成就
忽略其已落地的 Storage 和 Reducer。

## 25. 推荐源码阅读顺序

如果目标是先看懂、再深入，建议按下面顺序：

1. [`packages/agent/src/types.ts`](../../code/pi/packages/agent/src/types.ts)：认识 Message、Tool、Event、
   Queue 和 Loop Config。
2. [`packages/agent/src/agent-loop.ts`](../../code/pi/packages/agent/src/agent-loop.ts)：只看一次
   `LLM → Tool → LLM` 如何运转。
3. [`packages/agent/src/agent.ts`](../../code/pi/packages/agent/src/agent.ts)：看 Loop 怎样变成有状态、
   可取消、可订阅的进程内 Agent。
4. [`packages/coding-agent/src/core/sdk.ts`](../../code/pi/packages/coding-agent/src/core/sdk.ts)：看产品
   如何注入模型、消息转换、资源和工具。
5. [`AgentSession.prompt()`](../../code/pi/packages/coding-agent/src/core/agent-session.ts)：沿输入准入、
   post-run、Retry、Compaction 分段阅读。
6. [`packages/coding-agent/src/core/session-manager.ts`](../../code/pi/packages/coding-agent/src/core/session-manager.ts)：
   理解 Entry Tree、leaf、branch 和 context projection。
7. [`packages/coding-agent/src/core/resource-loader.ts`](../../code/pi/packages/coding-agent/src/core/resource-loader.ts)
   与 [`extensions/runner.ts`](../../code/pi/packages/coding-agent/src/core/extensions/runner.ts)：理解扩展面。
8. [`packages/coding-agent/src/core/agent-session-runtime.ts`](../../code/pi/packages/coding-agent/src/core/agent-session-runtime.ts)：
   看 Session 替换和 cwd 隔离。
9. [`packages/ai/src/models.ts`](../../code/pi/packages/ai/src/models.ts) 和一个具体 API adapter：理解模型边界。
10. 最后阅读 [`harness/agent-harness.ts`](../../code/pi/packages/agent/src/harness/agent-harness.ts)、
    [`harness/reducer.ts`](../../code/pi/packages/agent/src/harness/reducer.ts) 和
    [`harness.md`](../../code/pi/packages/agent/docs/harness.md)，对照目标设计与当前完成度。

## 26. 最终总结

pi 当前可运行架构可以压缩成一句话：

> `AgentSession` 把资源、策略和持久化组装到轻量 `Agent` 上，`Agent` 用事件驱动的
> `runAgentLoop()` 执行模型与工具，而 `pi-ai` 在最外层隔离不同 Provider 协议。

它真正值得学习的不是 `while (toolCalls.length)`，而是以下不变量：

1. 一个活跃 transcript 只有一个 Run 写入者；
2. 模型只接收请求边界投影出的标准消息；
3. Tool 可以并发，但历史顺序必须确定；
4. 配置变化只在安全 Turn 边界进入下一请求；
5. Session 历史追加，当前上下文由 branch 和 compaction 投影；
6. Session cwd 变化时，所有 cwd-bound 服务整体重建；
7. Extension 是可信进程内代码，不是假想沙箱；
8. 设计规格、已实现底座和已接通产品主链必须分别判断。

新版 durable Harness 的方向，是把当前集中在 `AgentSession` 中的通用运行时职责，进一步拆成
“持久事实 + 纯 Reducer + Effect Interpreter”。但在当前版本中，理解真实行为仍应从
`AgentSession → Agent → runAgentLoop` 开始。
