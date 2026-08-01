# 大模型 API 差异适配

## 结论

OpenManus 选择较窄的 OpenAI Chat Completions 统一面：默认 provider 与多数兼容服务都通过 `AsyncOpenAI` 加 base URL 接入，Azure 使用 `AsyncAzureOpenAI`，AWS Bedrock 用自研 shim 模拟 `client.chat.completions.create()`。它不是完整的多原生协议框架。研究版本：`52a13f2`。

## 统一调用面

`LLM` 根据 `api_type` 只分三路：`azure`、`aws` 和默认 OpenAI-compatible。消息被整理为 OpenAI role/content/tool_calls 结构，普通问答、结构化 JSON 和工具调用最终都进入 `self.client.chat.completions.create`；reasoning model 的主要特例是改用 `max_completion_tokens` 并省略 temperature（[`llm.py`](../../code/openmanus/app/llm.py)）。配置层允许 default、vision 等命名实例继承同一组 model/base URL/API key 参数（[`config.py`](../../code/openmanus/app/config.py)）。

Google 示例通过 Gemini 的 OpenAI-compatible endpoint 接入，Azure 示例设置专用 SDK 与 API version；Anthropic 示例也只是给默认 OpenAI client 更换 base URL，并没有仓库内的 Anthropic Messages 转换器（[`config.example-model-google.toml`](../../code/openmanus/config/config.example-model-google.toml)、[`config.example-model-azure.toml`](../../code/openmanus/config/config.example-model-azure.toml)、[`config.example-model-anthropic.toml`](../../code/openmanus/config/config.example-model-anthropic.toml)）。因此能否工作取决于目标端点是否接受 OpenAI Chat 形状，不能据配置文件推断具备原生 Anthropic 支持。

## Bedrock 特例与限制

`BedrockClient` 仿造 OpenAI client 对象，将 OpenAI messages/tools 转成 Converse 请求，再把完整或流式结果聚合回 ChatCompletion 风格对象（[`bedrock.py`](../../code/openmanus/app/bedrock.py)）。实现用模块级 `CURRENT_TOOLUSE_ID` 关联 tool result，且只显式读取首个 assistant tool call、对 content block index 有固定假设；这是源码中的临时方案和并发/并行工具限制，不应视为无损适配。

## 取舍

- 单一 Chat Completions 调用面实现简单，任何真正兼容的网关都可通过 base URL 接入。
- model capability 依赖硬编码模型名，token 估算默认使用 tiktoken；非 OpenAI 模型的多模态、上下文和计费可能不准确。
- Bedrock shim 将原生特性压回 OpenAI 对象，能够复用 Agent loop，但当前工具关联与流聚合实现不适合复杂并发场景。
