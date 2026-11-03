# 大模型 API 差异适配

## 2026-11-02 复核与当前定位

- 本地源码：`debc9fd747bb2123160a98046ad1c2d4da44a567`（提交日期 2022-05-02）。
- 核对方式：本地源码、调用入口与测试材料静态阅读；未运行上游构建或测试。下文早期日期与版本号保留作研究历史，本节记录本轮基线与修订边界。

本地 HEAD 仍是 2022 年的教学快照。研究对象是 Encoder/Decoder、注意力、mask、训练与贪心解码；没有 Provider、Agent Loop 或模型服务 API，不能为统一比较表虚构这些能力。

当前入口：[the_annotated_transformer.py](../../code/annotated-transformer/the_annotated_transformer.py)、[README.md](../../code/annotated-transformer/README.md)。

本专题继续从 [the_annotated_transformer.py](../../code/annotated-transformer/the_annotated_transformer.py)、[README.md](../../code/annotated-transformer/README.md) 进入；涉及已迁移的运行时，以本节和项目总览中的当前路径为准。

## 结论

该项目不解决大模型 API 差异。它是 Transformer 论文的教学实现，研究对象是模型结构、训练与推理算法，不是托管模型服务、Provider SDK 或 Agent 运行时。研究版本：`debc9fd`。

## 源码依据

仓库主体是单文件 Jupytext 教程 [`the_annotated_transformer.py`](../../code/annotated-transformer/the_annotated_transformer.py)，直接使用 PyTorch 构造 encoder、decoder、attention、训练循环和 greedy decoding；项目说明也将其定位为 Annotated Transformer 博文配套代码（[`README.md`](../../code/annotated-transformer/README.md)）。源码中不存在统一消息对象、模型 provider 注册表、OpenAI/Anthropic 客户端、工具调用协议或 SSE 事件转换层。

## 与其他项目的边界

这里解决的是“不同模型如何在同一种 Transformer 数学结构上实现和训练”，不是“不同厂商如何暴露推理 API”。如果要把该实现作为在线服务使用，仍需在仓库之外增加推理服务层，定义请求/响应协议、鉴权、流式输出、错误映射与模型能力声明；vLLM 一类项目才承担后者。
