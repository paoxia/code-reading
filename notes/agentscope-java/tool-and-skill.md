# Tool 与 Skill 实现分析

## 概述

AgentScope Java 的 Tool 子系统统一收口到 `AgentTool` 接口，提供四种实现方式：注解反射、抽象基类、MCP 远程工具、子 Agent 工具。Skill 是独立概念，本质是 Markdown 知识包，通过 Tool Group 与 Tool 解耦组合。

## 1. Tool 的三种定义方式

所有 Tool 最终都实现 `AgentTool` 接口（`agentscope-core/src/main/java/io/agentscope/core/tool/AgentTool.java:40`）：

```java
public interface AgentTool {
    String getName();
    String getDescription();
    Map<String, Object> getParameters();          // JSON Schema
    default Boolean getStrict() { return null; }
    default Map<String, Object> getOutputSchema() { return null; }
    default boolean isReadOnly() { return false; }
    Mono<ToolResultBlock> callAsync(ToolCallParam param);  // 响应式执行
}
```

整个框架基于 Project Reactor，`callAsync` 返回 `Mono<ToolResultBlock>`。

### 1.1 `@Tool` 注解方式（最常用）

注解定义（`tool/Tool.java:60`）：

```java
@Target({ElementType.METHOD, ElementType.ANNOTATION_TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface Tool {
    String name() default "";
    String description() default "";
    boolean strict() default false;
    boolean readOnly() default false;
    boolean concurrencySafe() default true;
    boolean externalTool() default false;       // 通过 TOOL_SUSPENDED 暴露而非执行
    boolean stateInjected() default false;      // 方法接受 AgentState 参数
    String[] dangerousFiles() default {};
    String[] dangerousDirectories() default {};
    Class<? extends ToolResultConverter> converter() default DefaultToolResultConverter.class;
}
```

参数注解（`tool/ToolParam.java:62`）：

```java
@Target({ElementType.PARAMETER, ElementType.FIELD, ElementType.ANNOTATION_TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface ToolParam {
    String name();                    // 必需 - Java 运行时不保留参数名
    boolean required() default true;
    String description() default "";
}
```

**示例 - `TodoTools`**（`tool/builtin/TodoTools.java:92`）：

```java
@Tool(
        name = "todo_write",
        description = DESCRIPTION,
        stateInjected = true,         // AgentState 由框架注入，不暴露给 LLM
        readOnly = false,
        concurrencySafe = false)
public String todoWrite(
        @ToolParam(name = "todos", description = "The COMPLETE updated todo list...")
        List<TodoItem> todos,
        AgentState state) {           // 按类型注入，LLM 不可见
    ...
}
```

**返回类型支持**（`ToolMethodInvoker.invokeAsync`, `ToolMethodInvoker.java:55`）：
- `String` / POJO - 同步，包成 `Mono.fromCallable`
- `Mono<T>` - 异步，flatMap
- `CompletableFuture<T>` - 异步，`Mono.fromFuture`

**框架自动注入的参数类型**（不需要 `@ToolParam`，见 `ToolMethodInvoker.convertParameters` at `:149`）：
- `ToolEmitter` - 执行中流式推送
- `Agent` - 调用方 agent 实例
- `AgentState` - 当 `@Tool(stateInjected=true)`
- `RuntimeContext` / `ToolExecutionContext`
- 任何用户自定义 POJO（按类型从 `RuntimeContext` 解析）

### 1.2 `ToolBase` 抽象类（程序化构建）

文件：`tool/ToolBase.java:60`

```java
public abstract class ToolBase implements AgentTool {
    protected ToolBase(Builder builder) { ... }

    @Override
    public Mono<ToolResultBlock> callAsync(ToolCallParam param) { ... }

    // 权限钩子：ALLOW / ASK / DENY
    public Mono<PermissionDecision> checkPermissions(
            Map<String, Object> toolInput, PermissionContextState context) {
        return Mono.just(PermissionDecision.passthrough(name));
    }

    public boolean matchRule(String ruleContent, Map<String, Object> toolInput) { ... }
    public List<PermissionRule> generateSuggestions(Map<String, Object> toolInput) { ... }
    protected boolean isDangerousPath(String filePath) { ... }  // 符号链接感知

    public static final class Builder {
        // .name, .description, .inputSchema, .readOnly, .concurrencySafe,
        // .externalTool, .stateInjected, .mcp(mcpName), .dangerousFiles, .dangerousDirectories
    }
}
```

