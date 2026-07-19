# ReactAgent、Multi-Agent、Tool Calling、Skills 与 Graph

> 源码版本：`spring-ai-alibaba/main@84ca19a12`
>
> Spring AI Alibaba 中的类名是 `ReactAgent`；仓库中 AgentScope 集成使用的类名才是
> `ReActAgent`。本文讨论前者。

## 1. 总体架构

Spring AI Alibaba 的 Agent 能力可以分成四层：

```text
Agent API
  ├─ ReactAgent：LLM 与 Tool 之间的 ReAct 循环
  └─ FlowAgent：Sequential / Parallel / Loop / Routing
             │
             ▼
StateGraph：节点、边、条件路由、并行路由和子图
             │
             ▼
CompiledGraph + GraphRunner：状态合并、流式执行、Checkpoint、中断恢复
             │
             ▼
Spring AI：ChatModel、ChatClient、Message、ToolCallback
```

最重要的设计结论是：

> `ReactAgent` 没有直接实现一个命令式 `while` 循环，而是先把 ReAct 循环构造成
> `StateGraph`，再交给 Graph Runtime 执行。

核心代码入口：

- [`ReactAgent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)
- [`AgentLlmNode`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentLlmNode.java)
- [`AgentToolNode`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentToolNode.java)
- [`StateGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/StateGraph.java)
- [`CompiledGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompiledGraph.java)

## 2. ReactAgent 的构建过程

`ReactAgent.builder()` 默认通过 `DefaultAgentBuilderFactory` 创建
[`DefaultBuilder`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/DefaultBuilder.java)。

`build()` 的主要工作是：

1. 校验 Agent 名称以及 `ChatModel`/`ChatClient`。
2. 合并模型默认选项和 Agent 级 `ChatOptions`。
3. 收集工具、Hook 和 Interceptor。
4. 创建负责 Reason 的 `AgentLlmNode`。
5. 创建负责 Act 的 `AgentToolNode`。
6. 创建 `ReactAgent`，但此时不一定立即编译图。

### 2.1 工具来源

Builder 可以从多个来源收集工具：

- `.tools(ToolCallback...)`
- `.methodTools(Object...)`
- `ToolCallbackProvider`
- `toolNames + ToolCallbackResolver`
- ModelInterceptor 提供的工具
- Hook 提供的工具

最终的合并优先级是：

```text
Hook 工具 → Interceptor 工具 → 用户直接配置的工具
```

同名工具会被去重。合并后的同一组工具会同时交给两个节点：

```text
AgentLlmNode  ── 把工具 schema 告诉 LLM
AgentToolNode ── 执行 LLM 生成的工具调用
```

## 3. ReAct 状态图

建图入口是 `ReactAgent.initGraph()`，基础结构如下：

```text
START
  │
  ▼
beforeAgent hooks
  │
  ▼
beforeModel hooks  ◄────────────────────────────┐
  │                                             │
  ▼                                             │
AgentLlmNode                                    │
  │                                             │
  ▼                                             │
afterModel hooks                                │
  │                                             │
  ├─ AssistantMessage 含 toolCalls ─► AgentToolNode
  │
  └─ 普通 AssistantMessage ─► afterAgent hooks ─► END
```

`ReactAgent` 在图中使用两个固定节点名：

- `agent_model`：模型调用节点
- `agent_tool`：工具执行节点

Hook 按四个生命周期位置被转换成图节点：

- `BEFORE_AGENT`
- `AFTER_AGENT`
- `BEFORE_MODEL`
- `AFTER_MODEL`

其中 `beforeAgent/afterAgent` 包围整个 Agent，`beforeModel/afterModel` 位于 ReAct
循环内部，因此每次模型调用都会执行。

Hook 还可以返回 `jump_to`，将控制流跳转到：

- `model`
- `tool`
- `end`

## 4. Reason：AgentLlmNode

[`AgentLlmNode.apply()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentLlmNode.java)
的执行步骤是：

1. 从 `OverAllState` 读取 `messages`。
2. 如果没有消息，尝试从 `input` 创建 `UserMessage`。
3. 向最后一个用户消息追加结构化输出 schema。
4. 使用图状态渲染尚未渲染的 `AgentInstructionMessage`。
5. 构造包含消息、模型选项、工具描述和状态上下文的 `ModelRequest`。
6. 经过 ModelInterceptor 责任链。
7. 使用 `ChatClient` 进行同步或流式调用。
8. 把模型返回的 `AssistantMessage` 写回图状态。

### 4.1 Graph 接管工具执行

`AgentLlmNode` 会强制执行：

```java
copiedOptions.setInternalToolExecutionEnabled(false);
```

