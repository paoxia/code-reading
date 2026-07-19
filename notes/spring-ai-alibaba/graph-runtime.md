# Spring AI Alibaba Graph 运行时源码笔记

> 源码基线：`code/spring-ai-alibaba/main@84ca19a12`  
> 本文关注 `spring-ai-alibaba-graph-core`：图如何声明、编译、执行、合并状态、保存检查点，以及中断后如何恢复。

## 1. 先说结论

Graph 不是只服务于 `ReactAgent` 的流程图工具，而是 Spring AI Alibaba Agent Framework 的通用运行时内核：

- `StateGraph` 负责声明节点、边、条件分支、并行分支和子图；
- `CompiledGraph` 把声明式图编译为可以执行的结构；
- `OverAllState` 保存跨节点流转的数据，并通过 `KeyStrategy` 决定每个字段怎样合并；
- `GraphRunnerContext` 保存一次运行的临时上下文；
- `MainGraphExecutor` 与 `NodeExecutor` 驱动节点执行、状态合并、路由和流式输出；
- `BaseCheckpointSaver`、中断点和 `RunnableConfig` 共同支撑 Human-in-the-loop 与断点续跑。

`ReactAgent` 本质上也是一张由 model、tool 和 hook 节点组成的 `StateGraph`。

## 2. 核心对象分层

| 层次 | 核心类 | 职责 |
| --- | --- | --- |
| 图声明 | [`StateGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/StateGraph.java) | 添加节点、普通边、条件边、并行边和子图 |
| 编译配置 | [`CompileConfig`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompileConfig.java) | checkpoint、中断点、最大迭代次数等固定配置 |
| 编译结果 | [`CompiledGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompiledGraph.java) | 校验图，创建运行入口，提供 invoke、stream、状态查询等 API |
| 业务状态 | [`OverAllState`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/OverAllState.java) | 保存节点之间传递的数据，并按策略合并更新 |
| 单次运行配置 | [`RunnableConfig`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/RunnableConfig.java) | threadId、checkpointId、context、metadata、streamMode、executor 等 |
| 运行上下文 | [`GraphRunnerContext`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/GraphRunnerContext.java) | 将编译图、状态、当前节点、配置、迭代计数等组织到一次运行中 |
| 主调度器 | [`MainGraphExecutor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/executor/MainGraphExecutor.java) | 判断开始、结束、中断和递归上限，调度当前节点 |
| 节点执行器 | [`NodeExecutor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/executor/NodeExecutor.java) | 执行 action、消费流、更新状态、计算下一节点并保存 checkpoint |

可以把它理解为：

```text
StateGraph --compile--> CompiledGraph
                             |
                             v
input + RunnableConfig -> GraphRunnerContext
                             |
                             v
                       MainGraphExecutor
                             |
                             v
                        NodeExecutor
                             |
                 action -> state -> edge -> next
```

## 3. StateGraph：声明一张有状态图

