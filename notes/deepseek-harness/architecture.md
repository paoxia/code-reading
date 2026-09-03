# DeepSeek Harness 深度架构与运行时分析

> 原始研究版本：`master@47f943859bef`
>
> 2026-08-19 增量复核版本：`master@99f6f02fecdb`。本次变更未改变 Cordis Service/Provider/Consumer 主架构，主要是 replay、PTY、Web UI 和发布边界修复。
>
> 2026-08-24 增量复核版本：`master@b150a551b8d4`（`dsh 0.1.1-rc.2`）。图片 admission、持久化引用、Files/inline 请求和 `read_image` 被统一到同一插件链，主架构仍未改变。
>
> 2026-09-03 增量复核版本：`master@49a606bc5b59`（`dsh 0.1.2-alpha.5`）。本次更新重点核对应用 Profile、Preset 打包、PTC、Session handle 持久化、子 Agent 模型选择与实验性 Agent Teams。
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

[`packages/boot/app-boot/src/profile.ts`](../../code/deepseek-harness/packages/boot/app-boot/src/profile.ts) 负责 Profile 初始化、manifest 解析与 Layer 定位。`web`、`headless`、`sdk` 和 `acp` 先叠加 `@deepseek-ai/dsh-base`，再加各自应用 Bundle；`sdk-minimal` 则由单独 Bundle 持有完整插件树，不继承 `base`。所有受支持的 Node 应用统一从 `dsh --profile` 启动，Profile 模板还明确选择 patch 是 live reload 还是只在 startup 应用。

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

Agent Plane 则通过 Preset 挂载，贡献该类 Agent 可见的 Prompt、Tools、Plan Mode、Compaction、Skills 和 Workflow。[`dsh-agent-presets`](../../code/deepseek-harness/packages/preset/agent-presets) 为每种已用 Preset 维护 standing composition，Session 通过 Scope parentage 加入；插件仍以 Session/Agent key 隔离运行状态。注册使用 Scope 限定可见性；需要 Preset 私有 Service 实例时再使用 Realm isolate。

两者不是同义词：

- Scope 解决“某个注册对哪些 Agent 可见”；
- Realm 解决“同名 Service 是否是独立实例”；
- Host/Agent Plane 解决“谁拥有生命周期与跨会话访问”。

[`standard/agent.cordis.yml`](../../code/deepseek-harness/packages/preset/agent-presets/presets/standard/agent.cordis.yml) 的大量注释是在维护这些所有权约束。例如 Sub-Agent Registry 必须在 Host Plane，Preset 只贡献 delegation tools；否则 Web API 看不到 Registry，或多个 Preset 重复注册同名 Provider。

## 5. `ReactLoopAgent` 的驱动状态机

默认实现是 [`ReactLoopAgent`](../../code/deepseek-harness/packages/core/agent-loop/src/agent.ts)。它维护 idle/running 等 phase、AbortController、当前 turn/step、wake latch 和 inbox。

### 5.1 四类输入

| API | 目标 | 行为 |
|---|---|---|
| 普通发送 | `next-turn` | 空闲时唤醒新 Turn |
| `followup()` | `next-turn` | 当前 Turn 后再开始一轮 |
| `steer()` | `next-step` | 当前 Turn 的下一次模型请求消费 |
| `inject()` | `next-step` | 不主动唤醒，随下一次有效消息进入模型 |

这种区分避免“补充上下文”意外启动一次模型调用，也让 UI 能明确告诉用户 steering 是否真正到达后续 request。

### 5.2 Driver 与唤醒防竞态

`wakeDriver()` 只保留一个活动 driver。运行时的新消息设置 `wakeRequested`；`kick()` 在退出边界把 phase 变回 idle，并在仍有 pending input 时重新启动。取消时 AbortController 终止当前工作，队列是否继续由取消选项与后续 wake 决定。`runMaintenance()` 还提供互斥的 maintenance phase，用于不打开 Turn 的维护操作；其对外 status 仍为 idle，但 waking input 会排队到维护结束。

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
- 生成 native schema 或 PTC SDK schema；
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

### 10.1 从 Tool 暴露到下一次模型请求的完整交互

```text
Preset / Plugin 注册 ToolDefinition
  → ToolRuntime 按 Agent Scope 合并、覆盖并应用 restriction
  → SystemPrompt.assemble() 收集可见 Tool Schema
  → buildRequest() 冻结 system / tools / messages / model route
  → LLM 流式输出 assistant chunks
  → BlockAssembler 固化 assistant/message
  → 提取其中的 tool-call blocks（保持模型顺序）
  → parse arguments + executionMode 分组
  → 对每个调用执行 prepare → dispatch → finalize/finish
  → 按模型顺序追加 tool/result
  → Session.deriveMessages() 将结果带入下一 Step
```

