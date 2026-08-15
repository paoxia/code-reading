# Annotated Transformer 源码详解

> 源码版本：`harvardnlp/annotated-transformer@debc9fd`

## 1. 研究范围

这个仓库不是通用 Transformer 框架，而是一份把论文公式、解释、PyTorch 实现和训练示例编排到一起的可执行教程。主要实现集中在 [`the_annotated_transformer.py`](../../code/annotated-transformer/the_annotated_transformer.py)，生成后的长文档位于 [`docs/index.html`](../../code/annotated-transformer/docs/index.html)。

本文沿张量的数据流解释 encoder-decoder Transformer，重点覆盖模型装配、三类 attention、mask、训练目标、学习率、推理和实现限制。代码对应 2017 年原始 Transformer，不代表现代 LLM 的 decoder-only、RoPE、RMSNorm、KV cache 或 FlashAttention 实现。

## 2. 整体数据流

```text
src token ids [B, S]
  → Embeddings × sqrt(d_model)
  → PositionalEncoding
  → N × EncoderLayer
  → memory [B, S, d_model]

tgt token ids [B, T]
  → 右移后的 Embeddings + PositionalEncoding
  → N × DecoderLayer(memory)
  → hidden [B, T, d_model]
  → Generator: Linear(d_model, vocab) + log_softmax
  → next-token log probabilities [B, T, vocab]
```

[`EncoderDecoder`](../../code/annotated-transformer/the_annotated_transformer.py) 是顶层容器。`forward(src, tgt, src_mask, tgt_mask)` 先调用 `encode()`，再把 encoder memory 交给 `decode()`。`Generator` 没有放进 `forward()`：训练 loss 或推理代码显式决定何时把 decoder hidden state 投影到 vocabulary。

## 3. 模型如何装配

[`make_model()`](../../code/annotated-transformer/the_annotated_transformer.py) 是理解对象图的最佳入口：

```text
EncoderDecoder
├── Encoder
│   └── N × EncoderLayer
│       ├── MultiHeadedAttention (self-attention)
│       └── PositionwiseFeedForward
├── Decoder
│   └── N × DecoderLayer
│       ├── MultiHeadedAttention (masked self-attention)
│       ├── MultiHeadedAttention (source attention)
│       └── PositionwiseFeedForward
├── src_embed: Embeddings + PositionalEncoding
├── tgt_embed: Embeddings + PositionalEncoding
└── Generator
```

`clones()` 使用 `copy.deepcopy()` 创建相同结构但参数独立的层。`make_model()` 也复制 attention、feed-forward 和 positional module，避免 encoder/decoder 各层意外共享可训练参数。构造结束后，对维度大于 1 的参数执行 Xavier uniform 初始化。

默认超参数是 `N=6`、`d_model=512`、`d_ff=2048`、`h=8`、`dropout=0.1`。`d_model % h == 0` 是多头拆分的硬约束。

## 4. Encoder：self-attention 与逐位置变换

[`Encoder.forward()`](../../code/annotated-transformer/the_annotated_transformer.py) 依次调用 N 个 `EncoderLayer`，最后做一次 `LayerNorm`。每个 `EncoderLayer` 包含：

1. self-attention：query、key、value 都来自同一个 `x`；
2. position-wise feed-forward：每个序列位置独立应用同一组两层 MLP 参数。

两者都被 `SublayerConnection` 包裹。代码实际执行：

```text
x + Dropout(Sublayer(LayerNorm(x)))
```

这是 pre-norm 写法。源码旁的论文文字描述偏向 post-norm，但注释明确说明实现为简洁而先做 norm。阅读时应以 `SublayerConnection.forward()` 为准，不能只照抄论文公式。

`PositionwiseFeedForward` 完成 `d_model → d_ff → d_model`，中间为 ReLU 和 dropout。它不在 token 维度之间混合信息；序列位置间通信发生在 attention。

## 5. Decoder：三段子层与自回归约束

每个 [`DecoderLayer`](../../code/annotated-transformer/the_annotated_transformer.py) 有三个子层：

1. masked self-attention：Q/K/V 都来自 decoder 当前状态；
2. source attention：Q 来自 decoder，K/V 来自 encoder memory；
3. feed-forward。

`src_mask` 限制 source attention 不能读取源序列 padding；`tgt_mask` 同时限制 padding 和未来位置。训练时虽然整段 target 并行送入模型，但位置 `i` 只能看到不晚于 `i` 的 token，从而保持与逐 token 生成一致的因果条件。

## 6. Scaled Dot-Product Attention

[`attention()`](../../code/annotated-transformer/the_annotated_transformer.py) 的核心计算是：

```text
scores = Q @ Kᵀ / sqrt(d_k)
scores[mask == 0] = -1e9
p_attn = softmax(scores, dim=-1)
output = p_attn @ V
```

除以 `sqrt(d_k)` 是为避免维度增大后点积绝对值过大，使 softmax 落入梯度极小区域。mask 在 softmax 前把非法位置替成极小值，使其概率接近零。函数同时返回 output 与 attention weights，后者被保存用于可视化。

### 多头维度变换

[`MultiHeadedAttention.forward()`](../../code/annotated-transformer/the_annotated_transformer.py) 的张量变化为：

