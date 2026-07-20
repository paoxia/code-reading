# Multi-Agent 实现

> 源码版本：`spring-ai-alibaba/main@84ca19a12`

## 1. 结论

Spring AI Alibaba 没有把 Multi-Agent 固定为一种“Supervisor 调多个 Worker”的实现，
而是提供了四种不同的组合机制：

| 机制 | 控制权 | 子 Agent 形态 | 适用场景 |
|---|---|---|---|
| FlowAgent | 图结构决定 | StateGraph 子图 | 固定编排、并行、循环、路由 |
| AgentTool | 父 Agent 的 LLM 决定 | ToolCallback | Supervisor/专家委派 |
| Task/SubAgent | 父 Agent 的 LLM 决定 | 通用 task 工具背后的 Agent | 上下文隔离、后台任务 |
| Handoff | 父图状态和条件边决定 | 父 StateGraph 中的节点 | Agent 间转交对话控制权 |

这几种模式最终都建立在 Graph Runtime 和 `ReactAgent` 之上，但它们共享上下文、
选择执行者和返回结果的方式不同。

## 2. 公共抽象

### 2.1 Agent

所有 Agent 的共同基类是
[`Agent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/Agent.java)。

它主要负责：

- Agent 的 `name` 和 `description`；
- 延迟创建 `StateGraph`；
- 线程安全地延迟编译 `CompiledGraph`；
- `invoke`、`stream` 和 `streamMessages` 等统一入口；
- 把输入转换为 `messages` 和 `input` 两个状态 key；
- 配置 Agent 名称、流式标识和并行 Executor 等运行时 metadata。

`description` 不只是文档。当 Agent 被包装为工具或交给路由模型时，它会成为模型
选择 Agent 的重要依据。

### 2.2 BaseAgent

[`BaseAgent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/BaseAgent.java)
在 `Agent` 上增加：

- `inputSchema/inputType`
- `outputSchema/outputType`
- `outputKey/outputKeyStrategy`
- `includeContents`
- `returnReasoningContents`
- `asNode()`

`ReactAgent` 继承自 `BaseAgent`，因此既能独立运行，也能变成另一个图中的节点。

### 2.3 FlowAgent

[`FlowAgent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/agent/FlowAgent.java)
是组合 Agent 的基类，持有：

- `subAgents`
- `CompileConfig`
- `StateSerializer`
- Executor
- Hooks

它把具体建图工作委托给
[`FlowGraphBuilder`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/builder/FlowGraphBuilder.java)
和不同的 `FlowGraphBuildingStrategy`。

这是 Strategy + Template Method 的组合：

```text
FlowAgent.initGraph()
  │
  ▼
FlowGraphBuilder.buildGraph(strategyType, config)
  │
  ▼
FlowGraphBuildingStrategyRegistry
  │
  ├─ SequentialGraphBuildingStrategy
  ├─ ParallelGraphBuildingStrategy
  ├─ LoopGraphBuildingStrategy
  └─ RoutingGraphBuildingStrategy
```

公共建图模板位于
[`AbstractFlowGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/AbstractFlowGraphBuildingStrategy.java)，
负责创建图、分类 Hook、添加 Hook 节点、确定入口/出口；具体策略只构建核心拓扑。

## 3. Agent 如何成为子图节点

### 3.1 ReactAgent.asNode()

[`ReactAgent.asNode()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)
会：

1. 延迟编译自己的 `CompiledGraph`；
2. 创建 `AgentSubGraphNode`；
3. 通过 `AgentToSubCompiledGraphNodeAdapter` 启动子图；
4. 把子图的最终更新映射回父图状态。

关键配置：

- `includeContents=true`：父图消息一起传给子 Agent；
- `includeContents=false`：进入子图前移除父级 `messages`；
- `returnReasoningContents=true`：向父图返回子 Agent 的完整新增消息；
- `returnReasoningContents=false`：通常只向父图返回最后一条消息。

适配器会从最终子图结果中移除父图本来就有的消息，避免重复追加。

### 3.2 子图 RunnableConfig

子图运行时会清理：

- `checkPointId`
- `nextNode`
- 临时 context

并写入 `_AGENT_` metadata，让流式输出知道当前来自哪个 Agent。

当父图和子图使用同一个 CheckpointSaver 实例时，子图 thread ID 被改写为：

```text
父 threadId + "_" + subGraphId
```

这样父子图可以共享 Saver，但不会写入同一个 Checkpoint 命名空间。

### 3.3 FlowGraphBuildingStrategy.addSubAgentNode()

[`FlowGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/FlowGraphBuildingStrategy.java)
按照子 Agent 类型选择包装方式：