请求组装发生在 [`preStep()`](../../code/deepseek-harness/packages/core/agent-loop/src/agent.ts) 中：Loop 先以当前 Agent Scope 调用 `systemPrompt.assemble()`，再把有序 Prompt sections、动态 context 和 Tool schemas 交给 `buildRequest()`。后者把 provider/model、System Prompt、Tool Schema 与调用配置组成 canonical request header；首次请求、恢复、配置变化或新的 message series 都会追加相应 `request/header`，保证 Resume 能解释历史请求实际暴露了什么能力。

模型流结束后，Loop 先把原始 `assistant/chunk` 和固化的 `assistant/message` 写入 Session，再从完整消息中过滤 `tool-call` block。每个 block 带模型生成的 `callId`、工具名与字符串参数。[`executeToolCalls()`](../../code/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts) 尝试把参数解析为 JSON；空参数变成 `{}`，非法 JSON 保留为原字符串，留给 Tool Schema 校验生成普通失败结果，而不是让 Loop 在解析处崩溃。

一次调用的运行阶段如下：

| 阶段 | 主要动作 | 失败语义 |
|---|---|---|
| `plan` | 根据当前可见 Tool 的 `isConcurrencySafe(args)` 判定 `parallel` 或 `exclusive` | 未知 Tool、无 classifier、非法参数或 classifier 抛错都保守地按 `exclusive` |
| `tool/call` | 在执行策略前追加 Session call 事件，记录原始 name、arguments 和 `callId` | 事件进入异步持久化链；是否已落盘由后端进度与 flush barrier 决定 |
| `prepare` | snapshot/freeze 参数，检查 PTC direct-call 限制和取消，运行 `tools/pre-execute`，处理 allow/deny/ask，再运行 monotonic guards | 拒绝、审批取消、参数 materialize 异常都转成结构化错误结果；不会进入 Tool Body |
| `dispatch` | 运行 `tools/execute` around waterfall，融合 caller/wrapper AbortSignal，重新解析当前可执行 Tool；第一方 `defineTool()` wrapper 校验参数 Schema 后调用 Tool Body | Tool、wrapper 或动态 lookup 异常规范化为 `isError` 结果；原始 `ToolDefinition` 实现仍需自行兑现参数合同；已启动调用必须达到 quiescence |
| normalize | snapshot Tool 返回值，校验 output Schema，调用 `output.render()` 生成模型内容，可选生成 UI `meta` | 非 JSON、Schema 不匹配或 renderer 异常都变成 Tool 错误 |
| `finalize` | 运行 `tools/post-execute`，允许 accept、替换内容/值、追加 context 或 block；再执行 Tool 自有 `finalizeContent` | post hook 异常同样物化为错误结果 |
| `finish` | 冻结 canonical result，发送只读 `tools/result` 通知 | observer 失败只记录 warning，不反向改变已确认结果 |
| commit | 按模型原始顺序追加 `tool/result`，用 `sourceEventSeqs` 指向对应 `tool/call` | 即使并发调用乱序完成，Session 和下一轮上下文仍保持模型顺序 |

调度器不是简单的 `Promise.all`。连续的 concurrency-safe Tool 可以进入有上限的 rolling pool，但 `prepare` 与最终 commit 仍按顺序；`exclusive` Tool 构成 barrier。每次有序提交后还会重新读取尚未启动调用的 mode，因此前一个 Tool 对 Registry 或策略的动态修改能够影响后续调用。

Tool Result 是 `user` role 的模型历史节点。结果提交后，Tool 产生的 `additionalContexts` 会进入 `next-step` inbox；即使没有额外 context，只要本 Step 执行过 Tool 且没有 `concludeTurn()`，Loop 也会继续下一 Step，让模型从 Session 派生出的 `tool/result` 判断下一步。没有 Tool Call 的 Assistant 消息或 Tool 主动 `concludeTurn()` 会产生 completed 候选；只有 `next-step` inbox 为空且 `agent/turn-stopping` 不再注入工作时，Turn 才真正收口，因此并发到达的 steering 或 Tool context 仍可要求再运行一步。

