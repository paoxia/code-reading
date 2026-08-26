# Agent 上下文管理机制横向总结

> 研究时间：2026-08-24
>
> 研究范围：本仓库中具有可执行 Agent Loop、会话运行时或 Agent 框架能力的项目。重点比较模型可见上下文、会话事实、压缩、恢复、长期记忆与子 Agent 上下文；不把普通 HTTP request context、前端状态或模型 KV Cache 纳入同一概念。

## 1. 核心结论

成熟 Agent 的上下文管理不是维护一个不断增长的 `messages` 数组，而是一条“事实记录 → 选择与投影 → 预算控制 → Provider 合法化 → 模型请求”的编译流水线：

```text
用户输入 / 工具结果 / 工作区规则 / Skills / 检索结果 / 长期记忆
                           │
                           ▼
             Session / Event Log / Checkpoint
                  （可恢复的事实层）
                           │
                           ▼
          选择、排序、权限过滤、父子作用域裁剪
                           │
                           ▼
        工具输出清理 → 历史摘要 → token 预算校验
                           │
                           ▼
       tool-call 配对、role 修复、Provider 协议适配
                           │
                           ▼
                    本轮模型上下文
```

从源码看，项目间真正的差异不在于“有没有 Memory”，而在于以下六个问题：

1. 哪些事实是权威记录，哪些只是本轮投影；
2. 工作区、代码、工具和记忆以何种粒度按需进入上下文；
3. token 压力出现时先删什么、再总结什么；
4. 压缩后能否恢复、审计或搜索原始事实；
5. Provider 切换后如何保持 role、tool call/result 和媒体消息合法；
6. 子 Agent 继承什么、隔离什么、最终向父 Agent 返回什么。

## 2. 先区分五种“上下文”

| 概念 | 主要用途 | 典型生命周期 | 不能替代什么 |
| --- | --- | --- | --- |
| 模型上下文 | 构造本次模型请求 | 一次 sampling step | 完整审计记录 |
| 会话事实 / transcript | 恢复、回放、分叉、审计 | 一个或多个 turn | 自动得到最优 prompt |
| 工作流状态 / checkpoint | 保存 graph channel、待执行任务和中断点 | 一个 thread/run | 长期语义记忆 |
| 长期记忆 | 跨会话召回偏好、事实和历史经验 | 用户、项目或 Agent 生命周期 | 当前会话的精确事件顺序 |
| 工作区上下文 | 规则、代码、Skill、项目知识 | 目录、仓库或任务生命周期 | 会话状态和工具执行结果 |

这一区分在框架中尤其重要。例如 Spring AI 明确把 [`ChatMemory`](../../code/spring-ai/spring-ai-model/src/main/java/org/springframework/ai/chat/memory/ChatMemory.java) 定义为“选择本轮需要的消息”，而 [`ChatMemoryRepository`](../../code/spring-ai/spring-ai-model/src/main/java/org/springframework/ai/chat/memory/ChatMemoryRepository.java) 只负责存取；LangGraph 的 [`BaseCheckpointSaver`](../../code/langgraph/libs/checkpoint/langgraph/checkpoint/base/__init__.py) 则保存 channel version、pending writes 和 task，它不是聊天摘要器。

## 3. 上下文进入模型前经历什么

### 3.1 来源发现与按需披露

最简单的 mini-swe-agent 直接把 system、task、assistant action 和 observation 追加到 [`DefaultAgent.messages`](../../code/mini-swe-agent/src/minisweagent/agents/default.py)，每步原样交给模型。实现容易理解，但没有默认压缩、持久会话或跨会话记忆。

更成熟的实现会避免一次性加载所有资源：

