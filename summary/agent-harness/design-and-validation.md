# Agent Harness 设计与有效性验证

> 整理时间：2026-08-24
>
> 整理范围：本文是对本仓库 `notes/` 中 Agent Loop、Session、Context、Tool Runtime、权限、恢复、评测与工程交付结论的二次归纳。实现细节与源码证据仍以各项目笔记为准；本文不把设计文档、接口形状或实验分支自动视为已完成能力。

## 1. 结论先行

如果自己实现一套 Agent Harness，推荐采用以下主线：

```text
统一消息和模型事件
  → 单次 Provider Turn
  → Tool continuation loop
  → 同 Session 串行与输入准入
  → 工具副作用前后持久化
  → Session Event Log 与投影
  → Context 编译、压缩与恢复
  → 权限、审批和强制沙箱
  → 稳定产品事件/API
  → 最后增加 Memory、Sub-Agent 和多租户
```

Harness 的有效性也不能只看“最终有没有写出代码”。根据现有笔记，应同时验证：

1. **协议正确性**：事件顺序、Tool Call/Result 配对、终态、重放和取消是否正确；
2. **任务有效性**：是否理解目标、完成正确变更并运行相关验证；
3. **运行可靠性**：崩溃、断流、超时和磁盘失败后是否能安全恢复；
4. **上下文有效性**：压缩后是否保留目标、约束、关键错误和未完成事项；
5. **安全性**：权限、审批、沙箱和租户边界是否由程序强制执行；
6. **工程闭环**：是否达到真实交付边界，并把可复用改进放到后续任务中验证。

## 2. 各项目笔记提供了什么答案

| 项目笔记 | 对 Harness 设计的主要启发 |
| --- | --- |
| [mini-swe-agent](../../notes/mini-swe-agent/README.md) | 最小 Loop：线性消息、模型 action、环境 observation；适合理解窄主链，也暴露无压缩、无恢复的上限 |
| [OpenManus](../../notes/openmanus/README.md) | 简洁 ReAct/Tool Call 继承链；同时展示消息条数硬裁剪、弱权限边界和状态流转误判风险 |
| [pi 自建 Coding Agent 方案](../../notes/pi/build-your-own-coding-agent.md) | SDK 嵌入、产品分层、SessionController、权限、测试和分阶段落地方案 |
| [DeepSeek Harness 深度架构](../../notes/deepseek-harness/architecture.md) | Turn/Step、四类输入、事件事实源、工具事务、有序提交、Scope/Realm 和 Capability Seam |
| [OpenCode](../../notes/opencode/README.md) | API-first、同 Session 串行、durable admission/event projection、Context Epoch 与副作用边界 |
| [Codex Harness 平台](../../notes/codex/agent-harness-platform.md) | Thread/Turn 生命周期、结构化事件、审批/沙箱、产品与 Harness 职责边界 |
| [Codex Rollout](../../notes/codex/rollout.md) | append-only canonical facts、恢复、rollback、fork、compaction 与 SQLite 投影 |
| [Kimi Code](../../notes/kimi-code/README.md) | Turn/Step、追加记录重放、ContextMemory、Full Compaction、子 Agent 与长任务状态 |
| [DeerFlow](../../notes/deer-flow/README.md) | 长时任务中的 Run、Checkpoint、Event、Sandbox、Memory、Skills 与 Sub-Agent 生产组合 |
| [AgentScope Java](../../notes/agentscope-java/react-architecture.md) | Java Middleware、`AgentStateStore`、三态权限、workspace/memory/compaction/sandbox 中间件 |
| [Spring AI Alibaba](../../notes/spring-ai-alibaba/react-agent-architecture.md) | Graph、`OverAllState`、Reducer、Checkpoint、Hook/Interceptor 和 Multi-Agent 组合 |
| [Spring AI Alibaba Skills](../../notes/spring-ai-alibaba/skills.md) | Skill 渐进披露、`read_skill` 后动态工具开放，以及 `allowed_tools` 不是安全白名单的边界 |
| [Hermes Agent](../../notes/hermes-agent/README.md) | Tool Registry、toolset、allowlist、动态 MCP 发现，以及子 Agent 能力裁剪 |
| [SWE-agent](../../notes/swe-agent/README.md) | 独立环境、trajectory、benchmark、候选重试和 Reviewer 评测闭环 |
| [Better Harness](../../notes/better-harness/README.md) | 证据冻结、证据域隔离、五维评估、修复验证与后续 Task Episode 的长期有效性 |

