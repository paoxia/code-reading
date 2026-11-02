# DeepInfer：离线推理引擎与 DeepSeek 组件协作

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`553741557a57df44a46fb3ab72b6aafeaf945337`（提交日期 2026-10-25）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

本次开源快照提供离线推理入口和规模化服务所需的部分核心机制。Python 引擎与 C++ 调度组件协作，连接模型执行、分布式并行和专用算子库。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| LLM | [deepinfer/entrypoints/llm.py](../../code/deepinfer/deepinfer/entrypoints/llm.py) | 离线请求、分词和结果收集 |
| LLMEngine | [deepinfer/engine/llm_engine.py](../../code/deepinfer/deepinfer/engine/llm_engine.py) | 调度与 worker 协调、资源结算 |
| C++ Scheduler | [csrc/engine/scheduler.hpp](../../code/deepinfer/csrc/engine/scheduler.hpp) | 设备执行前的请求调度 |
| Model executor | [deepinfer/model_executor](../../code/deepinfer/deepinfer/model_executor) | 模型、各层算子与并行实现 |
| Worker | [deepinfer/worker](../../code/deepinfer/deepinfer/worker) | 设备执行与异步调度协作 |

## 主要执行链

```text
LLM.generate → _add_request → _run_engine
  → LLMEngine → C++ Scheduler / BlockManager
  → worker → model executor / kernels
  → sampler / request outputs → 结果汇总
```

## 关键机制与扩展边界

`llm_engine.py` 从 `_C.engine` 导入 Scheduler、BlockManager 和 metadata/output pools。只读 Python 外壳会漏掉调度实现。`DeferredRelease` 把某步产生的资源延后一轮释放，以便调用者读取并和设备计算重叠。

README 明确列出 DSpark、异步调度、结构化输出与 NVIDIA/Ascend 路径，并说明确定性配置存在平台限制。各机制的开关不是能力等价证明，应沿具体 env 与模型实现核对。

## 深入：三种 EngineType 与全组步型一致

[Scheduler._schedule](../../code/deepinfer/csrc/engine/scheduler.hpp) 根据 PROMPT、COMPLETION 和 NORMAL 分派。前两者只执行 prefill 或 decode；NORMAL 则要求 attention DP 组在同一步采用一致步型。

NORMAL 在两类 decode 间隔上尝试 prefill：ALL 点要求所有 rank 都有可做的 prefill，减少大量空跑；ANY 点允许单个 rank 的等待请求触发全组 prefill，避免孤立请求一直等待。这里还检查 GPU cache watermark。

第一次投票通过后，真正准入仍可能因 slot/KV 不足而失败，因此存在第二次“是否确实有人排出 prefill”的投票。全组都没有排出请求时转回 decode；否则反复执行空 prefill、清零 decode_step，可能让队列无法推进。

## 深入：抢占不总是回队重算

```text
RUNNING → 资源不足
  ├─ stop_preempted_request / 结构化输出不可重算
  │    → FINISHED_PREEMPTED → 释放资源
  └─ 可重算
       → reset_for_recompute → WAITING → 释放旧资源
```

COMPLETION 引擎没有 prefill 通道，构造时明确禁止“抢占后重算”的配置；结构化输出请求也有不可重算的专门限制。不能把 nano-vLLM 的简单抢占策略直接套用到这里。

另一个生命周期限制是 SchedulerOutputs 中部分数组借用 scheduler 的 vector 存储：下一次 schedule 会清空复用。Python 必须在此前消费相应 clone/zero 元数据；需要跨步保留时不能只保存借用引用。结合 [DeferredRelease 与 LLMEngine](../../code/deepinfer/deepinfer/engine/llm_engine.py) 阅读，才能区分 scheduler 元数据借用和设备资源延迟释放。

## 限制与注意事项

上游明确说明本次发布不包含完整服务所需的 KV cache system、完整 VE/Prefill/Decode 分离与副本间负载均衡。这不表示引擎内部没有 BlockManager。不能将离线快照描述成可直接替代线上完整服务。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/engine/test_sequence.py](../../code/deepinfer/tests/engine/test_sequence.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
