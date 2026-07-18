# A2A（Agent-to-Agent）协议实现分析

## 概述

agentscope-java 实现了 Google 的 **A2A (Agent2Agent) 协议**，包装了官方 A2A Java SDK（`io.github.a2asdk:a2a-java-sdk-*:0.3.3.Final`）。支持协议版本 `0.3.0`，传输层用 **JSON-RPC 2.0 over HTTP**，流式响应用 **SSE**。

代码分为客户端、服务端、Spring Boot starter 三个模块，外加 Nacos 服务发现集成。

## 1. 模块结构

```
agentscope-extensions/
  agentscope-extensions-protocol/
    agentscope-extensions-a2a/                  <-- 父 POM
      agentscope-extensions-a2a-client/        <-- 客户端（调用远程 A2A agent）
      agentscope-extensions-a2a-server/        <-- 服务端（把本地 ReActAgent 暴露为 A2A）
  agentscope-extensions-nacos/
    agentscope-extensions-nacos-a2a/            <-- Nacos 注册 + 发现
  agentscope-spring-boot-starters/
    agentscope-a2a-spring-boot-starter/         <-- Spring Boot 自动配置 + controller
```

依赖管理（`agentscope-dependencies-bom/pom.xml:98-100`）：
```xml
<a2a-client.version>0.3.3.Final</a2a-client.version>
<a2a-server-common.version>0.3.3.Final</a2a-server-common.version>
<a2a-transport-jsonrpc.version>0.3.3.Final</a2a-transport-jsonrpc.version>
```

所有 `io.a2a.*` import 都来自官方 SDK。

## 2. 协议规格与传输

### 协议版本

硬编码 `0.3.0`（`agentscope-extensions-a2a-server/.../card/AgentScopeAgentCardConverter.java:98`）：
```java
.protocolVersion("0.3.0")
```

### 核心数据模型（来自 SDK `io.a2a.spec`）

直接复用 SDK 的 record/interface，不在本地重造：
- `AgentCard`、`AgentSkill`、`AgentProvider`、`AgentCapabilities`、`AgentInterface`
- `SecurityScheme`
- `Task`、`TaskStatus`、`TaskState`
- `Message`、`Part`、`TextPart`、`FilePart`、`DataPart`
- `Artifact`
- `JSONRPCRequest`、`JSONRPCResponse`、`JSONRPCErrorResponse`
- `NonStreamingJSONRPCRequest`、`StreamingJSONRPCRequest`
- `TransportProtocol`（枚举：`JSONRPC`、`GRPC`、`REST`）

### 传输层

当前只实现 **JSON-RPC 2.0 over HTTP**，通过 `TransportWrapper` / `TransportWrapperBuilder` SPI 设计成可插拔。

### HTTP 端点（Spring Boot starter）

两个端点：

1. **`GET /.well-known/agent-card.json`** - 返回 `AgentCard`（标准 A2A well-known discovery URI）
   - `agentscope-a2a-spring-boot-starter/.../controller/AgentCardController.java:36-39`

2. **`POST /`** - JSON-RPC 端点，content type `application/json`，返回 `application/json`（非流式）或 `text/event-stream`（SSE 流式）
   - `agentscope-a2a-spring-boot-starter/.../controller/A2aJsonRpcController.java:50-66`

### JSON-RPC 方法分发

在 `JsonRpcTransportWrapper.handleNonStreamRequest`（`...server/transport/jsonrpc/JsonRpcTransportWrapper.java:206-227`）：

| JSON-RPC method | Java 请求类型 | 流式? |
|---|---|---|
| `message/send` | `SendMessageRequest` | 否 |
| `message/stream` | `SendStreamingMessageRequest` | 是 (SSE) |
| `tasks/get` | `GetTaskRequest` | 否 |
| `tasks/cancel` | `CancelTaskRequest` | 否 |
| `tasks/pushNotificationConfig/get` | `GetTaskPushNotificationConfigRequest` | 否 |
| `tasks/pushNotificationConfig/set` | `SetTaskPushNotificationConfigRequest` | 否 |
| `tasks/pushNotificationConfig/list` | `ListTaskPushNotificationConfigRequest` | 否 |
| `tasks/pushNotificationConfig/delete` | `DeleteTaskPushNotificationConfigRequest` | 否 |
| `tasks/resubscribe` | `TaskResubscriptionRequest` | 是 (SSE) |

流式响应包装为 Spring `ServerSentEvent`，event 类型 `jsonrpc`，id 匹配 JSON-RPC 请求 id（`A2aJsonRpcController.java:77-93`）。

## 3. 服务端：把 ReActAgent 暴露为 A2A

### 入口：`AgentScopeA2aServer`

文件：`agentscope-extensions-a2a-server/.../AgentScopeA2aServer.java`

**本身不绑定端口、不暴露端点**。只组装组件和请求处理链。开发者把 transport 接到 Spring Boot / Quarkus / Vert.x 等。

