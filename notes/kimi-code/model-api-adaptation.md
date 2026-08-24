# 大模型 API 差异适配

## 结论

kimi-code 将模型适配集中在 `packages/kosong`：`ChatProvider` 规定统一生成与配置接口，provider adapter 分别实现 Kimi、OpenAI Chat、OpenAI Responses、Anthropic、Google GenAI/Vertex，Agent Core 只消费规范化的流式消息部件。原始研究版本：`bf8e967d5`；2026-08-19 增量复核至 `2ea2ef62`，2026-08-24 再复核至 `dceb3fd6`。Google GenAI 的 `null` content 语义仍保留；本轮主要变化在 Agent Runtime/MCP 管理面，`packages/kosong` 的 provider/wire 分层没有被改写。

## 统一抽象

`ChatProvider` 接收统一 `Message`、`Tool` 和 `GenerateOptions`，返回 `StreamedMessage`。流完成后提供规范化 usage、finish reason，同时保留 `rawFinishReason` 和 provider trace id，避免归一化造成信息丢失（[`provider.ts`](../../code/kimi-code/packages/kosong/src/provider.ts)）。thinking、max completion tokens、tool choice、response format 等配置通过返回克隆 provider 的 `with...` 方法实现，防止共享实例被并发请求修改。

`createProvider` 用判别联合 `ProviderConfig` 显式分派六种 wire 类型；Vertex 与 Google GenAI 共用实现，但不会把 Anthropic 或 Responses 强行走 Chat Completions（[`providers/index.ts`](../../code/kimi-code/packages/kosong/src/providers/index.ts)）。每个 adapter 自己负责消息、工具、推理块、usage 和 SSE/SDK event 转换，例如 [`anthropic.ts`](../../code/kimi-code/packages/kosong/src/providers/anthropic.ts)、[`openai-responses.ts`](../../code/kimi-code/packages/kosong/src/providers/openai-responses.ts)、[`google-genai.ts`](../../code/kimi-code/packages/kosong/src/providers/google-genai.ts)。

## 能力差异

静态 capability registry 按 wire 与模型名前缀描述 vision、tool use、thinking/effort 等能力。未知模型返回 `UNKNOWN_CAPABILITY`，检查保持非致命；Kimi wire 的能力由宿主 catalog/config 提供（[`capability-registry.ts`](../../code/kimi-code/packages/kosong/src/providers/capability-registry.ts)）。tool call id、reasoning key、相邻 user 消息合并等跨协议历史问题各有小型兼容模块。

## 一次生成的状态机

```text
ProviderConfig → createProvider
  → immutable withModel/withTools/withThinking...
  → generate(messages, options)
  → native request lowering
  → native stream consumption
  → StreamedMessage parts
  → final usage + finishReason + rawFinishReason
```

不可变 `with...` 返回值使同一基础 provider 能安全派生不同 turn 配置；调用方若忽略返回对象，配置不会生效。流式 tool arguments 需要按 call id 累积，thinking/reasoning part 还可能携带 provider key/signature，必须在历史重放时保留。

跨 provider 切换历史前要检查角色合并、tool result 引用与 reasoning key。Capability registry 只用于预检和 UI，不是 wire 层强制保证；最终仍应处理服务端 unsupported parameter。诊断时同时记录规范化 finish reason 与 `rawFinishReason`，否则会丢失 adapter 映射依据。

## 取舍

- 统一输出同时保存 raw 值，兼顾易用和可诊断性。
- capability catalog 可能滞后，因此未知不等于不支持；宿主仍需保守降级。
- 不同 API 对“工具调用结束”的 finish reason 并不一致，源码已在统一类型注释中明确，Agent 不应只靠 stop reason 判断是否有工具调用。
