# 大模型 API 差异适配

## 结论

Trae Agent 使用统一 DTO 与抽象基类，再按 provider 选择具体 client。OpenAI、Azure、OpenRouter、Doubao、Ollama 共享 OpenAI-compatible 基类；Anthropic 与 Google 因原生协议差异使用独立实现。研究版本：`e839e55`。

## 统一调用面

`BaseLLMClient` 规定 history、`chat` 和 tool-calling capability，输入输出统一为 `LLMMessage`、`LLMResponse`、`LLMUsage`、`ToolCall`（[`base_client.py`](../../code/trae-agent/trae_agent/utils/llm_clients/base_client.py)、[`llm_basics.py`](../../code/trae-agent/trae_agent/utils/llm_clients/llm_basics.py)）。`LLMClient` 根据配置枚举创建七种 provider client，上层 Agent 始终调用同一个 facade（[`llm_client.py`](../../code/trae-agent/trae_agent/utils/llm_clients/llm_client.py)）。

## 复用与专用转换

`OpenAICompatibleClient` 集中处理 message role、tool schema、tool result、usage、重试与历史追加；各 provider 只通过 `ProviderConfig` 覆写 client 构造、额外 headers、名称和模型工具能力（[`openai_compatible_base.py`](../../code/trae-agent/trae_agent/utils/llm_clients/openai_compatible_base.py)）。它还显式处理 `max_tokens` 与 `max_completion_tokens`、o3/o4/GPT-5 不发送 temperature 等模型差异。

Anthropic 与 Google client 分别把统一消息/工具转换为各自 SDK 对象，再把 content、tool calls、finish reason 和 usage 映射回 `LLMResponse`（[`anthropic_client.py`](../../code/trae-agent/trae_agent/utils/llm_clients/anthropic_client.py)、[`google_client.py`](../../code/trae-agent/trae_agent/utils/llm_clients/google_client.py)）。

## 取舍

- 策略直观，新增 OpenAI-compatible provider 成本较低。
- provider 列表是封闭枚举，扩展需要改 facade，而不是动态插件注册。
- 当前主 `chat` 接口是同步完整响应，跨 provider 的流式增量差异没有形成统一事件层。
- 工具能力主要来自配置或 provider/model 判断，错误配置可能到请求时才暴露。
