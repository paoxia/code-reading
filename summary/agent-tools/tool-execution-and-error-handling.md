# Agent Tool 调用与错误处理横向总结

> 更新日期：2026-11-02；版本见 [完整项目总览](../project-landscape/overview.md)。本轮修订当前工具路径和执行边界，基于源码与测试材料静态研究，未运行上游测试。

## 一条完整调用链

```text
模型声明 tool call
  → 完整参数解析与 schema 校验
  → 工具解析 / 当前能力与权限
  → approval / sandbox
  → 记录调用意图 → dispatch
  → success / failure / abort 结算
  → 结果与 call ID 配对并持久化
  → 编译下一轮模型消息
```

schema 是模型可见的使用合同，权限是运行时是否允许动作，sandbox 是操作系统或远端执行边界。三者不能互相代替。

## 当前实现矩阵

| 项目 | 核心入口 | 关键机制 |
| --- | --- | --- |
| [mini-swe-agent](../../notes/mini-swe-agent/README.md) | DefaultAgent + Environment | action/observation 与限额、格式错误分支 |
| [pi](../../notes/pi/README.md) | Agent Loop；实验性 Durable tools/tasks | 参数准备、hook、结果归一与持久化路径分开 |
| [Kimi Code](../../notes/kimi-code/README.md) | v2 machine/tools + toolExecutor | expected IDs、pending entries、批次和取消结算 |
| [OpenCode](../../notes/opencode/README.md) | core SessionStep + Tool runtime | 模型事件、工具结果、retry/compaction 分支 |
| [Codex](../../notes/codex/tool-runtime.md) | router/handler + 审批/沙箱 | 工具规格、策略和设备/进程执行分层 |
| [DeepSeek Harness](../../notes/deepseek-harness/architecture.md) | core/tools batch/pipeline | exclusive barrier、有界并行、有序提交、取消排空 |
| [Goose](../../notes/goose/README.md) | 状态机 ops_toolcalling + ExtensionManager | MCP、工具检查、确认与运行事件 |
| [Gemini CLI](../../notes/gemini-cli/README.md) | Core tool scheduling / policy | 工具状态、确认与模型 Turn 衔接 |
| [Trae Agent](../../notes/trae-agent/README.md) | ToolExecutor | 顺序/并行执行、错误结果和 trajectory |
| [SWE-agent](../../notes/swe-agent/README.md) | Parser + ToolHandler + SWEEnv | 格式、动作检查与环境 observation 分层 |
| [OpenManus](../../notes/openmanus/README.md) | ToolCallAgent + ToolCollection | 异常和工具结果转回下一轮思考 |
| [Hermes](../../notes/hermes-agent/README.md) | AIAgent + tool registry/middleware | 工具集合、执行控制与子 Agent 裁剪 |
| [AgentScope Java](../../notes/agentscope-java/tool-and-skill.md) | ReActAgent + Tool/Middleware | 调用状态、工具结果和失败持久化 |
| [Spring AI](../../notes/spring-ai/README.md) | ToolCallingManager | ToolCallback 执行与工具响应消息 |
| [Spring AI Alibaba](../../notes/spring-ai-alibaba/tool-calling.md) | AgentToolNode / Interceptor | 图状态、工具调用与扩展 |
| [LangChain/LangGraph](../../notes/langchain/README.md) | Agent middleware + ToolNode | 工具结果与图状态、错误策略分离 |

Aider 的主编辑通道是 Coder 的文本编辑协议；RTK/Caveman 是工具或上下文外围层。它们可参与同一工作流，但不应强行填成相同 Function Calling Tool Runtime。

## 三个应从当前源码重读的实现

### Kimi：每个调用都要收口

[createMachineTools](../../code/kimi-code/packages/agent-core-v2/src/agent/loop/machine/tools.ts) 维护 expected IDs、pending entry、progress handlers 和 extras，批次通过 toolExecutor 执行。取消前未执行的调用、执行后缺失结果的调用，都必须得到明确结算，避免等待者永不完成。