Builder 入口：
- `AgentScopeA2aServer.builder(ReActAgent.Builder)`（`:174`）- 默认用 `ReActAgentWithBuilderRunner`
- `AgentScopeA2aServer.builder(AgentRunner)`（`:184`）- 自定义 runner

Builder 字段（`:188-216`）：`agentRunner`、`supportedTransports`、`agentRegistries`、`agentCard`、`taskStore`、`queueManager`、`pushConfigStore`、`pushSender`、`executor`、`deploymentProperties`、`agentExecuteProperties`。

### 构建流水线（`Builder.build()`, `:363-418`）

1. 创建 `AgentScopeAgentExecutor` 包装 `AgentRunner`
2. 创建 `AgentScopeA2aRequestHandler` 包装 executor + task store + queue manager + push notification 组件（默认：`InMemoryTaskStore`、`InMemoryQueueManager`、`InMemoryPushNotificationConfigStore`、`BasePushNotificationSender`）
3. 未配 transport 时默认 `JSONRPC`
4. **SPI 加载所有 `TransportWrapperBuilder`**（`ServiceLoader.load`, `:421`）
5. 过滤出"可用"的 transport
6. 通过 `AgentScopeAgentCardConverter` 构建 `AgentCard`
7. 每个 transport 构建一个 `TransportWrapper`
8. 从 registry 列表构建 `AgentRegistryService`

### AgentCard 构建

文件：`...server/card/AgentScopeAgentCardConverter.java`

`createAgentCard`（`:69-100`）从 `ConfigurableAgentCard` + `AgentRunner` + 可用 transport 构建 SDK 的 `AgentCard`。规则：
- `protocolVersion` = `"0.3.0"`（硬编码，`:98`）
- `name` 回退到 `AgentRunner.getAgentName()`
- `description` 回退到 `AgentRunner.getAgentDescription()`
- `version` 默认 `"1.0.0"`
- `capabilities` 永远 `streaming=true`、`pushNotifications=false`、`stateTransitionHistory=false`（`:102-108`）
- `defaultInputModes`/`defaultOutputModes` 默认 `["text"]`
- `supportsAuthenticatedExtendedCard` = `false`（`:93`）
- `preferredTransport` 默认 `JSONRPC`
- `url` 从 transport properties 用 `"%s://%s:%d%s"` 派生（`:67`），按 `supportTls` 选 http/https，未指定端口默认 80/443

### 请求处理链

1. **`TransportWrapper<T, R>`**（`...server/transport/TransportWrapper.java`）- 通用接口 `R handleRequest(T body, Map<String,String> headers, Map<String,Object> metadata)`。每个 transport 一个 wrapper。

2. **`JsonRpcTransportWrapper`**（`...server/transport/jsonrpc/JsonRpcTransportWrapper.java`）：
   - 解析 body 判断流式/非流式（`isStreamingRequest`, `:145`）：方法为 `message/stream` 或 `tasks/resubscribe` 时流式
   - 把 `isStream` 标志塞到 `ServerCallContext.state` key `A2aServerConstants.ContextKeys.IS_STREAM_KEY`（`:117`）- executor 后续读这个决定阻塞/非阻塞
   - 委托给 SDK 的 `JSONRPCHandler`
   - 流式加背压 buffer（默认 8192，可通过系统属性 `agentscope.a2a.streaming.backpressure-buffer-size` 配置，`:81-89`）
   - JSON 处理异常映射到 JSON-RPC 错误（`JSONParseError`、`MethodNotFoundError`、`InvalidParamsError`、`InvalidRequestError`）

3. **`AgentScopeA2aRequestHandler`**（`...server/request/AgentScopeA2aRequestHandler.java`）：
   - 继承 SDK 的 `DefaultRequestHandler`
   - **用反射**设超时字段 `agentCompletionTimeoutSeconds=60` 和 `consumptionCompletionTimeoutSeconds=10`（`:133-148`），因为 SDK 没暴露 setter
   - 提供 `AgentScopeTaskStateProvider` record（`:151-176`）适配自定义 `TaskStore` 给 queue manager 的 active/finalized 检查

4. **`AgentScopeAgentExecutor`**（`...server/executor/AgentScopeAgentExecutor.java`）- 实现 SDK 的 `AgentExecutor`。这里是 AgentScope agent 执行模型与 A2A 的桥接点。

### `AgentScopeAgentExecutor.execute()`（`:96-124`）

```java
public void execute(RequestContext context, EventQueue eventQueue) throws JSONRPCError {
    List<Msg> inputMessages = MessageConvertUtil.convertFromMessageToMsgs(context.getMessage());
    AgentRequestOptions requestOptions = buildAgentRequestOptions(context);
    Flux<Event> resultFlux = agentRunner.stream(inputMessages, requestOptions);
    Task task = context.getTask() == null ? newTask(context.getMessage()) : context.getTask();
    if (isBlockRequest(context)) {
        processTaskBlocking(context, eventQueue, task, resultFlux);
    } else {
        processTaskNonBlocking(context, eventQueue, task, resultFlux);
    }
}
```

