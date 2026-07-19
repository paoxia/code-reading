# Tool Calling 实现

> 源码版本：`spring-ai-alibaba/main@84ca19a12`

## 1. 结论

Spring AI Alibaba 的 Tool Calling 是一条由 Graph 接管的完整链路：

```text
注册 ToolCallback
      │
      ▼
AgentLlmNode 把工具 schema 发给模型
      │
      ▼
模型返回 AssistantMessage.ToolCall
      │
      ▼
ReactAgent 条件边进入 AgentToolNode
      │
      ▼
ToolInterceptor → 解析工具 → 执行工具
      │
      ▼
ToolResponseMessage 写回 messages
      │
      ▼
再次调用模型，直到没有 ToolCall
```

最关键的实现选择是关闭 Spring AI ChatClient 内部的自动工具执行，让
`ReactAgent + AgentToolNode + StateGraph` 控制整个循环。这样工具调用才能参与状态
合并、Checkpoint、Hook、中断、并行执行和流式输出。

## 2. 核心类型

| 类型 | 职责 |
|---|---|
| `ToolCallback` | Spring AI 的同步工具抽象 |
| `AsyncToolCallback` | 框架扩展的异步工具抽象 |
| `CancellableAsyncToolCallback` | 支持取消 token 的异步工具 |
| `StateAwareToolCallback` | 可读取/更新 Agent 状态的工具 |
| `AgentLlmNode` | 把工具定义传给模型并接收 ToolCall |
| `AgentToolNode` | 解析并执行 ToolCall |
| `ToolInterceptor` | 包装一次工具调用 |
| `ToolCallbackResolver` | 根据名称延迟解析工具 |
| `ToolStateCollector` | 合并并行工具的状态更新 |

主要源码：

- [`Builder`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/Builder.java)
- [`DefaultBuilder`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/DefaultBuilder.java)
- [`AgentLlmNode`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentLlmNode.java)
- [`AgentToolNode`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentToolNode.java)
- [`InterceptorChain`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/InterceptorChain.java)

## 3. 工具注册

### 3.1 直接注册 ToolCallback

```java
ReactAgent.builder()
    .tools(weatherTool, searchTool)
    .build();
```

适合已经手工创建的 `FunctionToolCallback`、`MethodToolCallback`、MCP ToolCallback
或框架内置工具。

### 3.2 注册带 @Tool 的对象

```java
ReactAgent.builder()
    .methodTools(new WeatherTools())
    .build();
```

Builder 使用 Spring AI `ToolCallbacks.from(toolObjects)` 扫描对象中的 `@Tool`
方法并创建回调。

### 3.3 ToolCallbackProvider

```java
.toolCallbackProviders(provider)
```

适合 MCP 或其他批量提供工具的组件。

### 3.4 按名称解析

```java
.toolNames("search", "read_file")
.resolver(toolCallbackResolver)
```

Builder 在构建 Agent 时通过 Resolver 找到工具。若指定名称无法解析，会抛出异常，
并提示模型可能对过长工具名进行了截断或改写。

### 3.5 Hook 和 Interceptor 提供工具

Hook 的 `getTools()` 和 ModelInterceptor 的 `getTools()` 也可以贡献工具。例如：

- `SkillsAgentHook` 提供 read/search/disable skill；
- `SubAgentInterceptor` 提供 task 工具；
- TodoListInterceptor 提供 todo 工具。

## 4. 工具收集与去重

