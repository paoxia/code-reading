# DeepEP Ascend：EP Buffer 与 NPU 通信后端

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`3b25377d04b24fc6154698ded78a2bcb2c59afff`（提交日期 2026-09-29）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

DeepEP Ascend 将 EP dispatch/combine 以及其他 buffer API 对齐到 Ascend。公共 Python 层相近，底层依靠 HCCL/HCOMM、UBMEM、URMA 和运行时编译。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| 公共入口 | [deep_ep/__init__.py](../../code/deepep-ascend/deep_ep/__init__.py) | JIT 初始化、buffer 与事件导出 |
| EPBuffer | [deep_ep/buffers/ep.py](../../code/deepep-ascend/deep_ep/buffers/ep.py) | dispatch/combine 和通信句柄 |
| Host 协调 | [csrc/buffers/ep.hpp](../../code/deepep-ascend/csrc/buffers/ep.hpp) | EP 缓冲与设备任务提交 |
| 设备通信 | [csrc/kernels/ep](../../code/deepep-ascend/csrc/kernels/ep) | Ascend dispatch/combine 内核 |
| JIT 连接 | [csrc/runtime/jit.hpp](../../code/deepep-ascend/csrc/runtime/jit.hpp) | 对接内核编译运行时 |

## 主要执行链

```text
token tensors + expert routes
  → EPBuffer.dispatch → Ascend communication → expert tensors
  → expert computation → combine(handle) → output
```

## 关键机制与扩展边界

接口对齐用于减少上层迁移，但 rank、拓扑、stream/event 和容量仍需要共同满足通信合同。DeepJIT 负责首次使用时编译设备内核，因此编译器与 toolkit 必须在运行时可用。

与 GPU 版本的主要差异位于设备通信、内存注册与同步机制，而不是简单替换 Python import。阅读时应把 EP 的主链和 PP/Bucket/Engram 分开，分别检查实现状态。

## 限制与注意事项

README 将部分 PP、CP/DP Bucket、Engram 通信能力标为开发中，并限定已验证的 Ascend/驱动工具栈；不能把导出类全部视为成熟等价能力。上游性能结果还依赖指定 HDK 配置，本文没有复现。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/ep/test_ep.py](../../code/deepep-ascend/tests/ep/test_ep.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
