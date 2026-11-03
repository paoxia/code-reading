# Spring AI Alibaba

## 2026-11-02 复核与当前定位

- 本地源码：`17e26ff6fe951d605771c1845229ca3edb043634`（提交日期 2026-10-07）。
- 核对方式：本地源码、调用入口与测试材料静态阅读；未运行上游构建或测试。下文早期日期与版本号保留作研究历史，本节记录本轮基线与修订边界。

ReactAgent 仍以 AgentLlmNode 与 AgentToolNode 组装有状态图，CompiledGraph 承担运行。Hook 改变图阶段，Model/Tool Interceptor 包裹具体调用；Skill 的渐进披露和工具授权要分别理解。

当前入口：[spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/ReactAgent.java)、[spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompiledGraph.java](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/CompiledGraph.java)。

## 项目信息

- **GitHub**: https://github.com/alibaba/spring-ai-alibaba
- **描述**: Agentic AI Framework for Java Developers
- **主要语言**: Java
- **默认分支**: main

## 项目概述

Spring AI Alibaba 是构建 Agent、工作流和多 Agent 应用的 Java 框架。它以
`spring-ai-alibaba-graph-core` 为运行时基础，在其上提供 `ReactAgent`、工具调用、
Hooks、Interceptors、Skills 以及 Sequential、Parallel、Loop、Routing 等组合模式。

## 核心特性

- 基于状态图实现 ReAct 推理—行动循环
- 支持同步、异步和并行 Tool Calling
- 支持 Checkpoint、会话状态、中断与恢复
- 支持确定性工作流和 LLM 驱动的多 Agent 协作
- 支持基于 `SKILL.md` 的渐进式技能披露

## 阅读笔记

- [ReactAgent 总览：Multi-Agent、Tool Calling、Skills 与 Graph](./react-agent-architecture.md)
- [Hook 与 Interceptor：执行层级、调用链与选型](./hook-and-interceptor.md)
- [Multi-Agent 实现](./multi-agent.md)
- [Tool Calling 实现](./tool-calling.md)
- [Skills 实现](./skills.md)
- [Graph 运行时实现](./graph-runtime.md)
- [生产运行能力：横切扩展、持久化、可观测性与 A2A](./production-capabilities.md)

## 学习目标

- [x] 理解 ReactAgent、Tool Calling 与 Graph 的关系
- [x] 理解 Multi-Agent 和 Skills 的主要实现方式
- [x] 掌握 Graph Runtime 的流式执行与中断恢复细节
- [x] 阅读各类生产级 Hook 和 Interceptor
- [x] 理解 Checkpoint、长期 Store、Observation 与 A2A 的边界
- [ ] 学习设计模式和最佳实践