关键行为：
- **每个请求创建新 `ReActAgent`**（见 `BaseReActAgentRunner.stream`，`:51-61`，按 `taskId` 缓存 agent 以便后续 interrupt）
- 阻塞/非阻塞决策（`:161-175`）：流式请求永远非阻塞；否则看 `configuration.blocking()`（默认 true）
- **阻塞路径** `processTaskBlocking`（`:177-189`）：订阅 `Flux<Event>`，累积输出，完成时往 event queue 发单个 A2A `Message`
- **非阻塞/流式路径** `processTaskNonBlocking`（`:191-212`）：发初始 `Task` 事件，然后调 `processStreamingOutput` 用 `TaskUpdater` 发 `startWork`/`addArtifact`/`complete` 事件，每个 artifact 是 agent 输出的一个块

### `AgentExecuteProperties`

文件：`...server/executor/AgentExecuteProperties.java`

两个布尔标志：
- `completeWithMessage` - 流式 task 完成时是否带最终整合消息
- `requireInnerMessage` - 是否转发内部事件（`TOOL_RESULT`、`HINT`）给 A2A 客户端，而不只 `REASONING`/`SUMMARY`

`BaseFluxEventHandler.generateRequiredEventTypes`（`:264-274`）用它过滤哪些 agent event 作为 A2A artifact 转发。

### `AgentRunner` SPI

文件：`...server/executor/runner/AgentRunner.java`

```java
String getAgentName();
String getAgentDescription();
Flux<Event> stream(List<Msg> requestMessages, AgentRequestOptions options);
void stop(String taskId);
```

三种实现：
1. **`BaseReActAgentRunner`** - 抽象；维护 `Map<String, ReActAgent>` 按 `taskId` 缓存。`stop()` 移除并 `agent.interrupt()`
2. **`ReActAgentWithBuilderRunner`** - 用 `ReActAgent.Builder` 每次构建新 agent
3. **`ReActAgentWithStarterRunner`**（spring-boot starter）- 用 Spring `ObjectProvider<ReActAgent>` 拿 prototype scope agent

### Registry

`...server/registry/AgentRegistry.java` - 接口 `registryName()` + `register(AgentCard, List<TransportProperties>)`。`AgentRegistryService` 在 `postEndpointReady()` 时遍历所有 registry。

### SPI 注册文件

- `META-INF/services/io.a2a.server.TransportMetadata` 注册 `JsonRpcTransportMetadata`（向 SDK 声明 JSONRPC 支持）
- `META-INF/services/io.agentscope.core.a2a.server.transport.TransportWrapperBuilder` 注册 `JsonRpcTransportWrapperBuilder`

## 4. 客户端：调用远程 A2A Agent

### `A2aAgent`

文件：`agentscope-extensions-a2a-client/.../A2aAgent.java`

`A2aAgent extends AgentBase`（`:72`）- 远程 A2A agent 看起来就是本地 agent，可塞到 Pipeline / MsgHub / SubAgentTool 等任何用 `Agent` 的地方。

典型用法：
```java
AgentCard agentCard = generateAgentCardByCode();
A2aAgent a2aAgent = A2aAgent.builder().name("remote-agent-name").agentCard(agentCard).build();

// 或自动发现：
AgentCardResolver resolver = new WellKnownAgentCardResolver(
    "http://127.0.0.1:8080", "/.well-known/agent-card.json", Map.of());
A2aAgent a2aAgent = A2aAgent.builder().name("remote-agent-name").agentCardResolver(resolver).build();
```

### 生命周期：`A2aClientLifecycleHook`

`A2aAgent` 注册内部 `A2aClientLifecycleHook`（`:243-287`）优先级 500（"Normal 中的最低优先级"）：

- `PreCallEvent`（`:252-260`）：生成 `currentRequestId` UUID，构建新的 `ClientEventContext`，从解析的 agent card 构建新的 `a2aClient`
- `PostCallEvent`（`:261-262`）：释放资源，关闭 A2A 客户端
- `ErrorEvent`（`:263-270`）：也释放资源

**每次调用构建一个 A2A client**（设计上"一个 agent 不应被多线程多任务同时调用"，`:91`）。

### `doCall`（`:116-132`）

1. 把输入 msgs 加到 memory
2. 把 hooks 和输入消息塞到 `ClientEventContext`
3. 用 `MessageConvertUtil.convertFromMsg` 把 memory 消息转成单个 A2A `Message`
4. 调 `doExecute(message)`

### `doExecute`（`:199-241`）

用 `Mono.create` + SDK 的 `a2aClient.sendMessage(message, eventConsumers, errorHandler)`：
- 对服务端来的每个 `ClientEvent`，调 `clientEventHandlerRouter.handle(event, eventContext)`
- 流在 terminal event 之前完成 -> exceptionally complete
- 取消时 -> 带CancellationException exceptionally complete

### 中断处理（`:153-172`）

`handleInterrupt` 调 `a2aClient.cancelTask(new TaskIdParams(taskId), null)` - 对应 A2A `tasks/cancel` JSON-RPC 方法。

