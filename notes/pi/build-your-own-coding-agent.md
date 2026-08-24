# 基于 pi 构建自有 Coding Agent：架构与实施方案

> 研究源码：`code/pi`
>
> 原始研究版本：`97f0ccdd96cc207b6ad3630c56eea4d32dbdcf53`
>
> 2026-08-19 增量复核版本：`ed867e90947910c907d7d4b9d1b7a8586448f648`（`@earendil-works/pi-* 0.84.2`）
>
> 2026-08-24 增量复核版本：`4af9d21d3b4d664e4a29fcabfec85171077248e3`
>
> 目标：在复用 pi 的模型适配、Agent Loop、工具协议、会话和扩展体系的基础上，构建一个
> 可以独立命名、独立发布、拥有自有安全策略和产品体验的 Coding Agent。

## 1. 先给结论

推荐采用“**SDK 嵌入优先、扩展实现策略、自有产品层封装、内核补丁最后考虑**”的路线：

本轮复核后，这个建议仍成立，但发行方案可以少承担一项宿主前置条件：官方 bundle 已能携带 Node runtime，并通过 managed installation state 支持原地升级。自有产品若复用该分发形态，仍需自行决定签名、更新源、回滚和企业代理策略，不能把“自带 Node”误解为完整发布系统。实现与分发测试见 [`build-coding-agent-bundle.mjs`](../../code/pi/scripts/build-coding-agent-bundle.mjs) 和 [`package-distribution.test.ts`](../../code/pi/packages/coding-agent/test/package-distribution.test.ts)。

```text
┌────────────────────── 自有 Coding Agent ──────────────────────┐
│ CLI / TUI / IDE / Server                                      │
│ 产品配置、账号、权限、审计、工作流、品牌与发布                 │
│ 自有 Extension、Tool、Skill、Prompt、项目规则                  │
├────────────────────── pi-coding-agent SDK ────────────────────┤
│ AgentSessionRuntime / AgentSession / SessionManager            │
│ ResourceLoader / ModelRuntime / ExtensionRunner                │
│ read / bash / edit / write / grep / find / ls                  │
├────────────────────── pi-agent-core / pi-ai ──────────────────┤
│ Agent Loop / tool execution / queues / unified model streams   │
├────────────────────── Provider / OS ───────────────────────────┤
│ OpenAI / Anthropic / Google / Bedrock / local model            │
│ filesystem / shell / git / sandbox                             │
└─────────────────────────────────────────────────────────────────┘
```

不要从复制 `packages/coding-agent/src` 开始。当前公开 SDK 已经提供
[`createAgentSession()`](../../code/pi/packages/coding-agent/src/core/sdk.ts)、
[`createAgentSessionRuntime()`](../../code/pi/packages/coding-agent/src/core/agent-session-runtime.ts)、
工具工厂、Extension API、Session 管理和模型运行时。直接复制内核会让后续 Provider、消息格式、
流事件和会话格式升级全部变成自己的维护责任。

建议的产品化边界是：

| 层 | 直接复用 | 自己实现 |
|---|---|---|
| 模型协议 | `pi-ai` 的模型目录、认证和统一流 | 模型白名单、企业网关、成本策略 |
| Agent Loop | `pi-agent-core` | 不修改；只通过公开配置和事件使用 |
| Coding Runtime | `AgentSessionRuntime`、`AgentSession` | 生命周期封装、并发准入、租户/工作区边界 |
| 工具 | pi 工具工厂和 Tool Definition | 权限、沙箱、审计、领域工具 |
| 上下文 | `ResourceLoader`、Skill、项目规则 | 自有 system prompt、规则优先级和敏感信息过滤 |
| 会话 | `SessionManager`、JSONL 会话树 | 索引、加密、保留策略、服务端存储 |
| 交互 | SDK 事件流；必要时复用 `pi-tui` | 自有 CLI/TUI/IDE/Web UI |
| 扩展 | Extension API | 自有扩展包和可信发布机制 |

## 2. 先确定产品范围

在写代码前先冻结第一版边界。建议第一版只解决单工作区、单活跃会话、一个主 Agent 的代码任务：

