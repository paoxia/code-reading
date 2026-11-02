# AgentScope Java SubAgent：独立会话、恢复与取消

> 本轮复核：2026-11-02；本地源码 `1d8f9dc04e0e6c7e4d54074331cd5059a87cfa1d`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 核心抽象

[SubAgentTool](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/subagent/SubAgentTool.java) 把子 Agent 暴露为 AgentTool，[SubAgentProvider](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/subagent/SubAgentProvider.java) 提供 fresh Agent，[SubAgentConfig](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/subagent/SubAgentConfig.java) 配置执行与事件转发。

```text
父工具调用(message, optional sessionId)
  → 校验 message → 新建或继续子 session
  → 从 parentContext 构造 childContext
  → 清理父 active state / execution / recorder identity
  → provider.provide → 可选 load state
  → streamEvents 或普通 call
  → 保存子状态 → ToolResultBlock 返回父调用
```

## 为什么要 fresh Agent 与独立上下文

当前实现明确不让子 Agent 继承父 Agent 的 active state 或 session execution：构建 childContext 时清空 agentState、SessionRecorder、turn ID、SessionExportSink、SessionExecution 与 ExecutionIdentity 等，再单独记录父会话关联。

因此“继承 RuntimeContext”不等于共享父调用的全部运行对象。父子关联用于追踪，不应让子调用写入父调用 recorder 或错误占有父 Session 的执行身份。

## 状态恢复

未传 sessionId 时创建新会话；传入已有 sessionId 时加载子状态。恢复需要同时考虑 conversation context 与 Agent state，不能只重新创建对象后假定旧历史已自动存在。

Fresh 实例避免多个委托共享可变对象，但它本身不提供外部文件系统隔离。状态隔离、权限继承、sandbox 和工作区策略要在 Harness/Provider 层进一步检查。

## 流式转发与取消

配置决定使用事件转发还是普通调用。父工具订阅被取消时，SubAgentTool 通过 `doFinally(CANCEL)` 中断子 Agent；源码特意区分它与普通错误传播 cleanup，避免已失败 Agent 又被误当取消处理。

这对 timeout/retry 尤其重要：旧订阅如果只在父层结束，子 Agent 仍可能消耗模型 token、连接与线程。重试不仅是再次调用 provider，还必须先结算上一尝试。

## 记忆与压缩

Harness 的 [CompactionMiddleware](../../code/agentscope-java/agentscope-harness/src/main/java/io/agentscope/harness/agent/middleware/CompactionMiddleware.java)、[WorkspaceContextMiddleware](../../code/agentscope-java/agentscope-harness/src/main/java/io/agentscope/harness/agent/middleware/WorkspaceContextMiddleware.java) 与子 Agent 工具处于不同层。当前消息压缩、跨会话 memory 和子调用状态恢复不可混为一谈；是否共享工作区由具体配置决定。

## 推荐验证材料

先读 SubAgentTool.executeConversation，再追 load/call/save 与取消：[会话测试](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/tool/subagent/SubAgentToolSessionTest.java)、[取消测试](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/tool/subagent/SubAgentToolCancellationTest.java)、[超时重试测试](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/tool/subagent/SubAgentToolTimeoutRetryIntegrationTest.java)。本轮未执行这些测试。
