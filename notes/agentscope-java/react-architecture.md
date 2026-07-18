# ReAct 架构实现分析

## 概述

AgentScope Java 实现了经典的 **ReAct (Reasoning and Acting)** 模式，这是一种将推理（思考/规划）与行动（工具执行）相结合的 Agent 设计模式。

## 核心组件

### 1. ReActAgent

**位置**: `agentscope-core/src/main/java/io/agentscope/core/ReActAgent.java`

ReActAgent 是整个架构的核心，实现了推理-行动循环：

```java
public class ReActAgent extends AgentBase implements AutoCloseable {
    // 核心配置
    private final String name;
    private final String sysPrompt;
    private final Model model;
    private final Toolkit toolkit;
    private final int maxIters;
    private final List<MiddlewareBase> middlewares;

    // 状态管理
    private final AgentStateStore stateStore;
    private final PermissionEngine permissionEngine;
}
```

### 2. HarnessAgent

**位置**: `agentscope-harness/src/main/java/io/agentscope/harness/agent/HarnessAgent.java`

HarnessAgent 在 ReActAgent 基础上增加了企业级能力：

- Workspace 管理
- 文件系统抽象（本地/Docker/Kubernetes/云沙箱）
- Subagent 编排
- Skill 自学习循环
- 分层内存管理
- Plan Mode 支持

## ReAct 循环实现

### 核心流程

ReAct 循环由两个主要阶段组成：

```
┌─────────────────────────────────────────────────┐
│                  ReAct 循环                      │
│                                                 │
│  ┌──────────┐      ┌──────────┐               │
│  │ Reasoning │ ───> │ Acting   │               │
│  │ (推理)    │      │ (行动)   │               │
│  └──────────┘      └──────────┘               │
│       │                  │                     │
│       │                  │                     │
│       └──────────────────┘                     │
│              (循环迭代)                         │
└─────────────────────────────────────────────────┘
```

### 1. Reasoning 阶段

**方法**: `reasoning(int iter, boolean ignoreMaxIters)`

**职责**:
- 调用 LLM 模型进行推理
- 累积模型响应（文本、思考块、工具调用）
- 通过中间件链处理事件流
- 决定下一步行动

**关键代码**:

```java
private Mono<Msg> reasoning(int iter, boolean ignoreMaxIters) {
    // 1. 检查最大迭代次数
    if (!ignoreMaxIters && iter >= maxIters) {
        return summarizing();
    }

    ReasoningContext context = new ReasoningContext(getName());

    return checkInterrupted()
        .then(hookDispatcher.firePreReasoning(...))
        .flatMap(event -> {
            // 2. 构建模型输入和工具 schema
            List<Msg> modelInput = prependSystemMsg(...);
            List<ToolSchema> tools = toolkit.getToolSchemas(...);

            // 3. 通过中间件链执行推理流
            Function<ReasoningInput, Flux<AgentEvent>> reasoningCore =
                ri -> reasoningStream(context, ri.messages(), ri.tools(), ri.options());

            Flux<AgentEvent> stream = MiddlewareChain.build(
                middlewares, ReActAgent.this, rc,
                MiddlewareBase::onReasoning, reasoningCore
            ).apply(new ReasoningInput(modelInput, tools, options));

            // 4. 处理推理结果
            return stream.doOnNext(this::publishEvent)
                .then(Mono.defer(() -> Mono.justOrEmpty(context.buildFinalMessage())));
        })
        .flatMap(msg -> runPostReasoningPipeline(msg, iter));
}
```

**事件流**:
```
ModelCallStartEvent
  → TextBlockStartEvent
  → TextBlockDeltaEvent (多个)
  → TextBlockEndEvent

  → ThinkingBlockStartEvent
  → ThinkingBlockDeltaEvent
  → ThinkingBlockEndEvent

  → ToolCallStartEvent
  → ToolCallDeltaEvent
  → ToolCallEndEvent

ModelCallEndEvent
```

### 2. Acting 阶段

**方法**: `acting(int iter)`

**职责**:
- 提取待执行的 pending tool calls
- 执行工具并获得结果
- 处理工具挂起（ToolSuspendException）
- 决定是否继续下一轮迭代

**关键代码**:

```java
private Mono<Msg> acting(int iter) {
    // 1. 提取待执行的 pending tool calls
    List<ToolUseBlock> pendingToolCalls = extractPendingToolCalls();

    if (pendingToolCalls.isEmpty()) {
        // 没有待执行的工具，进入下一轮迭代
        return executeIteration(iter + 1);
    }

    // 2. 通过中间件链执行工具
    return hookDispatcher.firePreActing(pendingToolCalls, toolkit)
        .flatMap(toolCalls -> {
            Function<ActingInput, Flux<AgentEvent>> actingCore =
                ai -> actingStream(ai.toolCalls(), replyId, resultHolder);

            Flux<AgentEvent> stream = MiddlewareChain.build(
                middlewares, ReActAgent.this, rc,
                MiddlewareBase::onActing, actingCore
            ).apply(new ActingInput(toolCalls));

            return stream.then(Mono.defer(() -> Mono.just(resultHolder.get())));
        })
        .flatMap(results -> {
            // 3. 处理工具执行结果
            List<Map.Entry<ToolUseBlock, ToolResultBlock>> successPairs =
                results.stream().filter(e -> !e.getValue().isSuspended()).toList();
            List<Map.Entry<ToolUseBlock, ToolResultBlock>> pendingPairs =
                results.stream().filter(e -> e.getValue().isSuspended()).toList();

            // 4. 通知 post-acting 钩子并决定下一步
            if (!pendingPairs.isEmpty()) {
                return Mono.just(buildSuspendedMsg(pendingPairs));
            }

            return executeIteration(iter + 1);
        });
}
```

**工具执行事件流**:
```
ToolResultStartEvent
  → ToolResultTextDeltaEvent / ToolResultDataDeltaEvent
ToolResultEndEvent
```

## 中间件系统

ReActAgent 使用中间件链来实现横切关注点：

### 中间件阶段

```java
public abstract class MiddlewareBase {
    // 代理级别
    public Mono<AgentInput> onAgent(AgentInput input, MiddlewareChain chain);

    // 推理级别
    public Mono<ReasoningInput> onReasoning(ReasoningInput input, MiddlewareChain chain);

    // 行动级别
    public Mono<ActingInput> onActing(ActingInput input, MiddlewareChain chain);

    // 模型调用级别
    public Mono<ModelCallInput> onModelCall(ModelCallInput input, MiddlewareChain chain);

    // 系统提示级别
    public Mono<SystemPromptInput> onSystemPrompt(SystemPromptInput input, MiddlewareChain chain);
}
```

### 内置中间件

HarnessAgent 预置了多个中间件：

- **WorkspaceContextMiddleware**: 加载 workspace 上下文（AGENTS.md, MEMORY.md）
- **MemoryFlushMiddleware**: 内存刷新和消息卸载
- **CompactionMiddleware**: 上下文压缩
- **SubagentsMiddleware**: Subagent 编排
- **HarnessSkillMiddleware**: Skill 加载和管理
- **SandboxLifecycleMiddleware**: 沙箱生命周期管理
- **PlanModeMiddleware**: Plan Mode 支持
- **AsyncToolMiddleware**: 异步工具执行
- **InboxMiddleware**: 消息收件箱处理
- **PermissionMiddleware**: 权限控制（允许/需要批准/拒绝）

## 状态管理

### AgentState

每个 `(userId, sessionId)` 对应一个独立的 AgentState：

```java
public class AgentState {
    private List<Msg> context;           // 会话上下文
    private PermissionContextState permission;  // 权限状态
    private Map<String, Object> metadata; // 元数据
}
```

### AgentStateStore

支持多种存储后端：

- **InMemoryAgentStateStore**: 内存存储（默认）
- **JsonFileAgentStateStore**: JSON 文件存储
- **MySQLAgentStateStore**: MySQL 数据库
- **RedisAgentStateStore**: Redis
- **PostgreSQLAgentStateStore**: PostgreSQL

## 权限系统

### 三态权限引擎

```java
public enum PermissionBehavior {
    ALLOW,     // 允许执行
    APPROVE,   // 需要用户批准
    DENY       // 拒绝执行
}
```

### PermissionEngine

```java
public class PermissionEngine {
    private PermissionMode mode;  // AUTO / MANUAL
    private List<PermissionRule> rules;

    public PermissionBehavior check(String toolName, Map<String, Object> args);
}
```

敏感工具需要 Human-in-the-Loop (HITL) 批准：