这些项目不是同一种成熟度。mini-swe-agent、OpenManus 更适合学习最小执行链；Codex、OpenCode、Kimi Code、DeepSeek Harness 展示会话与运行时工程；LangGraph/Spring AI Alibaba/AgentScope Java 提供框架积木；SWE-agent 和 Better Harness 则重点回答“怎么证明 Harness 有效”。

## 3. 推荐的总体架构

```text
CLI / TUI / IDE / Web / RPC
             │
             ▼
┌──────────────────────────────────────┐
│ Input Admission                     │
│ prompt / follow-up / steer / inject │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ Session Coordinator                 │
│ single-flight / queue / abort       │
│ Turn / Step state machine           │
└──────────┬──────────────┬────────────┘
           │              │
           ▼              ▼
  Session Event Log   Context Compiler
  canonical facts     model-visible view
           │              │
           │              ▼
           │        Model Gateway
           │              │
           │              ▼
           │        Tool Runtime
           │        policy / approval
           │        sandbox / execute
           │              │
           └──── durable settle ───────┘
                          │
                          ▼
             Projection / Telemetry / Audit
```

产品层和 Harness 层需要保持边界：

| 产品或应用负责 | Harness 负责 |
| --- | --- |
| 用户、组织和租户身份 | Session/Turn/Step 生命周期 |
| 业务对象和真实业务权限 | 模型、工具和上下文执行协议 |
| 高风险动作的产品确认体验 | 发起审批、等待、取消并继续 |
| 外部系统幂等和最终状态 | 工具调用状态与模型结果配对 |
| 业务审计、配额和成本策略 | usage、retry、compaction 与运行事件 |
| UI、通知和业务记录刷新 | 可恢复的 Thread/Session 素材 |

Codex 笔记明确把业务幂等、最终系统状态与多租户隔离留在应用侧；pi 笔记也指出 Extension 不适合承担 Session 单写者、强制沙箱、密钥托管和全局预算。这些能力必须由宿主运行时实现。

## 4. 运行主链如何实现

### 4.1 统一消息与事件

第一步不是写一个巨大的 `run()`，而是定义稳定协议。事件 envelope 至少包含：

```text
eventId
sessionId
turnId
stepId
sequence
type
timestamp
causedBy
payload
```

建议的 canonical event：

```text
session/created
turn/admitted, turn/start, turn/end
step/start, step/end
user/message
request/header, request/context
assistant/message
tool/call, tool/approval, tool/result
context/compaction
turn/aborted, turn/failed
```

DeepSeek Harness 将追加事件作为唯一事实源，模型历史、UI、Telemetry、标题和全文搜索都从同一数据源投影；Codex Rollout 也区分 canonical item 与纯 UI delta。由此可以提炼出一个原则：

> 所有会改变后续模型输入或恢复结果的事实，都必须有可持久化事件；流式展示事件不必全部成为模型历史。

### 4.2 Turn、Step 和输入准入

一个 Turn 对应一次用户意图，一个 Step 对应一次模型请求及其工具结算。外部输入不能只有一个模糊的 `send()`：

| 输入 | 消费边界 | 建议语义 |
| --- | --- | --- |
| prompt | next turn | 空闲时开始新 Turn；运行中排队或拒绝 |
| follow-up | next turn | 当前 Turn 收口后继续 |
| steer | next step | 当前 Turn 下一次模型请求消费 |
| inject | context inbox | 只进入上下文，不主动唤醒 |

DeepSeek Harness 用四类 inbox 明确表达这些语义；OpenCode 和 pi 同样强调同一 Session 不能并发执行两个普通 prompt。服务端需要维护：

```text
(tenant, workspace, session) → single-flight coordinator
```

第二个输入必须明确选择 join、steer、queue、reject 或新 Session，不能静默并发修改相同历史。

### 4.3 单次 Provider Turn 与外层 continuation loop

运行时先实现“单次模型请求”的纯执行器，再由外层 Loop 决定是否继续：

```text
构造冻结的 ModelRequest
  → 流式生成 assistant item
  → 固化完整 assistant message
  → 无 tool call：进入停止判断
  → 有 tool call：执行、结算并写回 result
  → 构造下一 Step
```

模型请求应冻结 Provider、Model、System Prompt、Tool Schema、Context 与能力配置。DeepSeek Harness 把 request header/context 写入 Session，是为了 Resume 时恢复当时真正使用的请求，而不是拿当前全局配置猜测历史。

### 4.4 Tool Runtime 是执行事务

Tool Runtime 不能只是 `Map<String, Function>`。完整路径应该是：

