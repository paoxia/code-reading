# 大模型 API 差异适配

## 结论

Codex 当前不是“支持任意厂商协议”的通用适配框架，而是将所有普通 provider 收敛到 OpenAI Responses-compatible wire API；provider 差异主要是 base URL、认证、headers、重试和传输能力。Amazon Bedrock 作为显式特例拥有独立的运行时 provider。研究版本：`28aacbb`。

## Provider 配置层

`ModelProviderInfo` 可由内建默认值或用户 `model_providers` 配置提供，描述 base URL、env key/command auth/AWS auth、query params、静态与环境变量 headers、请求/流重试、idle timeout 和 WebSocket 能力（[`model-provider-info/src/lib.rs`](../../code/codex/codex-rs/model-provider-info/src/lib.rs)）。`WireApi` 目前只有 `Responses`；旧的 `chat` 配置会直接返回带迁移说明的错误。因此所谓兼容 provider 必须提供 Responses API，而不只是 `/chat/completions`。

运行时 `ModelProvider` 抽象把认证、账号状态、模型列表、错误映射和能力上限封装起来。默认实现根据 metadata 创建 OpenAI-compatible API provider；Amazon Bedrock 使用独立实现和 AWS SigV4，并声明自己的能力限制（[`provider.rs`](../../code/codex/codex-rs/model-provider/src/provider.rs)、[`amazon_bedrock/mod.rs`](../../code/codex/codex-rs/model-provider/src/amazon_bedrock/mod.rs)）。

### 配置到运行时对象

```text
config / built-in provider map
  → model_provider id → ModelProviderInfo
  → create_model_provider(info, AuthManager)
  → Arc<dyn ModelProvider> → ModelClient → ModelClientSession
```

`ModelProviderInfo` 是“怎样连接”的可序列化元数据，`ModelProvider` 才是负责认证、账号、模型目录和错误映射的运行时 trait。两者分离后，provider id 和非敏感配置可以进入 thread metadata，而 token 不需要写入 rollout。

`model_provider` 是选中的 id，`model_providers` 是 id 到定义的映射。仅定义 provider 并不会自动选中它。恢复旧 thread 时 provider id 也属于会话语义；换 provider 继续不保证 reasoning item、tool call id 和历史字段仍兼容。

### 认证与 Header

Provider 可使用 API key 环境变量、命令凭据、Codex 登录态或 AWS 凭据，但并非任意叠加，创建阶段会校验冲突。运行时 auth provider 生成动态认证 header，静态 header、环境 header 和 query params 来自 `ModelProviderInfo`。协议兼容与认证兼容因此是两个问题：某网关即使实现 Responses JSON，也可能因 token refresh 或 header 语义不同而无法工作。

## 请求与流式差异

`ModelClient` 构造统一 Responses 请求并解析统一 `ResponseEvent`。若 provider 声明支持 WebSocket，则优先走 Responses WebSocket；连接或重试预算耗尽后在同一会话永久回退 HTTP SSE（[`client.rs`](../../code/codex/codex-rs/core/src/client.rs)）。模型级 reasoning effort、summary、verbosity、tools 等由 Codex protocol types 统一，但 provider 必须真正接受对应 Responses 字段。

### 请求、工具与流式事件

`ModelClient` 持有共享 provider、认证管理器与 telemetry；`ModelClientSession` 保存活跃会话的连接复用、previous response 和 fallback 状态。prompt/history、tools、model、instructions、reasoning、verbosity 等最终组装成 [`ResponsesApiRequest`](../../code/codex/codex-rs/codex-api/src/common.rs)。

内部 `ToolSpec` 还要转换为 Responses schema。function、custom/freeform、namespace 与 hosted tool 的 JSON 形状不同，转换集中在 [`tools/src/responses_api.rs`](../../code/codex/codex-rs/tools/src/responses_api.rs) 及 spec planning 层。因此“文本请求成功”不能证明 provider 完整支持 Codex 的工具协议。

```text
Responses request
  ├── WebSocket（provider 声明支持）
  │     └── 连接/重试耗尽后标记 session fallback
  └── HTTP POST + SSE
          ↓
  ResponseEvent stream
          ↓
  turn loop：固化 item / dispatch tool / 下一请求
```

WebSocket fallback 是 session 状态，不会每轮重新制造一次失败延迟。请求重试与 stream idle retry 也分开配置：前者处理建连/请求失败，后者处理流已开始后的无事件超时。若已有部分 output item 固化，盲目重放可能产生重复文本或工具调用，安全重试必须结合 response id 和已消费事件判断。

## 三类能力边界

- Provider 能力：传输、认证、模型目录、工具数量等连接端限制；
- model metadata：context window、reasoning/verbosity 支持和默认行为；
- session 配置：本轮实际 effort、summary、tools 与 feature flags。

例如 `supports_websockets` 属于 Provider，模型是否理解 reasoning summary 属于模型/服务协议，用户是否请求 summary 属于 session。不能靠模型名猜测 Provider 能力。

## 失败定位

| 现象 | 优先检查 |
|---|---|
| provider 不存在 | `model_provider` id 与映射 |
| `wire_api = "chat"` 被拒绝 | 当前只接受 `responses` |
| 401/403 | AuthManager、env key、最终 headers |
| 文本成功、工具失败 | tool schema 与服务字段支持 |
| WebSocket 失败后恢复 | session 级 SSE fallback |
| 流中断后内容重复 | retry 与已固化 item 边界 |
| reasoning 字段被拒绝 | metadata 与服务真实能力不一致 |

## 测试证据与阅读顺序

1. [`model_provider_info_tests.rs`](../../code/codex/codex-rs/model-provider-info/src/model_provider_info_tests.rs)：配置反序列化与校验。
2. [`provider.rs`](../../code/codex/codex-rs/model-provider/src/provider.rs)：trait 与 factory。
3. [`core/src/client.rs`](../../code/codex/codex-rs/core/src/client.rs)：请求、session 与传输选择。
4. [`codex-api/tests/clients.rs`](../../code/codex/codex-rs/codex-api/tests/clients.rs)：HTTP/WebSocket client 行为。
5. [`core/src/client_common_tests.rs`](../../code/codex/codex-rs/core/src/client_common_tests.rs)：公共请求转换。
6. [`responses-api-proxy/README.md`](../../code/codex/codex-rs/responses-api-proxy/README.md)：自定义 provider 的最小权限代理边界。

## 取舍

- 收敛到单一 wire API 大幅减少协议转换和历史回放歧义。
- 代价是仅提供 Chat Completions、Anthropic Messages 或 Gemini 原生 API 的服务不能直接接入，必须先经过兼容网关。
- `supports_websockets`、AWS auth 冲突校验和 provider capabilities 是显式能力边界；它们不靠模型名猜测。
