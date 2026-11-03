# Kimi Code 大模型 API 差异适配

> 本轮复核：2026-11-02；本地源码 `fc3b521b8b68468268bb4cfe7f45008ce08b2b99`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 结论

当前模型层由 `agent-core-v2/src/llm-adapter` 与 `human/llm`、`human/llm-requester` 协作。旧的独立 kosong 包已不在当前 checkout，先前的 provider.ts/generate.ts 路径不能作为现行证据。

## 抽象与装配

| 层 | 源码 | 作用 |
| --- | --- | --- |
| Model catalog | [catalog.ts](../../code/kimi-code/packages/agent-core-v2/src/llm-adapter/model/catalog.ts) | 模型配置与元数据 |
| Provider definition | [provider-definition.ts](../../code/kimi-code/packages/agent-core-v2/src/llm-adapter/provider/provider-definition.ts) | Provider 默认策略 |
| Protocol registry | [protocolAdapterRegistry.ts](../../code/kimi-code/packages/agent-core-v2/src/llm-adapter/protocol/protocolAdapterRegistry.ts) | requester、endpoint、headers 与错误分类 |
| 生成适配 | [generate.ts](../../code/kimi-code/packages/agent-core-v2/src/llm-adapter/model/generate.ts) | 请求输入、流事件、usage、finish 和 timing |
| 基础 LLM | [human/llm](../../code/kimi-code/packages/agent-core-v2/src/human/llm) | 请求协议和基础实现 |

`routeFor()` 分别处理 openai、openai_responses、anthropic、Google 等协议，并允许 Provider definition 覆盖 requester、endpoint 和默认 headers。Provider 与 protocol 是两个维度，不能用模型名称决定所有字段。

## 一次模型调用

```text
Model + catalog + credential
  → protocol registry / routeFor
  → initialized requester
  → generateModel(input, params, policy)
  → part / usage / finish / timing
  → Loop machine 事件与下一步工具调用
```

ModelRequestInput 包含 systemPrompt、tools、messages 和 responseFormat；ModelRequestParams 单独携带 sampling、thinking、completion/context budget 等。请求策略还承载 recovery/resolver 与 recovery ledger，因此兼容修复不是简单修改 base URL。

## 状态与失败边界

文本和工具参数以 part 逐步到达，usage 和 finish 是独立事件；timing 也单独记录。取消、Provider 错误翻译和 recovery 要保留调用上下文，避免把一次失败请求当成完整 assistant answer。

统一类型不代表所有协议都支持同样的 reasoning、媒体、缓存或响应格式。阅读新增 Provider 时，应同时核对 catalog 能力、routeFor 选项和底层协议实现，再用 loop 层 [工具测试](../../code/kimi-code/packages/agent-core-v2/test/agent/loop/machineTools.test.ts) 检查调用配对。
