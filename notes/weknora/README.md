# WeKnora：文档入库、RAG、Agent 与自动 Wiki

> 2026-11-20 收录并静态阅读。研究版本为 `1b3a1febf3e5c9b37564912d288adc838f6a2e2b`，提交日期为 2026-11-20。本次覆盖文件导入、知识问答、Agent 循环及 Wiki 编译主链，运行效果需另行验证。

[Tencent/WeKnora](https://github.com/Tencent/WeKnora) 将企业文档用于带引用的问答、多步工具调用和自动整理的 Wiki。从 [上游中文说明](../../code/weknora/README_CN.md) 了解产品能力，再沿 [Go 服务入口](../../code/weknora/cmd/server/main.go) 和各功能路由查看具体实现。

## 文档入库

[知识路由](../../code/weknora/internal/router/routes_knowledge.go) 把文件、URL 和手工录入归到指定知识库。以文件为例，[`CreateKnowledgeFromFile`](../../code/weknora/internal/application/service/knowledge_create.go) 先保存原文件，再创建 `pending` 状态的知识条目并投递解析任务。任务入队失败时会标记条目的失败状态。

后台任务 [`ProcessDocument`](../../code/weknora/internal/application/service/knowledge_process.go) 负责文档转换、分块和索引写入，并按配置触发后续处理。重复投递时会跳过已完成的文档，重新解析会产生新的尝试编号，旧任务发现自己已被替代时退出。这些检查把上传成功和索引可检索落到各自的状态上。

[飞书 Wiki 连接器](../../code/weknora/internal/datasource/connector/feishu/wiki/connector.go) 提供资源选择和可恢复的流式同步，进入[数据源服务](../../code/weknora/internal/application/service/datasource_service.go)调度的同步流程。[企业微信适配器](../../code/weknora/internal/im/wecom/factory.go) 则属于聊天渠道，负责接入会话消息。

## RAG 问答与引用

[聊天路由](../../code/weknora/internal/router/routes_chat.go) 分别注册 `/knowledge-chat`、`/agent-chat` 和 `/knowledge-search`。其中 [`KnowledgeQA`](../../code/weknora/internal/application/service/session_knowledge_qa.go) 依据请求组装事件流水线。知识问答的核心顺序是查询理解、并行检索、重排、合并与 Top K 过滤，再组装模型消息并流式生成回答。会话历史、联网结果和数据分析根据条件接入。

- [`HybridSearch`](../../code/weknora/internal/application/service/knowledgebase_search.go) 先检查知识库访问范围和嵌入模型兼容性，再按存储分组检索。向量与关键词两路都有结果时，[融合实现](../../code/weknora/internal/application/service/knowledgebase_search_fusion.go) 使用加权 Reciprocal Rank Fusion（RRF）。问答流水线还有独立的重排阶段。
- [引用构造](../../code/weknora/internal/application/service/chat_pipeline/references.go) 把检索结果和来源注册到模型上下文，并根据请求配置处理公开引用。可以从这里追踪答案里的来源编号如何对应到文档片段。

## Agent 工具循环

[`AgentEngine.Execute`](../../code/weknora/internal/agent/engine.go) 进入轮次循环，根据模型输出决定是否继续执行工具。工具注册表提供能力列表，[工具执行层](../../code/weknora/internal/agent/act.go) 调用具体工具并把结果写回 Agent 状态，供后续推理使用。阅读配置时，可再核对知识检索、MCP 与 Skills 分别如何被注册，以及每轮可见的工具、迭代预算和执行上下文如何影响行为。

## 自动 Wiki

[`EnqueueWikiIngest`](../../code/weknora/internal/application/service/wiki_ingest.go) 将待编译的文档写入 `task_pending_ops`，再调度知识库级任务。工作线程按知识库批量处理，并按文档 ID 合并待处理操作。待处理项持久化和触发任务投递是两个步骤，因此触发失败时可以重投触发任务。

[批处理](../../code/weknora/internal/application/service/wiki_ingest_batch.go) 先并行从文档提取待更新内容，再聚合同一页面的修改，最后把知识库级的索引重建交给 `ProcessWikiFinalize`。[Wiki 页面服务](../../code/weknora/internal/application/service/wiki_page.go) 在页面内容变化时保存旧版本快照。[Wiki 路由](../../code/weknora/internal/router/routes_knowledge.go) 提供页面检索、修订历史、回退和关系图入口。

## 建议阅读顺序

1. 从文件上传追到 `ProcessDocument`，核对解析失败、重试和重新解析时的状态变化。
2. 用同一知识库追踪 `KnowledgeQA` 和 `HybridSearch`，对照候选融合、问答重排和来源引用三个环节。
3. 从 `AgentEngine` 看检索作为工具被调用时如何进入下一轮，再读 Wiki 队列、页面与修订记录，理解文档如何产生可更新的知识页面。
