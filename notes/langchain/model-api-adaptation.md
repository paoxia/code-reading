# 大模型 API 差异适配

## 结论

LangChain 用“核心行为接口 + 标准消息/内容块 + provider 独立集成包 + 动态模型工厂”吸收 API 差异。核心不要求厂商共用 wire protocol，而是要求集成把原生请求和响应映射到 `BaseChatModel`、`AIMessage`、标准 content blocks、tool calls 和 usage。原始研究版本：`fa7ce76`；2026-08-19 增量复核至 `2019bf5e`。新修复要求 OpenAI reasoning item 保留原始边界，DeepSeek 的 `prompt_cache_hit_tokens` 映射到标准 `cache_read`，xAI 则在加入 reasoning token 后重算 total usage。

## 核心抽象与装配

`BaseChatModel` 统一 `invoke`、`stream`、batch、tool binding 和 structured output 等调用约定；具体集成实现 `_generate`/`_stream` 等底层方法（[`chat_models.py`](../../code/langchain/libs/core/langchain_core/language_models/chat_models.py)）。`init_chat_model` 接受 `provider:model` 或独立的 `model_provider`，推断并延迟导入对应集成包；也能把 model/provider 暴露为运行时 configurable fields（[`base.py`](../../code/langchain/libs/langchain_v1/langchain/chat_models/base.py)）。因此切换 provider 的入口统一，但真正的 SDK 依赖仍在 `langchain-openai`、`langchain-anthropic` 等包内。

## 数据归一化

消息层把文本、图片、推理、工具调用、服务端工具结果等归一为 LangChain v1 标准 content blocks，并保留 provider metadata 作为逃生口（[`_utils.py`](../../code/langchain/libs/core/langchain_core/language_models/_utils.py)、[`_compat_bridge.py`](../../code/langchain/libs/core/langchain_core/language_models/_compat_bridge.py)）。流式层累积增量工具参数，将 `tool_call_chunk` 最终化为正常或无效工具调用，避免每个 Agent 自己拼接厂商 chunk（[`chat_model_stream.py`](../../code/langchain/libs/core/langchain_core/language_models/chat_model_stream.py)）。

provider 包负责剩余差异。例如 Anthropic 集成会在 Anthropic content blocks 与 LangChain 标准块之间转换，并保留 thinking、server tools、annotations 等专有数据（[`_compat.py`](../../code/langchain/libs/partners/anthropic/langchain_anthropic/_compat.py)）。

## 调用、流式聚合与工具绑定

`bind_tools()` 通常返回带 provider tool schema/config 的 Runnable，并不在 Core 中执行工具。调用链是 `invoke/stream → BaseChatModel` 的公共校验与 callbacks → provider `_generate/_stream` → `AIMessage`/`AIMessageChunk`。Agent 或 `ToolNode` 才读取 `tool_calls` 并执行。

```text
standard Messages + RunnableConfig
  → BaseChatModel
  → provider request lowering
  → SDK/native stream
  → AIMessageChunk merge
  → AIMessage(tool_calls, invalid_tool_calls, usage_metadata)
```

chunk 合并不仅拼文本，还要按 index/id 合并 tool argument fragments 和 content blocks。JSON 无法解析的调用进入 `invalid_tool_calls`，不应伪装成空参数工具。callbacks、retry、rate limiter 和 cache 位于模型公共生命周期，但 provider SDK 自带 retry 可能再包一层；配置时要避免乘法式重试。

## 取舍

- 统一的是可组合行为和常见语义，不是所有参数的最小公分母；专有能力仍通过 provider kwargs、content block extras 或专用中间件暴露。
- `init_chat_model` 的名称推断只是便利功能，存在歧义时源码会要求显式 `model_provider`。
- `disable_streaming="tool_calling"` 等开关承认部分 provider 的流式工具调用不可靠，而不是假设能力完全一致。
