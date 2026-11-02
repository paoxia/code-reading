# SGLang：服务请求、Radix Cache 与模型执行

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`ad6ca42dea36ffad53fa033dab400f40ffa677f7`（提交日期 2026-11-02）。
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

## 限制与注意事项

NPU、CUDA 等后端及 speculative/disaggregated 路径存在不同约束；支持矩阵以本地配置与具体实现为准。本文不声称所有可选路径都完成运行验证。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [test/registered/spec/dspark/test_dspark_scheduler.py](../../code/sglang/test/registered/spec/dspark/test_dspark_scheduler.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
