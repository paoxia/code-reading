# 基于 pi 构建自有 Coding Agent：当前接口与实施路线

> 本轮复核：2026-11-02；本地源码 `62752fd4c37a72e0f3c1cc83e9ac3b4299f31fe6`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 先选择要复用的层

当前选择应基于三条实际入口，而不是旧 `packages/agent/src/harness`：

| 路线 | 复用入口 | 自己需要承担 |
| --- | --- | --- |
| 现成终端与 SDK | [AgentSession](../../code/pi/packages/coding-agent/src/core/agent-session.ts) | 产品配置、UI、宿主策略与发布 |
| 轻量自建 Loop | [Agent](../../code/pi/packages/agent/src/agent.ts) + [pi-ai](../../code/pi/packages/ai/README.md) | 持久化、恢复、输入准入与产品工具 |
| Durable 服务 | [pi-durable](../../code/pi/packages/durable/README.md) | 实验 API 迁移、业务幂等、权限与运维 |

这是根据当前抽象提出的实施建议，不表示仓库已有一套满足所有业务要求的产品。Durable 的存在使“需要恢复就必须 fork”不再是默认判断，但它也没有替宿主实现租户权限或外部系统事务。

## 建议架构

```text
自有 CLI / Web / IDE
  → 输入准入、身份、会话路由
  → 所选 pi runtime
      → pi-ai → Provider
      → tool registry → 授权 / sandbox → execute
      → 会话存储 / transcript / audit
  → 产品事件与结果验收
```

先固定一个工作区和单个会话的正确行为，再增加并发、远程执行和多租户。不要让两个独立 runtime 同时拥有同一 Session 的写入权。

## 版本与 API 的落地方法

依赖版本以当前 [coding-agent package.json](../../code/pi/packages/coding-agent/package.json)、[durable package.json](../../code/pi/packages/durable/package.json) 及锁文件为准，固定经过验证的组合。旧笔记中的 0.83/0.84 示例只代表当时快照，本轮不再作为可复制的安装清单。

构建一个最小可运行纵切面：创建会话、提交输入、完成一次工具调用、观察完成/失败、关闭并重开。Durable 可从 `Harness.open()`、`root()`、`submit()`、`wait()` 和 `close()` 追踪，但应以该快照 README 的真实类型签名为准。

## 权限与工具副作用

模型可见的 tool schema 是能力描述。执行前仍需检查工作目录、文件访问、Shell/网络边界和审批；执行后要保存最终结果，处理中断及重复恢复。

持久化的 tool intent 与外部动作不天然原子。对于发消息、部署、支付等操作，宿主需要 request ID、幂等键或可查询状态；不能用重放 transcript 自动重做所有外部动作。

## 扩展与上下文

优先用工具和 extension 接入业务，再判断是否需要改 Loop。上下文构造与压缩需保留用户目标、约束、未完成事项以及工具调用配对；UI 的展示历史不要直接当成 Provider messages。

Durable 将 entries、documents 与 tasks 组合进原子 commit；自有状态可通过 document 协议参与。但它仍是实验接口，采用时应把格式迁移和回滚方案纳入版本升级。

## 必须验证的行为

1. prompt、steer、follow-up 的消费边界与同会话并发。
2. 工具成功、失败、取消和缺失结果的配对。
3. 模型请求中断、进程崩溃和存储失败后的继续方式。
4. compaction 前后约束、工具结果和未完成意图是否保留。
5. 权限拒绝能否在副作用之前生效。

可先阅读 [工具测试](../../code/pi/packages/durable/test/harness-tools.test.ts)、[重启测试](../../code/pi/packages/durable/test/harness-restart-failure.test.ts) 和 [压缩测试](../../code/pi/packages/durable/test/harness-compaction.test.ts)，然后为自身业务边界设计验收。本文是源码研究与方案更新，本轮没有实现或运行自有 Agent。
