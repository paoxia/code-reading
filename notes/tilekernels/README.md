# TileKernels：TileLang 算子、量化与硬件分派

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`c1cf914a82e6901c679445f872051ce44ac2cc63`（提交日期 2026-10-14）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

TileKernels 用 TileLang 表达算子并配合 Python 包装和硬件专用实现。它覆盖 quant、MoE、Engram、mHC、transform 等模型组件，适合研究模型数学到设备布局之间的映射。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| 公共入口 | [tile_kernels/__init__.py](../../code/tilekernels/tile_kernels/__init__.py) | 加载模块与全局执行配置 |
| 配置 | [tile_kernels/config.py](../../code/tilekernels/tile_kernels/config.py) | 设备核数、对齐与确定性策略 |
| 量化 | [tile_kernels/quant](../../code/tilekernels/tile_kernels/quant) | cast、scale、norm 与激活相关算子 |
| MoE | [tile_kernels/moe](../../code/tilekernels/tile_kernels/moe) | 路由和 token 变换相关实现 |
| Engram | [tile_kernels/engram](../../code/tilekernels/tile_kernels/engram) | hash、gate 与融合实现 |

## 主要执行链

```text
model layer → Python wrapper / platform dispatch
  → TileLang kernel specialization
  → layout / quantization / device execution → tensor
```

## 关键机制与扩展边界

同一算子附近常有 `_kernel`、`_cuda`、`_asc` 文件，分别承载核心表达与不同设备路径。应从公开入口追踪当前分派结果，不能根据文件名断言所有功能在所有设备上等价。

量化要同时关注 tensor 数值、scale 格式和内存布局；例如 per-token 与 per-block 的统计/还原语义不同。配置中的 alignment、核数与 deterministic 开关也会参与执行策略。

## 深入：以 per_block_cast 跟踪包装层到设备分派

[per_block_cast_impl](../../code/tilekernels/tile_kernels/quant/per_block_cast_kernel.py) 校验二维连续输入、维度对齐以及预分配输出，再生成输入/输出格式配置并选择 CUDA 或 Ascend kernel。这里可看到三种不同合同：

| 模式 | 控制参数 | 返回 |
| --- | --- | --- |
| 只统计 scale | sf_only=True | scale tensor |
| 已有 scale 的 cast | sf 非空 | 量化输出 tensor |
| 同时量化与统计 | 其他情况 | `(out_x, out_sf)` |

这些返回形状由参数决定，不宜在上层一律解包成二元组。提供 sf 时还不能同时请求某些 packed/TMA layout 模式，预分配 out_x 的地址需要满足 16-byte 对齐。

## 深入：共享包装层不意味着同一后端支持矩阵

当前 [CUDA kernel](../../code/tilekernels/tile_kernels/quant/per_block_cast_cuda.py) 支持的 scale block 维度组合，与 [Ascend kernel](../../code/tilekernels/tile_kernels/quant/per_block_cast_asc.py) 中限定的 `(32,32)` 不同；Ascend 还显式限制目标低精度类型。CUDA 的 PDL 设置与 NPU vector/core 的配置也是不同分派参数。

所以“同一个 Python 函数名”和“相同模型数学”不足以证明平台等价。应沿 wrapper 的配置对象追到具体 kernel 的 assert、scale store 与输出 epilogue，再对照数值测试。

## 限制与注意事项

本项目不是 serving 引擎，也不是所有 PyTorch 算子的通用替换。专用 kernel 的 shape、dtype 与架构前提应逐个阅读；测试目录给出数值合同，尚未在此运行。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/quant](../../code/tilekernels/tests/quant) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
