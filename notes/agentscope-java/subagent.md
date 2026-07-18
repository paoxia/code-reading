# SubAgent 实现分析

## 概述

AgentScope Java 有**两套并行的 subagent 系统**：

| | Core `SubAgentTool` | Harness `AgentSpawnTool` |
|---|---|---|
| 定位 | 轻量通用 Agent 包装 | 完整工业级系统，含工作区/沙箱/异步任务 |
| 入口 | `agentscope-core/.../tool/subagent/SubAgentTool.java:62` | `agentscope-harness/.../tool/AgentSpawnTool.java:89` |
| 工具名 | 由 `SubAgentConfig.toolName` 决定 | `agent_spawn` / `agent_send` / `agent_list` |

SubAgent 本质上是把另一个 Agent 包成 `AgentTool`，跟普通 tool 走同一套调用链。

## 1. SubAgent 架构核心

### 1.1 关键抽象

- **`AgentTool` 接口收口** - subagent 实现就是 `AgentTool` 的一种。
- **`SubAgentProvider<T extends Agent>`**（`SubAgentProvider.java:42`）- 函数式接口，`T provide()`。每次调用产**全新 agent 实例**。
- **`SubAgentConfig`**（`SubAgentConfig.java:61`）- 五个旋钮：
  - `toolName` - 覆盖；默认 `call_<lowercased agent name>`（sanitize，非 ASCII 或过长加 hash 后缀；见 `sanitizeName` at `SubAgentTool.java:508`）
  - `description` - 覆盖；默认 `agent.getDescription()` 或 `"Call {name} to complete tasks"`
  - `forwardEvents` - 是否把子 agent 事件（reasoning chunks、tool chunks）转发给父 `ToolEmitter`，默认 true
  - `streamOptions` - 事件类型过滤和流式模式
  - `stateStore` - `AgentStateStore` 持久化子 agent state，默认 `InMemoryAgentStateStore`，可换 `JsonFileAgentStateStore` 跨重启持久化
- **`SubagentFactory`**（harness, `SubagentFactory.java:37`）- `Agent create(RuntimeContext parentRc)`，多收父 `RuntimeContext` 用于派生子 session id

### 1.2 为什么要 fresh 实例

`ReActAgent` **非线程安全**（`ReActAgent.java:197-203`），每次 tool 调用都得新实例。Provider / Factory 模式兜底。

子 agent 与父 `ReActAgent` 之间**无反向引用**：父注册一个 `SubAgentTool`，LLM 调用时 provider/factory 产新实例，子跑自己的 ReAct 循环。

### 1.3 `callAsync` 端到端

`SubAgentTool.callAsync`（`SubAgentTool.java:111`）-> `executeConversation`（`:130`）：

1. 从 tool input 解析 `session_id`，没有就 `UUID.randomUUID()`（`:140`）
2. 解析 `message`，空就报错
3. `agentProvider.provide()` 拿新 agent（`:151`）
4. 续接 session 时：`loadAgentState(sessionId, agent)` 从 `AgentStateStore` 恢复（`:154-156`）
5. `message` 包成 USER `Msg`
6. 按 `forwardEvents` 分流：
   - `executeWithStreaming`（`:309`）- 调 `reActAgent.stream(...)`，每个 event 通过 `forwardEvent` 转 `emitter.emit(new ToolResultBlock(... metadata))`，metadata 带 `subagent_event`/`subagent_name`/`subagent_id`/`subagent_session_id`。`filter(Event::isLast).last()` 抽最终事件
   - `executeWithoutStreaming`（`:355`）- 调 `reActAgent.call(...)`
7. `doFinally(CANCEL)`（`:204-210`）- 父订阅取消时 `interruptAgent(agent, runtimeContext)` -> `ra.interrupt(ctx)`，防孤儿 agent 继续 LLM/tool 调用
8. `doOnSuccess`（`:213`）- `saveAgentState(finalSessionId, agent)` 持久化

