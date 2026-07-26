# Hook 与 Interceptor：执行层级、调用链与选型

## 1. 研究范围

- 源码版本：`84ca19a1296f`
- Maven `revision`：`1.1.2.2`
- 研究对象：`ReactAgent` 中的 Hook、ModelInterceptor、ToolInterceptor 和
  StreamingModelInterceptor

本文只回答一个问题：

> 当我们要给 `ReactAgent` 增加一项横切能力时，应该使用 Hook 还是 Interceptor？

## 2. 一句话结论

Hook 和 Interceptor 的根本区别不是“谁在调用前、谁在调用后”，而是所在层级不同：

```text
Hook
  = StateGraph 中真实存在的节点
  = 改变工作流状态和控制流

Interceptor
  = Model/Tool 节点内部的函数包装器
  = 改变一次模型或工具调用
```

可以把 `ReactAgent` 想象成一张道路地图：

- Hook 是地图上的检查站、岔路和红绿灯，导航系统知道它们存在；
- Interceptor 是某个服务窗口外面的鉴权、重试和日志，不改变整张地图。

## 3. 它们在一次 ReAct 执行中的位置

一个同时配置了 Hook 和 Interceptor 的 `ReactAgent`，执行结构近似如下：

```text
START
  │
  ▼
BeforeAgent Hooks                         Graph 节点，只执行一次
  │
  ▼
┌────────────── ReAct Loop ────────────────────────────┐
│                                                     │
│  BeforeModel Hooks                    Graph 节点     │
│        │                              每轮执行       │
│        ▼                                            │
│  AgentLlmNode                         Graph 节点     │
│        │                                            │
│        └─ ModelInterceptor A           函数包装器    │
│             └─ ModelInterceptor B                    │
│                  └─ ChatModel.call                   │
│                                                     │
│  AfterModel Hooks                     Graph 节点     │
│        │                                            │
│        ├─ 没有 ToolCall ─────────────────────────┐  │
│        │                                         │  │
│        └─ 有 ToolCall                            │  │
│             ▼                                    │  │
│        AgentToolNode               Graph 节点    │  │
│             │                                    │  │
│             └─ ToolInterceptor A    函数包装器   │  │
│                  └─ ToolInterceptor B            │  │
│                       └─ ToolCallback             │  │
│             │                                    │  │
│             └────────── 回到 BeforeModel         │  │
└──────────────────────────────────────────────────┘  │
                                                      │
                                                      ▼
                                               AfterAgent Hooks
                                                      │
                                                      ▼
                                                     END
```

[`ReactAgent.initGraph()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)
会用 `graph.addNode()` 把 Hook 加进图。

ModelInterceptor 则在
[`AgentLlmNode`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentLlmNode.java)
内部组成责任链；ToolInterceptor 在
[`AgentToolNode`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentToolNode.java)
内部组成责任链。它们不会成为图节点。

## 4. Hook：改变工作流

### 4.1 Hook 是一个 Graph Node

[`Hook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/Hook.java)
有两组主要实现：

- `AgentHook`：整个 Agent Loop 前后执行；
- `ModelHook`：每次模型推理前后执行。

还有两个以消息列表为主要输入输出的便捷抽象：

- `MessagesAgentHook`
- `MessagesModelHook`

Hook 最终接收 `OverAllState` 和 `RunnableConfig`，返回一个状态更新 `Map`：

```java
CompletableFuture<Map<String, Object>> beforeModel(
    OverAllState state,
    RunnableConfig config
)
```

这个返回值会像普通 Graph Node 的结果一样，通过 KeyStrategy 合并进
`OverAllState`。

因此 Hook 可以：

- 读取和更新完整图状态；
- 更新持久化消息历史；
- 声明新增状态字段的合并策略；
- 跳转到 Model、Tool 或 END；
- 触发 Interrupt，等待恢复；
- 让更新后的状态进入 Checkpoint；
- 被 Graph 生命周期监听器观察。

### 4.2 四个生命周期位置

Hook 通过 `@HookPositions` 或类型默认值确定位置：

| 位置 | 执行频率 | 典型用途 |
| --- | --- | --- |
| `BEFORE_AGENT` | 整个 Agent 调用开始时一次 | 初始化资源、加载 Skill、注入 instruction |
| `BEFORE_MODEL` | 每轮模型推理前 | 压缩消息、PII 检测、调用次数限制 |
| `AFTER_MODEL` | 每轮模型推理后 | HITL、检查 ToolCall、改变路由 |
| `AFTER_AGENT` | Agent 正常结束前一次 | 清理资源、整理最终状态 |

