# 大模型 API 差异适配

## 结论

Codex 当前不是“支持任意厂商协议”的通用适配框架，而是将所有普通 provider 收敛到 OpenAI Responses-compatible wire API；provider 差异主要是 base URL、认证、headers、重试和传输能力。Amazon Bedrock 作为显式特例拥有独立的运行时 provider。研究版本：`28aacbb`。

## Provider 配置层

`ModelProviderInfo` 可由内建默认值或用户 `model_providers` 配置提供，描述 base URL、env key/command auth/AWS auth、query params、静态与环境变量 headers、请求/流重试、idle timeout 和 WebSocket 能力（[`model-provider-info/src/lib.rs`](../../code/codex/codex-rs/model-provider-info/src/lib.rs)）。`WireApi` 目前只有 `Responses`；旧的 `chat` 配置会直接返回带迁移说明的错误。因此所谓兼容 provider 必须提供 Responses API，而不只是 `/chat/completions`。

运行时 `ModelProvider` 抽象把认证、账号状态、模型列表、错误映射和能力上限封装起来。默认实现根据 metadata 创建 OpenAI-compatible API provider；Amazon Bedrock 使用独立实现和 AWS SigV4，并声明自己的能力限制（[`provider.rs`](../../code/codex/codex-rs/model-provider/src/provider.rs)、[`amazon_bedrock/mod.rs`](../../code/codex/codex-rs/model-provider/src/amazon_bedrock/mod.rs)）。

## 请求与流式差异

`ModelClient` 构造统一 Responses 请求并解析统一 `ResponseEvent`。若 provider 声明支持 WebSocket，则优先走 Responses WebSocket；连接或重试预算耗尽后在同一会话永久回退 HTTP SSE（[`client.rs`](../../code/codex/codex-rs/core/src/client.rs)）。模型级 reasoning effort、summary、verbosity、tools 等由 Codex protocol types 统一，但 provider 必须真正接受对应 Responses 字段。

## 取舍

- 收敛到单一 wire API 大幅减少协议转换和历史回放歧义。
- 代价是仅提供 Chat Completions、Anthropic Messages 或 Gemini 原生 API 的服务不能直接接入，必须先经过兼容网关。
- `supports_websockets`、AWS auth 冲突校验和 provider capabilities 是显式能力边界；它们不靠模型名猜测。
