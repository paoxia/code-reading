# Codex Open Agent Harness：从 Coding Agent 到可嵌入运行时

> 调研日期：2026-08-22
>
> 官方公告发布日期：2026-08-19
>
> 源码复核版本：`openai/codex@4f39251`
>
> 2026-08-24 增量复核版本：`openai/codex@339751715c64`

## 1. 先说结论：这次发布的准确名称是什么

OpenAI 这次的官方标题是 **“Codex as a platform: build on the open agent harness”**。其中真正被复用的是 **Codex open agent harness**，即围绕模型构建的 Agent 执行系统；它负责上下文、Agent Loop、工具、事件流、沙箱、审批和跨轮状态。官方没有发布一个名为 “Codex Agent Framework” 或 “Codex Agent SDK” 的新产品。

更准确的理解是：这是一次 Codex **平台定位与集成路径的系统化发布**，不是把一个全新的通用 Agent 框架突然加入仓库。此前 CLI、IDE、app-server、Codex SDK 和底层 Rust runtime 已经是同一开源系统的不同入口；2026-08-19 的公告明确把它们作为可嵌入的 agent harness 对外解释，并给出面向垂直业务产品的组合方式。

后续源码进一步证明 harness 是持续演进的运行时而非一次性发布包装：root turn 可在未完成时 suspend，TUI 可通过动态工具管理 Codex tasks，subagent fork 会保留 developer instruction 的来源标注，Agent Plugin MCP server 也会接收受控的本地环境变量。对应入口见 [`turn_suspension.rs`](../../code/codex/codex-rs/core/src/session/turn_suspension.rs)、[`dynamic_tools.rs`](../../code/codex/codex-rs/tui/src/dynamic_tools.rs) 和 [`agent_plugin_mcp_overlay.rs`](../../code/codex/codex-rs/core-plugins/src/agent_plugin_mcp_overlay.rs)。

几个容易混淆的名称需要先拆开：

| 名称 | 定位 | 与本次发布的关系 |
|---|---|---|
| Codex | 面向软件工程和代码任务的 Agent 产品及开源 runtime | harness 的主体；CLI、App、IDE 等体验由它驱动 |
| Codex open agent harness | 上下文、循环、工具、状态、安全边界等执行层 | 本次公告的核心说法，不是新的 npm/pip 包名 |
| Codex SDK | 在应用代码中启动、继续、恢复 Codex thread 的封装 | harness 的简化编程入口；当前官方提供 TypeScript 和 Python 路径 |
| Codex app-server | 面向深度产品集成的双向 JSON-RPC 接口 | 暴露 thread、turn、item、事件、审批和中断等完整生命周期 |
| OpenAI Agents SDK | 通用、code-first 的 Agent 定义与多 Agent 编排 SDK | 不等于 Codex SDK；可通过 MCP 把 Codex 当作一个工程专家来编排 |
| AgentKit | OpenAI 曾用于一组 Agent 构建能力的套件名称 | 不是 Codex harness 的别名；截至调研日，官方 API 文档分别组织 Agents SDK、ChatKit，并把 Agent Builder 列在 Legacy APIs 下 |
| Codex subagents / Responses API multi-agent | Codex 或模型层的多 Agent 能力 | 是运行能力，不是本次公告中另一个新框架 |

因此，下文用“Codex harness”指开源执行系统，用“Codex SDK”和“app-server”指两个具体集成面；不会把 Agents SDK、AgentKit 或模型名称混写成同一产品。

## 2. 背景与定位

直接调用 Responses API 可以得到模型输出和 tool call，但一个可用的 Agent 还需要处理：

- 任务与环境上下文如何持续进入模型；
- 多次模型采样和工具执行何时继续、何时结束；
- 命令、文件修改、MCP 工具如何执行并回传结果；
- 长会话如何持久化、恢复与压缩；
- 用户如何看到进度、批准高风险动作或中断任务；
- 工具失败、连接失败和上下文溢出如何进入明确的终态。

