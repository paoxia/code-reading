# 大模型 API 差异适配

## 结论

sub2api 的核心就是多协议、多上游账号之间的网关适配。它同时暴露 Anthropic Messages、OpenAI Responses/Chat Completions 和 Gemini 原生入口，再依据 API Key 所属分组与候选账号的 platform/type 选择直通、协议转换或专用上游实现。研究版本：`5a8d6c4e4`。

## 入口协议与路由

`/v1/messages`、`/v1/responses`、`/v1/chat/completions` 会按分组平台自动交给 Anthropic 或 OpenAI/Grok handler；`/v1beta/models/*` 则提供 Gemini SDK/CLI 入口。也就是说，客户端协议与实际账号平台是两个维度，不靠 URL 本身决定最终上游（[`gateway.go`](../../code/sub2api/backend/internal/server/routes/gateway.go)）。handler 在转换之前完成鉴权、模型映射、并发控制、账号选择和失败切换，流已经向客户端提交后则不能再安全切换账号（[`gateway_handler_responses.go`](../../code/sub2api/backend/internal/handler/gateway_handler_responses.go)）。

## 协议转换

Anthropic 账号承接 Responses 请求时，`ForwardAsResponses` 将请求转成 Messages，上游固定使用 streaming，再把 Anthropic SSE 状态机转换成 Responses 事件；非流式客户端也是先聚合上游流再返回完整结果（[`gateway_forward_as_responses.go`](../../code/sub2api/backend/internal/service/gateway_forward_as_responses.go)）。Chat Completions 复用 Responses 作为中间表示，形成 `Chat Completions → Responses → Anthropic` 以及反向响应链；工具调用、stop reason、usage 和流结束事件由 `apicompat` 分层处理（[`gateway_forward_as_chat_completions.go`](../../code/sub2api/backend/internal/service/gateway_forward_as_chat_completions.go)、[`chatcompletions_responses_bridge.go`](../../code/sub2api/backend/internal/pkg/apicompat/chatcompletions_responses_bridge.go)）。

Bedrock 不是简单更换 base URL：它单独构造 InvokeModel/stream 请求、执行 AWS 签名或 Bearer 鉴权，并转换 Bedrock 指标和事件（[`gateway_bedrock.go`](../../code/sub2api/backend/internal/service/gateway_bedrock.go)）。Anthropic OAuth 账号还会注入 Claude Code 兼容 system、metadata 和 cache-control，这属于账号协议约束，而非一般模型能力。

## 取舍与风险

- 以 Responses 作为 Chat 与 Anthropic 间的中间层减少重复转换，但协议不等价；新增字段必须同步维护请求、完整响应和 SSE 状态机。
- 账号调度与协议适配紧密结合，能按 401/403/429/5xx failover，却也使“格式错误、能力不支持、账号失效”的错误分类更复杂。
- OAuth mimicry、模型别名、beta header、thinking 与缓存计费都是上游特例；不能把“OpenAI-compatible”理解为无损透传。
