# 大模型 API 差异适配

## 结论

当前 opencode 在 `@opencode-ai/llm` 内实现了分层协议栈：canonical schema → provider facade → route/auth/transport → protocol lowering/parsing。上层 Session Runner 只处理统一 `LLMRequest` 和 `LLMEvent`，厂商差异被限制在 provider 与 protocol 模块。研究版本：`d36a2d8`。

## 分层结构

`LLM.request` 将 system、messages、tools、tool choice、generation 和 HTTP 选项规范化；`generateObject` 甚至用强制的合成工具实现跨协议结构化输出，避开各家 JSON mode 的语义差异（[`llm.ts`](../../code/opencode/packages/llm/src/llm.ts)）。Session Runner 每轮只调用统一的 `llm.stream(request)` 并持久化 text、reasoning、usage、provider error 和 tool events（[`session/runner/llm.ts`](../../code/opencode/packages/core/src/session/runner/llm.ts)）。

Provider facade 组合认证、base URL、默认参数与一到多个 route。OpenAI 同时公开 Responses、Responses WebSocket 和 Chat route；Anthropic 使用 `x-api-key` 与 Messages route（[`providers/openai.ts`](../../code/opencode/packages/llm/src/providers/openai.ts)、[`providers/anthropic.ts`](../../code/opencode/packages/llm/src/providers/anthropic.ts)）。OpenAI-compatible provider 则复用兼容协议并开放 base URL/options。

Protocol 模块是真正的转换边界。OpenAI Chat 和 Anthropic Messages 各自定义原生请求/事件 schema、把统一消息和工具 lowering 到 wire body、再把 SSE 增量解析成统一 lifecycle/tool/usage events（[`openai-chat.ts`](../../code/opencode/packages/llm/src/protocols/openai-chat.ts)、[`anthropic-messages.ts`](../../code/opencode/packages/llm/src/protocols/anthropic-messages.ts)）。工具 schema projection 和流式参数拼接是共享 utility。

## 取舍

- 原生 schema 会严格暴露协议不兼容，而不是依赖 SDK 的宽松 `any`。
- provider 与 protocol 分离后，同一厂商多协议切换很清晰，但维护成本高。
- OpenAI-compatible 仍需要 profile/options 修补；兼容名称不代表 reasoning、usage、strict schema 或缓存都相同。
