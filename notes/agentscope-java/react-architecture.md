# AgentScope Java ReAct 与调用生命周期

> 本轮复核：2026-11-02；本地源码 `1d8f9dc04e0e6c7e4d54074331cd5059a87cfa1d`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 核心对象

[ReActAgent](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/ReActAgent.java) 是执行内核，内部 `CallExecution` 保存每次调用的 state、permission engine、slot、上下文与事件等。[HarnessAgent](../../code/agentscope-java/agentscope-harness/src/main/java/io/agentscope/harness/agent/HarnessAgent.java) 组合更高层能力，而不是另一份独立 ReAct 算法。

## 从 call 到共享事件流

```text
call / streamEvents
  → buildAgentStream
  → AgentBase.runLifecycle
  → acquireCallExecution
  → CallExecution reasoning / tool execution
  → AgentResultEvent → AgentEndEvent
  → save / release
```

`callInternal()` 从共享事件流提取 AgentResultEvent 的最终 Msg，因此 call 和 streamEvents 经过同一个 onAgent middleware 边界。旧 stream API 的部分重载明确标记 Deprecated forRemoval，应优先阅读当前 streamEvents 与 call 链。

调用作用域通过 Reactor Context 传播，`scopeFrom()` 拒绝脱离调用生命周期的访问。它解决了“同一 Agent 对象上的上下文属于哪次调用”的问题，但同会话是否可并发仍要继续核对会话执行/序列化 gate，不能从对象可复用推导任意并发安全。

## reasoning 与 acting

reasoning 构造模型请求并处理流式 ChatResponse，工具调用进入 Toolkit/ToolExecutor；没有工具时进入 final 判断。空 final 有专门恢复逻辑，迭代限制、结构化输出与取消也会改变终态，模型一条文本不总是完整任务结果。

Middleware 横跨 agent、model 和 tool 等阶段，应明确每个 hook 包裹哪一层调用。事件 delta 供观察，最终 Msg 供结果使用，持久化记录又有独立事实语义；不能用流中最后一段文本代替正式终态。

## 失败、取消与保存

`saveStateAfterCallFailure()` 与取消清理保证失败时仍尝试保存可恢复事实，并处理未结束工具的结果配对。保存失败还可能与原始调用异常共同形成恢复问题，不能把 finally/cleanup 当作无条件成功。

验证材料：[空响应重试](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/agent/ReActAgentEmptyResponseRetryTest.java)、[失败持久化](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/agent/ReActAgentCallFailurePersistenceTest.java)。本轮仅阅读测试。

## 扩展与限制

HarnessAgent 在 delegate 上组合 workspace、memory、compaction、sandbox lifecycle、plan 和 skill curator。优先通过这些扩展层添加能力，再判断是否需要改核心循环；工具权限、外部副作用幂等和业务完成验收仍由具体运行环境负责。