`ToolBase` 额外提供：
1. **权限集成** - 子类可重写 `checkPermissions`、`matchRule`、`generateSuggestions` 参与 `PermissionEngine`
2. **危险路径检测** - Bash 类工具标记敏感文件/目录
3. **Builder 模式** - 安全标志位（`readOnly`、`concurrencySafe`、`externalTool`、`mcp`）

**核心子类**：

| 子类 | 文件 | 用途 |
|---|---|---|
| `ReflectiveFunctionTool` | `tool/ReflectiveFunctionTool.java:39` | 包装每个 `@Tool` 注解方法 |
| `SchemaOnlyTool` | `tool/SchemaOnlyTool.java:57` | 外部工具，只有 schema，调用时抛 `ToolSuspendException` |
| `McpTool` | `tool/mcp/McpTool.java:51` | 包装远程 MCP 工具，委托 `McpClientWrapper.callTool` |

### 1.3 直接实现 `AgentTool`

不需要权限集成的工具可直接实现接口。例如：

- `ShellCommandTool`（`tool/coding/ShellCommandTool.java:73`）- 带白名单和超时的 shell 执行
- `SubAgentTool`（`tool/subagent/SubAgentTool.java:62`）- 把另一个 `ReActAgent` 包成可调用工具

## 2. Tool 的注册与发现

### 2.1 `Toolkit` 门面

文件：`tool/Toolkit.java:66`

委托给多个专职协作者（同包下）：

| 协作者 | 文件 | 职责 |
|---|---|---|
| `ToolRegistry` | `tool/ToolRegistry.java:40` | name -> `AgentTool` 查找（ConcurrentHashMap） |
| `ToolGroupManager` | `tool/ToolGroupManager.java` | 工具组 CRUD + 活跃组追踪 |
| `ToolSchemaProvider` | `tool/ToolSchemaProvider.java` | 按活跃组过滤生成 schema |
| `McpClientManager` | `tool/McpClientManager.java` | MCP 客户端生命周期 |
| `MetaToolFactory` | `tool/MetaToolFactory.java` | 构建 `reset_equipped_tools` 元工具 |
| `ToolSchemaGenerator` | `tool/ToolSchemaGenerator.java` | 反射 -> JSON Schema |
| `ToolMethodInvoker` | `tool/ToolMethodInvoker.java:38` | 反射调用 + 类型转换 |
| `ToolExecutor` | `tool/ToolExecutor.java:58` | 单/批执行，超时、重试、调度 |

### 2.2 注册入口

`Toolkit` 上：

- `registerTool(Object toolObject)`（`:154`）- 反射扫描 `@Tool` 方法，每个包成 `ReflectiveFunctionTool`
- `registerAgentTool(AgentTool tool)`（`:203`）- 注册预构建的 `AgentTool`
- `registerSchema(ToolSchema schema)`（`:294`）- 只注册 schema（外部工具，包成 `SchemaOnlyTool`）
- `registerMcpClient(McpClientWrapper)`（`:538`）- 委托 `McpClientManager`，发现远程工具注册为 `McpTool`
- `registerMetaTool()`（`:743`）- 注册 `reset_equipped_tools` 元工具用于运行时组控制

### 2.3 流式 Builder API

文件：`Toolkit.java:804`（内部类 `ToolRegistration`）

```java
toolkit.registration()
    .tool(new WeatherTools())                // 或 .agentTool(...) / .mcpClient(...) / .subAgent(...)
    .group("myGroup")                        // 可选工具组
    .presetParameters(Map.of(                // 可选隐藏参数（不在 LLM schema 里）
        "get_weather", Map.of("apiKey", "secret")))
    .extendedModel(extendedModel)            // 可选动态 schema 扩展
    .enableTools(List.of("tool1"))           // 仅 MCP：白名单
    .disableTools(List.of("tool2"))           // 仅 MCP：黑名单
    .apply();
```

### 2.4 `ToolRegistry` - 内部映射

文件：`tool/ToolRegistry.java:40`

线程安全的 `ConcurrentHashMap<String, AgentTool>` + 平行的 `RegisteredToolFunction` 元数据（预设参数、MCP 客户端名、扩展模型）。唯一变更点：

