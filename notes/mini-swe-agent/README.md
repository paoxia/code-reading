# mini-swe-agent 架构与 Agent Loop

相关专题：[Windows、Linux 与 macOS 跨平台适配](./cross-platform-adaptation.md)

> 源码版本：`SWE-agent/mini-swe-agent main@38c01a19ed1a`
>
> 软件版本：`2.4.5`
>
> 本文先研究默认 `mini` CLI 的主链路；Benchmark Runner、非默认 Model 和远程
> Environment 留待后续专题分析。

## 1. 一句话认识

mini-swe-agent 的核心不是复杂的工具编排，而是一个刻意压缩过的循环：

```text
完整消息历史 → LLM → bash tool call → 独立子进程 → observation → 完整消息历史
```

它只向默认模型暴露一个 `bash(command)` 工具。文件搜索、代码修改、测试以及提交任务
等能力都不在 Agent 内分别建模，而是交给模型组合 Shell 命令完成。

最小 Python API 示例直接组装三个对象：

- [`DefaultAgent`](../../code/mini-swe-agent/src/minisweagent/agents/default.py)
- [`LitellmModel`](../../code/mini-swe-agent/src/minisweagent/models/litellm_model.py)
- [`LocalEnvironment`](../../code/mini-swe-agent/src/minisweagent/environments/local.py)

组装代码见
[`run/hello_world.py`](../../code/mini-swe-agent/src/minisweagent/run/hello_world.py)。

## 2. 分层与核心抽象

项目在
[`minisweagent/__init__.py`](../../code/mini-swe-agent/src/minisweagent/__init__.py)
中用 Python `Protocol` 定义三个结构化接口：

| 抽象 | 核心方法 | 职责 |
|---|---|---|
| `Agent` | `run()`、`save()` | 驱动循环并保存轨迹 |
| `Model` | `query()`、`format_message()`、`format_observation_messages()` | 调用模型，在 Provider 消息和 Agent 内部消息之间转换 |
| `Environment` | `execute()` | 在本地、容器或远程环境中执行 action |

这些接口依赖结构类型和鸭子类型，不要求实现类继承共同基类。工厂函数还支持两种类名：

1. 内置短名称，例如 `interactive`、`litellm`、`local`；
2. 完整 Python 导入路径，用于加载用户自定义实现。

对应工厂位于：

- [`agents/__init__.py`](../../code/mini-swe-agent/src/minisweagent/agents/__init__.py)
- [`models/__init__.py`](../../code/mini-swe-agent/src/minisweagent/models/__init__.py)
- [`environments/__init__.py`](../../code/mini-swe-agent/src/minisweagent/environments/__init__.py)

这种设计的重点是“单个类保持简单，通过替换整个组件扩展”，而不是在核心循环中不断增加
Hook 或 Middleware。

## 3. 默认 CLI 启动链

`pyproject.toml` 将 `mini` 和 `mini-swe-agent` 都注册到 `run.mini:app`。主入口
[`run/mini.py`](../../code/mini-swe-agent/src/minisweagent/run/mini.py) 的执行顺序是：

```text
Typer 解析参数
   │
   ▼
读取 mini.yaml 和额外 -c 配置
   │
   ▼
递归合并 CLI 覆盖项
   │
   ├─ get_model()       → 默认 LitellmModel
   ├─ get_environment() → 默认 LocalEnvironment
   └─ get_agent()       → 默认 InteractiveAgent
                              │
                              ▼
                         agent.run(task)
```

配置既可以来自 YAML，也可以来自形如
`model.model_kwargs.temperature=0.5` 的点路径参数。解析逻辑见
[`config/__init__.py`](../../code/mini-swe-agent/src/minisweagent/config/__init__.py)。

默认 [`mini.yaml`](../../code/mini-swe-agent/src/minisweagent/config/mini.yaml) 的重要设置是：

- `step_limit: 0`：不限制模型调用次数；
- `cost_limit: 3.0`：累计成本达到限制后结束；
- `mode: confirm`：执行模型命令前请求确认；
- Model 输出必须至少包含一次 `bash` tool call；
- 每个 action 都在新子 Shell 中执行，目录和临时环境变量不会跨 action 保留；
- observation 超过 10000 字符时，只把头尾各 5000 字符返回模型。

模型名不在默认 YAML 中固定。`get_model_name()` 依次读取显式参数、配置项和
`MSWEA_MODEL_NAME`，三者都没有时直接报错。

## 4. DefaultAgent 的最小循环

核心实现集中在
[`agents/default.py`](../../code/mini-swe-agent/src/minisweagent/agents/default.py)。

### 4.1 初始化状态

`DefaultAgent` 持有的主要运行状态包括：

```text
messages                    完整线性消息历史
cost                        本 Agent 实例累计模型成本
n_calls                     本 Agent 实例累计模型调用次数
n_consecutive_format_errors 连续格式错误次数
_start_time                 Agent 实例创建时间
```

`run(task)` 首先清空 `messages`，渲染并加入 system、user 两条消息，随后进入
`while True`。循环体本身只有一个关键调用：

```python
self.step()
```

