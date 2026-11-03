# OpenCode 大模型 API 差异适配

> 本轮复核：2026-11-02；本地源码 `67139d6827af3a337c80472c33f9cb7c6c2ce500`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 结论与分层

模型层已迁到 `packages/ai`。应区分三件事：Provider 描述身份和默认设置，Route 选择可执行协议及传输，Protocol 负责真实请求与流事件转换。模型名字和 endpoint 相同，不代表协议功能相同。

```text
SessionRunner / SessionModelRequest
  → packages/ai：LLM client
  → provider + route + transport
  → protocol request / streaming decoder
  → 统一事件 → SessionStep → 记录与工具结算
```

| 层 | 当前入口 | 核对重点 |
| --- | --- | --- |
| Session 模型请求 | [model-request.ts](../../code/opencode/packages/core/src/session/model-request.ts) | 上下文、工具与压缩请求 |
| Runner 模型层 | [runner/llm.ts](../../code/opencode/packages/core/src/session/runner/llm.ts) | 运行时到 AI 的边界 |
| 公共 LLM | [llm.ts](../../code/opencode/packages/ai/src/llm.ts) | 请求与事件类型 |
| 路由 | [route.ts](../../code/opencode/packages/ai/src/route.ts) | 协议及运行参数 |
| OpenAI Chat | [openai-chat.ts](../../code/opencode/packages/ai/src/protocols/openai-chat.ts) | 消息、工具和 stream |
| Responses | [openai-responses.ts](../../code/opencode/packages/ai/src/protocols/openai-responses.ts) | Responses 协议与状态 |
| Anthropic | [anthropic-messages.ts](../../code/opencode/packages/ai/src/protocols/anthropic-messages.ts) | content block 与工具结果 |

## 请求与响应两侧都要转换

请求侧需要把统一消息、工具参数和 reasoning/缓存等选项转为协议字段。响应侧则需要把文本片段、tool arguments、usage、finish reason 归一化；工具参数的部分 JSON 不是可立即执行的完整参数。

Provider-specific 的差异仍保留在各协议实现及选项中。统一接口解决公共运行时如何消费，不承诺不同模型的思考、多模态或缓存能力等价。

## 错误与重试边界

错误分类和 tool runtime 位于 [provider-error.ts](../../code/opencode/packages/ai/src/provider-error.ts)、[tool-runtime.ts](../../code/opencode/packages/ai/src/tool-runtime.ts)；Session 的恢复选择则在 [step.ts](../../code/opencode/packages/core/src/session/runner/step.ts) 和 [retry.ts](../../code/opencode/packages/core/src/session/runner/retry.ts)。传输层可重试与已落盘输出后的 continuation 是不同决策。

阅读时固定一个 route，先跟踪请求编译，再跟踪流的终态与 usage，最后核对 [Session 重试测试](../../code/opencode/packages/core/test/session-runner-retry.test.ts)。不要沿用旧笔记中已移除的 `packages/llm` 路径。