```java
void registerTool(String toolName, AgentTool tool, RegisteredToolFunction registered) {
    tools.put(toolName, tool);
    registeredTools.put(toolName, registered);
}
```

### 2.5 Tool Groups（动态激活）

文件：`tool/ToolGroupManager.java`、`tool/ToolGroup.java`、`tool/SkillToolGroup.java`、`tool/ToolGroupScope.java`

工具可放入命名组。**只有活跃组里的工具（或无组工具）才对 LLM 可见、可调用**。`MetaToolFactory` 创建特殊的 `reset_equipped_tools` 工具，让 LLM 自己在运行时切换组（`Toolkit.registerMetaTool()` at `:743`）。

`SkillToolGroup` 子类通过 `activateOnSkill` 把组绑定到 skill 名。

### 2.6 Schema 生成与发现

`ToolSchemaProvider.getToolSchemas(activeGroups)`（`Toolkit.java:349`）遍历注册表，按活跃组过滤，返回 `List<ToolSchema>`，每项含 `name`、`description`、`parameters`（JSON Schema）、`strict` 标志。这个列表就是发给 LLM 的 function calling 规格。

`@Tool` 方法的 schema 由 `ToolSchemaGenerator.generateParameterSchema(method, presetParamNames)` 生成 - 遍历方法的 `Parameter[]`，读 `@ToolParam` 注解，产出 JSON Schema properties（排除 `ToolEmitter`、`Agent`、`AgentState`、`RuntimeContext` 等框架注入类型）。

## 3. 端到端 Tool 调用流程

由 `ReActAgent` 的推理/行动循环驱动。关键代码在 `ReActAgent.java`（4662 行）的 acting 阶段（行 2290-3010 附近的内部类）。

### 步骤分解

1. **LLM 返回 tool call** - 模型的 `ChatResponse` 携带 `ToolUseBlock`（`message/ToolUseBlock.java:34`）：
   ```java
   private final String id;                          // 唯一调用 id
   private final String name;                        // 工具名
   private final Map<String, Object> input;          // 解析后的参数
   private final String content;                     // 原始流式内容
   private final Map<String, Object> metadata;       // 供应商特定
   private final ToolCallState state;                // PENDING / ALLOWED / ASKING / ...
   ```

2. **Acting 阶段入口** - `acting(int iter)` at `ReActAgent.java:2311`，从最后一条 assistant 消息里抽 pending `ToolUseBlock`

3. **Pre-acting hooks** - `hookDispatcher.firePreActing(pendingToolCalls, toolkit)`（`:2327`）

4. **中间件链** - `MiddlewareChain.build(middlewares, ..., MiddlewareBase::onActing, actingCore).apply(new ActingInput(toolCalls))`（`:2333`）

5. **权限评估** - `actingStream`（`:2420`）调 `evaluatePermissions(toolCalls)`（`:2690`）。对每个 `ToolUseBlock`，权限引擎问 `ToolBase.checkPermissions(...)`：
   - ALLOW -> 标 `ToolCallState.ALLOWED`，立即执行
   - ASK -> 标 `ToolCallState.ASKING`，agent 返回 `GenerateReason.PERMISSION_ASKING`，等人工
   - DENY -> 合成 `ToolResultBlock`（`ToolResultState.DENIED`，"Permission denied by rules"），追加到上下文不执行

6. **批量分发** - `runToolBatch`（`:2508`）按 `concurrencySafe` 分并行/串行，调 `executeToolCalls`（`:2856`） -> `dispatchToolCalls`（`:2907`）

7. **Toolkit 分发** - `toolkit.callTools(toolCalls, toolExecutionConfig, this, runtimeContext)`（`Toolkit.java:511`）：
   ```java
   public Mono<List<ToolResultBlock>> callTools(
           List<ToolUseBlock> toolCalls,
           ExecutionConfig agentExecutionConfig,
           Agent agent,
           RuntimeContext agentRuntimeContext) {
       ExecutionConfig effectiveConfig = ExecutionConfig.mergeConfigs(
               agentExecutionConfig,
               ExecutionConfig.mergeConfigs(config.getExecutionConfig(), ExecutionConfig.TOOL_DEFAULTS));
       return executor.executeAll(toolCalls, config.isParallel(), effectiveConfig, agent, agentRuntimeContext);
   }
   ```

