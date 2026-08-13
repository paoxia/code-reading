# DeerFlow 2.0 源码分析

> 源码版本：`main@c542185a7f71`
>
> 研究范围：2.0 主线的全栈拓扑、Lead Agent、Middleware、Sandbox、Skills、Memory、Sub-Agent 与运行时持久化。旧版 Deep Research 实现位于 `1.x` 分支，与 2.0 不共享代码，不在本文范围内。

## 1. 定位与结论

DeerFlow 2.0 不是单纯的研究工作流，而是一个面向分钟到小时级任务的全栈 SuperAgent harness。它以 LangChain `create_agent()` 和 LangGraph 状态/检查点能力为 Agent 内核，在外围补齐线程级文件系统、隔离执行、长期记忆、Skills、子 Agent、流式事件、Web UI 和消息渠道。

源码入口与官方定位见 [`README_zh.md`](../../code/deer-flow/README_zh.md)，后端整体说明见 [`backend/docs/ARCHITECTURE.md`](../../code/deer-flow/backend/docs/ARCHITECTURE.md)。

最重要的架构判断是：

- Lead Agent 是稳定主干，功能主要通过有顺序的 Middleware 和 Tool 注入；
- 每个线程拥有独立的 `workspace/uploads/outputs`，Sandbox 把虚拟路径映射到线程数据目录；
- Sub-Agent 是 Lead Agent 的委托执行单元，拥有独立模型循环和服务器生成的执行 ID；
- Gateway 同时承担 REST API、LangGraph 兼容 API、运行管理和 SSE 桥接，不再依赖独立 LangGraph Server；
- 2.0 已明显超出“Agent Demo”：它包含鉴权、持久化、定时任务、消息渠道和扩展包等平台能力。

## 2. 整体架构

```text
Browser / IM Channel
        │
        ▼
Nginx :2026
  ├─ /              → Next.js Frontend :3000
  ├─ /api/*         → FastAPI Gateway :8001
  └─ /api/langgraph → LangGraph-compatible runtime in Gateway
                              │
                              ▼
                    RunManager / run_agent
                              │
                              ▼
                     Lead Agent Graph
                 ┌────────────┼─────────────┐
                 ▼            ▼             ▼
             Middleware      Tools       Sub-Agents
                 │            │             │
                 └──── Sandbox / Memory ────┘
                              │
                              ▼
                  Checkpoint / Event / Files
```

根目录 [`AGENTS.md`](../../code/deer-flow/AGENTS.md) 给出的默认服务拓扑包括 Nginx、Gateway、Frontend，以及按配置启用的 Provisioner。Gateway 入口在 [`backend/app/gateway/app.py`](../../code/deer-flow/backend/app/gateway/app.py)，运行管理集中在 [`runtime/runs/manager.py`](../../code/deer-flow/backend/packages/harness/deerflow/runtime/runs/manager.py)。

## 3. Lead Agent 组装

核心工厂是 [`make_lead_agent()`](../../code/deer-flow/backend/packages/harness/deerflow/agents/lead_agent/agent.py)。它并未自行实现一套 ReAct 循环，而是组装模型、工具、Prompt、状态 schema 和 LangChain Middleware 后调用 `create_agent()`。

运行时配置的主要优先级是：

```text
request context/configurable > custom agent config > application default
```

因此模型、thinking、plan mode 等可以按请求覆盖；代码使用“键是否存在”而不是简单 truthy 判断，保证显式的 `false` 不会错误回退。

当前工厂涉及的主要 Middleware 包括：

| Middleware | 职责 |
|---|---|
| `MemoryMiddleware` | 检索并注入长期记忆，触发记忆更新 |
| `DeerFlowSummarizationMiddleware` | 上下文过长时总结历史 |
| `TitleMiddleware` | 生成会话标题 |
| `TodoMiddleware` | Plan Mode 下维护任务列表 |
| `SubagentLimitMiddleware` | 限制单次 Run 可创建的子 Agent 总量 |
| `LoopDetectionMiddleware` | 识别重复工具调用等循环迹象 |
| `ViewImageMiddleware` | 为支持视觉的模型提供图片内容 |
| `TokenUsageMiddleware` | 归集主 Agent 与子 Agent token 使用量 |
| `TerminalResponseMiddleware` | 规范化最终响应 |
| `SafetyFinishReasonMiddleware` | 处理模型安全终止原因 |
| `ModelLengthFinishReasonMiddleware` | 处理长度截断并提供可理解结果 |

具体顺序和条件以 [`agent.py`](../../code/deer-flow/backend/packages/harness/deerflow/agents/lead_agent/agent.py) 中传给 `create_agent()` 的列表为准。Middleware 顺序会影响模型请求、工具执行和状态更新，不能视为可任意排序的插件集合。

## 4. 一次请求的主要调用链

```text
HTTP / Channel message
  → Gateway 创建或恢复 Run
  → RunManager 启动 worker
  → run_agent() 加载 checkpoint 与线程上下文
  → make_lead_agent() 组装 Agent
  → Middleware.before_agent / before_model
  → Model 产生文本或 tool calls
  → Middleware / ToolNode 执行工具
  → 需要时 task 工具委托 Sub-Agent
  → 状态写入 checkpoint，事件写入 StreamBridge/EventStore
  → Gateway 通过 SSE 返回客户端
```

运行时并非只保存最后一条消息。`runtime/` 下区分 Run、Checkpoint、事件和流桥接：[`runs/manager.py`](../../code/deer-flow/backend/packages/harness/deerflow/runtime/runs/manager.py) 管理执行生命周期，[`checkpointer/provider.py`](../../code/deer-flow/backend/packages/harness/deerflow/runtime/checkpointer/provider.py) 选择检查点实现，[`events/store`](../../code/deer-flow/backend/packages/harness/deerflow/runtime/events/store) 保存可恢复事件，[`stream_bridge`](../../code/deer-flow/backend/packages/harness/deerflow/runtime/stream_bridge) 在进程内或 Redis 间转发实时输出。