```text
解析并校验参数
  → restriction / guard
  → 权限：ALLOW / APPROVE / DENY
  → durable tool intent
  → sandbox dispatch
  → finalize / normalize
  → durable result 或 interrupted result
  → 按模型原始顺序提交 context
```

DeepSeek Harness 的并行工具只让真正的 dispatch/body 重叠，提交事件和模型上下文仍按原 Tool Call 顺序；取消时还为未启动调用补合成 aborted result。Kimi Code 也强调批次可并行完成，但结果按模型调用顺序写回。这能同时保证性能和可重放性。

非幂等工具要额外记录 `operationId`。崩溃恢复时先查询外部状态，再决定继续、补记结果或交给人工处理；不能自动重放“可能已经完成”的部署、推送、消息或工单操作。

## 5. Session、Workspace、Checkpoint 和 Context

### 5.1 Session 不等于工作区快照

pi 笔记明确指出，会话恢复只能恢复消息和运行时配置，不能自动恢复 Git、文件系统、数据库或远端状态。第一版至少应在 Turn 开始和结束时记录：

```text
cwd
branch
HEAD
git status
diff hash
workspace/config fingerprint
```

需要隔离实验时再选择临时 worktree、Git checkpoint 或文件 CAS。不要把一个内存里的 stash map 写成生产级代码恢复。

### 5.2 Checkpoint 不等于聊天记忆

Spring AI Alibaba 和 LangGraph 笔记表明，Checkpoint 保存的是 Graph state、channel version、pending writes、节点位置和中断点。它能恢复工作流，但不会自动得到高质量模型上下文。

因此建议分开：

```text
Session Event Log  → 对话和工具事实
Checkpoint         → 执行位置和状态
Workspace Snapshot → 文件/Git 状态
Context View       → 本轮模型可见投影
Memory             → 跨会话检索材料
```

### 5.3 Context 编译和压缩

Context 不是把 Session 全量序列化后直接发送。根据 Continue、Codex、Kimi Code、AgentScope Java 和 pi 笔记，可以采用以下顺序：

1. 平台安全与身份规则；
2. 组织和项目规则；
3. 当前活动工具及限制；
4. 当前任务和近期原始消息；
5. 工作区、Skill 和检索材料；
6. 长期记忆召回；
7. 清理旧工具大输出；
8. 总结较旧历史；
9. 修复 Tool Call/Result 和 Provider role；
10. 预留输出与下一步工具预算。

工具层应优先把巨大日志保存为 artifact，并向模型返回：

```text
摘要 + 首尾关键片段 + 总行数/字节数 + 完整制品路径
```

Compaction 摘要至少保留用户目标、验收条件、已修改文件、关键决策、失败尝试、未完成事项与安全限制。原始事件仍用于审计、搜索和重新投影。

## 6. 权限、沙箱和扩展边界

Prompt、`AGENTS.md` 和 Skill 只能影响模型行为，不能构成安全边界。AgentScope Java 提供 `ALLOW / APPROVE / DENY` 三态权限，Codex 和 OpenCode 也把 approval 与执行分开；但应用层审批仍不等于 OS 沙箱。

建议按副作用分级：

| 级别 | 示例 | 默认行为 |
| --- | --- | --- |
| 只读 | 工作区内搜索、读取、`git status` | 自动允许并记录 |
| 局部可恢复 | 编辑源码、运行聚焦测试 | 允许或按策略批准 |
| 高影响本地操作 | 删除、覆盖配置、安装依赖、修改 Git 索引 | 明确批准 |
| 外部副作用 | 推送、发消息、创建 PR/工单、部署 | 默认拒绝，逐次授权 |
| 凭据与系统操作 | 密钥、sudo、宿主全局配置 | 默认拒绝 |

强制边界还应包括：规范化路径、符号链接检查、环境变量过滤、网络策略、进程树取消、资源限额以及容器/microVM。DeerFlow 笔记提醒，本地文件隔离不等于安全沙箱；不可信仓库里的测试和安装脚本本身也是不可信代码。

Extension、Middleware、Hook 和 Interceptor 也不能互相替代：

- Extension/Middleware 适合工具、上下文、审批、审计和产品扩展；
- Graph Hook 适合状态跳转、Checkpoint、HITL 和提前结束；
- Model Interceptor 适合 Prompt 修改、动态工具、重试和 fallback；
- 多租户、密钥、单写者、强制沙箱和任务队列属于宿主基础设施。

### 6.1 动态加载与权限授予必须分离

如果 Skill 和 MCP 都支持动态加载，应把系统拆成两个平面：

