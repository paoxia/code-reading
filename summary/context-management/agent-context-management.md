# Agent 上下文管理机制横向总结

> 更新日期：2026-11-02；项目版本见 [完整清单](../project-landscape/overview.md)。本轮以当前本地源码为依据，修订了 OpenCode、Kimi Code、pi 与 Goose 的旧实现路径；未运行上游测试。

## 先分开五种状态

| 状态 | 内容 | 主要消费者 |
| --- | --- | --- |
| 原始事实 | 用户输入、assistant、tool call/result、压缩记录 | 恢复、审计和投影 |
| 模型上下文 | system、有效历史、工具 schema、附件、摘要 | 当前模型请求 |
| 图/任务执行状态 | 节点、channel、pending task、checkpoint | 工作流恢复 |
| 产品展示 | 流式 delta、进度、连接与界面投影 | UI/SDK 客户端 |
| 长期记忆 | 跨会话事实、索引、工作区文件 | 检索与后续会话 |

这些状态可能由同一存储承载，但生命周期和正确性要求不同。压缩模型历史不等于删除审计，保存 checkpoint 不等于模型摘要，UI 显示结束也不等于业务任务验收。

```text
用户/项目规则/Skill/工具/附件/Memory
  → 来源发现与授权 → 按需披露
  → 会话事实投影 → 工具配对与 Provider 合法化
  → 预算估计 → 输出清理 / 历史压缩
  → 冻结模型请求 → Provider
             ↑
    工具结果与运行事件落盘
```

## 各项目的当前实现

| 项目 | 上下文与持久化入口 | 关键取舍 |
| --- | --- | --- |
| [mini-swe-agent](../../notes/mini-swe-agent/README.md) | 线性 messages、Model、Environment | 适合理解最小循环，不提供同等 durable 恢复 |
| [SWE-agent](../../notes/swe-agent/README.md) | HistoryProcessor、history 与 trajectory | 模型视图可压缩，评测轨迹另存 |
| [Aider](../../notes/aider/README.md) | RepoMap、chat files、done/cur messages | 在发请求前选择代码和符号，非全仓全文注入 |
| [Continue](../../notes/continue/README.md) | CLI session、模型历史、压缩 | 会话文件与模型摘要分层 |
| [Codex](../../notes/codex/rollout.md) | Rollout、有效历史与 compaction | 原始记录和当前模型视图分离 |
| [OpenCode](../../notes/opencode/README.md) | Session Store/Inbox/Runner、compaction | 当前已迁入 core，不再沿用旧默认 V1 的描述 |
| [Kimi Code](../../notes/kimi-code/README.md) | v2 ContextMemory、事件 fold、FullCompaction | 状态机事件、模型历史与工具配对协作 |
| [pi](../../notes/pi/README.md) | AgentSession；实验性 pi-durable 的 entries/documents/tasks | 轻量循环、产品会话和 durable 是不同入口 |
| [Goose](../../notes/goose/README.md) | SessionRuntime、状态机与压缩 operation | 原 agent.rs 已拆除，连接/活跃 run 与历史分层 |
| [Gemini CLI](../../notes/gemini-cli/README.md) | GeminiChat、ContextManager、ToolOutputMasking | 工具大输出清理与整段历史摘要不同 |
| [DeepSeek Harness](../../notes/deepseek-harness/architecture.md) | Session events、request context、投影 | 用统一事实生成模型/界面/查询视图 |
| [Hermes](../../notes/hermes-agent/README.md) | context compressor、memory、session | 长期召回与当前消息压缩分开 |
| [OpenClaw](../../notes/openclaw/README.md) | Gateway Session、嵌入 runtime、插件 | 渠道路由与模型上下文是两层 |
| [DeerFlow](../../notes/deer-flow/architecture.md) | Run/checkpoint、memory、subagents、sandbox | 长任务运行状态比消息数组更宽 |
| [LangGraph](../../notes/langgraph/README.md) | StateGraph/Pregel/channels/checkpoint | 保存图执行状态，节点仍负责外部副作用 |
| [Spring AI Alibaba](../../notes/spring-ai-alibaba/graph-runtime.md) | OverAllState、Reducer、Checkpoint | 状态合并规则和历史摘要分开 |
| [AgentScope Java](../../notes/agentscope-java/subagent.md) | StateStore、workspace/memory/compaction middleware | 会话隔离与工作区加载要显式配置 |
| [Trae Agent](../../notes/trae-agent/README.md) | Provider client 的历史与 trajectory | 历史所有权不在 BaseAgent 单一对象中 |
| [OpenManus](../../notes/openmanus/README.md) | Memory 与单任务状态 | 消息裁剪不等于语义摘要或可恢复执行 |

