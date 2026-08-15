# 大模型 API 差异适配

## 结论

pi 的 `packages/ai` 是独立的统一 LLM 层：用规范化 `Model`、`Context`、`Message`、`AssistantMessageEventStream` 表示上层语义，再按 wire API 注册具体 stream 实现。它不把 provider 与协议混为一谈：同一 provider 可以有多个 API，同一种 API 也能被多个兼容 provider 复用。研究版本：`3a40794`。

## 统一模型与事件流

公共类型定义已知 API，同时允许扩展字符串；统一内容覆盖 text、thinking、tool call、tool result、usage 和 stop reason。`StreamFunction`/`streamSimple` 把所有实现收敛为相同的异步事件流（[`types.ts`](../../code/pi/packages/ai/src/types.ts)）。`Models` 集合负责 provider/model catalog、凭据解析与按 `model.api` 分派请求，内建 provider 由组合函数注册（[`models.ts`](../../code/pi/packages/ai/src/models.ts)、[`all.ts`](../../code/pi/packages/ai/src/providers/all.ts)）。

## 每种协议独立适配

Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Codex Responses、Azure Responses、Google Generative AI/Vertex、Bedrock Converse、Mistral Conversations 等各自拥有请求 lowering 和流事件解析文件。例如 Anthropic 适配器单独处理 thinking signature、cache control、工具引用与 temperature 限制（[`anthropic-messages.ts`](../../code/pi/packages/ai/src/api/anthropic-messages.ts)）；OpenAI Chat 适配器通过 `compat` 标志处理兼容端点的 developer role、streaming usage、strict tools 等细微差异（[`openai-completions.ts`](../../code/pi/packages/ai/src/api/openai-completions.ts)）。

模型 catalog 除价格和 context window 外，还携带 reasoning、input 类型、compat 和 thinking level mapping；`streamSimple` 将统一 reasoning 等级钳制/映射到各 API 原生字段。旧的全局 API registry 被保留在兼容入口，支持扩展注册自定义 wire API（[`compat.ts`](../../code/pi/packages/ai/src/compat.ts)）。

## 统一事件的生命周期

```text
Model(provider, api, id, compat)
  + Context(messages, tools)
  + options
  → Models 按 api 选择 StreamFunction
  → provider request lowering
  → SDK/fetch event stream
  → start / text|thinking|toolcall delta / usage / done|error
  → AssistantMessageEventStream.result()
```

上层既可逐事件渲染，也可等待最终 `AssistantMessage`。适配器必须保证 terminal event 唯一，并在工具参数流结束前完成 JSON 聚合。thinking signature、tool call id 和 provider-specific metadata 属于后续历史重放需要的数据，不能只留在 UI event。

`streamSimple` 负责将统一 thinking level 映射到模型支持范围，并做常见 options 简化；直接调用底层 stream function 则由调用方承担完整协议参数。自定义 API 注册既要提供 stream 实现，也应补 model catalog/compat，否则能力预检、token 价格和输入类型会缺失。

## 取舍

- 分离 provider、model 与 wire API，扩展性强，也能精确保存厂商特性。
- 代价是适配代码量大；新模型若 catalog/compat 不及时，仍可能请求成功但能力映射错误。
- “统一事件”不抹掉差异，provider metadata、thinking signature 等仍需回放，跨模型切换历史时必须做兼容清理。