这意味着 Spring AI 只负责生成结构化 `toolCalls`，不在 `ChatClient` 内部执行
工具。工具调用由 `AgentToolNode` 和 StateGraph 控制，从而可以支持：

- Hook 和条件路由
- Checkpoint
- 中断与恢复
- 工具并行执行
- 工具状态更新
- 流式事件

### 4.2 systemPrompt 与 instruction

两者作用不同：

| 配置 | 注入方式 | 作用范围 |
|---|---|---|
| `systemPrompt` | 每次调用模型时添加 `SystemMessage` | 每轮模型调用 |
| `instruction` | 默认 `InstructionAgentHook` 添加 `AgentInstructionMessage` | Agent 开始时写入状态 |

`AgentInstructionMessage` 的消息类型是 USER，并且支持根据图状态渲染 Prompt
模板。默认 Hook 实现见
[`InstructionAgentHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/InstructionAgentHook.java)。

## 5. Reason 到 Act 的路由

模型节点之后，`makeModelToTools()` 根据以下优先级选择下一节点：

1. 如果 Hook 设置了合法的 `jump_to`，立即按该指令跳转。
2. 最后一条消息是带有 `toolCalls` 的 `AssistantMessage`，进入工具节点。
3. 最后一条消息是普通 `AssistantMessage`，结束 Agent。
4. 最后一条消息是部分 `ToolResponseMessage`，比较请求和已执行的 tool-call ID：
   - 所有工具均已执行：回到模型；
   - 仍有工具未执行：继续进入工具节点。

因此，框架不是解析模型输出文本来判断行动，而是依赖 Spring AI 的结构化
`AssistantMessage.ToolCall`。

## 6. Act：AgentToolNode

[`AgentToolNode.apply()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentToolNode.java)
的基本流程是：

```text
读取最后一条 AssistantMessage
        │
        ▼
提取 ToolCall 列表
        │
        ├─ 顺序执行
        └─ 并行执行
                │
                ▼
         ToolInterceptor 责任链
                │
                ▼
           查找 ToolCallback
                │
                ▼
        sync / async / cancellable async
                │
                ▼
         生成 ToolResponseMessage
                │
                ▼
          追加到 messages 状态
```

### 6.1 工具查找顺序

工具节点按以下顺序解析工具名：

1. Agent 静态注册的工具
2. ModelInterceptor 动态添加的工具
3. `ToolCallbackResolver`

如果找不到工具，不会直接让整个 Agent 崩溃，而是构造包含错误信息的工具响应，
使模型有机会理解错误并调整下一步行动。

### 6.2 工具上下文与状态更新

对于 `StateAwareToolCallback`、`FunctionToolCallback` 和 `MethodToolCallback`，工具
上下文会额外注入：

- 当前 `OverAllState`
- 当前 `RunnableConfig`
- 工具专用的 state-update Map

因此工具不仅能返回字符串，还能通过 update Map 修改图状态。

### 6.3 顺序执行

顺序模式逐个调用工具，为每个工具创建独立 update Map，成功后立即合并。

多个工具写入同一 key 时采用 last-write-wins，即后执行的工具覆盖先执行的工具。

### 6.4 并行执行

开启 `.parallelToolExecution(true)` 后，同一模型响应中的多个工具可以并行执行。

实现包括：

- 使用配置的 Executor
- 使用 `Semaphore` 限制 `maxParallelTools`
- 每个工具使用独立状态更新 Map
- 按原始 ToolCall 顺序组织最终响应
- 支持超时和错误隔离
- `CancellableAsyncToolCallback` 支持协作式取消
- 使用 `ToolStateCollector` 和 `KeyStrategy` 合并状态

注意：并行执行使用的 `OverAllState.snapShot()` 是浅拷贝。工具不应原地修改状态中的
可变 List/Map，而应该通过注入的 update Map 返回修改。

## 7. 状态、输出与会话

Agent 的核心状态是：

```java
Map<String, Object>
```

默认关键策略为：

```text
messages  → AppendStrategy
outputKey → ReplaceStrategy 或用户自定义策略
其他 key  → 默认 ReplaceStrategy
```

同步 `call()` 最终按下面的规则提取结果：

- 配置了 `outputKey`：读取这个 key，并转换为 `AssistantMessage`；
- 没有配置：返回 `messages` 中最后一个 `AssistantMessage`。

如果配置了 `CheckpointSaver`，并在不同调用中使用同一个 `threadId`，Graph Runtime
会加载历史 Checkpoint，使对话和其他状态可以跨调用延续。

## 8. Hook 与 Interceptor

这两套机制处于不同层级：