**输出格式**（`SubAgentTool.java:425`）：
```
session_id: <id>

<子agent回复>
```
JSON schema 描述里告诉 LLM："续接对话要从上一次响应里抽 `session_id` 再传回来"。

### 1.4 状态恢复 - `applyLoadedState`

`SubAgentTool.java:283-295` 做**整体替换**：

```java
private static void applyLoadedState(ReActAgent agent, AgentState loaded) {
    AgentState live = agent.getAgentState();
    if (live == null) return;
    live.contextMutable().clear();
    live.contextMutable().addAll(loaded.getContext());
    live.setSummary(loaded.getSummary());
    live.setReplyId(loaded.getReplyId());
    live.setCurIter(loaded.getCurIter());
    live.setShutdownInterrupted(loaded.isShutdownInterrupted());
    live.getToolContext().setActivatedGroups(loaded.getToolContext().getActivatedGroups());
}
```

## 2. 上下文管理

### 2.1 上下文存储位置

**唯一权威位置**：`AgentState.contextMutable()` - `List<Msg>`（`AgentState.java:64,186`）

`AgentState` 是 v2.0 替代旧 `Memory` 接口的设计：

```java
public final class AgentState implements State {
    private final String sessionId;
    private final String userId;
    private String summary;
    private final List<Msg> context;       // <-- 对话缓冲
    private String replyId;
    private int curIter;
    private boolean shutdownInterrupted;
    private PermissionContextState permissionContext;
    private final ToolContextState toolContext;
    private final TaskContextState tasksContext;
    private final PlanModeContextState planModeContext;
}
```

### 2.2 父子之间不共享上下文

- 父有 `AgentState`，按 `(userId, sessionId)` 缓存在 `ReActAgent.stateCache`（`ReActAgent.java:267`）
- 子有独立 `AgentState`，存在子自己的 `AgentStateStore`

跨边界的只有两样：
1. **入**：父 LLM 输出的 `message` 字符串 -> 子的 USER `Msg`
2. **出**：子最终回复文本 -> 包成 `ToolResultBlock` 回到父 context（TOOL 角色）

### 2.3 三层上下文压缩

#### A. 主压缩：`CompactionMiddleware` + `ConversationCompactor`（harness）

文件：`agentscope-harness/.../middleware/CompactionMiddleware.java:57` 和 `memory/compaction/ConversationCompactor.java:57`

在每次 `onReasoning`（LLM 调用前）触发，七步算法（`ConversationCompactor.java:41-56`）：

1. **Arg 截断（非 LLM）** - 老消息里过大的 `ToolUseBlock` 参数值截断（`truncateArgs`, `:594-628`）
2. **Tool 结果裁剪（非 LLM）** - 倒序扫 TOOL 消息，保护最近 `protectTokens` 的工具输出，老的用 `head + "\n\n...(N chars pruned)...\n\n" + tail` 预览替换（`pruneToolResults`, `:492-571`）
3. **触发判定** - `messages.size() >= triggerMessages` 或 `totalTokens >= triggerTokens`，触发 token 可动态 = `model.getContextWindowSize() - reserved`（`shouldCompact`, `:207-224`）
4. **找切点** - 二分或按消息数。关键：`findSafeCutoffPoint`（`:286-328`）倒序走，**避免把 ASSISTANT tool-call 和它的 TOOL result 切开**
5. **记忆 flush（可选，LLM）** - 把可记事实抽到 `memory/YYYY-MM-DD.md`（`flushManager.flushMemories(rc, prefix)`）
6. **消息外存（可选）** - 完整对话落盘到 `agents/<agentId>/sessions/<sessionId>.log.jsonl`（`flushManager.offloadMessages`）
7. **LLM 摘要** - 一次模型调用，`config.getSummaryPrompt().replace("{messages}", formatted)`（`summarizePrefix`, `:334-371`）

重建：`[summaryUserMsg] + preservedTail`。summary 消息带 `name="__compaction_summary__"`，方便后续过滤（`filterSummaryMessages`, `:474-478`）。

中间件清空 `AgentState.contextMutable()` 并替换为压缩后列表（`CompactionMiddleware.java:213-226`）。