- Aider 的 [`RepoMap`](../../code/aider/aider/repomap.py) 用 Tree-sitter/grep-ast 提取定义与引用，根据 chat files、用户提到的文件和标识符排序，在 token 预算内渲染代码骨架；可编辑文件、只读文件与其他仓库文件是三个不同集合。
- AgentScope Java 的 [`WorkspaceContextMiddleware`](../../code/agentscope-java/agentscope-harness/src/main/java/io/agentscope/harness/agent/middleware/WorkspaceContextMiddleware.java) 负责加载 `AGENTS.md`、`MEMORY.md` 和 knowledge catalog，再以明确区块注入工作区上下文。
- Kimi Code 的动态工具上下文位于 [`dynamic-tools.ts`](../../code/kimi-code/packages/agent-core/src/agent/context/dynamic-tools.ts)：工具目录与真正加载的 schema 分离，减少“大量工具定义常驻 prompt”。
- Hermes 的 Skill、Memory recall 和插件 `pre_llm` 结果在 [`build_turn_context`](../../code/hermes-agent/agent/turn_context.py) 汇合；长期记忆是一次有来源的召回，不是把整个历史数据库塞给模型。

因此，上下文选择本质上也是权限控制：模型“知道某资源存在”、模型“读到了内容”和工具“获准修改资源”是三件事。

### 3.2 结构修复与 Provider 合法化

工具型 Agent 不能随意删除单条消息。assistant tool call 与 tool result 必须成对，system/user/assistant 的顺序也受 Provider 约束。

- Kimi Code 的 [`ContextMemory`](../../code/kimi-code/packages/agent-core/src/agent/context/index.ts) 从追加记录投影消息，并处理 tool call/result 配对、历史版本兼容和压缩后的形状。
- Gemini CLI 的 [`GeminiChat`](../../code/gemini-cli/packages/core/src/core/geminiChat.ts) 会校验、精选、合并角色，并清理不同 Provider 不兼容的 thought/tool-call 标识。
- Codex 的 [`ContextManager`](../../code/codex/codex-rs/core/src/context_manager/history.rs) 归一化 Responses item、补齐工具输出并执行内容截断；[`context-fragments`](../../code/codex/codex-rs/context-fragments/src) 还保留内容种类和来源，使 fork、compaction 与模型切换不只传递裸文本。
- Spring AI Alibaba 的 [`SummarizationHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/summarization/SummarizationHook.java) 在选择截断点时显式避免拆开 assistant tool call 与其 tool response。

这解释了为什么“从尾部保留最后 N 条消息”通常不够：它可能制造 Provider 无法接受的历史。

### 3.3 三层预算控制

源码中常见的压缩顺序是从低损失到高损失逐层升级：

1. **限制单个大对象**：截断 shell/tool output，移除旧媒体或只保留头尾。
2. **清理旧工具结果**：保留工具调用的存在和简短占位，但移除低价值大正文。
3. **总结较老会话**：使用模型生成 summary，保留近期原始消息后继续执行。

代表实现如下：

| 层次 | 代表项目 | 实现特点 |
| --- | --- | --- |
| 单项截断 | Codex | [`truncate_function_output_payload`](../../code/codex/codex-rs/core/src/context_manager/history.rs) 对函数与自定义工具输出应用统一策略 |
| 工具结果清理 | Gemini CLI | [`ToolOutputMaskingService`](../../code/gemini-cli/packages/core/src/context/toolOutputMaskingService.ts) 在完整会话压缩前先遮蔽旧工具大输出 |
| 工具结果清理 | LangChain | [`ContextEditingMiddleware`](../../code/langchain/libs/langchain_v1/langchain/agents/middleware/context_editing.py) 在阈值后按策略清理旧 tool uses |
| 工具结果清理 | Spring AI Alibaba | [`ContextEditingInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/contextediting/ContextEditingInterceptor.java) 按 token 计数选择可清理的旧工具消息 |
| 历史总结 | Continue | [`compaction.ts`](../../code/continue/extensions/cli/src/compaction.ts) 生成摘要，记录 compaction index，并让 Agent 在摘要上下文上继续 |
| 历史总结 | Codex | [`context_window.rs`](../../code/codex/codex-rs/core/src/session/context_window.rs) 区分主动阈值与模型硬窗口，压缩摘要进入有效历史，原 rollout 保留 |
| 历史总结 | Kimi Code | [`FullCompaction`](../../code/kimi-code/packages/agent-core/src/agent/compaction/full.ts) 与 Context 投影协作；当前 [`MicroCompaction`](../../code/kimi-code/packages/agent-core/src/agent/compaction/micro.ts) 源码已明确禁用，不能写成现行生效能力 |
| 历史总结 | Goose | [`CompactionOperation`](../../code/goose/crates/goose/src/agents/state_machine/ops_compaction.rs) 支持主动、手动和 context-error 恢复，并限制重复压缩 |
| 历史总结 | AgentScope Java | [`CompactionMiddleware`](../../code/agentscope-java/agentscope-harness/src/main/java/io/agentscope/harness/agent/middleware/CompactionMiddleware.java) 根据模型窗口减去 reserved tokens 动态决定触发阈值 |