8. **执行器基础设施** - `ToolExecutor.executeAll`（`:305`）按 `concurrencySafe` 分块：
   - 并发安全的连续段通过 `Flux.mergeSequential` 并发跑
   - 非并发安全的形成串行槽（`:336`）

   每个调用 `executeWithInfrastructure`（`:374`）叠加：
   - `applyScheduling` - `Schedulers.boundedElastic()` 或用户 `ExecutorService`
   - `applyTimeout` - `Mono.timeout(config.getTimeout())`
   - `applyRetry` - `Retry.backoff(...)` 可配置过滤器
   - `applyShutdownGuard` - 与全局优雅关闭信号竞速

9. **核心执行** - `executeCore(param)`（`:184`）：
   1. 查工具：`AgentTool tool = toolRegistry.getTool(toolCall.getName());`
   2. **外部工具短路** - 若 `tool instanceof ToolBase tb && tb.isExternalTool()`，立即返回 `ToolResultBlock.suspended(...)`（不做 schema 校验、不执行）
   3. **组激活检查** - `groupManager.isActiveTool(name)`；不活跃工具返回 "Unauthorized tool call" 错误
   4. **Schema 校验** - `ToolValidator.validateInput(toolCall.getContent(), tool.getParameters())`；失败变成 `ToolResultBlock.error(...)` 让 LLM 重试
   5. **Runtime-context 合并** - 参数级 context 优先于 toolkit 默认（`ToolExecutionContext.merge(...)`）
   6. **Emitter 创建** - `DefaultToolEmitter` 包装 chunk 回调
   7. **预设参数合并** - `RegisteredToolFunction.getPresetParameters()` 叠加到 `param.getInput()` 上，框架控制的值覆盖 LLM 提供的值
   8. 构建 `ToolCallParam`，调 `tool.callAsync(executionParam)`
   9. **错误处理** - `onErrorResume(ToolSuspendException.class, ...)` 转成 suspended 结果；其他错误变 `ToolResultBlock.error(...)`

10. **按子类分发**：
    - `ReflectiveFunctionTool.callAsync` -> `methodInvoker.invokeAsync(...)` - 用 `JsonUtils.getJsonCodec().convertValue(...)` 转参数，反射调用方法，结果过 `ToolResultConverter`
    - `McpTool.callAsync`（`mcp/McpTool.java:180`）- 合并预设参数，调 `clientWrapper.callTool(name, args, metaMap)`，`McpContentConverter` 转结果
    - `SchemaOnlyTool.callAsync`（`:136`）-> `Mono.error(new ToolSuspendException())`
    - `SubAgentTool.callAsync`（`:111`）- 创建/加载子 agent session，运行，事件转发给 emitter
    - 手写的 `AgentTool`（如 `ShellCommandTool`）跑自己的逻辑

11. **Post-acting** - 每个成功结果，`notifyPostActingHook`（`:2993`）触发 `PostActingEvent`，设 `ToolResultState`（RUNNING -> COMPLETED/ERROR），`ToolResultMessageBuilder.buildToolResultMsg(...)` 包成 tool-result `Msg` 追加到 agent 上下文。Suspended 结果短路成 `TOOL_SUSPENDED` 消息返回调用方。

12. **循环** - 所有工具 resolve 后，`acting` 递归到 `executeIteration(iter + 1)` - LLM 带更新后的上下文（assistant 消息 + tool 结果）再次调用，循环直到 LLM 输出最终答案（无 `ToolUseBlock`）或达到 `maxIters`。

### 流式输出

`ToolEmitter`（`tool/ToolEmitter.java`）注入到需要的工具里。工具可调 `emitter.emit(partialResult)` 推送中间块到 UI。`DefaultToolEmitter` 通过 `BiConsumer<ToolUseBlock, ToolResultBlock>` 回调路由（用户用 `Toolkit.setChunkCallback(...)`，框架用 `setInternalChunkCallback(...)` - `ReActAgent` 用它触发 `ActingChunkEvent` hooks）。

## 4. Skill：与 Tool 的关系

**Skill 和 Tool 是独立但可组合的概念。** Skill 是 Markdown 知识包（含可选资源文件和可选 Tools 包），LLM 可按需加载。Tool 是执行表面；Skill 是包装工具的交付、文档、懒激活层。

### 4.1 Skill 是什么

文件：`skill/AgentSkill.java:68`

