# Codex App Server：JSON-RPC 控制面与 Core Thread 桥接

> 原始研究版本：`code/codex@28aacbb`
>
> 2026-08-19 增量复核版本：`code/codex@f5a3dc55404d`

## 1. 定位

App Server 是 Codex Core 的长驻控制面。它通过 JSON-RPC transport 向桌面端、IDE 或其他客户端暴露 thread/turn、配置、账户、MCP、文件系统、进程和扩展能力。它不重新实现 Agent loop；真正的推理、工具与 rollout 在 Core，App Server 负责协议校验、对象管理、事件投影和多连接生命周期。

协议类型位于 [`app-server-protocol`](../../code/codex/codex-rs/app-server-protocol)，服务实现位于 [`app-server`](../../code/codex/codex-rs/app-server)。

## 2. 进程拓扑

```text
Client connection(s)
  ↕ JSON-RPC request / response / notification
Transport
  → MessageProcessor
      ├─ InitializeRequestProcessor
      ├─ ThreadProcessor
      ├─ TurnProcessor
      ├─ Config/Account/MCP/FS/... processors
      └─ OutgoingMessageSender
             ↓
        CodexThread / ThreadManager
             ↓
        Core Session + Rollout + Tools
```

[`run_main_with_transport_options()`](../../code/codex/codex-rs/app-server/src/lib.rs) 装配配置、认证、thread manager、state DB、watchers、processors 与 transport loop。连接可以是 stdio 或其他 transport；业务处理不应依赖某一种 frame 来源。

## 3. Initialize Gate

每个连接都有 session state，`initialize` 只能按协议完成一次。`MessageProcessor.handle_client_request()` 特判 Initialize；其他请求进入 `dispatch_initialized_client_request()` 前检查 `session.initialized()`，未初始化返回 `Not initialized`。

Initialize 不只是返回版本号，还协商 client info/capabilities、实验能力和通知准备状态。服务必须先发送 connection-scoped initialize notifications，再允许普通 outbound notification，源码使用 `outbound_initialized` 与连接状态保证顺序。否则客户端可能先收到无法按协商版本解析的事件。

## 4. 请求分派

[`message_processor.rs`](../../code/codex/codex-rs/app-server/src/message_processor.rs) 将 JSON-RPC request 反序列化为强类型 `ClientRequest`，再按 variant 委托 processor。大类包括：

- thread：start/resume/fork/list/read/archive/rollback/compact；
- turn：start/steer/interrupt/review/realtime；
- config、models、account、rate limit；
- MCP、skills、plugins/apps/extensions；
- filesystem、process、one-off command；
- git、search、feedback、remote control。

MessageProcessor 是路由总表，不应塞入具体业务。各 `request_processors/*` 负责参数验证、Core 调用和 response/notification 转换。

## 5. Thread Start 与监听

[`ThreadProcessor.thread_start_inner()`](../../code/codex/codex-rs/app-server/src/request_processors/thread_processor.rs) 需要加载配置/overrides、创建 Core thread、获取 config snapshot、附加 listener、写 state DB 并返回 thread 数据。耗时工作被放入 background task，processor 还提供 `drain_background_tasks()` 以支持受控 shutdown。

每个已加载 Core thread 有事件 listener，把 `EventMsg` 转为 app-server `ServerNotification`。多个连接可以订阅 thread，因此 listener 生命周期不等于单个 WebSocket/stdio connection 生命周期。unsubscribe/connection close 要解除该连接关系，但只有 thread removal/shutdown 才终止 Core runtime。

## 6. Turn Start

[`TurnProcessor.turn_start_inner()`](../../code/codex/codex-rs/app-server/src/request_processors/turn_processor.rs) 完成：

1. 加载 thread 并检查 direct input/active turn 条件；
2. 构造 environment 和 thread settings overrides；
3. 把 app-server input items 转成 Core `Op`；
4. 记录 client/trace context；
5. `submit_core_op()`；
6. 返回 turn id/初始状态，后续进度走 notifications。

