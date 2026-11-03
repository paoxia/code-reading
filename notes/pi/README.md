# pi：模型接口、轻量 Loop 与实验性 Durable Harness

> 本轮复核：2026-11-02；本地源码 `62752fd4c37a72e0f3c1cc83e9ac3b4299f31fe6`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 当前分层

pi 当前至少有三条应分别理解的主线：`pi-ai` 统一模型访问，`pi-agent-core` 提供轻量 Agent Loop，`pi-coding-agent` 提供终端产品与 SDK；新增 `pi-durable` 承载可持久化会话、任务和恢复。旧笔记中的 `packages/agent/src/harness` 已不在当前树中。

| 层 | 当前入口 | 关注点 |
| --- | --- | --- |
| AI | [pi-ai README](../../code/pi/packages/ai/README.md) | Provider collection、鉴权、消息与流事件 |
| 轻量 Agent | [agent.ts](../../code/pi/packages/agent/src/agent.ts)、[agent-loop.ts](../../code/pi/packages/agent/src/agent-loop.ts) | 内存状态、工具续跑与输入队列 |
| Coding Agent | [agent-session.ts](../../code/pi/packages/coding-agent/src/core/agent-session.ts) | 产品会话、压缩、工具和扩展 |
| Durable Harness | [harness.ts](../../code/pi/packages/durable/src/harness/harness.ts) | 会话句柄、提交和运行生命周期 |
| Durable Session | [session.ts](../../code/pi/packages/durable/src/session/session.ts) | 原子 commit、entries/documents/tasks |
| Storage | [storage](../../code/pi/packages/durable/src/storage) | memory、JSONL、SQLite 等存储实现 |

## 轻量 Loop

```text
输入 → context → model stream
  → assistant message
  → 有工具：执行并加入 tool result → 下一次模型请求
  → 无工具：检查 steer / follow-up 与终止条件
```

这条链解决模型与工具反复交互，但内存 Loop 本身不等于崩溃恢复协议。恢复、文件副作用幂等和宿主权限必须在具体产品/持久化层继续检查。

## Durable 的记录模型

[pi-durable README](../../code/pi/packages/durable/README.md) 明确标为 **Experimental**，API 可在版本之间变化。其概念是：Session 为存储及执行容器；Conversation 是不可变 entries 的 transcript；Document 保存可变 JSON 状态；Task 持久化可继续的工作；Commit 将这些改变原子写入。

```text
Harness.open(storage)
  → root conversation
  → submit(input)：持久化准入
  → generation task → model → tool tasks
  → commit entries / documents / tasks
  → 已存储内容再对外展示
```

重开存储可以恢复未完成工作，进程在模型请求中死亡会计为失败 attempt 后重试，并受 restart limit 等策略约束。不能把这些语义推导成外部 API 或任意 Shell 副作用 exactly-once。

## 配置、上下文和扩展

[harness/agent.ts](../../code/pi/packages/durable/src/harness/agent.ts) 把 retry、compaction、progress、toolExecution、steeringMode 和 followUpMode 等解析为运行设置，并以 `pi.agent` document 保存每 conversation 配置。压缩见 [compaction.ts](../../code/pi/packages/durable/src/harness/compaction.ts)，工具定义与扩展要走 registry 和相应 hook。

Coding Agent 的 AgentSession 与 Durable Harness 都存在，不能因出现新包就声称终端产品所有路径已迁移过去。选择嵌入路线时要按公开入口和实际依赖核对。

## 验证材料与阅读顺序

先读 AI 与轻量 Loop，再读产品 AgentSession；需要服务端恢复时单独研究 Durable。关键材料：[重启失败测试](../../code/pi/packages/durable/test/harness-restart-failure.test.ts)、[工具测试](../../code/pi/packages/durable/test/harness-tools.test.ts)、[压缩测试](../../code/pi/packages/durable/test/harness-compaction.test.ts)。

专题：[自建 Coding Agent](./build-your-own-coding-agent.md)、[模型适配](./model-api-adaptation.md)、[跨平台适配](./cross-platform-adaptation.md)。
