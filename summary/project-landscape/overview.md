# 全部项目总览与阅读路线

## 研究范围与更新方式

本轮复核日期为 **2026-11-02**，覆盖 projects.json 中全部 **48 个项目、6 个分类**。本地源码均已存在，本轮为 18 个新增基础设施项目补充首次笔记，为已有项目和专题补充当前基线，并修订模块迁移与过时结论。

版本表在本轮上游更新进程结束后，按最终本地 HEAD 校准，不表示此后仍与远端实时同步。DeepSeek Harness 仍为浅克隆，其余项目的历史状态以表格为准。下表明确保留浅克隆状态；源码研究没有要求先下载全部历史。所有项目均以静态源码、调用链、测试和示例为依据，没有运行上游构建、GPU/NPU 测试或性能基准。

已有专题保留早期版本字段以便追溯；本轮更新段与重写章节给出当前入口和已确认的变化，不把历史快照当作新实现。各笔记的细分范围和实验性限制仍然适用。

## 按层理解整个仓库

```text
原理与模型：Annotated Transformer
       ↓
计算与数据底座：推理引擎 / 算子 / 通信 / JIT / 训练 / 存储 / API 网关
       ↓
开发积木：Spring AI / LangChain / LangGraph / Java Agent 框架
       ↓
执行与交付：Coding Agent / Agent 平台与助手
       ↓
领域使用：Financial Services 插件、cookbooks 与工作流示例
```

这是阅读视角，图中相邻层不一定存在直接代码依赖。Agent 运行时、模型服务与算子库优化的是不同状态和成本，不应只用功能数量或单一 benchmark 排名。

## Coding Agent（15）

直接面向代码阅读、修改、测试与终端协作的智能体。

| 项目与笔记 | 当前研究重点 | 本地提交 | 提交日期 | 浅克隆 |
| --- | --- | --- | --- | --- |
| [mini-swe-agent](../../notes/mini-swe-agent/README.md) | 以极简实现研究Agent Loop、线性消息历史和Bash工具执行 | `04d809ceab9d` | 2026-09-03 | 否 |
| [pi](../../notes/pi/README.md) | 研究统一模型接口、轻量Agent Loop、终端产品会话与实验性pi-durable持久化运行时 | `62752fd4c37a` | 2026-11-02 | 否 |
| [opencode](../../notes/opencode/README.md) | 研究完整终端Coding Agent的会话、工具、权限和扩展架构 | `67139d6827af` | 2026-11-02 | 否 |
| [continue](../../notes/continue/README.md) | 研究开源Coding Agent的模型接入、上下文构建、工具执行和IDE集成 | `5522c6f44ca0` | 2026-07-20 | 否 |
| [codex](../../notes/codex/README.md) | 研究Rust实现的Agent运行时、沙箱、审批、协议和终端界面 | `020e0f77080f` | 2026-11-02 | 否 |
| [kimi-code](../../notes/kimi-code/README.md) | 研究终端Coding Agent的会话循环、工具系统、上下文管理、子Agent并行协作、插件机制、TUI和ACP集成 | `fc3b521b8b68` | 2026-11-02 | 否 |
| [trae-agent](../../notes/trae-agent/README.md) | 研究模块化软件工程Agent架构、多模型适配、工具调用、交互式CLI、执行轨迹记录和Docker隔离运行 | `e839e559ac61` | 2026-02-05 | 否 |
| [better-harness](../../notes/better-harness/README.md) | 研究Coding Agent工作流的证据采集、五维评估、修复闭环、报告生成和多宿主适配 | `b605532fcf10` | 2026-10-20 | 否 |
| [deepseek-harness](../../notes/deepseek-harness/README.md) | 研究基于Cordis的插件化Agent Harness、运行模式、工具、会话与扩展机制 | `ce7073d51254` | 2026-10-30 | 是 |
| [swe-agent](../../notes/swe-agent/README.md) | 研究benchmark驱动的软件修复Agent、Agent-Computer Interface、轨迹与评测闭环 | `3ea751c087f3` | 2026-07-16 | 否 |
| [gemini-cli](../../notes/gemini-cli/README.md) | 研究Google终端Coding Agent的循环、工具、策略、沙箱、扩展与模型接入 | `6814e00d6b14` | 2026-10-30 | 否 |
| [goose](../../notes/goose/README.md) | 研究MCP-first本地Agent的扩展、Recipe、会话、工具调用与多模型适配 | `0909288ed4a2` | 2026-11-02 | 否 |
| [aider](../../notes/aider/README.md) | 研究代码编辑格式、Repository Map、上下文选择、Git工作流与模型适配 | `5dc9490bb35f` | 2026-05-22 | 否 |
| [rtk](../../notes/rtk/README.md) | 研究命令改写、输出压缩、失败回退、Hook、独立LLM Proxy与两类用量统计 | `fcc2eb0939bf` | 2026-11-02 | 否 |
| [caveman](../../notes/caveman/README.md) | 研究Coding Agent响应压缩、上下文Engine、本地Proxy、CCR恢复、MCP工具与诚实计量 | `2e068f735253` | 2026-11-01 | 否 |