压缩阈值不能只统计对话文本。工具 schema、system instructions、图片、Provider 固定开销和输出预留都会占窗口。Hermes 的 [`ContextCompressor`](../../code/hermes-agent/agent/context_compressor.py) 与 Codex、AgentScope Java 都把这些辅助开销纳入决策。

### 3.4 压缩与事实保留分离

成熟系统通常不破坏性删除原历史，而是保留完整事实，再维护一个“模型当前可见视图”：

- Codex 用 [`RolloutRecorder`](../../code/codex/codex-rs/rollout/src/recorder.rs) 追加 canonical item；compaction、rollback 和 fork 改变逻辑视图，不要求删除原 JSONL。
- OpenCode V1 每轮从持久 Session 重新读取并过滤 compacted messages，[`SessionProcessor`](../../code/opencode/packages/opencode/src/session/processor.ts) 把模型流归约成 message/part；V2 进一步用 durable inbox、event projector 和 Context Epoch 保存特权系统上下文基线，但仍是演进中的非默认主链。
- Kimi Code 把运行记录写入 Session 的 `wire.jsonl`，恢复时重放记录并重建 Context、工具、Goal 和后台任务投影，而不是反序列化一个巨型可变对象。
- DeepSeek Harness 把 Session 定义为追加事件，并将压缩拆成 [`compaction-basic`](../../code/deepseek-harness/packages/compaction/compaction-basic/src)、[`compaction-tool-result-pruner`](../../code/deepseek-harness/packages/compaction/compaction-tool-result-pruner/src) 等可组合插件；持久化由 [`session-persistence`](../../code/deepseek-harness/packages/session/session-persistence/src) 协调 JSONL/SQLite 后端。
- Goose 在 Operation 产生 effect 后落地 Session，再从持久化状态重读；新状态机正在逐步替代旧 `Agent` 中的大型装配循环，当前仍需区分两条路径。

这种设计的关键收益不是“永远不丢 token”，而是压缩错误仍可审计、搜索、重新投影或从原始事件恢复。

### 3.5 Checkpoint、Session 与长期记忆

三者应分层，而不是共用一个模糊的 `memory` 对象：

- **Session** 保存对话与工具事实。Continue 保存 JSON session 并支持 resume/fork；Codex、Kimi Code、OpenCode、Goose 和 Hermes 都有更完整的追加或数据库事实层。
- **Checkpoint** 保存执行状态。LangGraph checkpoint 包含 channel versions、tasks 与 pending writes；Spring AI Alibaba 通过 `threadId + CheckpointSaver` 延续 `OverAllState`。这支持 interrupt/resume，但不会自动筛选最有用的模型上下文。
- **长期记忆** 跨会话检索。Hermes 的 [`MemoryManager`](../../code/hermes-agent/agent/memory_manager.py) 在 turn 前预取 recall，并在 turn/compression/delegation 生命周期通知 provider；DeerFlow 的 [`MemoryMiddleware`](../../code/deer-flow/backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py) 对接多种后端；AgentScope Java 用 Workspace/Memory middleware 分离加载与落盘。
- **短窗口消息记忆** 不等于长期记忆。Spring AI 默认 [`MessageWindowChatMemory`](../../code/spring-ai/spring-ai-model/src/main/java/org/springframework/ai/chat/memory/MessageWindowChatMemory.java) 只保留有限消息窗口，并保护 system message 与合法切点。