```text
FlowAgent → SubCompiledGraphNode(flowAgent.getAndCompileGraph())
BaseAgent → baseAgent.asNode(...)
其他类型 → 拒绝
```

因此 FlowAgent 可以嵌套 FlowAgent，也可以嵌套 ReactAgent。

## 4. SequentialAgent

[`SequentialAgent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/agent/SequentialAgent.java)
构建线性流水线：

```text
START
  │
  ▼
beforeAgent hooks
  │
  ▼
flow transparent node
  │
  ▼
agent1 → agent2 → agent3
  │
  ▼
afterAgent hooks
  │
  ▼
END
```

核心策略见
[`SequentialGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/SequentialGraphBuildingStrategy.java)。

数据传递依赖共享 `OverAllState`：

- `messages` 通常使用 AppendStrategy；
- 子 Agent 的 `outputKey` 默认使用 ReplaceStrategy；
- 下游 Agent 可以从状态读取前序输出；
- `instruction` 可以引用状态 key，形成模板化任务。

适合：翻译 → 审校 → 总结、提取 → 分析 → 生成等固定步骤。

不适合：需要模型动态决定下一位专家的场景。

## 5. ParallelAgent

[`ParallelAgent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/agent/ParallelAgent.java)
实现 Fan-Out/Gather：

```text
                  ┌─ agent1 ─┐
START → fan-out ──├─ agent2 ─┼──► aggregator → END
                  └─ agent3 ─┘
```

建图策略见
[`ParallelGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/ParallelGraphBuildingStrategy.java)。

### 5.1 构建约束

- 至少两个子 Agent；
- 最多十个子 Agent；
- 子 Agent 必须是 `BaseAgent`；
- ReactAgent 子节点应提供唯一 `outputKey`；
- `maxConcurrency` 为空表示不额外限制，否则必须大于等于 1。

唯一 `outputKey` 很重要，因为多个并行节点写同一个 ReplaceStrategy key 时会发生
冲突，结果还可能受到完成顺序影响。

### 5.2 聚合

`EnhancedParallelResultAggregator` 读取各子 Agent 的输出 key，再交给
`ParallelAgent.MergeStrategy`：

- `DefaultMergeStrategy`：返回 Map；
- `ListMergeStrategy`：返回结果 List；
- `ConcatenationMergeStrategy`：拼接字符串；
- 用户自定义策略。

`mergeOutputKey` 决定聚合结果写回哪个状态 key。

### 5.3 并发控制

`ParallelAgent` 会把 `maxConcurrency` 写入 `RunnableConfig` metadata，底层
`ParallelNode` 从 metadata 获取限制。Executor 可以在 Agent builder 或
RunnableConfig 中配置。

## 6. LoopAgent

[`LoopAgent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/agent/LoopAgent.java)
只允许一个子 Agent：

```text
root transparent node
        │
        ▼
    loopInit
        │
        ▼
   loopDispatch
     │      │
 continue  break
     │      └──────────────► END
     ▼
 beforeModel hooks
     │
     ▼
  subAgent
     │
     ▼
 afterModel hooks
     │
     └─────────────────────► loopDispatch
```

核心策略见
[`LoopGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/LoopGraphBuildingStrategy.java)。

Hook 语义经过特别处理：

- `beforeAgent/afterAgent`：整个循环只执行一次；
- `beforeModel/afterModel`：每轮循环执行一次。

内置 LoopStrategy 包括：