## Agent 框架（5）

用于构建、编排和运行 Agent 应用的开发框架。

| 项目与笔记 | 当前研究重点 | 本地提交 | 提交日期 | 浅克隆 |
| --- | --- | --- | --- | --- |
| [spring-ai-alibaba](../../notes/spring-ai-alibaba/README.md) | 阿里巴巴开源的Java AI框架 | `17e26ff6fe95` | 2026-10-07 | 否 |
| [agentscope-java](../../notes/agentscope-java/README.md) | 构建分布式、生产级、长期运行的Agent框架 | `1d8f9dc04e0e` | 2026-11-02 | 否 |
| [langchain](../../notes/langchain/README.md) | 研究Runnable组合、模型与工具抽象、基于LangGraph的Agent工厂、中间件和集成生态 | `aa13e9c0e94c` | 2026-11-02 | 否 |
| [langgraph](../../notes/langgraph/README.md) | 研究StateGraph、Pregel执行引擎、Channel状态合并、Checkpoint、Interrupt和持久化工作流 | `ee3c043bddcc` | 2026-11-01 | 否 |
| [spring-ai](../../notes/spring-ai/README.md) | 研究Spring风格模型抽象、ChatClient、Advisor链、工具调用、记忆、RAG、MCP和自动配置 | `4459ae88f4f6` | 2026-11-02 | 否 |

## Agent 平台与助手（6）

面向长期运行、托管、多入口或个人场景的 Agent 系统。

| 项目与笔记 | 当前研究重点 | 本地提交 | 提交日期 | 浅克隆 |
| --- | --- | --- | --- | --- |
| [multica](../../notes/multica/README.md) | 研究托管式Agent平台的任务队列、本地Daemon、统一CLI适配、实时状态同步和多Agent协作 | `ed7c001778c0` | 2026-11-02 | 否 |
| [openclaw](../../notes/openclaw/README.md) | 研究常驻Gateway、渠道路由、Agent Runtime、插件系统、会话持久化和多Agent协作 | `74563362e8ee` | 2026-11-02 | 否 |
| [hermes-agent](../../notes/hermes-agent/README.md) | 研究多入口Agent内核、工具注册、Provider适配、长期记忆、消息网关和子Agent委托 | `fbf6c6c91d8a` | 2026-11-02 | 否 |
| [openmanus](../../notes/openmanus/README.md) | 研究通用Agent的循环、工具系统、规划执行、浏览器能力和多Agent协作 | `3309bf4e416f` | 2026-08-16 | 否 |
| [deer-flow](../../notes/deer-flow/README.md) | 研究长时任务中的主Agent、子Agent、Skills、Memory、Sandbox与消息网关 | `14abd9a28eb0` | 2026-11-02 | 否 |
| [openhands](../../notes/openhands/README.md) | 研究完整软件开发Agent平台的运行时、事件流、沙箱、会话与多入口架构 | `974ea6ae9694` | 2026-11-02 | 否 |

