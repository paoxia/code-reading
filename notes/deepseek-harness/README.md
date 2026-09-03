# DeepSeek Harness 源码分析

> 原始研究版本：`master@47f943859bef`
>
> 2026-08-19 增量复核版本：`master@99f6f02fecdb`（`dsh 0.1.0-rc.7`）
>
> 2026-08-24 增量复核版本：`master@b150a551b8d4`（`dsh 0.1.1-rc.2`）
>
> 2026-09-03 增量复核版本：`master@49a606bc5b59`（`dsh 0.1.2-alpha.5`）
>
> 研究范围：Developer Preview 主线的 Cordis 插件架构、配置组合、Agent Loop、Session Event Log、能力接缝、运行 Preset 与扩展机制。

进一步阅读：[DeepSeek Harness 深度架构与运行时分析](./architecture.md)。

## 1. 定位与结论

DeepSeek Harness（CLI 命令为 `dsh`）不是“给 DeepSeek 模型套一组固定工具”的薄客户端，而是一套以插件组合 Agent Runtime 的 TypeScript monorepo。它 vendoring 了 Cordis 元框架，并把模型、Agent Loop、Session、Prompt、工具、文件系统、Shell、Sandbox、Sub-Agent、Web UI 与持久化都实现成可挂载插件。

官方介绍见 [`README.zh.md`](../../code/deepseek-harness/README.zh.md)，架构总览见 [`docs/architecture.md`](../../code/deepseek-harness/docs/architecture.md)。当前仍标为 Developer Preview，包结构和公开接口应视为快速演进中。

增量复核确认插件化主架构未变，但交互和恢复边界有两项可见更新：Ask User 问题卡可收起，实现见
[`QuestionComposer.tsx`](../../code/deepseek-harness/packages/client/ui-user-questions/src/client/QuestionComposer.tsx)；LLM replay 会把恢复状态与已组装 content 对齐，遇到不可用状态时降级，避免 max-token continuation 重放出错，见
[`replay.ts`](../../code/deepseek-harness/packages/llm/llm-pi-ai/src/replay.ts)。

2026-08-24 的核心变化是图片链路统一：本地 attachment、DeepSeek Files 和模型请求共享 canonical admission/encoding，`read_image` 会返回下采样尺寸与坐标缩放；Files 解析失败可以回退 inline，同时文件上传和 stream timeout 分开计算。实现见 [`read-image.ts`](../../code/deepseek-harness/packages/fs/tool-fs/src/read-image.ts) 与 [`llm-deepseek/src/index.ts`](../../code/deepseek-harness/packages/llm/llm-deepseek/src/index.ts)。这扩展了 Attachment/LLM plugin 的合同，没有改变 Cordis 组合方式。

2026-09-03 的复核仍确认 Cordis、事件事实源和能力接缝三条主线不变，但产品装配和持久化边界已经收紧：所有受支持的 Node 应用统一由 `dsh --profile` 启动；Agent Preset 被打包进独立 package，`code` 正式更名为 `ptc`；Session persistence 改为每 Session 一个 handle 的单写者模型，目前只有 JSONL 是第一方 Session 后端；子 Agent 可以在 Session 记录的白名单内选择模型。实验性的 Agent Teams 已实现持久 mailbox 与 task board，但明确排除在正式发行物之外。

核心设计可以概括为：

```text
Everything is a plugin
        +
model-visible means logged
        +
Service Definition / Provider / Consumer
```

第一条决定扩展方式，第二条决定可恢复性，第三条决定文件系统、Shell、Sandbox、LLM 等能力如何替换。

## 2. Cordis 插件树

Cordis 的核心源码位于 [`vendor/cordis/src`](../../code/deepseek-harness/vendor/cordis/src)，Harness 所需概念可先读 [`docs/cordis-primer.md`](../../code/deepseek-harness/docs/cordis-primer.md)：

| 概念 | 作用 |
|---|---|
| Plugin | 函数插件或 `Service` 子类，向运行时贡献行为 |
| Context | 按稳定 key 保存服务，例如 `ctx.tools`、`ctx.llm`、`ctx.sessions` |
| `inject` | 声明服务依赖，依赖就绪后再激活插件 |
| Typed Event | 插件间通信与拦截点 |
| Effect | 可撤销注册，支持 teardown 和热重载 |
| Realm/Scope | 隔离服务实例并把注册限定到 Agent/Preset |

