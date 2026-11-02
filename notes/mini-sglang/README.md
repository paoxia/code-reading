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

## 深入：准入要同时满足三类资源

[PrefillAdder](../../code/mini-sglang/python/minisgl/scheduler/prefill.py) 依次检查请求表空位、当前计算预算与可回收 KV 容量。一次 cache hit 并不能直接证明请求可执行：它必须先锁住命中的 handle，再重新检查容量，因为锁定会把一部分“可驱逐缓存”变为不可驱逐。

| 资源 | 代表状态 | 控制的问题 |
| --- | --- | --- |
| 请求表 | TableManager.available_size | 还能否容纳请求到 token 的映射 |
| 本步 token 预算 | token_budget | 当前 prefill chunk 可以计算多长 |
| 缓存容量与预留 | available_size / reserved_size | 输入增量和预计输出是否放得下 |

估算使用 `extend_len + output_len`，源码将更好的估算策略和 host cache match 标为 TODO，不能写成已完成的分层缓存调度器。

## 深入：为什么匹配时排除输入的最后一个 token

[CacheManager.match_req](../../code/mini-sglang/python/minisgl/scheduler/cache.py) 只匹配 `input_ids[:input_len-1]`，为本次请求留下至少一个待计算 token。ChunkedReq 不允许按普通完成请求追加 host token，也不会进入 decode manager；最后一个 prefill chunk 完成后才进入正常生成。

`cache_req()` 将请求新计算的前缀插入树，释放被其他请求先插入的重复物理页；完成时还释放不能入树的尾部，未完成时则锁住新 handle。它必须同时维护树中的共享部分和请求私有尾部，不能只对整段调用一次 free。

完整性检查要求 `free_pages + cache_pages == num_pages`，并检查页起点对齐。`lazy_free_region()` 把本次释放的页集中回收到 free_slots，用于配合重叠调度，而不是让页在调用 free 后即可被所有异步消费者安全复用。

## 限制与注意事项

这是学习实现，模型、后端和部署面均小于完整 SGLang。CUDA stream 与 host 结果回传有明确依赖，不能随意删掉同步点来推断性能提升。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/core/test_scheduler.py](../../code/mini-sglang/tests/core/test_scheduler.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