取消遵循“停止补充、排空在途、补齐协议”的顺序：不再启动新调用，等待已启动 Body settle，为未启动调用追加合成的 aborted call/result，再结束 Turn。内部 scheduler 自身若发生致命错误，则不会伪造未知执行结果，而是排空已启动 dispatch 后向上抛出，让当前 Turn 以 error 结束。`TOOL_OUTCOME_UNKNOWN` 只用于进程崩溃留下开放 Turn 后的 Resume 修复，不能把普通框架故障假装成已经确认的 Tool 失败。

### 10.2 PTC 模式的两层调用

PTC 模式把模型直接可见的 Tool 收敛为 `run_code`，同时把当前 Scope 的其他 Tool 生成为 SDK bindings。模型输出的是一个外层 `run_code` Tool Call；代码运行时执行 TypeScript，程序中的 `tools.read(...)`、`tools.bash(...)` 等调用再携带 parent execution token 回到同一个 `ToolRuntime`。内层调用仍经过 visibility、Schema、Guard、审批、超时和结果规范化，不能绕过原生 Tool 执行边界。

内层调用使用 `tool/code-dispatch-start` 与 `tool/code-dispatch` 成对记录，但属于 log-only 事件，不直接进入 `deriveMessages()`；程序拿到 canonical JSON value，模型最终只看到外层 `run_code` 的打印值、返回值和必要的图片 context。这样可以把多次 Tool 往返压缩进一次模型 Step，同时保留每个内层副作用的审计记录。

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

`deriveMessages()` 从事件重建模型历史；Projection 生成 UI 状态；JSONL Provider 保存日志；fork 选择稳定边界建立子 Session；Telemetry、标题、全文搜索和 transcript 都消费同一数据源。`SessionSeq` 表示已经存在的事件或 inclusive watermark，`SessionLogOffset` 表示事件间隙、前缀长度或读取边界，避免把“事件编号”和“可等于 event count 的偏移”混为一个裸数字。

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

### `ptc`

将 Tool schema 投影成 PTC SDK，让模型在 `run_code` 内写 TypeScript 批量调用工具。它减少多轮原生 tool call 往返，但引入代码执行 runtime、嵌套调用与输出归并的额外边界。当前 Preset 保留 workflow engine 供 `ralph` 使用，却禁用通用 `workflow` Tool，避免同时向模型暴露两套相近的编排面。Python Code Runtime 已有实验实现，但仍位于 `packages/experimental`，不能视为正式发行能力。

### `cordis`

提供 inspect、mount/unmount 与插件开发 Skill，使 Agent 能分析并修改自己的插件 composition。这是运行时自扩展实验面，插件仍是宿主进程代码，不具备“不可信插件安全沙箱”属性。

## 14. 持久化、恢复与 Fork

Session persistence 已重构为 [`SessionPersistence`](../../code/deepseek-harness/packages/session/session-persistence/src/index.ts) 与每 Session 一个 [`SessionHandle`](../../code/deepseek-harness/packages/session/session-persistence/src/handle.ts) 的接缝。`create/open('write')` 获取进程内单写者所有权；所有读取和追加都经过 handle；后台 append 只代表本进程接受，`flush()` 才是明确的 durability barrier；`close()` 会排空待写事件再释放所有权。后台写失败会保留有序事件并暂停自动写入，下一次显式 flush 重试并把错误暴露给调用者。

当前唯一第一方 Session persistence Provider 是 [`session-persistence-jsonl`](../../code/deepseek-harness/packages/session/session-persistence-jsonl)，每个 Session 保存为压缩的 `.jsonl.zstd` 或纯 JSONL artifact。`storage-sqlite` 服务于通用 domain KV，`session-query-sqlite` 服务于查询，它们都不是 Session 日志 Provider。SQLite Session backend 已从当前源码删除，不能再根据旧包名把两者混为一谈。

Resume 重建 Session 后，先对崩溃中断的最后 Turn 做语义修复：未开始的 Tool Call 得到 `TOOL_NOT_STARTED`，已记录 call 但结果未知的调用得到 `TOOL_OUTCOME_UNKNOWN`，再补齐 `step/end` 和 `turn/end { interrupted }`。修复事件通过同一个 write handle 持久化后，Loop 才读取 request header、派生 messages 并继续处理 inbox。Fork 只能选择 live Session 的稳定边界建立新 lineage；Attachment、查询与 Projection 使用稳定 Session identity，而不是复制一份 UI JSON。

这种设计比“保存最终 messages 数组”更复杂，但能保留 chunk、工具关系、请求配置变化和人为交互等事实。

