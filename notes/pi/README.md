# pi：模型接口、轻量 Loop 与实验性 Durable Harness

> 本轮复核：2026-11-02；本地源码 `62752fd4c37a72e0f3c1cc83e9ac3b4299f31fe6`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

> 2026-11-07 补充：按同一源码版本展开 `prompt → model → tool → result` 的具体设计；阅读相关测试代码，未执行测试。

## 当前分层

pi 当前至少有三条应分别理解的主线：`pi-ai` 统一模型访问，`pi-agent-core` 提供轻量 Agent Loop，`pi-coding-agent` 提供终端产品与 SDK；新增 `pi-durable` 承载可持久化会话、任务和恢复。旧笔记中的 `packages/agent/src/harness` 已不在当前树中。

| 层 | 当前入口 | 关注点 |
| --- | --- | --- |
| AI | [pi-ai README](../../code/pi/packages/ai/README.md) | Provider collection、鉴权、消息与流事件 |
| 轻量 Agent | [agent.ts](../../code/pi/packages/agent/src/agent.ts)、[agent-loop.ts](../../code/pi/packages/agent/src/agent-loop.ts) | 内存状态、工具续跑与输入队列 |
| Coding Agent | [agent-session.ts](../../code/pi/packages/coding-agent/src/core/agent-session.ts) | 产品会话、压缩、工具和扩展 |
| Durable Harness | [harness.ts](../../code/pi/packages/durable/src/harness/harness.ts) | 会话句柄、提交和运行生命周期 |
| Durable Session | [session.ts](../../code/pi/packages/durable/src/session/session.ts) | 原子 commit、entries/documents/tasks |
| Storage | [storage](../../code/pi/packages/durable/src/storage) | memory、JSONL、SQLite 等存储实现 |

## 轻量 Loop

```text
输入 → context → model stream
  → assistant message
  → 有工具：执行并加入 tool result → 下一次模型请求
  → 无工具：检查 steer / follow-up 与终止条件
```

这条链解决模型与工具反复交互，但内存 Loop 本身不等于崩溃恢复协议。恢复、文件副作用幂等和宿主权限必须在具体产品/持久化层继续检查。

## 从 `session.prompt()` 看具体设计

### 三层对象：产品会话、运行状态、执行循环

[sdk.ts](../../code/pi/packages/coding-agent/src/core/sdk.ts) 的 `createAgentSession()` 先准备模型、资源和 SessionManager，再创建 `Agent`，最后用 `AgentSession` 将它们连接起来。[最小 SDK 示例](../../code/pi/packages/coding-agent/examples/sdk/01-minimal.ts) 从 `session.prompt()` 开始使用这条链。

| 对象 | 保存或接入的内容 | 在主链中的职责 |
| --- | --- | --- |
| `AgentSession` | SessionManager、设置、项目资源、扩展、重试与压缩状态 | 处理输入、准备运行、接入会话记录及产品级恢复 |
| `Agent` | 消息、模型、可执行工具、活动运行、输入队列、监听器 | 保证同一实例的运行生命周期，通过事件更新内存状态 |
| `runLoop()` | 本次执行的 context、配置、上一 turn 和待消费消息 | 调用模型、执行工具、决定是否再请求模型 |

这三层是同一进程中的协作对象，不代表三个 Agent 或三次模型调用。模型调用通过注入的 `streamFunction` 发生，工具通过各自的 `execute()` 发生。Loop 不依赖终端界面。

```text
session.prompt(text)
  → 输入处理、模板/Skill 命令展开、忙闲判断、模型鉴权检查
  → AgentSession._startRun()
      → _prepareRun()：必要压缩、before_agent_start、准备消息与工具
      → Agent.prompt(messages)
          → runPromptMessages()
              → runAgentLoop()
                  → runLoop()
                      → 模型响应 → 工具批次 → 下一轮模型请求
      → 产品层检查：重试、恢复、运行结束前的扩展处理
```

入口见 [agent-session.ts](../../code/pi/packages/coding-agent/src/core/agent-session.ts) 的 `prompt()`、`_startRun()`、`_prepareRun()`，以及 [agent.ts](../../code/pi/packages/agent/src/agent.ts) 的 `prompt()` 和 `runPromptMessages()`。某些输入会被扩展命令直接处理；运行中输入也可能排队，因此调用 `session.prompt()` 不一定立即产生模型请求。

### 一次 `read` 调用如何变成下一轮上下文

以下仅为协议示意，不是本次执行记录，也省略时间戳和 Provider 元数据：

```text
user: 解释 src/total.ts
assistant: toolCall(id="c1", name="read", arguments={path:"src/total.ts"})
toolResult: toolCallId="c1", toolName="read", content=[文件内容]
assistant: 根据文件内容给出解释，或继续请求其他工具
```