- 在指定仓库内读取、搜索、编辑文件；
- 运行受控命令和测试；
- 支持流式输出、取消、steer 和 follow-up；
- 保存并恢复会话；
- 所有高风险工具经过确定性策略；
- 支持 OpenAI 或 Anthropic 中至少一个 Provider；
- 提供非交互 `run` 和交互式 `chat` 两种入口；
- 输出工具调用、修改文件、命令、Token 和费用审计事件。

第一版不建议同时实现：

- 多 Agent 自动编排；
- 云端多租户托管；
- IDE、Web、桌面和 TUI 四套 UI；
- 自己的模型协议适配层；
- 崩溃后从工具调用中点 exactly-once 恢复；
- 自动执行任意网络、部署或生产环境操作。

这些能力会改变运行时、权限和持久化模型，应在单 Agent 主链稳定后分别设计。

## 3. 为什么选择 SDK 嵌入而不是直接 Fork

### 3.1 三种路线

| 路线 | 适用场景 | 优点 | 主要代价 |
|---|---|---|---|
| 配置 + Extension | 快速做团队内部 Agent | 开发最快，几乎不维护内核 | 产品入口和部分行为仍像 pi |
| SDK 嵌入 | 独立产品、独立 CLI/服务 | 自有边界清楚，仍能跟随上游 | 需要自己实现宿主生命周期和 UI |
| Fork pi | 必须改变 Loop、消息或会话协议 | 控制力最高 | 长期合并上游、Provider 和格式迁移成本最高 |

本方案选择第二种，并允许第一种作为原型阶段。只有以下情况才考虑 Fork：

1. 公开 Hook 无法实现必须的调用前后事务；
2. 必须改变 Tool Call 的批处理或顺序语义；
3. 必须替换会话存储协议且公开 Session 接口无法承载；
4. 必须提供当前 Agent Loop 没有的 durable resume 语义；
5. 已经准备长期维护 `pi-ai`、`pi-agent-core` 和 `pi-coding-agent` 的同步升级。

### 3.2 依赖必须固定版本

源码仓库内部包使用同步版本发布，但 `pi-coding-agent` 的依赖声明允许兼容升级。自有产品应在
`package.json` 和锁文件中固定经过验证的精确版本，不要在生产构建时漂移：

```json
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.83.0",
    "@earendil-works/pi-ai": "0.83.0",
    "typebox": "1.3.7"
  },
  "engines": {
    "node": ">=22.19.0"
  }
}
```

Node 版本要求来自 pi 根目录和 coding-agent 的
[`package.json`](../../code/pi/packages/coding-agent/package.json)。每次升级都应作为一次运行时升级，
而不是普通依赖刷新。

## 4. 建议的代码仓库结构

```text
my-coding-agent/
├── package.json
├── package-lock.json
├── tsconfig.json
├── src/
│   ├── cli.ts                    # 参数解析和命令分发
│   ├── app.ts                    # 组合应用，不放业务细节
│   ├── runtime/
│   │   ├── create-runtime.ts     # 构造 AgentSessionRuntime
│   │   ├── session-controller.ts # 单会话准入、取消、替换和释放
│   │   ├── event-projector.ts    # pi 事件投影为产品事件
│   │   └── types.ts
│   ├── model/
│   │   ├── policy.ts             # Provider/模型/费用/能力白名单
│   │   └── credentials.ts        # 凭据来源，不写入会话
│   ├── context/
│   │   ├── system-prompt.ts
│   │   ├── project-rules.ts
│   │   └── redaction.ts
│   ├── tools/
│   │   ├── registry.ts
│   │   ├── policy.ts
│   │   ├── sandbox.ts
│   │   └── domain/               # issue、CI、代码搜索等领域工具
│   ├── extensions/
│   │   ├── permission.ts
│   │   ├── protected-paths.ts
│   │   ├── audit.ts
│   │   └── git-checkpoint.ts
│   ├── session/
│   │   ├── store.ts
│   │   ├── index.ts
│   │   └── retention.ts
│   ├── modes/
│   │   ├── print.ts
│   │   ├── interactive.ts
│   │   └── rpc.ts
│   └── telemetry/
│       ├── events.ts
│       └── metrics.ts
├── resources/
│   ├── skills/
│   ├── prompts/
│   └── default-rules.md
└── test/
    ├── faux-provider.ts
    ├── tool-policy.test.ts
    ├── session-runtime.test.ts
    └── e2e/
```

