# 大模型 API 差异适配

## 结论

AgentScope Java 采用“核心中立模型 + 独立扩展模块 + Formatter”的三层结构：核心只认识 `Msg`、`ToolSchema`、`GenerateOptions`、`ChatResponse`，provider 模块负责 HTTP/SDK 调用，Formatter 负责同一协议家族内部的消息、工具和参数细节。研究版本：`1bd783de`。

## 统一抽象

`Model` 只暴露流式 `stream(...)` 和少量能力查询；同步结果可以由流聚合得到。结构化输出、结构化输出与工具共存、上下文窗口等不能安全假设的特性被设计成显式 capability，默认返回不支持或未知（[`Model.java`](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/Model.java)）。`ChatModelBase` 固化 tracing、超时/重试入口，把厂商实现限制在 `doStream`（[`ChatModelBase.java`](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/ChatModelBase.java)）。

扩展发现通过 Java SPI 完成。`ModelProvider` 用 `providerId` 和完整的 `provider:model` 标识判断是否支持并创建模型，具体 provider 作为单独 Maven 模块发布（[`ModelProvider.java`](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/spi/ModelProvider.java)、[`OpenAIModelProvider.java`](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-model/agentscope-extensions-model-openai/src/main/java/io/agentscope/extensions/model/openai/OpenAIModelProvider.java)）。Spring Boot starter 只负责把各实现的 builder 与配置属性装配起来。

## 协议转换

以 OpenAI 模块为例，`OpenAIChatModel` 把统一消息交给 `Formatter`，再构造请求、附加 tools/options/tool choice，最后把普通响应或 SSE chunk 解析回 `ChatResponse`。标准 OpenAI、DeepSeek、GLM 等可复用同一 HTTP 客户端，通过不同 Formatter 修补消息与参数差异（[`OpenAIChatModel.java`](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-model/agentscope-extensions-model-openai/src/main/java/io/agentscope/extensions/model/openai/OpenAIChatModel.java)、[`OpenAIBaseFormatter.java`](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-model/agentscope-extensions-model-openai/src/main/java/io/agentscope/extensions/model/openai/formatter/OpenAIBaseFormatter.java)）。Anthropic、Gemini、DashScope、Ollama 则有各自模型扩展，而不是强行伪装成一种 wire protocol。

## 完整调用链与失败边界

```text
Model.builder / SPI provider
  → ChatModelBase.stream(Msg, ToolSchema, GenerateOptions)
  → tracing + timeout/retry
  → concrete doStream
  → Formatter lowering
  → HTTP/SDK stream
  → Formatter response/chunk mapping
  → Flux<ChatResponse>
```

同步调用本质上聚合 stream，因此 chunk 中的 tool call 参数、usage 和 finish reason 必须先在 provider 层正确合并。Formatter 负责协议语义，`ChatModelBase` 负责横切生命周期；把重试塞进 Formatter 会导致 tracing 和订阅语义错位。结构化输出失败还要区分 capability 拒绝、schema 不被服务接受、以及模型返回不符合 schema 三类情况。

扩展新 provider 时至少需要验证：SPI 能发现、builder 参数校验、system/tool result 角色转换、并行 tool calls、取消订阅、空流、rate limit/timeout 和 usage 聚合。OpenAI-compatible Formatter 复用只适用于 wire 接近的服务，不能覆盖原生 Gemini/Anthropic content block。

## 取舍

- 优点是 core 与 SDK 解耦，新增 provider 可通过扩展模块和 SPI 接入。
- OpenAI-compatible 只表示协议相近；endpoint path、base URL、Formatter 和能力位仍需分别配置。
- capability 采用保守默认值，未知模型不会被误判为支持结构化输出，但需要新模型及时补充元数据。
