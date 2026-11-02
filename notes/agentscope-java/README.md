# AgentScope Java：调用级 ReAct、Harness 与协议扩展

> 本轮复核：2026-11-02；本地源码 `1d8f9dc04e0e6c7e4d54074331cd5059a87cfa1d`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 研究主线

AgentScope Java 以 Model、Msg、Tool、RuntimeContext 和 Agent 生命周期组织运行，再由 HarnessAgent 组合工作区、记忆、压缩、子 Agent 与沙箱。当前研究应先区分调用内状态、会话存储和宿主能力，不能只看一个 reasoning/acting 循环。

```text
call / streamEvents
  → 共享 Agent lifecycle 与 middleware
  → 获取本次 CallExecution / Session 状态
  → reasoning → tools → 下一轮或 final
  → 结算未完成调用 → 持久化 → 释放执行作用域
```

## 核心分层

| 层 | 当前源码 | 职责 |
| --- | --- | --- |
| Agent 内核 | [ReActAgent](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/ReActAgent.java) | 单次调用、模型/工具循环与结果 |
| Harness | [HarnessAgent](../../code/agentscope-java/agentscope-harness/src/main/java/io/agentscope/harness/agent/HarnessAgent.java) | workspace、memory、skill、subagents 等组合 |
| 模型 | [Model](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/model/Model.java) | 流式响应、工具与结构化输出能力 |
| 工具 | [Toolkit](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/Toolkit.java) | 注册、schema、执行和分组 |
| 子 Agent | [SubAgentTool](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/subagent/SubAgentTool.java) | 子会话与独立调用作用域 |
| 协议 | [A2A modules](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-protocol/agentscope-extensions-a2a/pom.xml) | 远程 Agent 的客户端与服务端 |

## 本轮关键变化

ReActAgent 目前通过共享 `buildAgentStream` 使 call 与 streamEvents 走相同生命周期，onAgent middleware 覆盖普通、结构化和流式调用。CallExecution 承载本次调用状态，不能用对象级“最后一次活跃调用”代表并发执行。

A2A 已迁到 SDK 1.4.0.Final，卡片使用 supportedInterfaces；默认接口协议版本的回归断言是 1.0。旧版 0.3.3.Final/0.3.0 与 `io.a2a.*` 说明已过时，见 [A2A 专题](./a2a.md)。

## 专题与阅读顺序

1. [ReAct 与调用生命周期](./react-architecture.md)
2. [Model API 适配](./model-api-adaptation.md)
3. [Tool、Skill 与动态披露](./tool-and-skill.md)
4. [SubAgent、状态恢复与隔离](./subagent.md)
5. [A2A 协议与部署边界](./a2a.md)

核心失败路径可对照 [失败持久化测试](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/agent/ReActAgentCallFailurePersistenceTest.java)。框架有相应抽象不表示每个应用已配好租户、沙箱、存储或分布式部署；这些配置和业务边界仍需单独验证。
