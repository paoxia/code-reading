# Better Harness 源码分析：用证据闭环审查 Coding Agent 工作流

相关专题：[Windows、Linux 与 macOS 跨平台适配](./cross-platform-adaptation.md)

> 上游仓库：[`QoderAI/better-harness`](../../code/better-harness/README.md)
>
> 原始研究版本：`main@1ad9642768881cf12b56cc6eadd71b7b28b1f8fd`
>
> 2026-08-19 增量复核版本：`main@e567e25e34f4aacb77d603888042ed939894dfdf`
>
> 2026-08-24 增量复核版本：`main@77db22a565f12c4396fcdfb7f79ac1bdc3dd22ba`
>
> 当前 npm 包版本：`@qoderai/better-harness 0.6.4`
>
> 研究范围：根 CLI、`/better-harness` Skill、Evidence Bundle、Session/Project/Agent
> Customize 三类证据、Agent Work Loop 模型、报告渲染与验证、多宿主适配和测试。

## 2026-08-19 增量复核

本次 pull 没有改变“证据闭环元 Harness”的核心定位，但用户交互面已从单独报告页进一步演进为 Studio 内置工作台：

- Studio 直接挂载 [`InspectorWorkbench`](../../code/better-harness/packages/harness-studio/src/app/InspectorWorkbench.tsx)，证据查询由 Studio server 统一提供；
- Inspector 新增按日期列出 session 的视图，而不只是单次 session 的静态渲染；
- 视觉与交互规则集中到 [`DESIGN.md`](../../code/better-harness/DESIGN.md)。这改变了呈现层，不改变 Session/Project/Agent Customize 的证据分域。

## 2026-08-24 增量复核

Better Harness 的“证据审查”定位仍未变化，但 Studio 已从查看既有证据扩展为可运行和检查 Agent 的工作台：

- Harness 新增 ACP SDK 执行入口，Studio 可启动 coding agent 并把 ACP 事件翻译成统一 Run 视图，见 [`acp-sdk.ts`](../../code/better-harness/packages/harness/src/exec/acp-sdk.ts) 与 [`RunView.tsx`](../../code/better-harness/packages/harness-studio/src/app/RunView.tsx)；
- Artifact provider 成为公开扩展面，workspace browser 可按 revision 浏览代码、Markdown、PDF、表格和外部 provider 产物，见 [`provider.ts`](../../code/better-harness/packages/harness/src/artifacts/provider.ts) 与 [`workspace-artifacts.ts`](../../code/better-harness/packages/harness-studio/src/server/workspace-artifacts.ts)；
- DeepSeek Harness 加入 configured-assets inventory，说明 Agent Customize 仍按宿主 adapter 扩展，而不是把不同宿主配置硬合并成一套 schema。

因此 Studio 现在同时承担 evidence inspection、live run 和 artifact review，但评分与证据契约仍由 Harness 层控制。

## 1. 先给结论

Better Harness 不是一个负责修改代码的 Coding Agent，也不是新的 Agent Loop。它是一套
“审查 Agent 外部工作系统”的元 Harness：

- 它检查 Agent 是否正确理解任务、沿受支持路径执行、验证改动、安全交付并沉淀学习；
- 它把 Session、项目静态结构、Agent 配置资产分成相互独立的证据域；
- 它让 AI 负责需要语义判断的 finding、严重度和评分，让确定性程序负责采集、脱敏、契约校验、
  投影、渲染和原子发布；
- 它不把“文件存在”“资产数量很多”或“配置已启用”直接当成能力已经生效；
- 它把一次修复通过与长期效果改善分开：同窗口验证只能更新 Repair Progress，只有后续可比
  Task Episode 才能更新 Loop Effectiveness。

最重要的架构可以压缩为：