事件有 `emit`、`waterfall`、`parallel` 和 `serial` 四种语义。其中 waterfall 类似 around middleware：监听者必须调用 `next()` 才会继续下游，也可以不调用以短路决策。

与传统 DI 容器相比，Cordis Context 不只是找对象。配置 Loader 会从 YAML 构造插件树，服务出现/消失会驱动依赖插件激活和卸载，所有贡献应通过可回收 Effect 注册。

## 3. 启动与配置分层

CLI 入口从 [`apps/cli/src/bin.ts`](../../code/deepseek-harness/apps/cli/src/bin.ts) 进入，Profile 解析由 [`packages/boot/app-boot/src/profile.ts`](../../code/deepseek-harness/packages/boot/app-boot/src/profile.ts) 负责。

实际配置不是一份不可覆盖的大文件，而是按层合并：

```text
空配置
  → Profile 声明的 Bundle（按顺序）
  → Profile 自己的 cordis.patch.yml
  → Harness Home 的 cordis.patch.yml
  → 命令行 --patch
```

基础层 [`packages/bundle/base/cordis.patch.yml`](../../code/deepseek-harness/packages/bundle/base/cordis.patch.yml) 提供模型、Session、工具注册表、执行后端、持久化、安全策略等 Host Plane 能力；Web、Headless、SDK 和 ACP 再叠加各自的应用 Bundle。`sdk-minimal` 是例外，它由一个独立 Bundle 持有完整显式插件树，不叠加 `base`。受支持的 Node 应用都从 `dsh` 入口选择 `web`、`headless`、`sdk`、`sdk-minimal` 或 `acp` Profile。

可用 `dsh --profile web --dump-config` 查看最终插件树。Patch 按插件 row ID 定位，并替换该 row 的完整 config，而不是递归深合并；自定义覆盖时遗漏字段可能导致原配置丢失。

## 4. Host Plane 与 Agent Plane

DeepSeek Harness 特别区分两种生命周期：

- Host Plane：进程级单例，例如模型路由、持久化、Sandbox policy、Sub-Agent Registry 和 Web Gateway；
- Agent Plane：某个 Preset/Agent 独有的 Prompt、工具集合、Plan Mode、Compaction 和 Workflow Engine。

Agent Preset 由 [`dsh-agent-presets`](../../code/deepseek-harness/packages/preset/agent-presets) 管理。每种 Preset 挂载一棵 standing composition，使用它的 Session 通过 Scope parentage 加入；工具、Prompt 等贡献按 Scope 可见，插件内部的会话状态仍以 Session/Agent 为 key。需要发布私有 Service 的 row 必须进入 `isolate` realm，避免不同 Preset 的同名服务落到 root realm 后互相冲突。源码中的说明集中在 [`standard/agent.cordis.yml`](../../code/deepseek-harness/packages/preset/agent-presets/presets/standard/agent.cordis.yml)。

这不是形式上的分层：如果把本应在 Host Plane 的 Registry 放进 Agent realm，Web API 或其他 Agent 就无法找到它；如果把 Agent 私有状态放在 Host Plane，多 Preset 会共享错误实例。

## 5. Agent Loop 与事件流

抽象 Agent 服务位于 `packages/core/agent`，默认驱动位于 [`packages/core/agent-loop/src/agent.ts`](../../code/deepseek-harness/packages/core/agent-loop/src/agent.ts)。一次 Turn 可以包含多个 Step，每个 Step 是一次模型请求及其工具调用：

```text
turn/start
  → inbox claim（输入和排队消息）
  → assemble prompt sections + tool schemas
  → agent/pre-step
  → step/start
  → user/message 写入 Session Log
  → 从 Log 派生模型历史
  → agent/request → llm/stream
  → assistant/chunk* → assistant/message
  → tool/call* → tools/pre-execute
               → tools/execute
               → tools/post-execute
               → tool/result*
  → step/end
  → 如工具或新输入要求继续，则进入下一 Step
  → agent/turn-stopping
turn/end
```

工具调用与结果整理可继续看 [`agent-loop/src/tool-calls.ts`](../../code/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts)。Loop 自身刻意保持窄；重复调用提醒、超时、Compaction、Plan Mode 等行为由外围插件监听事件实现，而不是持续往 Loop 中增加条件分支。

