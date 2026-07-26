# trae-agent 源码架构概览

> 上游仓库：`bytedance/trae-agent`
>
> 源码版本：`main@e839e559ac61bdd0e057c375dd1dee391fee797d`
>
> 研究日期：2026-07-26
>
> 本文研究 `trae-cli run`、交互模式、Agent Loop、工具、Provider、MCP、Docker、
> Trajectory 和 Evaluation。`evaluation/patch_selection` 只做定位，不展开算法细节。

## 1. 一句话认识

Trae Agent 是一个面向软件工程任务的 Python Agent Harness。它的核心闭环很直接：

```text
问题描述 + 仓库路径
        │
        ▼
LLM Client ── 工具 Schema
        │
        ▼
模型返回 Tool Calls
        │
        ▼
Bash / Edit / JSON Edit / Thinking / MCP
        │
        ▼
工具结果加入历史 ── 回到下一 Step
        │
        ▼
task_done 或 max_steps
```

与更偏产品平台的 Kimi Code 相比，它的代码量和抽象层次更小，重点是：

- 用统一接口适配多种模型；
- 执行软件工程工具；
- 完整记录 Agent Trajectory；
- 在 Docker 中生成 Patch；
- 对接 SWE-bench 等评测集及 test-time patch selection。

## 2. 仓库结构

| 模块 | 路径 | 职责 |
|---|---|---|
| CLI | [`trae_agent/cli.py`](../../code/trae-agent/trae_agent/cli.py) | Click 命令、配置覆盖、工作目录、Docker 和 Console |
| Agent 门面 | [`agent/agent.py`](../../code/trae-agent/trae_agent/agent/agent.py) | 创建具体 Agent、Trajectory 和 UI |
| Agent 基类 | [`agent/base_agent.py`](../../code/trae-agent/trae_agent/agent/base_agent.py) | 通用 Step 循环、LLM 调用和工具执行 |
| 软件工程 Agent | [`agent/trae_agent.py`](../../code/trae-agent/trae_agent/agent/trae_agent.py) | Prompt、完成判定、Patch 与 MCP |
| 工具 | [`tools`](../../code/trae-agent/trae_agent/tools/) | Bash、编辑、JSON、思维、CKG、Task Done 和 MCP |
| 模型客户端 | [`utils/llm_clients`](../../code/trae-agent/trae_agent/utils/llm_clients/) | OpenAI、Anthropic、Google 等协议适配 |
| 配置 | [`utils/config.py`](../../code/trae-agent/trae_agent/utils/config.py) | YAML、CLI、环境变量和模型配置 |
| 轨迹 | [`utils/trajectory_recorder.py`](../../code/trae-agent/trae_agent/utils/trajectory_recorder.py) | 保存模型交互、Step、工具调用和结果 |
| 评测 | [`evaluation`](../../code/trae-agent/evaluation/) | 数据集、Docker Patch 生成、Harness 和 Patch Selection |

[`pyproject.toml`](../../code/trae-agent/pyproject.toml) 注册的命令是：

```text
trae-cli = trae_agent.cli:main
```

项目要求 Python `>=3.12`，采用 MIT License。

## 3. CLI 启动与对象组装

`trae-cli run` 的主要流程位于
[`cli.run`](../../code/trae-agent/trae_agent/cli.py)：

```text
Click 解析命令
  ├─ 校验任务文本或 --file
  ├─ Config.create(YAML)
  ├─ CLI / ENV 覆盖模型和 max_steps
  ├─ 创建 Simple 或 Rich Console
  ├─ 解析工作目录和 Docker 参数
  └─ Agent(...).run(task, task_args)
```

[`Agent`](../../code/trae-agent/trae_agent/agent/agent.py) 是一个很薄的工厂门面：

1. 创建 `TrajectoryRecorder`；
2. 根据 `AgentType` 创建具体 Agent；
3. 注入 Console 和 Recorder；
4. 初始化允许使用的 MCP Server；
5. 调用 `execute_task()`；
6. 在退出时清理 MCP Client。

当前 `AgentType` 只有 `trae_agent` 一种，因此这里的多类型工厂更多是扩展预留，
还不是实际的多 Agent 系统。

## 4. Agent Loop

循环集中在
[`BaseAgent.execute_task`](../../code/trae-agent/trae_agent/agent/base_agent.py)：

