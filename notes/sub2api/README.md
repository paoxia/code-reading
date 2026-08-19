# Sub2API 架构与网关主链

## 1. 研究范围和版本

- 上游仓库：`https://github.com/Wei-Shaw/sub2api`
- 分支：`main`
- 原始研究提交：`5a8d6c4e41e38f05cea4164e6ff03443fc0f6923`
- 2026-08-19 增量复核提交：`ae62854abcb1285e0abc4e69d7465e78518d7d4b`
- 增量复核提交时间：2026-08-19 16:42:52 +08:00
- 本轮范围：启动流程、依赖组装、API 网关主链、账号调度、计费记录、数据层和前端控制面

本文以本地源码为准。项目 README 的技术栈表仍写 Go 1.25.7，但
[`backend/go.mod`](../../code/sub2api/backend/go.mod) 已声明 Go 1.26.5；阅读和构建时应以后者为准。

## 2. 一句话认识 Sub2API

Sub2API 是一个带控制面的多租户 AI API 网关：用户使用平台签发的 API Key 调用
Anthropic、OpenAI、Gemini 等兼容端点，系统在请求进入上游之前完成鉴权、额度检查、
账号选择、并发与速率控制，在响应返回时处理流式协议、故障切换和用量计费。

它不是一个只做 URL 转发的轻量代理。核心复杂度集中在以下几个方面：

1. 一个客户端协议可能根据分组和账号平台路由到不同上游。
2. 同一上游平台背后有多个账号，需要粘性会话、负载感知和故障切换。
3. 流式响应一旦向客户端写出语义内容，就不能随意切换账号，否则会拼接出损坏的 SSE 流。
4. 用户、API Key、订阅、分组、账号和模型价格共同决定请求是否可执行以及如何计费。

增量版本还新增了 `composite` 分组路由层。这类 API Key 不固定绑定一种 provider，而是先根据客户端 model、endpoint 和管理员配置的 exact/prefix route 解析为具体平台与 upstream model，再进入原有账号选择、限额、计费和故障归因链。未知模型会 fail closed，它不是根据任务语义自动选厂商的“智能路由”。设计边界见
[`COMPOSITE_GROUPS.md`](../../code/sub2api/docs/COMPOSITE_GROUPS.md)。

Composite 已覆盖 Responses、Chat Completions、Messages、count tokens、Gemini、embedding、image 以及 Codex `backend-api/codex`、Alpha Search/Live/Models 等入口；新增 Kimi、Zhipu 和 DeepSeek 具体平台后，路由决策仍以 concrete platform 执行配额和计费，不会生成一套独立 composite 价格。

## 3. 整体架构

```text
                        ┌───────────────────────────────┐
                        │ Vue 3 管理与用户控制面        │
                        │ router + Pinia + Axios        │
                        └──────────────┬────────────────┘
                                       │ /api/v1/* (JWT)
客户端 SDK / CLI                       │
Anthropic / OpenAI / Gemini 协议        │
          │                            │
          └──────────┬─────────────────┘
                     ▼
              Gin Router / Middleware
                     │
          ┌──────────┴──────────┐
          │                     │
    控制面 Handler         Gateway Handler
          │                     │
          └──────────┬──────────┘
                     ▼
                  Service
       鉴权、调度、并发、计费、OAuth、支付
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
  Repository / Ent         HTTPUpstream
  PostgreSQL + Redis       代理/TLS/上游 API
```

后端是一个分层单体：

| 层 | 主要目录 | 职责 |
|---|---|---|
| 启动与组装 | [`backend/cmd/server`](../../code/sub2api/backend/cmd/server) | 首次安装判断、配置加载、Wire 依赖组装、HTTP 服务生命周期 |
| HTTP 接入 | [`backend/internal/server`](../../code/sub2api/backend/internal/server) | Gin 中间件、路由注册、HTTP/H2C 配置 |
| Handler | [`backend/internal/handler`](../../code/sub2api/backend/internal/handler) | 协议输入输出、请求编排、错误响应、故障切换循环 |
| Service | [`backend/internal/service`](../../code/sub2api/backend/internal/service) | 调度、并发、计费、OAuth、上游协议适配等业务逻辑 |
| Repository | [`backend/internal/repository`](../../code/sub2api/backend/internal/repository) | PostgreSQL、Redis 和外部客户端的具体实现 |
| 数据模型 | [`backend/ent/schema`](../../code/sub2api/backend/ent/schema) | Ent schema；SQL migration 是实际数据库结构的权威来源 |
| 前端 | [`frontend/src`](../../code/sub2api/frontend/src) | Vue 用户端、管理端、运营监控和首次安装页面 |

