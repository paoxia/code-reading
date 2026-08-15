# OpenHands Agent Canvas 架构分析

> 源码版本：`OpenHands/OpenHands main@e6c90d6`（2026-08-13）

## 研究范围

当前 `OpenHands/OpenHands` 仓库的主体是 **Agent Canvas**：负责启动、连接和观察 OpenHands Agent 的 React/TypeScript 客户端，而不是 Agent 推理循环本身。仓库自己的架构说明明确把动作执行、沙箱隔离和模型凭据托管排除在 Canvas 边界之外；核心运行时位于独立的 `software-agent-sdk` / Agent Server。

因此本文重点研究完整开发 Agent 平台的前端控制面、事件流、多后端连接和部署边界。不能仅凭本仓库推断 Agent Server 内部的 Loop 或沙箱实现。

## 整体架构

```text
Browser / Electron / embedded library
                 │
          OpenHands Agent Canvas
       ┌─────────┼──────────┐
       │         │          │
 conversation  files     terminal/browser
       │         │          │
       └──── service adapters ────┐
                                  │ HTTP / WebSocket
                         OpenHands Agent Server
                                  │
                    workspace / sandbox / LLM / tools

          Optional: Automation Server / Cloud APIs
```

源码边界可先看 [`docs/architecture.md`](../../code/openhands/docs/architecture.md)。Canvas 的核心目录是：

| 目录 | 职责 |
|---|---|
| [`src/api`](../../code/openhands/src/api) | Agent Server、配置、技能、自动化等服务适配器 |
| [`src/components`](../../code/openhands/src/components) | 会话、终端、浏览器、文件和设置界面 |
| [`src/hooks`](../../code/openhands/src/hooks) | 数据请求、事件订阅与交互逻辑 |
| [`src/stores`](../../code/openhands/src/stores) | Zustand 客户端状态 |
| [`src/types/agent-server`](../../code/openhands/src/types/agent-server) | Agent Server 事件和协议类型 |
| [`bin`](../../code/openhands/bin) / [`scripts`](../../code/openhands/scripts) | 本地栈启动与打包 |

## 会话与事件流

Agent Server 是执行事实来源，Canvas 通过 HTTP 创建、读取和控制会话，通过 WebSocket 接收持续事件。连接上下文位于 [`conversation-websocket-context.tsx`](../../code/openhands/src/contexts/conversation-websocket-context.tsx)，事件先进入 [`use-event-store.ts`](../../code/openhands/src/stores/use-event-store.ts)，再由 [`handle-event-for-ui.ts`](../../code/openhands/src/utils/handle-event-for-ui.ts) 转换成界面状态。

```text
用户消息
  → Conversation Service
  → Agent Server
  → WebSocket OpenHandsEvent
  → event store
  → event handler / derived stores
  → Chat、Terminal、Browser、Files UI
```

协议不只包含聊天文本。类型目录区分 message、observation、streaming delta、conversation state、condensation、pause 和 hook execution 等事件，入口见 [`openhands-event.ts`](../../code/openhands/src/types/agent-server/core/openhands-event.ts) 和 [`events`](../../code/openhands/src/types/agent-server/core/events)。这使 UI 能呈现执行过程，而不必把所有信息压成 Assistant 文本。

### WebSocket 连接生命周期

[`ConversationWebSocketProvider`](../../code/openhands/src/contexts/conversation-websocket-context.tsx) 显式维护连接状态，并向子组件提供发送能力。它同时处理 conversation/backend 改变、组件卸载、主动关闭、异常断开和重建连接。发送方法返回结果，而不是把浏览器 `send()` 成功等同于 Agent Server 已完成处理。

实时消息处理包含三道边界：

- transport：frame 是否到达、连接是否需要重建；
- protocol：JSON 是否符合当前 `OpenHandsEvent` 类型；
- projection：事件是否写入通用 event store，以及要更新哪个领域 store。

页面显示异常时，应先在 provider 确认 frame，再看 [`use-event-store.ts`](../../code/openhands/src/stores/use-event-store.ts) 是否追加/合并，最后检查 [`handle-event-for-ui.ts`](../../code/openhands/src/utils/handle-event-for-ui.ts) 的分发分支。

### Event Store 不是聊天消息列表

`OHEvent` 在服务端事件上补充客户端字段，`EventState` 维护事件集合与更新操作。事件 id/排序信息用于合并历史加载和实时增量，数组下标不是稳定身份。streaming delta 可能持续更新正在生成的消息，而 observation、state change 与 pause 是独立事件，不能全部拼到 assistant 文本。

`handle-event-for-ui.ts` 是投影层：它根据事件类型更新 terminal、browser、conversation、files 等 store。服务端 event log 是事实记录，Zustand store 是为渲染派生的当前视图。刷新或重连后可以从历史事件重建视图；只保存当前视图则不足以恢复完整执行轨迹。