这些位于“模型之上、产品界面之下”的机制就是 harness。Codex App、CLI 和 IDE Extension 原本已经依赖同一套机制；新的平台定位允许开发者保留自己的工单、告警、物流、客服或安全工作台，只把 Agent 执行层嵌入既有产品。

这也解释了为什么官方示例 Relay 不是又一个聊天窗口：业务应用仍然拥有界面、记录、规则、授权和 MCP 数据/动作，Codex 负责 Agent Loop、对话状态、流式活动和工具交互。

## 3. 核心架构

```text
业务应用
├─ 界面：工单 / IDE / 告警 / 记录 / 操作按钮
├─ 业务上下文、规则、身份与用户同意
├─ 系统记录与应用自有 MCP 数据/动作
│
└─ Codex 集成面
   ├─ codex exec：一次性脚本、CI、后台任务
   ├─ Codex SDK：start / run / stream / resume
   └─ app-server：JSON-RPC thread / turn / item / approval
          │
          ▼
      Codex open agent harness
      ├─ Thread / Session：跨轮上下文与持久化
      ├─ Turn / sampling loop：模型—工具—模型循环
      ├─ Tool runtime：shell、文件、MCP、扩展工具
      ├─ Sandbox + approval：执行边界与人在回路
      ├─ Events / rollout：流式进度、恢复与审计素材
      └─ Compaction / retry / interrupt：长任务生命周期
          │
          ▼
      模型访问与托管服务（与开源 harness 分离）
```

### 3.1 Thread、Turn 与 Item

- **Thread** 是一段可继续、恢复或分叉的会话，包含多个 turn。
- **Turn** 是一次用户请求及随后发生的 Agent 工作；一次 turn 内部可以进行多次模型采样和工具执行。
- **Item** 是可流式观察的输入或输出单元，例如用户消息、Agent 消息、命令执行、文件修改和工具调用。

app-server 把这三层作为协议原语；核心 runtime 中则由 `Session`、`TurnContext` 和 `run_turn()` 等实现实际生命周期。详细源码链路可继续阅读 [Turn Loop](./turn-loop.md) 和 [App Server](./app-server.md)。

### 3.2 Agent Loop 不是一轮 API 请求

典型 turn 的内部流程是：

```text
用户输入
  → 固化本轮模型、cwd、权限、sandbox 与工具配置
  → 构造模型输入并开始流式采样
  → 收到 tool call
  → 审批 → 选择沙箱 → 执行 → 记录 tool output
  → 把结果加入上下文，再次采样
  → 无待执行工具并通过停止条件
  → 发送完成、失败或中断终态
```

源码中的 [`session/turn.rs`](../../code/codex/codex-rs/core/src/session/turn.rs)、[`tools/orchestrator.rs`](../../code/codex/codex-rs/core/src/tools/orchestrator.rs) 和 [`tools/router.rs`](../../code/codex/codex-rs/core/src/tools/router.rs) 分别对应采样循环、审批/沙箱执行次序与工具路由。工具 runtime 的完整拆解见 [Tool Runtime](./tool-runtime.md)。

### 3.3 应用与 harness 的职责边界

| 应用负责 | Codex harness 负责 |
|---|---|
| 业务界面、所选记录和当前视图 | Thread/turn 生命周期和模型循环 |
| 身份、组织权限和业务规则 | 配置的文件/命令沙箱与 Agent 审批协议 |
| MCP 服务背后的真实数据和副作用 | 发现、调用工具并把结果送回模型 |
| 高风险动作的产品级确认体验 | 发起 approval request、等待并继续执行 |
| 业务记录刷新、幂等和最终系统状态 | 流式 item/event、会话历史和恢复素材 |
| 多租户隔离、审计、指标和成本策略 | Agent runtime 本身的重试、压缩和中断语义 |

“harness 开源”不表示模型权重、模型访问和 OpenAI 托管服务也随之开源；官方明确把两者分开。

## 4. 主要能力

### 4.1 可持续的任务状态