```text
能力发现平面
  Skill Registry / MCP Registry / Built-in / Plugin
                  │
                  ▼
              Tool Catalog

能力控制平面
  Visibility Guard → Tool Broker → Invocation Guard
                                 → Capability Lease
                                 → Executor / MCP Adapter
                                 → Effect Guard / Audit
```

能力发现只能回答“有哪些能力可以候选加载”，不能回答“当前调用是否获得授权”。因此：

- Skill 的 `allowed_tools` 只能表示能力请求，不能直接授予权限；
- MCP 的 `listTools()` 只能生成候选目录，不能把底层 Client 暴露给模型或 Skill；
- Tool Registry 中注册的全部工具，与本轮模型可见的工具必须是两个集合；
- 禁用或隐藏 Skill 只影响发现，不等于撤销底层 Tool 权限；
- Skill 正文、supporting scripts 和远程 MCP 描述都应视为不可信输入。

[Spring AI Alibaba Skills](../../notes/spring-ai-alibaba/skills.md) 展示了“启动时只披露
Skill 元数据，调用 `read_skill` 后再动态加入工具”的渐进加载方式；其
`allowed_tools` 是增量开放信息，并不是 deny-by-default 的安全边界。
[OpenCode](../../notes/opencode/README.md) 也把 `ToolRegistry` 的全部注册项与 Provider turn
中实际发送给模型的工具区分开来。

### 6.2 所有执行路径必须汇入 Tool Broker

要实现不可绕过的 Guard，必须只有一个执行入口：

```text
Skill Tool ───────┐
MCP Tool ─────────┤
Built-in Tool ────┼─→ Tool Broker → Guard → Executor
Plugin Tool ──────┤
tool_search bridge┤
Sub-Agent Tool ───┘
```

Skill、MCP Adapter、Plugin 和 Sub-Agent 都不能直接调用底层 `ToolCallback`、MCP Client
或执行器。`Tool Broker` 至少负责：

1. 将别名解析为规范 Tool ID；
2. 规范化并校验参数；
3. 重新计算当前调用上下文；
4. 执行 Guard 和审批；
5. 签发短时效能力凭证；
6. 调度执行并记录结果；
7. 保证 Tool Call 与 result/error/interrupted 配对。

DeepSeek Harness 的
[`ToolRuntime`](../../notes/deepseek-harness/architecture.md) 同时处理 Scope 合并、restriction、
guard、取消、dispatch 和 finalize，说明运行时不能只是 `Map<String, Function>`。
Spring AI Alibaba 的
[`ToolInterceptor`](../../notes/spring-ai-alibaba/hook-and-interceptor.md) 则适合包装每个独立
Tool Call；Graph Hook 更适合暂停、恢复和控制流跳转，不能替代调用级 Guard。

### 6.3 Guard 应覆盖四个边界

| 边界 | 检查时机 | 作用 | 是否能单独构成安全边界 |
| --- | --- | --- | --- |
| Discovery/Load Guard | 加载 Skill、连接 MCP 或刷新目录前 | 校验来源、签名、租户、场景和 Server 信任级别 | 否 |
| Visibility Guard | 每次 Provider turn 前 | 生成本轮模型可见 Tool Schema，减少误调用 | 否 |
| Invocation Guard | 每个 Tool Call 执行前 | 重新校验 Tool、参数、用户、Session、场景和实时策略 | 必需但仍不充分 |
| Effect/Runtime Guard | 真实文件、进程、网络或外部系统操作前 | 通过沙箱、网络、凭据和目标系统权限限制副作用 | Hard Deny 的最终边界 |

只把 Tool 从 Schema 中隐藏不能防止历史 Tool Call、缓存、`tool_search`、别名或恶意输入
直接构造调用；只在调用入口按名称拒绝，也不能阻止 `bash`、`curl`、Python 或另一个 MCP
完成相同副作用。因此可见性过滤和执行时强制检查必须同时存在。

当模型调用已经被隐藏或刚刚撤权的 Tool 时，Harness 仍应生成结构化
`ToolDenied` result，而不是直接丢弃调用，避免破坏 Provider 要求的 Tool Call/Result 配对。

### 6.4 Hard Deny 必须按副作用建模

Tool 名称不是稳定的安全语义。推荐为每个 Tool 声明能力和副作用：

```text
READ_WORKSPACE
WRITE_WORKSPACE
EXEC_PROCESS
NETWORK_READ
NETWORK_WRITE
WRITE_PRODUCTION
DEPLOY
SEND_MESSAGE
MANAGE_CREDENTIALS
```

例如 `deploy_app`、`bash`、`curl`、`python`、`mcp://pipeline/trigger` 和委托给运维子 Agent，
都可能产生 `DEPLOY` 或 `WRITE_PRODUCTION`。如果某个场景绝对禁止部署，就必须同时限制：