### AgentCard 发现

文件：`...client/card/AgentCardResolver.java` - 接口 `AgentCard getAgentCard(String agentName)`

三种实现：
1. **`FixedAgentCardResolver`** - 持有固定 `AgentCard`
2. **`WellKnownAgentCardResolver`** - 从标准 `/.well-known/agent-card.json` URI 用 `A2A.getAgentCard(baseUrl, relativeCardPath, authHeaders)` 抓取（`:54`），默认路径 `/.well-known/agent-card.json`（`:75`）
3. **`NacosAgentCardResolver`** - 从 Nacos A2A registry 解析，带订阅式缓存更新

### 客户端配置

`A2aAgentConfig` 是 record `(@SuppressWarnings Map<Class, ClientTransportConfig> clientTransports, ClientConfig clientConfig)`。未配置时 `A2aAgent.buildA2aClient`（`:187-197`）默认 `JSONRPCTransport.class` + 默认 `JSONRPCTransportConfig`。

### 客户端事件处理

`...client/event/ClientEventHandlerRouter.java` - 策略路由器，注册三个 handler（`:36-41`）：
- `TaskUpdateEventHandler` 处理 `TaskUpdateEvent`
- `MessageEventHandler` 处理 `MessageEvent`
- `TaskEventHandler` 处理 `TaskEvent`

`ClientEventContext` 持有 per-call 状态：`MonoSink<Msg> sink`、`Task task`、hooks、输入消息、三个 `AtomicBoolean`（`preReasoningFired`、`postReasoningFired`、`terminalDelivered`）保证生命周期事件只触发一次。暴露 hook 发布助手：`publishPreReasoning()`、`publishReasoningChunk(Msg)`、`publishPostReasoning(Msg)`。

### 事件处理器（terminal 处理）

1. **`MessageEventHandler`** - 把 A2A `Message` 转 `Msg`，触发 `PostReasoningEvent` hooks，完成 Mono sink
2. **`TaskEventHandler`** - 设 task 到 context；task 处于 final state 时优先用 `status.message()`（非 null 时），否则从 `task.getArtifacts()` 转换。触发 `PostReasoningEvent` 并完成
3. **`TaskUpdateEventHandler`** - 委托给两个内部 handler：
   - `TaskStatusUpdateEventHandler`（`:86-152`）- `isFinal()` 时：state 非 `COMPLETED` 则带错误消息完成；否则把 task artifacts 转 `Msg`，触发 `PostReasoningEvent` 完成。非 final 状态带 message 时触发 `ReasoningChunkEvent`（流式块）
   - `TaskArtifactUpdateEventHandler`（`:154-172`）- 把 artifact 转 `Msg`，触发 `ReasoningChunkEvent`

所以流式 task 中，每个 artifact/status 更新变成一个 `ReasoningChunkEvent`（hooks 可见），final state 触发 `PostReasoningEvent` + Mono 完成。

### 消息转换（客户端）

`...client/utils/MessageConvertUtil.java` - 双向转换：
- `convertFromMsg(List<Msg>) -> Message`（`:106`）：扁平化所有 msgs 为单个 A2A `Message`，每个 `ContentBlock` 一个 part，把元数据键（`_agentscope_msg_id`、`_agentscope_msg_source`、`_agentscope_msg_role`）注入到每个 part。Role 解析（`:147-160`）：所有 msgs 共享同一转换 role 时用它；否则默认 `USER`
- `convertFromMessage(Message, agentName) -> Msg`（`:90`）
- `convertFromArtifact(Artifact|List<Artifact>, agentName) -> Msg`（`:54-81`）
- `convertFromParts(List<Part<?>>)`（`:173`）包含流式块累积：标记 `_agentscope_stream_chunk=true` 且同 `msgId` 同 kind（text 或 thinking）的 parts 被合并（`:234-266`）

### Part <-> ContentBlock 解析架构

两套并行层次，都是路由式：

- `...client/message/PartParser.java` - `PartParser<T extends Part<?>>` 把 Part 解析为 `ContentBlock`
- `...client/message/ContentBlockParser.java` - `ContentBlockParser<T extends ContentBlock>` 把 ContentBlock 解析为 Part

路由器：
- `PartParserRouter`（`:36-44`）- 按 `part.getKind()` switch（TEXT/FILE/DATA）
- `ContentBlockParserRouter`（`:45-69`）- 按 instanceof 分发 `TextBlock`/`ThinkingBlock`/`ImageBlock`/`AudioBlock`/`VideoBlock`/`ToolUseBlock`/`ToolResultBlock`

解析器：