[`StateGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/StateGraph.java) 使用两个特殊节点标记图的边界：

- `START`：入口；
- `END`：终点。

典型声明过程如下：

```java
StateGraph graph = new StateGraph("demo", keyStrategyFactory)
    .addNode("model", modelNode)
    .addNode("tools", toolNode)
    .addEdge(StateGraph.START, "model")
    .addConditionalEdges("model", route, mappings)
    .addEdge("tools", "model");

CompiledGraph compiledGraph = graph.compile(compileConfig);
```

### 3.1 节点只返回局部状态

节点 action 通常不需要返回完整状态，而是返回一个 `Map<String, Object>`，表示本节点产生的增量。Graph 再根据每个 key 的 `KeyStrategy` 合并到 `OverAllState`。

这意味着节点之间主要通过“状态字段协议”解耦：节点不一定直接依赖另一个节点的 Java 类型，但必须对字段名和字段值结构达成一致。

### 3.2 边决定控制流

Graph 支持几类控制关系：

- 固定边：执行完节点后直接进入指定节点；
- 条件边：根据当前状态计算路由结果，再映射到目标节点；
- 并行边：从一个节点派生多个分支，之后汇总；
- 子图节点：把另一张 `StateGraph` 或 `CompiledGraph` 当作当前图中的一个节点。

ReAct 的循环就是一个条件边示例：model 输出 tool call 时进入 tools，否则结束；tools 执行完后再回到 model。

## 4. OverAllState：数据流的中心

[`OverAllState`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/OverAllState.java) 内部主要保存：

- 当前状态数据；
- 各字段对应的 `KeyStrategy`；
- 输入与更新状态时所需的辅助信息。

### 4.1 为什么需要 KeyStrategy

同一个增量对不同字段有不同语义：

| 字段类型 | 常见策略 | 含义 |
| --- | --- | --- |
| 当前输出、路由结果 | Replace | 新值替换旧值 |
| 消息列表、执行轨迹 | Append | 把新元素追加到历史数据 |
| Map 或可组合对象 | Merge/自定义策略 | 按业务规则合并 |

策略由 [`KeyStrategyFactory`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/KeyStrategyFactory.java) 提供。没有为 key 配置特殊策略时，应确认默认替换行为是否符合预期。

消息历史是最典型的 Append 状态。Agent hook 如果要整体重写消息列表，会使用 `ReplaceAllWith` 这样的控制值显式覆盖，而不是继续追加。

### 4.2 状态合并发生在哪里

节点 action 先计算局部结果，随后 `NodeExecutor` 调用状态更新逻辑。更新过程不是简单的 `Map.putAll`，而是逐 key 查找合并策略。

因此，排查“数据为什么被覆盖”“消息为什么重复”时，不能只看节点返回值，还要同时检查该 key 的策略声明。

### 4.3 并发边界

`OverAllState` 自身不是一个可以任意并发写入的通用线程安全容器。并行分支应当由 Graph 的并行执行与汇总机制管理，而不是让多个业务线程直接修改同一个实例。

## 5. 编译：从声明结构到可运行图

调用 [`StateGraph.compile`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/StateGraph.java) 后得到 [`CompiledGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompiledGraph.java)。编译阶段主要完成：

1. 校验节点和边的引用是否合法；
2. 处理普通节点、并行节点和子图节点；
3. 固化 checkpoint、中断点和递归上限等编译配置；
4. 准备执行时需要的节点工厂和边工厂。

编译结果可以多次运行；每次运行自己的输入、threadId、context 等信息则由 `RunnableConfig` 提供。

## 6. CompileConfig 与 RunnableConfig 不要混用

两个配置的生命周期不同：

### 6.1 CompileConfig：图级固定能力

[`CompileConfig`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompileConfig.java) 适合配置：

- checkpoint saver；
- 哪些节点执行前中断；
- 哪些节点执行后中断；
- 最大递归或迭代次数。

它随图的编译结果存在，不应承载某次用户请求的业务数据。

### 6.2 RunnableConfig：本次执行参数

[`RunnableConfig`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/RunnableConfig.java) 适合配置：

- `threadId` 与 `checkpointId`；
- 下一节点与中断节点信息；
- `StreamMode`；
- metadata；
- context；
- 节点和流程执行器。

Agent 的动态 tool、子 Agent 调用所需参数等运行期对象，也会通过 `RunnableConfig.context()` 传递。

## 7. 一次执行的完整链路

`CompiledGraph.stream(...)` 或 `invoke(...)` 最终进入相同的执行内核。整体过程可以简化为：

```text
CompiledGraph.stream(input, config)
  -> 创建或恢复 OverAllState
  -> GraphRunner 创建 GraphRunnerContext
  -> MainGraphExecutor.execute(context)
       -> 判断 END / 中断 / 最大迭代次数
       -> NodeExecutor.execute(context)
            -> 找到当前节点 action
            -> action.apply(state, config)
            -> 处理普通结果或 Flux 结果
            -> 按 KeyStrategy 合并状态
            -> 根据边计算 nextNode
            -> 保存 checkpoint
            -> 产生 GraphResponse
       -> 继续调度 nextNode
```

### 7.1 MainGraphExecutor：控制图是否继续