- 所有带 `DEPLOY`/`WRITE_PRODUCTION` Effect 的工具；
- Shell、HTTP 和脚本工具能访问的命令与目标；
- 生产凭据是否注入执行环境；
- 到生产控制面的网络连通性；
- MCP Server 使用的身份及其服务端权限；
- 子 Agent 能继承的工具与凭据。

建议采用固定优先级：

```text
HARD_DENY > DENY > REQUIRE_APPROVAL > ALLOW
```

`HARD_DENY` 不能被 Skill、MCP 声明、项目配置、普通 allow 规则或人工 Approval 覆盖，只能
由更高权限的策略控制面修改。动态来源默认 deny；没有 UI 或审批通道时，也不能把
`REQUIRE_APPROVAL` 静默降级为 `ALLOW`。

策略可以表达为：

```yaml
scene: production_incident_analysis

hard_deny:
  effects:
    - DEPLOY
    - WRITE_PRODUCTION
    - NETWORK_WRITE
    - SEND_MESSAGE

allow:
  tools:
    - builtin://read_file
    - builtin://grep
    - mcp://sunfire-readonly/query_logs
    - mcp://sunfire-readonly/query_metrics

mcp:
  allow_servers:
    - sunfire-readonly
  deny_servers:
    - deployment-control
```

### 6.5 Guard 上下文、规范 ID 与能力凭证

每次决策不能只传 `toolName`，至少需要：

```text
actor / tenant / workspace / scene
agentId / parentAgentId / sessionId / turnId
canonicalToolId / source / schemaHash
normalizedArgs / effects / trustLevel
policyVersion / runtimeTarget
```

MCP Tool 可使用带命名空间和 Schema 摘要的规范 ID：

```text
mcp://{serverId}/{toolName}@{schemaHash}
```

这样可以避免不同 MCP Server 同名工具冲突，并在远端 Schema 变化时使旧授权失效。Guard
放行后，Broker 应签发短时效 `CapabilityLease`：

```text
sessionId / turnId / toolId / schemaHash
allowedEffects / policyVersion / expiresAt
```

执行器和 MCP Adapter 必须验证 Lease，且高风险 Hard Deny 在执行前读取实时策略，以支持
紧急撤权。Skill/MCP Catalog 可以热刷新，但 Schema、Server 身份、策略版本或 Tool Effect
变化时必须让旧快照和旧 Lease 失效；对已经开始的高风险操作还要有取消和对账机制。

### 6.6 Skill、MCP 与子 Agent 的具体加载流程

Skill 推荐流程：

```text
discover metadata
  → 校验来源、版本、摘要和覆盖关系
  → SkillLoadGuard
  → read_skill
  → 解析 requested tools
  → Tool Broker resolve
  → 与当前场景权限取交集
  → 加入本轮 ToolCapabilitySnapshot
```

动态 ToolCallback 不应直接写入 Checkpoint。Session 恢复时可以从历史 `read_skill` 事实重新
识别已读 Skill，但必须按当前 Skill 版本和当前策略重新计算工具集合。

MCP 推荐流程：

```text
resolve server
  → 校验 Server 信任与认证身份
  → lazy connect
  → discover versioned tool snapshot
  → namespace + schema hash + effect classification
  → policy filter
  → 注册 Tool Broker wrapper
```

MCP 的动态发现不应发生在不可控的模块导入副作用中。Hermes Agent 把 MCP 从模块级发现中
移出，并通过 Registry generation 让上层 Schema 缓存失效，是一种可参考的生命周期设计。

子 Agent 的能力只能缩小：

```text
child capabilities
  = parent capabilities
  ∩ child role policy
  ∩ scene policy
  ∩ runtime policy
```

不能因为子 Agent 加载了新的 Skill、MCP 或 `tool_search` 结果，就获得父 Agent 没有的能力。
任何动态工具桥接器都必须再次确认底层 Tool 属于当前 Session 的允许目录。

### 6.7 Guard 的结构化接口示例

```java
interface ToolGuard {
    Decision evaluate(GuardContext context);
}

enum GuardAction {
    HARD_DENY,
    DENY,
    REQUIRE_APPROVAL,
    ALLOW
}

record Decision(
    GuardAction action,
    String policyVersion,
    String ruleId,
    String reason
) {}
```

完整调用顺序应固定为：

```text
catalog.discover
  → load/visibility guard
  → model-visible ToolCapabilitySnapshot
  → model tool call
  → canonicalize name and args
  → invocation guard
  → optional approval
  → capability lease
  → executor effect guard
  → durable result and audit
```