`BEFORE_AGENT` 和 `BEFORE_MODEL` 很容易混淆。

假设模型连续调用三次工具，整个任务包含四轮模型推理：

```text
beforeAgent                              1 次

beforeModel → model → afterModel         第 1 轮
tool
beforeModel → model → afterModel         第 2 轮
tool
beforeModel → model → afterModel         第 3 轮
tool
beforeModel → model → afterModel         第 4 轮

afterAgent                               1 次
```

### 4.3 Hook 可以更新状态

一个简化的模型调用计数 Hook：

```java
@HookPositions(HookPosition.BEFORE_MODEL)
public class ModelBudgetHook extends ModelHook {

    @Override
    public String getName() {
        return "model_budget";
    }

    @Override
    public CompletableFuture<Map<String, Object>> beforeModel(
            OverAllState state,
            RunnableConfig config) {

        int calls = state.value("model_calls", 0);
        return CompletableFuture.completedFuture(
            Map.of("model_calls", calls + 1)
        );
    }

    @Override
    public Map<String, KeyStrategy> getKeyStrategys() {
        return Map.of("model_calls", new ReplaceStrategy());
    }
}
```

`model_calls` 是 Graph State 的一部分。配置 CheckpointSaver 后，它可以随执行状态一起
保存和恢复。

### 4.4 Hook 可以改变路由

Hook 可以把 `jump_to` 写入状态：

```java
return CompletableFuture.completedFuture(
    Map.of("jump_to", JumpTo.end)
);
```

同时需要通过 `canJumpTo()` 声明允许的目标：

```java
@Override
public List<JumpTo> canJumpTo() {
    return List.of(JumpTo.end);
}
```

ReactAgent 编译图时会为这些目标创建条件边。运行时读取 `jump_to`，选择：

- `JumpTo.model`
- `JumpTo.tool`
- `JumpTo.end`

路由实现见
[`ReactAgent.addHookEdge()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)。

### 4.5 Hook 的执行顺序

同一位置的 Hook 按 `getOrder()` 从小到大排序。before 正向执行，after 反向执行：

```text
Hook A：order = 10
Hook B：order = 20

A.before
  → B.before
      → Model / Agent Loop
  → B.after
→ A.after
```

这类似一层层进入作用域，再按相反顺序退出。

但 `afterAgent` 仍然是图上的后续节点，不是 Java 的 `finally`。如果上游异常直接终止
Graph，不保证一定执行 `afterAgent`。

## 5. Interceptor：包装一次调用

### 5.1 ModelInterceptor

[`ModelInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/ModelInterceptor.java)
的核心方法是：

```java
ModelResponse interceptModel(
    ModelRequest request,
    ModelCallHandler handler
)
```

它可以：

- 修改本次请求的消息、SystemMessage 和模型参数；
- 缩小本轮允许使用的工具集合；
- 动态加入 ToolCallback；
- 调用一次 `handler.call(request)`；
- 多次调用 handler，实现重试；
- 不调用 handler，直接返回缓存结果；
- 捕获异常后调用备用模型；
- 修改模型响应。

例如模型调用耗时统计：

```java
public class LoggingModelInterceptor extends ModelInterceptor {

    @Override
    public String getName() {
        return "model_logging";
    }

    @Override
    public ModelResponse interceptModel(
            ModelRequest request,
            ModelCallHandler handler) {

        long start = System.nanoTime();
        try {
            return handler.call(request);
        }
        finally {
            long duration = System.nanoTime() - start;
            System.out.println("model duration = " + duration);
        }
    }
}
```

[`ModelRequest`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/ModelRequest.java)
描述的是“这一次发给模型的请求”，包含：

```text
systemMessage
messages
options
tools
dynamicToolCallbacks
toolDescriptions
context
```

它不是完整的 Graph State。

### 5.2 ToolInterceptor