模型返回的是结构化调用描述。运行时按名称找到工具，执行真实读取，再以相同 `toolCallId` 关联结果。下一次请求携带这段历史，使模型知道自己请求了什么、实际得到了什么。`runLoop()` 不包含“解释 total.ts”的固定流程，也不会根据文件名选择下一步。

真实实现分两部分：工具接口见 [types.ts](../../code/pi/packages/agent/src/types.ts) 的 `AgentTool`，读取操作见 [read.ts](../../code/pi/packages/coding-agent/src/core/tools/read.ts)。通用循环只依赖工具描述、参数 schema 和 `execute()` 等协议。

### 消息状态为什么分成多个视图

`Agent.createContextSnapshot()` 复制消息和工具数组；`runAgentLoop()` 再构造本次运行的 context。Loop 内部据此追加用户消息、完整 assistant 消息和工具结果。这里是**浅复制数组**，并未深拷贝每个消息和工具对象，不能理解为内存隔离。

同时，Loop 通过 `await emit(event)` 通知外部。`Agent.processEvents()` 在 `message_end` 时把完整消息追加到自身状态；流式过程主要更新 `streamingMessage`。因此，Loop 的工作上下文与 Agent 的内存消息数组各有更新路径，不是把同一数组重复追加两次。

```text
Loop 内部 context ──供下一轮模型请求使用
        │
        └─ await emit(event)
               → Agent.processEvents()：更新 Agent 内存状态
               → await 已注册监听器
                      → AgentSession：扩展事件、会话记录、产品状态
```

`AgentSession` 订阅 Agent 事件，在 `_handleAgentEvent()` 的 `message_end` 分支调用 `SessionManager.appendMessage()` 或对应的自定义消息入口。[SessionManager](../../code/pi/packages/coding-agent/src/core/session-manager.ts) 用带 `id/parentId` 的 JSONL 追加树记录会话，再按当前分支和压缩记录构建上下文。

这里体现了三种不同用途：Loop 推进当前执行，Agent 提供可观测的运行状态，SessionManager 保存会话记录。它们不自动构成覆盖工具副作用的事务。

### 模型请求前：把应用历史转换成 Provider 可接受的输入

[agent-loop.ts](../../code/pi/packages/agent/src/agent-loop.ts) 的 `streamAssistantResponse()` 按以下次序处理：

```text
本轮 context
  → prepareRequest（在外层 runLoop 中，可替换 context/model）
  → transformContext（可选，上下文选择或扩展处理）
  → convertToLlm（把应用消息转成模型消息）
  → normalizeContext
  → streamFunction(model, transcript, options)
```

这种拆分允许应用保留自定义消息和界面状态，同时单独决定模型实际看到什么。[sdk.ts](../../code/pi/packages/coding-agent/src/core/sdk.ts) 将模型调用接到 `modelRuntime.streamSimple()`，因此 Loop 不必直接了解各个 Provider 的 SDK。

当前版本还有一个需要留意的协议设计：`context.tools` 保存可执行工具；模型可见的工具声明记录在 transcript 的 system messages 中。`declareToolChanges()` 把工具集差异写为 `toolsAdded/toolsRemoved`，再由模型适配层处理。不能按旧接口假设模型请求直接携带运行时工具函数。

### 模型响应后：先收齐，再执行工具

`streamAssistantResponse()` 将 Provider 的流式事件转成 `message_start/update/end`，最终返回完整 `AssistantMessage`。`runLoop()` 随后提取其中的 `toolCall`，并处理这些分支：

| 情况 | 当前行为 |
| --- | --- |
| `stopReason` 是 `error` 或 `aborted` | 结束本次核心运行，不执行其中的工具 |
| `stopReason` 是 `length`，且带工具调用 | 为这些调用生成失败结果，不执行可能残缺的参数 |
| 正常响应带工具调用 | 进入工具准备、执行和结果归一化 |
| 正常响应无工具调用 | 检查 finishTurn 和输入队列，决定是否结束 |

流式解析出来的 JSON 即使满足 schema，也可能只是被截断后仍能解析的片段。这是完整响应状态与参数校验都需要检查的原因。

单个工具的执行路径是：

```text
按名称查工具 → prepareArguments → schema 校验 → beforeToolCall
  → execute(toolCallId, args, signal, onUpdate)
  → afterToolCall → 生成 toolResult → 写回上下文
```

未知工具、校验失败、Hook 拦截及执行异常会形成错误结果。当前 `beforeToolCall` 可以修改已校验的参数，且不会自动再次校验；这一扩展能力不能等同于不可绕过的权限或最终参数保证。

`AgentToolResult` 也按消费者分开数据：`content` 面向模型，`details` 面向日志和 UI，`structuredContent` 面向程序调用者。后两者不应被当作自动进入模型上下文的额外知识。