## 请求前的三道预算

第一道是减少不必要的来源：Aider 的 [RepoMap](../../code/aider/aider/repomap.py) 在预算内渲染符号骨架；Spring AI Alibaba 的 [SkillsInterceptor](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/skills/SkillsInterceptor.java) 根据已读取 Skill 追加动态工具；Kimi v2 的 [machine tools](../../code/kimi-code/packages/agent-core-v2/src/agent/loop/machine/tools.ts) materialize 当前工具信息。

第二道是清理 observation：Gemini CLI 的 [ToolOutputMaskingService](../../code/gemini-cli/packages/core/src/context/toolOutputMaskingService.ts) 遮蔽旧工具输出；[RTK](../../notes/rtk/README.md) 和 [Caveman](../../notes/caveman/README.md) 则在工具/Proxy 层减少内容。可恢复的原文句柄和无恢复的截断不是同一种合同。

第三道才是历史摘要：OpenCode 的 [compaction](../../code/opencode/packages/core/src/session/compaction.ts)、Kimi 的 [FullCompaction](../../code/kimi-code/packages/agent-core-v2/src/agent/fullCompaction/compactionOps.ts) 和 pi 的 [Durable compaction](../../code/pi/packages/durable/src/harness/compaction.ts) 在各自记录模型中生成新视图。

预算应包含 system、schema、多模态、Provider 开销及输出预留；不能只数用户与 assistant 文本。上述策略既可组合，也可能引入重复处理，要明确每层保留什么、谁负责恢复原文。

## 当前最重要的四处修订

**OpenCode** 已从旧 SessionProcessor 迁入 SessionExecution/Runner/Step。执行 claim 与 started event 一起落盘，shutdown 可保留恢复意图；“V2 只是非默认 scaffold”不再是当前总括结论。见 [execution.ts](../../code/opencode/packages/core/src/session/execution.ts)。

**Kimi Code** 的当前上下文入口是 v2 的 [ContextMemory](../../code/kimi-code/packages/agent-core-v2/src/agent/contextMemory/contextMemory.ts)、[loopEventFold](../../code/kimi-code/packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts) 和 [openToolExchange](../../code/kimi-code/packages/agent-core-v2/src/agent/contextMemory/openToolExchange.ts)。旧 v1 的目录、MicroCompaction 开关与 wire.jsonl 细节不能未经重新核对就移植到 v2。

**pi** 当前有独立 [pi-durable](../../code/pi/packages/durable/README.md)，明确实现持久化提交、会话和任务恢复，同时标为 Experimental。旧 AgentHarness.compact/resume 未实现的结论不适用于这个新包，也不能据此断言产品 AgentSession 已全量迁移。

**Goose** 当前的 [SessionRuntime](../../code/goose/crates/goose/src/agents/session_runtime.rs) 管理 attachment、resident session、steer、confirmation 与 run。旧 Agent 类的大型 reply 链不再是当前源码入口。

## 子 Agent 与恢复

子 Agent 应明确继承哪些事实、拥有哪个会话、用什么工具和权限、结果如何返回父任务。Kimi 的 [spawn](../../code/kimi-code/packages/agent-core-v2/src/session/subagent/spawn.ts)、Hermes 的 [delegate_tool](../../code/hermes-agent/tools/delegate_tool.py) 与 AgentScope 的 [子 Agent 笔记](../../notes/agentscope-java/subagent.md) 提供不同实现，不能归结成复制 messages 后并发调用。

恢复至少要保持：目标与约束、尚未完成意图、工具 call/result 配对、压缩边界和资源引用。重开历史或 checkpoint 不意味着可以无条件重做有副作用的工具；副作用幂等需要应用或工具另外保证。

## 如何验证上下文有效性

1. 比较压缩前后实际 Provider request，而不是只看 UI 文本。
2. 检查目标、限制、错误、下一步和未结算工具是否保留。
3. 让恢复后的 Agent 完成后续任务，观察是否反复读取或遗漏约束。
4. 同时记录 token、缓存使用、恢复开销和任务成功率。

这些是从源码归纳的验证建议，不是本轮已执行的实验。GPU KV cache、引擎 prefix caching 和 Agent 语义摘要也应分开；设备缓存主线见 [AI 基础设施总结](../ai-infrastructure/architecture-and-reading-guide.md)。