| Parser | Source | Target | 说明 |
|---|---|---|---|
| `TextPartParser` | `TextPart` | `TextBlock` 或 `ThinkingBlock` | 通过 `_agentscope_block_type=thinking` 区分 |
| `FilePartParser` | `FilePart` | `ImageBlock`/`AudioBlock`/`VideoBlock` | 按 MIME 主类型（image/audio/video）|
| `DataPartParser` | `DataPart` | `TextBlock`（默认）、`ToolUseBlock` 或 `ToolResultBlock` | 按 `_agentscope_block_type` 元数据 |
| `TextBlockParser` | `TextBlock` | `TextPart` | 标记 `_agentscope_block_type=text` |
| `ThinkingBlockParser` | `ThinkingBlock` | `TextPart` | 标记 `_agentscope_block_type=thinking`（以 TextPart 承载）|
| `ImageBlockParser`/`AudioBlockParser`/`VideoBlockParser` | media block | `FilePart` | 继承 `BaseMediaBlockParser` |
| `BaseMediaBlockParser` | (abstract) | `FilePart` | `Base64Source` -> `FileWithBytes`，`URLSource` -> `FileWithUri` |
| `ToolUseBlockParser` | `ToolUseBlock` | `DataPart` | input 存为 data，metadata 含 `_agentscope_block_type=tool_use`、`_agentscope_tool_name`、`_agentscope_tool_call_id` |
| `ToolResultBlockParser` | `ToolResultBlock` | `DataPart` | 输出存在 `_agentscope_tool_output` key |

### 自定义元数据键

`...client/message/MessageConstants.java`：
```
_agentscope_msg_source       // 源名
_agentscope_msg_id           // 消息 id
_agentscope_msg_role         // 角色
_agentscope_block_type       // block 判别（text/thinking/image/audio/video/tool_use/tool_result）
_agentscope_stream_chunk     // 标记流式增量 part
_agentscope_tool_name
_agentscope_tool_call_id
_agentscope_tool_output
```

这是 AgentScope 在 A2A 最低公分母 Part 类型（只有 `TextPart`/`FilePart`/`DataPart`）之上保留自己丰富 `Msg`/`ContentBlock` 语义的方式。**非 agentscope A2A 客户端能优雅降级** - 没有 `_agentscope_block_type` 的 `DataPart` 被解析成包含 JSON 的 `TextBlock`（见 `DataPartParser.isCommonDataPart`, `:49-54`）。

## 5. 与 Core 集成

### 与 Toolkit 系统的关系

**A2A 不作为 `Tool` 暴露**。没有 `A2aTool` 之类。`A2aAgent` 是 `Agent`，不是 `AgentTool`。

要把远程 A2A agent 当 tool 从父 agent 的 ReAct 循环调用，手动组合现有的 **`SubAgentTool`**（`agentscope-core/.../tool/subagent/SubAgentTool.java`），它能把任何 `Agent`（包括 `A2aAgent`）包成 `AgentTool`。

### 与 SubAgent 系统的关系

`SubAgentTool` 包 `Agent` 为 `AgentTool`。因为 `A2aAgent extends AgentBase`，可以把远程 A2A agent 包在 `SubAgentTool` 里作为工具调用。这是标准组合模式，A2A 没有特殊集成。

### 与 MCP 的对比

两者都是"远程能力"协议，但**集成在不同层**：

| 维度 | MCP | A2A |
|---|---|---|
| 集成层 | `ToolBase` 子类 `McpTool` | `AgentBase` 子类 `A2aAgent` |
| 包装 | 单个工具（可调用）| 整个 agent（对话式）|
| 使用方 | ReActAgent 的 Toolkit | 任何用 Agent 的地方（Pipeline、SubAgentTool 等）|
| 模块 | `agentscope-core/.../tool/mcp/` | `agentscope-extensions-a2a-client/` |
| 方向 | Agent 作为 MCP 客户端（调远程 MCP server）| 双向：`A2aAgent`（客户端）+ `AgentScopeA2aServer`（服务端）|
| Spec/SDK | `io.modelcontextprotocol.spec.McpSchema` | `io.a2a.spec.*` |

MCP 工具出现在 agent 工具列表里，在 ReAct 循环中被调用。A2A agent 是可对等调用的 peer（`a2aAgent.call(msg).block()`）。**MCP 给工具，A2A 给 agent**。两者可在同一 `ReActAgent` 中并存。

注意：MCP 集成在 `agentscope-core` 本身，A2A 在 `agentscope-extensions`。这反映了 MCP 工具集成更紧耦合 ReAct 循环，A2A 是严格在 agent 抽象之上的对等协议。

## 6. Task 生命周期

### Task 状态机

`Task` 创建时状态 `SUBMITTED`（`AgentScopeAgentExecutor.newTask`, `:149-159`）：
```java
return new Task(taskId, contextId, new TaskStatus(TaskState.SUBMITTED), null, List.of(request), null);
```

状态转换由 SDK 的 `TaskUpdater` 驱动。终态通过 `taskStatus.state().isFinal()` 检测（见 `AgentScopeA2aRequestHandler.AgentScopeTaskStateProvider.isTaskFinalized`, `:165-175`）。

