# Multica 架构与托管 Agent 执行主链

> 原始研究版本：`multica-ai/multica main@ecce589867b9`
>
> 2026-08-19 增量复核版本：`main@d563bfbc08d0`（Web `0.4.30`）
>
> 研究范围：本文聚焦 Issue/Chat 触发任务、本地 Daemon 领取和执行任务、统一 Agent
> Backend、任务状态机以及 Web/Desktop 的实时状态同步。Autopilot、Squad、移动端、
> 云 Runtime、Slack/Lark 和 Composio 只介绍它们与主链的连接点，留待后续专题。

## 1. 先给结论

Multica 不是 Claude Code、Codex 或 OpenCode 那样直接实现模型—工具循环的 Coding
Agent。它更接近一个 **Agent 管理平面和执行编排层**：

```text
人类或 Agent 创建/分配 Issue、发送 Chat、触发 Autopilot
                         │
                         ▼
                  Go Server 决定是否入队
                         │
                         ▼
                 agent_task_queue（PostgreSQL）
                         │
              WS 唤醒 + WS/HTTP 领取
                         ▼
                 本地 multica Daemon
                         │
       准备工作目录、技能、凭据、Prompt 和 Provider 配置
                         │
                         ▼
          Claude Code / Codex / OpenCode / Pi / ... CLI
                         │
              统一消息流、进度、结果和用量
                         ▼
       Server 事务化结算 → WebSocket → React Query Cache → UI
```

真正的模型循环仍由各家 Agent CLI 实现。Multica 负责的是其外层生命周期：

- 谁可以触发哪个 Agent；
- 任务怎样入队、串行化、限流、领取、重试和取消；
- 在哪台 Runtime 上执行；
- 怎样为不同 CLI 准备一致的上下文、Skills、MCP 和任务凭据；
- 怎样把异构 CLI 的流式输出统一成消息、进度、结果和用量；
- 怎样让浏览器、桌面端和聊天渠道看到一致的实时状态。

增量版本进一步收紧了这个管理面：私有 Agent 的 invoke/assign/UI 选择面统一为 owner-only，不再出现服务端拒绝但客户端仍显示可用的假能力；provider 命令日志在记录前统一脱敏，覆盖 Claude、Codex、Kimi、OpenCode 等 backend；Issue 还新增“自定义属性无值”过滤和语义化 `last_activity_at`，后者需要 migration/backfill，不能仅靠前端推导。

理解这个定位后，仓库里看似分散的 Board、Chat、Daemon、Skills、Squads 和 Autopilots
就能收束到同一条主线：**它们都是产生、路由、执行或观察 Agent Task 的不同入口。**

## 2. 仓库分层

项目是 Go 后端与 pnpm/Turborepo 前端组成的 Monorepo。作者声明的边界集中在
[`AGENTS.md`](../../code/multica/AGENTS.md) 和
[`CLAUDE.md`](../../code/multica/CLAUDE.md)。

| 层 | 主要目录 | 职责 |
|---|---|---|
| API 与后台服务 | [`server/cmd/server`](../../code/multica/server/cmd/server) | 组装 Chi Router、PostgreSQL、事件总线、Realtime Hub、Daemon Hub 和后台任务 |
| HTTP Handler | [`server/internal/handler`](../../code/multica/server/internal/handler) | 认证、工作区隔离、请求校验、响应与应用服务调用 |
| 领域服务 | [`server/internal/service`](../../code/multica/server/internal/service) | Issue 触发判定、Task 入队/领取/结算/重试、Autopilot 等业务规则 |
| 数据访问 | [`server/pkg/db/queries`](../../code/multica/server/pkg/db/queries) | sqlc SQL；任务状态的原子迁移主要在 `agent.sql` |
| 本地执行器 | [`server/internal/daemon`](../../code/multica/server/internal/daemon) | 注册 Runtime、领取任务、准备环境、执行 CLI、上报消息和终态 |
| CLI 适配层 | [`server/pkg/agent`](../../code/multica/server/pkg/agent) | 把不同 Agent CLI 统一成 `Backend`、`Session`、`Message`、`Result` |
| Headless 前端核心 | [`packages/core`](../../code/multica/packages/core) | API Client、Zod 边界、React Query、Zustand、Realtime 同步 |
| 共享业务界面 | [`packages/views`](../../code/multica/packages/views) | Web/Desktop 共用的页面和业务组件 |
| 平台外壳 | [`apps/web`](../../code/multica/apps/web)、[`apps/desktop`](../../code/multica/apps/desktop) | Next.js/Electron 路由、导航和平台 API 适配 |
| 移动端 | [`apps/mobile`](../../code/multica/apps/mobile) | 独立的 Expo/React Native 客户端，只有限复用纯类型和函数 |