```text
宿主调用 /better-harness
          │
          ▼
冻结 workspace / provider / 时间窗 / depth / authority
          │
          ▼
┌────────────── Evidence Bundle：确定性采集 ──────────────┐
│ Session Evidence     Project Harness     Agent Customize │
│ facts                git + files         lint/inventory  │
│                                           /integrity     │
│                         Lead analyzer                  │
│              report.source + evidence brief + facts   │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
             3 个相互隔离的只读分析 Agent
                          │
                          ▼
              Lead AI 统一裁决与编写 findings.json
                          │
                          ▼
       确定性校验、Markdown/HTML/Canvas 投影、原子发布
```

这里有两个必须分开的“并发”：

1. [`collectEvidenceBundle()`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/index.mjs)
   在 Node 进程中用 `Promise.all()` 并行采集三个 lane 和一个 lead envelope；
2. [`SKILL.md`](../../code/better-harness/skills/better-harness/SKILL.md) 要求宿主在拿到
   bundle 后，再启动恰好三个只读 Agent 分别解释三个证据域。

第二条属于 Skill 编排协议，并不是 Node CLI 在运行时强制创建 Agent。宿主如果没有忠实执行
Skill，JavaScript 层无法保证“三 Agent 隔离分析”真的发生。

## 2. 仓库不是普通应用，而是“规范 + 采集器 + 宿主壳”

根 [`package.json`](../../code/better-harness/package.json) 只声明两个运行依赖：
`@vscode/tree-sitter-wasm` 和 `esbuild-wasm`。大量功能由 Node 标准库、Git 命令和 Markdown
协议组成。

| 目录 | 职责 | 典型入口 |
|---|---|---|
| `skills/` | 用户工作流和 AI 编排协议 | [`skills/better-harness/SKILL.md`](../../code/better-harness/skills/better-harness/SKILL.md) |
| `models/` | Agent Work Loop、Harness Engineering 等判断模型 | [`models/agent-work-loop.md`](../../code/better-harness/models/agent-work-loop.md) |
| `references/` | Session、项目 Harness、Agent Customize、Loop Engineering 的解释规则 | [`references/README.md`](../../code/better-harness/references/README.md) |
| `scripts/` | 可执行采集、分析、验证、渲染和 CLI | [`scripts/better-harness.mjs`](../../code/better-harness/scripts/better-harness.mjs) |
| `hooks/` | Secret Guard、test mapping、blast radius、review trigger | [`hooks/hooks.json.template`](../../code/better-harness/hooks/hooks.json.template) |
| `templates/` | 报告结构、视觉风格和 Qoder Canvas 模板 | [`templates/reporting/routing.md`](../../code/better-harness/templates/reporting/routing.md) |
| `.qoder-plugin/` 等 | 薄宿主壳，只负责安装和发现元数据 | [`.codex-plugin/plugin.json`](../../code/better-harness/.codex-plugin/plugin.json) |
| `test/` | 契约、采集器、隐私、渲染、宿主适配的 Node tests | [`test/reporting/better-harness-evidence-bundle.test.mjs`](../../code/better-harness/test/reporting/better-harness-evidence-bundle.test.mjs) |

[`docs/ARCHITECTURE.md`](../../code/better-harness/docs/ARCHITECTURE.md) 明确规定：

- `scripts/<capability>/` 应是可复制、可执行、可测试的最小原子能力；
- 根 CLI 必须是薄 facade，不能拥有产品判断、schema 或宿主适配；
- 宿主壳不能拥有产品判断；
- AI 写的读者文案仍归 AI 所有，确定性代码只校验、持久化和投影；
- CLI 的机器模式必须保持 stdout 可解析，诊断写 stderr；
- 计划与写操作分离，外部可见或破坏性动作需要显式确认。

这解释了仓库为什么 Markdown 规范很多、JavaScript 模块也很多：它把“AI 应如何判断”和
“机器应如何守约”都当成一等源码。

## 3. 根 CLI：注册表驱动的薄分发器

根入口 [`scripts/better-harness.mjs`](../../code/better-harness/scripts/better-harness.mjs)
只做三件事：

