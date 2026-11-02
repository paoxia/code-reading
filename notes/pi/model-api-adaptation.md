# pi 大模型 API 差异适配

> 本轮复核：2026-11-02；本地源码 `62752fd4c37a72e0f3c1cc83e9ac3b4299f31fe6`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 当前补充：动态模型目录与缓存维度

[model-catalog-protocol.ts](../../code/pi/scripts/model-catalog-protocol.ts) 对没有显式 pi-version 的已发布客户端，从 User-Agent 解析 pi 版本并直接选择目录，不再通过 redirect 补 query。源码说明服务端响应需要正确声明 Vary；显式 pi-version 优先。这影响目录分发与缓存，未改变工具 continuation loop 的职责。

## 当前模型装配方式

[pi-ai 文档](../../code/pi/packages/ai/README.md) 当前以 provider collection、显式注册和自动认证解析为主，并包含旧 global API 的迁移说明。不能只复述早期全局模型注册表的用法。

```text
createModels → setProvider(provider factory)
  → 按 provider/model 取得模型与能力
  → 构造 Context + tools + options
  → stream / complete
  → 统一 assistant 内容、tool calls、usage 和 stop reason
```

实现入口是 [ai/src](../../code/pi/packages/ai/src)，协议具体实现见 [providers](../../code/pi/packages/ai/src/providers)。统一层还提供成本与 token 记录、上下文持久化和跨模型衔接；各 Provider 的转换仍承担协议差别。

## 差异如何隔离

| 差异 | 实现职责 |
| --- | --- |
| 身份与鉴权 | provider factory、credential store、OAuth 与 headers |
| 内容格式 | 文本、图像、thinking 与工具消息转换 |
| 流响应 | 将协议片段折成统一事件及完整 AssistantMessage |
| 能力 | catalog/operation capabilities 与 Provider options |
| 模型交接 | 转换已有历史中的 reasoning、tool call ID 和结果形式 |

工具参数在流中可以是部分 JSON；最终执行前必须经过完整参数与 schema 检查。Provider 支持某个选项与该模型/端点接受选项也不是同一事实。

## 运行时和持久化边界

轻量 [Agent Loop](../../code/pi/packages/agent/src/agent-loop.ts) 消费模型事件并接续工具；实验性 [Durable provider](../../code/pi/packages/durable/src/harness/provider.ts) 则在任务与存储语义中装配模型访问。模型层的取消与重试不能代替上层的准入、结果结算和副作用控制。

跨协议比较应记录实际 provider、model、options、上下文转换和完成原因。仅把 base URL 指向兼容端点，不能证明 reasoning、缓存或工具流与原生端点一致。