观察到的转换：
- **`SUBMITTED`** - task 创建时初始
- **`WORKING`** - 由 `taskUpdater.startWork()` 设（`processStreamingOutput`, `:225`）
- **`COMPLETED`** - 由 `taskUpdater.complete(...)` 设（`StreamingFluxEventHandler.doOnComplete`, `:435`）或阻塞路径间接通过最终消息
- **`FAILED`** - 出错时 `taskUpdater.fail(...)`（`:201, :458`）
- **`CANCELED`** - `AgentScopeAgentExecutor.cancel` 中 `taskUpdater.cancel()`（`:81`），然后 `agentRunner.stop(taskId)` 中断 agent，订阅被取消

### Task 提交/轮询/取消

映射到 `JsonRpcTransportWrapper.handleNonStreamRequest`（`:206-227`）处理的 JSON-RPC 方法：
- **提交（阻塞）**：`message/send` 带 `configuration.blocking=true` -> `SendMessageRequest` -> `jsonRpcHandler.onMessageSend` -> 返回单个 `Message`（或 `Task`）
- **提交（流式）**：`message/stream` -> `SendStreamingMessageRequest` -> `jsonRpcHandler.onMessageSendStream` -> 返回 SSE 流
- **轮询**：`tasks/get` -> `GetTaskRequest` -> `jsonRpcHandler.onGetTask`
- **取消**：`tasks/cancel` -> `CancelTaskRequest` -> `jsonRpcHandler.onCancelTask` -> 最终调 `AgentScopeAgentExecutor.cancel` -> `taskUpdater.cancel()` + 取消 Reactor `Subscription` + `agent.interrupt()`
- **重订阅**：`tasks/resubscribe` -> `TaskResubscriptionRequest` -> `jsonRpcHandler.onResubscribeToTask`（也是流式/SSE）

### 订阅追踪

`AgentScopeAgentExecutor` 持有 `Map<String, Subscription> subscriptions`（`:64`）按 taskId 索引。`saveSubscription`（`:234`）在 `Flux.doOnSubscribe` 时填充，`removeSubscription`（`:239`）在 `Flux.doFinally` 时清除。这是 `cancel()` 能实际停止运行中流式执行的关键。

### Artifact 如何返回

流式路径，`StreamingFluxEventHandler.handleEvent`（`:439-453`）：
```java
Msg outputMessage = output.getMessage();
List<Part<?>> responseParts = MessageConvertUtil.convertFromContentBlocks(
    outputMessage, !output.isLast());
taskUpdater.addArtifact(responseParts, artifactId, "agent-response",
    outputMessage.getMetadata(),
    !isFirstArtifact.getAndSet(false), false);
```

整个 task 用同一个 `artifactId`（UUID, `:419`）；后续块传 `append=true`（`!isFirstArtifact.getAndSet(false)`）让 SDK 追加到同一 artifact。每个 artifact 命名 `"agent-response"`。完成时调 `taskUpdater.complete(completeMessage)`（`:435`）- 可选带最终整合消息（`AgentExecuteProperties.isCompleteWithMessage()` 为 true 时）。

阻塞路径通过 `eventQueue.enqueueEvent(resultMessage)` 返回单个 A2A `Message`（不是 artifact）（`:382`）。

## 7. Spring Boot Starter

文件：`agentscope-a2a-spring-boot-starter/.../AgentscopeA2aAutoConfiguration.java`

通过标准 Spring Boot 3+ SPI 文件 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 注册。

激活条件（`:61-67`）：
- `@ConditionalOnClass({AgentScopeA2aServer.class})`
- `@ConditionalOnWebApplication`
- `@ConditionalOnProperty(prefix = "agentscope.a2a.server", name = "enabled", havingValue = "true", matchIfMissing = true)`

创建的 Bean：
- `agentRunnerWithStarterRunner`（`:70-75`）- 存在 `ReActAgent` bean 时（用 Spring `ObjectProvider`）
- `agentRunnerWithBuilder`（`:77-82`）- 存在 `ReActAgent.Builder` bean 时
- `agentScopeA2aServer`（`:84-109`）- 主 server bean，从 `A2aAgentCardProperties`、`A2aCommonProperties`、`Environment`（port/address/context-path）、任意 `List<AgentRegistry>` 和 `List<CustomTransportProperties>` bean 配置
- `agentCardController`（`:111-115`）- well-known URI controller
- `a2aJsonRpcController`（`:125-129`）- JSON-RPC POST 端点
- `serverReadyConfiguration`（`:131-135`）- `ServerReadyListener`，在 `ApplicationReadyEvent` 时调 `agentScopeA2aServer.postEndpointReady()`（`...listener/ServerReadyListener.java:34-37`）

### 配置属性（前缀 `agentscope.a2a.server.*`）

定义在 `...properties/Constants.java`：
- `agentscope.a2a.server.enabled`（默认 true）
- `agentscope.a2a.server.card.*` - `A2aAgentCardProperties`（name、description、url、provider、version、documentationUrl、defaultInputModes、defaultOutputModes、skills、securitySchemes、security、iconUrl、additionalInterfaces、preferredTransport）
- `agentscope.a2a.server.completeWithMessage` / `requireInnerMessage` - `A2aCommonProperties`
- `agentscope.a2a.server.transports.jsonrpc.*` - `JSONRPCProperties`（实现 `CustomTransportProperties`）
- 部署默认从 `server.port`、`server.address`、`server.servlet.context-path` 读（`Constants.java:36-41`）