依赖方向大体是 `server → handler → service ← repository`。Repository 实现的是 Service
层声明的接口，例如 [`APIKeyRepository`](../../code/sub2api/backend/internal/service/api_key_service.go)
和 [`AccountRepository`](../../code/sub2api/backend/internal/service/account_service.go)。这样 Service
不直接依赖 Ent 的具体查询实现，也方便测试使用 stub。

## 4. 启动和依赖注入

程序入口是 [`backend/cmd/server/main.go`](../../code/sub2api/backend/cmd/server/main.go)。启动分三条路径：

```text
main
 ├─ -version             → 输出版本后退出
 ├─ -setup               → 命令行安装向导
 ├─ NeedsSetup() = true  → 自动安装或启动 Web 安装向导
 └─ 已完成安装            → runMainServer()
                              ├─ 加载配置和日志
                              ├─ initializeApplication()
                              ├─ 启动 Prompt Audit
                              ├─ ListenAndServe()
                              └─ SIGINT/SIGTERM 后优雅关闭
```

[`backend/cmd/server/wire.go`](../../code/sub2api/backend/cmd/server/wire.go) 用 Google Wire
静态生成对象图，ProviderSet 的组装顺序表达了主要架构：

```text
config
  → repository
  → service / securityaudit / payment
  → middleware
  → handler
  → server
  → Application
```

Wire 生成结果在
[`backend/cmd/server/wire_gen.go`](../../code/sub2api/backend/cmd/server/wire_gen.go)。读架构时先读
`wire.go` 看意图，需要确认真实构造顺序时再看生成文件。

`Application.Cleanup` 会并行停止大多数后台服务，随后按顺序关闭 Redis 和 Ent。这里说明
Sub2API 的主进程还承载 token 刷新、过期清理、用量聚合、告警、邮件、备份等后台任务，
并不是无状态的纯 HTTP 转发器。

## 5. 路由分成控制面和数据面

[`backend/internal/server/router.go`](../../code/sub2api/backend/internal/server/router.go) 统一注册路由：

- `/api/v1/auth/*`：登录、注册、刷新 token 等控制面认证。
- `/api/v1/user/*`、`/api/v1/keys/*`、`/api/v1/admin/*`：用户与管理接口，主要使用 JWT。
- `/api/v1/payment/*`：订单、支付和回调。
- `/v1/*`：Anthropic/OpenAI 兼容网关，使用平台 API Key。
- `/v1beta/*`：Gemini 原生兼容层。

网关端点集中在
[`backend/internal/server/routes/gateway.go`](../../code/sub2api/backend/internal/server/routes/gateway.go)。
`/v1/messages`、`/v1/responses` 和 `/v1/chat/completions` 并不固定指向一个实现，而是先读取
API Key 所属分组的平台：OpenAI/Grok 分组进入 `OpenAIGatewayHandler`，其他分组进入
`GatewayHandler`；Gemini 则还有独立的 `/v1beta/models/*` 兼容入口。

## 6. `/v1/messages` 的完整请求链

### 6.1 第一层：API Key 中间件

入口中间件在
[`backend/internal/server/middleware/api_key_auth.go`](../../code/sub2api/backend/internal/server/middleware/api_key_auth.go)。
它依次完成：

1. 从 `Authorization: Bearer`、`x-api-key` 或 `x-goog-api-key` 提取凭证。
2. 限制凭证长度并拒绝 query string 传 Key。
3. 通过 `APIKeyService.GetByKey` 加载 API Key，同时带出 User 和 Group。
4. 检查 Key 状态、用户状态、IP 黑白名单和分组可用性。
5. 非 Simple 模式下加载订阅，并检查过期、Key 配额、订阅窗口或用户余额。
6. 把 API Key、用户身份、订阅和分组写入 Gin context。