1. 判断当前文件是否是进程入口；
2. 导出 `main()` 和 `resolveDispatch()` 供测试使用；
3. 把参数交给
   [`better-harness-cli/cli.mjs`](../../code/better-harness/scripts/better-harness-cli/cli.mjs)。

命令元数据集中在
[`better-harness-cli/registry.mjs`](../../code/better-harness/scripts/better-harness-cli/registry.mjs)。
每条命令声明：

- `kind`：直接命令或带子命令的 group；
- `audience`：`workflow`、`advanced` 或 `maintainer`；
- 实际脚本路径；
- 摘要、描述、别名和子命令。

`resolveDispatch()` 只解析帮助、版本、机器可读命令清单和脚本路由。真正执行时用：

```text
spawnSync(process.execPath, [dispatch.script, ...dispatch.args])
```

它没有拼 shell 字符串，因此参数边界天然适配 Windows、macOS 和 Linux。子命令退出码被原样
传回，机器模式通过统一 JSON envelope 返回成功或失败。

主要工作流命令是：

```text
better-harness report
better-harness harness evidence-bundle
better-harness harness analyze
better-harness harness render
```

其余 `session-analysis`、`agent-customize`、`agent-lint`、`core-change-watch` 等是能力所有者
或诊断入口，不应代替标准 bundle。

## 4. `/better-harness` Skill 才是产品级编排器

[`skills/better-harness/SKILL.md`](../../code/better-harness/skills/better-harness/SKILL.md)
规定五步工作流。

### 4.1 冻结范围并只采一次 Evidence Bundle

Skill 先确定：

- 绝对 target；
- provider 和 locale；
- 决策、验收边界和风险；
- `quick` 或 `normal` 深度；
- 7 天或 30 天窗口；
- 是否授权 user home、Memory 元数据和全局能力；
- inline、HTML、Markdown 或 Qoder Canvas 输出。

之后调用 `harness evidence-bundle`。单个诊断命令只允许用于定位某个明确 unavailable 或
truncated owner，不能把诊断输出偷偷替换成正式 bundle 数据。

### 4.2 三个分析 Agent 严格隔离

Skill 要求恰好三个 fresh、read-only Agent：

| Agent | 只允许接收 | 禁止接收 |
|---|---|---|
| Session Evidence | provider 标记的 privacy-safe facts、少量资产计数、scope | 原始 Session、项目源码结论、Agent Customize 结论 |
| Project Harness | target、Git/当前改动边界、project lane、风险 | Session 和 Agent Customize 结论 |
| Agent Customize | lint/inventory/integrity envelope、资产授权、风险 | Session 和 Project 结论 |

Specialist 只返回候选问题，不分配最终 severity 和 score。这样可以减少前一个分析结论对后一
证据域的锚定效应。

### 4.3 Lead AI 统一裁决

Lead 必须保留所有候选，再按“相同 target、后果、owner、repair route”去重。只有 Lead 能：

- 验证后果与原因链；
- 选择最小 owner；
- 确定证据边界和置信度；
- 分配最终 severity；
- 将 finding 绑定到一个 primary check；
- 独立评估五个维度；
- 编写最终 `findings.json`。

Finding 不能为了控制报告长度而被删除，也不能由 score、文件名、数量或资产存在性自动产生。

### 4.4 确定性 renderer 只投影已审查数据

Lead 完成语义判断后才调用 `harness render`。Qoder 默认生成 Canvas，其他宿主默认生成
自包含 HTML 和 Markdown。Renderer 成功的条件是校验状态为 `pass`，而不是文件已经写出。

### 4.5 修复与效果跟踪分离

finding-bound fix 可以在独立复核后更新 `verified`、`partial` 或 `blocked` 的 Repair
Progress，但当前报告的 severity 和五维 score 保持不变。长期效果必须等待以后可比较的
Task Episode。

## 5. Evidence Bundle：冻结上下文和失败语义