```text
[B, L, d_model]
  → linear projection
  → view [B, L, h, d_k]
  → transpose [B, h, L, d_k]
  → attention
  → transpose + contiguous
  → [B, L, h × d_k]
  → output linear [B, L, d_model]
```

四个 Linear 分别用于 Q、K、V 和拼接后的输出。mask 会 `unsqueeze(1)` 增加 head 维，使同一个 mask 广播到全部 attention heads。

## 7. Embedding 与位置编码

[`Embeddings`](../../code/annotated-transformer/the_annotated_transformer.py) 将 token id 映射到 `d_model`，再乘 `sqrt(d_model)`，平衡 embedding 与位置编码的量级。

[`PositionalEncoding`](../../code/annotated-transformer/the_annotated_transformer.py) 在初始化时生成最长 `max_len=5000` 的正弦/余弦矩阵，并通过 `register_buffer("pe", pe)` 保存。这意味着 `pe` 会随 module 移动设备和进入 state dict，但不会被优化器更新。forward 只切出当前长度、与 embedding 相加并 dropout。

限制也很明确：输入长度超过 `max_len` 时没有动态扩展；它使用绝对 sinusoidal encoding，而不是现代模型常用的旋转或相对位置方案。

## 8. Mask 的形状与组合

[`Batch`](../../code/annotated-transformer/the_annotated_transformer.py) 构造训练数据视图：

- `src_mask = (src != pad).unsqueeze(-2)`，典型形状 `[B, 1, S]`；
- `tgt = full_tgt[:, :-1]`，作为 decoder 输入；
- `tgt_y = full_tgt[:, 1:]`，作为监督标签；
- `tgt_mask` 是 padding mask 与 `subsequent_mask(T)` 的逻辑与；
- `ntokens` 是非 padding target label 数，用于归一化 loss。

[`subsequent_mask()`](../../code/annotated-transformer/the_annotated_transformer.py) 创建 `[1, T, T]` 下三角布尔矩阵。Multi-head attention 再增加 head 维，依靠广播扩展到 batch 和 heads。

## 9. 训练循环

[`run_epoch()`](../../code/annotated-transformer/the_annotated_transformer.py) 对每个 `Batch` 执行 model forward、loss compute、backward、optimizer step 和 scheduler step。`TrainState` 记录 step、accumulation step、samples 与 tokens。

值得注意的是，当前源码中 `loss_node = loss_node / accum_iter` 被注释；但 optimizer 只在 `i % accum_iter == 0` 时 step。若把它当作标准 gradient accumulation 模板复用，需要重新核对首步更新条件、梯度缩放和尾部不足一个 accumulation window 的处理，不能直接假设语义完善。

`LabelSmoothing` 构造平滑后的 target distribution，并把 padding 位置清零。目标不是把全部概率放到正确类别，而是保留一小部分给其他非 padding 类别，缓解过度自信。训练 loss 最终按有效 token 数归一化。

仓库还演示 Noam 学习率：模型维度缩放、线性 warmup 与之后的逆平方根衰减共同决定每步 learning rate。调度器按 batch step 更新，不按 epoch 更新。

## 10. 推理链

[`greedy_decode()`](../../code/annotated-transformer/the_annotated_transformer.py) 先计算一次 encoder memory，然后循环：

```text
已有 ys
  → decode(memory, ys, causal mask)
  → 取最后位置 hidden
  → Generator
  → argmax 得到 next_word
  → 拼接到 ys
```

这是 greedy decoding，没有 beam search、sampling、temperature、重复惩罚，也没有 KV cache。每生成一个 token 都重算整个 decoder prefix，适合教学但不是高性能推理实现。

## 11. 实现限制与阅读注意

- 单文件混合解释、绘图、数据下载、分布式训练和模型定义，适合顺序学习，不适合直接作为生产 library。
- 代码对应 encoder-decoder 翻译模型，不能直接映射为 decoder-only LLM。
- pre-norm 实现与论文叙述存在差别，应以 `SublayerConnection` 实际代码为准。
- attention 是朴素二次复杂度实现，没有 fused kernel 或 memory-efficient attention。
- 训练示例依赖外部数据、spaCy 模型和多进程环境；阅读核心结构无需完整执行 WMT 训练。
- `model-api-adaptation.md` 明确说明本项目没有远程模型 API 适配层，不应硬套 Coding Agent 的 Provider 分析框架。

## 12. 推荐阅读与单步调试顺序

1. `make_model()`：先看完整对象图。
2. `EncoderDecoder.forward()`：确认 encode/decode 边界。
3. `EncoderLayer`、`DecoderLayer`、`SublayerConnection`：理解残差主链。
4. `MultiHeadedAttention.forward()` 与 `attention()`：逐行标注形状。
5. `Batch.make_std_mask()`：验证 padding 与 causal mask。
6. `run_epoch()`、loss compute、`LabelSmoothing`：追踪一次参数更新。
7. `greedy_decode()`：对照训练时的 target shift 理解自回归生成。

最小调试时可用 `make_model(11, 11, N=2)` 和仓库已有 copy-task 数据，打印每层 shape 与 mask；无需先运行完整翻译训练。