```text
new_task()
  ├─ system prompt
  └─ user: project_path + issue

for step_number in 1..max_steps
  │
  ├─ LLMClient.chat(messages, model_config, tools)
  │
  ├─ 模型调用 task_done？
  │    ├─ 是：检查 Patch 要求并结束
  │    └─ 否：继续
  │
  ├─ ToolExecutor 执行 Tool Calls
  │    ├─ parallel_tool_calls = true  → asyncio.gather
  │    └─ false                       → 顺序执行
  │
  ├─ Tool Results 转为新消息
  └─ 记录 Step，进入下一轮
```

### 4.1 消息历史在哪里

`BaseAgent` 每轮只把新增 Tool Result 交给 `LLMClient.chat()`，看起来没有显式拼回
之前消息。完整历史实际由各 Provider Client 内部维护。例如
[`OpenAICompatibleClient`](../../code/trae-agent/trae_agent/utils/llm_clients/openai_compatible_base.py)
把新消息追加到 `message_history`，再把 Assistant 响应也写回历史。

这简化了 Agent Loop，但也让“会话状态”分散到 Provider Adapter 内。新增 Provider
时，`set_chat_history()`、`reuse_history` 和 Tool Call/Result 配对必须保持一致。

### 4.2 完成协议

通用 `BaseAgent` 支持用自然语言关键词判断完成；具体
[`TraeAgent`](../../code/trae-agent/trae_agent/agent/trae_agent.py)
覆盖了这一行为，只接受模型调用 `task_done` 工具。

当 CLI 使用 `--must-patch` 时，`task_done` 之后还会执行：

1. `git diff` 获取 Patch；
2. 过滤测试目录的修改；
3. 如果业务代码 Patch 为空，向模型返回“Patch 为空”，继续循环；
4. 有 Patch 才认为成功。

因此 `task_done` 是“模型申请结束”，`_is_task_completed()` 才是 Host 侧的最终验收。

### 4.3 状态模型

[`agent_basics.py`](../../code/trae-agent/trae_agent/agent/agent_basics.py)
定义：

- `AgentState`：运行、完成或错误；
- `AgentStepState`：思考、调用工具、反思、完成或错误；
- `AgentStep`：单步 LLM 响应、工具调用、工具结果和错误；
- `AgentExecution`：整次任务的 Steps、Token、耗时和最终结果。

这是内存中的单任务状态，不是可恢复的持久化 Session。

## 5. 工具系统

### 5.1 抽象与注册

[`Tool`](../../code/trae-agent/trae_agent/tools/base.py) 定义：

- 名称和描述；
- `ToolParameter`；
- JSON Schema；
- 异步 `execute()`；
- 可选 `close()`。

[`tools_registry`](../../code/trae-agent/trae_agent/tools/__init__.py)
用字符串到 Tool Class 的字典完成注册。内置工具包括：

| 名称 | 实现 | 用途 |
|---|---|---|
| `bash` | [`BashTool`](../../code/trae-agent/trae_agent/tools/bash_tool.py) | 持久 Bash 子进程 |
| `str_replace_based_edit_tool` | [`TextEditorTool`](../../code/trae-agent/trae_agent/tools/edit_tool.py) | 查看、创建和替换文本 |
| `json_edit_tool` | [`JSONEditTool`](../../code/trae-agent/trae_agent/tools/json_edit_tool.py) | 基于 JSONPath 修改 JSON |
| `sequentialthinking` | [`SequentialThinkingTool`](../../code/trae-agent/trae_agent/tools/sequential_thinking_tool.py) | 显式分步推理记录 |
| `task_done` | [`TaskDoneTool`](../../code/trae-agent/trae_agent/tools/task_done_tool.py) | 请求结束任务 |
| `ckg` | [`CKGTool`](../../code/trae-agent/trae_agent/tools/ckg_tool.py) | 查询代码知识图谱 |

### 5.2 `ToolExecutor`

[`ToolExecutor`](../../code/trae-agent/trae_agent/tools/base.py)
对工具名做小写和去下划线归一化，然后捕获执行异常并转换为 `ToolResult`。
当 `parallel_tool_calls=true` 时，它直接使用 `asyncio.gather()` 并行执行整个批次。

