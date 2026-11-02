# 跨项目总结

本轮更新于 **2026-11-02**，覆盖本地全部 48 个项目。单项目的源码架构与细节见 notes，各主题总结负责比较抽象边界、调用链和设计取舍；具体提交与浅克隆状态集中记录在项目总览。

## 项目全景与基础设施

- [全部项目总览与阅读路线](./project-landscape/overview.md)：6 个分类、48 个项目、研究重点与本地版本。
- [AI 基础设施分层与阅读路线](./ai-infrastructure/architecture-and-reading-guide.md)：推理引擎、算子、通信、JIT、训练调度和存储。

## Agent 运行时

- [Agent 上下文管理机制横向总结](./context-management/agent-context-management.md)
- [Agent Tool 调用与错误处理横向总结](./agent-tools/tool-execution-and-error-handling.md)
- [Agent Harness 设计与有效性验证](./agent-harness/design-and-validation.md)
- [Coding Agent 跨平台适配总览](./coding-agents/cross-platform-adaptation.md)

## 历史复核

- [2026-08-24 上游源码更新复核](./coding-agents/2026-08-24-source-update.md)：保留当时的更新规模与结论，当前状态以各项目本轮复核及项目总览为准。