### `JSONRPCProperties`

实现 `CustomTransportProperties`（Spring 可配置 transport 的 SPI）。`toTransportProperties()`（`:45-51`）产生 `TransportProperties` record。有 `enabled` 标志（默认 true）和 `deploymentProperties`（host/port/path）。

### `CustomTransportProperties` SPI

`...server/transport/CustomTransportProperties.java` - 添加 Spring 可配置 transport 的扩展点。每个实现：
1. 通过 `toTransportProperties()` 转成 `TransportProperties`
2. 通过 `setDeploymentProperties()` 接收 `DeploymentProperties`（从主配置继承 host/port）
3. 通过 `isEnabled()` 让 auto-config 过滤

auto-config 在 `agentScopeA2aServer` bean（`:100-106`）中迭代：
```java
transportProperties.stream()
    .filter(CustomTransportProperties::isEnabled)
    .forEach(each -> {
        each.setDeploymentProperties(deploymentProperties);
        builder.withTransport(each.toTransportProperties());
    });
```

## 8. Nacos 集成

目录：`agentscope-extensions/agentscope-extensions-nacos/agentscope-extensions-nacos-a2a/`

### Registry: `NacosAgentRegistry`

文件：`...registry/NacosAgentRegistry.java`

实现 `AgentRegistry`（塞进 `AgentScopeA2aServer.Builder.withAgentRegistry`）。`registryName()` 返回 `"Nacos"`（`:60`）。

`register()`（`:64-70`）委托 `NacosA2aRegistry.registerAgent`：
1. 通过 `AgentCardConverterUtil.convertToNacosAgentCard`（`...utils/AgentCardConverterUtil.java:159-183`）把 SDK `AgentCard` 转 Nacos `com.alibaba.nacos.api.ai.model.a2a.AgentCard`
2. 调 `a2aService.releaseAgentCard(...)`（`:89`）发布 card 本身
3. 若 `enabledRegisterEndpoint=true`（默认），每个 transport 注册为 `AgentEndpoint`（`a2aService.registerAgentEndpoint(...)`, `:105-133`）

可选 `overwritePreferredTransport`（`:170-211`）- 根据Nacos 配置的 transport 覆盖 agent card 的 preferred transport + URL（当 Nacos 注册的 endpoint 与 agent 自己报告的不同时有用）。

### Discovery: `NacosAgentCardResolver`

文件：`...discovery/NacosAgentCardResolver.java`

客户端实现 `AgentCardResolver`。用 `ConcurrentHashMap`（`:65`）缓存 agent card，用 Nacos 订阅 + `AbstractNacosAgentCardListener`（`:113-121`）保持缓存更新。

用法（`:38-54`）：
```java
NacosAgentCardResolver resolver = new NacosAgentCardResolver(aiService);
A2aAgent agent = A2aAgent.builder().name("remote-agent-name").agentCardResolver(resolver).build();
```

### `AgentCardConverterUtil`

文件：`...utils/AgentCardConverterUtil.java`

SDK `io.a2a.spec.AgentCard` 与 Nacos `com.alibaba.nacos.api.ai.model.a2a.AgentCard` 间的双向转换器。注意：`SecurityScheme` 通过 JSON 往返通用处理（`:84-91, :235-242`），因为 Nacos SDK 不保留具体 A2A `SecurityScheme` 子类型。

## 9. 关键要点

1. **包装官方 SDK，不自造协议**。所有 `io.a2a.spec.*` 数据模型直接复用 `a2a-java-sdk` 0.3.3.Final。

2. **协议版本 0.3.0 硬编码**。目前固定，未来升级 SDK 时需同步更新。

3. **传输层只有 JSON-RPC over HTTP + SSE**。SPI 设计允许扩展 gRPC、REST，但目前无实现。

4. **服务端不绑端口**。`AgentScopeA2aServer` 只组装组件，端口暴露交给 Spring Boot / Quarkus 等 web 框架。

5. **每个请求一个新 ReActAgent**。`BaseReActAgentRunner` 按 `taskId` 缓存以便后续 interrupt，但每次请求都构建新实例。

6. **客户端 `A2aAgent` 是 `AgentBase` 子类**。可塞到 Pipeline / SubAgentTool 任何用 `Agent` 的地方。每次 `call()` 构建一个新 A2A client。

7. **A2A 不作为 Tool 暴露**。要用远程 A2A agent 作 tool，手动用 `SubAgentTool` 包装 `A2aAgent`。

8. **MCP vs A2A 分层不同**：MCP 在 `ToolBase` 层（agent 调远程工具），A2A 在 `AgentBase` 层（agent 调远程 agent）。

