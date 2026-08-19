# 大模型 API 差异适配

## 结论

Multica 的主 Agent 运行时不直接统一 OpenAI、Anthropic 等模型 wire API，而是统一 Claude Code、Codex、OpenCode、Kimi 等外部 coding-agent CLI/协议。真正的模型鉴权、消息格式和工具调用由各 CLI 负责；Multica 适配的是进程启动、会话恢复、事件、模型目录和 usage。只有服务端轻量辅助任务有一层独立的 OpenAI-compatible Chat Completions 客户端。原始研究版本：`ecce589`；2026-08-19 增量复核至 `d563bfbc`。

新版中 provider command 日志会在通用 launch 边界脱敏，因此新增 CLI backend 不应各自复制一套凭据隐藏逻辑。这是 Agent 宿主适配层的安全约束，不是模型 wire API 的新统一层。

## Agent 宿主适配

`Backend.Execute` 将所有 CLI 收敛为 `Session.Messages` 与 `Session.Result`，统一 text、thinking、tool use/result、status、usage 和 session ID；`New` 再按 agent type 创建专用 backend（[`agent.go`](../../code/multica/server/pkg/agent/agent.go)）。各 backend 仍使用原生宿主协议：Claude Code 进程输出 stream-json，Codex 则启动 `app-server --listen stdio://` 并走 JSON-RPC（[`claude.go`](../../code/multica/server/pkg/agent/claude.go)、[`codex.go`](../../code/multica/server/pkg/agent/codex.go)）。

模型与 reasoning 选项同样来自运行时：`ListModels` 对不同 CLI 使用静态 catalog、子进程探测或 ACP 会话发现，并保留各 CLI 原生的 thinking/service-tier 值（[`models.go`](../../code/multica/server/pkg/agent/models.go)）。因此这里的 provider 是“Agent runtime provider”，不等于模型 API provider。

## 直接 LLM 调用边界

`server/pkg/llm.Client` 只服务标题生成等不需要完整 Agent runtime 的轻量调用。它封装官方 OpenAI Go SDK，允许替换 base URL、API key、默认模型和重试，暴露 Chat、ChatStream 与 GenerateText；兼容范围明确停留在 OpenAI Chat Completions 协议（[`client.go`](../../code/multica/server/pkg/llm/client.go)）。没有 Anthropic Messages、Gemini 原生协议或统一 provider capability 转换。

## 两层事件归一化不要混淆

```text
用户任务
  → agent Backend (Claude/Codex/OpenCode/Kimi CLI)
  → 宿主原生 stream/JSON-RPC/ACP
  → Multica Session.Messages / Result

标题等辅助任务
  → pkg/llm Client
  → OpenAI Chat Completions-compatible endpoint
```

第一条链归一的是完整 Agent 事件，tool use 已由外部 CLI 产生或执行；第二条链才是直接 LLM 请求，没有 Coding Agent 工具循环。两者的 model 名、usage 和错误不能放进同一统计口径。Codex backend 的 app-server request id/thread id 与 Claude stream-json session id 也有不同恢复合同。

CLI 子进程退出、协议解析失败、Agent turn 失败与底层模型拒绝是不同错误层。Multica 通常只能可靠识别宿主暴露的错误；若宿主丢失 provider 原始 code，不应在上层臆测为 rate limit。

## 取舍

- 复用成熟 CLI 可继承其 OAuth、模型发现和工具协议，Multica 不必重复实现每家模型 API。
- 代价是能力与行为受 CLI 版本影响；参数、恢复语义和事件格式必须逐 backend 维护。
- 辅助 LLM 层的可配置 base URL 只代表 OpenAI-compatible，非兼容上游需要外部网关，或另写客户端实现。