| 机制 | 所处层级 | 适合解决的问题 |
|---|---|---|
| Hook | StateGraph 节点 | 状态变更、流程跳转、中断、HITL、调用次数限制 |
| ModelInterceptor | 单次模型调用外围 | Prompt 修改、动态工具、重试、fallback、上下文处理 |
| ToolInterceptor | 单次工具调用外围 | 工具重试、错误处理、权限和参数检查 |
| StreamingModelInterceptor | 模型响应流外围 | 检查、修改、过滤流式 chunk |

同步 Model/Tool Interceptor 使用责任链模式：第一个注册的 Interceptor 是最外层。
实现见
[`InterceptorChain`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/InterceptorChain.java)。

需要参与 Graph 控制流时应选择 Hook；只包装一次模型或工具调用时选择 Interceptor。

## 9. Multi-Agent

Spring AI Alibaba 没有把 Multi-Agent 限制为单一模型，而是提供了多种组合方式。

### 9.1 Agent 作为子图：FlowAgent

`ReactAgent.asNode()` 会编译自己的状态图，并包装成父图中的可恢复子图节点。

子图适配器还负责：

- 控制是否向子图传递父级消息；
- 控制是否向父图返回完整推理消息；
- 为子图生成独立的 RunnableConfig；
- 在共享 CheckpointSaver 时为子线程生成独立 thread ID。

#### SequentialAgent

```text
START → agent1 → agent2 → agent3 → END
```

适用于顺序固定、前一个 Agent 输出供后一个 Agent 使用的流水线。建图策略见
[`SequentialGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/SequentialGraphBuildingStrategy.java)。

#### ParallelAgent

```text
             ┌─ agent1 ─┐
START → fan ─├─ agent2 ─┼→ aggregator → END
             └─ agent3 ─┘
```

特点：

- 子 Agent 并行执行；
- 支持 `maxConcurrency`；
- 支持 Map、List、字符串拼接或自定义 MergeStrategy；
- 至少需要两个、最多允许十个子 Agent；
- 子 Agent 应配置唯一 `outputKey`，避免结果冲突。

建图策略见
[`ParallelGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/ParallelGraphBuildingStrategy.java)。

#### LoopAgent

```text
loopInit → loopDispatch
               │
       continue│      break
               ▼        ▼
           subAgent     END
               │
               └──→ loopDispatch
```

支持固定次数、条件循环、JSON 数组遍历以及自定义 `LoopStrategy`。每个 LoopAgent
只允许一个子 Agent。建图策略见
[`LoopGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/LoopGraphBuildingStrategy.java)。

#### LlmRoutingAgent

```text
Routing LLM
   │
   ├─ agent A
   ├─ agent B
   └─ agent C
          │
          ▼
    RoutingMergeNode
```

路由模型根据子 Agent 的名称和 description 选择一个或多个 Agent。多选时并行执行，
最后由 `RoutingMergeNode` 使用模型综合结果。建图策略见
[`RoutingGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/RoutingGraphBuildingStrategy.java)。

### 9.2 Agent 作为工具：Supervisor

[`AgentTool`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/AgentTool.java)
可以把一个完整的 `ReactAgent` 包装成标准 `ToolCallback`：

```java
.tools(
    AgentTool.getFunctionToolCallback(calendarAgent),
    AgentTool.getFunctionToolCallback(emailAgent)
)
```

父 Agent 看到的是普通工具；实际调用工具时，内部会启动子 Agent 自己的 ReAct 图。
如果父调用携带 thread ID，子线程 ID 会被改写为：

```text
父 threadId + "_" + 子 agent name
```

这样可以隔离父子 Agent 的 Checkpoint。示例见
[`SupervisorConfig`](../../code/spring-ai-alibaba/examples/multiagent-patterns/supervisor/src/main/java/com/alibaba/cloud/ai/examples/multiagents/supervisor/SupervisorConfig.java)。

### 9.3 Task/SubAgent

`SubAgentInterceptor` 或 `TaskToolsBuilder` 会向主 Agent 提供通用 `task` 工具，LLM
根据 `subagent_type` 选择专业 Agent。

适合：

- 将上下文很重的工作与主 Agent 隔离；
- 研究、代码搜索等专业任务；
- 后台执行独立任务；
- 通过 Java 或 Markdown 定义子 Agent。

示例见
[`SubagentConfig`](../../code/spring-ai-alibaba/examples/multiagent-patterns/subagent/src/main/java/com/alibaba/cloud/ai/examples/multiagents/subagent/SubagentConfig.java)。

### 9.4 Handoff

