# AgentScope Java 大模型 API 差异适配

> 本轮复核：2026-11-02；本地源码 `1d8f9dc04e0e6c7e4d54074331cd5059a87cfa1d`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 公共合同

[Model](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/Model.java) 将模型暴露为 `stream(messages, tools, options) → Flux<ChatResponse>`，模型内部使用配置的 formatter 处理消息转换。[ChatModelBase](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/ChatModelBase.java)、[GenerateOptions](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/GenerateOptions.java)、[ChatResponse](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/ChatResponse.java) 与 [ChatUsage](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/ChatUsage.java) 承担公共生命周期与结果表示。

```text
Agent Msg + ToolSchema + GenerateOptions
  → 所选 Model / formatter
  → Provider 原生请求与流
  → ChatResponse / 内容块 / usage
  → ReActAgent reasoning → tool continuation
```

## 能力与协议不能只看接口相同

Model 当前显式区分 native structured output、native structured output with tools、tool choice 与工具搜索模式。某个兼容 Provider 即使接受 response_format，也可能优先生成 JSON 而跳过工具，因此结构化输出与工具同时存在时需要单独能力判断，必要时回退到 synthetic generate_response tool。

工具搜索模式默认 FUNCTION，原生工具加载需要 Provider 另行支持。统一 Model 接口表达公共调用面，不保证所有端点的 reasoning、多模态、缓存或 schema 限制相同。

## 注册与运行时

模型发现/创建可从 [ModelRegistry](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/ModelRegistry.java) 和 [ModelProvider SPI](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/spi/ModelProvider.java) 追踪。选定 Provider 后应继续读具体 formatter 和 transport，不能只改模型名或 base URL 就认定语义兼容。

## 错误与持久化边界

Provider 流式错误、工具执行失败与 Agent 的调用失败属于不同层。ReActAgent 的共享生命周期负责持久化和终态，但不能将未完成的流误当作完整 ChatResponse；工具结果也必须回到对应调用。

继续读 [ReActAgent](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/ReActAgent.java) 的 reasoning/structured output 分支，以及 [失败持久化测试](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/agent/ReActAgentCallFailurePersistenceTest.java)。本轮未运行网络请求或模型兼容性测试。
