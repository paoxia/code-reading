# EPLB：专家复制、分层放置与负载映射

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`d52c72d5b2f2fb4c41afbf8eb21366820239913d`（提交日期 2025-03-24）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

EPLB 输入专家负载估计和集群形状，输出逻辑专家到物理副本的放置方案。它是 MoE 负载均衡算法，负载采集、权重迁移和在线生效由宿主系统完成。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| rebalance_experts | [eplb.py](../../code/eplb/eplb.py) | 根据拓扑选择策略并生成双向映射 |
| 接口示例 | [README.md](../../code/eplb/README.md) | 展示负载输入及 physical/logical 映射 |

## 主要执行链

```text
estimated expert weights + replica/node/GPU counts
  → hierarchical 或 global policy
  → replicate_experts → balanced_packing
  → phy2log / log2phy / logcnt
```

## 关键机制与扩展边界

`replicate_experts()` 反复给当前单副本平均负载最大的逻辑专家增加副本；`balanced_packing()` 在每个 pack 元素数固定的约束下做启发式分配。分层策略优先把专家 group 放到 node，再在 node 内复制和分配到 GPU；条件不满足时使用全局策略。

输出的三个张量分别回答“物理槽位是谁”“某逻辑专家有哪些副本”“共有多少副本”。它们是部署映射，不是实际 token dispatch 结果；与 DeepEP 结合还需要宿主同步路由及权重状态。

## 深入：副本数与物理放置是两个步骤

[replicate_experts](../../code/eplb/eplb.py) 每次选择 `weight/logcnt` 最大的逻辑专家增加副本，假设负载在副本间可摊分；随后 balanced_packing 在固定每 GPU 槽位数的前提下做降序启发式装箱。

例如按 helper 手工推导，负载 `[12,4]` 扩到 4 个副本时，两个新增副本都给第一个专家，得到副本数 `[3,1]`，理想单副本负载均为 4。这只是规划所用的负载模型，不证明实际 token 路由必然均分。

## 深入：三张输出表怎样配合

| 输出 | 解释 | 调用方不能忽略的部分 |
| --- | --- | --- |
| phy2log | 每个物理槽位存哪个逻辑专家 | 权重应按该映射部署 |
| log2phy | 某个逻辑专家有哪些物理副本 | 未使用位置填 -1，需要结合 logcnt |
| logcnt | 每个逻辑专家实际副本数 | 选择副本时只遍历有效项 |

入口会把 weight 转为 float CPU tensor；它是规划实现，不能误读为每次 GPU token dispatch 的热路径。groups 可按 nodes 整除时走分层策略，否则通过统一的单 group/node 退化配置执行全局规划。

输出方案还需要宿主协调权重迁移、路由切换及在途批次。单独调用 rebalance_experts 不会在线修改 DeepEP、模型权重或已有请求的专家映射。

## 限制与注意事项

README 明确把专家负载预测排除在仓库范围之外。整除条件由 assert 约束，算法是启发式，不能写成求得任意拓扑下的全局最优方案。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [README.md](../../code/eplb/README.md) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