Token 计数：`TokenCounterUtil.calculateToken`。

#### B. 结构化输出路径压缩（core）

`ReActAgent.compressStructuredOutputContext`（`:1191-1217`）：fallback 走合成 `generate_response` tool 时，调用后把相关 bookkeeping 消息全部从 context 删除，只留最终结构化响应。**一次性、局部**。

```java
private void compressStructuredOutputContext(AgentState agentState) {
    List<Msg> contextMutable = agentState.contextMutable();
    List<Msg> original = new ArrayList<>(contextMutable);
    contextMutable.clear();
    for (Msg msg : original) {
        if (!isStructuredOutputRelated(msg)) {
            contextMutable.add(msg);
        }
    }
}
```

#### C. 超迭代总结（core）

`ReActAgent.summarizing()`（`:3029-3108`）：达到 `maxIters` 时，给 pending tool calls 生成 error `ToolResultBlock`，追加"总结当前局面"的 user 指令（`prepareSummaryMessages`, `:3218-3233`），做最终 LLM 调用（`summaryStream`，无 tool schemas），结果带 `GenerateReason.MAX_ITERATIONS` 追加。**只增不减**，不是压缩。

### 2.4 Per-session 缓存与并发

`ReActAgent.activateSlotForContext(RuntimeContext)`（`:442-483`）：

- 槽位 key = `(userId or "__anon__") + "/" + sessionId`（`slotKey`, `:341-344`）
- 配了 `stateStore` 时：**每次调用都从 store 重新加载**（适配分布式部署看到最新状态）
- 否则用内存 `stateCache: ConcurrentHashMap<String, AgentState>`（`:267`）
- `callSerializationKey`（`:503-513`）返回同一槽位 key -> **同一 session 调用串行，不同 session 并行**，per-session context 并发安全的根

### 2.5 `RuntimeContext` - 调用级状态包

文件：`agentscope-core/.../agent/RuntimeContext.java:33`

- `sessionId`、`userId` - 槽位身份
- `agentState` - **volatile 调用级** `AgentState`，由 ReActAgent 在调用入口设（`ReActAgent.java:530`）。中间件/工具应读 `rc.getAgentState()` 而不是 `agent.getAgentState()`（`:101-108`）
- `stringAttributes` / `typedAttributes` - `ConcurrentMap` 任意 KV
- `toolExecutionContext` - 工具 POJO 的 DI

`RuntimeContext.resolveAgentState(ctx, fallbackAgent)`（`:128-134`）是规范访问器：优先用调用级 state，没有时才回退到 agent 实例 state。

## 3. 记忆子系统

### 3.1 核心 Memory（已废弃）

目录 `agentscope-core/.../memory/`：

| 文件 | 状态 | 用途 |
|---|---|---|
| `Memory.java:35` | `@Deprecated(forRemoval=true, since="2.0.0")` | 旧接口：addMessage/getMessages/deleteMessage/clear/saveTo/loadFrom |
| `InMemoryMemory.java:37` | deprecated | CopyOnWriteArrayList，存在 `memory_messages` key |
| `StateBackedMemory.java:36` | deprecated | 委托给 `AgentState.contextMutable()` |
| `AgentStateMemoryView.java:43` | deprecated | 给旧 hook 的只读视图 |
| `LongTermMemory.java:70` | deprecated | 接口：`record(List<Msg>)`、`retrieve(Msg)` |
| `LongTermMemoryMode.java` | deprecated | 枚举：`AGENT_CONTROL`/`STATIC_CONTROL`/`BOTH` |
| `LongTermMemoryTools.java` | 存在 | AGENT_CONTROL 模式的工具函数 |
| `StaticLongTermMemoryHook.java:78` | deprecated | PreCall 检索、PostCall 记录 |

明确说明：*"Conversation context lives on `AgentState#getContext()`"*、*"Long-term memory is removed"*。

### 3.2 记忆类型