核心入口是
[`collectEvidenceBundle()`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/index.mjs)，
上下文契约在
[`contract.mjs`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/contract.mjs)。

`freezeEvidenceBundleContext()` 将以下字段一次性固定：

```text
workspace
provider ∈ qoder | codex | claude | cursor | qwen
language
depth ∈ quick | normal
window.since / window.until
evidenceLimit ∈ [1, 5]
authority.includeUserHome
authority.includeMemories
```

默认规则值得注意：

- `quick` 是 7 天、最多 3 条证据；
- `normal` 是 30 天、最多 5 条证据；
- Qoder 默认可读取当前项目的 Memory 标题元数据；
- 其他 provider 默认不读取 Memory 元数据；
- Memory body 始终不因这些 flag 自动获得授权。

四路采集并发执行：

```text
Promise.all(
  collectSessionEvidence(),
  collectProjectHarness(),
  collectAgentCustomize(),
  collectLead()
)
```

每个 lane 使用 `available | partial | unavailable` envelope。异常会被压缩成公开错误码和
“该 owner 不可用”的消息，避免把私有路径或底层内容泄露给报告。

失败策略是 fail closed：

- lead 不可用时，无论深度都 `failed`；
- `normal` 下任何 specialist lane 不完整都 `failed`；
- `quick` 下 specialist 不完整可以返回 `partial`，但必须降低置信度并显式展示缺口。

### 5.1 Session Evidence lane

[`session-evidence.mjs`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/session-evidence.mjs)
通过 provider analyzer 的生产级 `facts` 路由采集：

```text
selection = all-eligible
limit = evidenceLimit
episode-limit = evidenceLimit
since / until = frozen window
```

只接受 `kind === "session-core-facts"` 且存在 `candidates` 的结果。来源覆盖为
`unobserved` 或 `partial` 时，整个 lane 也变为 `partial`。

Session adapter 的目标不是交出完整 transcript，而是交出经过规范化和脱敏的任务、编辑、
检查、结果与遗漏边界。具体 provider 实现位于
[`scripts/session-analysis/platforms/qoder.mjs`](../../code/better-harness/scripts/session-analysis/platforms/qoder.mjs)
等同级模块。

### 5.2 Project Harness lane

[`project-harness.mjs`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/project-harness.mjs)
调用
[`buildEvidencePack()`](../../code/better-harness/scripts/core-change-watch/evidence-pack.mjs)，
顺序构建：

```text
project profile
      ↓
git history profile
      ↓
core candidates
      ↓
diff impact
      ↓
change drift
      ↓
recommended reads / follow-up actions / review matrix
```

它主要依据 `git ls-files`、本地 manifest/path 检查、有限 `git log` 和 `git diff`。证据包
明确把“测试通过”“CI 状态”“运行时行为”标成 `UNVERIFIED`，不会从静态结构推断运行结果。

### 5.3 Agent Customize lane

[`agent-customize.mjs`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/agent-customize.mjs)
调用
[`collectAssetBaseline()`](../../code/better-harness/scripts/coding-agent-practices/asset-baseline.mjs)。

它先采集一份共享 raw inventory snapshot，再并行执行：

- `agent-lint`：检查规则和 Agent 资产；
- public inventory：投影 Rules、Skills、MCP、Memory、Agents、Hooks、Commands、
  Workflows、Plugins；
- integrity review：在 public inventory 上检查重复、冲突和路由问题。

共享 snapshot 避免三个阶段在不同时间读到不一致的配置。输出会压缩文本、限制 finding 和
owner route 数量，并只保留 Memory 标题分类统计，不读取 body。

### 5.4 Lead analyzer

Lead lane 调用
[`analyzeHarnessEvidence()`](../../code/better-harness/scripts/harness-analysis/report-run.mjs)。
它通过
[`createTaskLoopSourceFromSessions()`](../../code/better-harness/scripts/harness-analysis/task-loop-source.mjs)
构造 `report.source`，校验后再生成：

