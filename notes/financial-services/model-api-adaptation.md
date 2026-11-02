# 大模型 API 差异适配

## 2026-11-02 复核与当前定位

- 本地源码：`60565064557ca77b12f62aa7877f365d111c129d`（提交日期 2026-10-28）。
- 核对方式：本地源码、调用入口与测试材料静态阅读；未运行上游构建或测试。下文早期日期与版本号保留作研究历史，本节记录本轮基线与修订边界。

本项目由金融领域插件、managed-agent cookbooks 与辅助脚本组成。orchestrate.py 明确为 reference only，handoff 来自文本解析并做目标白名单和 schema 校验，不能描述成已经完整实现的生产工作流引擎。

当前入口：[scripts/orchestrate.py](../../code/financial-services/scripts/orchestrate.py)、[scripts/sync-agent-skills.py](../../code/financial-services/scripts/sync-agent-skills.py)。

本专题继续从 [README.md](../../code/financial-services/README.md)、[agent.yaml](../../code/financial-services/managed-agent-cookbooks/market-researcher/agent.yaml) 进入；涉及已迁移的运行时，以本节和项目总览中的当前路径为准。

## 结论

financial-services 不是通用模型 API 适配库。仓库交付 Claude/Cowork 插件、skills、MCP 配置和 Claude Managed Agents 模板；运行时与模型协议由 Anthropic 产品承载，仓库代码只负责准备和部署这些资产。研究版本：`eb0c1ea`。

## 源码边界

项目说明明确提供两种表面：把同一套 prompts/skills 安装为 Claude Cowork 插件，或部署到 Claude Managed Agents API。仓库主体是 Markdown、YAML 与 JSON，不包含统一 Message、Provider registry、OpenAI/Anthropic/Gemini 请求转换或 SSE parser（[`README.md`](../../code/financial-services/README.md)）。

Managed Agent manifest 直接指定 Claude 模型、tools、MCP servers、skills 和 callable agents；例如 market researcher 固定 `claude-opus-4-7`（[`agent.yaml`](../../code/financial-services/managed-agent-cookbooks/market-researcher/agent.yaml)）。部署脚本将文件引用内联、上传 skill、递归创建 leaf agents，最后用固定 Anthropic version/beta headers 调用 `/v1/agents`；它没有 provider 抽象或其他 wire protocol backend（[`deploy-managed-agent.sh`](../../code/financial-services/scripts/deploy-managed-agent.sh)）。

跨 Agent handoff 示例也直接使用 Anthropic SDK beta sessions stream/steer。文件头明确标注它只是 reference event loop，并提示文本中解析 handoff 的注入风险（[`orchestrate.py`](../../code/financial-services/scripts/orchestrate.py)）。

## 与多 Provider 的关系

README 提到 Microsoft 365 add-in 可以由管理员接到 Vertex AI、Bedrock 或内部网关，但本仓库对应目录提供的是安装与路由配置指引，不是这些模型 API 的协议转换实现。若要支持非 Anthropic runtime，需要在外部托管层完成模型、工具、streaming、usage 和 Managed Agents 语义的兼容，不能只改 manifest 中的 `model`。

## 注意事项

- `callable_agents` 和 Managed Agents 均带 preview/beta 标记，接口与能力不能当作稳定通用标准。
- 这些模板的可移植单位是 prompt、skill 与 MCP 配置，不是模型 wire request。
- 金融输出在 README 中明确要求专业人员复核；更换模型/provider 时还需重新验证工具权限、结构化输出和合规边界。
