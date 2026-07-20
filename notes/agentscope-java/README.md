# AgentScope Java

## 项目信息

- **GitHub**: https://github.com/agentscope-ai/agentscope-java
- **描述**: Build distributed, production-grade, long-running agents
- **主要语言**: Java
- **默认分支**: main

## 项目概述

AgentScope Java 2.0 是一个生产级框架，用于构建分布式、企业级 Agent，提供关键抽象以适应不断增长的模型能力，并内置支持长期运行、安全控制的 Agent 执行。

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