[`MainGraphExecutor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/executor/MainGraphExecutor.java) 位于外层，主要负责：

- 识别图的起点和终点；
- 检查是否达到最大迭代次数；
- 检查编译配置中的中断条件；
- 把当前节点交给 `NodeExecutor`；
- 节点完成后继续拼接下一次执行。

其响应式实现通过延迟创建和流拼接推进流程，因此 `stream` 是底层形态，`invoke` 可以看作等待流执行完成并取得最终结果的便捷入口。

### 7.2 NodeExecutor：完成一个节点事务

[`NodeExecutor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/executor/NodeExecutor.java) 承担一次节点执行的关键步骤：

1. 从上下文取得当前节点；
2. 获取对应 action；
3. 处理 action 自身声明的可中断逻辑；
4. 执行 action；
5. 识别普通结果、嵌套 `Flux`、Graph 流或并行 Graph 流；
6. 合并节点输出到全局状态；
7. 依据出边计算下一节点；
8. 按需要保存 checkpoint；
9. 发出本步响应并回到主调度器。

“执行节点”和“选择下一节点”是分开的：action 负责数据计算，edge 负责控制流计算。

## 8. 流式执行

Graph 的执行 API 建立在 Reactor `Flux` 上。流里不仅可能有节点最终结果，也可能包含节点内部产生的流式片段。

例如 LLM 节点可以持续产生 token 或部分响应；`NodeExecutor` 识别嵌套流后，将其展开到整张图的输出流里。节点最终完成时，再合并完整的状态更新并进入后继节点。

`RunnableConfig` 中的 `StreamMode` 用来控制调用者看到的是状态值还是更完整的快照语义。业务方消费流时，要区分：

- 中间流式事件；
- 节点完成后的状态事件；
- 图结束、错误或中断事件。

不要把收到的每个事件都当成最终 Agent 答案。

## 9. 条件路由与并行执行

### 9.1 条件路由

条件边读取最新状态，返回一个路由标识，再通过 mapping 找到实际节点。它适合表达：

- ReAct 中 model 到 tools 或 END；
- Router Agent 按任务类型选择子 Agent；
- 审批、人机确认等业务分支。

路由返回值必须与 mapping 一致。新增分支时，应同时检查路由函数和映射表，否则错误通常只会在运行到该分支时暴露。

### 9.2 并行分支

并行节点让多个 action 基于约定的输入状态执行，框架再收集各分支结果并合并。最终结果仍受 `KeyStrategy` 约束：多个分支写同一个 Replace key 时，含义往往不明确；写 Append 或专门的聚合 key 更安全。

并行执行提高吞吐，但不等于业务状态可以无规则共享。分支输入、输出 key 和聚合策略应当显式设计。

## 10. 子图

Graph 可以把另一张图当作节点。子图是 Multi-Agent 的重要基础：[`ReactAgent.asNode`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java) 就能将一个 Agent 转换为父图节点。

子图执行时应关注三类边界：

- 输入映射：父图的哪些字段作为子图输入；
- 输出映射：子图结果写回父图的哪些字段；
- 运行配置：context、threadId、checkpoint 命名空间等如何继承或隔离。

如果多个子 Agent 共用 `messages` 等 key，又没有清晰的输入输出转换，父图很容易累积无关上下文。

## 11. Checkpoint：保存与恢复执行状态

配置 checkpoint saver 后，Graph 可以在节点边界保存状态和执行位置。一次会话通常用 `RunnableConfig.threadId()` 标识，具体历史版本可以再用 checkpointId 定位。

恢复时，运行时需要组合：

- 已保存的状态；
- checkpoint 记录的下一节点或中断位置；
- 本次新输入；
- 本次 `RunnableConfig`。