- 最多约 6,000 token 的自然语言 evidence brief；
- 不允许 AI 改写的 `summaryFacts`；
- Qoder 明确授权时的 `canvas.json` 初始数据。

这个 lead 路径自身还会读取 Session、项目文件、敏感配置、Agent lint 和 practice
inventory。因此 Evidence Bundle 的三个 specialist lane 与 lead 并非简单共享同一内部对象；
它们保持不同 owner 契约，代价是部分采集工作可能重复。

## 6. `report.source`：事实层与判断层的分界线

[`task-loop-source.mjs`](../../code/better-harness/scripts/harness-analysis/task-loop-source.mjs)
是最重要也最复杂的桥接模块之一。主流程如下：

```text
选择 provider analyzer
  → 冻结 session inventory
  → stratified 或显式 selection plan 选样
  → 读取选中 session 并归一化事件
  → all-eligible usage census（标准报告）
  → 扫描受控范围内的敏感配置
  → 扫描仓库 Harness 资产
  → 采集 Agent lint / practice inventory
  → 读取之前的 Learning Capture ledger
  → 构造并校验 report.source
```

值得学习的边界有：

- 显式 selection profile 与 selection plan 必须成对出现；
- provider 与 selection profile 不一致时直接失败；
- 标准 usage census 必须覆盖 frozen eligible population，不能用样本统计冒充全量；
- 敏感配置只扫描 Git tracked、位于 workspace 内、非符号链接的普通文件；
- Secret Scan 有 2,000 文件上限、读取错误和 skip 统计，并对内容脱敏；
- 私有 episode/session identity 在公共结果中使用稳定 fingerprint，而不是原始 ID；
- `report.source` 先通过
  [`validateHarnessReportSource()`](../../code/better-harness/scripts/harness-analysis/report-source/source.mjs)
  才能进入报告阶段。

这层只负责提供证据候选、边界和可重复事实，不负责最终 finding。

## 7. Agent Work Loop：五维十五项检查

判断模型在
[`models/agent-work-loop.md`](../../code/better-harness/models/agent-work-loop.md)。

| 维度 | 三个稳定 check |
|---|---|
| Task Understanding | Intent and Acceptance、Relevant Context、Scope Boundary |
| Controlled Execution | Reproducible Startup、Supported Operation、Permission Boundary |
| Change Validation | Relevant Verification、Failure Diagnosis and Repair、Post-repair Revalidation |
| Reliable Delivery | Delivery Acceptance、High-risk Approval、Rollback or Recovery |
| Learning Capture | Lifecycle Opportunity Detection、Loop Engineering、Longitudinal Validation |

每个检查使用以下 evidence state：

```text
Present
  → Wired
    → Exercised
      → Outcome-supported

另有 Missing / Unobserved / Not applicable
```

状态不是简单 pass/fail：

- `Present` 只说明机制存在；
- `Wired` 说明任务或触发器能到达它；
- `Exercised` 说明某个关联 Episode 真正使用并留下结果；
- `Outcome-supported` 需要可比较的后续结果支持效果；
- 外部边界无法观察时是 `Unobserved`，不能偷换成 `Missing`。

前四维的证据等级给 score 设置上限，而不是直接套公式：

| 最高证据 | score ceiling |
|---|---:|
| Missing / Unobserved / Not applicable | 59 |
| Present | 74 |
| Wired | 84 |
| Exercised | 94 |
| Outcome-supported | 100 |

Learning Capture 有单独约束：完成受限审查后的整数范围为 35–100；当前任务只验证修复而没有
后续比较时，不能声称长期效果改善。

评分与 finding 是两条独立输出：

- 低分不会自动创建 finding；
- finding 数量不会推导 score；
- 一个 finding 必须有已检查 gap、明确影响、最小 owner-aligned repair 和验证路线；
- 同一问题只绑定一个 primary check，邻近维度可以通过引用表达关联。

