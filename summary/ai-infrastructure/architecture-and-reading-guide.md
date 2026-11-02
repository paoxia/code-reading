# AI 基础设施分层与阅读路线

> 复核日期：2026-11-02。研究对象为本仓库的 20 个 AI 基础设施项目，具体提交见 [完整项目总览](../project-landscape/overview.md)。结论依据本地源码、测试与示例；本轮没有运行 GPU/NPU、分布式训练或存储 benchmark。

## 先按职责分层

新增项目使仓库覆盖了从 Agent 请求到设备计算的多个层次。不能把它们都称作“推理框架”，也不能因同属 DeepSeek 生态就假定已经接成同一条可部署服务。

```text
Agent / 应用
  → API 网关（Sub2API）
  → 推理服务与请求调度（vLLM / SGLang / TensorRT-LLM）
      ├─ 精简学习实现（nano-vLLM / mini-SGLang）
      ├─ 特定模型离线引擎（DeepInfer）
      ├─ Attention / GEMM / TopK / quant 等算子
      ├─ MoE 通信与专家放置
      └─ JIT 编译与硬件后端

旁支：草稿模型训练评估（DeepSpec）
      训练流水线（DualPipe）
      分布式文件存储（3FS）
```

上图表达研究层次，不表示每条边都是本地项目已经实现的直接依赖。DeepInfer 明确列出的算子依赖可继续从其 [README](../../code/deepinfer/README.md) 与 [model_executor](../../code/deepinfer/deepinfer/model_executor) 核对；其他引擎的具体后端需按配置确认。

## 项目定位矩阵

| 层次 | 项目 | 应重点追踪的状态 | 不负责的边界 |
| --- | --- | --- | --- |
| 网关 | [Sub2API](../../notes/sub2api/README.md) | API key、账号、quota、转发与用量 | 模型 forward、GPU KV 分配 |
| 精简引擎 | [nano-vLLM](../../notes/nano-vllm/README.md) | Sequence、waiting/running、block 引用 | 完整在线平台与多租户运维 |
| 精简在线服务 | [mini-SGLang](../../notes/mini-sglang/README.md) | 消息、prefill/decode、radix cache、stream | 完整 SGLang 的全部模型/后端 |
| 完整推理引擎 | [vLLM](../../notes/vllm/README.md)、[SGLang](../../notes/sglang/README.md)、[TensorRT-LLM](../../notes/tensorrt-llm/README.md) | request、token budget、cache、batch、worker | Agent 任务验收与业务事务 |
| 模型特定离线引擎 | [DeepInfer](../../notes/deepinfer/README.md) | C++ 调度、metadata pool、worker 与输出 | 本次发布未包含的完整在线服务组件 |
| 草稿训练与评估 | [DeepSpec](../../notes/deepspec/README.md) | target cache、draft、proposal、verification | 通用在线请求调度 |
| Attention 算子 | [FlashInfer](../../notes/flashinfer/README.md)、[FlashMLA](../../notes/flashmla/README.md) | plan、workspace、KV layout、稀疏索引 | HTTP 与服务请求排队 |
| GEMM/融合计算 | [DeepGEMM](../../notes/deepgemm/README.md)、[DeepGEMM Ascend](../../notes/deepgemm-ascend/README.md) | shape、scale、grouped layout、kernel specialization | 模型层间调度和业务路由 |
| 通用模型组件算子 | [TileKernels](../../notes/tilekernels/README.md)、[DeepSelect](../../notes/deepselect/README.md) | dtype、量化/重排、有效区间与 TopK | 完整模型服务 |
| 专家通信 | [DeepEP](../../notes/deepep/README.md)、[DeepEP Ascend](../../notes/deepep-ascend/README.md) | token 重排、handle、dispatch/combine、event | 专家负载预测和服务队列 |
| 专家放置 | [EPLB](../../notes/eplb/README.md) | logical/physical expert、replica count、node/GPU mapping | 权重迁移与在线生效协议 |
| JIT | [DeepJIT](../../notes/deepjit/README.md) | source/options hash、cache、load、launch | 算法选择与数值正确性证明 |
| 训练流水线 | [DualPipe](../../notes/dualpipe/README.md) | micro-batch、stage、forward/backward、通信 | serving 连续批处理 |
| 存储 | [3FS](../../notes/3fs/README.md) | inode、chunk、replica chain、I/O queue | GPU 内部 KV block 生命周期 |

## 第一条阅读主线：从请求到一个生成 token