这里没有独立的权限或审批层。非 Docker 模式下，模型生成的 Bash 和编辑调用会直接在
用户指定的工作目录执行。实际使用第三方模型或不可信 Prompt 时，需要在外层提供隔离。

## 6. Provider 适配

[`LLMClient`](../../code/trae-agent/trae_agent/utils/llm_clients/llm_client.py)
根据配置创建具体 Client，当前枚举包括：

- OpenAI；
- Anthropic；
- Azure；
- OpenRouter；
- Doubao；
- Ollama；
- Google。

所有 Client 实现
[`BaseLLMClient`](../../code/trae-agent/trae_agent/utils/llm_clients/base_client.py)
的 `chat()`、`set_chat_history()` 和工具调用能力判断。

OpenAI、Azure、Doubao 和 OpenRouter 复用
[`OpenAICompatibleClient`](../../code/trae-agent/trae_agent/utils/llm_clients/openai_compatible_base.py)
的消息转换、历史维护、重试和 Tool Schema 逻辑；Anthropic、Google、Ollama 分别实现
各自协议转换。

这种结构清晰，但统一层较薄。Provider 差异仍会进入 Schema、消息格式、Token 参数和
工具结果配对代码，新增 Provider 不能只填写一个配置对象。

## 7. MCP

[`MCPClient`](../../code/trae-agent/trae_agent/utils/mcp_client.py)
连接允许列表中的 Server，调用 `list_tools()` 后将结果包装成
[`MCPTool`](../../code/trae-agent/trae_agent/tools/mcp_tool.py)，再加入普通工具列表。

当前实际只实现 stdio Transport。配置模型虽然包含 HTTP、SSE/WebSocket 相关字段，
但 `http_url` 和 `url` 分支会抛出 `NotImplementedError`。所以不能仅根据
`MCPServerConfig` 的字段推断所有 Transport 已可用。

MCP 初始化失败会被跳过，并清理失败的 Client；任务结束时统一关闭 `AsyncExitStack`。

## 8. Docker 隔离

CLI 可用镜像、已有 Container、Dockerfile 或本地镜像文件启动 Docker 模式。
[`DockerManager`](../../code/trae-agent/trae_agent/agent/docker_manager.py)
负责容器生命周期和命令执行；
[`DockerToolExecutor`](../../code/trae-agent/trae_agent/tools/docker_tool_executor.py)
按工具名决定在 Host 还是 Container 执行。

当前 Docker 路由只专门支持：

- `bash`；
- `str_replace_based_edit_tool`；
- `json_edit_tool`。

其他工具仍走本地 Executor。Docker 模式下即使模型配置允许并行工具调用，
`parallel_tool_call()` 也会退化成顺序执行。新增工具时必须同时决定它应在 Host
还是 Container 执行，并补充参数到命令行的安全序列化。

## 9. Trajectory 与 Lakeview

[`TrajectoryRecorder`](../../code/trae-agent/trae_agent/utils/trajectory_recorder.py)
把下列内容写入 JSON：

- 任务、Provider、模型和最大步数；
- 每次 LLM 输入与响应；
- Token Usage；
- Tool Schema 名称、Tool Calls 和 Tool Results；
- 每个 Agent Step；
- 最终结果、成功状态和耗时。

它在每次交互或 Step 后都会重写轨迹文件，优点是异常退出时通常仍能保留部分过程。
代价是大任务下写放大会增加，而且轨迹可能包含 Prompt、源码片段、命令输出和敏感信息，
不应未经处理直接公开。

[`LakeView`](../../code/trae-agent/trae_agent/utils/lake_view.py)
使用独立模型对 Step 做两次派生分析：

1. 生成简短任务与细节摘要；
2. 标注 `EXAMINE_CODE`、`WRITE_FIX`、`VERIFY_FIX` 等行为标签。

Lakeview 只影响可读展示和轨迹摘要，不参与主 Agent 的决策。

## 10. Evaluation 与 test-time scaling

[`evaluation/run_evaluation.py`](../../code/trae-agent/evaluation/run_evaluation.py)
负责：

1. 加载 Benchmark 数据；
2. 准备或拉取 Docker 镜像；
3. 在每个实例中运行 `trae-cli run --must-patch`；
4. 收集 Patch 和 Trajectory；
5. 调用相应评测 Harness。

[`evaluation/utils.py`](../../code/trae-agent/evaluation/utils.py) 当前配置了：

