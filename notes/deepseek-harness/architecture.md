# DeepSeek Harness 深度架构与运行时分析

> 原始研究版本：`main@47f943859bef`
>
> 2026-08-19 增量复核版本：`main@99f6f02fecdb`。本次变更未改变 Cordis Service/Provider/Consumer 主架构，主要是 replay、PTY、Web UI 和发布边界修复。
>
> 当前项目处于 Developer Preview。本文描述此提交上的实现与不变量，不承诺后续版本保持相同包边界和配置格式。

## 1. 真正的核心不是某个 Agent Loop，而是可组合运行时

DeepSeek Harness 的默认 Loop 位于 [`packages/core/agent-loop`](../../code/deepseek-harness/packages/core/agent-loop)，但项目没有把它视作不可替换内核。抽象 Agent Service、LLM adapter、Tool Runtime、Session、Prompt assembler、Shell、FS、Sandbox、持久化和 UI 都通过 Cordis Service 与事件连接。

```text
Profile / Bundle / Patch
          │ Loader 构造插件树
          ▼
      Cordis Context
  ┌───────┼────────┬─────────┐
  ▼       ▼        ▼         ▼
Agent   Session   Tools      LLM
  │       │        │          │
  └──── Events / Services / Effects ────┐
                                        ▼
                           FS / Shell / Sandbox / UI
```

所以“Everything is a plugin”不是宣传语：新增能力应落在现有 Service/Event 接缝上；仓库规则甚至要求改变 `agent-loop` 时同步更新架构文档。

## 2. Cordis Context、Fiber 与 Effect 生命周期

Cordis 源码位于 [`vendor/cordis/src`](../../code/deepseek-harness/vendor/cordis/src)。Context 提供服务查找、事件分发和子上下文；Service 声明稳定 key；Fiber 管理插件激活；Registry 保存插件元信息；Effect 绑定撤销动作。

插件的基本生命周期可以理解为：

```text
Loader 读配置 row
  → 解析 plugin module
  → 检查 inject 依赖
  → 依赖就绪后创建 Fiber
  → apply(ctx, config) 注册 Service/Event/Tool
  → config reload 或父 Fiber dispose
  → 逆序执行 disposer，撤销全部贡献
```

`inject` 让启动顺序由依赖关系决定，而不是靠 YAML 顺序偶然正确。所有 Registry contribution 返回 disposer，保证 HMR、Preset 卸载和测试 teardown 后不会残留重复工具或监听器。

### 2.1 四类事件语义

| 类型 | 等待 | 典型用途 |
|---|---|---|
| `emit` | 不等待 | 广播观察事件 |
| `parallel` | 等待全部 | 并行通知多个消费者 |
| `serial` | 顺序等待 | 有顺序、可汇总的阶段 |
| `waterfall` | 围绕调用 | 请求、Tool 等可拦截流水线 |

waterfall listener 接收 `next()`。不调用 `next()` 会短路下游，这适合权限拒绝或 Provider 接管；只做观测却忘记调用则会意外吞掉执行。

## 3. 配置是可发布的组合，而不是全局设置对象

[`packages/boot/app-boot/src/profile.ts`](../../code/deepseek-harness/packages/boot/app-boot/src/profile.ts) 负责 Profile 初始化、manifest 解析与 Layer 定位。默认 Profile 至少包含 `@deepseek-ai/dsh-base`，再叠加 Web 或 Headless Bundle。

```text
bundle 1 patch
  → bundle 2 patch
  → profile/cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml
  → CLI --patch
```

每个 row 有稳定 ID、插件 name、config、disabled、group 和 isolate 信息。Patch 用 ID 替换目标 row 的完整 config，而不是 JSON deep merge。这让覆盖行为可预测，但也意味着只写一个字段会丢失被替换 row 的其他字段。

Loader 允许 `config` 和 `disabled` 中使用 `!!js` 表达式；表达式在相应 Context 中求值。它是部署级代码能力，配置来源必须可信。

## 4. Host Plane、Agent Plane、Scope 与 Realm