先读 nano-vLLM 的 [LLMEngine](../../code/nano-vllm/nanovllm/engine/llm_engine.py)、[Scheduler](../../code/nano-vllm/nanovllm/engine/scheduler.py) 和 [BlockManager](../../code/nano-vllm/nanovllm/engine/block_manager.py)，逐步回答：

1. 请求何时进入 waiting，何时转到 running？
2. prefill/decode 如何争用 token 预算与物理块？
3. 哪些前缀可以共享，何时增减引用？
4. forward 返回 token 后，谁决定完成并回收资源？

然后读 mini-SGLang 的 [Scheduler](../../code/mini-sglang/python/minisgl/scheduler/scheduler.py)：它增加跨组件消息、不同 stream 与上一批结果处理，帮助理解 CPU 调度与 GPU 执行为什么可以重叠。

最后比较 vLLM 的 [Scheduler](../../code/vllm/vllm/v1/core/sched/scheduler.py)、SGLang 的 [Scheduler](../../code/sglang/python/sglang/srt/managers/scheduler.py) 和 TensorRT-LLM 的 [PyExecutor](../../code/tensorrt-llm/tensorrt_llm/_torch/pyexecutor/py_executor.py)。不要将 nano-vLLM 的 prefill 优先策略推广为所有引擎相同的调度规则。

## 第二条主线：设备输入合同

引擎负责准备哪些 token 和 KV 页，算子负责怎样高效计算。阅读算子前需要先写清 tensor shape、dtype、stride、scale、地址有效范围及 workspace 生命周期。

- FlashInfer 的 [decode wrapper](../../code/flashinfer/flashinfer/decode.py) 分离 plan 与 run；改变 shape/页表等信息后是否能复用计划需要按接口核对。
- FlashMLA 的 [接口](../../code/flashmla/flash_mla/flash_mla_interface.py) 在首次调用建立调度元数据；topk 长度值变化却复用旧 metadata 可能静默使用旧调度。兼容参数仍在签名中不代表仍参与执行。
- DeepSelect 的 [topk](../../code/deepselect/deep_select/interface.py) 有变长区间和输出对齐合同，结果可能不 contiguous；不能自动套用 torch.topk 的全部语义。
- GPU 与 Ascend 的 DeepGEMM 接口相近，但 [Ascend scale 打包说明](../../code/deepgemm-ascend/README.md) 明确与 NVIDIA 格式不同。

这些差异会影响正确性，也会影响端到端成本。单个 kernel 的时间不包含所有布局转换、计划、编译、通信和排队开销。

## 第三条主线：MoE、训练与存储

EPLB 的 [rebalance_experts](../../code/eplb/eplb.py) 产生专家复制和放置方案；DeepEP 的 [EPBuffer](../../code/deepep/deep_ep/buffers/ep.py) 按实际路由做 dispatch/combine；DeepGEMM 再计算专家矩阵乘法。三个项目解决“专家放哪里”“token 怎么过去”“专家如何计算”，宿主还要衔接路由、权重迁移和一致生效。

DualPipe 的 [step](../../code/dualpipe/dualpipe/dualpipe.py) 管理训练 micro-batch 顺序，需要模型提供定制重叠实现才能利用对应窗口。它与推理阶段的 chunked prefill/continuous batching 优化目标不同。

3FS 的 [设计说明](../../code/3fs/docs/design_notes.md) 区分元数据事务、chunk 复制与客户端 I/O。它可以作为推理缓存的存储底座；这不等于它负责引擎内部的 KV slot 分配或前缀索引。

## 当前已知限制

- DeepInfer 的本次发布是离线快照；上游列出尚缺完整服务所需的缓存系统、完整分离和副本负载均衡，不能替它补写已完成能力。
- DeepJIT 的 [README](../../code/deepjit/README.md) 将历史 cache warmup 与 Python source 编译 API 列为 WIP。
- DeepEP Ascend 的 [README](../../code/deepep-ascend/README.md) 将部分通信原语标为开发中，并限定验证硬件和工具栈。
- DeepSpec 的训练接受行为、单 kernel 吞吐、引擎 token 吞吐与 Agent 任务成功率属于不同层次，不能相互直接替代。

推荐顺序：nano-vLLM → mini-SGLang → vLLM/SGLang → 算子接口 → DeepEP/EPLB → DeepInfer；需要训练时再进入 DeepSpec/DualPipe，需要存储时再进入 3FS。