前端依赖方向是：

```text
apps/web ─┐
          ├─> packages/views ─> packages/core
desktop ──┘                 └─> packages/ui

packages/core 与 packages/ui 相互独立
```

其中 React Query 拥有服务端状态，Zustand 只拥有过滤器、草稿、弹窗、标签页等客户端状态；
WebSocket 更新 React Query Cache，不把服务端实体复制进 Zustand。这个边界不仅写在约定中，
也体现在
[`use-realtime-sync.ts`](../../code/multica/packages/core/realtime/use-realtime-sync.ts)
的实现中。

## 3. 核心领域对象

### 3.1 Workspace、Runtime 和 Agent

一个 Agent 并不直接等于某个 CLI 进程：

```text
Workspace
  ├─ Runtime：可执行任务的计算环境
  │    ├─ 本地 Daemon 检测出的内置 Provider
  │    └─ 自定义 Runtime Profile
  └─ Agent
       ├─ runtime_id
       ├─ model / thinking_level / service_tier
       ├─ instructions / skills / MCP / custom_env / custom_args
       ├─ visibility / invocation permission
       └─ max_concurrent_tasks
```

Runtime 表示“哪里能执行”，Agent 表示“以什么身份和配置执行”。一个 Daemon 可以注册多个
Runtime，并在一次机器级领取请求中携带完整的 `runtime_ids`。

Agent 还可以是 Squad 的 Leader。Issue 分配给 Squad 时，最终入队的执行者仍是具体 Leader
Agent，Task 额外保存 `is_leader_task` 和 `squad_id`，从而保留协调者角色和 Squad 上下文。

### 3.2 `agent_task_queue` 是系统中轴

任务表最初定义于
[`001_init.up.sql`](../../code/multica/server/migrations/001_init.up.sql)，之后由大量迁移补入
Runtime、重试、会话恢复、准备租约、Squad、归因、MCP Overlay、评论合并等字段。

当前 Task 可以关联：

- `issue_id`：Issue 执行；
- `chat_session_id`：对话执行；
- `autopilot_run_id`：自动任务；
- 三者都为空并在 `context` 中携带 Quick Create 数据；
- `trigger_comment_id` 和 `coalesced_comment_ids`：一次执行计划要处理的评论集合；
- `parent_task_id`、`retry_of_task_id`、`rerun_of_task_id`：自动重试和人工重跑谱系；
- `session_id`、`work_dir`：后续任务恢复会话和复用工作目录。

这解释了为什么
[`Task`](../../code/multica/server/internal/daemon/types.go)
看起来很宽：领取响应不是简单 Prompt，而是 Daemon 构造可执行环境需要的完整任务信封。

## 4. 一次 Issue 分配如何变成 Agent Task

### 4.1 写入与触发判定分开

创建 Issue 的事务由
[`IssueService.Create`](../../code/multica/server/internal/service/issue.go)
负责；更新入口在
[`handler/issue.go`](../../code/multica/server/internal/handler/issue.go)。

是否启动 Agent Run 则统一交给
[`IssueService.WillEnqueueRun`](../../code/multica/server/internal/service/issue_trigger.go)：