```java
public class AgentSkill {
    private final Map<String, Object> metadata;       // name, description, 加任意键
    private final String skillContent;               // SKILL.md 正文
    private final Map<String, String> resources;      // 支持文件（脚本、参考）
    private final String source;                      // 来源标识
    private final Path originDir;                     // 磁盘 skill 目录（可选）

    public String getSkillId() { return getName() + "_" + source; }
}
```

Skill 通常写成 `SKILL.md` 文件带 YAML frontmatter。示例（`agentscope-examples/documentation/src/main/resources/skills/data-analysis/SKILL.md`）：

```markdown
---
name: data-analysis
description: Statistical data analysis skill - use when the user asks to analyze numbers...
---

# Data Analysis

You are a data analysis assistant. When the user provides numbers or datasets:
1. Use `analyze_data` to compute basic statistics...
2. Use `write_summary` to save analysis results...
```

### 4.2 Skill 存储 - Repository

接口：`skill/repository/AgentSkillRepository.java:35`

```java
public interface AgentSkillRepository extends AutoCloseable {
    AgentSkill getSkill(String name);
    List<String> getAllSkillNames();
    List<AgentSkill> getAllSkills();
    boolean save(List<AgentSkill> skills, boolean force);
    boolean delete(String skillName);
    boolean skillExists(String skillName);
    AgentSkillRepositoryInfo getRepositoryInfo();
    String getSource();
    void setWriteable(boolean writeable);
    boolean isWriteable();
}
```

**五种实现**：
- `FileSystemSkillRepository`（`skill/repository/FileSystemSkillRepository.java:60`）- 目录式 `<skill-name>/SKILL.md`，mtime 缓存
- `ClasspathSkillRepository` - JAR 资源
- `GitSkillRepository`（`agentscope-extensions/agentscope-extensions-skills/agentscope-extensions-skill-git-repository/.../GitSkillRepository.java:39`）- 克隆远程 Git 仓库读子目录（读时自动同步）
- `MysqlSkillRepository`
- `PostgresSkillRepository`

### 4.3 Skill Registry 与 Load Tool

- `SkillRegistry`（`skill/SkillRegistry.java:39`）- 纯存储：`Map<String, AgentSkill>` + `Map<String, RegisteredSkill>`。`RegisteredSkill`（`skill/RegisteredSkill.java:25`）追踪 per-skill 激活状态并派生工具组名：
  ```java
  public String getToolsGroupName() { return skillId + "_skill_tools"; }
  ```
- `SkillBox`（`skill/SkillBox.java:44`）- 公共门面，持有 `SkillRegistry` + `SkillToolFactory` + `AgentSkillPromptProvider`。`registerSkill(AgentSkill)`（`:242`）入注册表；`registerSkillLoadTool()`（`:636`）注册单个 `load_skill_through_path` 的 `AgentTool`（由 `SkillToolFactory.createSkillAccessToolAgentTool()` at `skill/SkillToolFactory.java:79` 构建）

`load_skill_through_path` 工具是唯一的内置 skill 工具。LLM 调用它（`path="SKILL.md"`）时：
1. 返回 skill 的 markdown 内容
2. 调 `activateSkill(skillId)`（`SkillToolFactory.java:370`）：
   - 设 `RegisteredSkill.active = true`
   - 激活 skill 的 tool group `<skillId>_skill_tools`（通过 `toolkit.updateToolGroups(...)`）
   - 找 `activateOnSkill` 匹配的 `SkillToolGroup`，一并激活

**这就是 Skill 与 Tool 的桥梁：加载 skill 切换 tool-group 可见性**，下一轮 LLM 就能看到对应的 `AgentTool`。

### 4.4 通过中间件动态加载 Skill

文件：`skill/DynamicSkillMiddleware.java:60`

`DynamicSkillMiddleware` 实现 `MiddlewareBase` + `ToolkitAware`。每次 `agent.call()` 时，`onSystemPrompt` hook（`:129`）：
1. 从配置的 repository 重载 skills（`reloadSkills(ctx)` at `:166`）
2. 用可见 skills 构建新的 `SkillBox`
3. `box.bindToolkit(toolkit)` + `box.registerSkillLoadTool()` 把 `load_skill_through_path` 接到活跃 toolkit
4. 把 skill catalog 提示追加到系统提示，让 LLM 知道有哪些 skill、怎么加载

内容指纹（SHA-256）短路（`:314`），合并视图未变就不重建。

### 4.5 把 Tool 绑到 Skill 的两种方式