`/v1/usage` 和 `/v1/sub2api/billing` 只要求身份有效，会跳过部分计费执行，使额度耗尽的
Key 仍能查询自身状态。这是有意的端点级例外，不应理解成网关普遍跳过计费。

### 6.2 第二层：GatewayHandler 编排

[`GatewayHandler.Messages`](../../code/sub2api/backend/internal/handler/gateway_handler.go) 是理解网关
最重要的入口。主流程可压缩为：

```text
读取并解析请求体
  → 识别模型、stream、thinking、Claude Code 客户端
  → 内容安全审计
  → 获取用户并发槽位
  → 等待后再次检查余额/订阅
  → 生成 sessionHash，查询粘性账号
  → SelectAccountWithLoadAwareness
  → 获取或等待账号并发槽位
  → 可选的用户消息串行化/RPM 节流
  → 按账号平台调用 GatewayService / AntigravityGatewayService
  → 成功：刷新粘性绑定、递增 RPM、异步记录 usage
  → 失败：分类错误，决定原账号重试、切换账号或立即返回
```

余额在并发等待之后会二次检查，这是为了避免多个已通过入口校验的排队请求在真正执行时
共同透支旧余额。

### 6.3 第三层：账号调度

调度入口是
[`GatewayService.SelectAccountWithLoadAwareness`](../../code/sub2api/backend/internal/service/gateway_scheduling.go)。
主要约束包括：

- 分组平台和模型支持范围。
- 已在本次 failover 中失败的账号排除集。
- 粘性会话绑定账号。
- 账号启用状态、模型映射、配额窗口和 RPM。
- 当前并发负载与等待队列上限。
- Anthropic/Gemini 分组的 mixed scheduling。
- 分组定义的模型路由账号列表。

返回值 [`AccountSelectionResult`](../../code/sub2api/backend/internal/service/gateway_service.go)
不只包含账号，还会表达槽位是否已经获得：

- `Acquired=true`：调度阶段已原子获得账号槽位，并返回 `ReleaseFunc`。
- `Acquired=false` 且 `WaitPlan!=nil`：Handler 可按超时和最大等待数排队。
- 没有可用账号或等待计划：请求直接失败。

这种设计把“选哪个账号”和“这个账号当前是否能执行”放在同一次调度决策里，减少选择后
再竞争槽位造成的偏差。

### 6.4 第四层：请求改写和上游转发

Anthropic 主转发逻辑在
[`backend/internal/service/gateway_forward.go`](../../code/sub2api/backend/internal/service/gateway_forward.go)。
它会根据账号类型分流到 API Key passthrough、Bedrock 或 OAuth 路径，并可能执行：

- 渠道级和账号级模型映射。
- Claude Code 客户端识别及 OAuth 请求兼容改写。
- `cache_control` 数量限制和缓存策略处理。
- beta header 策略校验。
- 获取或刷新上游访问凭证。
- 通过 [`HTTPUpstream`](../../code/sub2api/backend/internal/service/http_upstream_port.go) 接口及其
  [`Repository 实现`](../../code/sub2api/backend/internal/repository/http_upstream.go) 应用代理、TLS 指纹和连接控制。
- 解析普通 JSON 或 SSE 流式响应，并提取 usage 与首 token 延迟。

同一账号的可重试错误最多尝试 5 次，采用指数退避，并受 10 秒总窗口限制。重试耗尽后，
Service 返回 `UpstreamFailoverError`，由 Handler 的 `FailoverState` 决定是否切换账号。

这里有一个关键不变量：Handler 会比较转发前后的 `c.Writer.Size()`。如果已经向客户端写出
流式语义内容，就禁止切换账号，避免把两个上游的 SSE 内容拼接成一个响应。只有明确标注
`SafeToFailoverAfterWrite` 的非语义输出才有例外。

### 6.5 第五层：用量和计费

转发结果用 [`ForwardResult`](../../code/sub2api/backend/internal/service/gateway_service.go) 返回实际模型、
token、缓存 token、耗时、首 token 延迟和图片计费字段。

