# FlashInfer：推理算子接口、执行计划与内核后端

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`ecb713c63c178e7fe195a38ece15e1eaa93804f5`（提交日期 2026-11-02）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

FlashInfer 位于推理引擎下方，提供 Attention、GEMM、采样、量化及相关算子。阅读重点是张量和缓存布局如何成为内核契约，以及重复运行时如何复用执行计划。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| Decode wrapper | [flashinfer/decode.py](../../code/flashinfer/flashinfer/decode.py) | 分页 KV decode、后端选择与计划 |
| Prefill wrapper | [flashinfer/prefill.py](../../code/flashinfer/flashinfer/prefill.py) | ragged/paged prefill 与 Attention 调用 |
| JIT | [flashinfer/jit](../../code/flashinfer/flashinfer/jit) | 按配置生成、编译和加载模块 |
| 设备实现 | [include/flashinfer](../../code/flashinfer/include/flashinfer) | CUDA 内核与公共基础设施 |

## 主要执行链

```text
引擎组批并准备 KV 页表
  → wrapper.plan（元数据、workspace、后端）
  → wrapper.run（Q/K/V 等张量）
  → 已编译或 JIT 内核 → 输出
```

## 关键机制与扩展边界

`BatchDecodeWithPagedKVCacheWrapper` 将计划阶段与运行阶段分开：页表、长度、布局和 workspace 会影响计划，Q 等数据张量在执行时传入。后端选择还涉及架构、dtype、shape 与 CUDA Graph 条件，不是一个适用于所有输入的固定 kernel。

源码还存在实验和专用模型路径。研究时应先从稳定 wrapper 与对应测试建立输入输出合同，再进入特定硬件内核；单独看到内核文件并不能说明公共接口一定会选中它。

## 限制与注意事项

算子库不负责 HTTP、请求排队、会话或集群调度。性能依赖硬件、shape、量化与 plan 重用方式；此处没有复现实测，也不转录上游性能数字。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/attention/test_deepseek_mla.py](../../code/flashinfer/tests/attention/test_deepseek_mla.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
