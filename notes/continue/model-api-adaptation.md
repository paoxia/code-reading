# 大模型 API 差异适配

## 结论

Continue 选择 OpenAI Chat Completions 类型作为内部“通用语”，在 `packages/openai-adapters` 中定义 `BaseLlmApi`，每个 provider 将 OpenAI 风格请求转换为原生请求，再把响应与流式 chunk 转回 OpenAI 类型。研究版本：`5522c6f`。

## 统一接口与分派

`BaseLlmApi` 统一 chat/completion、stream/non-stream、embedding、rerank 和 FIM 方法；不支持的方法由实现明确抛错，而不是伪造成功（[`base.ts`](../../code/continue/packages/openai-adapters/src/apis/base.ts)）。入口根据配置的 provider/api 类型实例化 OpenAI、Anthropic、Gemini、Bedrock、Azure、Cohere、WatsonX 等 adapter（[`index.ts`](../../code/continue/packages/openai-adapters/src/index.ts)）。

OpenAI 实现是基准路径，并能按模型和官方 endpoint 在 Chat Completions 与 Responses API 之间切换，再把 Responses 结果还原为 Chat Completion（[`OpenAI.ts`](../../code/continue/packages/openai-adapters/src/apis/OpenAI.ts)、[`openaiResponses.ts`](../../code/continue/packages/openai-adapters/src/apis/openaiResponses.ts)）。大量 OpenAI-compatible 服务通过继承/覆写 base URL、headers、body 修补复用此路径。

原生协议使用显式双向转换。Anthropic adapter 将 system 从 messages 拆出，把 OpenAI tools/tool choice、图片、tool calls/results 转成 Anthropic content blocks，并把 Anthropic SSE 事件、usage 和 stop reason拼回 OpenAI chunk（[`Anthropic.ts`](../../code/continue/packages/openai-adapters/src/apis/Anthropic.ts)）。Gemini adapter还处理 `assistant → model`、tool call id/name 对照、相邻角色合并与 thought signature（[`Gemini.ts`](../../code/continue/packages/openai-adapters/src/apis/Gemini.ts)）。

## 请求与流事件的精确路径

```text
Continue LLM request
  → BaseLlmApi method selection
  → provider adapter request conversion
  → fetch/SDK + abort signal
  → SSE/native event parser
  → OpenAI-compatible chunk
  → upper-layer stream aggregation
```

Chat、completion、FIM、embedding 与 rerank 是不同方法，不存在一个 adapter 实现 chat 就自动支持其余能力。原生 adapter 还必须维护双向 tool call id 映射：assistant tool use 与之后的 tool result 若跨轮失配，服务通常会以角色/引用错误拒绝整段历史。

流式解析要分别完成文本 delta、reasoning/thought、增量 JSON tool arguments、finish reason 和 usage。Anthropic/Gemini 的事件生命周期并不等价于 OpenAI chunk；adapter 只能在收到足够事件后合成某些字段。取消、半截 JSON、空 candidate 和 provider error 应保留为可诊断错误，不能被误聚合成正常 stop。

## 取舍

- OpenAI 类型作为内部格式让上层简单，但对非 OpenAI 原生特性存在表达压力，需要 `extra_content` 等扩展字段。
- adapter 对 unsupported content 会忽略或报错；跨 provider 不能假设音频、图片、缓存、FIM、rerank 都存在。
- `llm-info` 单独维护模型能力与 provider 元数据，新增模型通常需要同时更新 catalog 和 API adapter。
