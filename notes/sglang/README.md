# SGLang：服务请求、Radix Cache 与模型执行

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`e33cd0c3a10474c7a0f6efeb69ce2cf4b7a55021`（提交日期 2026-11-02）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

SGLang 将服务层、分词、请求调度、前缀缓存、模型执行和多种硬件后端组合起来。这里研究 SRT 推理运行时，前端语言与外部网关作为边界定位。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| HTTP server | [python/sglang/srt/entrypoints/http_server.py](../../code/sglang/python/sglang/srt/entrypoints/http_server.py) | API 路由与请求进入运行时 |
| TokenizerManager | [python/sglang/srt/managers/tokenizer_manager.py](../../code/sglang/python/sglang/srt/managers/tokenizer_manager.py) | 输入处理、请求转发与输出接收 |
| Scheduler | [python/sglang/srt/managers/scheduler.py](../../code/sglang/python/sglang/srt/managers/scheduler.py) | 运行队列、prefill/decode、重叠与分离部署协调 |
| RadixCache | [python/sglang/srt/mem_cache/radix_cache.py](../../code/sglang/python/sglang/srt/mem_cache/radix_cache.py) | 前缀树缓存与引用管理 |
| ModelRunner | [python/sglang/srt/model_executor/model_runner.py](../../code/sglang/python/sglang/srt/model_executor/model_runner.py) | 模型、Attention 后端与设备 forward |

## 主要执行链

```text
HTTP → TokenizerManager → Scheduler
  → batch + cache allocation → model worker / ModelRunner
  → sampling → detokenize → streaming response
```

## 关键机制与扩展边界

Scheduler 是多个执行分支的汇合点：初始化包括模型 worker、缓存池、chunked prefill、overlap 与 disaggregation。应沿一次具体配置追踪批次，避免把所有 mixin 和可选功能合成一条必经链。

前缀复用减少需要重新计算的 token，但缓存树和设备池各自承担逻辑索引与物理内存职责。它与 vLLM 的比较应围绕相同工作负载、缓存命中、预算和抢占语义，而不是只比较是否出现 “Paged” 或 “Radix”。

## 更新后增量：可选的 full-attention KV split

当前 [TRTLLM MHA backend](../../code/sglang/python/sglang/srt/layers/attention/trtllm_mha_backend.py) 新增由 `SGLANG_TRTLLM_MHA_FULL_ATTN_KV_SPLITS` 控制的 decode KV split，针对 TRTLLM-GEN/SM100。它检查 batch 阈值和 workspace/counter 容量，在滑窗层或不满足条件时不启用；XQA 路径不使用该覆盖。

这是特定后端的 opt-in 执行策略，不能写成所有 SGLang Attention 默认加速。相关 [paged KV 单元测试](../../code/sglang/test/registered/unit/layers/attention/test_trtllm_mha_paged_kv.py) 用于核对分派与容量边界，本轮未运行。

## 深入：RadixKey、树结构与物理 KV 的三个边界

[RadixCache.match_prefix](../../code/sglang/python/sglang/srt/mem_cache/radix_cache.py) 的 key 除 token IDs 还包含 `extra_key` 命名空间。相同 token 前缀但不同 adapter/隔离标签不共享节点；页大小大于一时，匹配长度还会对齐到页边界。

匹配并不是纯只读操作：若命中结束在已有 segment 中间，会拆分节点以形成精确边界，并刷新访问元数据。拆节点不复制 KV 内容，逻辑树结构和物理缓存的分配需要分别观察。

`inc_lock_ref()` 沿祖先路径增加保护；只有引用从 0 变为 1 的部分从 evictable_size 转入 protected_size。`dec_lock_ref()` 在最后一份引用释放时反向调整。驱逐从可驱逐叶子开始，释放物理 segment；父节点失去最后一个子节点且未被锁定后，才可继续成为候选。

## 深入：上轮 prefill 如何进入下一轮 decode

[get_next_batch_to_run](../../code/sglang/python/sglang/srt/managers/scheduler.py) 在组下一批前处理 pending abort、缓存事件和 chunked request，并把上轮完成 prefill 的请求并入 running batch。尚未结束的 chunk 必须排除，不能被误当成已准备好 decode 的普通请求。

normal loop 在当前轮执行后立即处理结果；overlap loop 用 result_queue 保存待结算批次，并在必要时提前处理上轮结果。是否能延后结果处理由实际依赖决定，不能机械理解为“GPU 永远领先 CPU 一整批”。研究特定 speculative/HiSparse/分离路径时，应继续追踪其专用的完成与准入分支。

## 限制与注意事项

NPU、CUDA 等后端及 speculative/disaggregated 路径存在不同约束；支持矩阵以本地配置与具体实现为准。本文不声称所有可选路径都完成运行验证。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [test/registered/spec/dspark/test_dspark_scheduler.py](../../code/sglang/test/registered/spec/dspark/test_dspark_scheduler.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
