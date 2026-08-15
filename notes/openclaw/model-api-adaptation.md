# 大模型 API 差异适配

## 结论

OpenClaw 将 provider、model 与 wire API 分开建模，并通过统一 `Model`/`Context`/`AssistantMessageEventStream` 运行多协议模型。内建 AI runtime 处理常见 API，provider 插件再补充发现、鉴权、传输、thinking 与回放策略；协议相近但行为不同的厂商由 stream wrapper 做细粒度修正。研究版本：`1bfd207a`。

## 模型解析与统一运行时

模型解析会合并静态 catalog、Agent 本地发现、内联 provider 配置和插件动态模型，并规范化 `provider`、`api`、base URL、input/cost/compat 等字段。显式配置 base URL 而未指定 API 时才回退为 `openai-completions`，说明 provider 身份与传输协议并不等价（[`model.ts`](../../code/openclaw/src/agents/embedded-agent-runner/model.ts)）。

`stream`/`complete`/`streamSimple` 先确保 transport host 与内建 API provider 已注册，再按模型绑定的 runtime 或默认 runtime 分派，所有实现返回统一 assistant event/message（[`stream.ts`](../../code/openclaw/src/llm/stream.ts)）。上层 Agent loop 因而不需要直接解析 Anthropic、OpenAI 或 Google 的 SSE。

## Provider 插件与兼容修正

特殊云平台通过 provider 插件拥有完整运行时边界。例如 Amazon Bedrock 插件注册 streaming、model discovery、AWS auth、thinking、guardrail 和 embedding hooks（[`register.sync.runtime.ts`](../../code/openclaw/extensions/amazon-bedrock/register.sync.runtime.ts)）；Anthropic Vertex 插件使用 ADC 合成鉴权，并注册 catalog、Claude replay family 和 thinking profile（[`index.ts`](../../code/openclaw/extensions/anthropic-vertex/index.ts)）。

对于共享 wire API 的厂商，wrapper 只修改必要差异：OpenAI wrapper 处理 reasoning effort、Responses/Chat 选择等行为，Google wrapper 处理 Gemini thinking payload；Anthropic-family 还单独修补 tool payload 与 cache semantics（[`openai.ts`](../../code/openclaw/src/llm/providers/stream-wrappers/openai.ts)、[`google.ts`](../../code/openclaw/src/llm/providers/stream-wrappers/google.ts)、[`anthropic-family-tool-payload-compat.ts`](../../code/openclaw/src/llm/providers/stream-wrappers/anthropic-family-tool-payload-compat.ts)）。

## 解析、绑定与流式包装顺序

```text
model reference
  → catalog/local/plugin merge
  → resolved Model(provider, api, compat, capabilities)
  → auth/runtime binding
  → base stream implementation
  → provider-family wrappers
  → AssistantMessageEventStream
```

顺序很重要：catalog 决定模型身份和默认能力，provider plugin 决定 auth/runtime，stream wrapper 才修补请求与历史。过早按 base URL 推断 API 会覆盖插件选择；多个 wrapper 重复修改 tool payload 或 thinking 参数则会产生双重转换。

统一事件流需要在结束前合并 text/thinking/tool calls/usage，并保留可回放的 provider metadata。取消或中途错误不能产出伪造 complete message。Bedrock/Vertex 等插件的 discovery 失败应允许静态配置继续工作，但不能把“目录不可用”误报为“凭据一定无效”。

## 取舍

- 分离 catalog、auth、transport 和 replay policy，既可复用协议实现，又能让云平台保留原生能力。
- 多层规范化与 wrapper 容易产生顺序依赖；新增 provider 不能只填 base URL，还要核对历史回放、thinking、tool、media 和 usage。
- 动态插件和前向兼容模型降低了升级阻塞，但未知模型的能力元数据可能只能采用保守默认值。