## 8. 报告渲染：staging、验证和原子发布

[`renderReport()`](../../code/better-harness/scripts/harness-analysis/render-report.mjs)
只接受 `--source` 或 `--findings` 之一：

1. 读取并按需投影 `report.source`；
2. 对常见 schema drift 做确定性 repair；
3. 归一化 report data；
4. 分配或解析 run directory；
5. 在同级临时 staging directory 写全部 artifact；
6. 对 staging 内容运行选定 validator；
7. 只有未失败时才 rename 到正式 run directory；
8. 替换已有目录时先备份，发布失败则 rollback。

三种模式的 artifact 集是固定的：

| 模式 | 文件 |
|---|---|
| Qoder Canvas | `findings.json`、`canvas.json`、`report.canvas.tsx` |
| Markdown | `findings.json`、`report.md` |
| HTML | `findings.json`、`report.md`、`report.html` |

验证不仅检查 JSON schema，还检查：

- run directory 是否越过输出根；
- 是否混入额外文件；
- finding 与报告引用是否一致；
- Canvas 是否只使用允许的 import 和 SDK export；
- TSX 能否转换；
- HTML 是否自包含且结构完整；
- Markdown、HTML、Canvas 是否投影同一语义数据。

因此“报告写出”与“报告发布成功”是两个状态。

## 9. 多宿主适配

源码为 Qoder、Codex、Claude Code、Cursor、Qwen Code 提供 provider 模块。配置资产注册表见
[`scripts/agent-customize/providers/index.mjs`](../../code/better-harness/scripts/agent-customize/providers/index.mjs)，
Session adapter 可从
[`scripts/session-analysis/platforms/qoder.mjs`](../../code/better-harness/scripts/session-analysis/platforms/qoder.mjs)
等 provider 文件开始阅读。

宿主差异被限制在三处：

```text
薄安装/发现 shell
       +
配置资产 provider
       +
真实 Session evidence adapter
```

产品判断仍由同一 Skill、模型、reference、template 和 capability script 所有。npm 包会携带
多个宿主的 metadata root，但生成的 Qoder runtime bundle 仍只包含 `.qoder-plugin/`。

不能把“代码里有 provider”理解成“所有宿主能力完全对等”。当前
[`roadmap.md`](../../code/better-harness/roadmap.md) 仍列出 provider-aware checkup、
Codex mutation contract、Cursor/Claude 静态报告、真实宿主 smoke 等未完成项。与此同时，
[`docs/adapters/README.md`](../../code/better-harness/docs/adapters/README.md) 已描述更新后的
Claude/Cursor/Qwen adapter，二者存在更新节奏不一致；roadmap 自己也将“修复过时 adapter
文档和支持声明一致性测试”列为待办。阅读支持矩阵时应回到具体 provider、CLI 注册表和测试，
不能只信单个表格。

## 10. 扩展机制和设计模式

### 10.1 Registry + Command

CLI 命令通过集中 registry 声明，facade 只做分发。新增 capability 的标准路径是实现独立
`cli.mjs`，再注册脚本和 audience，而不是把逻辑塞入根命令。

### 10.2 Strategy / Adapter

Session 与 Agent Customize 都按 provider 选择 collector。公共 contract 不随宿主变化，
平台差异被隔离在 provider 文件。

### 10.3 Envelope + Pipeline

每个采集 owner 返回带 kind、schemaVersion、status 和 data/error 的 envelope。后续阶段只
消费公开 contract，不导入其他 capability 的 private helper。

### 10.4 Deterministic shell + AI semantic core

传统系统常把 AI 当作一个不透明的末端调用；Better Harness 反过来把 AI 判断放在中间：

```text
确定性采集 → AI 判断 → 确定性校验与投影
```

这使自然语言判断仍可演进，同时让路径、安全、schema 和 artifact 可测试。

### 10.5 Transactional publication