Handler 成功返回客户端后，通过 `UsageRecordWorkerPool` 异步调用
[`GatewayService.RecordUsage`](../../code/sub2api/backend/internal/service/gateway_usage_billing.go)。核心计算会综合：

- 实际上游模型及模型单价。
- input/output/cache token。
- 分组默认倍率与用户在该分组的专属倍率。
- 订阅模式、余额模式和平台配额。
- 图片数量与尺寸等非 token 计价维度。

这意味着“响应已经成功”和“计费记录已经持久化”不完全同步。代码提供 worker pool、Redis
累计和 flusher 指标来处理吞吐与可观测性，但运维时仍应关注异步落库失败相关指标。

## 7. 数据层

[`backend/internal/repository/ent.go`](../../code/sub2api/backend/internal/repository/ent.go) 初始化 PostgreSQL
和 Ent。启动时会先运行嵌入式 SQL migrations，再创建 Ent client。源码明确说明：
SQL migration 是 schema 的权威来源，不能把 Ent 自动迁移当作生产结构依据。

主要持久化实体包括：

- `User`、`APIKey`、`Group`、`Account`：鉴权和路由核心。
- `UsageLog`、`UserSubscription`、`UserPlatformQuota`：用量与计费。
- `Proxy`、`TLSFingerprintProfile`：上游网络出口。
- `Setting`、`AuditLog`、批量图片和支付相关实体。

Redis 承担的是易变协调状态，例如 API Key 缓存、粘性会话、并发槽位、RPM、计费缓存和
leader lock。阅读具体能力时，通常可以从 Service 接口跳到
[`backend/internal/repository/wire.go`](../../code/sub2api/backend/internal/repository/wire.go) 找到实现绑定。

## 8. 前端控制面

前端入口 [`frontend/src/main.ts`](../../code/sub2api/frontend/src/main.ts) 依次初始化 Pinia、注入配置、
i18n 和 Vue Router。后端可把构建产物嵌入 Go 二进制，相关服务逻辑在
[`backend/internal/web`](../../code/sub2api/backend/internal/web)。

[`frontend/src/router/index.ts`](../../code/sub2api/frontend/src/router/index.ts) 将页面分成安装、公开、
用户和管理员区域，并用 route meta 表达 `requiresAuth`、`requiresAdmin`、支付和风控等功能要求。

统一 HTTP 客户端在
[`frontend/src/api/client.ts`](../../code/sub2api/frontend/src/api/client.ts)：

- 默认访问 `/api/v1` 控制面，而不是 `/v1` 模型网关。
- 请求拦截器附加 JWT、语言和时区。
- 响应拦截器解包 `{code, message, data}`。
- 多个请求同时收到 401 时，只发起一次 refresh 请求，其余请求排队等待新 token。
- refresh 失败会清理本地认证状态并跳转登录页。

因此需要区分两套认证：浏览器控制面使用 JWT/refresh token；模型数据面使用用户创建的
API Key。它们最终都关联到同一个用户与权限模型，但入口中间件不同。

## 9. 扩展机制和设计取舍

1. **Wire ProviderSet**：新增完整业务模块时通常要同时补 repository、service、handler 和路由绑定。
2. **Service 层接口**：接口多定义在消费者所在的 service 文件中，Repository 提供实现，利于 stub 测试。
3. **平台分派**：路由和 Handler 根据 Group/Account 的 platform 分派到 Anthropic、OpenAI、Grok、Gemini 或 Antigravity 实现。
4. **Context 元数据**：用户、分组、平台、客户端特征和 failover 状态大量通过 request context 传递；增加 key 时应避免类型和生命周期混乱。
5. **后台任务**：许多 Service 构造后会启动 worker 或定时任务，新增此类能力必须同时接入 `Cleanup`。

## 10. 限制、风险和注意事项