长期记忆还需要写入策略。把完整 Skill、工具输出或压缩脚手架误写为“用户偏好”，会在未来会话中持续污染召回；Hermes 因而在 Memory 层剥离 Skill 展开内容，OpenClaw 也通过 memory 文件来源与 incognito 约束区分允许持久化的内容。

### 3.6 子 Agent 上下文：复制、继承还是隔离

子 Agent 最稳妥的默认不是复制父 Agent 的全部 transcript，而是传入明确任务、必要资源和受限能力，完成后只回注结构化结果：

- Hermes 的 [`delegate_task`](../../code/hermes-agent/tools/delegate_tool.py) 创建全新对话，不继承父 transcript；子 Agent 继承裁剪后的 toolsets，父 Agent 只接收任务结果摘要。
- Kimi Code v1 子 Agent 共享 Session 级 Skill、MCP 和部分权限上下文，但拥有独立 Agent 目录、消息、记录与运行状态，入口在 [`SessionSubagentHost`](../../code/kimi-code/packages/agent-core/src/session/subagent-host.ts)。
- OpenCode 的 task 工具创建子 Session，并复用同一套 prompt、工具、权限和持久化服务；执行过程在父 Session 中表现为一个 tool part。
- Spring AI Alibaba 为子线程生成独立 thread ID，避免共享 `CheckpointSaver` 时父子状态串线。
- DeerFlow 的 [`SubagentExecutor`](../../code/deer-flow/backend/packages/harness/deerflow/subagents/executor.py) 建立独立 Agent 运行，并将中间步骤作为单独事件保存；子 Agent 的总结、token 上限和长期记忆 flush 也要单独控制，避免污染父 thread。

Codex 新增的上下文来源标注说明了另一条原则：即使 fork 继承内容，也应继承“这是 developer instruction、工作区上下文还是普通用户消息”的来源，而不是降级为没有权限语义的纯文本。

## 4. 项目实现矩阵

