# SWE-agent：Benchmark 驱动的软件修复 Agent

> 源码版本：`SWE-agent/SWE-agent main@3ea751c`（2026-07-16）

## 研究范围

SWE-agent 的目标不是提供通用聊天助手，而是把 Issue、代码仓库和可复现运行环境转换成软件修复轨迹与最终 Patch。本文关注 Agent Loop、Agent-Computer Interface（ACI）、SWE-ReX 环境、批量 benchmark、轨迹和评审重试闭环。

## 整体架构

```text
Problem Statement / SWE-bench instance
                    │
          run_single / run_batch
                    │
       ┌────────────┴────────────┐
       │                         │
 DefaultAgent                SWEEnv
       │                         │
 Model + HistoryProcessor    SWE-ReX Deployment
       │                         │
 Parser / ToolHandler        container / remote shell
       └──────── action ─────────┘
                    │ observation
              trajectory + patch
                    │
        evaluator / reviewer / inspector
```

官方架构说明位于 [`docs/background/architecture.md`](../../code/swe-agent/docs/background/architecture.md)。`SWEEnv` 在 1.0 后主要是 SWE-ReX 的薄封装：部署和 Shell 执行由外部 `swerex` 包承担，本仓库负责 Agent、配置、工具协议和实验管线。

## Agent Loop

核心类是 [`DefaultAgent`](../../code/swe-agent/sweagent/agent/agents.py)。运行过程可以概括为：

```text
setup(problem, env)
  → 构造 system / instance messages
  → step()
      → HistoryProcessor 压缩模型历史
      → Model.query()
      → Parser 提取 action / tool call
      → ToolHandler 校验
      → SWEEnv.execute()
      → observation 写入 history 和 trajectory
  → 重复直到 submit、成本/步数限制或异常终止
  → 保存 patch、info 和 trajectory
```

`DefaultAgentConfig` 把模板、工具、模型、HistoryProcessor 和最大重试次数组合起来。模型输出解析不是固定格式：[`tools/parsing.py`](../../code/swe-agent/sweagent/tools/parsing.py) 同时支持 Thought-Action、XML、JSON、Function Calling 和 Bash code block 等形式。

错误也是 Loop 的一部分。格式错误、被阻止的动作、Shell 语法错误、超时和空输出会转换为专门 observation，让模型有机会修正；上下文、成本和总执行时间限制则可以终止运行。

### `setup()`：运行前冻结哪些事实

`DefaultAgent.setup()` 绑定 `SWEEnv`、problem statement、output directory 和 run id，重置 trajectory/statistics，并依次加入 system message、demonstrations 与 instance template。Pydantic validator 会提前检查模板语法，但变量是否齐备仍由实际渲染上下文决定。

`add_system_message_to_history()`、`add_demonstrations_to_history()` 和 `add_instance_template_to_history()` 的顺序会影响首轮上下文。Demonstration 是作为历史示例注入的配置资产，不是 benchmark ground truth。比较实验时必须记录 template 与 demonstration，而不能只记录 model name。

### `step()` 内部的错误恢复

`step()` 通过 HistoryProcessor 生成 query history，再进入 `forward_with_handling()`。后者包围 `forward()`，把模型调用、parser、tool handler 与环境执行中的可恢复异常转换为 observation。`_RetryWithOutput` 保留给模型看的错误，`_RetryWithoutOutput` 避免污染 history，`_ExitForfeit` 放弃实例，`_TotalExecutionTimeExceeded` 则终止预算。

`forward()` 从模型 response 解析 thought/action 并交给 `handle_action()`；后者完成 blocked action、语法和工具规则检查后调用环境。`handle_submission()` 单独处理 submit，因为它还要抽取 patch、补充已编辑文件上下文并形成最终结果。异常终止时 `attempt_autosubmission_after_error()` 仍可能提交已有修改，因此“run 报错”不等于“没有 prediction”。

```text
processed history
  → model.query
  → parser(response)
  → action validation
  → env.communicate / submit
  → observation
  → StepOutput
  → history + trajectory + stats
```

`add_step_to_history()` 与 `add_step_to_trajectory()` 面向不同消费者：history 是下次模型请求的上下文，trajectory 是审计记录。HistoryProcessor 可以压缩模型历史，但 trajectory 仍保留 step 信息，不能用当前 `messages` 反推完整轨迹。

## ACI：性能来自交互接口设计

SWE-agent 把模型可见的工具和交互格式称为 Agent-Computer Interface。设计说明位于 [`docs/background/aci.md`](../../code/swe-agent/docs/background/aci.md)，强调：

- 编辑后立即运行 linter，语法不合法时拒绝修改；
- 使用带窗口的文件查看器控制每次展示范围；
- 搜索结果刻意压缩，避免 observation 淹没上下文；
- 命令无输出时返回明确成功提示。

工具声明和安装逻辑集中在 [`sweagent/tools`](../../code/swe-agent/sweagent/tools)。ACI 不是单纯工具 schema：它同时包含 Prompt 模板、解析格式、容器内命令和 observation 反馈语义。

### Parser 与 ToolHandler 是两道边界

[`parsing.py`](../../code/swe-agent/sweagent/tools/parsing.py) 中的 parser 只回答“怎样从模型文本得到 action”。`ThoughtActionParser`、XML、JSON、function calling 与 bash code block 处理不同输出协议，但不判断命令是否被允许。

