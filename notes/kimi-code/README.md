# Kimi Code：v2 状态机、上下文与工具运行时

> 本轮复核：2026-11-02；本地源码 `fc3b521b8b68468268bb4cfe7f45008ce08b2b99`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 当前架构

当前主要运行时已经落在 `packages/agent-core-v2`。旧 `packages/agent-core`、kosong、kaos 的独立包结构已不在本地树中，不能继续将旧 loop 路径作为现行执行链。v2 内部同时包含应用服务、Agent 适配层和 `human` 下的基础状态机。

```text
TUI / SDK / KAP / ACP
  → 应用与 Session 服务
  → Session run gate / LoopService
  → machine engine（Agent / Turn / Tool 状态机）
  → requester → LLM adapter / human LLM
  → tool executor → permission / OS backend
  → context fold / Session state / 事件投影
```

## 核心对象与职责

| 对象 | 源码 | 职责 |
| --- | --- | --- |
| LoopService | [loopService.ts](../../code/kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts) | Agent 运行主链的服务装配 |
| Machine engine | [machine/engine.ts](../../code/kimi-code/packages/agent-core-v2/src/agent/loop/machine/engine.ts) | 连接 Agent、Turn、Tool 状态机和外部事件 |
| Machine tools | [machine/tools.ts](../../code/kimi-code/packages/agent-core-v2/src/agent/loop/machine/tools.ts) | 工具批次、结果配对和取消结算 |
| ContextMemory | [contextMemory.ts](../../code/kimi-code/packages/agent-core-v2/src/agent/contextMemory/contextMemory.ts) | 模型上下文及状态折叠 |
| SessionRunGate | [sessionRunGate.ts](../../code/kimi-code/packages/agent-core-v2/src/session/sessionActivity/sessionRunGate.ts) | Session 运行准入 |
| SessionState | [sessionState.ts](../../code/kimi-code/packages/agent-core-v2/src/session/state/sessionState.ts) | 会话状态管理 |
| Subagent | [subagent/spawn.ts](../../code/kimi-code/packages/agent-core-v2/src/session/subagent/spawn.ts) | 子 Agent 创建与运行衔接 |

## Turn、Step 与工具事件

MachineEngineEvent 显式区分 `turnStarted/turnSettled`、`stepStarted/stepCompleted/stepFailed`、delta、retrying、recovering，以及 toolStarted/toolDone/toolFailed/toolAborted。模型流结束、当前 Step 完成、用户 Turn 收口分别是不同的状态边界。

`createMachineTools()` 维护预期 tool call ID、pending entry 和结果 extras。取消或工具没有结果时，也会为等待中的调用形成明确失败结果，避免上层一直等待。extras 中的 stopTurn、delivery、stopBatchAfterThis 等字段进一步区分批次控制与模型可见内容。

动态工具披露通过 toolInfos/materialize 衔接；工具被展示、工具获准执行和工具结果写回仍是三个步骤。不能把注册了工具解释成已经获得用户文件或系统权限。

## 上下文与压缩

ContextMemory 把 loop events 和工具结果转成上下文；相关实现包括 [loopEventFold.ts](../../code/kimi-code/packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts)、[openToolExchange.ts](../../code/kimi-code/packages/agent-core-v2/src/agent/contextMemory/openToolExchange.ts)。Full compaction 与恢复见 [compactionOps.ts](../../code/kimi-code/packages/agent-core-v2/src/agent/fullCompaction/compactionOps.ts)、[contextRecovery.ts](../../code/kimi-code/packages/agent-core-v2/src/agent/fullCompaction/contextRecovery.ts)。

压缩不能打断调用/结果配对，展示投影也不等于模型下一次真正看到的历史。排查时应同时核对事件、上下文 fold 和 request 输入，不能仅看 TUI 文本。

## 模型与执行环境

模型适配器已在 v2 内部的 `llm-adapter`，继续读 [模型 API 适配](./model-api-adaptation.md)。OS backend、ExecutionEnvironment 与 Shell path bridge 见 [跨平台适配](./cross-platform-adaptation.md)。权限策略入口是 [permissionPolicy.ts](../../code/kimi-code/packages/agent-core-v2/src/agent/permissionPolicy/permissionPolicy.ts)，能力注册不应代替权限判断。

## 阅读与验证

推荐依次阅读 LoopService、machine engine、tools、ContextMemory、LLM adapter，再进入 Session 和子 Agent。测试证据包括 [工具批次测试](../../code/kimi-code/packages/agent-core-v2/test/agent/loop/machineTools.test.ts)、[压缩测试](../../code/kimi-code/packages/agent-core-v2/test/agent/fullCompaction/compactionOps.test.ts)。源码处于持续重构中，旧版类名与当前 v2 不应混用。