报告使用 staging、backup、rename 和 rollback 模拟小型文件事务。已有输出不会在半完成校验时
被直接覆盖。

### 10.6 Fail-closed evidence

来源不完整、provider 不匹配、normal lane partial、private boundary 未授权、输出目录逃逸、
SDK import 不存在等情况都倾向失败或显式 `Unobserved`，而不是猜测成功。

## 11. 安全与隐私边界

源码中最值得复用的安全原则有：

- user home、全局能力、Memory 元数据都需要独立授权；
- Memory title metadata 不等于 Memory body；
- 完整 Session 与公共 facts 分离；
- 原始 prompt、command、home path 不应进入公开报告；
- Secret Scan 的 workspace containment 在真正读文件时再次检查，防止符号链接或 TOCTOU
  越界；
- finding-bound fix 只能修改 finding 指定的 owner 和直接相关文件；
- renderer 拒绝相对 `run-dir` 逃逸 `--out`；
- 已存在输出的替换采用 backup + rollback；
- unsupported host mutation 应 fail closed，不能回退到另一个 provider 的执行器。

## 12. 测试与本地验证结果

仓库当前有 65 个 `*.test.mjs` 文件。测试覆盖 CLI 发现、provider inventory、Session
归一化、证据选择、隐私脱敏、Skill 契约、report source、findings、Canvas/HTML 渲染、
host manifest、Git hook 和跨平台路径。

本次运行：

```text
npm ci
npm test
```

环境：

```text
Node v22.14.0
npm 11.16.0
Windows
```

结果：

```text
866 tests
860 pass
3 fail
3 skipped
```

需要同时说明两个环境边界：

1. 项目要求 Node `>=22.20.0 <25.0.0`，当前 Node `22.14.0` 低于最低版本，`npm ci`
   给出 `EBADENGINE` 警告；
2. 三个失败均来自
   [`test/reporting/harness-report-render-cli.test.mjs`](../../code/better-harness/test/reporting/harness-report-render-cli.test.mjs)
   的 Qoder Canvas 校验。本机自动发现的
   `%USERPROFILE%\.qoder\canvas\sdk\index.d.ts` 不包含模板导入的 `AreaChart`、
   `CollapsibleSection` 和 `Dialog`，所以 runtime-boundaries fail。Markdown 和 HTML
   相关用例通过。

这次结果不能写成“测试通过”，但它也不是三个独立业务逻辑回归：三个用例共享同一个本机
Qoder SDK 声明不兼容原因。它同时暴露出测试/校验的环境敏感性：默认 SDK 自动发现会让本机
已安装 Qoder 版本影响 Canvas 测试结果。

仓库 CI 使用 Node 22.20.0 的 Windows、macOS、Linux 和 Node 24 的 Linux，并运行
`npm test` 与 `npm run pack:verify`，见
[`ci.yml`](../../code/better-harness/.github/workflows/ci.yml)。本次没有查询外部 CI 状态，
也没有运行真实宿主安装 smoke。

## 13. 限制、风险和未完成项

### 13.1 Skill 协议无法由 CLI 完全强制

三个 fresh Agent、不可交叉读取、候选不能丢弃、AI 必须先冻结评分再写 reader copy 等约束
存在于 `SKILL.md`。它们能被 Skill 测试检查文本形态，却不能证明任意宿主运行时一定按协议
执行。

### 13.2 Lead 与 specialist 采集有重叠

Evidence Bundle 一边采集三个 specialist lane，一边运行会自行构造 `report.source` 的
lead analyzer。这有利于 owner contract 独立，但对大型仓库或大量 Session 会增加 Git、
文件和会话读取成本。

### 13.3 Schema 和验证器规模较大

仓库约有 242 个 `scripts/hooks/test` 下的 `.mjs` 文件、约 9.2 万行；其中
`task-loop-report.mjs`、`validate-canvas.mjs`、Qoder/Codex session provider 都是大型模块。
虽然 contract 很严密，但理解和变更成本高，也容易出现多处 validator/renderer/template
同步问题。

