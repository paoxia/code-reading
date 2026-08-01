# 大模型 API 差异适配

## 结论

Spring AI Alibaba 没有在 Agent 运行时重新定义一套模型协议，而是把主要差异交给 Spring AI 的 `ChatModel`、`ChatClient`、`ChatOptions` 和各厂商实现处理。它自身增加的适配主要位于 Admin：用 `ChatClientFactory` 按 provider 创建不同的 Spring AI 模型，再把统一的 `ChatClient` 注入图节点和 Agent。研究版本：`84ca19a12`。

## 实现方式

调用侧只依赖 Spring AI 抽象。Agent builder 接收任意 `ChatModel`，`AgentLlmNode` 最终通过统一的 `ChatClient` 发起同步或流式调用，因此 Agent Loop 不感知 DashScope、DeepSeek 或 OpenAI 的请求结构差异（[`Builder.java`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/Builder.java)、[`AgentLlmNode.java`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/node/AgentLlmNode.java)）。

Admin 层使用工厂注册表做 provider 分派。`ChatClientFactoryDelegate` 目前显式注册 OpenAI、DashScope、DeepSeek 三个工厂，根据模型配置中的 `provider` 选择工厂；每个工厂分别构造厂商 `ChatModel` 和对应的 `ChatOptions`，最后统一包装成 `ChatClient`（[`ChatClientFactory.java`](../../code/spring-ai-alibaba/spring-ai-alibaba-admin/spring-ai-alibaba-admin-server-start/src/main/java/com/alibaba/cloud/ai/studio/admin/service/client/ChatClientFactory.java)、[`ChatClientFactoryDelegate.java`](../../code/spring-ai-alibaba/spring-ai-alibaba-admin/spring-ai-alibaba-admin-server-start/src/main/java/com/alibaba/cloud/ai/studio/admin/service/client/ChatClientFactoryDelegate.java)）。用户参数覆盖模型默认参数，provider 专属参数则留在各工厂内。

## 差异边界与注意事项

- 统一的是上层调用形态，不保证所有 provider 的参数和能力完全等价；具体消息转换、工具调用和流式事件仍由 Spring AI 模型实现决定。
- 未识别的 provider 会回退到 OpenAI 工厂，这有利于 OpenAI-compatible 端点，但也可能把拼写错误延迟成上游请求错误。
- `DefaultBuilder` 为合并 provider 专属 `ChatOptions` 使用了反射，并明确警告 options 类型应与模型默认类型一致；这说明 provider 切换时不能任意混用不同实现的 options（[`DefaultBuilder.java`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/DefaultBuilder.java)）。
- `ModelFallbackInterceptor` 接收一组统一的 `ChatModel`，可跨 provider 做失败切换，但它解决的是可用性，不会把不兼容参数自动翻译成另一厂商语义（[`ModelFallbackInterceptor.java`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/modelfallback/ModelFallbackInterceptor.java)）。