关键原则是让 pi 类型只出现在 `runtime/`、`tools/` 和适配层。UI 和业务代码使用自己的
`ProductEvent`、`ProductSession`、`PermissionDecision`，避免整个产品绑定上游内部类型。

## 5. Runtime 的正确装配方式

### 5.1 原型阶段：`createAgentSession()`

最短路径使用
[`createAgentSession()`](../../code/pi/packages/coding-agent/src/core/sdk.ts)：

```ts
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create({
  authPath: process.env.MY_AGENT_AUTH_FILE,
  modelsPath: process.env.MY_AGENT_MODELS_FILE,
});

const { session } = await createAgentSession({
  cwd: process.cwd(),
  modelRuntime,
  sessionManager: SessionManager.create(process.cwd()),
  tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
});

const unsubscribe = session.subscribe(projectEvent);
try {
  await session.prompt("分析失败测试并修复");
} finally {
  unsubscribe();
  session.dispose();
}
```

这适合验证模型、工具和事件流，但不适合作为最终宿主，因为新建、恢复、fork 或 import 会替换
`AgentSession` 实例。

### 5.2 产品阶段：`AgentSessionRuntime`

正式产品应使用
[`AgentSessionRuntime`](../../code/pi/packages/coding-agent/src/core/agent-session-runtime.ts)。它负责：

- `newSession()`；
- `switchSession()`；
- `fork()` 和 clone；
- 导入 JSONL；
- 切换前 abort 当前响应并等待落盘；
- 发送 `session_shutdown`；
- 销毁旧 Session 并重建与新 cwd 绑定的服务。

建议自己的 `SessionController` 只暴露：

```ts
interface SessionController {
  prompt(input: PromptInput): Promise<RunResult>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<SessionInfo>;
  resume(sessionId: string): Promise<SessionInfo>;
  close(): Promise<void>;
}
```

每次 Session 替换后必须重新绑定事件订阅和宿主 UI。pi 的 SDK 文档和实现都明确表明订阅属于
具体 `AgentSession`，不能在替换后继续使用旧引用。

### 5.3 并发合同

一条 Session 只允许一个活跃 `prompt()`。运行中输入必须显式选择：

- `steer`：在当前运行的下一个安全 Provider 边界纠偏；
- `followUp`：当前任务原本准备结束后继续；
- `abort`：请求取消并等待 Agent 收口。

不要把多个 HTTP 请求直接并发调用同一个 Session。服务端至少维护：

```text
(tenant, workspace, session) → single-flight controller
```

第二个普通 prompt 应返回冲突、进入产品队列，或显式映射成 steer/follow-up，不能静默改变语义。

## 6. 模型层方案

### 6.1 复用 `ModelRuntime`

[`ModelRuntime`](../../code/pi/packages/coding-agent/src/core/model-runtime.ts) 是产品应使用的模型和认证
边界。不要绕过它在业务代码里直接实例化各家 SDK，否则会重复处理：

- Provider 与 wire API 的映射；
- streaming text、thinking 和 Tool Call；
- usage、cost、stop reason；
- reasoning/thinking level；
- 模型能力与上下文窗口；
- 跨 Provider 历史兼容。

具体协议差异见[大模型 API 差异适配](./model-api-adaptation.md)。

### 6.2 自己必须补的模型策略

pi 解决“能调用什么”，产品还要解决“允许调用什么”：

| 策略 | 建议 |
|---|---|
| 模型白名单 | 只暴露验证过 Tool Calling 和上下文行为的模型 |
| 默认模型 | 按任务类型和组织配置选择，不依赖 catalog 的第一个模型 |
| 能力门控 | 图片、thinking、工具并行、超长上下文分别检查 |
| 费用上限 | 每轮、每会话、每天三层预算 |
| 超时 | Provider 建连、首 Token、总响应分别设置 |
| Fallback | 只在请求尚未产生可见或可执行输出时切换 |
| 凭据 | 环境、密钥服务或用户 OAuth；绝不写入 Session 与日志 |

模型切换不能只替换字符串。需要通过 `ModelRuntime` 取得完整 `Model`，并让 pi 对 thinking level
做能力钳制。

## 7. System Prompt、项目规则与 Skill

### 7.1 Prompt 分层

建议按不可变性从高到低组织：

```text
产品安全与身份（宿主固定）
  → 工具能力和限制（按本轮活动工具生成）
  → 组织规则（管理员配置）
  → 项目规则（仓库内可信文件）
  → Skill 摘要（按需加载）
  → 会话历史
  → 当前用户任务
```