- SWE-bench；
- SWE-bench-Live；
- Multi-SWE-bench。

[`evaluation/patch_selection`](../../code/trae-agent/evaluation/patch_selection/)
可以对同一问题生成的多个候选 Patch 去重、分组并用 Selector Agent 选择结果。这是
项目论文中 test-time scaling 在仓库里的主要工程落点：不是只让单条轨迹思考更久，
而是生成多个候选再选择。

## 11. 测试现状

测试集中在 [`tests`](../../code/trae-agent/tests/)：

- Agent 初始化、Patch 过滤和完成判断；
- CLI；
- 配置解析；
- Bash、文本编辑和 JSON 编辑工具；
- MCP Client / Tool；
- Google、Ollama、OpenRouter Client 的部分行为。

代表性入口：

- [`test_trae_agent.py`](../../code/trae-agent/tests/agent/test_trae_agent.py)；
- [`test_bash_tool.py`](../../code/trae-agent/tests/tools/test_bash_tool.py)；
- [`test_mcp_client.py`](../../code/trae-agent/tests/utils/test_mcp_client.py)；
- [`test_config.py`](../../code/trae-agent/tests/utils/test_config.py)。

相较功能范围，现有测试数量不多，且大量 Provider 和 CLI 测试依赖 Mock。主循环跨
真实模型、工具、Docker 和轨迹的完整集成验证主要依赖 Evaluation Harness。

本文未运行测试；结论来自本地源码和测试定义。

## 12. 限制与风险

1. **没有本地审批机制**：普通模式下 Bash 和编辑工具直接执行，应优先使用受控目录
   或 Docker。
2. **Session 不可恢复**：Trajectory 用于观察和评测，不会被主 Agent 重放成可继续
   的会话。
3. **MCP Transport 不完整**：当前只有 stdio 可用，HTTP 与 WebSocket 分支明确未实现。
4. **HTTP Server 未完成**：[`server/Readme.md`](../../code/trae-agent/server/Readme.md)
   明确说明仍在建设中，目录内没有可用的 FastAPI Server 实现。
5. **Docker 并非全工具沙箱**：只有指定工具路由进 Container，其他工具可能仍在 Host
   执行。
6. **状态位于 Provider Client**：消息历史由各 Client 自己维护，Provider 实现错误
   会直接破坏主循环。
7. **轨迹可能泄密**：记录包含完整输入、工具参数和输出，需要单独制定保留与脱敏策略。
8. **完成信号较弱**：`task_done` 加“Patch 非空”只能证明产生了改动，不能证明改动正确；
   正确性仍依赖模型主动运行测试以及外部评测。

## 13. 与 Kimi Code 的关系

横向对比表见
[`notes/kimi-code/README.md`](../kimi-code/README.md#12-与-trae-agent-的横向对比)。

可以把两者理解为不同取舍：

```text
Trae Agent
  └─ 强调简单循环、实验轨迹、Benchmark 和候选 Patch 选择

Kimi Code
  └─ 强调长会话、权限、恢复、多前端、多 Agent 和扩展生态
```

Trae Agent 更适合先读清楚“模型—工具—观察—继续”的软件工程闭环；Kimi Code
更适合进一步研究这个闭环如何发展为长期运行的开发者产品。

## 14. 推荐阅读顺序

1. [`cli.run`](../../code/trae-agent/trae_agent/cli.py)；
2. [`Agent`](../../code/trae-agent/trae_agent/agent/agent.py)；
3. [`BaseAgent.execute_task`](../../code/trae-agent/trae_agent/agent/base_agent.py)；
4. [`TraeAgent`](../../code/trae-agent/trae_agent/agent/trae_agent.py)；
5. [`Tool` 与 `ToolExecutor`](../../code/trae-agent/trae_agent/tools/base.py)；
6. [`LLMClient`](../../code/trae-agent/trae_agent/utils/llm_clients/llm_client.py)
   和一个具体 Provider；
7. [`TrajectoryRecorder`](../../code/trae-agent/trae_agent/utils/trajectory_recorder.py)
   与 [`LakeView`](../../code/trae-agent/trae_agent/utils/lake_view.py)；
8. [`evaluation/run_evaluation.py`](../../code/trae-agent/evaluation/run_evaluation.py)
   和 `patch_selection`。