[`docs/ARCHITECTURE.md`](../../code/better-harness/docs/ARCHITECTURE.md) 也明确将公共
`schemas/`、`agent-roles/`、`knowledge-base/` 标为目标目录或候选目录，尚未完成迁移。

### 13.4 宿主能力仍不对称

Qoder 的 Canvas、Memory 和 runtime 路径最完整。Codex、Cursor、Claude、Qwen 虽已有不同
程度的 collector 和 shell，但自动 mutation、真实 runtime smoke、session/model/hook
证据仍有 provider-specific 限制。不能从统一接口推断统一能力。

### 13.5 语义真实性仍依赖 AI

确定性 validator 可以发现缺字段、非法引用、越界路径和投影不一致，却不能证明 AI 对
“影响、原因、最小 owner、severity”作出了正确判断。三路隔离、evidence ref 和 finding
quality gate 是降低风险，不是消除模型误判。

### 13.6 文档存在短期漂移

最新提交已加入 Qwen 和更多 Claude/Cursor provider 能力，但 package version、changelog、
adapter matrix 和 roadmap 的描述并非完全同步。源码分析应记录具体 commit，并优先检查
注册表、provider 实现和测试。

## 14. 推荐阅读顺序

1. [`README.zh-CN.md`](../../code/better-harness/README.zh-CN.md)：先理解产品目标和五维循环。
2. [`skills/better-harness/SKILL.md`](../../code/better-harness/skills/better-harness/SKILL.md)：
   看完整产品工作流。
3. [`models/agent-work-loop.md`](../../code/better-harness/models/agent-work-loop.md)：
   理解 evidence state、finding 和 score 的边界。
4. [`scripts/better-harness-cli/registry.mjs`](../../code/better-harness/scripts/better-harness-cli/registry.mjs)：
   建立能力地图。
5. [`scripts/harness-analysis/evidence-bundle/index.mjs`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/index.mjs)：
   看三 lane 和 lead 如何组装。
6. 依次读
   [`session-evidence.mjs`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/session-evidence.mjs)、
   [`project-harness.mjs`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/project-harness.mjs)、
   [`agent-customize.mjs`](../../code/better-harness/scripts/harness-analysis/evidence-bundle/agent-customize.mjs)。
7. [`task-loop-source.mjs`](../../code/better-harness/scripts/harness-analysis/task-loop-source.mjs)：
   追 Session、静态仓库、Secret Scan 和 practice evidence 的汇合。
8. [`render-report.mjs`](../../code/better-harness/scripts/harness-analysis/render-report.mjs) 和
   [`validate-canvas.mjs`](../../code/better-harness/scripts/harness-analysis/validate-canvas.mjs)：
   看 artifact 如何守约并原子发布。
9. 最后按目标宿主阅读 `scripts/session-analysis/platforms/<provider>.mjs` 和
   `scripts/agent-customize/providers/<provider>.mjs`。

## 15. 可以借鉴什么

如果要为自己的 Coding Agent 设计 Harness，Better Harness 最值得借鉴的不是五个分数本身，
而是这些边界：

1. 先冻结观察范围，再采证据；
2. 静态配置、真实使用和长期效果必须是不同证据等级；
3. 让不同证据域独立分析，再由一个 owner 统一裁决；
4. AI 负责语义判断，程序负责格式、安全和可重复性；
5. 缺证据时写 `Unobserved`，不要把未知变成失败或成功；
6. 修复完成与效果改善必须跨窗口区分；
7. 报告也要像代码一样经过 staging、验证、原子发布和 rollback；
8. 每个 finding 都要绑定最小 owner、可见证据、预期产物和验收检查。

这套设计把“Agent 有没有写出代码”提升为“整个工程系统能否让 Agent 稳定地理解、执行、
验证、交付并学习”，正是 Better Harness 的核心价值。
