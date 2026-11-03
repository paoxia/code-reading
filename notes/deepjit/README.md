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

## 深入：内存命中、磁盘命中与编译是不同路径

[Runtime.compile](../../code/deepjit/include/deep_jit/runtime/runtime.hpp) 合并默认与覆盖选项后计算 cache key，再进入 memory cache；未命中时查询 disk entry，必要时编译，最后加载 Kernel。`compile_without_load()` 只产生磁盘产物，不保证设备模块已经加载。

cache key 包括 extra_signature、编译器身份、有效编译选项、post-hook 与源码/include 哈希；磁盘目录还用 name/tag 区分。修改外部依赖却没有纳入被追踪 include 或 extra_signature，不能指望仅靠相同函数名自动识别。

## 深入：共享缓存如何避免读到半成品

[DiskCacheEntry](../../code/deepjit/include/deep_jit/cache/disk.hpp) 的 miss 先建立 `<root>/tmp/<uuid>`。编译完成后写 `.committed`、同步目录，再整体 rename 到 `<root>/cache/<tag>.<digest>`；查找只接受带完成标记的目录。正常异常路径通过析构清理未提交临时目录，突然结束进程则不保证析构运行。

多个 rank 可能同时编译同一个 key：发布时后到者处理 rename 竞争并使用已有目标。这个设计避免把半成品当成命中，但不等于在所有进程间只会编译一次。

[MemCache](../../code/deepjit/include/deep_jit/cache/memory.hpp) 本身是 unordered_map 和 shared_ptr 的 get-or-create，没有在该类内实现互斥。磁盘原子发布与同一个 Runtime 对象的线程安全是两个问题，不能用前者证明后者。

## 限制与注意事项

README 将基于历史的 cache warmup、直接从 Python 传 source 编译列为 WIP，不能写成已发布功能。后端统一不表示 CUDA 源码能够直接在 Ascend 执行。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/test_exception.py](../../code/deepjit/tests/test_exception.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
