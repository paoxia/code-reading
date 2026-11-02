# DeepSpec：投机解码的草稿模型训练与评估

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`005e03b81cec38b7da6399833d609ee89a2587f2`（提交日期 2026-07-09）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

DeepSpec 研究如何训练并评估 speculative decoding 的草稿模型，主链是数据准备、target cache、draft training 和接受行为评估。它不是独立在线 serving 引擎。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| 训练入口 | [train.py](../../code/deepspec/train.py) | 解析配置并启动多 GPU worker |
| BaseTrainer | [deepspec/trainer/base_trainer.py](../../code/deepspec/deepspec/trainer/base_trainer.py) | 模型、数据、FSDP、训练与 checkpoint |
| Draft models | [deepspec/modeling](../../code/deepspec/deepspec/modeling) | DSpark 与 Eagle3 等模型实现 |
| BaseEvaluator | [deepspec/eval/base_evaluator.py](../../code/deepspec/deepspec/eval/base_evaluator.py) | 生成与验证公共逻辑 |
| DSpark proposal | [deepspec/eval/dspark/draft_ops.py](../../code/deepspec/deepspec/eval/dspark/draft_ops.py) | 草稿候选与置信前缀 |

## 主要执行链

```text
prompts → target answers → target cache
  → draft trainer → draft checkpoint
  → evaluator.propose → target verify → update
  → 接受行为与任务统计
```

## 关键机制与扩展边界

算法与 target family 由配置共同决定，不是只换一个模型文件。BaseTrainer 负责公共训练生命周期，具体 trainer 实现 batch loss；评估中 proposal、verify 和 update 是独立边界。DSpark 的 confidence head 用来选择草稿前缀，不能把草稿长度直接当作接受长度。

上游还列出 DFlash；阅读时应继续追踪配置复用关系，而不要仅按目录名推断支持算法。训练数据的 target、thinking mode 和评估采样配置都会影响可比性。

## 限制与注意事项

target cache 可能很大；接受率不能直接推导生产端到端加速比。该源码提供的训练与评估闭环不等于所有 serving 框架已集成相同算法。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [eval.py](../../code/deepspec/eval.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