| 项目 | 权威事实层 | 模型上下文控制 | 恢复 / 长期状态 | 当前边界 |
| --- | --- | --- | --- | --- |
| mini-swe-agent | 内存 `messages` | 线性追加 | 主要是运行结果/trajectory | 默认无压缩、会话恢复和长期记忆 |
| SWE-agent | history + trajectory | 可组合 [`HistoryProcessor`](../../code/swe-agent/sweagent/agent/history_processors.py) | trajectory 用于评测审计 | processed history 不等于完整 trajectory |
| Aider | chat history + Git/文件集合 | Repo Map、chat files、摘要与 token 检查 | 可恢复聊天/Git 状态 | 强项是代码上下文选择，不是通用 durable runtime |
| Continue CLI | JSON session + ChatHistory | 自动/手动 compaction、按组裁剪 | resume、fork | Session 保存失败当前只记录日志 |
| Codex | append-only rollout + SQLite 投影 | item 归一化、工具输出截断、主动/溢出压缩 | resume、fork、rollback、thread tree | 模型 history 与客户端 event 不是同一集合 |
| OpenCode | DB message/part；V2 event projection | 每轮重投影、compaction、Context Epoch | Session 恢复、snapshot/revert | V1 是默认主链，V2 durable runner 仍在演进 |
| Kimi Code | `wire.jsonl` 追加记录 | Provider 投影、Full Compaction、动态工具披露 | replay、fork、Goal/后台任务恢复 | v1/v2 并存；Micro Compaction 当前禁用 |
| Gemini CLI | `GeminiChat` history / session | curated history、tool masking、chat compression | start/resume chat、checkpointing | UI loop 与 headless loop 需分别核对 |
| Goose | 持久 Session | tool-pair 清理、主动/手动/错误恢复压缩 | 多入口 Session、导入其他 Agent 会话 | 新状态机与旧 Agent 并存 |
| DeepSeek Harness | 追加 Session event | 可组合 compaction 插件 | JSONL/SQLite、projection/query | Cordis 插件装配决定实际启用能力 |
| pi | 现行 AgentSession JSONL；新 Harness Session tree | 产品层已有 transform/compaction；新 Harness 有 helper | 产品层可分叉；新 Harness 有 storage | 新 `AgentHarness.compact/resume` 仍显式未实现 |
| Trae Agent | message history + trajectory | 主要复用/重设线性历史 | trajectory 记录执行 | 没有与 Codex/Kimi 等价的默认压缩事实层 |
| OpenManus | `BaseAgent.memory` | 有界 loop 下的线性消息 | Agent state | Memory 名称不代表跨会话持久检索 |
| OpenClaw | Session/transcript + memory artifacts | context engine、compaction planning、overflow retry | 多渠道路由、transcript、memory search | Gateway 路由 key 决定上下文隔离边界 |
| Hermes | SQLite SessionDB + FTS | stable prefix、压缩锁、Context Engine | 跨会话 Memory、rewind、delegation | 多进程写入和压缩需要 fencing/重试 |
| DeerFlow | LangGraph checkpoint + run events/files | summarization、工具输出预算、动态上下文 | thread 恢复、多 Memory backend | checkpoint、event、memory 是独立层 |
| AgentScope Java | `AgentStateStore` | workspace、tool eviction、compaction middleware | `(userId, sessionId)` 状态、Memory flush | RuntimeContext 必须明确隔离会话 |
| LangChain | AgentState / middleware state | Context Editing + Summarization middleware | 依赖 LangGraph checkpointer/store | 提供策略积木，不替应用选择默认政策 |
| Spring AI Alibaba | `OverAllState` + CheckpointSaver | Hook 总结、Interceptor 清理工具结果、Skills 按需披露 | thread checkpoint、子图/子 Agent | 要显式配置 reducer 与 thread ID |
| LangGraph | channel state + checkpoint | 由应用节点/中间件决定 | interrupt、resume、replay、time travel | checkpoint 不是自动 prompt 压缩 |
| Spring AI | ChatMemoryRepository | MessageWindow + Advisor/RAG | 多种 repository | ChatMemory 不是不可变审计历史 |
| OpenHands 当前 checkout | Agent Server 是事实来源 | 前端只展示 context meter/触发 compact | WebSocket/HTTP 控制会话 | 本地仓库主要是 Canvas，不能据此推断后端压缩算法 |

## 5. 典型调用链

### 5.1 Continue：摘要替换模型视图

```text
ChatHistory
  → shouldAutoCompact()
  → compactChatHistory()
  → 用同一模型生成 summary
  → 写入 compactionIndex
  → getHistoryForLLM() 只投影摘要后的有效历史
  → 继续原任务
```

### 5.2 Codex：事实记录与有效上下文分离

```text
Rollout canonical items
  → rollout reconstruction / rollback markers
  → ContextManager 归一化并截断单项输出
  → context-window 检查
  → 必要时 compaction task
  → compacted model history

原始 rollout ─────────────────────────→ 审计、fork、重建
```

### 5.3 Kimi Code：记录重放驱动上下文投影

```text
wire.jsonl records
  → replay
  → ContextMemory
  → Provider-compatible projection
  → beforeStep 检查 Full Compaction
  → LLM request
  → tool call/result 继续追加 records
```

### 5.4 LangGraph / Spring AI Alibaba：状态恢复不等于摘要

```text
threadId
  → load checkpoint
  → 恢复 channels / pending writes / agent state
  → Hook 或 Middleware 选择模型 messages
  → model/tool nodes
  → reducer 合并更新
  → save checkpoint
```