- **短期/工作记忆**：`AgentState.context` - 对话缓冲，per-session
- **长期记忆（旧，已 deprecated）** - `LongTermMemory` 接口在扩展里有实现：
  - `Mem0LongTermMemory`（`agentscope-extensions-mem0`）
  - `BailianLongTermMemory`（`agentscope-extensions-memory-bailian`）
  - `ReMeLongTermMemory`（`agentscope-extensions-reme`）
- **Harness 双层记忆（现行系统）**：
  - `MemoryFlushManager`（`agentscope-harness/.../memory/MemoryFlushManager.java:56`）- 每日 append-only 账本 `memory/YYYY-MM-DD.md`，压缩前用 LLM 从对话前缀抽事实
  - `MemoryConsolidator`（`agentscope-harness/.../memory/MemoryConsolidator.java`）- 周期性把每日条目合并进**精修、去重、有大小上限**的 `MEMORY.md`
  - `MemoryFlushMiddleware` / `MemoryMaintenanceMiddleware` - 串进 agent 生命周期

注释（`MemoryFlushManager.java:46-55`）：
```
memory/YYYY-MM-DD.md - append-only daily ledger. Written ONLY by this class.
MEMORY.md            - globally curated, deduplicated, size-bounded long-term memory.
                       Written ONLY by MemoryConsolidator on a periodic schedule.
```

### 3.3 记忆如何注入上下文

**旧 `StaticLongTermMemoryHook`**（`:124-199`）：
- `PreCallEvent` -> `longTermMemory.retrieve(lastUserMsg)` -> 包在 `<long_term_memory>` 标签里追加为 USER msg
- `PostCallEvent` -> 把 `memory.getMessages()` 全部记录到长期存储（同步或异步，1 worker 队列大小 3 的有界调度器）

**现行 harness 系统**：
- `MEMORY.md` 和 `memory/YYYY-MM-DD.md` 在构建系统提示时由 `WorkspaceManager` 读取
- `MemoryFlushMiddleware` 在压缩前触发 flush
- `DEFAULT_FLUSH_PROMPT`（`MemoryFlushManager.java:65-92`）显式告诉 LLM："写到每日账本，把 `MEMORY.md` 当只读上下文，别重复已有事实"

## 4. 沙箱与隔离

### 4.1 沙箱子系统（harness）

目录 `agentscope-harness/.../sandbox/`，**真实存在且有分量**：

| 文件 | 用途 |
|---|---|
| `SandboxManager.java:40` | 生命周期管理器。获取优先级：external sandbox -> external state -> persisted state -> fresh `client.create` |
| `SandboxClient.java` | 接口 |
| `impl/docker/DockerSandboxClient.java`、`DockerSandbox.java` | Docker 实现 |
| `SandboxIsolationKey.java:33` | key 由 `IsolationScope`（SESSION/USER/AGENT/GLOBAL）+ value 组成 |
| `SessionSandboxStateStore.java` | per-session 持久化沙箱状态 |
| `SandboxLifecycleMiddleware.java` | 每次调用 acquire/release |
| `SandboxExecutionGuard.java` | 按 isolation key 的执行租约，防并发修改 |
| `SandboxAware.java` | 标记需要沙箱注入的组件 |
| `layout/` | `BindMountEntry`、`GitRepoEntry`、`LocalDirEntry`、`LocalFileEntry` 把工作区投到沙箱 |
| `snapshot/` | `SandboxSnapshot`、`LocalSandboxSnapshot`、`RemoteSandboxSnapshot`、`NoopSandboxSnapshot` 快照/恢复 |

`SandboxIsolationKey.resolve`（`:67-104`）按 scope 派生：
```java
case SESSION -> new SandboxIsolationKey(SESSION, ctx.getSessionId());
case USER    -> ... ctx.getUserId() ...;
case AGENT   -> new SandboxIsolationKey(AGENT, agentId);
case GLOBAL  -> new SandboxIsolationKey(GLOBAL, "__global__");
```

不同 parent context 下的 subagent 拿到不同沙箱槽位。

### 4.2 工作区隔离：`WorkspaceMode`

