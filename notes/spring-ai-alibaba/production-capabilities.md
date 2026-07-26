# 生产运行能力：横切扩展、持久化、可观测性与 A2A

## 1. 研究范围

- 源码版本：`84ca19a1296f`
- Maven `revision`：`1.1.2.2`
- 研究范围：Agent Hook/Interceptor、Graph Checkpoint 与长期 Store、Micrometer
  Observation、A2A 远端 Agent 与 Nacos Starter

本文从仓库外的旧笔记中筛选出当前笔记尚未系统覆盖的主题，再以本地源码重新核对。
旧笔记中的文件数量、行号和“已完整支持”等结论没有直接沿用。

## 2. 总体结论

Spring AI Alibaba 的生产运行能力不是一个独立模块，而是分布在四个层次：

```text
ReactAgent
  ├─ Hook：进入 StateGraph，参与状态更新、跳转、中断与恢复
  ├─ Interceptor：包装一次模型调用或工具调用
  └─ A2aRemoteAgent：把远端 Agent 适配为一个图节点

CompiledGraph
  ├─ CheckpointSaver：保存某个 thread 的执行历史和恢复位置
  ├─ Store：保存跨 thread、跨会话的长期结构化数据
  └─ Observation：Graph/Node 生命周期与 Micrometer 观测
```

| 能力 | 作用域 | 适合解决的问题 |
| --- | --- | --- |
| Hook | Graph 节点 | HITL、中断、调用次数限制、流程跳转、状态改写 |
| Model/Tool Interceptor | 单次调用 | 重试、fallback、错误归一化、动态工具、上下文裁剪 |
| CheckpointSaver | 单个 `threadId` 的执行历史 | 断点恢复、时间旅行、状态回放 |
| Store | 跨执行的命名空间数据 | 用户偏好、长期记忆、共享业务数据 |
| Observation | Graph/Node 执行过程 | 指标、追踪、输入输出诊断 |
| A2A | 进程或服务边界 | 将远端 Agent 纳入本地图编排 |

## 3. Hook 与 Interceptor：两个不同的扩展面

本节概括两类扩展面的生产用途；完整执行图、责任链顺序、示例和选型决策树见
[Hook 与 Interceptor：执行层级、调用链与选型](./hook-and-interceptor.md)。

### 3.1 Hook 属于图控制流

[`Hook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/Hook.java)
按 `BEFORE_AGENT`、`BEFORE_MODEL`、`AFTER_MODEL`、`AFTER_AGENT` 等位置转换成图节点。
因此 Hook 可以读取和更新 `OverAllState`，也可以返回跳转指令，并自然参与 Checkpoint
和中断恢复。

典型内置 Hook 包括：

- [`HumanInTheLoopHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/hip/HumanInTheLoopHook.java)：
  在工具执行前后引入人工决策；
- [`ModelCallLimitHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/modelcalllimit/ModelCallLimitHook.java)
  与
  [`ToolCallLimitHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/toolcalllimit/ToolCallLimitHook.java)：
  防止 Agent Loop 失控；
- [`SummarizationHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/summarization/SummarizationHook.java)：
  在模型调用前压缩消息；
- [`PIIDetectionHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/pii/PIIDetectionHook.java)：
  检测、阻断或脱敏敏感信息；
- [`ReturnDirectModelHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/returndirect/ReturnDirectModelHook.java)：
  让指定工具结果直接结束 Agent；
- [`SkillsAgentHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/skills/SkillsAgentHook.java)：
  管理 Skill 生命周期并注入相关工具。

### 3.2 Interceptor 属于单次调用

[`InterceptorChain`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/InterceptorChain.java)
分别构建 Model 与 Tool 责任链。第一个注册的 Interceptor 位于最外层，可以在调用前后
修改请求、响应或异常，但它本身不是一个 Graph 节点。

主要实现可以按职责分组：