Thread 可以连续运行多轮，也可以按 ID 恢复。Codex 的 rollout 保存可重建历史，app-server 还能 resume、fork、interrupt 和 stream；因此产品无需把 UI 事件数组误当成下一轮 prompt。持久化边界详见 [Rollout](./rollout.md)。

### 4.2 流式、可观察的执行

SDK 能流式返回结构化事件；app-server 进一步暴露 `turn/started`、`item/*`、`turn/completed` 等通知。产品可以分别渲染推理进度、命令、文件变化、工具调用和最终回复，而不是等一个长请求结束。

### 4.3 工具与业务系统集成

Codex 自带代码任务所需的 shell、文件修改等能力，也可以连接 MCP。业务应用可以只暴露与当前工作流相关的读写工具，使 Agent 在既有记录和操作上工作。工具能被调用不代表副作用已经安全：应用仍需提供授权、幂等、参数校验和业务审计。

### 4.4 沙箱、权限和人在回路

Codex 可限制文件系统、网络和命令执行，并在策略要求时发起审批。app-server 客户端需要处理服务端 approval request；产品应把拟执行命令、变更或业务动作呈现给用户，而不是自动同意所有请求。

### 4.5 多种集成粒度

| 入口 | 适合 | 代价/控制力 |
|---|---|---|
| `codex exec` | shell 脚本、CI、一次性后台任务 | 集成最轻，生命周期控制较少 |
| Codex SDK | 服务端应用启动、流式执行和恢复 coding thread | API 简洁，隐藏了较多协议细节 |
| app-server | Agent 是产品功能本身，需要自定义 UI、审批和长会话 | 控制最完整，也要自己维护双向协议状态机 |
| Codex MCP server + Agents SDK | Codex 是更大通用工作流中的工程专家 | 多一层编排，但职责边界更清晰 |

## 5. 典型工作流与最小示例

### 5.1 推荐工作流

1. 先判断任务是否真的以代码、仓库和本地命令为核心。
2. 从最小入口开始：单次任务用 `codex exec`，应用代码用 SDK，只有深度交互产品才直接接 app-server。
3. 明确工作目录、可写目录、网络和 approval policy，不使用宽泛权限作为默认值。
4. 把业务上下文和工具放在应用侧，通过输入或 MCP 交给 Codex。
5. 启动 thread 和 turn，消费中间事件；在 UI 或服务端处理审批、取消和超时。
6. 保存 thread ID 与业务对象 ID 的映射，以便继续或恢复任务。
7. 用真实任务集验证完成率、错误副作用、时延、token/工具成本和人工审批频率，再逐步扩大权限。

### 5.2 TypeScript 最小示例

以下接口已按 2026-08-22 的官方文档和本地 `sdk/typescript` 源码复核。Codex SDK 要在服务端运行，Node.js 最低版本为 18。

```bash
npm install @openai/codex-sdk
```

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: process.cwd(),
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
});

const result = await thread.run(
  "分析当前测试失败，先说明根因，再实现最小修复并运行相关测试。",
);