Handoff 不把 Agent 包装成工具，而是把不同 Agent 放进同一个父 `StateGraph`：

```text
sales_agent ── transfer_to_support ──► support_agent
support_agent ── transfer_to_sales ──► sales_agent
```

Transfer 工具修改 `active_agent` 等父图状态，条件边据此决定下一位接管对话的
Agent。示例见
[`MultiAgentHandoffsConfig`](../../code/spring-ai-alibaba/examples/multiagent-patterns/handoffs-multiagent/src/main/java/com/alibaba/cloud/ai/examples/multiagents/handoffs/MultiAgentHandoffsConfig.java)。

### 9.5 模式选择

| 场景 | 推荐模式 |
|---|---|
| 流程顺序固定 | SequentialAgent |
| 多个独立任务并行完成 | ParallelAgent |
| 同一任务反复迭代 | LoopAgent |
| 根据请求内容自动选择专家 | LlmRoutingAgent |
| 主 Agent 自主调用专业 Agent | AgentTool/Supervisor |
| 上下文隔离、后台长任务 | Task/SubAgent |
| Agent 之间显式转交控制权 | Handoff |

## 10. Skills

Skill 不是另一种 Agent，也不只是工具集合。它是一个可发现、按需加载的 Prompt/
工作流知识包，并且可以在加载后动态开放相关工具。

### 10.1 Skill 文件结构

```text
skills/
└─ sales-analysis/
   ├─ SKILL.md
   ├─ scripts/
   ├─ references/
   └─ assets/
```

`SKILL.md` 使用 YAML frontmatter：

```yaml
---
name: sales-analysis
description: Analyze sales data
allowed_tools:
  - query_database
---

具体操作说明……
```

[`SkillScanner`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/registry/filesystem/SkillScanner.java)
会解析 frontmatter，并验证：

- name 最长 64 字符；
- name 使用小写字母、数字和单连字符；
- name 应与目录名一致；
- description 最长 1024 字符。

为兼容旧 Skill，当前名称校验失败只记录警告，并不会拒绝加载。

### 10.2 SkillRegistry

[`SkillRegistry`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/registry/SkillRegistry.java)
负责列出、查找、搜索、读取、重新加载和禁用 Skill。

主要实现包括：

- `FileSystemSkillRegistry`
  - 默认用户目录：`~/saa/skills`
  - 默认项目目录：`./skills`
  - 同名时项目 Skill 覆盖用户 Skill
- `ClasspathSkillRegistry`
  - 默认从 `resources/skills` 加载
  - 会把 JAR 中的 scripts/references/assets 复制到可访问的临时目录

### 10.3 SkillsAgentHook

推荐通过
[`SkillsAgentHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/skills/SkillsAgentHook.java)
完成集成：

```java
SkillRegistry registry = ClasspathSkillRegistry.builder()
    .classpathPath("skills")
    .build();

SkillsAgentHook skillsHook = SkillsAgentHook.builder()
    .skillRegistry(registry)
    .build();

ReactAgent agent = ReactAgent.builder()
    .name("sql-assistant")
    .model(chatModel)
    .hooks(skillsHook)
    .build();
```

这个 Hook 同时提供：

- `read_skill`
- `search_skills`
- `disable_skill`
- `SkillsInterceptor`

### 10.4 渐进式披露

Skills 不会在一开始就把所有 `SKILL.md` 全文塞进上下文：

```text
第一轮模型调用
  │
  ├─ system prompt 只包含 skill 名称、描述、路径
  │
  ▼
LLM 判断某个 skill 相关
  │
  ▼
调用 read_skill
  │
  ▼
AgentToolNode 返回完整 SKILL.md
  │
  ▼
下一轮模型调用
  │
  ├─ SkillsInterceptor 识别历史 read_skill 调用
  └─ 动态添加该 skill 对应的工具
```

[`SkillsInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/skills/SkillsInterceptor.java)
会扫描历史 `read_skill` ToolCall，并将下面两类工具加入
`dynamicToolCallbacks`：

- Java 配置的 `groupedTools`
- Skill frontmatter 中 `allowed_tools` 解析出的工具

动态工具随后由 `AgentLlmNode` 写入 `RunnableConfig.context()`，再由
`AgentToolNode` 解析执行。

注意：

- `allowed_tools` 当前表示加载 Skill 后额外开放的工具，不是安全白名单；
- `disable_skill` 只在当前 Registry 实例中隐藏 Skill，不删除任何文件。

## 11. Graph Runtime

### 11.1 StateGraph：声明图