### 并行、插话与终止：小循环中的调度规则

当前工具默认可以并行；若配置为 sequential，或批次内任一工具声明 sequential，整个批次串行。并行分支先逐个做准备，再并发执行；执行完成事件可以按完成顺序出现，模型可见的结果消息仍按原调用顺序提交。

例如调用顺序为 A、B，B 先完成时：

```text
进度事件：tool_execution_end(B) → tool_execution_end(A)
结果历史：toolResult(A) → toolResult(B)
```

用户新输入通过两种队列接入：`steer` 在下一轮正常消费点参与当前运行；`followUp` 在当前循环自然准备停止时消费。两者均不是立即撤销正在执行的工具；立即取消另走 abort 信号。`Agent.prompt()` 在已有活动运行时拒绝直接再启动普通 prompt，避免同一实例同时运行两条消息链。

一个 pi-core `turn` 是一次模型请求及其工具批次，一个用户任务可能包含许多 turn。`finishTurn` 可返回 `end` 或 `continue`；工具批次全部结果带 `terminate: true` 时可以跳过自动续问。`agent_end` 发出后仍需等待 Agent 的异步监听器处理完成，Agent 才真正空闲；产品层还可能因错误重试或上下文恢复调用 `agent.continue()`。

因此，无工具调用仅是默认停止判断的一个条件。循环终止也不证明业务任务已经完成；是否正确修改、测试是否相关、用户目标是否满足，需要产品或任务验收机制提供证据。

### 为什么这些边界能让核心保持小

从职责分配可以归纳出：模型选择行动，工具封装具体操作，Loop 维护通用协议，Agent 管理运行状态，AgentSession 连接产品能力。框架不需要为“修复测试”“解释函数”“生成文档”各写一条固定主流程。

相应代价是：模型可能选错行动；Hook 不能自动提供强制沙箱；保存会话不能保证外部副作用只发生一次。需要强恢复语义时，应另外研究下文的实验性 durable 包，不能把它的能力直接归到当前产品主链。

### 测试证据与推荐阅读顺序

本次静态阅读了 [agent-loop.test.ts](../../code/pi/packages/agent/test/agent-loop.test.ts) 中上下文转换顺序、截断响应不执行工具、并行完成与结果顺序的用例，以及 [agent.test.ts](../../code/pi/packages/agent/test/agent.test.ts) 中工具声明进入 transcript 和等待异步订阅者的材料。未执行这些测试。

推荐按 `types.ts → agent.ts → agent-loop.ts → read.ts → sdk.ts → agent-session.ts → session-manager.ts` 阅读。先用一次 read 的轨迹串起接口和状态，再研究工具并行、steer/follow-up 和压缩，避免一开始就进入产品会话的全部分支。

## Durable 的记录模型

[pi-durable README](../../code/pi/packages/durable/README.md) 明确标为 **Experimental**，API 可在版本之间变化。其概念是：Session 为存储及执行容器；Conversation 是不可变 entries 的 transcript；Document 保存可变 JSON 状态；Task 持久化可继续的工作；Commit 将这些改变原子写入。

```text
Harness.open(storage)
  → root conversation
  → submit(input)：持久化准入
  → generation task → model → tool tasks
  → commit entries / documents / tasks
  → 已存储内容再对外展示
```

重开存储可以恢复未完成工作，进程在模型请求中死亡会计为失败 attempt 后重试，并受 restart limit 等策略约束。不能把这些语义推导成外部 API 或任意 Shell 副作用 exactly-once。

## 配置、上下文和扩展

[harness/agent.ts](../../code/pi/packages/durable/src/harness/agent.ts) 把 retry、compaction、progress、toolExecution、steeringMode 和 followUpMode 等解析为运行设置，并以 `pi.agent` document 保存每 conversation 配置。压缩见 [compaction.ts](../../code/pi/packages/durable/src/harness/compaction.ts)，工具定义与扩展要走 registry 和相应 hook。

Coding Agent 的 AgentSession 与 Durable Harness 都存在，不能因出现新包就声称终端产品所有路径已迁移过去。选择嵌入路线时要按公开入口和实际依赖核对。

## 验证材料与阅读顺序

先读 AI 与轻量 Loop，再读产品 AgentSession；需要服务端恢复时单独研究 Durable。关键材料：[重启失败测试](../../code/pi/packages/durable/test/harness-restart-failure.test.ts)、[工具测试](../../code/pi/packages/durable/test/harness-tools.test.ts)、[压缩测试](../../code/pi/packages/durable/test/harness-compaction.test.ts)。

专题：[自建 Coding Agent](./build-your-own-coding-agent.md)、[模型适配](./model-api-adaptation.md)、[跨平台适配](./cross-platform-adaptation.md)。
