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

## 深入：一次 SM100 GEMM 的真实准备阶段

[sm100_fp8_fp4_gemm_1d1d](../../code/deepgemm/csrc/jit_kernels/impls/sm100_fp8_fp4_gemm_1d1d.hpp) 先构造 GemmDesc，记录 M/N/K、dtype、A/B 主序、累加项、SM 配置与编译维度；再由 get_best_config 选择 tile、pipeline 和 launch 配置。

```text
输入张量与 scale
  → GemmDesc → heuristics / GemmConfig
  → A/B/CD 与 scale 的 TMA descriptors
  → JIT 特化 + shared memory / grid / block / cluster
  → kernel 与 epilogue
```

A/B 的 stride 进入 TMA descriptor，scale 还带各自 K 粒度和布局信息。因此同样的数学矩阵乘法，如果 storage major、分组方式或 scale 粒度不同，会形成不同特化和描述符，不能只按 M/N/K 判定缓存可复用。

## 深入：初始化与退出也有设备资源语义

[lazy-init 与 shutdown 测试](../../code/deepgemm/tests/test_lazy_init.py) 覆盖本地扩展、fork 及 cuBLASLt 资源释放的部分边界。其中 shutdown probe 关注 handle 必须在底层 backend 已退出之前释放，并检查重复 shutdown 和关闭后不能悄悄重建 runtime。

这里的测试需要相应平台、扩展和编译器，本轮未运行。它提示阅读 JIT 算子库时除了编译与 launch，还需确认进程、设备和库析构顺序；Python 对象被回收不等于所有 native 资源天然按正确顺序退出。

## 限制与注意事项

不是完整模型执行器；GPU 架构和量化形状约束很强。融合算子的存在不代表对任意模型结构可直接替换，性能也不能脱离布局转换和编译成本比较。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/test_fp8_fp4.py](../../code/deepgemm/tests/test_fp8_fp4.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