[`CompiledGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompiledGraph.java) 还提供状态读取、状态历史和状态更新相关能力，便于查看或修改挂起会话。

Checkpoint 适合保存可序列化、可恢复的业务状态。数据库连接、回调对象、动态 tool 实例等运行期依赖更适合放入 `RunnableConfig.context()`，恢复执行时重新注入。

## 12. 中断与 Human-in-the-loop

中断有两种主要来源：

1. 编译时配置某节点执行前或执行后中断；
2. 节点 action 自己实现可中断协议，根据状态动态决定是否暂停。

发生中断时，GraphResponse 会携带中断信息，checkpoint 保存当前状态和后续位置。调用方取得人工反馈后，再用相同 threadId 和适当的恢复配置继续执行。

因此 Human-in-the-loop 不是“阻塞线程等待用户输入”，而是：

```text
运行 -> 持久化状态 -> 返回中断结果
用户处理
新请求 -> 载入状态 -> 从断点继续
```

这更适合 Web 服务和长时间业务流程。

## 13. GraphRunnerContext：一次运行的临时控制面

[`GraphRunnerContext`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/GraphRunnerContext.java) 把执行器需要的信息收拢到一个对象中，包括当前状态、运行配置、当前/下一节点、图结构和迭代信息等。

它与 `OverAllState` 的区别是：

- `OverAllState` 是节点之间共享的业务数据面；
- `GraphRunnerContext` 是执行引擎使用的控制面。

业务节点通常读取 state 和 RunnableConfig，不应直接修改调度器内部的控制字段。

## 14. ReactAgent 如何映射到 Graph

| ReactAgent 概念 | Graph 对应物 |
| --- | --- |
| `agent_model` | LLM action 节点 |
| `agent_tool` | ToolNode action 节点 |
| AgentHook | model/tool 前后的附加节点 |
| model 是否产生 tool call | 条件边的路由依据 |
| tool 执行后继续推理 | `agent_tool -> agent_model` 回边 |
| messages | 使用 AppendStrategy 的共享状态 |
| outputKey | 通常使用 ReplaceStrategy 的最终输出状态 |
| `ReactAgent.asNode()` | 将 Agent 的 CompiledGraph 包装为父图节点 |
| recursionLimit | Agent 循环的最大执行保护 |

ReactAgent 的最小拓扑可以表示为：

```text
START -> agent_model
             |
       has tool calls?
          /       \
        yes        no
         |          |
    agent_tool     END
         |
         +------> agent_model
```

相关实现见 [`ReactAgent.initGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)。

## 15. 容易踩坑的地方

### 15.1 忘记为累计字段设置策略

节点返回列表不代表框架必然追加。消息、轨迹、多个分支结果等累计字段需要明确的 Append 或自定义策略。

### 15.2 Replace 字段被并行分支同时写入

这种行为通常缺乏稳定的业务含义。最好让分支写不同 key，之后由单独的聚合节点归并。

### 15.3 把不可持久化对象放入状态

一旦启用 checkpoint，状态最好是可序列化数据。运行期服务对象应放在 config context 中，并在每次恢复时重建。

### 15.4 忽略循环上限

通用 Graph 的 `CompileConfig` 有默认递归限制；ReactAgent builder 会把限制设置得非常大。生产环境应结合模型、工具和业务流程配置显式的停止条件，避免无限的 model-tool 循环。

### 15.5 把 invoke 当成不同的执行模型

同步调用只是对响应式执行结果的封装。遇到卡住、超时或流式事件顺序问题时，应沿 `CompiledGraph -> GraphRunner -> MainGraphExecutor -> NodeExecutor` 这条链路排查。

### 15.6 子图共享字段过多

子图可以复用父状态，但便利也会扩大耦合。Multi-Agent 场景最好明确每个 Agent 的输入、输出和共享字段，而不是默认共享全部消息。

## 16. 推荐源码阅读顺序

1. [`StateGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/StateGraph.java)：先理解图能声明什么；
2. [`OverAllState`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/OverAllState.java)：理解数据怎样更新；
3. [`CompileConfig`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompileConfig.java) 与 [`RunnableConfig`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/RunnableConfig.java)：区分图级和请求级配置；
4. [`CompiledGraph`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompiledGraph.java)：找到公开执行入口；
5. [`MainGraphExecutor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/executor/MainGraphExecutor.java)：理解循环与停止；
6. [`NodeExecutor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/executor/NodeExecutor.java)：串起 action、state、edge、checkpoint 和 stream；
7. [`ReactAgent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)：回到真实 Agent 看 Graph 如何被组装。

## 17. 一句话总结

Spring AI Alibaba Graph 的关键思想是：**节点只生产状态增量，KeyStrategy 定义数据合并，边定义下一步控制流，执行器围绕这两件事提供流式执行、并行、子图、checkpoint 与中断恢复能力。**