## AI 基础设施（20）

模型训练与推理、算子与通信、分布式存储、服务化与 API 网关。

| 项目与笔记 | 当前研究重点 | 本地提交 | 提交日期 | 浅克隆 |
| --- | --- | --- | --- | --- |
| [sub2api](../../notes/sub2api/README.md) | 研究多租户AI API网关的鉴权、账号调度、协议转发、故障切换和计费闭环 | `4a4a83ee5ec8` | 2026-11-02 | 否 |
| [vllm](../../notes/vllm/README.md) | 研究V1多进程架构、统一调度器、连续批处理、KV Cache块管理、Prefix Caching、Model Runner、Attention Backend和分布式执行 | `f9db1756e9e6` | 2026-11-02 | 否 |
| [nano-vllm](../../notes/nano-vllm/README.md) | 研究精简实现中的LLM推理循环、请求调度、KV Cache管理和模型执行 | `bb823b3e0698` | 2026-04-26 | 否 |
| [mini-sglang](../../notes/mini-sglang/README.md) | 研究紧凑实现中的LLM服务系统的调度、缓存、批处理和执行流程 | `9a91cfafe754` | 2026-05-17 | 否 |
| [flashinfer](../../notes/flashinfer/README.md) | 研究LLM推理算子库、Attention内核、KV Cache布局、算子调度及与推理框架的集成 | `ecb713c63c17` | 2026-11-02 | 否 |
| [sglang](../../notes/sglang/README.md) | 研究LLM与多模态模型服务的请求链、调度、前缀缓存、模型执行和分布式推理，并与vLLM比较 | `ad6ca42dea36` | 2026-11-02 | 否 |
| [tensorrt-llm](../../notes/tensorrt-llm/README.md) | 研究NVIDIA GPU上的LLM推理优化、Python与C++运行时、请求调度、量化和多GPU执行 | `4c2238ee524c` | 2026-11-02 | 否 |
| [deepinfer](../../notes/deepinfer/README.md) | 研究DeepSeek模型的离线推理引擎、分布式执行、调度和推理组件协作 | `553741557a57` | 2026-10-25 | 否 |
| [deepspec](../../notes/deepspec/README.md) | 研究投机解码的草稿模型训练、验证流程、接受率和端到端评估 | `005e03b81cec` | 2026-07-09 | 否 |
| [deepgemm](../../notes/deepgemm/README.md) | 研究GPU矩阵计算、低精度GEMM、分组计算和内核特化 | `5081f8513af5` | 2026-10-20 | 否 |
| [deepep](../../notes/deepep/README.md) | 研究MoE专家并行的dispatch/combine、节点内外通信和计算通信重叠 | `f6aa38fe06cd` | 2026-10-21 | 否 |
| [flashmla](../../notes/flashmla/README.md) | 研究MLA与稀疏Attention内核、KV Cache布局、调度元数据和GPU执行 | `395cb3afbb33` | 2026-10-27 | 否 |
| [deepjit](../../notes/deepjit/README.md) | 研究xPU内核即时编译、缓存、加载与算子库集成 | `18fe520b0473` | 2026-10-19 | 否 |
| [tilekernels](../../notes/tilekernels/README.md) | 研究TileLang算子实现、内核调优和硬件适配 | `c1cf914a82e6` | 2026-10-14 | 否 |
| [deepselect](../../notes/deepselect/README.md) | 研究稀疏Attention与采样中的TopK选择、GPU实现和数据筛选 | `bfa4507d935f` | 2026-09-30 | 否 |
| [3fs](../../notes/3fs/README.md) | 研究AI训练与推理的数据访问、分布式文件系统、元数据和存储服务 | `22fca04564c7` | 2026-05-07 | 否 |
| [dualpipe](../../notes/dualpipe/README.md) | 研究双向流水线并行、训练微批调度和计算通信重叠 | `030ce4325f4e` | 2026-01-14 | 否 |
| [eplb](../../notes/eplb/README.md) | 研究MoE专家负载统计、专家复制与跨设备部署映射 | `d52c72d5b2f2` | 2025-03-24 | 否 |
| [deepgemm-ascend](../../notes/deepgemm-ascend/README.md) | 研究Ascend矩阵内核、低精度计算及与GPU版DeepGEMM的接口关系 | `3a35326271b0` | 2026-10-14 | 否 |
| [deepep-ascend](../../notes/deepep-ascend/README.md) | 研究Ascend上的MoE专家并行通信、dispatch/combine及与GPU版DeepEP的接口关系 | `3b25377d04b2` | 2026-09-29 | 否 |