pi 的
[`buildSystemPrompt()`](../../code/pi/packages/coding-agent/src/core/system-prompt.ts) 已支持：

- 完全替换默认 prompt；
- 追加 prompt；
- 按活动工具生成工具说明；
- 注入项目 context files；
- 在有 `read` 工具时注入 Skill 索引；
- 固定附加当前工作目录。

第一版优先使用追加和 ResourceLoader，不要复制整个默认 prompt。完全替换意味着 pi 后续工具说明
变化不会自动进入产品，必须自己维护 prompt 与工具的一致性。

### 7.2 规则不是权限系统

`AGENTS.md`、Skill 和 system prompt 只能影响模型行为，不能作为安全边界。以下约束必须在工具
执行前由程序检查：

- 工作区根目录；
- 禁止写入路径；
- 命令和参数；
- 网络访问；
- 环境变量；
- 用户确认；
- 超时、输出量和进程树；
- 是否允许发布、部署、提交和推送。

### 7.3 防止 Prompt Injection

把读取到的 README、Issue、网页和代码注释视为不可信数据：

1. 不允许文档改变宿主权限；
2. 不把密钥放进模型可见环境；
3. 工具结果标注来源；
4. 外部内容与系统规则分区；
5. 高风险动作只依据确定性策略和用户批准；
6. 对上传、网页和依赖脚本设置单独的信任级别。

## 8. 工具体系

### 8.1 起步工具集

pi 的工具工厂位于
[`tools/index.ts`](../../code/pi/packages/coding-agent/src/core/tools/index.ts)：

| 工具 | 用途 | 第一版策略 |
|---|---|---|
| `read` | 读取文件和图片 | 允许工作区内读取，敏感文件拒绝或脱敏 |
| `grep` | 内容搜索 | 默认允许，只在工作区内 |
| `find` | 文件名搜索 | 默认允许，限制结果数量 |
| `ls` | 目录浏览 | 默认允许，禁止逃逸工作区 |
| `bash` | 命令执行 | 默认需策略判定；高风险需批准 |
| `edit` | 精确编辑 | 允许工作区内，记录 diff |
| `write` | 创建/覆盖文件 | 允许工作区内，覆盖已有文件提高风险级别 |

建议显式传 `tools` 白名单，不依赖默认值。`createAgentSession()` 的默认内置工具只有
`read/bash/edit/write`，而 `grep/find/ls` 需要显式启用。

### 8.2 自定义 Tool 的合同

每个领域工具都应满足：

- 名称短、稳定且不可与内置工具冲突；
- description 写清使用条件和禁止条件；
- TypeBox Schema 尽量收紧字段、枚举和长度；
- 执行前再次做运行时校验；
- 接受 `AbortSignal`；
- 长任务通过 `onUpdate` 报告进度；
- 结果区分给模型看的内容和产品内部 details；
- 错误返回可操作信息，但不泄露密钥、完整环境或内部栈；
- 副作用操作携带幂等键或可审计 operation id。

工具注册可直接使用 `customTools`，也可在 Extension 中调用 `registerTool()`。稳定的核心工具建议在
Runtime 装配时注册；可选集成和项目插件建议作为 Extension。

### 8.3 文件修改串行化

pi 暴露了
[`withFileMutationQueue`](../../code/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts)。当模型
并行调用多个写工具时，应确保针对同一工作区的文件变更不会相互覆盖。除了工具级队列，产品还应：

- 保存操作前文件摘要；
- 修改后重新读取或计算 diff；
- 检测用户/IDE 并发修改；
- 冲突时拒绝覆盖并要求模型重新读取；
- 将工具结果按原 Tool Call 顺序写回模型历史。

## 9. 权限、沙箱和审批

### 9.1 不要只复制正则示例

pi 的
[`permission-gate.ts`](../../code/pi/packages/coding-agent/examples/extensions/permission-gate.ts) 和
[`protected-paths.ts`](../../code/pi/packages/coding-agent/examples/extensions/protected-paths.ts) 展示了
`tool_call` Hook 的阻断方式，但它们是示例，不是完整安全实现：