而 `step()` 又只有一层组合：

```python
return self.execute_actions(self.query())
```

因此主链可以直接展开为：

```text
query()
  ├─ 检查 step/cost/wall-time 限制
  ├─ model.query(messages)
  ├─ 累加调用次数和成本
  └─ 追加 assistant message

execute_actions(message)
  ├─ 读取 message.extra.actions
  ├─ 逐个 env.execute(action)
  ├─ Model 将执行输出格式化为 observation
  └─ 追加 tool message

回到下一轮 query()
```

### 4.2 消息是唯一的循环状态

默认 Agent 没有独立 Plan、Memory Store 或 StateGraph。循环的主要状态就是
`messages: list[dict]`：

| role | 来源 | 用途 |
|---|---|---|
| `system` | `system_template` | 定义行为与工具使用约束 |
| `user` | `instance_template` 或流程中断 | 提供任务、格式错误反馈和用户补充要求 |
| `assistant` | Model | 保存推理文本、tool call 和内部元数据 |
| `tool` | Model 的 observation formatter | 返回 Bash 执行结果，并用 `tool_call_id` 关联调用 |
| `exit` | Agent 控制流 | 记录退出原因和最终 submission，不再发给模型 |

`assistant.extra` 会保存解析后的 actions、Provider 原始响应、成本和时间戳；tool
message 的 `extra` 会保存完整原始输出、return code、异常和时间戳。

调用 Provider 前，`LitellmModel._prepare_messages_for_api()` 会删除每条消息的
`extra`。因此这些字段属于轨迹和控制数据，不会作为未知字段传给模型。默认 YAML
对超长 observation 的裁剪只影响发给模型的 `content`；完整输出仍保存在轨迹的
`extra.raw_output` 中。

项目没有在默认循环中做上下文压缩或历史淘汰。历史持续线性增长，直到任务结束、
达到限制或 Provider 报出上下文窗口错误。

## 5. Model：只暴露一个 Bash 工具

默认模型适配器
[`LitellmModel`](../../code/mini-swe-agent/src/minisweagent/models/litellm_model.py)
调用 `litellm.completion()`，并固定传入一个工具定义：

```text
bash(command: string)
```

工具 schema 和解析逻辑位于
[`actions_toolcall.py`](../../code/mini-swe-agent/src/minisweagent/models/utils/actions_toolcall.py)。
解析器要求：

- 响应至少包含一个 tool call；
- 工具名必须为 `bash`；
- arguments 必须是合法 JSON；
- arguments 必须包含 `command`。

任何条件不满足都会抛出 `FormatError`，其中携带一条 user message。`run()` 将这条
消息加入历史，让模型在下一轮自行纠正。默认连续三次格式错误后，以
`RepeatedFormatError` 结束，防止错误响应持续消耗预算。相关行为由
[`tests/agents/test_default.py`](../../code/mini-swe-agent/tests/agents/test_default.py)
和
[`tests/models/test_actions_toolcall.py`](../../code/mini-swe-agent/tests/models/test_actions_toolcall.py)
覆盖。

Model 层还负责：

- Provider 调用重试；
- Anthropic thinking block 顺序及 cache-control 兼容；
- 调用成本计算与全局成本/调用次数限制；
- 把 Provider 响应转换成统一的内部消息；
- 把 Environment 输出转换成对应的 tool result message。

## 6. Environment：执行边界

默认
[`LocalEnvironment`](../../code/mini-swe-agent/src/minisweagent/environments/local.py)
使用 `subprocess.Popen(..., shell=True)` 执行命令：

- 工作目录来自 action 参数、环境配置或当前进程目录；
- 进程环境为宿主环境与配置环境变量的合并结果；
- stdout 和 stderr 合并捕获；
- 默认超时 30 秒；
- POSIX 超时时终止整个进程组，Windows 下终止直接启动的进程；
- 每个 action 创建新进程，不维护一个长期存在的 Shell session。

异常不会直接从 `execute()` 向外抛出，而是转换成包含 `returncode: -1`、
`exception_info` 和异常类型的结构化 observation，让模型看到并调整命令。

Environment 工厂还提供 Docker、Singularity、bubblewrap、Contree 和 SWE-ReX 等
实现。它们替换的是执行边界，Agent Loop 和 Model 不需要随之改变。

## 7. 任务如何结束

mini-swe-agent 没有单独的 `finish` 工具。默认 Prompt 要求模型执行：

```bash
echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT
```

`LocalEnvironment._check_finished()` 检查命令输出：

1. return code 必须为 0；
2. 去掉左侧空白后的第一行必须等于该标记；
3. 后续输出行被作为 `submission`；
4. 满足条件后抛出 `Submitted`。

`Submitted` 不是异常失败，而是一种控制流信号。它继承自
`InterruptAgentFlow`，携带一条 `role: exit` 消息。`DefaultAgent.run()` 捕获后追加
消息，在发现最后一条消息是 `exit` 时跳出循环。

其他正常退出也使用相同机制：