```java
// 工具执行时抛出 ToolSuspendException
if (behavior == PermissionBehavior.APPROVE) {
    throw new ToolSuspendException("Waiting for user approval");
}
```

## 消息模型

### 统一的内容块

```java
public sealed interface ContentBlock permits
    TextBlock,        // 文本内容
    ThinkingBlock,    // 思考内容
    ToolUseBlock,     // 工具调用
    ToolResultBlock,  // 工具结果
    ImageBlock,       // 图片
    AudioBlock,       // 音频
    VideoBlock,       // 视频
    FileBlock {       // 文件
}
```

### Message 角色

```java
public sealed interface Msg permits SystemMessage, UserMessage, AssistantMessage {
    MsgRole getRole();
    List<ContentBlock> getContent();
}
```

## 事件系统

### 28 种类型化事件

AgentScope 2.0 定义了完整的事件体系：

**代理生命周期事件**:
- AgentStartEvent
- AgentEndEvent
- AgentResultEvent

**推理事件**:
- ModelCallStartEvent / ModelCallEndEvent
- TextBlockStartEvent / TextBlockDeltaEvent / TextBlockEndEvent
- ThinkingBlockStartEvent / ThinkingBlockDeltaEvent / ThinkingBlockEndEvent
- ToolCallStartEvent / ToolCallDeltaEvent / ToolCallEndEvent

**行动事件**:
- ToolResultStartEvent / ToolResultTextDeltaEvent / ToolResultDataDeltaEvent / ToolResultEndEvent

**人机交互事件**:
- RequireUserConfirmEvent

**其他事件**:
- RequestStopEvent
- ExceedMaxItersEvent
- AllToolsDeniedEvent

## 关键设计特点

### 1. 无状态设计

ReActAgent 在调用之间是无状态的，状态由 `AgentStateStore` 持有：

```java
// 线程安全：可以单例方式服务多用户/会话
HarnessAgent agent = HarnessAgent.builder().build();

// 每次调用使用 RuntimeContext 隔离状态
agent.call(message, RuntimeContext.builder()
    .userId("alice")
    .sessionId("session-123")
    .build());
```

### 2. 响应式编程

使用 Project Reactor 的 Mono/Flux 实现异步非阻塞：

```java
// 阻塞调用
Mono<Msg> result = agent.call(message, context);
result.block();

// 流式事件
Flux<Event> events = agent.streamEvents(message, context);
events.doOnNext(event -> {
    // 实时处理事件
}).blockLast();
```

### 3. 中间件模式

通过中间件链实现横切关注点的优雅处理：

```java
MiddlewareChain.build(middlewares, agent, rc,
    MiddlewareBase::onReasoning, reasoningCore)
.apply(input);
```

### 4. 事件驱动

细粒度的事件流支持实时前端渲染：

```java
agent.streamEvents(message, context)
    .doOnNext(event -> {
        switch (event.getType()) {
            case TEXT_BLOCK_DELTA -> renderText(...);
            case TOOL_CALL_START -> showTool(...);
            case TOOL_RESULT_START -> displayResult(...);
        }
    })
    .blockLast();
```

## 与 Spring AI Alibaba 的对比

| 特性 | AgentScope Java | Spring AI Alibaba |
|------|----------------|-------------------|
| 核心模式 | ReAct | ReAct + Graph |
| 状态管理 | AgentStateStore | ChatMemory |
| 中间件 | MiddlewareBase | 无 |
| 事件系统 | 28种事件 | 无 |
| 权限系统 | PermissionEngine | 无 |
| 沙箱执行 | Docker/K8s/E2B | 无 |
| Subagent | 支持 | 支持 |
| 文件系统 | 多后端抽象 | 无 |

## 总结

AgentScope Java 的 ReAct 实现是一个**生产级、企业就绪**的设计：

1. **清晰的两阶段分离**: Reasoning 和 Acting 各司其职
2. **强大的中间件系统**: 五阶段切面，灵活扩展
3. **完善的事件体系**: 28 种事件支持实时渲染
4. **无状态架构**: 天然支持分布式部署
5. **权限控制**: 三态引擎保护敏感操作
6. **工具挂起**: 支持长时间运行的人机交互

这种设计使得 Agent 既能处理简单的问答，也能应对长期运行、复杂任务的场景。