- Bash 正则可以被 shell 语法、脚本文件、别名和间接执行绕过；
- `path.includes()` 不能防止 `..`、符号链接和大小写差异；
- 只检查 `write/edit` 无法阻止 Bash 修改文件；
- 用户批准某个字符串不等于批准其派生进程的所有行为。

### 9.2 建议的决策模型

```ts
type PermissionDecision =
  | { action: "allow"; reason: string }
  | { action: "deny"; reason: string }
  | { action: "ask"; reason: string; scope: ApprovalScope };
```

按副作用而不是按工具名分类：

| 风险级别 | 示例 | 默认行为 |
|---|---|---|
| 只读 | 工作区内读取、搜索、`git status` | 自动允许 |
| 局部可恢复 | 修改普通源码、运行单元测试 | 允许并记录；可配置批准 |
| 高影响 | 删除、覆盖配置、安装依赖、改 Git 索引 | 每次或规则化批准 |
| 外部副作用 | 网络写、Issue/PR、部署、推送 | 默认拒绝，显式授权 |
| 凭据/系统 | 密钥、sudo、宿主全局配置 | 默认拒绝 |

无 UI 模式必须 fail closed：需要询问时直接拒绝，而不是自动批准。

### 9.3 沙箱层级

按部署场景选择：

1. 本地个人模式：进程继承用户权限，依赖审批与路径策略；
2. 团队桌面模式：为 Bash 清理环境、限制 cwd、网络和资源；
3. 服务端模式：每个任务进入独立容器或 microVM，工作区只挂载必要目录；
4. 不可信仓库：禁用安装脚本和网络，运行测试也视为执行不可信代码。

工具 Hook 是策略层，OS/容器沙箱才是强制执行层，两者都需要。

## 10. Session、恢复和代码状态

### 10.1 当前可复用能力

[`SessionManager`](../../code/pi/packages/coding-agent/src/core/session-manager.ts) 使用追加式 Session 数据
构建当前分支上下文，支持会话树、导航、fork、compaction 和模型/思考级别等状态记录。
`AgentSessionRuntime` 在替换 Session 前先 abort 并等待当前响应收口，避免旧 Session 在后台继续写入。

### 10.2 Session 不等于工作区快照

会话恢复只能恢复对话和运行时配置，不能自动恢复文件系统、Git 索引、数据库或远端服务。pi 的
[`git-checkpoint.ts`](../../code/pi/packages/coding-agent/examples/extensions/git-checkpoint.ts) 只是演示如何
把 Git stash 引用与会话节点关联，而且 checkpoint Map 本身只在内存中，`agent_end` 后会清空，不能
直接作为生产恢复方案。

自有产品应明确采用哪一种代码状态策略：

| 策略 | 优点 | 风险/代价 |
|---|---|---|
| 不管理代码状态 | 最简单，不碰用户 Git | 会话分支与文件状态可能不一致 |
| Git commit/checkpoint ref | 可审计、恢复清楚 | 污染仓库或需要隐藏 refs |
| Git stash | 实现快 | 与用户 stash、未跟踪文件和冲突交互复杂 |
| 文件快照/CAS | 不依赖 Git | 存储和恢复实现成本高 |
| 临时 worktree | 隔离好 | 生命周期和大仓库成本较高 |

建议第一版采用“运行前记录 `HEAD + status + diff hash`，不自动回滚”；需要可靠分支实验时再引入
独立 worktree。

### 10.3 Durable Harness 的现状

当前仓库用 [`harness.md`](../../code/pi/packages/agent/docs/harness.md) 定义 durable operation、lane、
checkpoint、Retry、Compaction 和恢复的实现规格；Session/Storage、record、reducer、工具等底座
已经落地。但 [`AgentHarness`](../../code/pi/packages/agent/src/harness/agent-harness.ts) 仍是 scaffold：
`prompt()`、`resume()`、`compact()`、Hook 和 lane API 都会抛 `HarnessNotImplemented`。

`pi-coding-agent` server 已有
[`create-harness.ts`](../../code/pi/packages/coding-agent/src/server/create-harness.ts) 组装工具与 system
prompt，但返回的仍是这个 scaffold。默认 CLI/TUI SDK 继续使用 `AgentSession`。因此自有产品
当前不能把新 Harness 当成可运行依赖，只能复用稳定产品路径，或把 storage/reducer 作为实验性
底座；更不能宣称任意崩溃点恢复或工具副作用 exactly-once。

因此第一版恢复语义应保守定义为：