## 6. Session Event Log 是事实源

Session 定义在 [`packages/core/session/src/index.ts`](../../code/deepseek-harness/packages/core/session/src/index.ts)，事件类型位于 [`session/src/types.ts`](../../code/deepseek-harness/packages/core/session/src/types.ts)。系统将 `turn/*`、`step/*`、用户消息、Assistant chunk/message 和工具调用/结果写成追加事件。

```text
Session Event Log
  ├─ deriveMessages() → 下一次模型请求历史
  ├─ Projection       → UI 当前视图
  ├─ Persistence      → JSONL Session artifact
  ├─ Resume / Fork    → 恢复与分支
  ├─ Transcript       → 会话记录
  └─ Telemetry        → 统计与诊断
```

“model-visible means logged” 是重要不变量：任何进入模型上下文的输入都必须能从事件日志重建。这样恢复会话时不会依赖只存在内存中的隐藏 Prompt 或注入状态。原始 `assistant/chunk` 也被保留，以支持精确回放和 UI 流式呈现。

持久化不是硬编码在 Loop 中。[`session-persistence`](../../code/deepseek-harness/packages/session/session-persistence) 定义 backend-neutral service 和 `SessionHandle`：`create/open` 取得单写者所有权，`append` 接收连续事件，`flush` 是明确的 durable barrier，`close` 排空写入后释放所有权。当前唯一第一方 Session 后端是 [`session-persistence-jsonl`](../../code/deepseek-harness/packages/session/session-persistence-jsonl)，以每 Session 一个 `.jsonl.zstd` 或纯 JSONL artifact 保存日志。通用 [`storage-sqlite`](../../code/deepseek-harness/packages/storage/storage-sqlite) 与 `session-query-sqlite` 仍使用 SQLite，但它们不是 Session Event Log 的持久化 Provider。

## 7. 能力接缝

Harness 把可替换能力拆成三种角色：

```text
Service Definition → 声明稳定接口
Service Provider   → 本地、远程或沙箱实现
Consumer           → Agent 可调用 Tool 或其他使用者
```

例如 Shell 并不等于一个 Bash tool：Shell Service 定义执行能力，本地或远程 Provider 负责实现，`tool-bash` 才把它暴露给模型。文件系统、Subprocess、Terminal、LSP、Web、Sub-Agent、Workflow 和 Code Runtime 都采用相似结构。完整包分组见 [`packages/README.md`](../../code/deepseek-harness/packages/README.md)。

这种拆法的直接收益是：当 FS、Subprocess 和 Shell Provider 一起指向远端 Sandbox 时，上层工具和 Agent Loop 不需要增加 provider-specific 分支。

## 8. 四种 Agent Preset

Preset 定义位于 [`packages/preset/agent-presets/presets`](../../code/deepseek-harness/packages/preset/agent-presets/presets)：

| Preset | 主要用途 | 特征 |
|---|---|---|
| `standard` | 完整 Coding Agent | 文件、Shell、Skills、Goal、Plan、Compaction、Sub-Agent、Workflow 等完整能力 |
| `ptc` | PTC | 通过 Code Runtime 让模型编写 TypeScript，批量组合多步工具操作；不再暴露重复的通用 `workflow` Tool |
| `minimal` | 最小评测/编码环境 | 完整固定 Persona，仅保留持久 Bash 与 `str_replace_editor`，无 Compaction |
| `cordis` | Runtime 自修改 | 增加插件树检查、挂载/卸载和插件开发 Skills |

`minimal` 的实现见 [`minimal/agent.cordis.yml`](../../code/deepseek-harness/packages/preset/agent-presets/presets/minimal/agent.cordis.yml)。它不是 `standard` 的简单开关组合，而是独立、严格受限的 Agent Plane 配置。

`cordis` Preset 最具实验性：Agent 可以检查自身插件树并动态挂载模型编写的插件。这体现了项目的“自描述运行时”方向，但也扩大了代码执行与配置错误的风险面。

## 9. Sandbox 与安全边界

Sandbox 是进程启动参数包装能力，而不是 Agent Loop 内部特判。当前包含 Linux `bwrap`/Landlock 与 macOS Seatbelt 等后端；本地文件系统、Subprocess、Shell 和 Terminal 再通过这一策略执行。

