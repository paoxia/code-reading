# MCode Stack：Agent 工程工作流与技能组织

> 收录与静态阅读日期：2026-11-15。本地源码版本 `0db1b4fb3b6270e173080d87b72c28516b299ddd`，提交日期 2026-11-11，完整克隆。未安装插件、运行安装脚本或执行上游测试。

## 项目定位

[MiniMax-AI/mcode-stack](https://github.com/MiniMax-AI/mcode-stack) 保存 MiniMax Code 团队的工程工作流、技能和检查清单。这里的研究重点是如何把工程规则组织为可按需加载的能力，以及哪些规则由脚本执行；MiniMax Code 本体位于另一个仓库。

从 [中文说明](../../code/mcode-stack/README_ZH.md) 和各 stack 的清单进入，再跟踪具体脚本。团队的使用经验与本地可以验证的程序行为分别理解，安装成功也不等于任务质量已经提高。

## 目录与职责

| 入口 | 职责与阅读重点 |
| --- | --- |
| [ronny 工作流](../../code/mcode-stack/stacks/ronny/WORKFLOW.md) | 按任务阶段选择规划、交接、审查、上下文审计和实验技能 |
| [jiachen 工作流](../../code/mcode-stack/stacks/jiachen/WORKFLOW.md) | PR 审查、本地与 CI 配合，以及工作流改进 |
| [req-tpm 工作流](../../code/mcode-stack/stacks/req-tpm/WORKFLOW.md) | 需求受理、优先级、设计、跟进、交付和效果复核；上游标注为 v0，依赖飞书与 Meegle |
| [youfang 工作流](../../code/mcode-stack/stacks/youfang/WORKFLOW.md) | 架构与流程讲解的 HTML 演示制作 |
| [插件市场清单](../../code/mcode-stack/.claude-plugin/marketplace.json) | 将 stack 注册为插件，指向各自的本地目录 |
| [另一份市场清单](../../code/mcode-stack/.agents/plugins/marketplace.json) | 描述插件来源、可用性与安装认证策略 |
| [安装脚本](../../code/mcode-stack/scripts/install.sh) | 根据本机 CLI 选择插件安装或复制技能 |
| [仓库检查脚本](../../code/mcode-stack/scripts/check.mjs) | 核对清单、技能 frontmatter、版本和可选的官方插件校验 |

## 安装流程的实际行为

`scripts/install.sh` 校验 stack 名称及技能目录，然后独立探测 `claude` 和 `codex`：

```text
选择 stack，默认 ronny
  → claude 在 PATH：执行其插件安装
  → codex 在 PATH：添加市场并安装对应插件
  → 两者都不在 PATH：复制技能到 ~/.agents/skills/
```

两种 CLI 的判断并非互斥；两者都存在时会依次执行。脚本启用 `set -euo pipefail`，前面的安装失败会中断后续流程。复制回退会先删除同名目标目录再复制，因此研究或选择单个技能时需要看清这一行为。本次仅阅读，没有执行安装。

## 值得优先研究的机制

- [handoff-doc](../../code/mcode-stack/stacks/ronny/skills/handoff-doc/SKILL.md)：先核对 Git、差异与真实验证结果，再保存目标、决策、约束、当前状态和下一步，适合研究跨会话交接。
- [evidence-first-review](../../code/mcode-stack/stacks/ronny/skills/evidence-first-review/SKILL.md)：区分实际命令证据与总结，并写清每项检查证明了什么、仍未覆盖什么。
- [harness-experiment](../../code/mcode-stack/stacks/ronny/skills/harness-experiment/SKILL.md)：固定实验条件、一次修改一个因素，重复观察成功率、任务翻转、请求数、token、缓存与耗时。
- [PR 审查裁决代码](../../code/mcode-stack/stacks/jiachen/ci/core/verdict.mjs)：将部分最终状态交给确定性规则计算，便于与纯提示词约定比较。

这些技能文件是研究材料，本次收录不代表已安装、启用或将其规则并入 Second Brain 的规约。

## PR 审查裁决的程序边界

`computeVerdict()` 接收 findings、待人工处理项、连续阻断轮数和未完成数量：连续阻断达到三轮时返回 `needs_human`；否则先判断阻断 finding，再判断未解决的人工事项或未完成审查，最后才允许 `pass`。退出码分别为 11、10 和 0。

同一文件还提供跨审查视角的问题合并、延迟发现标记和轮次计数。这里能确认的是状态转换与合并规则；finding 的正确性仍取决于上游采集、模型分析与证据核验，不能仅凭脚本返回 `pass` 推断代码没有问题。

## 检查与验证边界

`scripts/check.mjs` 的静态检查覆盖技能目录与 manifest 对应关系、名称和 description 等字段；配置 `CHECK_BASE` 后才检查受影响 stack 的版本增长，配置 `MINIMAX_CODE_DIR` 后才调用相应官方校验器。

本次没有运行这些检查，也没有评估技能对任务成功率或成本的影响。后续若借鉴到自己的工作流，应以小范围对照实验记录效果，而不是直接引用上游经验作为本地结果。

许可证以 [LICENSE](../../code/mcode-stack/LICENSE) 和各 stack 的 NOTICE 为准；`engineering-*` 改编内容有单独的授权说明。

## 后续阅读

先读 ronny 的工作流与上述三个技能，再读安装与检查脚本，最后进入 jiachen 的 CI 裁决。可与 [Better Harness 笔记](../better-harness/README.md) 对比证据、评估和修复闭环，与 [Caveman 笔记](../caveman/README.md) 区分行为规则与程序化上下文处理。