- `CountLoopStrategy`：固定次数；
- `ConditionLoopStrategy`：按条件决定结束；
- `ArrayLoopStrategy`：遍历 JSON 数组；
- 自定义 `LoopStrategy`。

LoopStrategy 使用临时状态 key 保存循环下标、当前元素和 continue/break 标记，这些
key 会注册 ReplaceStrategy。

## 7. LlmRoutingAgent

[`LlmRoutingAgent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/agent/LlmRoutingAgent.java)
使用一个独立 `ChatModel` 选择子 Agent：

```text
root
  │
  ▼
beforeModel hooks
  │
  ▼
RoutingNode ── LLM 选择一个或多个 Agent
  │
  ▼
afterModel hooks
  │
  ├─ agent A ─┐
  ├─ agent B ─┼─► RoutingMergeNode ─► END
  └─ agent C ─┘
```

核心策略见
[`RoutingGraphBuildingStrategy`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/flow/strategy/RoutingGraphBuildingStrategy.java)。

实现重点：

- `RoutingNode` 根据子 Agent 名称、description 和输入做选择；
- 使用 `addParallelConditionalEdges`，因此一次可以选择多个 Agent；
- 每个被选 Agent 执行后汇入 `RoutingMergeNode`；
- MergeNode 再调用模型综合多个专家结果；
- 合并结果 key 使用 ReplaceStrategy。

这和 Supervisor 的区别是：RoutingAgent 把“路由”和“结果综合”固化在图结构中；
Supervisor 则让主 ReactAgent 在自己的多轮 ReAct 中自由决定何时调用哪个 AgentTool。

## 8. Agent-as-Tool：Supervisor

[`AgentTool`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/AgentTool.java)
把 ReactAgent 转换为 `MethodToolCallback`。

### 8.1 ToolDefinition

生成的 ToolDefinition 使用：

- 工具名：`agent.name()`；
- 描述：`agent.description()`；
- 输入 schema：来自 `inputSchema` 或 `inputType`；
- 原始 schema 被包装在顶层 `input` 属性中。

因此 Agent 的名称、描述和输入 schema 会直接影响父模型能否正确选择和调用它。

### 8.2 调用流程

```text
父 ReactAgent
  │
  ▼
LLM 生成子 Agent 对应的 ToolCall
  │
  ▼
父 AgentToolNode
  │
  ▼
AgentToolExecutor.executeAgent()
  │
  ├─ 解析 {"input": ...}
  ├─ 创建子 Agent 消息
  ├─ 构造隔离的子 RunnableConfig
  └─ childAgent.invoke(...)
          │
          ▼
返回子 Agent 最后的 AssistantMessage
```

父 Agent 将子 Agent 的最终回答视为普通工具结果，随后可以继续推理、调用另一个
AgentTool，或生成最终回复。

参考示例：
[`SupervisorConfig`](../../code/spring-ai-alibaba/examples/multiagent-patterns/supervisor/src/main/java/com/alibaba/cloud/ai/examples/multiagents/supervisor/SupervisorConfig.java)。

## 9. Task/SubAgent 模式

项目中同时存在两条相关路径：

- [`SubAgentInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/extension/interceptor/SubAgentInterceptor.java)：通过 ModelInterceptor 提供统一 `task` 工具和子 Agent 使用说明；
- `TaskToolsBuilder`：根据 Java 配置或 Markdown Agent 描述构建 Task/TaskOutput 工具。

与每个 Agent 一个 ToolDefinition 的 AgentTool 不同，Task 模式通常暴露一个统一入口：

```text
task(
  subagent_type,
  description,
  prompt,
  run_in_background
)
```

主 Agent 的职责是写清楚任务，而不是把整个主线程消息复制给子 Agent。这可以：

- 减少主上下文膨胀；
- 隔离大量搜索或研究细节；
- 同时启动多个独立后台任务；
- 通过 TaskOutput 在稍后收集结果。

示例见
[`SubagentConfig`](../../code/spring-ai-alibaba/examples/multiagent-patterns/subagent/src/main/java/com/alibaba/cloud/ai/examples/multiagents/subagent/SubagentConfig.java)。

## 10. Handoff 模式