9. **Part <-> ContentBlock 转换有自定义约定**。A2A 只有 3 种 Part（Text/File/Data），AgentScope 有 7 种 ContentBlock。通过 `_agentscope_block_type` 等元数据键保留语义；非 agentscope 客户端能优雅降级。

10. **Task 状态机**：SUBMITTED -> WORKING -> COMPLETED/FAILED/CANCELED。流式路径用 `TaskUpdater` 发 startWork/addArtifact/complete 事件。同一 task 的所有 artifact 共享一个 `artifactId`，后续块 `append=true`。

11. **取消通过 JSON-RPC `tasks/cancel`**：服务端 `AgentScopeAgentExecutor.cancel` -> `taskUpdater.cancel()` + 取消 Reactor `Subscription` + `agent.interrupt()`。`Map<String, Subscription>` 按 taskId 索引是关键。

12. **Nacos 集成提供 registry + discovery**：服务端 `NacosAgentRegistry` 发布 AgentCard + endpoint；客户端 `NacosAgentCardResolver` 订阅式缓存远程 agent card。

## 10. 关键文件清单

### 服务端 - `agentscope-extensions-a2a-server/.../`

| 文件 | 用途 |
|---|---|
| `AgentScopeA2aServer.java` | 入口，组装组件 |
| `card/AgentScopeAgentCardConverter.java` | 构建 SDK AgentCard |
| `card/ConfigurableAgentCard.java` | 可配置 AgentCard POJO |
| `executor/AgentScopeAgentExecutor.java` | 实现 SDK AgentExecutor，桥接 AgentScope agent |
| `executor/AgentExecuteProperties.java` | completeWithMessage / requireInnerMessage 标志 |
| `executor/runner/AgentRunner.java` | AgentRunner SPI |
| `executor/runner/BaseReActAgentRunner.java` | 抽象基类，按 taskId 缓存 agent |
| `executor/runner/ReActAgentWithBuilderRunner.java` | 用 Builder 构建新 agent |
| `request/AgentScopeA2aRequestHandler.java` | 继承 SDK DefaultRequestHandler |
| `transport/TransportWrapper.java` | 通用 transport 接口 |
| `transport/TransportWrapperBuilder.java` | SPI builder 接口 |
| `transport/jsonrpc/JsonRpcTransportWrapper.java` | JSON-RPC 实现 |
| `transport/jsonrpc/JsonRpcTransportWrapperBuilder.java` | builder |
| `registry/AgentRegistry.java` | registry 接口 |
| `registry/AgentRegistryService.java` | 多 registry 聚合 |

### 客户端 - `agentscope-extensions-a2a-client/.../`

| 文件 | 用途 |
|---|---|
| `A2aAgent.java` | AgentBase 子类，远程 A2A agent |
| `A2aAgentConfig.java` | transport 配置 record |
| `card/AgentCardResolver.java` | AgentCard 解析接口 |
| `card/FixedAgentCardResolver.java` | 固定 card 实现 |
| `card/WellKnownAgentCardResolver.java` | 从 well-known URI 抓取 |
| `event/ClientEventHandlerRouter.java` | 事件策略路由器 |
| `event/ClientEventContext.java` | per-call 状态 |
| `event/MessageEventHandler.java` | 处理 MessageEvent |
| `event/TaskEventHandler.java` | 处理 TaskEvent |
| `event/TaskUpdateEventHandler.java` | 处理 TaskUpdateEvent |
| `message/PartParserRouter.java` | Part -> ContentBlock 路由 |
| `message/ContentBlockParserRouter.java` | ContentBlock -> Part 路由 |
| `message/*Parser.java` | 各种解析器 |
| `message/MessageConstants.java` | 自定义元数据键 |
| `utils/MessageConvertUtil.java` | Msg <-> Message 双向转换 |

### Spring Boot - `agentscope-a2a-spring-boot-starter/.../`

| 文件 | 用途 |
|---|---|
| `AgentscopeA2aAutoConfiguration.java` | 自动配置 |
| `controller/AgentCardController.java` | `/.well-known/agent-card.json` 端点 |
| `controller/A2aJsonRpcController.java` | JSON-RPC POST 端点 |
| `properties/Constants.java` | 配置前缀 |
| `properties/A2aAgentCardProperties.java` | AgentCard 配置 |
| `properties/A2aCommonProperties.java` | 通用配置 |
| `properties/JSONRPCProperties.java` | JSONRPC transport 配置 |
| `listener/ServerReadyListener.java` | ApplicationReadyEvent 触发 registry 注册 |
| `runner/ReActAgentWithStarterRunner.java` | Spring prototype scope agent |

### Nacos - `agentscope-extensions-nacos-a2a/.../`

| 文件 | 用途 |
|---|---|
| `registry/NacosAgentRegistry.java` | 服务端 registry 实现 |
| `discovery/NacosAgentCardResolver.java` | 客户端 discovery 实现 |
| `utils/AgentCardConverterUtil.java` | SDK <-> Nacos AgentCard 转换 |
