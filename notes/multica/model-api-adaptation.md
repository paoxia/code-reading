# 大模型 API 差异适配

## 结论

Multica 的主 Agent 运行时不直接统一 OpenAI、Anthropic 等模型 wire API，而是统一 Claude Code、Codex、OpenCode、Kimi 等外部 coding-agent CLI/协议。真正的模型鉴权、消息格式和工具调用由各 CLI 负责；Multica 适配的是进程启动、会话恢复、事件、模型目录和 usage。只有服务端轻量辅助任务有一层独立的 OpenAI-compatible Chat Completions 客户端。研究版本：`ecce589`。

## Agent 宿主适配

`Backend.Execute` 将所有 CLI 收敛为 `Session.Messages` 与 `Session.Result`，统一 text、thinking、tool use/result、status、usage 和 session ID；`New` 再按 agent type 创建专用 backend（[`agent.go`](../../code/multica/server/pkg/agent/agent.go)）。各 backend 仍使用原生宿主协议：Claude Code 进程输出 stream-json，Codex 则启动 `app-server --listen stdio://` 并走 JSON-RPC（[`claude.go`](../../code/multica/server/pkg/agent/claude.go)、[`codex.go`](../../code/multica/server/pkg/agent/codex.go)）。

模型与 reasoning 选项同样来自运行时：`ListModels` 对不同 CLI 使用静态 catalog、子进程探测或 ACP 会话发现，并保留各 CLI 原生的 thinking/service-tier 值（[`models.go`](../../code/multica/server/pkg/agent/models.go)）。因此这里的 provider 是“Agent runtime provider”，不等于模型 API provider。

## 直接 LLM 调用边界

`server/pkg/llm.Client` 只服务标题生成等不需要完整 Agent runtime 的轻量调用。它封装官方 OpenAI Go SDK，允许替换 base URL、API key、默认模型和重试，暴露 Chat、ChatStream 与 GenerateText；兼容范围明确停留在 OpenAI Chat Completions 协议（[`client.go`](../../code/multica/server/pkg/llm/client.go)）。没有 Anthropic Messages、Gemini 原生协议或统一 provider capability 转换。

## 取舍

- 复用成熟 CLI 可继承其 OAuth、模型发现和工具协议，Multica 不必重复实现每家模型 API。
- 代价是能力与行为受 CLI 版本影响；参数、恢复语义和事件格式必须逐 backend 维护。
- 辅助 LLM 层的可配置 base URL 只代表 OpenAI-compatible，非兼容上游需要外部网关，或另写客户端实现。