```text
Issue 创建 / assignee 变化
  ├─ status == backlog        → 只停放，不启动
  ├─ Agent 无 Runtime/已归档  → 不启动
  └─ Agent 或 Squad Leader ready
                              → 返回 IssueRunTrigger

Issue 从 backlog 进入活动状态
  ├─ done / cancelled         → 不启动
  ├─ 当前 Agent 自触发同一 Issue → 阻止循环
  ├─ 已有 pending run         → 去重
  └─ ready                    → 返回 IssueRunTrigger
```

预览接口和真实写路径复用同一个判定，所以前端显示“将启动 N 个 Agent”时不需要重写服务端
规则。Handler 收到 `IssueRunTrigger` 后通过
[`dispatchIssueRun`](../../code/multica/server/internal/handler/issue_trigger.go)
选择普通 Agent 或 Squad Leader 路径。

### 4.2 入队

普通分配最终调用：

```text
TaskService.EnqueueTaskForIssueWithHandoff()
  → enqueueIssueTaskWithCommentPlan()
  → 加载 Agent 并检查 archived/runtime
  → 解析顶层人类 originator/accountable user
  → 构造本次 Runtime MCP Overlay
  → sqlc CreateAgentTask
  → 发布 task:queued
  → EmptyClaim.Bump
  → Daemon WS task_available
```

核心实现在
[`service/task.go`](../../code/multica/server/internal/service/task.go)，原子插入 SQL 在
[`agent.sql`](../../code/multica/server/pkg/db/queries/agent.sql)。

这里有两个重要顺序：

1. 先广播 `task:queued`，再唤醒 Daemon，防止客户端先观察到后续 `task:dispatch`；
2. 先递增 Empty Claim Cache 版本，再发送唤醒，防止 Daemon 被唤醒后仍命中旧的“无任务”
   缓存。

Comment、Chat、Autopilot、Quick Create 和人工 Rerun 有各自入口，但最终都写入同一任务表，
复用相同的领取与执行状态机。

## 5. Task 状态机与并发控制

主状态可以概括为：

```text
deferred ──到期提升──> queued
                         │ ClaimAgentTask
                         ▼
                     dispatched
                       │     │ 本地目录锁冲突
                       │     ▼
                       │ waiting_local_directory
                       │     │ 获得锁
                       └─────┘
                         ▼
                       running
                    ┌────┼─────┐
                    ▼    ▼     ▼
               completed failed cancelled
                            │
                            └─ 可重试原因 → 新的 queued/deferred 子 Task
```

[`ClaimAgentTask`](../../code/multica/server/pkg/db/queries/agent.sql) 使用
`FOR UPDATE SKIP LOCKED` 原子领取，并同时实施：

- 按 Task priority 降序、创建时间升序；
- `Agent.max_concurrent_tasks` 容量限制；
- 同一 `(issue, agent)` 不并行；
- Chat 按 `(chat_session, agent)` 串行；
- 不同 Agent 可以并行处理同一 Issue。

状态转换也带比较并交换条件：

- `StartAgentTask` 只接受 `dispatched` 或 `waiting_local_directory`；
- `CompleteAgentTask` 只接受 `running`；
- `FailAgentTask` 接受尚未终结的已领取状态；
- 领取响应构造失败时，`RequeueAgentTaskAfterClaimFailure` 还会比较 `dispatched_at`，避免旧
  Handler 回滚一次更新的领取。

领取后、正式启动前还有短期 Prepare Lease。Daemon 如果在准备仓库、Skills 或环境时持续
工作，就延长租约；如果响应丢失或 Daemon 消失，服务端可以重新投递长期停在
`dispatched` 且从未 `started` 的 Task。

并发正确性不是只靠 Go 内存锁。
[`task_claim_race_test.go`](../../code/multica/server/internal/service/task_claim_race_test.go)
并发调用 `ClaimTask`，验证 `max_concurrent_tasks=1` 时只有一个领取成功；批量领取行为由
[`task_batch_claim_test.go`](../../code/multica/server/internal/service/task_batch_claim_test.go)
覆盖。

