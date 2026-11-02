# Caveman：压缩、CCR 恢复与当前产品边界

> 本轮复核：2026-11-02；本地源码 `2e068f735253cce28256744804785f01887d9646`（提交日期 2026-11-01）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 当前定位与版本变化

Caveman 叠加到已有 Agent 上，通过响应规则、上下文压缩、Proxy、MCP 和宿主集成降低输入输出体积。当前 README 已扩展到 Auto、Blocks、Waste fixes 与 Browse 等产品面，不能再用早期两个模块穷尽整个产品。

旧笔记的重要纠正是许可证：本地 [LICENSING.md](../../code/caveman/LICENSING.md) 明确从 3.0.0 起仓库统一采用 Apache-2.0；早期 MIT/BSL 分区描述仅适用于当时发布版本。Cloud 仍是独立商业软件，不在此仓库中。这里仅记录仓库声明，不对第三方发布作法律判断。

## 分层与入口

| 层 | 源码 | 职责 |
| --- | --- | --- |
| 行为规则 | [skills](../../code/caveman/skills) | 要求模型用简练表达生成回答 |
| CLI | [CLI](../../code/caveman/packages/cli/src/index.ts) | 安装、配置、启停及宿主接入 |
| Engine | [engine.go](../../code/caveman/engine/engine.go) | Detect、Compress、Retrieve、Stats 与 Simulate |
| CCR | [CCR store](../../code/caveman/engine/ccr) | 保存原文、恢复句柄与存储边界 |
| Proxy | [proxy](../../code/caveman/proxy) | Provider 请求处理和用量/会话观测 |
| Shrink / MCP | [shrink.go](../../code/caveman/shrink/shrink.go)、[mcp](../../code/caveman/mcp) | schema 压缩和模型可调用的恢复入口 |

旧 `cacheengine`、`rewriter`、`packages/agent` 等目录已不在当前树中，不再保留为现行架构模块。

## 压缩与恢复主链

```text
宿主工具结果 / Provider 请求
  → 内容检测 → compressor registry → 安全分类
  → 压缩是否更小？是否允许有损？
  → 需要 CCR：先保存原文 → 返回压缩体与恢复句柄
  → 条件不满足：原文透传
```

`Engine.Compress()` 明确保留原文作为默认结果。record mode、不支持内容、解析失败、压缩后不更小、未知安全分类、无法保证有损恢复时，均退回原始内容。`New()` 允许不带 store，但在没有外部恢复保证时不能执行依赖 CCR 的有损压缩。

`Simulate` 是不修改存储状态的离线预估。预估 token、Provider 计费 token、缓存折扣和最终任务正确率是不同指标，不能把字节减少直接称为账单节省。

## Skill、Proxy 与 Loop 的边界

Skill 改变回答风格，不提供 byte-exact 恢复。Engine/CCR 处理送入模型前的内容，恢复能力来自保存的原文及可用句柄。两条路径不能混作一种“摘要”。

本地 Proxy 的存在也不代表所有模型请求在本机执行：它仍连接所选 Provider。Auto 等托管功能与本地 Engine 的边界应以当前配置和公开实现分别核对，不能从 CLI 命令推断未公开服务代码。

## 扩展与限制

压缩器由 registry 与 safety class 管理，调用面共享核心 Engine。对新内容类型的扩展至少需要定义检测、压缩、计量与恢复前提；只删文本而没有恢复合同会破坏后续工具使用。

本轮不转录 README 的节省百分比，也未运行 benchmark。继续阅读 [Engine 实现与测试](../../code/caveman/engine)、[Proxy 会话与计量存储](../../code/caveman/proxy/internal/store)、[评估材料](../../code/caveman/evals)，分别验证输入减少、上下文有效性及实际用量。
