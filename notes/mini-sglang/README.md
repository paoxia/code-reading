# mini-SGLang：分离进程、Radix Cache 与重叠调度

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`9a91cfafe754aa85daee49998176275667eb58f2`（提交日期 2026-05-17）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

mini-SGLang 在紧凑代码中保留在线推理服务的主要分层：API、tokenizer、scheduler 与 engine。它适合在 nano-vLLM 之后研究消息传递、缓存树和 CPU/GPU 重叠执行。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| 服务启动 | [python/minisgl/server/launch.py](../../code/mini-sglang/python/minisgl/server/launch.py) | 创建服务及后台进程 |
| Scheduler | [python/minisgl/scheduler/scheduler.py](../../code/mini-sglang/python/minisgl/scheduler/scheduler.py) | 接收消息、组批、执行与上一批结果结算 |
| PrefillManager | [python/minisgl/scheduler/prefill.py](../../code/mini-sglang/python/minisgl/scheduler/prefill.py) | prefill 准入、预算与分块 |
| RadixCache | [python/minisgl/kvcache/radix_cache.py](../../code/mini-sglang/python/minisgl/kvcache/radix_cache.py) | 前缀匹配、缓存树与回收 |
| Engine | [python/minisgl/engine/engine.py](../../code/mini-sglang/python/minisgl/engine/engine.py) | 设备模型、forward 与采样 |

## 主要执行链

```text
API → tokenize → BackendMsg → Scheduler
  → PrefillManager / DecodeManager → Engine
  → 上一批结果结算 → DetokenizeMsg → API
```

## 关键机制与扩展边界

`overlap_loop()` 先安排当前批次在 engine stream 执行，再处理上一批结果；`normal_loop()` 则当轮执行、当轮结算。二者由环境配置切换，因此要区分“支持重叠”与某次运行实际是否启用。

TableManager 管理请求到 token 的映射，CacheManager 管理页生命周期，RadixCache 管理可共享前缀。完成请求时必须同时回收运行队列与缓存引用；源码特别防止重叠流水线对同一请求重复释放。

## 限制与注意事项

这是学习实现，模型、后端和部署面均小于完整 SGLang。CUDA stream 与 host 结果回传有明确依赖，不能随意删掉同步点来推断性能提升。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/core/test_scheduler.py](../../code/mini-sglang/tests/core/test_scheduler.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
