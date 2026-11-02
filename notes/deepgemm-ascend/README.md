# DeepGEMM Ascend：接口兼容与 NPU 布局适配

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`3a35326271b069b8b5bf1a754435acd6cc91575b`（提交日期 2026-10-14）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

这是使用同一 deep_gemm 包名的 Ascend 实现。公开接口尽量对齐 GPU 版本，但矩阵原语、scale 打包、调度与 JIT 工具链针对 Ascend 重新实现。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| 公共接口 | [deep_gemm/__init__.py](../../code/deepgemm-ascend/deep_gemm/__init__.py) | 导出 NPU 版本算子与运行时配置 |
| 设备实现 | [deep_gemm/include/deep_gemm](../../code/deepgemm-ascend/deep_gemm/include/deep_gemm) | MAD 抽象、GEMM 与融合算子 |
| Host 扩展 | [csrc](../../code/deepgemm-ascend/csrc) | 参数处理、接口绑定与 JIT |
| 布局测试 | [tests/test_layout.py](../../code/deepgemm-ascend/tests/test_layout.py) | scale 与张量布局合同 |

## 主要执行链

```text
deep_gemm API → NPU 参数/布局适配
  → JIT / Bisheng → MAD 与 AIV/AIC 执行
  → epilogue → output
```

## 关键机制与扩展边界

上游说明每对 K 方向 UE8M0 scale 打包为 int16，并以 MN-major 存储；这与 NVIDIA 的 scale 表示不同。迁移时不能只替换包而沿用未经转换的量化张量。

实现把分形布局、对齐和地址计算封装到较低层，便于上层保留 API 形状。README 中 dense GEMM 的 full C 与单行 bias 还走不同 epilogue 处理，正确性验证要包括这些分支。

## 限制与注意事项

快照开发验证面向 Ascend 950、CANN 与 torch_npu 的特定组合。API 对齐不代表数值误差、性能、scale 格式或二进制兼容；这里未运行 NPU 测试。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/test_fp8_gemm.py](../../code/deepgemm-ascend/tests/test_fp8_gemm.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