> 进程正常退出或已完成落盘的消息可以恢复；中断中的 Provider 请求和工具副作用不保证自动续跑，
> 重启后由用户或上层调度器决定重新提示、检查状态或放弃。

## 11. Compaction 与上下文预算

长会话不能只依赖模型最大上下文。产品需要同时维护：

- system prompt 固定预算；
- 项目规则预算；
- Skill 索引预算；
- 最近消息预算；
- Tool Result 输出限制；
- compaction 触发阈值；
- 为模型输出和下一轮工具结果预留空间。

工具层先截断巨量输出，比事后让模型总结更可靠。日志、测试和搜索工具建议返回：

```text
摘要 + 首尾关键片段 + 总行数/字节数 + 完整输出制品路径
```

Compaction 摘要必须保留：用户目标、验收条件、已修改文件、关键决策、失败尝试、未完成事项和
安全限制。不要假设摘要能无损保存较早的 Tool Call/Result 细节。

## 12. Extension 体系如何使用

适合用 Extension 实现：

- 工具审批和阻断；
- 审计事件；
- 项目规则加载；
- 自定义 Tool 和 Command；
- Git checkpoint；
- prompt/context 变换；
- compaction 定制；
- TUI 小组件；
- 可选 Provider 和企业集成。

不适合用 Extension 承担：

- 多租户身份隔离；
- 强制 OS 沙箱；
- Session 单写者锁；
- 密钥托管；
- 全局预算结算；
- 宿主进程健康和任务队列。

Extension 是进程内可信代码，拥有与 Agent 相同的系统权限。自动发现项目本地 Extension 前必须做
项目信任确认；服务端不要直接加载用户仓库中的任意 TypeScript Extension。

扩展能力和生命周期详见
[`extensions.md`](../../code/pi/packages/coding-agent/docs/extensions.md)。

## 13. 产品事件与可观测性

### 13.1 建立自己的事件协议

把 pi 事件投影成稳定的产品事件：

```ts
type ProductEvent =
  | { type: "run.started"; runId: string; sessionId: string }
  | { type: "message.delta"; messageId: string; text: string }
  | { type: "tool.requested"; callId: string; name: string; inputSummary: unknown }
  | { type: "tool.approval_required"; callId: string; risk: string }
  | { type: "tool.completed"; callId: string; durationMs: number; outcome: string }
  | { type: "usage.updated"; inputTokens: number; outputTokens: number; cost: number }
  | { type: "run.completed"; runId: string; outcome: string };
```

不要把 Provider 原始 payload、完整环境变量或未脱敏工具参数默认写入日志。

### 13.2 最低指标集

- run 成功、失败、取消和超时数；
- 首 Token 延迟、Provider 总耗时；
- 每轮和每会话 Token/费用；
- Tool Call 次数、耗时、错误率和拒绝率；
- compaction 次数和前后 Token；
- 用户批准/拒绝分布；
- 修改文件数和 diff 规模；
- 重试、模型 fallback 和上下文溢出；
- 活跃 Session 和排队时长。

审计日志使用稳定的 session/run/tool-call ID 串联，但内容日志与指标分开保留。

## 14. CLI、TUI、RPC 和 IDE 的演进顺序

建议按以下顺序：

1. **Print mode**：输入一个 prompt，输出流和最终状态；最容易自动测试。
2. **Interactive CLI**：增加 steer、follow-up、abort、approval 和 session resume。
3. **RPC/Server**：把产品事件序列化，建立单 Session 单写者和连接重建。
4. **IDE 插件**：IDE 只做客户端，Runtime 放在独立本地进程，避免 Extension Host 崩溃丢 Session。
5. **自有 TUI/Web**：在事件协议稳定后实现，不直接耦合 pi 内部事件。

如果 UI 目标与 pi 接近，可先复用 `pi-tui`；如果要做 IDE/桌面/Web，多花一层事件投影的成本是
值得的。

## 15. 测试策略

### 15.1 不用真实模型验证主链

建立 Faux Provider，用预设事件驱动：

- 纯文本结束；
- 单个和多个 Tool Call；
- 流式 Tool Call 参数；
- Provider 错误、超时和取消；
- 输出长度截断；
- Tool Call 后继续下一轮；
- steer 与 follow-up；
- compaction；
- Session 替换与恢复。