审计事件至少记录原始 Tool 名、规范 ID、来源、Schema Hash、Effect、匹配规则、策略版本、
决策、审批与实际执行结果，以便区分“模型没有选择”“Guard 拒绝”“执行环境阻断”和“外部
系统失败”。

### 6.8 如何验证 Guard 不可绕过

除一般权限单元测试外，还需要用确定性 Provider 主动构造绕过路径：

| 测试 | 预期结果 |
| --- | --- |
| 禁止 Tool 不在本轮 Schema 中 | Visibility Guard 过滤 |
| 模型直接伪造被隐藏 Tool Call | Invocation Guard 返回 `HARD_DENY` |
| Skill 的 `allowed_tools` 请求被禁 Tool | 不能扩大权限 |
| `tool_search` 找到被禁 Tool | Broker 再次拒绝 |
| MCP 给同一能力换名称或更新 Schema | 按 Effect 拒绝，旧 Lease 失效 |
| 用 `bash`、`curl` 或 Python 实现相同操作 | Effect Guard 或沙箱阻断 |
| 子 Agent 加载新的 Skill/MCP 后调用 | 权限交集阻断 |
| 人工 Approval 尝试覆盖 Hard Deny | 仍然拒绝 |
| Resume 使用历史 `read_skill` 和旧工具快照 | 按当前策略重新计算 |
| 模型选择 Tool 后、dispatch 前发生撤权 | 实时策略检查拒绝 |
| 没有审批 UI 时命中 `REQUIRE_APPROVAL` | 默认拒绝或保持等待，不能放行 |
| 代码绕过 Broker 直接调用 MCP Client/Executor | 架构测试或依赖规则失败 |

最后一项不能只靠约定。可以通过模块可见性、依赖反转、包级私有构造器和静态架构测试，
保证只有 Tool Broker 模块能够引用底层 `McpClient.callTool()`、`ToolCallback.call()` 或进程执行
接口。只有“不可见、不可直调、不可通过等价副作用实现、不可通过其他 Agent/Adapter 绕过”
同时成立时，才可以声称某个场景绝对不能调用或执行该能力。

## 7. Sub-Agent 为什么应最后实现

DeerFlow、Kimi Code 和 Hermes Agent 笔记都把 Sub-Agent 当成受控的独立执行，而不是普通函数调用。需要额外定义：

- 父子上下文继承范围；
- Tool 与权限裁剪；
- 独立工作区还是共享工作区；
- 并发和 token 上限；
- 取消传播和超时；
- 子任务事件与最终结果回注；
- 父 Agent 能否查询子任务证据；
- 子 Agent 是否允许写长期记忆。

第一版应只做主 Agent。单 Agent 的事件、恢复、权限和工作区一致性稳定后，再把 Sub-Agent 作为“独立 Session/Run + 受限能力 + 结果摘要”接入。

## 8. 如何建立有效性证据链

### 8.1 先冻结评测上下文

Better Harness 的做法是先冻结 target、时间窗、provider、depth、authority 和证据上限，再开始分析。应用到 Harness 评测时，每次 run 至少固定：

```text
task ID / repo fixture / base commit
model/provider/version
system prompt 与项目规则版本
工具集合和权限模式
sandbox 镜像与网络策略
context/compaction 策略
token、费用、turn 和时间预算
随机参数与重复次数
```

如果这些条件没有记录，模型、Prompt、工具、环境和 Harness 变化会混在一起，无法归因。

### 8.2 分层验证

| 层级 | 主要方法 | 证明什么 |
| --- | --- | --- |
| 单元测试 | 路径、权限、Reducer、token、脱敏、事件投影 | 局部规则正确 |
| 合同测试 | Provider、Tool、Session、Extension Adapter | 边界协议兼容 |
| 确定性集成 | Faux Provider → Tool → Session → 下一 Step | Loop 和事件顺序正确 |
| 故障注入 | 断流、超时、磁盘失败、取消、崩溃点 | 恢复和副作用边界正确 |
| 仓库 E2E | 临时 Git 仓库里的固定任务 | 整条工程链可用 |
| 真实模型评测 | 固定模型、重复采样、对照/消融 | 行为质量和效率 |
| 线上观测 | SLO、审批、成本、失败类型、用户干预 | 生产运行表现 |
| 后续 Task Episode | 可比任务再次执行 | 改进是否长期有效 |

真实模型不适合验证协议状态机。pi 笔记建议用 Faux Provider 驱动纯文本、单/多 Tool Call、流式参数、错误、超时、取消、compaction、steer 和 Session 恢复；真实模型只作为固定任务 smoke 与行为评测。