## 6. Daemon 如何领取和执行

### 6.1 注册与机器级领取

[`Daemon.Run`](../../code/multica/server/internal/daemon/daemon.go) 会完成认证、探测本机 Agent
CLI、同步 Workspace/Runtime Profile、注册 Runtime、启动心跳、自动更新、GC、WebSocket
和任务轮询。

任务轮询不是每个 Runtime 一个永久轮询器。当前主路径是机器级批量领取：

```text
runBatchPoller()
  → 先获取本地空闲 slot
  → 收集当前 Daemon 的全部 runtime_ids
  → ClaimTasksWSFirst(max_tasks = 空闲 slot 数)
       ├─ 优先 daemon WebSocket RPC
       └─ 不可用时 HTTP POST /api/daemon/tasks/claim
  → 按 task.runtime_id 找到本地 Provider
  → 每个 Task 进入 handleTask goroutine
```

“先拿本地 Slot，再向服务端领取”避免任务已变成 `dispatched` 却没有本地执行容量。服务端
批量领取仍逐 Agent 进入同一 `ClaimTask` 路径，因此不会绕过单 Agent 并发上限和
Issue/Chat 串行约束。

HTTP 协议及解析由
[`client_batch_claim_test.go`](../../code/multica/server/internal/daemon/client_batch_claim_test.go)
验证；Daemon WebSocket Hub 位于
[`server/internal/daemonws`](../../code/multica/server/internal/daemonws)。

### 6.2 环境准备

[`runTask`](../../code/multica/server/internal/daemon/daemon.go) 是执行侧最关键、也最密集的
方法。启动 Provider 前大致完成：

1. 确认 Task 对应 Runtime 和 Provider，可自愈已失效的 CLI 绝对路径；
2. 解析 Project Repo 或 `local_directory`；
3. 解析/缓存 Skill Bundle；
4. 合并 Runtime 与 Agent MCP 配置；
5. 选择新建或复用之前的执行目录；
6. 通过 [`execenv`](../../code/multica/server/internal/daemon/execenv) 写入 Agent Context、
   Skills、Provider 配置和隔离目录；
7. 环境准备完成后才调用 `StartTask`，保证消费者看见 `running` 时工作目录已经存在；
8. 生成本次 Prompt；
9. 校验服务端签发的 Task Scoped Token；
10. 注入 `MULTICA_TASK_ID`、`MULTICA_AGENT_ID`、`MULTICA_WORKSPACE_ID`、
    `MULTICA_TOKEN` 等环境变量；
11. 创建统一 Backend 并执行。

Task Scoped Token 是重要安全边界：Agent 子进程看到的是绑定 Task 和 Agent 的 `mat_`
凭据，不是 Daemon Owner 的长期凭据。Agent 自己调用 `multica issue`、`comment` 等命令时，
服务端因此能够识别为 Agent 行为，并保留原始人类触发者的归因链。

Local Directory 模式会对路径加进程内互斥锁。发生竞争时 Task 进入
`waiting_local_directory`，而不是占着一个模糊的 `running` 状态；执行结束后还会清除注入到
用户仓库的 Runtime Brief 和 Sidecar。

## 7. 统一 Agent Backend

统一接口定义在
[`server/pkg/agent/agent.go`](../../code/multica/server/pkg/agent/agent.go)：

```go
type Backend interface {
    Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error)
}

type Session struct {
    Messages <-chan Message
    Result   <-chan Result
}
```

`Message` 把异构 CLI 流归一成：

```text
text | thinking | tool-use | tool-result | status | error | log
```

`Result` 则统一终态、最终输出、错误、会话 ID、耗时和按模型统计的 Token Usage。