pi 自己要求 coding-agent 测试使用 faux provider，测试布局可参考
[`packages/coding-agent/test`](../../code/pi/packages/coding-agent/test)。

### 15.2 权限测试优先级最高

至少覆盖：

- `../` 路径逃逸；
- 绝对路径；
- 符号链接逃逸；
- Bash 通过脚本、解释器和子 shell 间接写文件；
- 无 UI 时 ask 是否拒绝；
- 批量 Tool Call 中一个被拒绝后的语义；
- abort 时子进程是否终止；
- 输出截断后是否仍泄漏敏感尾部；
- 用户批准是否被错误复用到不同参数；
- Session 恢复后是否沿用过期授权。

### 15.3 分层测试

| 层级 | 内容 |
|---|---|
| 单元 | 路径、命令、风险分类、脱敏、事件投影 |
| 合同 | 自定义 Tool、Provider 和 Session Adapter |
| 集成 | Faux Provider → Tool → Session → 下一 Provider Turn |
| 故障注入 | Provider 断流、工具超时、磁盘写失败、进程取消 |
| E2E | 临时 Git 仓库内完成小型修复并运行测试 |
| 真实模型 smoke | 少量固定任务，只验证受支持模型，不作为主要回归套件 |

## 16. 分阶段实施路线

### Phase 0：技术验证，约 2～3 天

交付：一个非交互 CLI。

1. 固定 pi 依赖版本；
2. 使用 `createAgentSession()` 和内存 Session；
3. 只启用 `read/grep/find/ls`；
4. 接一个模型；
5. 输出文本 delta、Tool Call 和 usage；
6. Faux Provider 跑通 text 和 tool 两条路径。

退出标准：没有写权限时，Agent 能稳定分析一个仓库并给出带文件路径的回答。

### Phase 1：本地可用 Coding Agent，约 1～2 周

交付：可读写、可恢复的本地 CLI。

1. 引入 `edit/write/bash`；
2. 实现规范化路径和 protected path；
3. Bash 风险分类、批准和无 UI fail-closed；
4. 使用持久 `SessionManager`；
5. 支持 abort、steer、follow-up；
6. 记录 diff、命令、费用和结果；
7. 完成临时 Git 仓库 E2E。

退出标准：能完成“定位 bug → 修改 → 运行相关测试 → 总结 diff”，并且所有副作用可审计。

### Phase 2：独立产品 Runtime，约 2～4 周

交付：自有 CLI/TUI 和稳定事件协议。

1. 切换到 `AgentSessionRuntime`；
2. 实现 `SessionController` 和事件投影；
3. 自有 system prompt、规则和 Skill；
4. 模型白名单、预算和 Provider 超时；
5. Session 新建、恢复、fork 和保留策略；
6. Extension 可信来源和加载策略；
7. 升级兼容测试。

退出标准：UI 不依赖 pi 内部事件类型，切换 Session 后无旧订阅、旧工具或旧 cwd 泄漏。

### Phase 3：团队/服务化，约 1～2 个月

交付：可由 IDE 或 Web 调用的本地/远程 Agent 服务。

1. RPC 协议和重连快照；
2. 每 Session 单写者和任务准入；
3. 容器/worktree 隔离；
4. 密钥服务和租户隔离；
5. 审计、指标、限额和数据保留；
6. 崩溃后的保守恢复工作流；
7. 逐步增加 CI、Issue、代码搜索等领域工具。

退出标准：任务、会话、工作区、凭据和事件都具有明确租户边界，进程崩溃不会造成静默重复副作用。

### Phase 4：高级 Agent 能力

按真实需求选择：

- plan/review 模式；
- 只读审查 Agent；
- 子 Agent；
- 后台长任务；
- durable run；
- 自动评测和模型路由。

不要直接把
[`subagent`](../../code/pi/packages/coding-agent/examples/extensions/subagent) 示例当生产调度器。多 Agent
会引入预算、权限继承、工作区并发、结果聚合和取消传播，需要独立设计。

## 17. 升级和上游协作策略

### 17.1 建立 Upstream Adapter

集中封装所有 pi API：

```text
src/runtime/pi-adapter.ts
src/runtime/pi-event-adapter.ts
src/tools/pi-tool-adapter.ts
```

升级时先编译 Adapter 和合同测试，再运行产品测试。不要在几十个业务文件里直接访问
`session.agent.state`；这类低层入口虽然公开可见，但会扩大升级面。

