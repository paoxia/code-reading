# TensorRT-LLM：LLM API、PyExecutor 与设备运行时

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`4c2238ee524c65dd25259274debf1b3bfe8181e9`（提交日期 2026-11-02）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

当前源码同时包含 PyTorch 执行路径、C++ 基础设施和 TensorRT 相关运行时，不能只用“先构建 TensorRT Engine”概括全部请求。本文以 Python LLM API 和 PyExecutor 为入口。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| LLM API | [tensorrt_llm/llmapi/llm.py](../../code/tensorrt-llm/tensorrt_llm/llmapi/llm.py) | 生成、请求参数与结果管理 |
| PyExecutor | [tensorrt_llm/_torch/pyexecutor/py_executor.py](../../code/tensorrt-llm/tensorrt_llm/_torch/pyexecutor/py_executor.py) | 执行循环与批次管理 |
| Scheduler | [tensorrt_llm/_torch/pyexecutor/scheduler/scheduler.py](../../code/tensorrt-llm/tensorrt_llm/_torch/pyexecutor/scheduler/scheduler.py) | 请求与资源调度 |
| LLM request | [tensorrt_llm/_torch/pyexecutor/llm_request.py](../../code/tensorrt-llm/tensorrt_llm/_torch/pyexecutor/llm_request.py) | 请求状态与生成元数据 |
| C++ 组件 | [cpp](../../code/tensorrt-llm/cpp) | 绑定、执行与设备插件 |

## 主要执行链

```text
LLM.generate / generate_async
  → GenerationExecutor → 所选执行后端
  → scheduler → model execution → sampling
  → GenerationResult → detokenized output
```

## 关键机制与扩展边界

LLM API 连接输入处理器、SamplingParams、LoRA、后处理与 GenerationExecutor。具体后端的选取应继续读配置与 executor 工厂，PyExecutor 是其中重要实现，不能把 Python 接口直接等同于唯一后端。

请求生命周期和设备张量生命周期分层管理。分离式推理、KV retention、量化和多 GPU 配置都会改变资源与通信路径，阅读时先固定模型及后端，再追踪 request 从等待到完成的状态。

## 最终快照补充：HF 权重缓存的 host memory 准入

当前 [HfWeightLoader](../../code/tensorrt-llm/tensorrt_llm/_torch/models/checkpoints/hf/weight_loader.py) 在启用原始 HF 权重缓存时，还检查 checkpoint 文件总量与可用 host memory/headroom。无法驻留时跳过 cache lookup/store，并走与 miss 相同的 collective 路径，避免“cache hit”反而反复触发存储读入。

这是 host 权重加载缓存，不是请求 KV cache。对应 [weight loader 测试](../../code/tensorrt-llm/tests/unittest/_torch/models/checkpoints/hf/test_weight_loader.py) 在本轮只作静态证据，未运行。

## 限制与注意事项

`_torch`、`_experimental`、runtime 和 C++ 目录的接口稳定性不同。GPU 架构、编译依赖和模型支持需要逐项检查；本文仅静态分析，没有构建 CUDA 工程。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/unittest/executor/test_event_loop_error_broadcast.py](../../code/tensorrt-llm/tests/unittest/executor/test_event_loop_error_broadcast.py) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