`agent.New()` 当前支持的 Provider 包括 Claude、CodeBuddy、Codex、Copilot、OpenCode、
DevEco、OpenClaw、Hermes、Pi、Cursor、Kimi、Kiro、Antigravity、Qoder、Trae、Grok 和
Qwen。这里的“统一”只到外层执行协议：

- Claude、OpenCode、Pi 等 Backend 启动各自 CLI 并解析其 JSON/JSONL；
- Codex 走 `codex app-server`；
- ACP Provider 通过对应 ACP 进程通信；
- 每个 CLI 的模型循环、工具实现和权限机制仍属于上游 CLI。

这是一种 **Adapter + Factory** 设计。新增 Provider 不只是在 `New()` 增加一个 `case`：

- `SupportedTypes`、`launchHeaders` 和 Backend 实现要同步；
- Runtime Profile 的数据库约束要接受新的 `protocol_family`；
- 默认命令名要加入
  [`agent-cli-command-names.txt`](../../code/multica/scripts/agent-cli-command-names.txt)；
- Daemon 的探测、模型目录、Prompt/System Prompt、MCP 和 `execenv` 支持也可能需要扩展。

[`agent_test.go`](../../code/multica/server/pkg/agent/agent_test.go)
验证 Factory、支持列表与启动提示的一致性。

## 8. 流式消息、Watchdog 和终态上报

Daemon 的
[`executeAndDrain`](../../code/multica/server/internal/daemon/daemon.go)
并行处理消息和最终结果：

```text
Backend.Execute()
  ├─ Messages
  │    ├─ thinking/text 合并
  │    ├─ tool-use/tool-result 立即结构化
  │    ├─ 每 500ms 批量 ReportTaskMessages
  │    └─ 首次出现 SessionID 时提前 PinTaskSession
  └─ Result
       └─ 等消息尾部 flush 后才进入终态结算
```

提前保存 `session_id/work_dir` 让 Daemon 在执行中崩溃时仍有机会恢复会话。消息序号由调用者
持有，同一 Task 的 Fresh Session Fallback 不会把序号重新从 1 开始。

Liveness 不简单等于固定总超时：

- 正常消息长时间持续流动时可以没有 Wall-clock Deadline；
- 无消息时由 Idle Watchdog 终止；
- 有未完成工具调用时使用更长的 Tool Watchdog；
- 服务端 Task 已取消、失败、完成或删除时，本地 watcher 会中止 Agent；
- 最终状态是 fail-closed：只有明确的 `completed` 才调用 Complete，其余未知状态走 Fail。

[`daemon_test.go`](../../code/multica/server/internal/daemon/daemon_test.go)
覆盖消息尾部刷写、取消、Watchdog、恢复拒绝、用量上报和终态回调等大量时序。

## 9. 服务端如何结算完成和失败

### 9.1 完成

[`TaskService.CompleteTask`](../../code/multica/server/internal/service/task.go)
在事务中把 `running` 改为 `completed`。Chat Task 还会在同一个事务中：

- 更新 `chat_session` 的 `session_id/work_dir/runtime_id`；
- 写入唯一的 Assistant Outcome；
- 绑定本次 Task 上传的附件。

事务提交后才广播 `chat:done` 和 `task:completed`，避免客户端先观察到事件却读不到消息或
新的 Resume Pointer。

Issue Task 如果 Agent 在执行期间没有主动评论，服务端会根据最终输出补一条兜底评论；这使
“Task 已完成但 Issue 时间线没有任何结果”不成为正常状态。

### 9.2 失败与自动重试

`FailTask` 会把原始错误映射到规范化 `failure_reason`。只有明确列入可重试集合且未耗尽预算
的失败才创建子 Task。父 Task 失败和子 Task 创建在同一事务中，避免中间窗口让较新的 Chat
输入越过重试任务。

重试可以立即进入 `queued`，也可以带 `fire_at` 进入 `deferred` 后退避。子 Task 继承必要的
触发计划、归因和会话信息；被判断为 Resume Unsafe 的错误不会继续复用有问题的会话。