Linux 原生 Landlock 辅助组件位于 [`native/landlock-run`](../../code/deepseek-harness/native/landlock-run)。平台支持与降级语义需要结合该目录文档和实际配置判断，不能仅看到 `sandbox` 包名就假定所有平台具有等价强制隔离。

系统还区分模型侧工具、人工 approval/interaction 和外部协议入口。ACP 主要面向自动化客户端，Web UI 通过 Host/Client 插件组合，Python SDK 则调用打包的 Harness Runtime；它们最终共享同一插件化内核。

## 10. 与 DeerFlow 的关键差异

| 维度 | DeepSeek Harness | DeerFlow 2.0 |
|---|---|---|
| 内核 | 自有 TypeScript Agent Loop + Cordis | LangChain Agent + LangGraph |
| 扩展单位 | 几乎一切都是 Plugin/Service/Event | Middleware、Tool、MCP、Skill、Python Extension |
| 状态事实源 | 追加式 Session Event Log | LangGraph State/Checkpoint + Runtime Event Store |
| 产品形态 | CLI、Web、ACP、SDK 共享可组合 Runtime | Web/IM 为主的全栈长任务平台 |
| Agent 变体 | Preset 插件树 | Lead Agent 配置与 Sub-Agent 类型 |
| 自修改 | `cordis` Preset 可检查和挂载插件 | Skills/Extension 可扩展，但主链相对固定 |

两者都支持长任务、Skills、Sandbox 和 Sub-Agent，但不应只按功能清单比较。DeepSeek Harness 优先追求运行时可组合性和可替换接缝；DeerFlow 优先提供开箱即用的完整任务平台与固定主链的一致体验。

## 11. 限制与注意事项

- 当前为 Developer Preview，包边界、Preset 和插件 API 仍可能快速变化。
- 包数量很多，直接从目录名顺读容易迷失；应从默认 Profile 的最终插件树反向追踪。
- Patch 替换整段插件配置而非深合并，用户覆盖存在意外丢字段风险。
- 动态插件和自修改能力强，但插件本质上是同进程代码，不是安全扩展沙箱。
- Sandbox 后端具有平台差异；需要分别验证 Linux、macOS 和 Windows 的实际执行路径。
- Session 格式仍为预发布 `v0`，未知且未标记 `ignorable` 的事件会拒绝读取；当前没有格式迁移兼容承诺。
- 仓库要求用 composition test、snapshot 和必要的 runtime invariant 验证关系，但这不等于 Developer Preview 已提供稳定兼容承诺。

## 12. 推荐阅读顺序

1. [`README.zh.md`](../../code/deepseek-harness/README.zh.md)：了解产品入口和 Preset。
2. [`docs/architecture.md`](../../code/deepseek-harness/docs/architecture.md)：建立 Host/Agent Plane 与事件模型。
3. [`docs/cordis-primer.md`](../../code/deepseek-harness/docs/cordis-primer.md)：理解 Context、Service、Effect 和 waterfall。
4. [`bundle/base/cordis.patch.yml`](../../code/deepseek-harness/packages/bundle/base/cordis.patch.yml)：看默认 Host 如何组装。
5. [`standard/agent.cordis.yml`](../../code/deepseek-harness/packages/preset/agent-presets/presets/standard/agent.cordis.yml)：看完整 Agent Plane。
6. [`core/agent-loop/src/agent.ts`](../../code/deepseek-harness/packages/core/agent-loop/src/agent.ts)：掌握 Turn/Step 主循环。
7. [`core/session/src`](../../code/deepseek-harness/packages/core/session/src)：理解 Event Log 与重建。
8. [`core/tools/src`](../../code/deepseek-harness/packages/core/tools/src)：理解工具注册、schema 和执行管线。
9. [`session-persistence/README.md`](../../code/deepseek-harness/packages/session/session-persistence/README.md)：理解 handle、单写者、flush 与崩溃恢复。
10. 按需进入 `fs/`、`shell/`、`sandbox/`、`subagent/` 等能力组，沿 Definition → Provider → Consumer 阅读。
11. 对照相应 `tests/` 验证取消、恢复、工具顺序、配置热重载和持久化不变量。