## 模型原理与基础（1）

经典模型架构、论文实现与基础原理。

| 项目与笔记 | 当前研究重点 | 本地提交 | 提交日期 | 浅克隆 |
| --- | --- | --- | --- | --- |
| [annotated-transformer](../../notes/annotated-transformer/README.md) | Transformer论文的注释实现，深度学习经典教程 | `debc9fd747bb` | 2022-05-02 | 否 |

## AI 应用与示例（1）

面向具体行业和业务场景的 AI 应用、工作流与参考实现。

| 项目与笔记 | 当前研究重点 | 本地提交 | 提交日期 | 浅克隆 |
| --- | --- | --- | --- | --- |
| [financial-services](../../notes/financial-services/README.md) | 研究Anthropic面向金融服务场景提供的Agent示例、工作流和参考实现 | `60565064557c` | 2026-10-28 | 否 |

## 推荐的三条阅读路线

1. **做一个 Agent**：mini-swe-agent → pi 的轻量 Loop → Codex/OpenCode/Kimi 的 Session 与工具 → LangGraph/Java 框架 → DeerFlow/OpenClaw/Multica 的平台边界 → SWE-agent/Better Harness 的验收与证据。
2. **理解模型如何运行**：Annotated Transformer → nano-vLLM → mini-SGLang → vLLM/SGLang/TensorRT-LLM → FlashInfer/FlashMLA/DeepGEMM 等算子 → DeepEP/EPLB/DeepJIT → DeepInfer。需要训练与数据底座时进入 DeepSpec/DualPipe/3FS。
3. **把能力接入业务**：Spring AI/LangChain 的模型与工具抽象 → AgentScope Java/Spring AI Alibaba 的状态、扩展与协作 → Sub2API 的协议/账号边界 → Financial Services 的领域插件与 reference-only handoff。

每条路线都先跟踪一次输入到输出的真实调用链，再研究扩展点，最后检查失败、取消、恢复与未完成实现。

## 本轮需要记住的修订

- OpenCode 的 core/ai、Kimi Code v2、Goose 状态机和 pi-durable 已改变旧笔记的源码入口。
- pi-durable 明确是实验接口；API 已实现与稳定兼容是两个问题。
- vLLM V2 Runner 当前按平台及特性条件默认选择，不再仅限 pooling 的旧描述。
- Caveman 的当前许可证声明从 3.0 起变为 Apache-2.0，不能沿用旧 MIT/BSL 分区描述。
- DeepInfer 本次发布仍是离线推理范围；DeepJIT 与 DeepEP Ascend 均有明确 WIP 边界。
- AgentScope Java 的 A2A 已迁到 SDK 1.4.0.Final 与 supportedInterfaces，旧 0.3 系列说明已重写。
- Financial Services 的 orchestrate.py 是参考实现，不能当作现成生产工作流引擎。

## 继续阅读

- [AI 基础设施分层与阅读路线](../ai-infrastructure/architecture-and-reading-guide.md)
- [Agent 上下文管理](../context-management/agent-context-management.md)
- [工具调用与错误处理](../agent-tools/tool-execution-and-error-handling.md)
- [Harness 设计与有效性验证](../agent-harness/design-and-validation.md)
- [Coding Agent 跨平台适配](../coding-agents/cross-platform-adaptation.md)