Host Plane 服务通常每进程一份，但内部按 Session/Agent key 管理状态，例如 `ctx.sessions`、模型路由、Sub-Agent Registry、Sandbox policy、持久化和 API Gateway。

Agent Plane 则通过 Preset 挂载，贡献该 Agent 可见的 Prompt、Tools、Plan Mode、Compaction、Skills 和 Workflow。注册使用 Scope 限定可见性；需要私有 Service 实例时再使用 Realm isolate。

两者不是同义词：

- Scope 解决“某个注册对哪些 Agent 可见”；
- Realm 解决“同名 Service 是否是独立实例”；
- Host/Agent Plane 解决“谁拥有生命周期与跨会话访问”。

[`standard/agent.cordis.yml`](../../code/deepseek-harness/apps/cli/config/agent-presets/standard/agent.cordis.yml) 的大量注释是在维护这些所有权约束。例如 Sub-Agent Registry 必须在 Host Plane，Preset 只贡献 delegation tools；否则 Web API 看不到 Registry，或多个 Preset 重复注册同名 Provider。

## 5. `ReactLoopAgent` 的驱动状态机

默认实现是 [`ReactLoopAgent`](../../code/deepseek-harness/packages/core/agent-loop/src/agent.ts)。它维护 idle/running 等 phase、AbortController、当前 turn/step、wake latch 和 inbox。

### 5.1 四类输入

| API | 目标 | 行为 |
|---|---|---|
| 普通发送 | `next-turn` | 空闲时唤醒新 Turn |
| `followup()` | `next-turn` | 当前 Turn 后再开始一轮 |
| `steer()` | `next-step` | 当前 Turn 的下一次模型请求消费 |
| `inject()` | context inbox | 不主动唤醒，随下一次有效消息进入模型 |

这种区分避免“补充上下文”意外启动一次模型调用，也让 UI 能明确告诉用户 steering 是否真正到达后续 request。

### 5.2 Driver 与唤醒防竞态

`wakeDriver()` 只保留一个活动 driver。运行时的新消息设置 `wakeRequested`；`kick()` 在退出边界把 phase 变回 idle，并在仍有 pending input 时重新启动。取消时 AbortController 终止当前工作，队列是否继续由取消选项与后续 wake 决定。

`whenIdle()` 等待的不是某个 Promise 快照，而是当前 activity drain，因此适合 CLI、测试与关闭流程观察真正静止状态。

## 6. Turn/Step 的精确语义

一个 Turn 包含零个或多个 Step。`turn()` 先持久化 `turn/start`，然后 `preStep()`：

1. 从指定 inbox target claim 输入；
2. 组装 System Prompt 与 Tool schemas；
3. 投影 runtime context；
4. 经过 `agent/pre-step` waterfall；
5. 决定 reject 或携带重写消息进入 Step。

如果第一批消息被 Middleware 重写为空，Turn 仍会记录 start/end，但不花费模型请求。这保留了用户尝试和策略拒绝的审计边界。

每个 Step 先写 `step/start` 和 `user/message`，再调用 `step()`。若 Tool 产生额外 next-step context，Turn 继续；否则进入 `agent/turn-stopping`，监听器还可以注入最后工作。最终无论成功、max-tokens、blocked、aborted 或 error，都写 `turn/end`。

## 7. 模型请求构造与可重放性

`buildRequest()` 不是每次从当前配置重新拼一个不可追踪对象。它先读取 Session 中的 request header：

- Provider/Model route 必须完整；
- reasoning effort 只在同一精确模型上恢复；
- adapter default 会标记哪些字段应重新由 Adapter 决定；
- `agent/request` waterfall 可以修改 proposal；
- `llm.prepareCall()` 将 proposal 解析为具体 Adapter 与最终 config；
- Header 或 context 变化会写 `request/header`、`request/context` 事件。

实际请求由冻结的 header、`session.deriveMessages()`、session ID 与 AbortSignal 构成。这样 Resume 时可以知道历史请求使用的 System Prompt、Tools 和模型路由，而不是拿今天的全局配置猜测。

## 8. Streaming 与 Assistant 消息固化

LLM 返回异步 chunk。Loop 对每个 chunk：

