# AgentScope Java A2A：卡片、远程调用与 SDK 迁移

> 本轮复核：2026-11-02；本地源码 `1d8f9dc04e0e6c7e4d54074331cd5059a87cfa1d`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 当前版本与旧笔记修订

本地 [依赖 BOM](../../code/agentscope-java/agentscope-dependencies-bom/pom.xml) 统一配置 `a2a-java-sdk.version = 1.4.0.Final`，当前实现使用 `org.a2aproject.sdk.*`。旧笔记中 SDK 0.3.3.Final、全部 import 为 io.a2a.*、卡片硬编码 protocolVersion 0.3.0 的说明不再适用于当前实现。

当前卡片通过 supportedInterfaces 描述端点，[卡片测试](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-protocol/agentscope-extensions-a2a/agentscope-extensions-a2a-server/src/test/java/io/agentscope/core/a2a/server/card/AgentScopeAgentCardConverterTest.java) 对默认 interface 的 protocolVersion 断言为 1.0；显式兼容接口和 Nacos 转换仍应逐条读取，不能由默认值推导所有连接都使用同一协议。

## 分层

| 层 | 当前入口 | 职责 |
| --- | --- | --- |
| Client | [A2A client](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-protocol/agentscope-extensions-a2a/agentscope-extensions-a2a-client/src/main/java) | 远程 Agent、card resolver 与消息转换 |
| Server | [AgentScopeAgentExecutor](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-protocol/agentscope-extensions-a2a/agentscope-extensions-a2a-server/src/main/java/io/agentscope/core/a2a/server/executor/AgentScopeAgentExecutor.java) | 连接 SDK task/event 与本地 Agent runner |
| Card | [AgentScopeAgentCardConverter](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-protocol/agentscope-extensions-a2a/agentscope-extensions-a2a-server/src/main/java/io/agentscope/core/a2a/server/card/AgentScopeAgentCardConverter.java) | 卡片、能力、security 与 interface 顺序 |
| Transport SPI | [TransportWrapperBuilder](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-protocol/agentscope-extensions-a2a/agentscope-extensions-a2a-server/src/main/java/io/agentscope/core/a2a/server/transport/TransportWrapperBuilder.java) | 可插拔传输包装 |
| Spring starter | [starter](../../code/agentscope-java/agentscope-extensions/agentscope-spring-boot-starters/agentscope-a2a-spring-boot-starter/src/main/java/io/agentscope/spring/boot/a2a) | Agent card 与 JSON-RPC 控制器、自动装配 |
| Discovery | [Nacos A2A](../../code/agentscope-java/agentscope-extensions/agentscope-extensions-nacos/agentscope-extensions-nacos-a2a) | 注册、发现和卡片转换 |

## 一次远程执行

```text
本地 A2A Agent → card / supported interface
  → SDK client / transport → remote task
  → AgentScopeAgentExecutor → AgentRunner → 本地 ReActAgent
  → message / artifact / task event → transport → client
```

A2A 的 task、message 和 artifact 与本地 Msg/ToolResult 不是同一对象层，客户端与服务端都需做内容和生命周期映射。媒体、thinking 与工具相关内容应继续读 parser/router，不能把任意 part 当作纯文本。

## 卡片顺序与能力边界

Converter 将 preferred interface 放在 supportedInterfaces 首位，因为客户端会选择第一个支持的接口。没有显式 preferred 配置时优先找 JSONRPC，找不到再从已有 transport 选择；最终没有任何 interface 则报错。

默认 capabilities 设置 streaming=true、pushNotifications=false、extendedAgentCard=false。存在 SDK 类型或 SPI 不等于所有协议、推送和认证功能都由当前 starter 实现；Spring starter 本地可见的是 AgentCardController 与 A2aJsonRpcController。

## 阅读与验证

推荐 BOM → converter/测试 → client 消息转换 → server executor → starter → Nacos。传输安全、服务认证、权限与多租户属于部署边界，不会因为 Agent 能互调就自动得到完整隔离。本文没有启动远程服务或运行兼容性测试。