## 10. 两套 WebSocket，各自解决不同问题

项目有两个容易混淆的实时通道：

| 通道 | 路由 | 用途 |
|---|---|---|
| 用户端 Realtime | `/ws` | Issue、Comment、Task、Chat、Agent、Runtime 等 Workspace 事件 |
| Daemon 通道 | `/api/daemon/ws` | 心跳、Task Available 唤醒、机器级 RPC Claim、Runtime Profile 刷新 |

用户端事件从应用内
[`events.Bus`](../../code/multica/server/internal/events)
进入
[`realtime.Hub`](../../code/multica/server/internal/realtime)；多 API 节点部署时可经 Redis
Relay 跨节点转发。没有 Redis 时是适用于单节点开发的进程内广播。

浏览器/Desktop 的
[`WSClient`](../../code/multica/packages/core/api/ws-client.ts)
负责认证、消息分发和带抖动的指数退避重连。源码明确说明当前 UI 还没有可见的断线状态或
手动重试入口，因此客户端会无限重连并把延迟封顶在 30 秒。

## 11. React Query 如何保持实时一致

[`useRealtimeSync`](../../code/multica/packages/core/realtime/use-realtime-sync.ts)
是 Web/Desktop 的实时归约中心：

```text
Workspace WebSocket Event
  ├─ 粗粒度事件前缀 → 100ms debounce 后 invalidateQueries
  └─ 需要即时视觉反馈的事件 → setQueryData 精确写入
```

例如：

- 任意 Task 生命周期变化使 Agent Presence、Working Agents、Issue Table、Task List、Usage、
  Squad Member Status 等 Query 失效；
- `task:message` 按 `seq` 直接合并到消息 Cache，避免每条流消息都重新请求；
- Chat 的 `task:queued/dispatch/running/waiting` 直接更新 Pending Task；
- `chat:done` 先把 Assistant Message 写入 Cache，再清 Pending Task，避免完成瞬间闪烁；
- Workspace 广播的 Chat Task 事件不会直接修改“当前用户是否有 Pending Chat”的聚合值，
  因为事件不携带足够的可见性信息；这里只让经过权限过滤的服务端 Query 重新获取。

对应测试位于
[`use-realtime-sync.test.ts`](../../code/multica/packages/core/realtime/use-realtime-sync.test.ts)
和
[`ws-client.test.ts`](../../code/multica/packages/core/api/ws-client.test.ts)。

这套实现体现了项目的状态所有权原则：**数据库是权威，React Query 是客户端服务端状态
缓存，WebSocket 是刷新或精确归约信号，Zustand 不保存这些实体副本。**

## 12. Skills、MCP 和会话恢复怎样接入主链

这些能力都不是独立旁路，而是在 Task Claim 和 `execenv` 阶段汇合：

### Skills

- Workspace Skill、Builtin Skill 和 Runtime Local Skill 有不同来源；
- Claim Response 可以直接携带小 Skill，也可以携带需要 Daemon 按哈希解析的 Bundle Ref；
- Daemon 缓存 Bundle，再写入 Provider 能原生发现的位置；
- Agent 可以禁用某些 Runtime Skill，`execenv` 在任务环境中隐藏它们。

### MCP 与 Connected Apps

- Agent 自身有 `mcp_config`；
- 服务端在入队时按任务归因和 Agent 权限生成 Runtime MCP Overlay；
- Daemon 合并两层配置，再转成各 Provider 所需的配置文件或启动参数；
- Composio 等 Connected App 因而是每次 Run 的能力，不必永久暴露给所有 Agent。

### Resume

- Task 流中尽早保存 Provider Session ID；
- 完成/失败时保存 `session_id` 与 `work_dir`；
- 下一次同 Agent、同 Issue/Chat 的 Task 可以收到 `prior_session_id/prior_work_dir`；
- Daemon 只有在工作目录确实复用、且 Provider 会话材料存在时才尝试 Resume；
- 手工 Rerun、自动 Retry 和正常后续消息的 Resume 语义不同，代码使用独立字段区分。