文件：`agentscope-harness/.../subagent/WorkspaceMode.java:42`

```
workspacePath  mode      runtime-workspace-root
set            ISOLATED  workspacePath            (定义目录即运行时根)
set            SHARED    mainWorkspace           (定义的 skills/knowledge 被忽略)
null           ISOLATED  mainWorkspace/agents/<name>/workspace/   (自动创建)
null           SHARED    mainWorkspace
(general-purpose, always SHARED) -> mainWorkspace  (完全镜像主 agent)
```

### 4.3 状态隔离：`deriveChildSessionId`

文件：`agentscope-harness/.../HarnessAgentBuilderSupport.java:551-565`

```java
static String deriveChildSessionId(SubagentDeclaration decl, RuntimeContext parentRc) {
    String declName = decl.getName();
    if (decl.getWorkspaceMode() == WorkspaceMode.SHARED || parentRc == null) {
        return declName;
    }
    String sid = sanitizeIdentifier(parentRc.getSessionId());
    String uid = sanitizeIdentifier(parentRc.getUserId());
    if (sid == null && uid == null) return declName;
    StringBuilder sb = new StringBuilder(declName);
    if (sid != null) sb.append('@').append(sid);
    if (uid != null) sb.append('#').append(uid);
    return sb.toString();
}
```

子 session ID 形如 `worker@s1#alice`。因为 `AgentStateStore` 按 `(userId, sessionId)` 分区，这保证**跨父 session、跨用户的状态隔离**。`SubagentIsolationIntegrationTest.java:64-152` 有验证。

### 4.4 Toolkit 隔离

`Toolkit.copy()`（`agentscope-core/.../tool/Toolkit.java:783-796`）：

```java
public Toolkit copy() {
    Toolkit copy = new Toolkit(this.config);
    this.toolRegistry.copyTo(copy.toolRegistry);
    this.groupManager.copyTo(copy.groupManager);
    copy.executor.setChunkCallback(this.executor.getChunkCallback());
    return copy;
}
```

`ReActAgent.Builder` 在构建时调 `toolkit.copy()`，每个 agent 实例拿到自己的**深拷贝** toolkit。父和子**永远不共享** Toolkit 实例。

### 4.5 工具继承与白名单

`SubagentDeclaration.getTools()`（`SubagentDeclaration.java:272-277`）：
```
Optional tool allowlist. When non-empty, only inherited parent tools whose names
are listed remain on the subagent's inherited toolkit. Empty means inherit all
parent tools.
```

子可继承父工具（可选白名单过滤），子 builder 还可加自己的局部工具。

### 4.6 权限继承（只继承 DENY）

`SubagentDeclaration.isInheritParentPermissions()`（`:243-249`）默认 true。实际传递在 `AgentSpawnTool.propagateDenyRules`（`AgentSpawnTool.java:1211-1226`）：

```java
private static void propagateDenyRules(AgentState parentState, ReActAgent child) {
    PermissionContextState parentPerms = parentState.getPermissionContext();
    if (parentPerms == null || parentPerms.getDenyRules().isEmpty()) return;
    var childEngine = child.getPermissionEngine();
    if (childEngine == null) return;
    for (Map.Entry<String, List<PermissionRule>> entry : parentPerms.getDenyRules().entrySet()) {
        for (PermissionRule rule : entry.getValue()) {
            childEngine.addRule(rule);
        }
    }
}
```

从 `AgentSpawnTool.agentSpawn`（`:305-308`）调用：
```java
boolean inherit = declOpt.map(SubagentDeclaration::isInheritParentPermissions).orElse(true);
if (inherit && parentState != null && agent instanceof ReActAgent ra) {
    propagateDenyRules(parentState, ra);
}
```

**只传 DENY 规则**（安全边界），ALLOW/PASSTHROUGH 不传，子有自己新鲜的 `PermissionContextState`（在 `freshState`, `ReActAgent.java:399-410` 设置）。

另外：如果父在 plan mode（只读），子也被强制 plan mode（`AgentSpawnTool.java:297-302`）。

