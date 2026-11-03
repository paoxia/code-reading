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

## 深入：验证的是连续接受前缀

[verify_draft_tokens](../../code/deepspec/deepspec/eval/base_evaluator.py) 要求 proposal 从当前已接受 token 开始，并校验草稿长度、logits 维数和词表大小。目标模型一次验证当前 token 与草稿序列，然后对每个草稿 token 比较目标/草稿概率。

```text
draft tokens + q(token)
  → target forward 得到 p(token)
  → min(1, p/q) 接受判定
  → cumprod：只保留第一次拒绝之前的连续前缀
  → 拒绝处 residual sampling / 全接受后的目标采样
  → 写入有效 token → crop target KV → 更新 draft context
```

后面的 token 即使单独通过随机接受，也不能越过先前的拒绝进入本轮提交。由此，按位置接受率、整轮接受长度和生成 token 数是不同指标。

## 深入：为什么常见的 accepted+1 也有例外

正常一轮推进已接受草稿再加一个目标 token；若接受前缀里已出现 stop token，generate_decoding_sample 会截到该位置并裁剪 KV，不再把多余 next token 计入有效输出。proposal length、accepted draft length 与 acceptance length 在统计中分别记录。

`assert_no_final_target_layer()` 还禁止把最终 decoder layer 当作普通 hidden-state cache 来源：Transformers 的该位置包含最终归一化输出，而数据准备保存的是原始层输出。训练 cache 与评估隐藏状态必须语义一致，仅 shape 相同不够。

本轮是源码推导，没有运行训练或接受率实验，也不据该公式直接声称生产端到端加速。

## 限制与注意事项

target cache 可能很大；接受率不能直接推导生产端到端加速比。该源码提供的训练与评估闭环不等于所有 serving 框架已集成相同算法。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [eval.py](../../code/deepspec/eval.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