## 6. 设计取舍与风险

1. **摘要会丢细节**。即使原始 transcript 仍可审计，模型后续只看到 summary 时也可能忘记精确路径、错误文本或未完成约束。摘要 prompt 应要求保留决策、待办、文件、命令结果和失败原因。
2. **工具对是最小一致性单元**。裁剪、分叉、回滚和 Provider 转换都不能留下孤立 tool call 或 tool result。
3. **并发会放大上下文竞争**。同一 Session 应串行提升输入；压缩要有 lock/fencing，否则模型回复、工具结果和 summary 可能互相覆盖。
4. **Prompt cache 与压缩存在冲突**。稳定 system prefix 有利于缓存命中，频繁改写历史则会破坏前缀；Hermes 对这一点处理得最显式。
5. **长期记忆必须有来源和删除语义**。召回结果应标记为历史资料而非新用户指令，并处理用户 rewind、incognito、过期和权限变化。
6. **恢复要重放逻辑语义，而不是拼接文本**。rollback、compaction、tool lifecycle、Provider metadata 和中断边界都可能仍物理存在于日志中，但不再属于当前有效视图。
7. **子 Agent 隔离同时是成本与安全机制**。全量复制父上下文增加 token、泄露权限并污染父历史；只回注结果摘要又可能丢证据，因此最好同时保留独立子任务日志供按需查询。

## 7. 推荐实现顺序

如果从零实现一个可长期运行的 Agent，源码给出的稳妥顺序是：

1. 先定义 canonical message/tool event，以及 tool call/result 配对不变量；
2. 分离完整 Session 事实与本轮模型投影；
3. 给工具输出设置单项预算，并在截断标记中说明丢失量；
4. 加入 token 估算、输出预留和主动阈值；
5. 再加入 summary compaction，并保留原始事实；
6. 加入 resume/fork/rollback，验证崩溃尾行和幂等重放；
7. 最后引入长期记忆、子 Agent 和多入口并发，明确继承、权限、锁与清理策略。

最小验证集应覆盖：超长工具输出、并行工具对、压缩时新增用户输入、压缩失败、压缩后 Provider 切换、Session 崩溃恢复、fork 后父子隔离、召回内容过期以及子 Agent 失败后的结果回注。

## 8. 研究边界与源码版本

本总结以 2026-08-24 本地 checkout 为准，主要版本如下：

| 项目 | 版本 | 项目 | 版本 |
| --- | --- | --- | --- |
| mini-swe-agent | `25941c89cfbc` | SWE-agent | `3ea751c087f3` |
| Aider | `5dc9490bb35f` | Continue | `5522c6f44ca0` |
| Codex | `339751715c64` | OpenCode | `03521003fafd` (`dev`) |
| Kimi Code | `dceb3fd634aa` | Gemini CLI | `5411f113cafa` |
| Goose | `2eb3ab1001de` | DeepSeek Harness | `b150a551b8d4` (`master`) |
| pi | `4af9d21d` | OpenClaw | `4c48c13ab603` |
| Hermes Agent | `dc50f020905d` | DeerFlow | `cc6a2657e7ba` |
| AgentScope Java | `c2d43f86e668` | Spring AI Alibaba | `c65a3eb5f57c` |
| LangChain | `c4c57d35bfab` (`master`) | LangGraph | `f09cfe8ffc1e` |
| Spring AI | `fd3fd6ec7003` | OpenHands | `861e9ef50173` |

未执行各上游项目的完整测试或真实模型长会话实验；本文结论来自当前源码、测试入口和仓库内已有项目笔记的交叉核对。`code/caveman` 当前不在工作区，虽然已有历史笔记，但未纳入本次“当前源码已验证”的实现矩阵。`vllm` 的 KV Cache、`sub2api` 的 HTTP request context、`rtk` 的命令输出压缩和 Better Harness 的评估证据不属于同一 Agent 上下文生命周期，因此也未作为主实现比较。