```text
Composer 提交
  → service / WebSocket send
  → Server 接受用户事件
  → conversation state 进入 RUNNING
  → message / action / observation / delta 返回
  → event store 合并
  → projector 更新领域 store
  → Chat / Terminal / Browser 分别重渲染
  → state 回到等待、暂停、完成或错误
```

“用户消息已显示”“Server 已接受”“Agent 开始运行”是三个时刻。乐观 UI、网络确认和 conversation state 必须分开理解，否则重连时容易产生重复消息或错误的 running 状态。

## 多后端与服务适配

[`active-backend-context.tsx`](../../code/openhands/src/contexts/active-backend-context.tsx) 保存当前后端上下文，[`agent-server-adapter.ts`](../../code/openhands/src/api/agent-server-adapter.ts) 统一 Agent Server 接入。运行栈还可以组合 Automation Server 和 Cloud API；后端返回的 runtime service 信息会进入 Agent 上下文，避免 Agent 猜测本地端口。

这种设计把 UI 与某个固定部署解绑：同一 Canvas 可以连接本地、远程或托管 Agent Server，但各后端能力并不必然完全相同，兼容性检查见 [`agent-server-compatibility.test.ts`](../../code/openhands/src/api/agent-server-compatibility.test.ts)。

Adapter 的目的不是抹平所有差异，而是集中能力协商、URL/认证与响应转换。`active-backend-context` 决定请求目标，各 service 再通过 adapter 访问对应 API。切换 backend 时，与旧端绑定的 conversation id、WebSocket 和查询缓存不能继续复用。

兼容性测试说明 Canvas 对 Agent Server 存在最低协议期待。新增事件类型通常可被旧客户端忽略，但关键 endpoint 缺失、字段语义变化或 WebSocket 不兼容会破坏主链。因此排查部署问题要同时记录 Canvas commit 和 Agent Server/SDK 版本。

## 前端控制面与安全强制点

Canvas 可以显示确认对话框、隐藏危险操作或禁用按钮，但浏览器状态可绕过，所以它不是授权事实来源。真正的 allow/deny、工作区边界、凭据注入和进程隔离必须由 Agent Server/runtime 强制执行。

Terminal 与 Browser 面板也是远程资源的视图，不表示命令或网页运行在浏览器进程内。分析信任边界时需要沿 `Canvas → Agent Server → runtime/sandbox → network/filesystem` 完整追踪。

## 子会话与扩展能力

子 Agent 在 Canvas 中表现为父子会话关系。客户端工具入口 [`launch-child-conversation-client-tool.ts`](../../code/openhands/src/api/launch-child-conversation-client-tool.ts) 和服务层 [`child-conversation-launch.ts`](../../code/openhands/src/services/child-conversation-launch.ts) 负责发起子会话；真正的子 Agent 调度仍由服务端承担。

Canvas 还包含 Skills、Plugins、MCP、ACP 与 Automation 的管理接口。这些模块主要是控制面和协议适配，不应误写成 Canvas 内部实现了对应执行引擎。

## 运行与安全边界

本地开发模式可以直接让 Agent Server 接触宿主工作区；仓库明确提示这不等于安全沙箱。自托管说明建议在不完全可信的任务上使用 Docker 隔离，参见 [`SELF_HOSTING.md`](../../code/openhands/docs/SELF_HOSTING.md)。

需要特别注意：

- Canvas 展示权限确认，不代表安全边界由前端提供；服务端仍必须强制执行策略。
- WebSocket 事件可能增量、重连或延迟到达，派生状态不能假设单次完整响应。
- 当前仓库已从旧版单体 OpenHands 演进为 Agent Canvas，阅读旧文章时需核对源码版本。
- Agent Server、SDK 与 Automation Server 独立演进，跨仓库接口存在版本兼容问题。

## 推荐阅读顺序

1. [`README.md`](../../code/openhands/README.md) 与 [`docs/architecture.md`](../../code/openhands/docs/architecture.md)：确认产品和仓库边界。
2. [`agent-server-adapter.ts`](../../code/openhands/src/api/agent-server-adapter.ts)：理解后端适配层。
3. [`conversation-service`](../../code/openhands/src/api/conversation-service)：走通会话 API。
4. [`conversation-websocket-context.tsx`](../../code/openhands/src/contexts/conversation-websocket-context.tsx)：理解实时连接。
5. [`use-event-store.ts`](../../code/openhands/src/stores/use-event-store.ts) 与 [`handle-event-for-ui.ts`](../../code/openhands/src/utils/handle-event-for-ui.ts)：理解事件到 UI 状态的转换。
6. 按需进入 Terminal、Browser、Files、Skills、Automation 模块。
