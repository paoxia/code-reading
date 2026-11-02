# DeepEP：专家并行 Buffer、Dispatch 与 Combine

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`f6aa38fe06cd4a0489e7730365d4e0114970a2f3`（提交日期 2026-10-21）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

当前 DeepEP 已是分 buffer 类型组织的通信库，公共接口包含 EP、PP、Bucket 与 Engram。研究 MoE 时以 EPBuffer 为主，不能继续只套早期单一 Buffer 的结构。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| 公共入口 | [deep_ep/__init__.py](../../code/deepep/deep_ep/__init__.py) | NCCL 一致性检查、JIT 初始化与 API 导出 |
| EPBuffer / EPHandle | [deep_ep/buffers/ep.py](../../code/deepep/deep_ep/buffers/ep.py) | 专家分发、结果合并与通信句柄 |
| BufferAllocator | [deep_ep/buffers/allocator.py](../../code/deepep/deep_ep/buffers/allocator.py) | 通信缓冲分配 |
| Host / device 实现 | [csrc](../../code/deepep/csrc) | 通信、buffer 与设备内核 |

## 主要执行链

```text
路由结果与 token tensors
  → EPBuffer.dispatch → expert-local tokens + handle
  → expert GEMM → EPBuffer.combine(handle)
  → 原 token 布局的聚合输出
```

## 关键机制与扩展边界

dispatch 负责把 token 按路由送给专家，combine 使用对应 handle 将专家结果归并回来。handle 承载重排和通信事实，不能从输出 tensor shape 反推全部原始映射。EventOverlap 等对象表达异步完成边界，数据可见与函数返回也不是同一时刻。

导入时会检查运行时 NCCL 与构建依赖是否一致，然后初始化 JIT。这是部署合同的一部分。新增 buffer 类型不代表每种通信原语都同样成熟，需分别查看实现与测试。

## 深入：EPHandle 既是映射快照，也是后续执行的借用合同

[EPHandle](../../code/deepep/deep_ep/buffers/ep.py) 保存 topk_idx 的引用、源 token/目标 slot 元数据、各专家接收数量及对齐 prefix sums。cached dispatch 复用这些路由事实，combine 用它逆转路由；仅保存 recv_x 不足以重建完整映射。

`topk_idx` 不能在 handle 使用期间修改。实现用 PyTorch version counter 检测普通原地更新，但 `.data`、原始指针及 inference-mode tensor 不具备同等可检测性，所以“没有触发 assert”不等于路由未变。

展开与非展开布局的接收计数含义不同：一个 token 的多个专家位于同一 rank 时，rank 接收计数可以去重；每专家计数又包含对齐 padding。不能把这两种计数相加或直接当作全局真实 token 总数。

## 深入：异步等待还可能触发 epilogue

[EventOverlap.current_stream_wait](../../code/deepep/deep_ep/utils/event.py) 除了让当前 stream 等待，还会执行一次注册的 hook_after_wait。defer_epilogue 路径因此把部分结果生成推迟到 wait，函数最初返回的可能只是 EventOverlap，而不是通常的五元组。

CUDA `previous_event` 与 allocate_on_comm_stream 有关联要求；extra tensors/事件还负责跨 stream 生命周期。`with event_overlap` 在退出上下文时等待，并不是进入上下文就自动串行化全部工作。调用方应先明确数据在哪个 stream 可见，再安排专家计算和 combine。

## 限制与注意事项

该库不负责预测专家负载、安排模型层或管理服务请求。NCCL、设备拓扑、buffer 容量和调用 rank 的一致性都会影响正确性，不能把 Python API 兼容理解成任意硬件二进制兼容。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/ep](../../code/deepep/tests/ep) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
