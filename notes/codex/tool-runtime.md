# Codex Tool Runtime：规格规划、路由、审批与沙箱执行

> 原始研究版本：`code/codex@28aacbb`
>
> 2026-08-19 增量复核版本：`code/codex@f5a3dc55404d`

## 1. 两张工具表

Codex 工具有两个必须一致但职责不同的表面：

- model-visible specs：发给模型的名称、描述、JSON schema/custom grammar；
- runtime registry：收到调用后真正执行的 handler。

[`spec_plan.rs`](../../code/codex/codex-rs/core/src/tools/spec_plan.rs) 同时规划两者，[`ToolRegistry`](../../code/codex/codex-rs/core/src/tools/registry.rs) 保存执行注册，[`ToolRouter`](../../code/codex/codex-rs/core/src/tools/router.rs) 解析并分派调用。只有 schema 没有 handler 会在运行时失败；只有 handler 没有 schema 则模型无法直接发现。

## 2. 一轮工具计划如何生成

```text
TurnContext + model capabilities + features
  + MCP tools + extension tools + dynamic tools
  + environment/sandbox capabilities
  → build tool plan
  ├─ Vec<ToolSpec> for Responses request
  └─ ToolRegistry for local dispatch
```

规划阶段会处理 shell/apply_patch/unified_exec、MCP resources、collaboration、plan、image、tool search、extension 和 dynamic tools。工具是否出现受 model capability、feature flag、code mode、环境类型和 exposure policy 共同影响，并非固定全集。

新增的 `send_user_message_async` 是这套规划机制的直接例子：它只向 root agent 且支持该工具的模型暴露，调用后立即返回 accepted，将用户可见更新标记为 async delivery，不把该更新回灌到当前模型输入。见
[`send_user_message_async.rs`](../../code/codex/codex-rs/core/src/tools/handlers/send_user_message_async.rs)。

另一个边界是 environment MCP policy：MCP 工具的可见性和调用不再只受静态配置控制，还必须通过当前执行环境的 policy。因此“已连接 MCP server”不等于“本 turn 中可见且可调用”。

namespace/code mode 会把多个工具合入 Responses namespace，同时注册 delegate executor。模型看到的名字可能与内部裸 handler 名不同，所以路由必须保留 name mapping，不能靠字符串随意切割。

## 3. 调用载荷

`ToolCall`/`ToolPayload` 区分 function、custom/freeform、MCP、local shell 等形态。Router 先把 provider output item 归一为调用，再从 registry 找 handler。参数解析失败、未知工具和 handler 不支持该 payload 时，会形成模型可见的失败结果，而不是 panic。

工具调用生命周期事件由 [`lifecycle.rs`](../../code/codex/codex-rs/core/src/tools/lifecycle.rs) 与 registry 协调，确保 start/finish 成对发送。代码还有“finish 是否已被 handler claim”的检查，防止通用包装层和专用 handler 重复发完成事件。

## 4. 审批与沙箱不是一层

```text
tool request
  → policy/approval decision
  → sandbox selection
  → first execution attempt
  → sandbox denial or escalation request
  → optional approval
  → escalated/reconfigured retry
  → normalized ToolOutput
```

[`ToolOrchestrator`](../../code/codex/codex-rs/core/src/tools/orchestrator.rs) 把单次工具执行包装成可能包含重试/提权的事务。审批回答“是否允许做”，sandbox 回答“获准进程实际能访问什么”。Ask/deny、sandbox blocked 和命令业务失败必须分别归类。

[`approvals.rs`](../../code/codex/codex-rs/core/src/tools/approvals.rs) 负责审批请求与 resolution；[`sandboxing.rs`](../../code/codex/codex-rs/core/src/tools/sandboxing.rs) 根据 TurnContext/环境选择约束。`run_attempt()` 执行某一 sandbox attempt，`run()` 决定是否能在获得批准后重试。

## 5. Shell、Unified Exec 与 Apply Patch

Shell handler 负责命令语义、输出截断和事件，runtime 负责真正启动进程。Unified exec 进一步支持持久 session、`exec_command`/`write_stdin` 和过程轮询；因此返回 session id 表示进程仍活着，不是失败或完成。

Apply Patch 使用专用 grammar/parser 和 runtime。它不是把模型字符串直接交给 shell：handler 解析 patch、检查目标和权限，再执行文件变更。通过 shell 间接调用 apply_patch 时还存在拦截/重路由逻辑，避免绕开专用安全语义。

对应源码在 [`handlers`](../../code/codex/codex-rs/core/src/tools/handlers)、[`runtimes`](../../code/codex/codex-rs/core/src/tools/runtimes) 与 [`unified_exec`](../../code/codex/codex-rs/core/src/unified_exec)。

## 6. 并行工具与确定性写回

模型可能在一个 response 中返回多个调用。[`parallel.rs`](../../code/codex/codex-rs/core/src/tools/parallel.rs) 决定哪些可以并行执行。并行完成顺序可能不同于模型声明顺序，但写回 history 必须保持 tool call id 的正确关联；文件写入、同一 process session 等有共享状态的工具不能盲目并发。

工具 output 同时有展示版与模型版。大输出需要截断/格式化，exec 输出通过 [`tools/mod.rs`](../../code/codex/codex-rs/core/src/tools/mod.rs) 的格式化函数生成模型内容；客户端仍可通过 delta/terminal 事件获得更细过程。

## 7. MCP、Extension 与 Dynamic Tool

MCP tool 的 schema 来自外部 server，调用走 MCP runtime，还可能触发 elicitation/OAuth。Extension tools 可以是 function 或 custom tool；dynamic tools 来自 app-server/client 注入。三者都进入统一 registry，但信任边界、执行位置和错误源不同。

Tool search 让部分工具按需披露：初始模型请求只带搜索入口，命中后再加载具体 spec。它降低 schema token 成本，也意味着“当前请求没看到工具”不代表 session 未配置该工具。

## 8. 失败定位表

| 现象 | 优先层级 |
|---|---|
| 模型从不调用工具 | spec plan、feature、model capability |
| unknown tool | provider 返回名与 registry mapping |
| 参数解析失败 | function schema/custom grammar 与 payload |
| 一直等待 | approval、elicitation、长期 exec session |
| permission denied | approval resolution 与 sandbox policy 分开看 |
| 命令成功但模型说失败 | model-visible output 格式/截断 |
| tool completed 重复 | lifecycle claim/通用 finish wrapper |

## 9. 测试入口

- [`spec_plan_tests.rs`](../../code/codex/codex-rs/core/src/tools/spec_plan_tests.rs)：不同模式下的工具可见性。
- [`registry_tests.rs`](../../code/codex/codex-rs/core/src/tools/registry_tests.rs)：注册和 dispatch。
- [`router_tests.rs`](../../code/codex/codex-rs/core/src/tools/router_tests.rs)：payload 路由与错误。
- [`approvals_tests.rs`](../../code/codex/codex-rs/core/src/tools/approvals_tests.rs)：审批语义。
- [`sandboxing_tests.rs`](../../code/codex/codex-rs/core/src/tools/sandboxing_tests.rs)：sandbox 选择。
- handlers/runtimes 下各专项测试：shell、apply patch、MCP、multi-agent 和 unified exec。