| 职责 | 代表实现 |
| --- | --- |
| 模型可靠性 | [`ModelRetryInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/modelretry/ModelRetryInterceptor.java)、[`ModelFallbackInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/modelfallback/ModelFallbackInterceptor.java) |
| 工具可靠性 | [`ToolRetryInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/toolretry/ToolRetryInterceptor.java)、[`ToolErrorInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/toolerror/ToolErrorInterceptor.java) |
| 上下文治理 | [`ContextEditingInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/contextediting/ContextEditingInterceptor.java)、[`LargeResultEvictionInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/extension/interceptor/LargeResultEvictionInterceptor.java) |
| 动态能力 | [`ToolSelectionInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/toolselection/ToolSelectionInterceptor.java)、[`TodoListInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/todolist/TodoListInterceptor.java)、[`SubAgentInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/extension/interceptor/SubAgentInterceptor.java) |

选型原则很简单：需要改变图状态、跳转、中断或恢复时使用 Hook；只想包装一次模型或
工具调用时使用 Interceptor。两者可以协作，但不能因为都是“横切能力”就互相替代。

## 4. Checkpoint 与 Store：短期执行状态和长期记忆

### 4.1 CheckpointSaver 的职责

[`BaseCheckpointSaver`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/checkpoint/BaseCheckpointSaver.java)
定义四个核心操作：

- `list(config)`：列出一个执行线程的 Checkpoint；
- `get(config)`：按 `threadId`/`checkPointId` 取状态；
- `put(config, checkpoint)`：写入状态，并返回可能带新 Checkpoint ID 的配置；
- `release(config)`：释放当前线程的 Checkpoint，并返回不可变 `Tag` 快照。

[`CompiledGraph.getInitialState()`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompiledGraph.java)
会先从 Saver 载入状态，再按 KeyStrategy 合并本次输入。因此 Checkpoint 保存的不只是聊天
消息，还包括节点位置、下一节点以及所有可序列化图状态。

当前源码提供以下实现：

| 类型 | 实现 |
| --- | --- |
| 进程内 | `MemorySaver`、`VersionedMemorySaver` |
| 文件 | `FileSystemSaver` |
| JDBC | `H2Saver`、`MysqlSaver`、`PostgresSaver`、`OracleSaver` |
| NoSQL | `RedisSaver`、`MongoSaver` |

实现目录见
[`checkpoint/savers`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/checkpoint/savers)。
`CompileConfig` 默认注册的是 `MemorySaver`，所以默认具备进程内恢复能力，但进程退出后
不会持久化。

[`RunnableConfig`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/RunnableConfig.java)
还允许通过 `checkpointsNumRetained` 控制每个线程保留的最近 Checkpoint 数量。`metadata`
是单次执行的不可变环境信息，`context` 是节点间共享但明确不进入持久化的运行期对象；
连接、回调和动态 ToolCallback 应放入 `context`，不要塞进图状态。

### 4.2 `SaverConfig` 的当前限制

[`SaverConfig`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/checkpoint/config/SaverConfig.java)
内部允许注册多个 Saver，但 `CompileConfig.checkpointSaver()` 当前只调用无选择器的
`SaverConfig.get()`。当注册数量大于 1 时，`get()` 会直接抛出异常。

因此目前应把它理解为“配置一个活动 Saver”，不要把 `register()` 多次当成多后端复制、
故障转移或按请求路由机制。`getAll()` 在 Graph 主运行链中也没有被消费。

### 4.3 Store 的职责

[`Store`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/store/Store.java)
是另一条独立的长期存储抽象，使用分层 namespace 和 key 保存 `StoreItem`，提供 CRUD、
搜索、namespace 列举和分页。

```text
CheckpointSaver
  key = threadId + checkpointId
  value = 图执行状态与恢复位置

Store
  key = namespace[] + item key
  value = 跨会话结构化数据
```

当前实现有
[`MemoryStore`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/store/stores/MemoryStore.java)、
[`FileSystemStore`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/store/stores/FileSystemStore.java)、
[`DatabaseStore`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/store/stores/DatabaseStore.java)、
[`RedisStore`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/store/stores/RedisStore.java)
和
[`MongoStore`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/store/stores/MongoStore.java)。

`CompileConfig.store()` 将 Store 注入 `OverAllState`，节点可通过
[`OverAllState.getStore()`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/OverAllState.java)
访问。不要用 Store 代替 Checkpoint：Store 不记录“下一步执行哪个节点”，也不提供图恢复
语义。

## 5. 可观测性

### 5.1 自动装配链

[`GraphObservationAutoConfiguration`](../../code/spring-ai-alibaba/spring-boot-starters/spring-ai-alibaba-starter-graph-observation/src/main/java/com/alibaba/cloud/ai/autoconfigure/graph/GraphObservationAutoConfiguration.java)
在 `spring.ai.alibaba.graph.observation.enabled=true` 时完成四件事：

1. 注册 `GraphObservationLifecycleListener`；
2. 将 `ObservationRegistry` 和 Listener 放入默认 `CompileConfig`；
3. 注册 Graph、Node、Edge 三类 ObservationHandler；
4. 注册 `ObservationThreadLocalAccessor`，并打开 Reactor 自动上下文传播。

如果应用自己声明了 `CompileConfig`，默认 Bean 会因 `@ConditionalOnMissingBean` 不再创建。
此时需要手工设置 `observationRegistry` 和 Listener，否则仅引入 Starter 并不能保证自定义
Graph 已接入观测。

### 5.2 实际运行链

[`GraphObservationLifecycleListener`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/observation/GraphObservationLifecycleListener.java)
以每次执行自动生成的 execution ID 关联一个 Graph Observation，并为节点创建子
Observation：

```text
START
  → start graph observation
  → before(node): start child observation + open scope
  → after(node): record state + stop child
  → END: record output + stop graph observation
```

异常会同时标记节点和图失败。输入输出作为 high-cardinality 数据写入 Observation；
实现会跳过 `_` 开头的内部字段和 `logs`，并将单个值截断到 1000 字符，但不会自动做
业务级脱敏。生产环境应先评估 Prompt、Tool 结果和用户数据是否允许进入 trace backend，
必要时配合 `PIIDetectionHook` 或替换 Listener/Convention。

### 5.3 尚需运行验证的边级观测

源码定义了
[`SpringAiAlibabaKind.GRAPH_EDGE`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/observation/SpringAiAlibabaKind.java)、
[`GraphEdgeObservationContext`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/observation/edge/GraphEdgeObservationContext.java)
和对应 Handler，Starter 也会注册它们。但在当前 Graph Core 主运行链中，没有定位到创建
`GraphEdgeObservationContext` 或启动 Edge Observation 的调用。

因此只能确认“边级观测抽象和自动配置存在”，不能据此断言实际执行时已经完整产生边级
trace/metric；这一点需要接入 MeterRegistry 后运行验证。

## 6. A2A：把远端 Agent 适配为图节点

### 6.1 客户端调用链

[`A2aRemoteAgent`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/a2a/A2aRemoteAgent.java)
继承 `BaseAgent`，内部图只有一个 `A2aNode`：

```text
START
  → A2aNodeActionWithConfig
      → message/send 或 message/stream
      → 解析远端 text / SSE
  → END
```

它既可以独立调用，也可以通过 `asNode()` 作为 `SubGraphNode` 参与本地 Sequential、
Parallel、Routing 等编排。AgentCard 可以直接传入，也可以由
[`AgentCardProvider`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/a2a/AgentCardProvider.java)
按默认目标或 Agent 名称解析；HTTP 场景可使用
[`RemoteAgentCardProvider`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/a2a/RemoteAgentCardProvider.java)。

`A2aRemoteAgent.Builder` 的最终 streaming 模式由 AgentCard capabilities 覆盖，而不是只由
本地 `streaming(boolean)` 决定。这保证客户端服从远端声明，但也意味着 Builder 上手工设置
的值不是最终真理源。

### 6.2 `shareState` 的准确语义

`shareState=true` 默认复用父图的 `RunnableConfig`；设为 `false` 时会派生独立
`threadId`，并清除 `nextNode` 与 `checkPointId`。具体逻辑在
[`A2aNodeActionWithConfig`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/a2a/A2aNodeActionWithConfig.java)。

这里的“共享状态”不要理解成自动序列化整个 `OverAllState` 给远端。当前 JSON-RPC 请求只
发送一段 text，并在 metadata 中携带 `threadId` 和可选 `userId`。text 来自 `instruction`
模板渲染；如果需要传递某些状态字段，必须显式写进模板。`userId` 的 metadata key 旁仍有
`FIXME`，尚未抽象成可配置键。

### 6.3 服务端与 Nacos

[`spring-ai-alibaba-starter-a2a-nacos`](../../code/spring-ai-alibaba/spring-boot-starters/spring-ai-alibaba-starter-a2a-nacos)
提供两组能力：

- 将本地 Graph/Agent 暴露为 A2A Server；
- 通过 Nacos 注册 AgentCard，并在客户端做发现与负载均衡。

自动装配入口见
[`AutoConfiguration.imports`](../../code/spring-ai-alibaba/spring-boot-starters/spring-ai-alibaba-starter-a2a-nacos/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports)，
服务端执行适配见
[`GraphAgentExecutor`](../../code/spring-ai-alibaba/spring-boot-starters/spring-ai-alibaba-starter-a2a-nacos/src/main/java/com/alibaba/cloud/ai/a2a/core/server/GraphAgentExecutor.java)，
Nacos 发现见
[`NacosAgentCardProvider`](../../code/spring-ai-alibaba/spring-boot-starters/spring-ai-alibaba-starter-a2a-nacos/src/main/java/com/alibaba/cloud/ai/a2a/registry/nacos/discovery/NacosAgentCardProvider.java)。

### 6.4 当前限制与风险

- `schedule()` 明确抛出 `UnsupportedOperationException`，远端 Agent 不能直接复用本地
  `BaseAgent` 的调度入口；
- 非流式请求每次新建 `CloseableHttpClient`，只接受 HTTP 200，源码中未看到统一的重试、
  连接池或超时策略；
- 非流式路径会用 `System.out.println` 输出 base URL 和完整请求 payload，可能泄漏 Prompt
  或 metadata；
- A2A 流式解析和 Studio 输出曾有专门回归测试，说明协议事件到本地图流的适配是需要重点
  回归的边界。

相关测试：

- [`A2aRemoteAgentTests`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/test/java/com/alibaba/cloud/ai/graph/agent/a2a/A2aRemoteAgentTests.java)
- [`A2aNodeActionWithConfigTests`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/test/java/com/alibaba/cloud/ai/graph/agent/a2a/A2aNodeActionWithConfigTests.java)
- [`A2aServerMultiAgentAutoConfigurationTest`](../../code/spring-ai-alibaba/spring-boot-starters/spring-ai-alibaba-starter-a2a-nacos/src/test/java/com/alibaba/cloud/ai/a2a/autoconfigure/server/A2aServerMultiAgentAutoConfigurationTest.java)

## 7. A2A、MCP 与 Skills 的边界

三者都在扩展 Agent 能力，但层级不同：

| 机制 | 远端对象 | 本地呈现方式 | 主要用途 |
| --- | --- | --- | --- |
| A2A | Agent | `A2aRemoteAgent` / Graph Node | 委托完整任务、跨进程 Agent 协作 |
| MCP | Tool Server | `ToolCallback` / `ToolCallbackProvider` | 把远端工具纳入本地 Tool Calling |
| Skills | 指令与资源包 | Hook + Interceptor + Skill Tools | 渐进式披露知识和操作规程 |

MCP 最终仍进入本地 Tool Calling 主链，详见
[Tool Calling 实现](./tool-calling.md)；Skills 的加载和动态工具披露见
[Skills 实现](./skills.md)。A2A 则绕过本地模型—工具循环，把请求发送给另一个拥有自己
循环和状态的 Agent。

## 8. 限制与推荐阅读顺序

本文只做静态源码核对，没有启动 Nacos、MeterRegistry 或远端 A2A Server。因此：

- Checkpoint/Store 的接口、实现和单元测试可以确认；
- Edge Observation 是否实际出数、A2A 鉴权和超时行为仍应在真实部署中验证；
- `FIXME`、未接入主链的 Observation 抽象以及多 Saver 配置都不应写成稳定能力。

推荐继续按以下顺序阅读：

1. [`react-agent-architecture.md`](./react-agent-architecture.md)：Hook 如何进入 Agent 图；
2. [`tool-calling.md`](./tool-calling.md)：Model/Tool Interceptor 调用链；
3. [`graph-runtime.md`](./graph-runtime.md)：Checkpoint、中断和恢复位置；
4. `BaseCheckpointSaver`、`Store` 与 `CompileConfig`：区分两类持久化；
5. `GraphObservationAutoConfiguration` 与 `GraphObservationLifecycleListener`；
6. `A2aRemoteAgent`、`A2aNodeActionWithConfig` 和 A2A Starter。
