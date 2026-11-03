# FlashInfer：推理算子接口、执行计划与内核后端

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`c34707ae98b8f2ff53a5ea2e98ac9b2cbc24b702`（提交日期 2026-11-02）。
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

## 深入：分页 KV 的索引合同

[BatchDecodeWithPagedKVCacheWrapper.plan](../../code/flashinfer/flashinfer/decode.py) 使用 CSR 风格的 `indptr`、`indices` 与 `last_page_len` 描述各请求持有的页。前两者决定“第几个请求引用哪些物理页”，最后一个字段决定末页有效 token 数；物理 buffer 的总容量不能替代这些有效长度。

| 参数 | 形状 | 含义 |
| --- | --- | --- |
| indptr | `[batch_size+1]` | 每个请求在页索引数组中的起止位置 |
| indices | `[indptr[-1]]` | 实际页编号 |
| last_page_len | `[batch_size]` | 各请求末页有效长度 |
| num_qo_heads / num_kv_heads | 标量 | Query 与 KV head 数的合同 |

例如某请求占两页，真实有效长度还取决于末页使用量；不能仅用“两页”推断它有 `2×page_size` 个有效 token。

## 深入：plan/run、CUDA Graph 与多 token decode

`q_len_per_req > 1` 需要在 plan 阶段设置，仅在 run 阶段传入不能启用相应 XQA MTP 路径。CUDA Graph 模式下它与 batch size 等属于冻结形状，重规划不能任意改变；自动生成的 block table 还有初始容量边界。

`fixed_split_size` 控制 FA2 split-KV 的分割与归约行为，但文档明确不保证它天然兼容所有 CUDA Graph 情况：KV 长度变化仍可能改变 CTA 数。确定性、图重放和计划复用分别约束不同部分，不能用一个布尔开关概括三者。

阅读服务引擎的调用方时，先核对何时重做 plan、页表和有效长度何时更新，再进入 run 对 Q/KV/scale 的校验；不要只比较最终调用的 kernel 名称。

## 限制与注意事项

算子库不负责 HTTP、请求排队、会话或集群调度。性能依赖硬件、shape、量化与 plan 重用方式；此处没有复现实测，也不转录上游性能数字。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/attention/test_deepseek_mla.py](../../code/flashinfer/tests/attention/test_deepseek_mla.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
