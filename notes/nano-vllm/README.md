# nano-vLLM：从最小推理循环理解调度与 KV Cache

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`bb823b3e06983d71485a8e1f23715ebd87d98ef8`（提交日期 2026-04-26）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

这是理解推理引擎的精简入口。`LLMEngine` 将分词、Sequence、Scheduler、BlockManager 与 ModelRunner 串成同步生成循环；模型执行支持 Tensor Parallel，但控制流仍足够短，可以逐行跟踪一次请求。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| LLMEngine | [nanovllm/engine/llm_engine.py](../../code/nano-vllm/nanovllm/engine/llm_engine.py) | 创建 worker、添加请求、执行 step 与汇总结果 |
| Scheduler | [nanovllm/engine/scheduler.py](../../code/nano-vllm/nanovllm/engine/scheduler.py) | waiting/running 队列、prefill 优先、decode 与抢占 |
| BlockManager | [nanovllm/engine/block_manager.py](../../code/nano-vllm/nanovllm/engine/block_manager.py) | 物理块、引用计数与前缀哈希复用 |
| ModelRunner | [nanovllm/engine/model_runner.py](../../code/nano-vllm/nanovllm/engine/model_runner.py) | 张量准备、模型执行、采样与设备通信 |

## 主要执行链

```text
generate → add_request → Scheduler.schedule
  → ModelRunner.run → Scheduler.postprocess
  → 完成则释放块；未完成则进入下一 step
```

## 关键机制与扩展边界

`schedule()` 先从 waiting 形成 prefill 批次；仅首个序列可以因 token 预算不足而执行 chunked prefill。有 prefill 时直接返回，因此它并不是 vLLM V1 式的统一混合调度。decode 空间不足时释放并抢占序列，之后重新 prefill。

前缀缓存以 token 块和前一块哈希组成链，命中后仍检查 token 内容。物理块释放到 free 队列时可以保留哈希，直到重新分配才清除旧索引；“请求结束”与“前缀立刻失效”是两个不同动作。

## 深入：Sequence 状态、分块与缓存所有权

[Sequence](../../code/nano-vllm/nanovllm/engine/sequence.py) 同时记录逻辑 token 数、已计算 token 数、当前步计划 token 数和物理 block table。它们不是可互换的长度：`num_tokens` 是历史长度，`num_cached_tokens` 表示已有 KV，`num_scheduled_tokens` 表示本步待计算区间。

```text
WAITING
  → 分配 block table / 可分多次 prefill
  → 本次 prefill 覆盖全部输入：RUNNING
  → 每轮 decode：追加一个新 token
  → EOS / max_tokens：FINISHED → 释放块引用

RUNNING → 空间不足 → 释放块 / 回到 WAITING → 重算
```

### 一个分块例子

按 [Scheduler](../../code/nano-vllm/nanovllm/engine/scheduler.py) 手工推导：无前缀命中、单请求输入 600 token、每批预算 256 且物理块足够时，prefill 分别安排 256、256、88 token。前两步 `postprocess()` 只推进缓存位置，不将采样结果追加成有效输出；最后一块完成才追加首个生成 token。

因此“每调用一次 forward 就应向用户输出一个 token”在 chunked prefill 中不成立。另一点是 [BlockManager.allocate](../../code/nano-vllm/nanovllm/engine/block_manager.py) 先为整个当前序列分配所需 blocks，再分块计算；计算预算分块不等于显存按相同大小逐块准入。

### 引用与 worker 传输

完整前缀块可以被多个请求引用，释放请求只减少 `ref_count`；进入 free 队列的块仍可能保留可复用哈希，直到重新分配。逻辑失效、物理空闲和可被前缀命中是三个不同状态。

Sequence 的序列化在 prefill 传完整 token IDs，decode 则只传最后一个 token及计数、block table，减少 [ModelRunner](../../code/nano-vllm/nanovllm/engine/model_runner.py) 的跨进程控制数据。这个简化依赖 worker 已有 KV；它不是可供任意远端 worker 独立恢复会话的完整快照。

## 限制与注意事项

`generate()` 的返回注解为 `list[str]`，实际构造的是包含 `text` 与 `token_ids` 的字典列表，使用时应以实现为准。项目没有完整在线服务、租户隔离和生产运维闭环，不能把精简实现的调度策略当作当前 vLLM 的全部行为。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [example.py](../../code/nano-vllm/example.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