## 13. 扩展机制和设计模式

| 机制 | 代码位置 | 设计作用 |
|---|---|---|
| Agent Backend Adapter | [`server/pkg/agent`](../../code/multica/server/pkg/agent) | 屏蔽 CLI 参数和流格式差异 |
| Runtime Profile | [`runtime_profile.go`](../../code/multica/server/internal/handler/runtime_profile.go) | 用自定义命令、固定参数和协议族扩展 Runtime |
| Task Service | [`task.go`](../../code/multica/server/internal/service/task.go) | 让 Issue/Chat/Autopilot 共用状态机和通知副作用 |
| Event Bus + Hub + Relay | [`events`](../../code/multica/server/internal/events)、[`realtime`](../../code/multica/server/internal/realtime) | 解耦事务后业务事件与单/多节点实时分发 |
| Navigation Adapter | [`packages/core/navigation`](../../code/multica/packages/core/navigation) | 共享 View 不依赖 Next.js 或 React Router |
| Storage Adapter | [`packages/core`](../../code/multica/packages/core) | Core 不直接依赖 `localStorage` |
| Runtime `execenv` | [`server/internal/daemon/execenv`](../../code/multica/server/internal/daemon/execenv) | 把 Provider 特有的 Home、Skill、MCP、沙箱配置收敛到准备阶段 |
| Builtin Skills | [`builtin_skills`](../../code/multica/server/internal/service/builtin_skills) | 把 Multica 产品操作知识交付给执行中的 Agent |

Squad 不是在 Go 进程内实现一个通用多 Agent Scheduler，而是把 Leader 作为稳定路由层：
平台把任务交给 Leader，Leader 再通过 Multica 的 Issue、Comment、Mention 等能力委派给成员。
因此 Squad 协作仍然落回可审计的 Task、Issue 和 Comment。

## 14. 限制、风险与阅读时的注意事项

### 14.1 仓库变化非常快

本文读取的 HEAD 提交日期为 2026-07-24，源码中已经有 200 号以上迁移和大量带问题编号的
兼容/竞态修复。Task 和 Daemon 主链正在持续演进，后续阅读应始终记录 Commit，而不要只写
“当前 main”。

### 14.2 编排热点文件很大

`server/internal/service/task.go` 和 `server/internal/daemon/daemon.go` 都是数千行级热点。
它们不是简单的 God Object：不少复杂度来自重试、租约、会话恢复、评论归并、不同 Task
类型和终态一致性；但阅读和修改时确实容易遗漏跨段不变量。最佳方法是沿单条状态链阅读，
并同时检查 SQL 和测试，不建议从第一行顺读到末尾。

### 14.3 “WebSocket 实时”不是唯一正确性来源

UI WebSocket 负责低延迟更新，React Query 仍保留失效重取和重连后的全量校正。Daemon
领取也有 WebSocket 优先、HTTP Fallback、定时 Poll 和丢响应回收。因此不要把任意一条 WS
消息误认为系统唯一的 Durable Queue。

### 14.4 自托管并不等于单进程应用

完整运行至少涉及 Web、Go Server、PostgreSQL 和本地 Daemon；多 API 节点还需要 Redis
Relay 和共享的请求状态。再叠加 Provider CLI 账号、Git 仓库访问、Skills/MCP 和可选外部
集成后，部署与安全面明显大于普通看板。

### 14.5 Runtime 执行权限很高

Daemon 最终启动的是具备代码修改和命令执行能力的 Agent CLI。Task Scoped Token、私有
Agent Gate、环境变量 Blocklist、工作目录隔离和 Provider Sandbox 都在降低风险，但不能把
“统一 Backend”理解为统一且等价的安全沙箱；实际能力仍随 Provider、操作系统和配置变化。