[`DefaultBuilder.gatherLocalTools()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/DefaultBuilder.java)
按以下来源收集：

1. `.tools()` 直接配置；
2. ToolCallbackProvider；
3. toolNames + Resolver；
4. 必要时尝试从 Resolver 中取得全部工具；
5. ModelInterceptor 工具；
6. Hook 工具。

最终组合顺序为：

```text
Hook tools → Interceptor tools → regular tools
```

然后 `ToolCallbackUtils.deduplicateByName()` 按工具名去重。工具名是贯穿 schema、
模型响应和执行解析的主键，因此在同一个 Agent 内必须稳定且唯一。

## 5. 把工具告诉模型

### 5.1 ToolCallingChatOptions

`AgentLlmNode` 把工具合并进 `ToolCallingChatOptions`：

- Builder 直接配置的工具优先；
- ChatOptions 原来包含但没有重名的工具会被保留；
- 每次请求复制 options，避免修改用户传入对象；
- 强制关闭 internal tool execution。

核心设置：

```java
copiedOptions.setToolCallbacks(filteredToolCallbacks);
copiedOptions.setInternalToolExecutionEnabled(false);
```

### 5.2 ModelRequest 中的工具信息

`AgentLlmNode.apply()` 还会把工具名和描述放入 `ModelRequest`：

```text
tools            : List<String>
toolDescriptions : Map<String, String>
```

ModelInterceptor 可以据此：

- 只保留当前场景需要的工具；
- 修改工具描述；
- 禁用所有工具；
- 增加动态工具。

### 5.3 工具筛选

最终发给模型的工具由 `filterToolCallbacks()` 决定：

1. 读取当前请求 options 中的 ToolCallback；
2. 如果 `ModelRequest.tools` 不为空，只保留名称位于列表中的工具；
3. 按名称去重；
4. 再与动态 ToolCallback 合并。

因此 ModelInterceptor 不必重建 Agent，也能按每次请求动态缩小工具集合。

## 6. 动态工具

ModelInterceptor 可以向 `ModelRequest.dynamicToolCallbacks` 添加工具。典型场景是：

- 读取某个 Skill 后开放该 Skill 的专属工具；
- 根据用户权限加载工具；
- 根据工作流阶段切换工具集合。

动态工具有一条跨节点传递链：

```text
ModelInterceptor
  │ 修改 ModelRequest.dynamicToolCallbacks
  ▼
AgentLlmNode.buildChatClientRequestSpec()
  │ 写入 RunnableConfig.context
  ▼
DYNAMIC_TOOL_CALLBACKS_METADATA_KEY
  │
  ▼
AgentToolNode.resolveFromConfigMetadata()
```

这里使用的是 `RunnableConfig.context()`，而不是可持久化的 `OverAllState`。动态工具
是本轮运行时对象，不应进入 Checkpoint 序列化。

## 7. 模型到工具的路由

[`ReactAgent.makeModelToTools()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)
按如下规则路由：

```text
afterModel hooks
      │
      ├─ jump_to=model ─► 下一轮模型
      ├─ jump_to=tool  ─► 工具节点
      ├─ jump_to=end   ─► Agent 结束
      │
      └─ 无 jump_to
            │
            ├─ AssistantMessage.hasToolCalls() ─► 工具节点
            └─ 普通 AssistantMessage          ─► 结束
```

如果最后一条消息已经是 `ToolResponseMessage`，路由逻辑会比较：

- AssistantMessage 中请求的 tool-call ID；
- ToolResponseMessage 中已经响应的 ID。

如果还有缺失 ID，会再次进入工具节点。这使框架能够处理部分工具响应和中断恢复。

## 8. AgentToolNode 执行入口