1. 写 `assistant/chunk`；
2. 交给 `BlockAssembler` 归并 text、reasoning、tool call、usage 与 finish；
3. 流结束后写一条 `assistant/message`，并通过 `sourceEventSeqs` 关联原始 chunks。

如果 finish 为 error/aborted，则先经过 `agent/request-error` waterfall，插件可以依据 retry policy 请求重试。未被处理的错误转换成结构化 `LlmError`；max-tokens 作为 sticky Turn 结果，不会被后续 Step 的正常结束降级为 completed。

## 9. Tool Runtime：注册表之外的执行事务

[`ToolRuntime`](../../code/deepseek-harness/packages/core/tools/src/index.ts) 同时负责：

- 按 Scope 合并 Tool layers；
- 生成 native schema 或 Code Mode SDK schema；
- 执行 restriction 与 guard；
- 合并 caller/wrapper cancellation；
- 调度 prepare、dispatch、finalize、finish；
- 规范化成功/失败与展示内容；
- 收集 deferred context；
- 支持 Tool 主动 conclude Turn；
- 发送 `tools/pre-execute`、`tools/execute`、`tools/post-execute` interception。

工具返回值会被 snapshot、冻结并标记 canonical token，防止下游插件修改已经确认的结果。Tool 的模型内容与 UI presentation 分开：`presentCall`/`presentResult` 只负责纯展示，不能反向改变执行语义。

## 10. 多 Tool 调度与确定性提交

[`executeToolCalls()`](../../code/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts) 先按模型输出顺序建立计划。每个 Tool 可判定为 exclusive 或 concurrency-safe parallel。

```text
模型顺序： A  B  C  D
执行模式： P  P  X  P

并发池执行 A/B
  → 即使 B 先完成，也按 A/B 顺序提交日志和 context
  → 等池 drain
独占执行 C
  → 提交
再执行 D
```

`pre-execute` 有序执行，只有真正 dispatch/body 重叠。每次有序 commit 后会重新判定尚未启动 Tool 的 mode，因为先前 Tool 可能动态修改 Registry 或 policy。

取消时停止启动新调用，等待已启动调用 settle，并为未启动的模型 tool call 写入合成的 aborted call/result。这样模型历史仍满足“每个 tool-call 都有对应 result”，Resume 不会得到协议无效的消息序列。

## 11. Session Event Log 与投影

[`Session`](../../code/deepseek-harness/packages/core/session/src/index.ts) 的追加事件是唯一事实源。事件 envelope 包含递增 seq、类型和 payload；`SessionEventMap` 通过 TypeScript declaration merging 扩展。

持久事件至少覆盖：

```text
turn/start, turn/end
step/start, step/end
user/message
request/header, request/context
assistant/chunk, assistant/message
tool/call, tool/result
```

`deriveMessages()` 从事件重建模型历史；Projection 生成 UI 状态；JSONL/SQLite Provider 保存日志；fork 选择 seq boundary 建立子 Session；Telemetry、标题、全文搜索和 transcript 都消费同一数据源。

新的 model-visible 输入必须增加 Session event，否则重启后无法重建完全相同的请求。Runtime invariant 会检查这种关系。结构性日志格式变化才提升 `SESSION_FORMAT_VERSION`；新事件若旧版本可安全忽略，需要显式 `ignorable` 语义。

## 12. Capability Seam：定义、实现、消费三分法

以 Shell 为例：

```text
Shell Service Definition
       │
       ├─ Local shell provider → Subprocess → Sandbox argv wrapper
       └─ Remote provider
       │
       └─ tool-bash Consumer → Tool Runtime → Model
```

FS、Terminal、Code Runtime、LSP、Web、Sub-Agent 和 Workflow 都采用相似结构。Provider 替换不应该要求修改 Consumer 或 Agent Loop。一个只有接口没有 Provider/Consumer 的包不算完整 seam；仓库要求同时考虑三个角色和真实 composition test。

## 13. Preset 的产品差异

### `standard`

完整 Coding Agent。使用 Host 的 FS/Shell/Sandbox/Registry，并在 Agent Scope 注册 Skills、Plan、Compaction、Goal、Sub-Agent 与 Workflow Tools。