Request response 只确认启动，不包含完整模型结果。客户端必须持续消费 `TurnStarted`、item delta/completed、approval、error 和 terminal notification。

Steer、interrupt 与 inject items 是不同 API：steer 进入活跃 turn 的安全队列，interrupt 取消 task，inject items 只修改 thread history且受直接输入规则限制。

新版还增加了持久化 queued submission，其语义也不同于 steer。`thread/queue/add`
可以在 turn 运行时保存后续用户消息，thread 恢复 idle 后再启动新 turn；完成或失败会自动继续队列，interrupt 则暂停队列。队列实现见
[`thread_queue_processor.rs`](../../code/codex/codex-rs/app-server/src/request_processors/thread_queue_processor.rs)，协议约束见
[`app-server/README.md`](../../code/codex/codex-rs/app-server/README.md)。普通 `turn/start` 不会隐式消费这个队列。

## 7. 协议事件投影

Core `EventMsg` 与 app-server notification 不一一同名。[`bespoke_event_handling.rs`](../../code/codex/codex-rs/app-server/src/bespoke_event_handling.rs) 和 outgoing message 层处理：

- Core item 到 v2 thread/turn/item notification；
- raw/experimental event 是否暴露；
- token usage replay；
- deprecated notification 兼容；
- thread status 派生。

App-server 的当前 view 是 Core event/rollout 的投影。恢复连接时可以通过 thread read/items list/token replay 重建，而不能假设通知恰好只投递一次。

## 8. 多连接与反向请求

Server 除了发 notification，还可能向客户端发 request，例如审批、elicitation 或动态能力交互。`process_response()`/`process_error()` 将客户端对 server request 的响应交还等待者。connection RPC gate 负责将请求路由到有能力且仍存活的连接。

连接关闭时要清理 pending request、登录流程、thread subscriptions 和 connection-scoped state，但不能误杀其他连接仍使用的 thread。相关收尾在 `connection_closed()`、[`connection_cleanup.rs`](../../code/codex/codex-rs/app-server/src/connection_cleanup.rs) 与 thread listener 管理中。

## 9. 状态数据库和 Watcher

App Server 初始化 SQLite state runtime，并在检测损坏时把旧文件移动到备份位置后 fresh start。Skills、配置、MCP 和 model catalog watcher 会产生刷新通知或更新 runtime；这些后台任务需要在 shutdown 时排空。

Watcher 更新影响后续请求/turn，不应在没有明确同步点时修改已冻结的 `TurnContext`。这与 Core 的每 turn 快照设计相配合。

## 10. 错误边界

| 层级 | 示例 | 对外形式 |
|---|---|---|
| JSON-RPC | malformed request、未知 method | JSON-RPC error |
| session gate | 未 initialize、重复 initialize | invalid request |
| processor validation | thread 不存在、参数冲突 | typed request error |
| Core submit | active turn 冲突、配置错误 | app-server error response |
| 异步 turn | model/tool/interrupt | server notifications |
| transport | connection closed | cleanup，不等同 thread 失败 |

## 11. 推荐阅读与测试

1. [`lib.rs`](../../code/codex/codex-rs/app-server/src/lib.rs)：装配和 transport loop。
2. [`message_processor.rs`](../../code/codex/codex-rs/app-server/src/message_processor.rs)：initialize gate 与请求总路由。
3. [`thread_processor.rs`](../../code/codex/codex-rs/app-server/src/request_processors/thread_processor.rs)：thread 生命周期。
4. [`turn_processor.rs`](../../code/codex/codex-rs/app-server/src/request_processors/turn_processor.rs)：turn/steer/interrupt。
5. [`transport_tests.rs`](../../code/codex/codex-rs/app-server/src/transport_tests.rs) 与 [`main_tests.rs`](../../code/codex/codex-rs/app-server/src/main_tests.rs)：协议顺序与连接行为。
6. `request_processors/*_tests.rs`：按 API 验证边界。
