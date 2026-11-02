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

## 限制与注意事项

上游明确说明本次发布不包含完整服务所需的 KV cache system、完整 VE/Prefill/Decode 分离与副本间负载均衡。这不表示引擎内部没有 BlockManager。不能将离线快照描述成可直接替代线上完整服务。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/engine/test_sequence.py](../../code/deepinfer/tests/engine/test_sequence.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
