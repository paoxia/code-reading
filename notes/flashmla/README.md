# FlashMLA：稀疏 MLA、KV 布局与调度元数据

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`395cb3afbb331fef7b1b21e9340861b9436b42d8`（提交日期 2026-10-27）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

当前快照的 MLA decode 接口强调量化 KV 与 sparse Attention，并保留部分旧参数以兼容调用者。理解它应从现行接口合同出发，而不是从早期 dense MLA 的说明推断。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| 接口与元数据 | [flash_mla/flash_mla_interface.py](../../code/flashmla/flash_mla/flash_mla_interface.py) | FlashMLASchedMeta、输入约束和设备调用 |
| 扩展加载 | [flash_mla/__init__.py](../../code/flashmla/flash_mla/__init__.py) | 加载 torch operator 并导出 API |
| 设备实现 | [csrc](../../code/flashmla/csrc) | 稀疏 prefill/decode 与相关算子 |

## 主要执行链

```text
get_mla_metadata → 空 FlashMLASchedMeta
  → flash_mla_with_kvcache(q, quantized KV, indices, meta)
  → 首次建立调度信息 → sparse decode → output + lse
```

## 关键机制与扩展边界

`get_mla_metadata()` 当前返回空 metadata 对象及 `None`，真正的 split-KV 信息在首次执行时生成。接口注释明确指出，复用 metadata 要保持 shape 以及 `topk_length`、`extra_topk_length` 的值不变；这些长度值不会在运行时重新校验，误用会静默复用过期调度。

当前 decode 路径忽略兼容参数 `block_table` 与 `cache_seqlens`，并要求 sparse、量化 KV 等条件。稀疏索引表达真实 KV 地址关系，不能把旧参数仍在签名中当作它们仍控制执行的证据。

## 深入：metadata 复用与索引有效性不是同一道校验

[flash_mla_with_kvcache](../../code/flashmla/flash_mla/flash_mla_interface.py) 首次记录 batch、query 长度、head 数、页大小、topk 宽度和 batch-invariant 设置。后续复用会对这些配置做 assert，但不会重新比较 `topk_length`、`extra_topk_length` 的内容值。

| 变化 | 当前合同 |
| --- | --- |
| batch/head/page/topk 宽度改变 | 同一 metadata 对象复用时触发相应一致性检查 |
| topk_length 内容改变、形状未变 | 调用者仍应重建 metadata；不能依赖运行时发现 |
| enable_batch_invariant 改变 | 不允许在同一已初始化 metadata 上切换 |
| decode 索引无效 | 只能用 `-1` 表示，正数越界没有通用保护 |

尤其要区分 sparse prefill 与 sparse decode：prefill 接口说明允许 `-1` 或超出 s_kv 的索引表示无效；decode 明确只把 `-1` 当作无效值。不能在两者之间未经转换就复用同一 padding 策略。

## 深入：Attention sink 与返回值

`sparse_fwd` 返回 output、max_logits 和 lse，decode 返回 output 和 lse；顺序和数量并不一致。attention sink 缩放输出，但接口说明它不改变返回的 lse。后续归约若把“sink 后输出”和“未受 sink 影响的归一化统计”当成同一含义，会产生误读。

当前量化 KV 的字节布局还包含原始量化值和尾随 scales；这不是只把 dtype 改成 FP8 的普通 Q/K/V tensor。可对照 [量化参考](../../code/flashmla/tests/quant.py) 和 [Attention 参考](../../code/flashmla/tests/ref.py) 理解它们的数学与存储合同。

## 限制与注意事项

q head dimension、head 数量、KV 的连续有效地址范围和架构均有限制。需要逐项阅读 docstring/assert；本文没有在支持硬件上验证数值或速度。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/test-sparse-decode.py](../../code/flashmla/tests/test-sparse-decode.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
