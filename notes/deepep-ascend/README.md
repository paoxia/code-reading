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

## 深入：兼容签名中的四种不同处理

[Ascend EPBuffer.dispatch](../../code/deepep-ascend/deep_ep/buffers/ep.py) 接口与 GPU 版本相近，但参数含义并非逐项等价：

| 参数 | 当前 Ascend 行为 |
| --- | --- |
| previous_event | 兼容参数，忽略 |
| allocate_on_comm_stream | 兼容参数，分配使用当前 stream |
| num_qps | 只允许 None/0，由后端自动配置 |
| do_handle_copy | 当前必须 False |

因此迁移 GPU 的 event 依赖代码时，不能因为调用未报错就认定之前的跨 stream 等待仍然成立。需要以 NPU 的当前 stream、返回事件和具体调用链重新确认依赖。

## 深入：延迟 epilogue 会改变返回协议

`defer_epilogue=True` 要求 async_with_compute_stream=True。这时 dispatch 直接返回 EventOverlap，`current_stream_wait()` 才等待 host 接收数量并执行 copy epilogue，得到 recv_x、recv_topk_idx、recv_topk_weights 与 handle。

普通路径返回的五元组与该延迟路径不是相同形状，包装层应按配置分派。cached handle 同样要求保持路由 tensor 和 token 数不变，避免复用旧 slot 映射处理新路由。

这些边界说明平台迁移至少要核对参数处理、返回类型和执行顺序，不能只比较公开类名和 Python 方法签名。

## 限制与注意事项

README 将部分 PP、CP/DP Bucket、Engram 通信能力标为开发中，并限定已验证的 Ascend/驱动工具栈；不能把导出类全部视为成熟等价能力。上游性能结果还依赖指定 HDK 配置，本文没有复现。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/ep/test_ep.py](../../code/deepep-ascend/tests/ep/test_ep.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