### `minimal`

固定完整 Persona，关闭 runtime context 和 Compaction，只提供持久 Bash 与绝对路径 `str_replace_editor`。它用于可控评测，不应理解为 standard 的性能模式。

### `code`

将 Tool schema 投影成 Code Mode SDK，让模型写 TypeScript 批量调用工具。它减少多轮原生 tool call 往返，但引入代码执行 runtime、嵌套调用与输出归并的额外边界。

### `cordis`

提供 inspect、mount/unmount 与插件开发 Skill，使 Agent 能分析并修改自己的插件 composition。这是运行时自扩展实验面，插件仍是宿主进程代码，不具备“不可信插件安全沙箱”属性。

## 14. 持久化、恢复与 Fork

Session persistence 通过独立协调器与 write-behind 实现，Provider 可以是 JSONL 或 SQLite。Write-behind 必须维护 revision/invariant，避免内存已确认事件在后台写入失败后被静默当作 durable。

Resume 重建 Session 后，Loop 读取 request header、派生 messages，并继续处理 inbox。Fork 以某个事件边界创建新 lineage；Attachment、查询与 Projection 使用稳定 Session identity，而不是复制一份 UI JSON。

这种设计比“保存最终 messages 数组”更复杂，但能保留 chunk、工具关系、请求配置变化和人为交互等事实。

## 15. 安全模型与平台隔离

Sandbox 是独立 capability。Linux 支持 bwrap/Landlock，macOS 使用 Seatbelt；Windows 与无法启用强隔离的平台必须依据实际 support matrix 判断降级行为。

权限不是只在 Tool schema 上隐藏。Approval/interaction、FS policy、Tool guard 和 Sandbox 分别约束不同层：

```text
模型是否看见 Tool
  ≠ Tool executor 是否允许请求
  ≠ 文件 Provider 是否允许路径
  ≠ OS 是否真正隔离进程
```

仅省略 schema 无法阻止直接调用 executor，因此拒绝策略必须落在做出副作用的执行路径。动态 Cordis 配置、插件与 `!!js` 都是可信部署代码。

## 16. 测试策略透露出的设计重点

项目要求包级单测、真实 composition test、keyless snapshot、必要时 real-API e2e。Agent Loop 测试重点包括：

- Turn/Step durable boundary；
- followup、steer、inject 的 inbox 语义；
- cancel 与 driver wake race；
- request header 恢复和模型切换；
- Tool 并发执行但有序 commit；
- Registry 动态变化导致的 barrier；
- Resume 后消息重建；
- initiator scope 与 teardown。

每个 package 还提供 runtime invariant，用当前事件/数据关系验证装配是否完整。它不是类型检查替代品，而是验证“插件确实在最终 composition 中建立了所声称关系”。

## 17. 架构收益与成本

| 收益 | 对应成本 |
|---|---|
| Provider 和 Consumer 可独立替换 | 包数量多，首次阅读门槛高 |
| Session Log 支持精确重放与投影 | 事件演进、revision 和迁移复杂 |
| Preset 可定义完全不同 Agent | Scope/Realm/Plane 所有权容易配置错 |
| Tool 并行且历史确定 | Scheduler 必须处理 barrier、取消和有序提交 |
| HMR 与动态插件 | 所有注册都必须正确 dispose |
| Runtime 自描述、自修改 | 同进程插件扩大可信代码面 |

## 18. 推荐源码追踪路径

```text
apps/cli/src/bin.ts
  → boot/app-boot profile layers
  → bundle/base cordis.patch.yml
  → agent preset agent.cordis.yml
  → core/agent service
  → core/agent-loop ReactLoopAgent
  → system-prompt assemble + session.deriveMessages
  → llm.prepareCall/stream
  → tool-calls scheduler
  → ToolRuntime interception/execution
  → Session append/projection/persistence
```

读某项能力时，再沿 `Service Definition → Provider → Consumer → composition YAML → tests` 追踪。例如研究 Shell，不应只读 `tool-bash`，还需追到 Shell、Subprocess、Sandbox 和 FS policy。
