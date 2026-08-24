# AgentScope Java

## 项目信息

- **GitHub**: https://github.com/agentscope-ai/agentscope-java
- **描述**: Build distributed, production-grade, long-running agents
- **主要语言**: Java
- **默认分支**: main
- **2026-08-24 增量复核版本**: `main@c2d43f86e668`（`2.0.3-SNAPSHOT`）

## 项目概述

AgentScope Java 2.0 是一个生产级框架，用于构建分布式、企业级 Agent，提供关键抽象以适应不断增长的模型能力，并内置支持长期运行、安全控制的 Agent 执行。

本轮复核没有改变总体定位，但补强了 ReAct 终态语义：空的 final response 会重试而不是静默结束，模型调用失败时当前轮上下文仍会进入持久化，Middleware 改写后的 tools 会在模型调用前归一化。实现和回归测试分别位于 [`ReActAgent.java`](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/ReActAgent.java)、[`ReActAgentEmptyResponseRetryTest.java`](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/agent/ReActAgentEmptyResponseRetryTest.java) 与 [`ReActAgentCallFailurePersistenceTest.java`](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/agent/ReActAgentCallFailurePersistenceTest.java)。

## 核心特性

- 分布式 Agent 架构
- 生产级可靠性
- 长期运行支持

## 架构分析

- [ReAct 架构实现](./react-architecture.md) - 推理-行动循环的核心实现
- [Tool 与 Skill 实现](./tool-and-skill.md) - 工具定义、注册、调用流程，以及 Skill 与 Tool 的关系
- [SubAgent 实现](./subagent.md) - 子 Agent 架构、上下文管理、记忆系统、沙箱隔离

## 学习目标

- [x] 理解项目整体架构
- [x] 掌握核心模块功能（ReAct 循环 / Tool / Skill / SubAgent）
- [ ] 学习分布式 Agent 设计模式