## 5. Sandbox 与线程文件系统

抽象接口位于 [`sandbox/sandbox.py`](../../code/deer-flow/backend/packages/harness/deerflow/sandbox/sandbox.py) 和 [`sandbox/sandbox_provider.py`](../../code/deer-flow/backend/packages/harness/deerflow/sandbox/sandbox_provider.py)。`SandboxMiddleware` 在 Agent 生命周期中获取执行环境，工具通过统一 Sandbox 接口读写文件或执行命令。

模型看到的稳定路径为：

| 虚拟路径 | 用途 |
|---|---|
| `/mnt/user-data/workspace` | 工作区 |
| `/mnt/user-data/uploads` | 用户上传文件 |
| `/mnt/user-data/outputs` | 最终产物 |
| `/mnt/skills` | 可用 Skills |

本地 Provider 主要用于开发。源码明确提醒：本地文件隔离不等于安全沙箱，host bash 默认关闭；生产隔离由 AIO Sandbox/Provisioner 等实现承担。工具封装见 [`sandbox/tools.py`](../../code/deer-flow/backend/packages/harness/deerflow/sandbox/tools.py)。

## 6. Sub-Agent

[`SubagentExecutor`](../../code/deer-flow/backend/packages/harness/deerflow/subagents/executor.py) 为每个委托任务构建独立 Agent，并支持后台线程、超时、取消、token 统计和终态竞争保护。

这里有两个容易忽略的 ID：

- `external_task_id` 保存模型 Provider 产生的 `tool_call_id`，用于 ToolMessage、SSE 和 UI 关联；
- `task_id` 是服务器生成的全局执行 ID，用于 Registry、取消、超时和清理。

两者不能合并，因为 Provider 的 tool call ID 在不同父 Run 之间不保证全局唯一。`SubagentResult.try_set_terminal()` 还保证取消/超时线程和正常 worker 竞争时只有一个终态获胜。

Sub-Agent 的设计更接近“受控的独立 Agent 执行”，而不是 Lead Agent 图中的普通函数节点。注册与可用 Agent 类型由 [`subagents/registry.py`](../../code/deer-flow/backend/packages/harness/deerflow/subagents/registry.py) 管理。

## 7. Skills、Memory 与扩展

Skills 目录不只做 Prompt 拼接。`skills/` 包含 frontmatter 解析、目录投影、安装、权限、静态安全扫描和 package review；核心入口可从 [`skills/catalog.py`](../../code/deer-flow/backend/packages/harness/deerflow/skills/catalog.py)、[`skills/parser.py`](../../code/deer-flow/backend/packages/harness/deerflow/skills/parser.py) 和 [`skills/security_scanner.py`](../../code/deer-flow/backend/packages/harness/deerflow/skills/security_scanner.py) 开始阅读。

Memory 通过统一 Manager 接口支持 `noop`、DeerMem、Mem0、Honcho 和 OpenViking 等后端。内置 DeerMem 将提取、更新、检索和存储拆开，相关实现位于 [`agents/memory/backends/deermem`](../../code/deer-flow/backend/packages/harness/deerflow/agents/memory/backends/deermem)。这部分仍在持续演进，配置与后端语义不能假设完全等价。

除 MCP 与 Skills 外，2.0 还支持可信 Python Extension。扩展代码与构建 Hook 以 Gateway 权限执行，因此它属于运营者信任边界，而不是面向任意用户的安全插件沙箱。

## 8. 限制与注意事项

- DeerFlow 2.0 与 `1.x` 是两套实现，旧文章中的 Research Graph 不能直接套用。
- 本地 Sandbox Provider 不提供真正的主机隔离；部署时应明确选择安全 Provider。
- Lead Agent 能力来自较长的 Middleware 链，新增 Middleware 必须审查顺序、状态 schema 与 tracing 影响。
- Gateway 同时承担 API 和 Agent Runtime，部署简单，但长任务的事件存储、Redis 桥接和恢复配置会直接影响可靠性。
- 仓库中存在多份 RFC、计划和 `TODO` 文档；本文只把已进入当前主线代码的能力写作确定实现。

## 9. 推荐阅读顺序

1. [`README_zh.md`](../../code/deer-flow/README_zh.md)：认识产品边界。
2. [`backend/docs/ARCHITECTURE.md`](../../code/deer-flow/backend/docs/ARCHITECTURE.md)：建立服务拓扑。
3. [`lead_agent/agent.py`](../../code/deer-flow/backend/packages/harness/deerflow/agents/lead_agent/agent.py)：看 Agent 如何组装。
4. [`agents/thread_state.py`](../../code/deer-flow/backend/packages/harness/deerflow/agents/thread_state.py)：理解状态字段。
5. [`sandbox/middleware.py`](../../code/deer-flow/backend/packages/harness/deerflow/sandbox/middleware.py) 与 [`sandbox/tools.py`](../../code/deer-flow/backend/packages/harness/deerflow/sandbox/tools.py)：理解执行环境。
6. [`subagents/executor.py`](../../code/deer-flow/backend/packages/harness/deerflow/subagents/executor.py)：理解委托、取消和终态。
7. [`runtime/runs/manager.py`](../../code/deer-flow/backend/packages/harness/deerflow/runtime/runs/manager.py)：理解长任务运行管理。
8. `backend/tests/` 中对应测试：用测试确认恢复、流式事件和并发语义。