[`ToolInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/ToolInterceptor.java)
的核心方法是：

```java
ToolCallResponse interceptToolCall(
    ToolCallRequest request,
    ToolCallHandler handler
)
```

[`ToolCallRequest`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/ToolCallRequest.java)
包含：

- 工具名称；
- JSON 参数；
- ToolCall ID；
- metadata/context；
- 当前 `RunnableConfig` 和 `OverAllState` 的执行上下文。

例如阻止危险工具：

```java
public class DangerousToolInterceptor extends ToolInterceptor {

    @Override
    public String getName() {
        return "dangerous_tool_guard";
    }

    @Override
    public ToolCallResponse interceptToolCall(
            ToolCallRequest request,
            ToolCallHandler handler) {

        if ("delete_all_files".equals(request.getToolName())) {
            return ToolCallResponse.builder()
                .toolName(request.getToolName())
                .toolCallId(request.getToolCallId())
                .status("error")
                .content("This tool is not allowed")
                .build();
        }

        return handler.call(request);
    }
}
```

每个 ToolCall 都会独立经过一次 ToolInterceptor 责任链。模型一次返回三个 ToolCall，
通常就会执行三次责任链。

### 5.3 Interceptor 责任链顺序

同步 ModelInterceptor 和 ToolInterceptor 中，第一个注册的是最外层：

```text
注册顺序：[A, B, C]

请求方向：
A → B → C → BaseHandler

响应方向：
BaseHandler → C → B → A
```

实际组合逻辑见
[`InterceptorChain`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/InterceptorChain.java)。

顺序会改变语义：

```text
Retry → Logging → Model
```

重试三次时，Logging 可能记录三次底层调用。

```text
Logging → Retry → Model
```

Logging 更接近记录一次包含全部重试的逻辑调用。

### 5.4 StreamingModelInterceptor 的特殊点

StreamingModelInterceptor 处理 `Flux<ChatResponse>`：

- `beforeStreamCall`
- `onStreamChunk`
- `afterStreamComplete`
- `onStreamError`

它有两个容易踩坑的地方：

1. 第一个注册的 StreamingModelInterceptor 是最内层，最先看到原始 chunk，与同步责任链
   相反；
2. `beforeStreamCall` 执行时底层 Flux 已创建，不能再改变真正发送给模型的请求。要修改
   模型输入，应使用普通 ModelInterceptor。

这些语义直接记录在
[`InterceptorChain.applyStreamingInterceptors()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/InterceptorChain.java)
的实现注释中。

## 6. 核心对照表

| 维度 | Hook | Interceptor |
| --- | --- | --- |
| 所在层级 | StateGraph | Graph Node 内部调用链 |
| 是否是 Graph 节点 | 是 | 否 |
| 主要输入 | `OverAllState`、`RunnableConfig` | `ModelRequest` 或 `ToolCallRequest` |
| 主要输出 | 状态更新 `Map` | Model/Tool Response |
| 是否直接更新图状态 | 可以 | 通常不直接更新 |
| 是否改变路由 | 可以使用 `jump_to` | 不能直接改变图边 |
| 是否支持 Graph Interrupt | 可以 | 不具备该语义 |
| 是否参与 Checkpoint | 状态更新可以进入 | Request/Response 修改不会形成独立图状态 |
| 执行频率 | Agent 一次或模型每轮一次 | 每次模型调用或每个 ToolCall |
| 是否适合多次调用下游 | 通常不这样使用 | 适合 retry/fallback |
| 典型用途 | HITL、状态压缩、调用限制、生命周期 | 重试、fallback、动态工具、错误处理 |

## 7. 四个典型场景

### 7.1 HumanInTheLoop：使用 Hook

需要的流程是：

```text
模型产生 ToolCall
  → AssistantMessage 写入 Graph State
  → HumanInTheLoopHook 检查 ToolCall
  → Interrupt
  → 保存 Checkpoint
  → 等待人工批准
  → 恢复 Graph
  → 执行工具
```

它依赖状态、中断位置和恢复语义，所以
[`HumanInTheLoopHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/hip/HumanInTheLoopHook.java)
是 `AFTER_MODEL` Hook。

ModelInterceptor 位于模型节点内部。此时模型结果还没有作为节点输出完成状态合并，不适合
承担 Graph 级暂停和恢复。

### 7.2 ModelRetry：使用 Interceptor

```text
ModelRetryInterceptor
  → handler.call(request)
      → 失败
  → handler.call(request)
      → 成功
```

它只包装一次逻辑模型调用，不需要增加图节点，所以使用
[`ModelRetryInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/modelretry/ModelRetryInterceptor.java)。

