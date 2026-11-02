# DeepGEMM：低精度 GEMM、分组计算与 JIT 内核

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`5081f8513af57e61696de4f4f04b0e707ffb503e`（提交日期 2026-10-20）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

DeepGEMM 在 Python 接口、C++ 特化选择和设备内核之间建立窄接口，涵盖 BF16、FP8/FP4、grouped GEMM，以及部分 Attention、MoE 与 Hyperconnection 算子。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| 公共接口 | [deep_gemm/__init__.py](../../code/deepgemm/deep_gemm/__init__.py) | 导出 dtype/布局变体并初始化扩展 |
| 特化与启发式 | [csrc/jit_kernels](../../code/deepgemm/csrc/jit_kernels) | 根据架构、shape 和布局选择实现 |
| 设备内核 | [deep_gemm/include/deep_gemm](../../code/deepgemm/deep_gemm/include/deep_gemm) | GEMM、调度与融合算子 |
| Mega 接口 | [deep_gemm/mega](../../code/deepgemm/deep_gemm/mega) | MoE 等融合执行入口 |

## 主要执行链

```text
Python op(A, B, scales, output)
  → C++ 参数与布局检查 → heuristics
  → JIT 特化 / cache → kernel launch → output
```

## 关键机制与扩展边界

公共接口区分 NT/NN/TN/TT、contiguous/masked 和分组方式，这些是数据布局与执行语义，不只是函数别名。低精度输入还带 scaling factors；只匹配 dtype 而忽略 scale 的打包、对齐和主序会违反内核合同。

`__init__.py` 仍兼容部分旧接口并尝试加载 A100 legacy Triton kernels，说明新旧硬件路径并存。应从当前导出的函数追到对应 C++ 特化，再阅读测试生成器如何构造合法输入。

## 限制与注意事项

不是完整模型执行器；GPU 架构和量化形状约束很强。融合算子的存在不代表对任意模型结构可直接替换，性能也不能脱离布局转换和编译成本比较。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/test_fp8_fp4.py](../../code/deepgemm/tests/test_fp8_fp4.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