Handoff 把多个 Agent 都添加为父 StateGraph 节点：

```text
START
  │ active_agent
  ├────────────► sales_agent
  │                 │ transfer_to_support
  │                 ▼
  └────────────► support_agent
                    │ transfer_to_sales
                    └────────────────────► sales_agent
```

Transfer 工具不负责直接调用另一个 Agent，而是修改 `active_agent` 等共享状态。
当前 Agent 结束后，父图条件边读取状态并选择下一节点。

这种模式的特点是：

- 控制权真的从一个 Agent 节点转移到另一个节点；
- 会话状态由父图统一管理；
- 路由规则显式可见；
- 适合销售转客服、分诊、审批等角色接管场景。

示例见
[`MultiAgentHandoffsConfig`](../../code/spring-ai-alibaba/examples/multiagent-patterns/handoffs-multiagent/src/main/java/com/alibaba/cloud/ai/examples/multiagents/handoffs/MultiAgentHandoffsConfig.java)。

## 11. 状态与上下文边界

不同模式最容易混淆的是上下文边界：

| 模式 | 输入上下文 | 输出如何返回 |
|---|---|---|
| Sequential/Parallel/Loop | 父图共享状态，可配置是否包含 messages | 写入共享状态/outputKey |
| LlmRoutingAgent | 父图输入分发到选中的子图 | MergeNode 综合 |
| AgentTool | 父 Agent 把一个明确 input 传给子 Agent | 最终 AssistantMessage 作为工具结果 |
| Task/SubAgent | 主 Agent 生成独立任务说明 | Task/TaskOutput 返回结果 |
| Handoff | 父图统一保存会话状态 | 下一 Agent 继续处理共享状态 |

选择模式时，先决定“是否共享完整消息历史”，再决定“由图还是 LLM 选择下一个
Agent”，通常比先挑类名更清晰。

## 12. 注意事项

### 12.1 outputKey 是多 Agent 数据协议

在 FlowAgent 中，`outputKey` 不只是返回值配置，也是子 Agent 之间的数据协议。
尤其在 ParallelAgent 中必须保持唯一，并为聚合结果单独设置 `mergeOutputKey`。

### 12.2 子 Agent 不应依赖隐式上下文

AgentTool 和 Task/SubAgent 都可能只向子 Agent 传递一个重新构造的 input。子 Agent
Prompt 应明确任务、输入格式和返回格式，不要假设它能看到父 Agent 的全部消息。

### 12.3 嵌套 Checkpoint 需要 thread ID 隔离

共享同一个 Saver 时必须避免父子图使用完全相同的 thread ID。ReactAgent 子图适配器
和 AgentTool 已经采用后缀方式隔离；自定义嵌套调用也应采用同样原则。

### 12.4 LLM 路由需要可靠 description

RoutingAgent、Supervisor 和 Task 模式都依赖 Agent description。描述应说明：

- 能做什么；
- 什么时候应该调用；
- 输入需要包含什么；
- 哪些任务不适合它。

### 12.5 固定编排和自主编排不要混为一谈

- FlowAgent 更确定、可预测、便于审计；
- AgentTool/Task 更灵活，但选择质量依赖模型；
- Handoff 介于两者之间：Agent 可以触发转交，但转交后的拓扑由父图约束。

## 13. 推荐阅读顺序

1. `Agent` 和 `BaseAgent`：统一 API。
2. `ReactAgent.asNode()`：Agent 如何变成子图。
3. `FlowGraphBuildingStrategy.addSubAgentNode()`：子 Agent 包装规则。
4. `SequentialGraphBuildingStrategy`：最简单的组合。
5. `ParallelGraphBuildingStrategy`：Fan-Out/Gather 和结果聚合。
6. `LoopGraphBuildingStrategy`：循环状态和 Hook 位置。
7. `RoutingGraphBuildingStrategy`、`RoutingNode`、`RoutingMergeNode`。
8. `AgentTool`：Agent-as-Tool。
9. `SubAgentInterceptor` 和 subagent 示例。
10. handoffs 示例：理解父图状态路由。

