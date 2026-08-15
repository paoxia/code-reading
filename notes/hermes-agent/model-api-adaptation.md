# 大模型 API 差异适配

## 结论

Hermes Agent 采用“OpenAI Chat Completions 作为常用内部调用面 + 原生协议适配器”的混合架构。多数 OpenAI-compatible provider 复用同一 client；Anthropic Messages、Codex Responses 和 Bedrock Converse 等差异较大的协议通过 adapter 包装成 Agent loop 可消费的 OpenAI 风格对象。研究版本：`07e97d2`。

## Provider 描述与扩展

`ProviderProfile` 声明 provider 身份、api mode、鉴权、endpoint、model catalog、vision、temperature/max tokens 和 request hooks，但不负责 client construction 或 streaming（[`base.py`](../../code/hermes-agent/providers/base.py)）。registry 会延迟发现内建与 `$HERMES_HOME` 用户 model-provider 插件，用户插件可同名覆盖内建 profile；旧式单文件 provider 仍作为兼容入口（[`__init__.py`](../../code/hermes-agent/providers/__init__.py)）。

初始化阶段结合 provider、base URL、凭据类型与模型选择具体 client。普通聚合器和直连厂商通常走 OpenAI SDK；native Anthropic 和 Bedrock Claude 走 Anthropic SDK 路径，非 Claude Bedrock 模型走 Converse，Codex OAuth 则使用 Responses 适配（[`agent_init.py`](../../code/hermes-agent/agent/agent_init.py)）。

## 原生协议归一化

Anthropic adapter 负责 OpenAI 消息/工具与 Messages content blocks 的双向转换，并处理 OAuth header、prompt caching、extended thinking、流式事件和第三方 Anthropic-compatible endpoint（[`anthropic_adapter.py`](../../code/hermes-agent/agent/anthropic_adapter.py)）。Bedrock adapter 则实现 AWS credential chain、模型发现、Converse 消息与工具转换、reasoning/usage 归一化、错误分类和流权限降级（[`bedrock_adapter.py`](../../code/hermes-agent/agent/bedrock_adapter.py)）。

辅助任务仍统一调用 `client.chat.completions.create()`；`auxiliary_client` 为 Codex Responses、Anthropic Messages 和 Bedrock Converse 提供 shim，并在 auto 模式按主 provider、OpenRouter、Nous、Anthropic 等顺序选择或因额度错误降级（[`auxiliary_client.py`](../../code/hermes-agent/agent/auxiliary_client.py)）。

## 选择路径与降级顺序

```text
provider profile + credential mode + model
  → agent_init client selection
  ├─ OpenAI SDK compatible path
  ├─ Anthropic native adapter
  ├─ Bedrock Claude / Converse adapter
  └─ Codex Responses adapter
  → OpenAI-shaped response for Agent loop
```

Provider profile 的 request hook 只能修补 endpoint/header/body；若 wire event 和历史结构不同，必须进入原生 adapter。主循环 client 与 auxiliary client 是两条调用路径：后者为标题、摘要等任务提供 shim/fallback，其模型选择、额度降级和错误策略不能反向推断主循环行为。

Bedrock 的 streaming 权限不足可以降级到非流式，但 credential failure、模型不存在和内容策略拒绝不能作为同类重试。Anthropic thinking block 还携带 signature，历史回放时顺序和签名必须保留；简单抽取成文本会破坏后续请求。

## 取舍

- 统一 OpenAI 风格调用面让 Agent loop 简单，同时原生 adapter 可保留 caching、thinking、AWS auth 等能力。
- 同一 provider 可能有主循环、辅助任务、OAuth 与 API key 多条路径，转换和错误策略容易漂移，必须依靠跨路径测试约束。
- 用户 provider plugin 适合描述 OpenAI-compatible 差异；真正的新 wire protocol 仍需要新增 client/stream adapter，单靠 `ProviderProfile` 不够。
