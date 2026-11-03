# DualPipe：双向流水线与前后向重叠调度

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`030ce4325f4ebeb437da4ebc6d00a70469dd58ae`（提交日期 2026-01-14）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

DualPipe 为训练流水线安排双向 micro-batch 流动，通过特定调度减少气泡并为计算通信重叠创造机会。DualPipeV 是另一种 stage 到 rank 的映射方案。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| DualPipe | [dualpipe/dualpipe.py](../../code/dualpipe/dualpipe/dualpipe.py) | 双向 stage 的训练 step 与通信排布 |
| DualPipeV | [dualpipe/dualpipev.py](../../code/dualpipe/dualpipe/dualpipev.py) | V 形映射和 step 调度 |
| 通信 | [dualpipe/comm.py](../../code/dualpipe/dualpipe/comm.py) | send/recv 等进程间操作 |
| 辅助组件 | [dualpipe/utils.py](../../code/dualpipe/dualpipe/utils.py) | 梯度等公共逻辑 |

## 主要执行链

```text
micro-batches → warmup
  → 双向 forward / backward / communication
  → 可选 overlapped_forward_backward
  → drain → gradients / losses
```

## 关键机制与扩展边界

每个包装器持有两个 module chunk，并检查它们是否提供 `overlapped_forward_backward`。没有专用方法时执行常规路径；具备方法时才交给模型定制的重叠实现。调度器的“可重叠窗口”与实际模型能否隐藏通信成本必须分开评价。

`step()` 控制 micro-batch 顺序和前后向资源使用，通信封装管理跨 rank 数据传递。因此阅读时先固定 PP rank/stage 数和 micro-batch 数，再绘制一个小配置的执行表。

## 深入：step 的前提不是任意 micro-batch 数

[DualPipe.step](../../code/dualpipe/dualpipe/dualpipe.py) 要求先设置 P2P tensor shapes/dtype，rank 数为偶数；num_chunks 必须为正偶数且至少是 `2×num_ranks`。它把输入分成 half_num_chunks，以两个方向组织执行，不能把该参数不加解释地等同为单向流水线的微批数量。

forward_only 由 `torch.is_grad_enabled()` 决定，不是仅调用 module.eval() 就自动切换。训练时首尾 rank 还需要 criterion，首尾返回的 loss/output 对应从另一端进入的数据方向。

## 深入：通信提交、计算与张量释放

[comm](../../code/dualpipe/dualpipe/comm.py) 先累计 isend/irecv 操作；forward/backward helper 在消费对应输入前执行提交与等待。定制 overlapped_forward_backward 提供的是模型计算交错位置，不意味着可以省略这些通信依赖。

zero-bubble 路径将部分 weight gradient 工作放入 FIFO 的 WeightGradStore，之后由 `_weight_chunk()` 取出执行。`_free_tensors()` 还要求被释放的 stage 输出不是 view tensor，说明输出别名会影响内存生命周期。

因此阅读调度表时应同时标记 forward、activation backward、weight backward、通信等待与释放，而不是只按 F/B 两种方块估算内存和气泡。

## 限制与注意事项

真实模型需自行实现定制重叠方法，上游示例不能证明任意模型自动获得相同速度。这里讨论训练流水线，不等同于 serving 的 prefill/decode 连续批处理。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [examples/example_dualpipe.py](../../code/dualpipe/examples/example_dualpipe.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
