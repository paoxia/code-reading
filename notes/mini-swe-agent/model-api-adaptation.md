# 大模型 API 差异适配

## 结论

mini-swe-agent 选择把广泛的厂商差异委托给 LiteLLM、OpenRouter、Portkey、Requesty 等聚合层，自身只维持一个很薄的 `Model` Protocol，并重点修补 Coding Agent 真正依赖的工具调用、消息历史、缓存和计费差异。研究版本：`38c01a1`。

## 实现方式

核心 Agent 只要求模型支持 `query`、消息格式化、工具结果格式化和序列化，不依赖具体 SDK（[`__init__.py`](../../code/mini-swe-agent/src/minisweagent/__init__.py)）。`get_model` 通过 `model_class` 短名或完整 import path 延迟加载实现；默认始终选择 `LitellmModel`，而不是按每个厂商维护一套 client（[`models/__init__.py`](../../code/mini-swe-agent/src/minisweagent/models/__init__.py)）。

`LitellmModel` 将带 provider 前缀的 `model_name`、统一 messages 和 Bash tool 交给 `litellm.completion`。返回后再把 tool calls 解析为 Agent action、规范化 usage/cost，并将原始响应保存在轨迹中（[`litellm_model.py`](../../code/mini-swe-agent/src/minisweagent/models/litellm_model.py)）。Responses API、纯文本 action、OpenRouter/Portkey 等差异通过不同 model class 分开，而不是塞进一个巨型条件分支。

项目仍保留少量 provider 补丁：Anthropic thinking blocks 在重放前重新排序，并默认在 Anthropic/Claude 模型上设置 cache control；OpenAI 多模态内容和工具结果也有专用格式化辅助（[`anthropic_utils.py`](../../code/mini-swe-agent/src/minisweagent/models/utils/anthropic_utils.py)、[`openai_multimodal.py`](../../code/mini-swe-agent/src/minisweagent/models/utils/openai_multimodal.py)）。

## 取舍

- 实现小、覆盖面大，但支持范围和参数翻译质量受 LiteLLM/网关版本影响。
- `Model` Protocol 很薄，没有完整 capability negotiation；不支持的参数通常在运行时由 LiteLLM 抛错。
- 成本统计依赖模型注册信息，未知本地模型必须补 registry 或显式忽略计费错误。
