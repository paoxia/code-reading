# 大模型 API 差异适配

## 结论

vLLM 不适配外部模型 provider，而是在同一个本地推理 `EngineClient` 之上提供 OpenAI Chat/Completions/Responses 与 Anthropic Messages 等服务端兼容 API。它解决的是“多种客户端协议如何落到统一推理引擎”和“不同开源模型输出如何解析”，不是跨云厂商转发。研究版本：`26d725c`。

## 统一推理内核

`GenerateBaseServing` 持有统一 `EngineClient`、model registry、renderer 与 input processor，公共处理覆盖模型校验、LoRA、请求 ID、采样参数、追踪、KV transfer 和错误响应（[`serving.py`](../../code/vllm/vllm/entrypoints/generate/base/serving.py)）。各协议 handler 最终都把输入渲染成 engine input，并消费同一异步生成结果。

OpenAI Chat handler 负责 chat template、multimodal content、sampling、SSE、usage/logprobs，并通过可配置 tool parser 与 reasoning parser 把模型生成文本恢复成协议字段（[`chat_completion/serving.py`](../../code/vllm/vllm/entrypoints/openai/chat_completion/serving.py)）。模型差异因此主要落在 tokenizer/chat template、renderer 和 parser，而不是 provider SDK。

## 多协议服务层

Anthropic Messages handler 继承 `OpenAIServingChat`，先将 system、content blocks、image、tool choice/tools 转成内部 ChatCompletionRequest，再把响应、usage、stop reason 和流事件转回 Anthropic 格式（[`anthropic/serving.py`](../../code/vllm/vllm/entrypoints/anthropic/serving.py)）。Responses handler 则拥有独立 conversation context、Harmony/普通 parser、MCP tool 事件与 stateful response 逻辑（[`responses/serving.py`](../../code/vllm/vllm/entrypoints/openai/responses/serving.py)、[`context.py`](../../code/vllm/vllm/entrypoints/openai/responses/context.py)）。

## 限制与风险

- “API compatible”不等于服务能力完全一致；tool/reasoning 是否正确取决于所选模型、chat template 与 parser 配置。
- Responses 的 `store` 默认会被忽略；启用 `VLLM_ENABLE_RESPONSES_API_STORE` 后当前实现使用无淘汰的内存字典，源码明确标记可能内存泄漏的 `FIXME`。
- Anthropic handler是协议桥而非 Claude provider：它可以让 Anthropic SDK 调用本地模型，但不会获得 Anthropic 托管侧的 prompt caching、计费或安全策略。