[`AgentToolNode.apply()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentToolNode.java)
读取最后一条消息：

- `AssistantMessage`：执行其中所有 ToolCall；
- `ToolResponseMessage`：找到前一条 AssistantMessage，只执行尚未响应的 ToolCall；
- 其他消息：抛出状态异常。

这意味着进入 `agent_tool` 节点前，messages 必须满足工具调用消息协议。

## 9. ToolInterceptor 责任链

每一个 ToolCall 都会先转换为 `ToolCallRequest`：

```text
toolCall
context          ← RunnableConfig.metadata
executionContext ← RunnableConfig + OverAllState
```

之后进入 `InterceptorChain.chainToolInterceptors()`：

```text
request
  │
  ▼
interceptor[0]  ← 最外层
  │
  ▼
interceptor[1]
  │
  ▼
base handler    ← 真正解析和执行工具
```

Interceptor 可以：

- 修改参数；
- 提前返回结果；
- 调用后检查或修改响应；
- 实现重试、错误包装、审计和权限判断。

工具执行结果统一封装为 `ToolCallResponse`，再转换为 Spring AI
`ToolResponseMessage.ToolResponse`。

## 10. 工具解析

`AgentToolNode.resolve()` 按以下顺序查找：

1. 节点持有的静态 ToolCallback 列表；
2. RunnableConfig context 中的动态工具；
3. ToolCallbackResolver。

如果工具不存在，框架生成状态为 error 的 `ToolCallResponse`，内容类似：

```text
Tool not available: tool_name
```

这条错误作为工具结果反馈给模型，模型可以重新选择工具或向用户说明问题。

## 11. 工具上下文和状态注入

基础 ToolContext 由两部分合并：

```text
Builder.toolContext
        +
ToolCallRequest.context（RunnableConfig metadata）
```

对于以下工具类型：

- `StateAwareToolCallback`
- `FunctionToolCallback`
- `MethodToolCallback`

还会注入：

| key | 内容 |
|---|---|
| `AGENT_STATE_CONTEXT_KEY` | 当前 OverAllState |
| `AGENT_CONFIG_CONTEXT_KEY` | 当前 RunnableConfig |
| `AGENT_STATE_FOR_UPDATE_CONTEXT_KEY` | 当前工具专用的 update Map |

工具应通过 update Map 修改状态，不应直接原地修改 `OverAllState` 中的集合。

## 12. 同步工具

普通 `ToolCallback` 通过：

```java
callback.call(arguments, toolContext)
```

执行。

异常处理分两类：

- `ToolExecutionException`：交给 `ToolExecutionExceptionProcessor`；
- 其他异常：转换为 error ToolCallResponse。

DefaultBuilder 默认创建 `alwaysThrow(false)` 的异常处理器，因此大多数工具错误会成为
模型可见的响应，而不是直接终止 Graph。

## 13. 异步工具

`AsyncToolCallback` 使用 `CompletableFuture<String>`：

```text
callAsync(arguments, context)
        │
        ▼
future.orTimeout(...).join()
```

每个异步工具可以提供自己的 timeout。发生超时时：

- 返回 `Tool execution timed out`；
- 清除该工具尚未合并的状态更新；
- 如果支持 cancellation token，则通知工具协作式停止。

`CancellableAsyncToolCallback` 接收 `DefaultCancellationToken`。这不能强制杀死任意
线程，工具实现仍需要主动检查 token。

### 13.1 包装同步工具

启用 `.wrapSyncToolsAsAsync(true)` 时，顺序执行模式可以通过
`AsyncToolCallbackAdapter` 将同步工具包装到 Executor 中。

并行执行模式会忽略该选项，因为外层已经使用 `CompletableFuture.runAsync()`。如果再
向同一线程池提交内层任务并同步等待，可能造成线程池饥饿甚至死锁。

## 14. 顺序执行多个工具

默认模式逐个执行同一 AssistantMessage 中的所有 ToolCall：

```text
toolCall1 → response1 → merge update1
toolCall2 → response2 → merge update2
toolCall3 → response3 → merge update3
```

每个工具拥有独立 update Map，避免后一个工具超时清理掉前一个工具已经完成的更新。

状态合并使用 `Map.putAll()`：

- 不读取 KeyStrategy；
- 多个工具写同一 key 时，最后执行的工具覆盖之前结果。

这是为保持历史兼容而保留的语义。

## 15. 并行执行多个工具

启用：

```java
.parallelToolExecution(true)
.maxParallelTools(5)
.toolExecutionTimeout(Duration.ofMinutes(2))
```

执行结构：

```text
                    ┌─ tool1 ─┐
AssistantMessage ───├─ tool2 ─┼─► ordered responses
                    └─ tool3 ─┘
                           │
                           ▼
                 ToolStateCollector.mergeAll()
```

实现细节：

- 创建当前状态的浅快照供所有工具读取；
- 为每个工具分配独立 update Map；
- `Semaphore` 限制实际并发数；
- `AtomicReferenceArray` 保存按调用顺序排列的响应；
- 外层 future 和异步工具自身都有超时处理；
- 超时工具的状态更新被丢弃；
- 最终按 KeyStrategy 合并所有成功更新。

并行模式下：

- APPEND key 会聚合各工具值；
- REPLACE key 仍是 last-write-wins，但并行完成顺序可能使结果不稳定；
- 不应让多个并行工具竞争写同一个 REPLACE key。

## 16. ToolResponseMessage

所有工具执行完后，工具节点创建一条 `ToolResponseMessage`，其中每个响应包含：

- tool-call ID；
- 工具名；
- response data；
- 错误状态和 metadata。

消息写入 `messages` 后，ReactAgent 通常回到 `beforeModel`，让模型读取工具结果并决定：

- 再调用其他工具；
- 修正参数后重试；
- 生成最终回答。

## 17. returnDirect

当一轮中的所有 ToolCallback 都设置 `returnDirect=true` 时，`AgentToolNode` 会在
ToolResponseMessage metadata 中写入 finish reason。

但当前
[`ReactAgent.makeToolsToModelEdge()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)
直接检查 ToolMetadata 的代码仍是 `FIXME`，不会单独依靠该 edge 结束。