## 15. Sub-Agent 与实验性 Agent Teams

Sub-Agent 同样遵循 Definition / Provider / Consumer 分层：Host Plane 的 `ctx.subagents` 注册 in-process spawn/fork、ACP、DSH SDK、Codex 或 Claude Code Provider，Preset 只通过 [`dsh-tool-subagent`](../../code/deepseek-harness/packages/subagent/tool-subagent) 选择性暴露 delegation Tool。`standard` 默认提供可继续的 `spawn` 与 `fork`，外部 Provider 的 Tool row 默认禁用，安装 Provider 本身不会自动向模型授权。

子 Agent 默认继承父 Agent 最新已记录请求的 provider、model 和 reasoning effort；若路由改变但调用未显式指定 effort，会清除旧模型拥有的 effort，让新模型采用自己的默认值。启用 model selection 时，Host 设置中的精确 provider/model 白名单会在顶层 Session 创建时写入日志并固定下来，后续设置变更不改变既有 Session；调用和 `list_subagent_models` 都再次执行授权检查。Fork Provider 刻意不启用模型选择，以保持继承历史与模型路由一致，保留 KV Cache 复用条件。

[`experimental/agent-team`](../../code/deepseek-harness/packages/experimental/agent-team) 在 Lead Session Log 上追加 roster、mailbox 和 task-board 事件，实现同一工作区内的多 Agent 协作、离线消息重投与 CAS 任务更新。它只承诺进程内所有权与去重，不提供跨进程共识；包位于 `experimental` 且排除在正式发行物之外，不能当成稳定 Harness 主链。

## 16. 安全模型与平台隔离

Sandbox 是独立 capability。Linux 支持 bwrap/Landlock，macOS 使用 Seatbelt；Windows 与无法启用强隔离的平台必须依据实际 support matrix 判断降级行为。

权限不是只在 Tool schema 上隐藏。Approval/interaction、FS policy、Tool guard 和 Sandbox 分别约束不同层：

```text
模型是否看见 Tool
  ≠ Tool executor 是否允许请求
  ≠ 文件 Provider 是否允许路径
  ≠ OS 是否真正隔离进程
```

仅省略 schema 无法阻止直接调用 executor，因此拒绝策略必须落在做出副作用的执行路径。动态 Cordis 配置、插件与 `!!js` 都是可信部署代码。

## 17. 测试策略透露出的设计重点

项目要求包级单测、真实 composition test、keyless snapshot、必要时 real-API e2e。Agent Loop 测试重点包括：

- Turn/Step durable boundary；
- followup、steer、inject 的 inbox 语义；
- cancel 与 driver wake race；
- request header 恢复和模型切换；
- Tool 并发执行但有序 commit；
- Registry 动态变化导致的 barrier；
- Resume 后消息重建；
- initiator scope 与 teardown。

存在可独立观察且可能分叉的运行时关系时，package 才提供 invariant companion；纯注册表、存储介质或已在调用点完整验证的关系会明确省略 invariant。Invariant 不是类型检查替代品，而是验证“最终 composition 中建立的跨组件关系仍一致”。

## 18. 架构收益与成本

| 收益 | 对应成本 |
|---|---|
| Provider 和 Consumer 可独立替换 | 包数量多，首次阅读门槛高 |
| Session Log 支持精确重放与投影 | 事件演进、revision 和迁移复杂 |
| Preset 可定义完全不同 Agent | Scope/Realm/Plane 所有权容易配置错 |
| Tool 并行且历史确定 | Scheduler 必须处理 barrier、取消和有序提交 |
| HMR 与动态插件 | 所有注册都必须正确 dispose |
| Runtime 自描述、自修改 | 同进程插件扩大可信代码面 |

## 19. 推荐源码追踪路径

```text
apps/cli/src/bin.ts
  → boot/app-boot profile layers
  → bundle/base cordis.patch.yml
  → preset/agent-presets/presets/*/agent.cordis.yml
  → core/agent service
  → core/agent-loop ReactLoopAgent
  → system-prompt assemble + session.deriveMessages
  → llm.prepareCall/stream
  → tool-calls scheduler
  → ToolRuntime interception/execution
  → Session append/projection/persistence
```

读某项能力时，再沿 `Service Definition → Provider → Consumer → composition YAML → tests` 追踪。例如研究 Shell，不应只读 `tool-bash`，还需追到 Shell、Subprocess、Sandbox 和 FS policy。
