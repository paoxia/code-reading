# 大模型 API 差异适配

## 结论

better-harness 不拥有大模型 wire API 适配层。它适配的是 Claude Code、Codex、Qoder、Cursor、Qwen 等 Agent 宿主的配置资产、session transcript 和输出形态，用统一证据模型评估工作流；宿主自身负责模型选择、鉴权和 API 调用。原始研究版本：`1ad9642`；2026-08-19 增量复核至 `e567e25e`，2026-08-24 再复核至 `77db22a5`。新增 ACP live run、Artifact provider SDK 和 DeepSeek Harness adapter 仍没有引入模型 wire API 层；ACP 在这里是 Agent 宿主执行协议，不是模型协议。

## Host adapter 而非 Model provider

架构要求 host shell 保持轻量，把配置资产盘点和 session evidence 放在 capability-local provider 中；产品判断保留在 skills、models、references 与 templates（[`ARCHITECTURE.md`](../../code/better-harness/docs/ARCHITECTURE.md)）。Host Adapter Matrix 逐项列出 Claude/Codex/Qoder/Cursor/Qwen 的 plugin shell、configured-assets collector、transcript adapter 和输出模式，明确这些 adapter 的对象是宿主边界（[`README.md`](../../code/better-harness/docs/adapters/README.md)）。

例如 `agent-customize/providers/index.mjs` 只按宿主选择文件系统 inventory collector；Codex collector读取本地 plugin、rules、skills、hooks 与 MCP 配置，并不创建 OpenAI client（[`index.mjs`](../../code/better-harness/scripts/agent-customize/providers/index.mjs)、[`codex.mjs`](../../code/better-harness/scripts/agent-customize/providers/codex.mjs)）。Claude session adapter则把本地 JSONL 的 message、tool use/result、usage 等归一为证据事件（[`claude.mjs`](../../code/better-harness/scripts/session-analysis/platforms/claude.mjs)）。

## 有模型参与的边界

部分语义分析可调用模型，但实现仍委托宿主 CLI。`createCodexCliJsonModelClient` 启动 `codex exec`，通过 output schema 约束 JSON，并使用 read-only、ephemeral 等参数；它不构造 Responses 或 Chat Completions 请求（[`codex-json-model.mjs`](../../code/better-harness/scripts/session-analysis/codex-json-model.mjs)）。`package.json` 也没有 OpenAI、Anthropic 或 Google SDK 依赖（[`package.json`](../../code/better-harness/package.json)）。

## 取舍

- 依赖宿主 CLI 可复用登录态、模型配置与安全策略，避免维护多厂商协议。
- 代价是 transcript schema、目录布局和 CLI 参数随宿主版本变化，需要分别维护 evidence adapter。
- `models/` 下的文件是 harness 工作循环与评估概念模型，不是 LLM catalog；把 host provider collector 当作模型 provider 会误判项目职责。