推荐显式注册
[`ReturnDirectModelHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/returndirect/ReturnDirectModelHook.java)：

1. 在 `beforeModel` 检查 ToolResponseMessage metadata；
2. 把工具结果转换为 AssistantMessage；
3. 返回 `JumpTo.end`；
4. 避免再次调用模型。

## 18. 部分工具响应与恢复

如果工具执行被中断，恢复时 messages 可能是：

```text
AssistantMessage(tool1, tool2, tool3)
ToolResponseMessage(tool1 response)
```

`handlePartialToolResponses()` 会：

1. 找到 AssistantMessage；
2. 收集已经执行的 tool-call ID；
3. 只执行 tool2、tool3；
4. 把新旧响应合并；
5. 使用 `RemoveByHash` 移除旧的部分响应消息；
6. 追加完整 ToolResponseMessage。

这是 Tool Calling 与 Graph Checkpoint/中断机制结合的关键实现。

## 19. 流式输出

模型节点在流式模式下把 `Flux<ChatResponse>` 放入节点更新，Graph Runtime 识别这个
内嵌 Flux 并转换为 `StreamingOutput`。

工具完成后也会产生 Agent 级工具完成输出。`Agent.streamMessages()` 只向上层暴露：

- `AGENT_MODEL_STREAMING`
- `AGENT_TOOL_FINISHED`

图节点和 Hook 等内部事件不会全部泄漏给只关心 Message 的调用方。

## 20. 实践建议

### 工具定义

- 工具名要短、稳定、语义明确；
- description 同时说明能力、适用时机和限制；
- JSON schema 尽量减少可选但含义模糊的字段；
- 工具输出应让模型容易判断成功、失败和下一步行动。

### 状态更新

- 使用工具专用 update Map；
- APPEND key 适合事件、结果列表；
- REPLACE key 适合单一当前值；
- 并行工具避免竞争同一个 REPLACE key。

### 稳定性

- 设置工具超时；
- 为长任务实现 CancellableAsyncToolCallback；
- 使用 ToolInterceptor 做重试、错误标准化和审计；
- 使用 ModelCallLimitHook/ToolCallLimitHook 限制失控循环；
- `returnDirect` 场景显式配置 ReturnDirectModelHook。

## 21. 推荐阅读顺序

1. `Builder.tools/methodTools/toolNames`。
2. `DefaultBuilder.gatherLocalTools()`。
3. `AgentLlmNode.buildChatOptions()`。
4. `AgentLlmNode.filterToolCallbacks()`。
5. `ReactAgent.makeModelToTools()`。
6. `AgentToolNode.apply()`。
7. `executeToolCallWithInterceptors()`。
8. `executeSyncTool()` 和 `executeAsyncTool()`。
9. `executeToolCallsParallel()`。
10. `handlePartialToolResponses()` 和 ReturnDirectModelHook。