### 8.3 关键不变量

至少自动检查：

```text
同一 Session active runner ≤ 1
Session sequence 严格递增
每个 Tool Call 都有 result/error/interrupted
每个 Turn 只有一个终态
重放相同事件得到相同逻辑 state hash
fork 后父子事件流互不写入
compaction 后 Provider 历史仍合法
恢复后不沿用过期 approval
取消后不遗留活动子进程
未知外部副作用不被自动重放
```

### 8.4 故障注入矩阵

需要在以下边界主动杀进程或制造异常：

1. `turn/admitted` 后、`turn/start` 前；
2. Provider request 发出后、完整 response 固化前；
3. `tool/call` 已持久化、工具尚未执行；
4. 工具已产生副作用、`tool/result` 尚未落盘；
5. 多工具批次部分完成；
6. compaction 摘要生成或提交中；
7. EventStore flush、fork、checkpoint 保存中；
8. approval 等待和用户取消同时发生。

恢复后对比 Session state、workspace diff、外部 operation 状态和最终事件，才能证明“可恢复”，而不是只证明 UI 能重新打开。

## 9. 任务基准如何设计

SWE-agent 将 dataset instance、repo/base commit、problem statement、trajectory、patch 和 evaluator 组成完整 benchmark。自建 Harness 也应把任务定义成可复现 fixture：

```yaml
task_id: fix-null-check
repo_fixture: java-service-03
base_commit: abc123
prompt: 修复 NullCheckTest 的失败
oracle:
  test_command: mvn -Dtest=NullCheckTest test
  allowed_paths:
    - src/main/java/**
    - src/test/java/**
  forbidden_paths:
    - .github/**
    - pom.xml
  expected:
    - focused_test_passes
    - no_unrelated_changes
```

第一版准备 10～20 个固定任务：

1. 解释调用链但不修改文件；
2. 修复一个明确失败测试；
3. 新增小功能和测试；
4. 需求不明确时停止并提问；
5. 保留用户已有修改；
6. 拒绝修改 `.env`、`.git` 和工作区外路径；
7. 无 UI 模式拒绝需要批准的动作；
8. 取消后终止 Provider 和子进程；
9. 长日志被截断但保留关键错误；
10. Session 恢复后能说明已完成和未完成工作；
11. Provider 断流不执行不完整 Tool Call；
12. 达到费用或 Turn 预算后停止。

每次运行保存完整 configuration、trajectory、event log、patch、测试结果、usage、审批和工作区终态。Retry/Reviewer 选择多个候选时，必须统计总尝试和总成本，不能只统计获胜轨迹。

## 10. 上下文策略如何做对照实验

对同一任务、模型、Prompt、工具、预算和环境比较：

```text
A：完整线性历史
B：只保留最近 N 条
C：工具结果清理 + 最近历史
D：工具结果清理 + summary compaction
E：summary compaction + 按需检索/Memory
```

每个任务重复多次，测量：

| 指标 | 含义 |
| --- | --- |
| Critical Fact Recall | 压缩后目标、路径、错误和约束保留率 |
| Stale Fact Rejection | 是否拒绝已被更新或撤销的旧事实 |
| Source Attribution | 是否区分系统、用户、工具、Skill 和 Memory |
| Tool Pair Integrity | 投影后 Provider 历史是否合法 |
| Task Success | 测试、行为和验收条件是否满足 |
| Token/Cost Reduction | 相对基线节省的输入 token 和费用 |
| Recovery Accuracy | 重启后状态和未完成事项是否正确 |

摘要降低 token 不等于有效。只有在任务成功率、关键事实保留和安全约束不下降时，token 节省才有意义。

## 11. 用五维模型评估完整工程闭环

Better Harness 的五维十五项检查适合作为最终报告结构：

| 维度 | 应检查的三个问题 |
| --- | --- |
| Task Understanding | Intent and Acceptance、Relevant Context、Scope Boundary |
| Controlled Execution | Reproducible Startup、Supported Operation、Permission Boundary |
| Change Validation | Relevant Verification、Failure Diagnosis and Repair、Post-repair Revalidation |
| Reliable Delivery | Delivery Acceptance、High-risk Approval、Rollback or Recovery |
| Learning Capture | Lifecycle Opportunity Detection、Loop Engineering、Longitudinal Validation |

这五维不能被一个总成功率替代。例如：