## 5. Session 管理

### 5.1 两种 Session 模型

**Tier 1: Core `SubAgentTool`（stateless provider）**

- Provider 每次产新 agent
- State 通过 `AgentStateStore` 按 UUID session ID 存取
- userId 永远传 `null`（`SubAgentTool.java:253` - `subSession.get(null, sessionId, "agent_state", AgentState.class)`）
- Session ID 是 UUID，首次调用生成（`:140`），靠 LLM 从结果文本里抽 `session_id` 传回来续接
- **无自动清理**，要显式 `AgentStateStore.delete(null, sessionId)`

**Tier 2: Harness `AgentSpawnTool`（更丰富）**

两个 in-memory map + parent state 持久化：
```java
// AgentSpawnTool.java:133-134
private final ConcurrentHashMap<String, SpawnedAgent> agentsByKey = new ConcurrentHashMap<>();
private final ConcurrentHashMap<String, String> labelToKey = new ConcurrentHashMap<>();

// AgentSpawnTool.java:861-877 - 持久化到父状态
parentState.getToolContext().putSpawnEntry(
    key, new ToolContextState.SpawnEntry(key, agentId, sessionId, label, depth));
```

恢复路径 `tryRestoreFromState`（`:893-926`）从父状态读 `SpawnEntry`，再 `agentManager.createAgentIfPresent(entry.agentId(), runtimeContext)` 重建 agent。

### 5.2 Session ID 策略

由 `SubagentDeclaration.isPersistSession()` 控制：

**非持久（默认，`persistSession=false`）**：
```java
// AgentSpawnTool.java:280-282
key = "agent:" + agentId + ":" + UUID.randomUUID();
sessionId = "sub-" + UUID.randomUUID();
```

**持久（`persistSession=true`）**：
```java
// AgentSpawnTool.java:264-267
String hash = deterministicHash(parentSessionId, agentId, canonLabel);
key = "agent:" + agentId + ":" + hash;
sessionId = "sub-" + hash;
```

`deterministicHash`（`:1199-1204`）委托 `SessionIdUtils.deterministicHash(parent, agentId, label)`。相同输入产相同 key：
- 跨父调用状态恢复：后续 `agent_send` 用相同 `agent_key`（或 label）复用现有 agent
- 跨重启恢复：前提是 `AgentStateStore` 也是持久化实现（`JsonFileAgentStateStore`、`RedisAgentStateStore`、`PostgresAgentStateStore`、`MysqlAgentStateStore`）

### 5.3 多轮对话

`AgentSpawnTool` 三条路：

1. **`agent_spawn`（带 `task`）** - spawn 并立即跑 task，返回 `agent_key` + `session_id` + reply
2. **`agent_spawn`（不带 `task`）** - 只创建持久 session，返回 handle，后续用 `agent_send` 驱动
3. **`agent_send`**（`:437-570`）- 按 `agent_key`（或 `label`）查 `SpawnedAgent`，调 `agentManager.invokeAgent(spawned.agent(), spawned.sessionId(), currentUserId, message, runtimeContext)`

子 session ID 在 `agent_send` 之间稳定（`spawned.sessionId()`），所以子 `AgentState` 跨轮累积上下文。harness 端 `DefaultAgentManager.invokeAgent`（`DefaultAgentManager.java:179-199`）构建 `RuntimeContext`（`sessionId=spawned.sessionId()`，`userId=父的 userId`），再调 `react.call(List.of(userMessage(prompt)), ctx)`。ReActAgent 的 `activateSlotForContext` 加载子持久化 `AgentState`。

### 5.4 生命周期与清理

