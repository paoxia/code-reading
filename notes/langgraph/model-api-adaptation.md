# 大模型 API 差异适配

## 2026-11-02 复核与当前定位

- 本地源码：`ee3c043bddcc514012885167dd5916b15d6e4731`（提交日期 2026-11-01）。
- 核对方式：本地源码、调用入口与测试材料静态阅读；未运行上游构建或测试。下文早期日期与版本号保留作研究历史，本节记录本轮基线与修订边界。

StateGraph 是声明层，PregelLoop 处理任务推进、channel 更新与 checkpoint。持久化保存的是图执行状态，是否能安全重做外部动作仍由节点的业务幂等合同决定，interrupt 也不等同于普通异常重试。

当前入口：[libs/langgraph/langgraph/graph/state.py](../../code/langgraph/libs/langgraph/langgraph/graph/state.py)、[libs/langgraph/langgraph/pregel/_loop.py](../../code/langgraph/libs/langgraph/langgraph/pregel/_loop.py)。

本专题继续从 [main.py](../../code/langgraph/libs/langgraph/langgraph/pregel/main.py)、[protocol.py](../../code/langgraph/libs/langgraph/langgraph/pregel/protocol.py) 进入；涉及已迁移的运行时，以本节和项目总览中的当前路径为准。

## 结论

LangGraph 本身不实现大模型 Provider 适配，而是把模型节点当作 `Runnable` 执行；API 差异通常由 LangChain 的 `BaseChatModel` 及各 provider 集成包解决。LangGraph 负责图调度、状态、checkpoint、interrupt 和流事件，不负责把 OpenAI 请求转换成 Anthropic 请求。研究版本：`30c4d58`。

## 源码边界

Pregel 执行器面向通用 `Runnable`/`RunnableConfig`，节点既可以是模型，也可以是普通函数或子图（[`main.py`](../../code/langgraph/libs/langgraph/langgraph/pregel/main.py)、[`protocol.py`](../../code/langgraph/libs/langgraph/langgraph/pregel/protocol.py)）。运行时只需要节点遵守 LangChain Runnable 的调用与流式事件约定，因此模型 SDK、鉴权、消息格式、工具 schema 和 usage 映射不会进入图引擎核心。

这种设计提供的是间接兼容：只要某个模型被适配为 `Runnable`，就能进入同一张图；切换 provider 通常替换模型节点或通过 `RunnableConfig` 传入运行时配置。流式传播能转发 `BaseChatModel.invoke` 等子调用事件，但不会重新解释 provider 原生 chunk（[`main.py`](../../code/langgraph/libs/langgraph/langgraph/pregel/main.py)）。

## 模型事件进入图运行时的路径

```text
graph node (Runnable)
  → BaseChatModel.invoke/stream
  → LangChain provider adapter
  → AIMessage / stream events
  → Pregel task result
  → channel/state reducer
  → checkpoint / downstream node
```

LangGraph 可以透传子 Runnable 的 stream events，但 checkpoint 保存的是图 state/channel value，不会自动把 provider 原生连接状态、SSE cursor 或 SDK client 持久化。恢复执行时模型节点会重新调用其 adapter；所谓 durable execution 不等于恢复半截模型 HTTP stream。

如果 state reducer 保存 `AIMessageChunk` 而不是最终 `AIMessage`，重放时可能重复合并 tool arguments。模型调用异常也要区分 node retry policy 与 provider client 自带 retry，避免同一请求在两层重复。多 provider fallback 最适合封装成明确 Runnable，输出同一标准消息合同。

## 注意事项

- LangGraph 的 provider-neutral 不等于不同模型行为等价；工具调用、结构化输出、并行工具、推理块和上下文窗口仍由模型适配层决定。
- 图状态若直接保存 provider 原生对象，会削弱可移植性；更稳妥的是保存 LangChain 标准消息或业务状态。
- 需要多 provider failover 时，应在模型节点、Runnable 路由或上层应用实现，而不是期待 Pregel 自动转换协议。