- 测试通过但修改越界，Task Success 不能掩盖 Controlled Execution 失败；
- 本地测试通过但未达到项目真实 CI/评审边界，不应标记 Reliable Delivery 完成；
- 当前修复验证通过，只能更新 Repair Progress；只有后续可比 Task Episode 才能证明 Learning Capture 有效。

Finding 需要同时包含已检查 gap、影响、最小 owner、修复路线、验证路线和证据置信度。文件存在、配置启用或资产数量不能直接证明能力生效。

## 12. 指标与上线门禁

最低运行指标来自 pi、Codex、SWE-agent 和 Better Harness 笔记：

- run 成功、失败、取消和超时；
- 首 token 与 Provider 总耗时；
- Turn/Step/Tool Call 数；
- Tool 耗时、错误率、拒绝率和 approval 等待；
- input/output/cache token 与总费用；
- compaction 次数、前后 token 和压缩后失败；
- 修改文件、diff 大小、相关测试结果；
- retry、fallback、context overflow 和 loop detection；
- Session 排队、恢复、fork 和 workspace drift；
- 用户纠偏、取消和人工接管频率。

安全和协议不变量应作为硬门禁，而不是与质量分数平均：

```text
必须为 0：
- 未授权的工作区外写入
- 未批准的高风险/外部副作用
- 孤立 Tool Call/Result
- 重复 Turn terminal event
- fork 父子状态污染
- 崩溃恢复后的静默重复副作用

质量与效率目标：
- 固定任务通过率不低于完整历史基线
- 关键事实和验收约束跨压缩保留
- 无关修改率和人工接管率处于可接受范围
- token、费用和 p95 时延符合产品预算
```

具体阈值取决于任务集，但硬安全门禁与质量/效率目标必须分开报告。

## 13. 分阶段落地

### Phase 0：只读技术验证

- 非交互 CLI；
- 一个 Provider Adapter 和 Faux Provider；
- 只启用 read/search/list；
- 输出文本、Tool Call、usage 和事件；
- 跑通纯文本和工具两条确定性路径。

退出标准：没有写权限时，能稳定分析仓库并给出带路径的结论。

### Phase 1：本地可用单 Agent

- edit/write/bash；
- 路径、权限、审批和进程取消；
- 持久 Session；
- diff、命令、测试和成本审计；
- 临时 Git 仓库 E2E。

退出标准：完成“定位 → 修改 → 聚焦测试 → 总结 diff”，所有副作用可审计。

### Phase 2：独立 Runtime

- Session Coordinator；
- Event Log 和投影；
- prompt/follow-up/steer/inject；
- Context Compiler 和 Compaction；
- resume/fork/retention；
- 稳定 ProductEvent/API。

退出标准：UI 不持有权威历史，切换 Session 后没有旧订阅、旧工具和旧 cwd 泄漏。

### Phase 3：服务化

- RPC、重连和快照；
- 每 Session 单写者；
- 容器/worktree 隔离；
- 多租户、密钥和限额；
- 故障恢复和副作用对账；
- 线上指标和审计保留。

退出标准：进程崩溃不会造成静默重复副作用，各种状态具有明确租户边界。

### Phase 4：高级能力

- Memory；
- Sub-Agent；
- 后台长任务；
- durable workflow；
- Reviewer、自动评测和模型路由。

这些能力应由真实任务瓶颈驱动，不能因为已有接口或示例就提前加入主链。

## 14. 最容易误判的地方

1. **有 API 不等于能力已实现**：pi 新 `AgentHarness` 的多个公开入口仍是 scaffold；OpenCode V2 也有明确未完成的恢复和 facade 能力。
2. **有 Session 不等于可恢复工作区**：消息恢复不能证明 Git、文件和外部副作用一致。
3. **有 approval 不等于有沙箱**：应用层允许/拒绝不能限制已获准进程的 OS 权限。
4. **有 Checkpoint 不等于有高质量 Context**：Graph state 恢复后仍需单独编译模型消息。
5. **有 Memory 不等于有长期学习**：只有后续可比任务证明改进有效，才算 Learning Capture。
6. **有测试不等于已交付**：聚焦测试、CI、评审、部署和人工验收是不同边界。
7. **一次成功不等于 Harness 有效**：必须保留配置、轨迹、成本、环境和失败样本，进行重复与对照实验。

## 15. 最终原则

从现有笔记可以归纳为一句话：

> 先把 Agent Harness 做成一个事件可追踪、状态可重放、工具副作用可对账、权限可强制、上下文可解释的单 Agent 运行时；再用冻结任务、确定性合同、故障注入、仓库 E2E、上下文消融和后续 Task Episode 证明它不仅能运行，而且能长期稳定地理解、执行、验证、交付和学习。
