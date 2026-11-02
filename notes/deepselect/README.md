# DeepSelect：按行 TopK、变长区间与后端合同

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`bfa4507d935f17ebfc3d0f00ff7d3c9a4d0e5c18`（提交日期 2026-09-30）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

DeepSelect 针对 sparse Attention 和采样中的 TopK 选择提供设备实现。它的核心不是全排序，而是每行在有效区间内返回少量高分元素及索引。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| topk | [deep_select/interface.py](../../code/deepselect/deep_select/interface.py) | 后端加载、对齐分配和参数传递 |
| 公共入口 | [deep_select/__init__.py](../../code/deepselect/deep_select/__init__.py) | 导出 topk 与 stride requirement |
| 设备后端 | [csrc](../../code/deepselect/csrc) | 选择算法与扩展实现 |

## 主要执行链

```text
scores + optional end + k
  → aligned output allocation → backend.topk
  → selected values（可选）+ indices
```

## 关键机制与扩展边界

接口支持用 end 指定每行有效右边界、索引偏移、输出复用以及不足 k 个元素时的填充值；begin/hint 当前要求为 None。输出可能因为 32-byte 对齐而不连续，因此后续算子不能只假设 `[batch, k]` 就一定 contiguous。

输入验证与 fallback 还有后端差别，docstring 明确记录某些 CUDA 分支的检查范围。研究契约时要连同边界行、空区间及填充值一起看，而不是只比较一般随机输入的结果。

## 深入：参数存在、实际支持与后端限制

[topk](../../code/deepselect/deep_select/interface.py) 保留 begin/hint 参数，但目前直接 assert 它们为 None，不能把签名中出现这两个名字写成已支持任意左边界和 hint。

| 参数/结果 | 当前实际边界 |
| --- | --- |
| begin / hint | 必须为 None |
| end | 每行有效右边界，调用方保证不超出 vocab_size |
| sorted | 值排序仅支持对应 FP32 路径；Ascend 只支持 False |
| indices_type | CUDA 可用 int32/int64，Ascend 限 int32 |
| return_value=False | 仍返回二元组，第一项是 None |
| 输出 stride | 根据后端字节对齐要求向上取整后切片，未必 contiguous |

`sorted` 与 `sorted_index` 分别控制值与索引顺序，不能将二者当作同一选项。输出 padding 的无效索引也不叠加 output_idx_offset。

## 深入：NaN 处理不能只看公共开关

NaN 检查不是由 abort_when_nan_found 决定是否开启；该参数决定发现后的动作。CUDA 与 Ascend 对 sentinel 写入范围及短行检查存在差别，源码 docstring 已明确记录。下游应按所选后端解释结果，不能以“返回了 indices tensor”作为输入全合法的证明。

后端选择在导入时依据设备平台探测，失败会提示对应构建目标；它不是在每次 topk 时根据输入 tensor 自动混合选择多个已加载后端。

## 限制与注意事项

TopK 的区间、排序保证和异常处理应以当前接口与测试为准，不应自动套用 torch.topk 的全部语义。它不负责 Attention 数学、KV 分配或模型采样策略本身。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/test.py](../../code/deepselect/tests/test.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