### 17.2 升级检查表

每次 pi 升级检查：

1. Node engine 和包版本；
2. Session 格式与恢复；
3. Agent/Session 事件顺序；
4. Tool Definition 和 TypeBox；
5. Provider/模型 catalog；
6. thinking level 和 stop reason；
7. compaction；
8. Extension Hook 顺序；
9. CLI/TUI 复用 API；
10. durable harness 是否从设计稿进入产品主链。

如果发现内核缺口，优先向上游贡献小而通用的扩展点；自有 Fork 只保留短小、可重放的补丁队列。

## 18. 关键风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 把 Prompt 当权限 | 模型被注入后执行危险操作 | Tool Hook + OS 沙箱 + 审批 |
| 直接 Fork | 上游升级成本持续增长 | SDK 嵌入，补丁最小化 |
| Session 与文件状态混淆 | 恢复后代码和对话不一致 | 记录 Git 状态，必要时 worktree |
| 并发 prompt | 历史和工具结果交错 | 单 Session single-flight |
| Extension 不可信 | 任意本地代码执行 | 签名/白名单/项目信任，不加载用户代码 |
| Provider 差异 | Tool Call 或 thinking 历史失效 | 复用 `pi-ai`，模型合同测试 |
| 工具输出过大 | 上下文爆炸和费用失控 | 工具端截断、制品存储、预算 |
| 中断时副作用不明 | 重试造成重复修改或外部操作 | 幂等键、状态检查、保守恢复 |
| 过早多 Agent | 权限、预算和并发失控 | 主 Agent 稳定后再引入 |
| 依赖自动升级 | 运行时行为漂移 | 精确版本、锁文件、升级门禁 |

## 19. 推荐的第一版验收场景

用 10～20 个固定小仓库任务建立回归集：

1. 解释一个调用链，不修改文件；
2. 修复一个有明确失败测试的 bug；
3. 新增一个小功能和测试；
4. 遇到不明确需求时停止并提问；
5. 发现工作区有用户修改时保留它们；
6. 拒绝修改 `.env` 和 `.git`；
7. 无 UI 模式拒绝高风险命令；
8. 用户取消后终止 Provider 和子进程；
9. 长测试输出被截断但保留关键错误；
10. Session 恢复后能说明已完成和未完成工作；
11. Provider 中途断流不会执行不完整 Tool Call；
12. 模型费用达到预算后停止新一轮请求。

验收不只看最终答案，还要检查：工具选择、修改范围、命令、审批、事件、Session、Token、费用和
失败后的仓库状态。

## 20. 推荐阅读与落地顺序

1. [`packages/coding-agent/docs/sdk.md`](../../code/pi/packages/coding-agent/docs/sdk.md)：确定宿主 API；
2. [`core/sdk.ts`](../../code/pi/packages/coding-agent/src/core/sdk.ts)：理解默认对象图和工具选择；
3. [`agent-session-runtime.ts`](../../code/pi/packages/coding-agent/src/core/agent-session-runtime.ts)：理解 Session 替换；
4. [`agent-session.ts`](../../code/pi/packages/coding-agent/src/core/agent-session.ts)：理解产品会话主链；
5. [`agent-loop.ts`](../../code/pi/packages/agent/src/agent-loop.ts)：理解 LLM/Tool 循环；
6. [`tools`](../../code/pi/packages/coding-agent/src/core/tools)：审计所有副作用入口；
7. [`extensions.md`](../../code/pi/packages/coding-agent/docs/extensions.md)：实现策略和领域扩展；
8. [`session-manager.ts`](../../code/pi/packages/coding-agent/src/core/session-manager.ts)：定义恢复边界；
9. [`system-prompt.ts`](../../code/pi/packages/coding-agent/src/core/system-prompt.ts)：设计 Prompt 分层；
10. [`harness.md`](../../code/pi/packages/agent/docs/harness.md)：对照目标 durable runtime 的状态机、效果边界和恢复契约，并用 `agent-harness-scaffold.test.ts` 核对当前完成度。

最终落地原则可以压缩成一句话：

> 让 pi 负责模型和 Agent 执行语义，让自有产品负责权限、隔离、生命周期、审计和用户体验；
> 先构建一个安全、可测、单 Agent 的窄主链，再增加编排和平台能力。