extras 中的 stopTurn、delivery、stopBatchAfterThis 与模型可见 output 不同，它们控制运行时如何继续。不能只保存一段 output 字符串而丢掉批次终态。

### OpenCode：单次尝试与会话所有权分开

[SessionStep](../../code/opencode/packages/core/src/session/runner/step.ts) 区分 Completed、Retry、Continue、RecoverFull、Compacted 和 OutputLimit；[SessionExecution](../../code/opencode/packages/core/src/session/execution.ts) 管活跃执行、claim、唤醒与中断。工具失败、Provider 错误和整个 Session 中断属于不同恢复层。

[ShellTool](../../code/opencode/packages/core/src/tool/plugin/shell.ts) 还可返回后台任务 `running`。工具函数已返回不代表命令进程已结束，模型结果与后续通知必须保持一致。

### DeepSeek Harness：执行可并行，提交仍有序

[executeToolBatch](../../code/deepseek-harness/packages/core/tools/src/batch.ts) 用有界 rolling pool 运行并行安全工具，exclusive 工具形成 barrier。后续工具启动前会重查分类，因为前面的有序提交可能改变 registry 或策略。

取消时停止补充新任务，排空已启动调用，为跳过调用生成结果；内部调度错误排空后再上抛，拥有该 Step 的层负责保守恢复。这不是对所有工具做一次 Promise.all 就能得到的语义。

## 错误应该进入哪一层

| 失败 | 模型反馈 | 自动重试判断 |
| --- | --- | --- |
| JSON/schema 不合法 | 指明参数问题，保留 call ID | 通常让模型更正 |
| 工具不存在/当前未披露 | 返回可恢复诊断 | 重新解析当前工具集合 |
| 权限拒绝 | 明确拒绝或请求有效审批 | 不因失败自动绕过权限 |
| Shell 非零退出/业务失败 | 结构化结果与可用输出 | 由任务语义判断 |
| 网络断连/Provider 限流 | Provider 错误及预算 | 可在无重复副作用前提下有限重试 |
| 超时/取消 | 区分未执行、运行中、结果未知 | 先确认真实外部状态 |
| 存储失败 | 不能假称已持久化成功 | 恢复协议处理，不盲目重放动作 |
| context overflow | 压缩/重新编译请求 | 不默认重做已执行工具 |

可对照 [pi Agent Loop](../../code/pi/packages/agent/src/agent-loop.ts)、[Spring AI ToolCallingManager](../../code/spring-ai/spring-ai-model/src/main/java/org/springframework/ai/model/tool/DefaultToolCallingManager.java) 与 [SWE-agent parser](../../code/swe-agent/sweagent/tools/parsing.py)，区分协议失败、工具业务失败与框架异常。

## 持久化不等于外部 exactly-once

如果进程在动作成功后、结果写入前崩溃，恢复者不能只根据“缺少 tool result”判断动作未发生。外部系统需要幂等键、事务或可查询状态，Shell/文件操作也需要自己的恢复策略。

同样，“模型要求结束”“工具返回成功”“测试通过”“业务验收完成”是不同层的证据。Trae 的 task_done + patch 检查、SWE-agent 的 prediction/trajectory 与 Better Harness 的证据评估分别研究这些边界。

## 推荐验证顺序

先用最小工具确认参数与结果配对，再检查失败与取消，随后加入并行、权限和恢复。重点阅读 [Kimi batch 测试](../../code/kimi-code/packages/agent-core-v2/test/agent/loop/machineTools.test.ts)、[OpenCode 工具事件测试](../../code/opencode/packages/core/test/session-runner-tool-events.test.ts) 与 [pi Durable 重启测试](../../code/pi/packages/durable/test/harness-restart-failure.test.ts)。测试材料在本轮只被阅读，没有执行。