### 7.3 Summarization：当前实现使用 Hook

[`SummarizationHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/summarization/SummarizationHook.java)
会把摘要后的消息写回 `messages` 状态。

结果是：

- 后续模型轮次看到摘要；
- Checkpoint 恢复后仍看到摘要；
- 长消息历史被状态级替换。

所以它使用 `MessagesModelHook`。

如果需求只是“本次请求临时截断消息，但不要重写持久化会话历史”，则更适合
ModelInterceptor。

### 7.4 ToolRetry：使用 Interceptor

```text
ToolRetryInterceptor
  → weather_tool(args)
      → timeout
  → weather_tool(args)
      → success
```

它只处理一个 ToolCall，不需要让 Graph 多走一个节点，因此使用
[`ToolRetryInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/toolretry/ToolRetryInterceptor.java)。

## 8. 为什么一个 Hook 还能提供 Interceptor

这是最容易造成概念混乱的设计。

`Hook` 接口还允许返回：

```java
getModelInterceptors()
getToolInterceptors()
getTools()
```

这表示一个 Hook 可以充当“功能安装包”，同时安装：

- Graph 生命周期节点；
- ModelInterceptor；
- ToolInterceptor；
- ToolCallback；
- State KeyStrategy。

但被安装的组件最终仍在不同层级运行。

`SkillsAgentHook` 是典型例子：

```text
SkillsAgentHook.beforeAgent
  ├─ 扫描 SKILL.md
  ├─ 初始化 SkillRegistry
  ├─ 注册 read_skill/search_skills 等工具
  └─ 提供 SkillsInterceptor

每轮模型调用：
SkillsInterceptor
  ├─ 判断已经激活的 Skill
  ├─ 修改本轮 System Prompt
  └─ 动态开放相关工具
```

Skill 初始化只需在 Agent 开始时做一次，因此属于 Hook；每轮 Prompt 和工具集合调整属于
ModelInterceptor。

ReactAgent 会合并直接配置的 Interceptor 与 Hook 提供的 Interceptor。名称重复时，直接
配置在 ReactAgent 上的 Interceptor 优先。

相关实现：

- [`SkillsAgentHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/skills/SkillsAgentHook.java)
- [`SkillsInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/skills/SkillsInterceptor.java)
- [`ReactAgent.collectAndMergeModelInterceptors()`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)

## 9. 选型决策树

```text
要增加一项横切能力
  │
  ├─ 是否需要暂停并恢复 Graph？
  │      └─ 是 → Hook
  │
  ├─ 是否需要改变下一节点，跳到 Model/Tool/END？
  │      └─ 是 → Hook
  │
  ├─ 是否需要把结果写入 OverAllState，并随 Checkpoint 保存？
  │      └─ 是 → Hook
  │
  ├─ 是否只包装一次模型请求？
  │      └─ 是 → ModelInterceptor
  │
  ├─ 是否只包装一个 ToolCall？
  │      └─ 是 → ToolInterceptor
  │
  ├─ 是否处理流式响应的每个 chunk？
  │      └─ 是 → StreamingModelInterceptor
  │
  └─ 是否同时需要初始化、工具注册和每轮请求修改？
         └─ 是 → Hook 作为功能容器，并由它提供 Interceptor
```

## 10. 最终记忆模型

```text
Hook 回答：

“Agent 工作流接下来应该怎么走，
工作流状态应该怎么变化？”

Interceptor 回答：

“眼前这一次模型调用或工具调用，
应该怎么修改、包装、重试或短路？”
```

需要状态、跳转、中断、恢复、Checkpoint 时选 Hook；只处理一次模型或工具调用时选
Interceptor。

## 11. 推荐源码阅读顺序

1. [`Hook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/Hook.java)
2. [`AgentHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/AgentHook.java)
   与
   [`ModelHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/ModelHook.java)
3. `ReactAgent.initGraph()`、`setupHookEdges()` 与 `addHookEdge()`
4. [`ModelInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/ModelInterceptor.java)
   与
   [`ToolInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/ToolInterceptor.java)
5. [`InterceptorChain`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/InterceptorChain.java)
6. `AgentLlmNode.apply()` 与 `AgentToolNode.executeToolCallWithInterceptors()`
7. `HumanInTheLoopHook`、`SummarizationHook`、`ModelRetryInterceptor` 和
   `ToolRetryInterceptor`