console.log(result.finalResponse);
console.log("thread:", thread.id);
```

同一 `thread` 再次调用 `run()` 会继续原会话；进程重启后可通过 `codex.resumeThread(threadId)` 恢复。需要展示命令、文件变更和 token 使用量时，改用 `runStreamed()` 消费 `item.completed`、`turn.completed` 等事件。

源码上，TypeScript SDK 通过 [`exec.ts`](../../code/codex/sdk/typescript/src/exec.ts) 启动 Codex CLI，并用 JSONL 交换事件；[`thread.ts`](../../code/codex/sdk/typescript/src/thread.ts) 提供 `run()`、`runStreamed()` 和 thread ID 管理。它是 harness 的便捷封装，不是远程 HTTP API 的另一套 Agent Loop。

Python SDK 当前要求 Python 3.10+，通过 JSON-RPC 控制本地 app-server；已发布版本携带固定的 Codex CLI runtime 依赖。两种语言的内部传输不同，不能根据 TypeScript 实现推断 Python 也通过 `codex exec`。

## 6. 与旧方式或相近方案的区别

### 6.1 与“直接调用 Responses API + 自己写循环”相比

直接 API 方式最灵活，也意味着应用要自行负责 tool loop、会话状态、命令环境、审批协议、重试、压缩和事件模型。Codex harness 提供经过 Codex 产品使用的现成实现，尤其适合需要真实仓库、命令和文件修改的长链路任务。

反过来，如果任务只是少量远程工具调用、完全不需要本地工程环境，直接用 Responses API 或 Agents SDK 通常更轻。引入 Codex 不应只是为了包装一次模型问答。

### 6.2 与过去只使用 Codex CLI 相比

CLI 仍然适合人直接在终端协作，`codex exec` 适合非交互自动化；但解析终端文本、模拟按键或把 CLI 当作无协议黑盒会很脆弱。SDK 给出稳定的代码级 thread/run/event 抽象，app-server 则提供正式的生命周期协议和审批请求。

新的平台定位还改变了产品形态：用户可以留在原有 IDE、告警台或业务工作台中，由应用自动提供当前对象的上下文，而不是先切换到通用聊天界面并手写提示词。

### 6.3 与 OpenAI Agents SDK 相比

| 维度 | Codex SDK / harness | OpenAI Agents SDK |
|---|---|---|
| 首要领域 | 软件工程、代码库、本地命令与文件操作 | 通用 Agent 应用和多领域工作流 |
| 核心抽象 | Codex thread、turn、item 与 coding runtime | Agent、Runner、tool、handoff、guardrail、session |
| 执行环境 | 本地 Codex runtime、工作区和沙箱是核心 | 模型/工具编排为核心，也支持 sandbox agent 等运行模式 |
| 多 Agent | Codex 自身可有 subagent 能力 | 明确提供 handoff 或“agent as tool”的编排模式 |
| 集成关系 | 可作为 MCP server 暴露给上层 | 可把 Codex MCP server 当作工程专家调用 |

二者不是互斥替代品。若整个产品就是一个 coding agent，优先从 Codex SDK 开始；若“修代码”只是客服、运营或研发工作流中的一个专家步骤，则由 Agents SDK 负责编排、Codex 负责代码任务更自然。

### 6.4 与 AgentKit / Agent Builder 相比

AgentKit 更接近一组构建 Agent 产品的能力集合，不是一个与 `openai/codex` 一一对应的 runtime 仓库。当前官方 API 文档将 code-first runtime 放在 Agents SDK 下，将 ChatKit 作为交互界面能力；Agent Builder 已位于 Legacy APIs。Codex harness 则有明确的开源 Rust 实现和 coding-first 安全/执行语义。选型时应比较具体组件，不要用“AgentKit”这个总称代替 Codex SDK 或 Agents SDK。

## 7. 适用场景与限制

### 7.1 适合

- 在 CI 中诊断失败、生成修复并输出结构化结果；
- 在 IDE、代码审查或内部研发平台中嵌入长时 coding agent；
- 安全告警、事故响应、客服排障等需要读取仓库并提出或执行修复的流程；
- 需要可恢复 thread、流式工具进度、沙箱和人工批准的垂直产品；
- 需要检查并按自身产品边界适配开源 Agent Loop 的团队。

### 7.2 限制与风险

- **不是纯浏览器 SDK。** TypeScript SDK 要求服务端 Node.js 18+ 并启动本地 Codex CLI；Python SDK要求 Python 3.10+ 并控制本地 app-server。
- **开源不等于离线免费模型。** 模型访问、认证、配额、价格和托管服务与开源 harness 分离，且会随官方策略变化；本文不固化价格或账号可用性结论。
- **沙箱不能替代业务授权。** MCP 写操作、工单变更、部署或真实数据修改仍需应用级权限、审批、幂等和审计。
- **app-server 接入复杂度更高。** 客户端必须实现 initialize gate、双向 request/response、事件排序、审批和终态；WebSocket transport 及部分方法仍被官方标记为 experimental/unsupported，不应默认作为生产承诺。
- **协议和源码演进快。** app-server 可按当前 Codex 版本生成 TypeScript 或 JSON Schema；集成方应固定兼容版本并运行契约测试，而不是复制本文中的字段列表长期不更新。
- **通用编排未必应该下沉到 Codex。** 跨客服、支付、CRM 等多专家路由更适合由 Agents SDK 或业务工作流层拥有，Codex 只处理边界清楚的工程任务。
- **生产能力仍由宿主补齐。** 多租户隔离、任务队列、SLA、成本上限、可观测性、数据保留和合规策略不是一段 SDK 示例自动解决的。

## 8. 快速上手建议

### 第 1 阶段：先跑通一个只读任务

选择一个小型 Git 仓库，以 read-only sandbox 完成“定位失败测试并给出证据”。记录最终回答、命令 item、耗时和 token 使用，确认 thread 能够继续和恢复。

### 第 2 阶段：开放受限写入

只允许工作区写入，要求 Agent 运行指定测试并输出 diff；所有网络、仓库外写入和高风险命令保持审批。不要从 `danger-full-access` 起步。

### 第 3 阶段：接入业务上下文

把工单、告警或服务元数据作为结构化上下文提供；真实业务数据和动作通过窄 MCP 工具暴露。读工具与写工具分离，写工具设置明确的审批和幂等键。

### 第 4 阶段：再决定是否需要 app-server 或 Agents SDK

- SDK 的事件和恢复能力足够，就保持简单。
- 需要定制 item UI、审批、中断、分叉和持续会话时，再下沉到 app-server。
- 需要多个领域专家、handoff、集中 tracing/eval 时，用 Agents SDK 做上层编排，并通过 MCP 调用 Codex。

## 9. 推荐源码阅读顺序

1. [`sdk/typescript/src/codex.ts`](../../code/codex/sdk/typescript/src/codex.ts)：SDK 如何创建和恢复 thread。
2. [`sdk/typescript/src/thread.ts`](../../code/codex/sdk/typescript/src/thread.ts)：`run()` 与 `runStreamed()` 如何投影 JSONL 事件。
3. [`codex-rs/app-server/README.md`](../../code/codex/codex-rs/app-server/README.md)：客户端协议、生命周期和审批面。
4. [`codex-rs/app-server/src/message_processor.rs`](../../code/codex/codex-rs/app-server/src/message_processor.rs)：请求如何分派到 thread/turn processor。
5. [`codex-rs/core/src/session/turn.rs`](../../code/codex/codex-rs/core/src/session/turn.rs)：真正的采样与工具循环。
6. [`codex-rs/core/src/tools`](../../code/codex/codex-rs/core/src/tools)：工具 registry/router、并发、审批与沙箱。
7. [`codex-rs/core/src/rollout.rs`](../../code/codex/codex-rs/core/src/rollout.rs)：恢复与持久化入口。

## 10. 官方参考

以下资料在 2026-08-22 复核；没有展示更新时间的文档页以本次调研日期作为快照日期。

- [Codex as a platform: build on the open agent harness](https://learn.chatgpt.com/blog/codex-as-a-platform)（2026-08-19，本次发布的主公告）
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)（TypeScript/Python 安装、thread、stream 与 resume）
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)（JSON-RPC、生命周期、事件和审批）
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)（`codex exec` 自动化）
- [Open Source](https://learn.chatgpt.com/docs/open-source)（开源组件与边界）
- [Use Codex with the Agents SDK](https://learn.chatgpt.com/docs/mcp-server)（通过 MCP 组合 Codex 与 Agents SDK）
- [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents)（通用 Agent runtime、编排与相关能力导航）
- [OpenAI Codex GitHub 仓库](https://github.com/openai/codex)（harness、CLI、app-server 与 SDK 源码）