**(a) 命名约定组** - `SkillRegistration.apply()`（`SkillBox.java:589`）自动创建 `<skillId>_skill_tools` 组并注册工具：

```java
String skillToolGroup = skill.getSkillId() + "_skill_tools";
toolkit.createToolGroup(skillToolGroup, skillToolGroup, false);   // 默认不活跃
toolkit.registration()
    .group(skillToolGroup)
    .tool(toolObject)
    .agentTool(agentTool)
    .mcpClient(mcpClientWrapper)
    .subAgent(subAgentProvider, subAgentConfig)
    .apply();
```

**(b) `SkillToolGroup` with `activateOnSkill`** - 通过 `Toolkit.createSkillToolGroup(name, desc, active, activateOnSkill)` 创建（`Toolkit.java:605`）。当任何名字匹配 `activateOnSkill` 的 skill 被加载，`SkillToolFactory.activateSkill(...)`（`SkillToolFactory.java:386`）通过 `toolkit.findSkillToolGroupsByActivateOnSkill(name)`（`Toolkit.java:617`）找到匹配组并激活。

**完整示例**（`agentscope-examples/documentation/src/main/java/io/agentscope/examples/documentation2/skill/SkillWithToolGroupExample.java:125`）：

```java
Toolkit toolkit = new Toolkit();
toolkit.createSkillToolGroup(
        "data-analysis-tools",
        "Tools exposed when the 'data-analysis' skill is active",
        false,
        "data-analysis");                         // activateOnSkill
toolkit.registration().tool(new DataTools()).group("data-analysis-tools").apply();
toolkit.registerTool(new InfoTool());              // 常驻普通工具

FileSystemSkillRepository skillRepo = new FileSystemSkillRepository(skillsDir, false);
ReActAgent agent = ReActAgent.builder()
        .toolkit(toolkit)
        .skillRepository(skillRepo)                 // 自动接入 DynamicSkillMiddleware
        .enableMetaTool(true)
        ...build();
```

当 LLM 调 `load_skill_through_path(skillId="data-analysis_custom", path="SKILL.md")`，`data-analysis-tools` 组激活，`analyze_data` / `write_summary` 工具在下一轮对 LLM 可见。

### 4.6 Skill vs Tool 对照

| 维度 | Tool | Skill |
|---|---|---|
| 本质 | 暴露给 LLM 的可执行函数 | Markdown 知识包 |
| 定义方式 | `@Tool`/`AgentTool`/MCP/sub-agent | `AgentSkill`，常由 `SKILL.md` 加载 |
| LLM 直接调用 | 是（返回 `ToolResultBlock`） | 否 - 通过 `load_skill_through_path` 工具加载 |
| 生命周期 | 注册即常驻（除非分组未激活） | 按需懒加载，激活工具组 |
| 存储 | `ToolRegistry` | `SkillRegistry`，后端有 FileSystem/Classpath/Git/MySQL/PostgreSQL |
| 桥梁 | `Toolkit.createSkillToolGroup(..., activateOnSkill)` 把组绑到 skill 名；`SkillBox.SkillRegistration` 让 skill 注册自己的工具 |

**结论**：Skill 不是 Tool 的一种，Tool 也不是 Skill 的一种。**连接点是 Tool Group** - Skill 可拥有（或激活）一个或多个 tool group，加载 Skill 时把这些组打开。

## 5. 关键文件清单

### Tool 子系统 - `agentscope-core/src/main/java/io/agentscope/core/tool/`