- **无自动 session 清理** - 在 `AgentStateStore` 里一直活到显式 `delete(userId, sessionId)`
- `InMemoryAgentStateStore.clearAll()` 仅测试用（`InMemoryAgentStateStore.java:140-142`）
- `InMemoryAgentStateStore.getSessionCount()` 可观测
- 子完成时：in-memory `SpawnedAgent` **保留**，`agent_send` 可继续驱动
- 父订阅取消：`doFinally(CANCEL)` -> `ra.interrupt(ctx)`（`AgentSpawnTool.java:809-818`、`SubAgentTool.java:204-210`）。停推理但不销毁 session
- **递归深度上限** `MAX_SPAWN_DEPTH = 3`（`AgentSpawnTool.java:95`），防无限递归 spawn

### 5.5 `AgentStateStore` 五种实现

接口文件：`agentscope-core/.../state/AgentStateStore.java:61`

| 实现 | 文件 | 特点 |
|---|---|---|
| `InMemoryAgentStateStore` | `state/InMemoryAgentStateStore.java:46` | `ConcurrentHashMap<userId, Map<sessionId, SessionData>>`，null userId 用 `"__anon__"` 哨兵，JVM 退出即失 |
| `JsonFileAgentStateStore` | `state/JsonFileAgentStateStore.java:69` | 文件系统，**列表状态增量追加**（按文件行数只写新增），单状态全量替换。布局 `<safe(userId)>/<sessionId>/...` |
| `RedisAgentStateStore` | `agentscope-extensions-redis` | Redis |
| `PostgresAgentStateStore` | `agentscope-extensions-postgresql` | PG |
| `MysqlAgentStateStore` | `agentscope-extensions-mysql` | MySQL |

接口：
```java
void save(String userId, String sessionId, String key, State value);
void save(String userId, String sessionId, String key, List<? extends State> values);
<T extends State> Optional<T> get(String userId, String sessionId, String key, Class<T> type);
<T extends State> List<T> getList(String userId, String sessionId, String key, Class<T> itemType);
boolean exists(String userId, String sessionId);
void delete(String userId, String sessionId);
Set<String> listSessionIds(String userId);
```

state key `"agent_state"` 是 `SubAgentTool` 和 `ReActAgent` 持久化 `AgentState` 的统一键，`"memory_messages"` 是 deprecated `Memory` 用的旧键。

## 6. 关键要点总结

1. **没有 `SubAgentSession` 这个类**。Session 状态就是通用的 `AgentState`，按 `sessionId` 持久化到 `AgentStateStore`。"session" 只是一个字符串 key。

2. **两套并行 subagent 系统**。Core `SubAgentTool` 是最小化的通用 AgentTool 包装。Harness `AgentSpawnTool` + `SubagentsMiddleware` + `DefaultAgentManager` + `SubagentDeclaration` 是丰富得多的系统，含工作区/沙箱隔离、异步任务、远程执行、gateway 暴露、LLM 驱动的 spec 生成。应用代码通常用 harness 系统。

3. **父子上下文不共享**。各自独立 `AgentState.context`。唯一跨边界的是 `message` 字符串（入）和 `ToolResultBlock` 文本（出，带 `session_id:` 前缀）。

4. **上下文压缩在 harness 不在 core**。`CompactionMiddleware` + `ConversationCompactor` 是主机制，三层：arg 截断、tool 结果裁剪、LLM 摘要。Core `ReActAgent` 只有结构化输出压缩和超迭代总结。

5. **记忆分 deprecated core 和 active harness**。Core `Memory`/`LongTermMemory` 系列已 `@Deprecated(forRemoval=true, since="2.0.0")`。现行系统是 harness 双层模型：`memory/YYYY-MM-DD.md`（append-only 每日账本）+ `MEMORY.md`（精修、去重、有上限）。

6. **沙箱是真实有分量的**。Docker 沙箱带 bind mount、snapshot、per-isolation-scope 状态、execution guard。Subagent 工作区隔离由 `WorkspaceMode`（ISOLATED vs SHARED）控制，状态隔离由 `deriveChildSessionId` 产出 `declName@parentSessionId#userId` 保证。

7. **Toolkit 按 agent 实例深拷贝**（`Toolkit.copy()`），父子永远不共享 tool 实例。子可继承父工具，可选白名单过滤。

