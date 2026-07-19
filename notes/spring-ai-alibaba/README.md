# Spring AI Alibaba

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
- [Multi-Agent 实现](./multi-agent.md)
- [Tool Calling 实现](./tool-calling.md)
- [Skills 实现](./skills.md)
- [Graph 运行时实现](./graph-runtime.md)

## 学习目标

- [x] 理解 ReactAgent、Tool Calling 与 Graph 的关系
- [x] 理解 Multi-Agent 和 Skills 的主要实现方式
- [x] 掌握 Graph Runtime 的流式执行与中断恢复细节
- [ ] 阅读各类生产级 Hook 和 Interceptor
- [ ] 学习设计模式和最佳实践