[`StateGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/StateGraph.java)
提供：

- `addNode`
- `addEdge`
- `addConditionalEdges`
- `addParallelConditionalEdges`
- 添加 StateGraph/CompiledGraph 子图
- `compile`

一个普通节点读取 `OverAllState`，返回局部状态更新：

```java
Map<String, Object> apply(OverAllState state)
```

节点不决定如何合并状态，对应 key 的 `KeyStrategy` 决定合并行为。

### 11.2 OverAllState：共享数据总线

[`OverAllState`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/OverAllState.java)
包含：

```text
data          : Map<String, Object>
keyStrategies : Map<String, KeyStrategy>
```

内置状态合并策略：

- `REPLACE`
- `APPEND`
- `MERGE`

没有显式策略的 key 默认使用 `REPLACE`。Agent、Tool、Hook、Checkpoint 和子图都
通过这份状态通信，而不是互相持有业务引用。

`OverAllState` 自身不是线程安全的，并行代码必须使用隔离的更新 Map 或外部同步。

### 11.3 CompiledGraph：编译

`StateGraph.compile()` 会创建 `CompiledGraph`，编译阶段负责：

- 校验 START 入口、节点和边；
- 编译普通、条件和并行路由；
- 编译嵌套子图；
- 汇总父子图的 KeyStrategy；
- 应用中断点；
- 配置 CheckpointSaver；
- 设置 recursion limit。

### 11.4 GraphRunner：执行

运行流程如下：

```text
加载初始状态或 Checkpoint
          │
          ▼
解析 START 的下一节点
          │
          ▼
执行节点 action
          │
          ▼
合并节点返回的局部状态
          │
          ▼
保存 Checkpoint
          │
          ▼
计算普通边、条件边或并行边
          │
          └──────────────► 下一节点 / END
```

主调度位于
[`MainGraphExecutor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/executor/MainGraphExecutor.java)，
节点执行位于
[`NodeExecutor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/executor/NodeExecutor.java)。

运行时基于 Reactor `Flux`，普通结果、模型流、工具流、并行流和子图流可以进入同一
执行管线。

## 12. 当前源码中的注意事项

### 12.1 默认 ReAct 循环上限很大

`Builder.buildConfig()` 默认把 `recursionLimit` 设置为 `Integer.MAX_VALUE`。生产环境
应使用以下至少一种限制：

- `ModelCallLimitHook`
- `ToolCallLimitHook`
- 自定义 `CompileConfig.recursionLimit`

否则错误的模型或工具组合可能持续循环。

### 12.2 returnDirect 依赖 Hook

`AgentToolNode` 会把所有工具的 `returnDirect` 信息写入 `ToolResponseMessage` metadata，
但 `ReactAgent.makeToolsToModelEdge()` 中直接处理它的代码仍标记为 `FIXME`。

需要可靠地从工具结果直接结束 Agent 时，应显式添加 `ReturnDirectModelHook`。该 Hook
在 `beforeModel` 阶段读取 metadata，将工具响应转换为 `AssistantMessage`，然后跳到
END。

### 12.3 顺序与并行工具状态语义不同

- 顺序模式：直接 `Map.putAll()`，last-write-wins；
- 并行模式：通过 `ToolStateCollector` 按 `KeyStrategy` 合并。

设计工具状态 key 时不能假设两种模式的冲突行为完全一致。

### 12.4 Hook 和 Interceptor 不可互换

需要 Checkpoint、状态跳转、HITL 或提前结束时使用 Hook；模型重试、Prompt 修改、
动态工具和工具错误处理更适合 Interceptor。

## 13. 推荐阅读顺序

1. `StateGraph`：理解节点、边、条件路由和子图。
2. `OverAllState`：理解状态以及 `KeyStrategy`。
3. `ReactAgent.initGraph()`：观察 ReAct 如何变成图。
4. `AgentLlmNode.apply()`：理解模型调用和 tool schema。
5. `AgentToolNode.apply()`：理解工具执行、并发、超时和状态注入。
6. `SequentialGraphBuildingStrategy`：理解最简单的 Agent 子图组合。
7. `ParallelGraphBuildingStrategy` 和 `RoutingGraphBuildingStrategy`。
8. `SkillsAgentHook` 与 `SkillsInterceptor`：理解 Hook、Interceptor 和动态工具协作。
9. `MainGraphExecutor` 与 `NodeExecutor`：深入流式执行、中断和 Checkpoint。

## 14. 一句话总结

> Graph 提供执行骨架，ReactAgent 用 Graph 实现 Reason/Act 循环，ToolCallback 提供
> 行动能力，Hook 和 Interceptor 提供横切扩展，Skills 做按需上下文与工具披露，
> Multi-Agent 则通过子图或 Agent-as-Tool 组合这些能力。
