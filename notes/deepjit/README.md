# DeepJIT：跨后端内核编译、缓存与加载

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`18fe520b0473fc45d32d2f0e86923da707de19ab`（提交日期 2026-10-19）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

DeepJIT 是 header-only C++20 JIT 基础设施，统一 CUDA 与 Ascend 的编译、缓存、加载和启动流程。统一的是运行时接口，kernel source、编译器及 launch 参数仍由后端决定。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| C++ runtime | [include](../../code/deepjit/include) | Runtime、缓存与 CUDA/Ascend 后端 |
| 包资源 | [deep_jit](../../code/deepjit/deep_jit) | 提供依赖与运行时资源 |
| CUDA 示例测试 | [tests/test_cuda.py](../../code/deepjit/tests/test_cuda.py) | 扩展调用与编译流程 |
| Ascend 示例测试 | [tests/test_ascend.py](../../code/deepjit/tests/test_ascend.py) | NPU 后端的使用方式 |

## 主要执行链

```text
kernel source + includes + compile options
  → dependency/cache key → memory / disk cache
  → compiler（miss 时）→ load → launch on current stream
```

## 关键机制与扩展边界

缓存身份包括源码、追踪的 include、编译器版本、有效选项和应用依赖签名。因此缓存命中并不是“文件名相同”。共享目录还依赖 POSIX 文件系统语义，部署时必须把缓存合同与存储语义一起考虑。

懒初始化推迟设备和编译器发现，PyTorch 集成默认衔接 CUDA 或 torch_npu 当前 stream。对上层算子库来说，JIT 的职责是得到可执行内核，不替算子决定 tile 大小、算法正确性或工作负载调度。

## 限制与注意事项

README 将基于历史的 cache warmup、直接从 Python 传 source 编译列为 WIP，不能写成已发布功能。后端统一不表示 CUDA 源码能够直接在 Ascend 执行。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/test_exception.py](../../code/deepjit/tests/test_exception.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