| 退出状态 | 触发条件 |
|---|---|
| `Submitted` | Bash 输出完成标记 |
| `LimitsExceeded` | step 或 cost 达到配置限制 |
| `TimeExceeded` | wall-clock 超时 |
| `RepeatedFormatError` | 连续格式错误达到上限 |

未预期异常会先转换成 exit message 并保存轨迹，然后重新抛出，所以调用方仍能感知
真正的运行失败。异常层次见
[`exceptions.py`](../../code/mini-swe-agent/src/minisweagent/exceptions.py)。

## 8. InteractiveAgent 的人机控制

默认 `mini` CLI 实际创建的是
[`InteractiveAgent`](../../code/mini-swe-agent/src/minisweagent/agents/interactive.py)，
它继承 `DefaultAgent`，没有重写核心消息循环，只在关键位置加入终端交互。

三种模式分别是：

| 模式 | 行为 |
|---|---|
| `confirm` | 默认模式；不在白名单中的模型命令需要用户批准 |
| `yolo` | 模型命令直接执行 |
| `human` | 用户直接输入 Shell 命令，仍复用相同 Environment 和消息链 |

主要扩展点是：

- `query()`：支持 human 模式，并允许交互式提高 step/cost 限制；
- `execute_actions()`：执行前进行批量确认；
- `step()`：捕获 `KeyboardInterrupt`，把用户意见转成新 user message；
- `_check_for_new_task_or_submit()`：模型请求结束时，允许用户追加新任务；
- `add_messages()`：把消息实时渲染到终端。

用户拒绝命令不是丢弃这一轮，而是抛出 `UserInterruption`，将拒绝原因作为 user
message 加入同一条历史，让模型重新规划。

## 9. 轨迹保存与恢复边界

`DefaultAgent.run()` 的每轮 `finally` 都调用 `save()`。轨迹 JSON 包含：

- 完整 messages；
- Agent、Model、Environment 的解析后配置和具体类型；
- 模型调用数与成本；
- exit status 和 submission；
- mini-swe-agent 版本及轨迹格式版本。

但当前 `DefaultAgent` 只有序列化和保存，没有对应的加载/恢复方法。`run()` 每次开始
还会清空 `messages`。因此默认输出文件首先是调试、评估和复盘用的 trajectory，不能
等同于可恢复 Checkpoint。

另一个容易忽略的细节是：`run()` 只清空消息，不重置 `cost`、`n_calls` 和实例创建
时记录的 `_start_time`。复用同一个 Agent 对象多次调用 `run()` 时，限制统计仍会跨
任务累计。

## 10. 设计取舍与限制

### 优点

1. `DefaultAgent.step()` 几乎直接表达 Query → Act，控制流容易验证和改造。
2. Bash 是通用能力面，避免维护大量文件、搜索、补丁等专用工具。
3. Agent、Model、Environment 三者可独立替换。
4. 线性历史与完整轨迹便于调试、训练和 Benchmark 分析。
5. Environment 抽象让同一个 Agent 可以从本地迁移到隔离环境。

### 限制与风险

1. `LocalEnvironment` 不是沙箱；确认模式只是交互门禁，不提供操作系统级隔离。
2. Bash 工具权限很大，命令粒度的正则白名单难以表达细粒度文件或网络策略。
3. 默认没有上下文压缩、长期记忆和会话恢复。
4. 模型调用与命令执行都是同步的；同一响应中的多个 action 也按顺序执行。
5. 完成协议耦合到 stdout 首行标记，简单但不如独立结构化 finish 工具明确。
6. 文件编辑质量高度依赖模型正确使用 Shell，而不是专用 Patch 工具提供的结构保证。
7. 默认 `step_limit` 为 0，主要依靠成本上限终止；成本跟踪被关闭或不准确时应显式
   配置 step/wall-time 限制。

## 11. 推荐继续阅读的顺序

1. `agents/default.py`：先掌握完整循环和异常控制流。
2. `models/utils/actions_toolcall.py`：理解唯一工具如何解析和回填 observation。
3. `environments/local.py`：理解 Bash 的进程、超时与结束协议。
4. `models/litellm_model.py`：理解 Provider 消息转换、重试与成本统计。
5. `agents/interactive.py`：观察人机审批如何在不改主循环的前提下叠加。
6. `run/mini.py` 与 `config/mini.yaml`：理解依赖组装和 Prompt 驱动的行为约束。
7. Docker、bubblewrap 或 SWE-ReX Environment：比较不同执行隔离策略。
8. Benchmark Runner：研究单 Agent 如何扩展到批量任务、轨迹和评估。

## 12. 核心结论

mini-swe-agent 的“mini”主要体现在 Harness，而不是任务能力：

> 它把 Agent Runtime 压缩成线性消息列表和 Query → Bash → Observation 循环，把复杂
> 软件工程能力尽量交还给模型和 Shell；框架自身只保留 Provider 适配、执行边界、
> 人工确认、限制控制和轨迹记录。

这使它非常适合作为阅读 Pi、OpenCode 和 Codex 前的基线：后续可以逐项观察这些大型
项目为什么增加专用工具、上下文压缩、权限策略、持久会话、事件总线和沙箱协议。