| 文件 | 用途 |
|---|---|
| `AgentTool.java` | 通用工具接口 - name/description/parameters/callAsync |
| `Tool.java` | `@Tool` 方法注解 |
| `ToolParam.java` | `@ToolParam` 参数注解 |
| `ToolBase.java` | 抽象基类，含权限和危险路径钩子 + Builder |
| `ReflectiveFunctionTool.java` | `@Tool` 方法生成的 `ToolBase` 子类 |
| `SchemaOnlyTool.java` | 外部（仅 schema）工具，调用抛 `ToolSuspendException` |
| `mcp/McpTool.java` | 包装远程 MCP 工具 |
| `subagent/SubAgentTool.java` | 把另一个 `ReActAgent` 包成带会话的可调用工具 |
| `Toolkit.java` | 中央门面 - registerTool / registerAgentTool / registerSchema / registerMcpClient / registerMetaTool / callTool / callTools + 流式 `ToolRegistration` |
| `ToolRegistry.java` | 内部 name -> `AgentTool` 映射 |
| `ToolExecutor.java` | 单/批执行 - 并行/串行分区、超时、重试、调度、shutdown guard |
| `ToolMethodInvoker.java` | 反射调用 + 参数转换 |
| `ToolCallParam.java` | `callAsync` 的不可变参数对象 |
| `ToolValidator.java` | 执行前 JSON Schema 校验 |
| `ToolSchemaGenerator.java` | 从 `@Tool` 方法参数构建 JSON Schema |
| `ToolSchemaProvider.java` | 按活跃组过滤返回 `List<ToolSchema>` |
| `ToolGroupManager.java`、`ToolGroup.java`、`SkillToolGroup.java`、`ToolGroupScope.java` | 工具组 CRUD + 激活追踪 |
| `MetaToolFactory.java` | 构建 `reset_equipped_tools` 元工具 |
| `McpClientManager.java` | MCP 客户端生命周期 |
| `ToolkitConfig.java`、`ToolkitAware.java` | 配置 + rebinding 接口 |
| `ToolEmitter.java`、`DefaultToolEmitter.java`、`NoOpToolEmitter.java` | 流式进度通道 |
| `ToolResultConverter.java`、`DefaultToolResultConverter.java` | 方法返回值转 `ToolResultBlock` |
| `ToolResultMessageBuilder.java` | `ToolResultBlock` 包成 `Msg` |
| `ToolSuspendException.java` | 外部工具挂起信号 |
| `builtin/TodoTools.java` | 内置 `todo_write` 示例 |
| `coding/ShellCommandTool.java`、`coding/CommandValidator.java` | 带白名单的 shell 执行 |
| `file/ReadFileTool.java`、`file/WriteFileTool.java` | 文件 I/O 工具 |

### Skill 子系统 - `agentscope-core/src/main/java/io/agentscope/core/skill/`

| 文件 | 用途 |
|---|---|
| `AgentSkill.java` | 数据模型 - metadata/content/resources/source/originDir |
| `AgentSkillPromptProvider.java` | 构建系统提示片段，广告可用 skill |
| `SkillBox.java` | 公共管理器 - 注册 skill，持有 registry + factory + prompt provider |
| `SkillRegistry.java` | 内部 name -> `AgentSkill` 映射 |
| `RegisteredSkill.java` | per-skill 元数据（active 标志 + `getToolsGroupName()`） |
| `SkillToolFactory.java` | 构建 `load_skill_through_path` 工具；`activateSkill(...)` 切换组 |
| `DynamicSkillMiddleware.java` | 每次调用重载 skill + 追加 catalog 到系统提示 |
| `SkillFilter.java`、`SkillFileFilter.java`、`SkillHook.java` | 过滤钩子 |
| `repository/AgentSkillRepository.java` | Repository 接口 |
| `repository/FileSystemSkillRepository.java` | 文件系统实现 |
| `repository/ClasspathSkillRepository.java` | Classpath 实现 |
| `util/MarkdownSkillParser.java`、`util/SkillUtil.java`、`util/SkillFileSystemHelper.java` | SKILL.md frontmatter 解析 |

### 端到端流程 - `agentscope-core/src/main/java/io/agentscope/core/`

- `ReActAgent.java`（4662 行）关键方法：
  - `acting(int iter)` at `:2311`
  - `actingStream(...)` at `:2420` - 权限门 + 流发射
  - `evaluatePermissions(toolCalls)` at `:2690`
  - `runToolBatch(...)` at `:2508`
  - `executeToolCalls(toolCalls)` at `:2856`
  - `dispatchToolCalls(toolCalls)` at `:2907` - 路由到 `toolkit.callTools(...)` 或结构化输出工具
  - `notifyPostActingHook(entry)` at `:2993` - 触发 `PostActingEvent`，构建 tool-result `Msg`

### 消息类型 - `agentscope-core/src/main/java/io/agentscope/core/message/`

- `ToolUseBlock.java` - 请求块（id/name/input/content/metadata/`ToolCallState`）
- `ToolResultBlock.java` - 响应块（text/error/suspended 变体；`ToolResultState`: RUNNING/COMPLETED/ERROR/DENIED/SUSPENDED）
- `ContentBlock.java` - 所有消息内容基类