8. **权限继承只传 DENY**。只把父的 DENY 规则传给子（`propagateDenyRules`），保证安全边界但允许子有自己的 ALLOW 规则。

9. **Session 无自动清理**。在 `AgentStateStore` 里活到显式 delete。`SubAgentProvider` 每次产新 agent，但 state 按 `sessionId` 从 store 重新水合。

10. **取消是显式的**。`doFinally(CANCEL)` 通过 `ra.interrupt(ctx)` 打断子的 ReAct 循环，防孤儿 agent 在超时触发重试后继续消耗 LLM/tool 资源。文档见 `SubAgentTool.java:191-203`，harness 镜像于 `AgentSpawnTool.java:800-818`。

## 7. 关键文件清单

### Core subagent - `agentscope-core/.../tool/subagent/`

| 文件 | 用途 |
|---|---|
| `SubAgentTool.java` | `AgentTool` 实现，多轮 session 支持 |
| `SubAgentProvider.java` | 函数式接口，每次产新 agent |
| `SubAgentConfig.java` | 配置（toolName/description/forwardEvents/streamOptions/stateStore） |

### Harness subagent - `agentscope-harness/.../`

| 文件 | 用途 |
|---|---|
| `agent/subagent/SubagentDeclaration.java` | subagent 声明（name/workspaceMode/tools/persistSession/inheritParentPermissions） |
| `agent/subagent/SubagentFactory.java` | `create(parentRc)` 工厂 |
| `agent/subagent/DefaultAgentManager.java` | 工厂注册表 + 调用器 |
| `agent/subagent/WorkspaceMode.java` | ISOLATED / SHARED |
| `agent/tool/AgentSpawnTool.java` | `agent_spawn`/`agent_send`/`agent_list` 工具 |
| `agent/middleware/SubagentsMiddleware.java` | 注册工具、重载声明 |
| `HarnessAgentBuilderSupport.java` | `deriveChildSessionId` 等 |

### 状态与上下文 - `agentscope-core/.../`

| 文件 | 用途 |
|---|---|
| `state/AgentState.java` | 状态模型（含 `contextMutable: List<Msg>`） |
| `state/AgentStateStore.java` | 持久化接口 |
| `state/InMemoryAgentStateStore.java` | 内存实现 |
| `state/JsonFileAgentStateStore.java` | 文件实现（增量追加） |
| `agent/RuntimeContext.java` | 调用级状态包 |
| `ReActAgent.java` | `stateCache`、`activateSlotForContext`、`callSerializationKey`、`compressStructuredOutputContext`、`summarizing` |

### 上下文压缩 - `agentscope-harness/.../`

| 文件 | 用途 |
|---|---|
| `agent/middleware/CompactionMiddleware.java` | 压缩中间件 |
| `agent/memory/compaction/ConversationCompactor.java` | 压缩算法（arg 截断/tool 裁剪/LLM 摘要） |

### 记忆 - `agentscope-harness/.../`

| 文件 | 用途 |
|---|---|
| `agent/memory/MemoryFlushManager.java` | 每日账本 `memory/YYYY-MM-DD.md` |
| `agent/memory/MemoryConsolidator.java` | 精修 `MEMORY.md` |
| `agent/middleware/MemoryFlushMiddleware.java` | flush 中间件 |
| `agent/middleware/MemoryMaintenanceMiddleware.java` | 周期合并触发 |

### 沙箱 - `agentscope-harness/.../sandbox/`

| 文件 | 用途 |
|---|---|
| `SandboxManager.java` | 生命周期管理 |
| `SandboxClient.java`、`impl/docker/DockerSandboxClient.java` | 客户端接口 + Docker 实现 |
| `SandboxIsolationKey.java` | 按 IsolationScope 派生 key |
| `SessionSandboxStateStore.java` | per-session 状态持久化 |
| `SandboxLifecycleMiddleware.java` | acquire/release |
| `SandboxExecutionGuard.java` | 防并发修改 |
| `layout/` | 工作区投影（bind mount/git repo/local dir/local file） |
| `snapshot/` | 快照/恢复 |
