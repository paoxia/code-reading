# 大模型 API 差异适配

## 结论

Spring AI 采用典型的 Port/Adapter 架构：`spring-ai-model` 定义统一模型、消息、响应、选项和工具抽象，各厂商模块分别使用官方 SDK 或原生 HTTP 完成双向转换，Spring Boot 自动配置负责按依赖和属性装配。研究版本：`aa17d5c`。

## 统一调用面

`ChatModel` 与 `StreamingChatModel` 分别统一同步和流式调用，输入是 `Prompt`，输出是 `ChatResponse`/`Flux<ChatResponse>`；`ChatOptions` 提供 model、temperature、topP、maxTokens 等公共字段，并允许厂商 options 扩展（[`ChatModel.java`](../../code/spring-ai/spring-ai-model/src/main/java/org/springframework/ai/chat/model/ChatModel.java)、[`StreamingChatModel.java`](../../code/spring-ai/spring-ai-model/src/main/java/org/springframework/ai/chat/model/StreamingChatModel.java)、[`ChatOptions.java`](../../code/spring-ai/spring-ai-model/src/main/java/org/springframework/ai/chat/prompt/ChatOptions.java)）。上层 `ChatClient`、Advisor、memory 和 Agent 因此只依赖公共接口。

## 厂商适配层

每个模型模块独立完成消息角色、媒体、工具 schema、tool choice、finish reason、usage、rate limit 和流式 chunk 的映射。OpenAI 实现使用 OpenAI Java SDK，将 Spring AI message/tool/options 转成 Chat Completions 参数，再把响应还原为 `AssistantMessage` 与统一 metadata（[`OpenAiChatModel.java`](../../code/spring-ai/models/spring-ai-openai/src/main/java/org/springframework/ai/openai/OpenAiChatModel.java)）。Anthropic 实现则使用 Anthropic SDK，单独处理 `system`、content blocks、thinking、PDF/图片、cache control、server tools 和 Anthropic 流事件（[`AnthropicChatModel.java`](../../code/spring-ai/models/spring-ai-anthropic/src/main/java/org/springframework/ai/anthropic/AnthropicChatModel.java)）。这避免了把所有厂商强行压成 OpenAI wire format。

工具执行也被上移到统一的 `ToolCallingManager`，provider 适配器只负责声明和识别调用；可观测性统一成 `ChatModelObservationContext`，但仍记录实际 `AiProvider`。

## 取舍

- 公共 options 是交集，推理、缓存、原生搜索等特性需使用 `OpenAiChatOptions`、`AnthropicChatOptions` 等专属类型。
- 同一 `Prompt` 在不同 provider 上可能因角色规则、媒体支持、token 计算和停止原因产生不同结果，抽象不承诺语义完全一致。
- Spring Boot 可以降低切换成本，但应用同时装入多个同类型 model bean 时仍需显式选择，自动配置不能替代路由策略。
