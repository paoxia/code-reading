# 2026-08-24 上游源码更新复核

## 1. 复核范围

本次以 `code/` 中 2026-08-24 执行 `git pull --ff-only` 前后的提交为边界，共核对 20 个上游仓库、4,271 个提交和 17,512 个变更文件。数字用于描述更新规模，不代表每个提交都改变了本文关注的架构；结论以实际实现、测试和现有笔记引用为准。

| 项目 | 复核区间 | 提交数 | 文件数 | 对现有笔记的主要影响 |
| --- | --- | ---: | ---: | --- |
| AgentScope Java | `bf7b7dae..c2d43f86` | 13 | 111 | ReAct 空终态重试、失败上下文持久化、工具归一化 |
| Better Harness | `e567e25e..77db22a5` | 73 | 253 | Studio 从证据浏览器扩展为 ACP 运行与 Artifact 工作区 |
| Codex | `f5a3dc55..33975171` | 209 | 1,033 | 上下文来源标注、任务工具、turn suspension、审批与插件 MCP |
| DeepSeek Harness | `99f6f02f..b150a551` | 743 | 3,319 | 统一图片请求链、Files fallback、`dsh 0.1.1-rc.2` |
| DeerFlow | `62ffcff4..cc6a2657` | 34 | 314 | managed subagent、delegation scope、tool receipt、sandbox 授权 |
| Financial Services | `38652224..33a3d8a9` | 1 | 5 | 仅 Microsoft Foundry 安装文档修订，运行架构未变 |
| Gemini CLI | `571851b1..5411f113` | 5 | 21 | macOS Seatbelt、symlink ignore、空文本工具轮次修复 |
| Goose | `9f941fbf..2eb3ab10` | 112 | 279 | Hook 生命周期、MCP/Skill 可见性、Provider 与 ACP 安全边界 |
| Hermes Agent | `13ce0c5c..dc50f020` | 1,116 | 1,498 | 子 Agent 重试与项目上下文、Provider 身份、Responses 结算 |
| Kimi Code | `2ea2ef62..dceb3fd6` | 49 | 838 | V2 Agent Runtime、统一 MCP 管理面、fork 与 Windows 路径桥接 |
| LangChain | `2019bf5e..c4c57d35` | 31 | 67 | 标准模型异常、gateway error metadata、可配置 token counter |
| LangGraph | `1e44bda4..f09cfe8f` | 3 | 8 | Python SDK 增加 decrypt replacement result，图运行时未变 |
| Multica | `d563bfbc..b2b4699f` | 111 | 1,123 | Plugin Public API、定时 Hook、ZeroClaw ACP、Windows stdin |
| OpenClaw | `3587158a..4c48c13a` | 1,182 | 6,358 | Anthropic Agent SDK、operator roles、worker 隔离、子 Agent 隐私 |
| OpenCode | `da4730e4..03521003` | 80 | 223 | 网络/未知 finish 重试、子 Agent 错误传播、Provider 参数保护 |
| OpenHands | `551e9a9e..861e9ef5` | 39 | 294 | Provider Connections、disabled skills、WebSocket 与概览控制面 |
| pi | `ed867e90..4af9d21d` | 49 | 123 | 自带 Node、托管安装升级、session-scoped 模型配置、reasoning 保真 |
| Spring AI | `c988e72a..fd3fd6ec` | 12 | 191 | 2.0.1 发布、工具回退策略、MCP 会话上限与资源路径校验 |
| Sub2API | `ae62854a..03e8ab41` | 217 | 544 | `service_tier`、OAuth 出站插件、阶梯计费与模型列表上限 |
| vLLM | `eac636a7..0ecc2847` | 192 | 910 | KV Cache 布局统一、媒体预检、SSE keep-alive、Anthropic 参数 |

## 2. 跨项目变化

### 2.1 Agent Runtime 正在显式化“来源”和“所有权”

Codex 为上下文片段增加 content kind/source，并在 subagent fork、compaction、模型切换和截断时保留这些标注；DeerFlow 把 delegation scope、managed subagent 和 sandbox authorization 放进运行时；Multica 则用 task provenance 约束 Squad activity。三者都在解决同一问题：长链路中不能只传递内容，还必须保留“谁产生、谁可见、谁授权”的事实。

### 2.2 工具调用从执行结果走向可审计生命周期

Goose 的 `PreToolUseResult` 与稳定 `tool_call_id`、DeerFlow 的 model-visible tool receipt ledger、Codex granular sandbox approval、Hermes 的 pending Responses tool-call settlement 都表明工具层不再只是 `call → result`。审批、Hook、重试、恢复和日志需要围绕同一个调用身份闭环，否则恢复后容易重复执行或丢失拒绝原因。

### 2.3 多 Agent 的重点转向上下文继承与恢复

Kimi Code V2 为 Agent tool 增加 `fork` 并把 agent domain 迁移到统一 runtime；Hermes 会把项目上下文文件和已加载 Skills 带入子 Agent；Codex 保留 developer instruction annotations，并能 suspend 未完成的 root turn。委托能力本身已经普遍存在，当前差异更多体现在继承范围、深度上限、失败恢复和父子生命周期。

### 2.4 协议兼容进入“语义细节”阶段

Sub2API 在 Responses、Chat Completions 和 WebSocket 路径统一 `service_tier`，并按上游实际档位计费；LangChain 增加标准模型异常并在 error path 传播 gateway 信息；pi 保留 OpenAI thinking signature 中的 reasoning details；vLLM 允许 Anthropic `vllm_xargs` 进入采样参数。HTTP 入口兼容已经不够，错误类型、推理元数据、计费档位和扩展参数也必须可往返。

### 2.5 跨平台适配继续向发行与边界安全外移

pi 开始随 Coding Agent 分发 Node runtime，并对托管安装原地升级；Kimi Code 为 Git Bash POSIX 路径增加 Shell/path bridge；Gemini CLI 在 macOS Seatbelt 中隔离容器 socket 和二进制；OpenClaw 为 node-hosted worker 增加可选容器隔离。跨平台成本不只在 Shell 方言，也在 runtime 分发、路径语义和隔离后端。

## 3. 阅读建议

1. 先读各项目 `README.md` 新增的 2026-08-24 增量复核，确认主架构是否变化。
2. 再按主题进入 Tool Runtime、Model API、跨平台或持久化专题；专题只记录与该边界直接相关的变化。
3. 对 1,000+ 提交的仓库不要把提交数当成能力数量，应继续从当前实现和回归测试验证具体语义。