ToolHandler 接着按配置验证 action、识别 shell function/submit，并把工具说明渲染进 prompt。失败因此分为四类：文本不符合 parser、action 可解析但工具未注册、参数或安全规则不满足、命令实际执行失败。四类 correction observation 的语义不同。

编辑工具的 lint-on-write 也是 ACI 合同：编辑命令可能已被调用，但 lint 失败后修改被拒绝或恢复。只读 trajectory 中的 action 而不读 observation，会误判实际工作区状态。

## 环境与仓库生命周期

[`SWEEnv`](../../code/swe-agent/sweagent/environment/swe_env.py) 管理 SWE-ReX Deployment、Shell session 和工具安装。仓库来源由 [`repo.py`](../../code/swe-agent/sweagent/environment/repo.py) 抽象，可处理已有目录、GitHub 仓库、SWE-bench/SWE-smith 实例等。

隔离和远程执行的真正实现主要在 SWE-ReX，不宜仅阅读 `SWEEnv` 就断言 Docker、Modal 或 AWS 的全部安全属性。SWE-agent 配置决定部署类型和资源参数，但安全边界仍由具体 Deployment 提供。

`SWEEnv.start()` 初始化 Deployment 与 shell session，再复制/准备仓库；`reset()`/`hard_reset()` 恢复实例状态，`close()` 释放资源。`communicate()` 是 Agent action 的主要执行窄腰，`execute_command()`、`read_file()`、`write_file()` 则供运行管线和 hook 使用。

仓库恢复并不总是简单 `git reset`：不同 `Repo` 来源需要定位 base commit、准备远端工作区并清理额外文件。批量运行必须保证每个 instance 得到独立或正确 reset 的环境，否则前一个候选会污染后一个结果。

环境 hook 与 agent hook 也处在不同层：前者观察 deployment/session/command 生命周期，后者观察 step/query/trajectory。命令耗时和容器故障应看环境层证据，模型决策与 token 成本则看 Agent/Model hooks。

## Benchmark 与批处理闭环

单实例入口是 [`run_single.py`](../../code/swe-agent/sweagent/run/run_single.py)，批处理入口是 [`run_batch.py`](../../code/swe-agent/sweagent/run/run_batch.py)。Batch Instance 来源定义在 [`batch_instances.py`](../../code/swe-agent/sweagent/run/batch_instances.py)，包括文件、Hugging Face、SWE-bench 和 SWE-smith。

```text
dataset instance
  → 准备 repo/base commit/problem statement
  → 独立 Agent + Environment run
  → trajectory / prediction patch
  → SWE-bench evaluation hook
  → 汇总成功率、成本与运行状态
```

这使配置、轨迹和评测成为一等产物，而不是 CLI 的附属日志。运行配置位于 [`config`](../../code/swe-agent/config)，其中 benchmark 配置和普通交互配置应区别对待。

## 轨迹、重放与 Reviewer

轨迹类型定义在 [`types.py`](../../code/swe-agent/sweagent/types.py)，每一步保留 response、thought、action、observation、execution time 和 model stats 等信息。Inspector 和重放入口分别位于 [`inspector_cli.py`](../../code/swe-agent/sweagent/run/inspector_cli.py) 与 [`run_replay.py`](../../code/swe-agent/sweagent/run/run_replay.py)。

[`reviewer.py`](../../code/swe-agent/sweagent/agent/reviewer.py) 支持对候选轨迹进行预选、打分或选择；`RetryAgent` 可以运行多个 Agent 尝试，再由 Reviewer 决定接受、继续或终止。它不是单次 ReAct Loop 内的普通 retry，而是更高层的候选生成与评审闭环。

## 限制与注意事项

- SWE-bench 成绩同时受模型、ACI、Prompt、环境镜像、采样和评测版本影响，不能只归因于 Agent 类。
- `SWEEnv` 是 SWE-ReX 包装层，跨仓库分析才能覆盖实际执行环境。
- Parser/工具格式众多，不同配置的运行轨迹可能具有不同语义。
- Retry/Reviewer 会增加模型调用和成本，比较实验时必须统计总尝试而非只看获胜轨迹。
- Benchmark 自动运行上游代码具有供应链风险，应使用隔离环境并限制凭据和网络。

## 推荐阅读顺序

1. [`docs/background/architecture.md`](../../code/swe-agent/docs/background/architecture.md)。
2. [`sweagent/run/run_single.py`](../../code/swe-agent/sweagent/run/run_single.py)。
3. [`sweagent/agent/agents.py`](../../code/swe-agent/sweagent/agent/agents.py) 的 `DefaultAgent`。
4. [`sweagent/tools`](../../code/swe-agent/sweagent/tools) 与 [`docs/background/aci.md`](../../code/swe-agent/docs/background/aci.md)。
5. [`sweagent/environment/swe_env.py`](../../code/swe-agent/sweagent/environment/swe_env.py)。
6. [`sweagent/run/run_batch.py`](../../code/swe-agent/sweagent/run/run_batch.py) 和 `batch_instances.py`。
7. [`sweagent/agent/reviewer.py`](../../code/swe-agent/sweagent/agent/reviewer.py) 与轨迹工具。