### 14.6 历史迁移不等于当前设计规则

早期迁移中仍能看到 Foreign Key、非 Concurrent Index 等旧做法；当前
[`CLAUDE.md`](../../code/multica/CLAUDE.md)
已经明确禁止新增数据库外键，并要求每个索引使用单独的
`CREATE [UNIQUE] INDEX CONCURRENTLY` 迁移。分析当前架构时应区分历史遗留与现行约束。

### 14.7 明确标注的现有限制

源码注释明确指出，Web/Desktop 目前没有可见的 WebSocket 断线状态和手动重试按钮，只能
无限自动重连。仓库中也保留少量 `TODO`，例如 Workspace Slug→UUID Cache、Kiro Payload
字段收敛，以及部分客户端反馈字段结构化；这些不应描述成已经完成的能力。

## 15. 推荐阅读顺序

第一次阅读建议按一条 Issue Task 主链走，不要先扎进 UI：

1. [`README.md`](../../code/multica/README.md) 和
   [`CLAUDE.md`](../../code/multica/CLAUDE.md)：先建立产品定位与硬边界。
2. [`issue_trigger.go`](../../code/multica/server/internal/service/issue_trigger.go)：理解什么写入会
   启动 Agent。
3. [`handler/issue_trigger.go`](../../code/multica/server/internal/handler/issue_trigger.go)：看预览、
   权限和真实 Dispatch 如何共享判定。
4. [`service/task.go`](../../code/multica/server/internal/service/task.go)：只按
   Enqueue → Claim → Start → Complete/Fail → Notify 函数跳读。
5. [`agent.sql`](../../code/multica/server/pkg/db/queries/agent.sql)：核对状态转换和并发保证实际
   落在哪里。
6. [`daemon.go`](../../code/multica/server/internal/daemon/daemon.go)：按
   `Run → pollLoop → runBatchPoller → handleTask → runTask → executeAndDrain` 跳读。
7. [`agent.go`](../../code/multica/server/pkg/agent/agent.go)：理解统一执行协议，再选一个熟悉的
   Provider，例如 [`codex.go`](../../code/multica/server/pkg/agent/codex.go) 深挖。
8. [`execenv`](../../code/multica/server/internal/daemon/execenv)：研究 Skills、MCP、Provider Home、
   Sandbox 和工作目录隔离。
9. [`ws-client.ts`](../../code/multica/packages/core/api/ws-client.ts) 与
   [`use-realtime-sync.ts`](../../code/multica/packages/core/realtime/use-realtime-sync.ts)：最后看
   Server 状态怎样变成 UI。
10. 对照测试：`task_claim_race_test.go`、`daemon_test.go`、`use-realtime-sync.test.ts`。

读懂主链以后，再按兴趣分专题：

- 多 Agent 协作：Squad Leader、Comment Routing、Attribution；
- 自动化：Autopilot Trigger、Scheduler、Webhook Delivery；
- 能力复用：Skill Bundle、Builtin Skill、Runtime Local Skill；
- 可靠性：Lease、Retry、Resume、GC、Realtime Relay；
- 安全：Task Token、Invocation Permission、Private Agent、MCP Overlay。

## 16. 核心结论

Multica 给出的不是一个更复杂的 Agent Loop，而是一套把现有 Coding Agent 变成“团队成员”
的外层系统：

> 用 PostgreSQL Task 状态机保存可审计的工作，用本地 Daemon 把工作路由到异构 CLI，用
> Task Scoped Context 和凭据约束每次执行，再用事件总线、WebSocket 和 React Query 将状态
> 实时投影回人类协作界面。

它最值得学习的地方不是 Provider 数量，而是围绕 **领取竞态、执行容量、终态事务、会话
恢复、实时缓存、安全归因和跨进程故障** 建立的一组时序不变量。对于已经读过单体 Coding
Agent 的人，这个项目正好补上“Agent 如何被长期托管并参与团队工作”的系统层视角。