- [`GatewayHandler.Messages`](../../code/sub2api/backend/internal/handler/gateway_handler.go) 同时承担协议处理、并发、调度、队列、failover 和计费任务提交，函数很长，修改时回归面较大。
- 调度使用若干 soft limit。源码明确接受 RPM 检查与成功后递增之间的 TOCTOU 竞态，高并发下可能短暂超限。
- 用量记录是异步路径；需要结合 ops 指标判断 Redis 累计、flusher 或数据库写入是否退化。
- 流式响应的错误处理必须维持“已写出语义内容后不切换账号”的不变量。
- `code/sub2api/README_CN.md` 将 Sora 标为“暂不可用”，相关配置不应视为当前可用能力。
- `gateway_service.go` 中仍保留计划在 2026-09 后移除的 legacy quota 指标，属于明确标注的兼容路径。
- 项目迭代很快，本笔记绑定到上述 commit；阅读最新代码时应先核对版本和迁移变化。

## 11. 测试布局

当前版本本地可见约 943 个后端 `_test.go` 文件和 179 个前端 `spec/test` 文件。重点测试入口包括：

- [`backend/internal/server/api_contract_test.go`](../../code/sub2api/backend/internal/server/api_contract_test.go)：路由和 API 契约。
- [`backend/internal/server/routes/gateway_test.go`](../../code/sub2api/backend/internal/server/routes/gateway_test.go)：网关路由分派。
- [`backend/internal/server/middleware/api_key_auth_test.go`](../../code/sub2api/backend/internal/server/middleware/api_key_auth_test.go)：API Key 鉴权边界。
- [`backend/internal/service/gateway_multiplatform_test.go`](../../code/sub2api/backend/internal/service/gateway_multiplatform_test.go)：多平台账号选择、粘性会话与负载感知调度。
- [`frontend/src/api/__tests__/client.spec.ts`](../../code/sub2api/frontend/src/api/__tests__/client.spec.ts)：JWT 附加和刷新队列。
- [`frontend/src/router/__tests__/guards.spec.ts`](../../code/sub2api/frontend/src/router/__tests__/guards.spec.ts)：前端路由守卫。

本轮是静态源码分析，没有执行构建或测试。

## 12. 推荐阅读顺序

1. [`README_CN.md`](../../code/sub2api/README_CN.md)：先建立产品和部署概念。
2. [`backend/cmd/server/main.go`](../../code/sub2api/backend/cmd/server/main.go)：看三种启动模式。
3. [`backend/cmd/server/wire.go`](../../code/sub2api/backend/cmd/server/wire.go)：看完整对象图。
4. [`backend/internal/server/router.go`](../../code/sub2api/backend/internal/server/router.go) 和 [`routes/gateway.go`](../../code/sub2api/backend/internal/server/routes/gateway.go)：区分控制面与数据面。
5. [`backend/internal/server/middleware/api_key_auth.go`](../../code/sub2api/backend/internal/server/middleware/api_key_auth.go)：理解请求为何能进入 Handler。
6. [`GatewayHandler.Messages`](../../code/sub2api/backend/internal/handler/gateway_handler.go)：跟随一次完整请求。
7. [`gateway_scheduling.go`](../../code/sub2api/backend/internal/service/gateway_scheduling.go)：理解账号为何被选中。
8. [`gateway_forward.go`](../../code/sub2api/backend/internal/service/gateway_forward.go) 和 [`gateway_upstream_response.go`](../../code/sub2api/backend/internal/service/gateway_upstream_response.go)：理解协议改写、重试和流式响应。
9. [`gateway_usage_billing.go`](../../code/sub2api/backend/internal/service/gateway_usage_billing.go)：最后补齐计费闭环。
10. [`frontend/src/api/client.ts`](../../code/sub2api/frontend/src/api/client.ts) 与 [`frontend/src/router/index.ts`](../../code/sub2api/frontend/src/router/index.ts)：理解管理控制面。

## 13. 核心结论

Sub2API 的核心并不是某一个上游 API client，而是围绕一次模型请求建立的协调协议：

```text
身份与额度
  → 用户并发
  → 分组/模型路由
  → 账号负载与粘性会话
  → 账号并发/RPM
  → 请求协议适配
  → 上游流式传输
  → 错误重试与账号切换
  → 异步用量计费
```

后续深入某个平台实现时，应继续围绕这条主链阅读，而不是从大量独立的 Handler 或页面随机开始。
