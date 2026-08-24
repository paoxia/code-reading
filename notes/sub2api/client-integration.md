# Sub2API 客户端接入原理：Codex、Claude Code、Gemini CLI、Grok CLI 与 OpenCode

## 1. 研究范围和版本

- 上游仓库：`code/sub2api`
- 分支：`main`
- 原始研究提交：`5a8d6c4e41e38f05cea4164e6ff03443fc0f6923`
- 2026-08-19 增量复核提交：`ae62854abcb1285e0abc4e69d7465e78518d7d4b`
- 2026-08-24 增量复核提交：`03e8ab41346b42de9ece4e3e5bfcb6ca2b8cb57e`（`0.1.180`）
- 研究范围：用户 API Key、分组平台、客户端配置生成、网关路由、协议转换、账号调度、HTTP/WS 转发和常见接入故障

本文以当前本地源码为准。客户端配置和模型列表变化很快，实际使用时应优先复制控制台“API 密钥 → 使用密钥”弹窗实时生成的配置；该弹窗的实现位于 [`UseKeyModal.vue`](../../code/sub2api/frontend/src/components/keys/UseKeyModal.vue)，对应配置测试位于 [`UseKeyModal.spec.ts`](../../code/sub2api/frontend/src/components/keys/__tests__/UseKeyModal.spec.ts)。

本轮接入侧新增三个注意点：OpenAI Fast mode 的 `service_tier` 已贯穿 Responses、Chat 和 WS，但最终计费以网关观察到的上游档位为准；Responses Lite 强制串行 tool calls；DeepSeek 账号上的 client tools 改走 native Responses 路径。客户端不能仅从请求字段推断实际计费档位或工具并发语义。

## 2. 先建立正确的连接模型

Sub2API 中存在两类完全不同的凭据：

1. **上游账号凭据**：由管理员录入，可能是 Anthropic/OpenAI/Gemini/Grok 的 OAuth、API Key、Setup Token、Bedrock 或 Vertex 凭据。
2. **Sub2API 用户 API Key**：由平台用户创建并绑定到一个分组，交给 Codex、Claude Code 等客户端使用。

客户端不应该获得上游账号的真实凭据。完整链路是：

```text
Codex / Claude Code / Gemini CLI / Grok CLI / OpenCode
                         │
                         │ Sub2API Base URL + 用户 API Key
                         ▼
                 Sub2API 网关入口
                         │
             API Key 鉴权、用户/订阅/额度检查
                         │
                  Key 绑定的分组
                         │
          平台、模型、负载、粘性会话、并发调度
                         │
                 选中一个上游账号
                         │
           协议转换、凭据注入、请求头重写
                         │
       Anthropic / OpenAI / Gemini / xAI 等上游
                         │
           流式响应转换、用量提取、异步计费
                         ▼
                       客户端
```

用户 Key 的创建接口和可选限制定义在 [`api_key_handler.go`](../../code/sub2api/backend/internal/handler/api_key_handler.go) 与 [`api_key_service.go`](../../code/sub2api/backend/internal/service/api_key_service.go)。前端创建 Key 时可以同时设置分组、额度、有效期、IP 黑白名单和 5 小时/1 天/7 天限额，见 [`frontend/src/api/keys.ts`](../../code/sub2api/frontend/src/api/keys.ts)。

网关鉴权中间件接受三种 Header：

```text
Authorization: Bearer <SUB2API_API_KEY>
x-api-key: <SUB2API_API_KEY>
x-goog-api-key: <SUB2API_API_KEY>
```

分别适配 OpenAI 风格、Anthropic 风格和 Gemini CLI 风格客户端；查询参数 `?key=` 与 `?api_key=` 已被明确拒绝。实现见 [`api_key_auth.go`](../../code/sub2api/backend/internal/server/middleware/api_key_auth.go)。

## 3. 分组决定客户端能走哪条链路

当前前端 `GroupPlatform` 已扩展为 `anthropic`、`openai`、`gemini`、`antigravity`、`grok`、`kimi`、`zhipu`、`deepseek` 和 `composite`，见 [`frontend/src/types/index.ts`](../../code/sub2api/frontend/src/types/index.ts)。“使用密钥”弹窗对前五种直接平台有专用 preset，其他平台使用通用 Claude/OpenCode 配置面：

| Key 的分组平台 | 控制台直接提供的客户端配置 | 默认网关协议 |
|---|---|---|
| `anthropic` | Claude Code、OpenCode | Anthropic Messages `/v1/messages` |
| `openai` | Codex CLI、Codex CLI WebSocket、OpenCode；开启 Messages 调度后还显示 Claude Code | OpenAI Responses `/v1/responses` |
| `gemini` | Gemini CLI、OpenCode | Gemini 原生 `/v1beta` |
| `antigravity` | Claude Code、Gemini CLI、OpenCode | `/antigravity/v1` 或 `/antigravity/v1beta` |
| `grok` | Grok CLI、Claude Code、Codex CLI、OpenCode | Responses 兼容入口，按 Grok 账号转发 |
| `kimi` / `zhipu` / `deepseek` | Claude Code、OpenCode | 通用 `/v1` 入口，再按具体平台调度 |
| `composite` | Claude Code、OpenCode（还可由调用方直接使用各协议入口） | 先按 model/endpoint 解析 concrete platform，再进入对应处理链 |

这张表描述的是**控制台正式暴露的推荐组合**。后端还有额外的协议桥，例如 Anthropic 分组的 `/v1/responses` 可以执行 `Responses → Anthropic → Responses` 转换，但控制台没有为 Anthropic 分组生成 Codex 配置，因此不应把它当作与 OpenAI 分组等价的首选接入方式。Composite 更不能只看弹窗 preset 推断能力，它的真实出口由 route registry 的 model/endpoint 决策。路由分派逻辑集中在 [`gateway.go`](../../code/sub2api/backend/internal/server/routes/gateway.go)。

## 4. 接入前的公共准备

无论使用哪种客户端，都建议按下面的顺序准备：

1. 管理员在“账号管理”中添加上游账号，并测试账号可用性。
2. 管理员创建与账号平台匹配的分组，将账号加入分组，并配置模型映射、并发和计费策略。
3. 用户在“API 密钥”页面创建 Key，必须为 Key 选择分组。
4. 在 Key 列表点击“使用密钥”，选择目标客户端和操作系统，复制生成内容。
5. 先用简单 API 请求验证 Base URL、Key 和模型，再启动完整 Agent 客户端。

未绑定分组的 Key 虽然可能存在，但网关路由会通过 `RequireGroupAssignment` 拦截，见 [`middleware.go`](../../code/sub2api/backend/internal/server/middleware/middleware.go)。前端也会在“使用密钥”弹窗中提示先分配分组，调用位置见 [`KeysView.vue`](../../code/sub2api/frontend/src/views/user/KeysView.vue)。

以下示例统一使用：

```text
SUB2API_BASE_URL=https://sub2api.example.com
SUB2API_API_KEY=sk-your-sub2api-key
```

`SUB2API_BASE_URL` 是 Sub2API 对外地址，不是上游 OpenAI 或 Anthropic 地址。末尾一般不要手工重复添加 `/v1`，除非对应客户端配置明确要求。

## 5. Codex CLI 接入

### 5.1 推荐的后台组合

最直接的组合是：

```text
OpenAI 上游账号
  → OpenAI 分组
  → 绑定该分组的用户 API Key
  → Codex CLI
```

OpenAI 上游账号可以是：

- OAuth 账号：最终访问 ChatGPT 内部 Codex Responses 入口。
- API Key 账号：最终访问 `https://api.openai.com/v1/responses` 或管理员配置的兼容 Base URL。

两类账号的目标 URL 选择和认证头注入位于 [`openai_gateway_forward.go`](../../code/sub2api/backend/internal/service/openai_gateway_forward.go)，常量与服务结构位于 [`openai_gateway_service.go`](../../code/sub2api/backend/internal/service/openai_gateway_service.go)，账号 Base URL 规则位于 [`account.go`](../../code/sub2api/backend/internal/service/account.go)。

### 5.2 HTTP Responses 配置

macOS/Linux 配置目录为 `~/.codex`，Windows 为 `%USERPROFILE%\.codex`。当前控制台生成两个文件。

`~/.codex/config.toml`：

```toml
model_provider = "OpenAI"
model = "gpt-5.5"
review_model = "gpt-5.5"
model_reasoning_effort = "xhigh"
disable_response_storage = true
network_access = "enabled"
windows_wsl_setup_acknowledged = true

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://sub2api.example.com"
wire_api = "responses"
requires_openai_auth = true

[features]
goals = true
```

`~/.codex/auth.json`：

```json
{
  "OPENAI_API_KEY": "sk-your-sub2api-key"
}
```

这里的 `wire_api = "responses"` 是关键：Codex 会使用 Responses 协议，而不是旧的 Chat Completions 协议。示例中的模型来自当前源码生成器；如果分组没有该模型，需要换成该分组实际可用或已配置映射的模型。

Windows 只是文件目录不同，文件内容相同。若文件已经存在，应合并配置，不能不加检查地覆盖已有 MCP、sandbox、feature 或 provider 设置。

### 5.3 WebSocket 模式

控制台的“Codex CLI (WebSocket)”标签在普通配置上增加：

```toml
[model_providers.OpenAI]
supports_websockets = true

[features]
responses_websockets_v2 = true
goals = true
```

完整配置仍需保留 `base_url`、`wire_api = "responses"`、认证模式和 `auth.json`。

WebSocket 模式不是简单地把 HTTP 请求换成另一个 URL：

1. 客户端对 `GET /v1/responses`、`GET /responses` 或 `GET /backend-api/codex/responses` 发起 WebSocket Upgrade。
2. 后端要求首条消息是合法的 `response.create` JSON，并从中提取模型。
3. 每个 turn 独立执行安全检查、用户并发、账号并发、调度和计费。
4. OpenAI 分组要求被选账号支持 Responses WSv2；Grok 分组则把入站 WS 桥接到其 HTTP/SSE Responses 上游。

入口实现位于 [`OpenAIGatewayHandler.ResponsesWebSocket`](../../code/sub2api/backend/internal/handler/openai_gateway_handler.go)，连接内转发位于 [`openai_ws_forwarder_ingress.go`](../../code/sub2api/backend/internal/service/openai_ws_forwarder_ingress.go)。账号级 WSv2 开关和模式定义在 [`account.go`](../../code/sub2api/backend/internal/service/account.go)。

HTTP Responses 路径明确拒绝 `previous_response_id`，要求它只能用于 WSv2；因此需要多轮 Responses 原生续链时，应使用 WebSocket 配置。

### 5.4 两种 Codex 认证模式

控制台当前提供：

- **兼容模式**：`requires_openai_auth = true`，这是默认配置。
- **API Key Mode**：生成以下 provider 配置：

```toml
requires_openai_auth = false
http_headers = { "x-openai-actor-authorization" = "local-image-extension" }
```

API Key Mode 用于客户端图片执行器相关授权。源码中的界面说明要求：保存后完全退出并重启 Codex Desktop 或 CLI，再创建新 task，让客户端重新构建工具注册表。相关文案见 [`dashboard.ts`](../../code/sub2api/frontend/src/i18n/locales/zh/dashboard.ts)。

不要把这个选择与“管理员录入的上游账号是 OAuth 还是 API Key”混为一谈：前者是客户端配置方式，后者是 Sub2API 调度到账号后如何访问上游。

### 5.5 Codex HTTP 请求的后端调用链

```text
Codex CLI
  → POST /v1/responses（也兼容 /responses、/backend-api/codex/responses）
  → APIKeyAuthMiddleware
  → 根据 Key.Group.Platform 分派
  → OpenAIGatewayHandler.Responses
  → 校验 JSON/model/stream、安全策略
  → 用户并发与二次计费检查
  → GenerateSessionHash
  → SelectAccountWithSchedulerForCapability
  → OpenAIGatewayService.Forward
  → 选择 OAuth/APIKey 上游 URL 和 HTTP/WS 传输
  → 流式返回客户端
  → 异步 RecordUsage
```

OpenAI/Grok 分组走 [`OpenAIGatewayHandler.Responses`](../../code/sub2api/backend/internal/handler/openai_gateway_handler.go)。其中账号选择不只看“平台相同”，还会综合模型能力、粘性会话、负载、并发、失败账号排除和所需传输能力。

真正转发前，[`OpenAIGatewayService.Forward`](../../code/sub2api/backend/internal/service/openai_gateway_forward.go) 还会：

- 检测 Codex 官方客户端及 `codex_cli_only` 账号限制；
- 应用分组和账号级模型映射；
- 选择 Responses 透传、协议修补或 Chat Completions 回退；
- 处理 `instructions`、reasoning effort、工具声明和图像工具策略；
- 为 OAuth 上游注入 Codex 身份头；
- 将会话 ID 按 Sub2API API Key 隔离，避免不同用户碰撞。

对于明确不支持 `/v1/responses` 的 OpenAI API Key 上游，普通文本请求可以降级走 Chat Completions；但需要原生 Responses 能力的功能不一定能无损降级，尤其是图像工具、WSv2、remote compact 和某些 Responses 专属事件。

### 5.6 Codex 走 Anthropic 分组：存在但不是首选

当 `/v1/responses` 对应的 Key 属于 Anthropic 分组时，路由会进入 [`GatewayHandler.Responses`](../../code/sub2api/backend/internal/handler/gateway_handler_responses.go)，再由 [`ForwardAsResponses`](../../code/sub2api/backend/internal/service/gateway_forward_as_responses.go) 完成：

```text
OpenAI Responses 请求
  → 转成 Anthropic Messages
  → 调度 Anthropic 账号
  → 接收 Anthropic JSON/SSE
  → 转回 OpenAI Responses JSON/SSE
```

这说明 Sub2API 的协议入口和上游平台不是一一绑定的。但控制台并未给 Anthropic 分组提供 Codex 配置标签，协议字段也不可能在所有高级功能上完全等价，所以更适合作为兼容桥或源码扩展点，而不是默认部署方案。

## 6. Claude Code 接入

### 6.1 Anthropic 分组的标准配置

macOS/Linux 当前终端：

```bash
export ANTHROPIC_BASE_URL="https://sub2api.example.com"
export ANTHROPIC_AUTH_TOKEN="sk-your-sub2api-key"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL="https://sub2api.example.com"
$env:ANTHROPIC_AUTH_TOKEN="sk-your-sub2api-key"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
$env:CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

Windows CMD：

```bat
set ANTHROPIC_BASE_URL=https://sub2api.example.com
set ANTHROPIC_AUTH_TOKEN=sk-your-sub2api-key
set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
set CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

也可以写入用户级 `~/.claude/settings.json`；Windows 路径为 `%USERPROFILE%\.claude\settings.json`：

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_BASE_URL": "https://sub2api.example.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-your-sub2api-key",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"
  }
}
```

Claude Code 会在 Base URL 后访问 `/v1/messages` 和 `/v1/messages/count_tokens`。`settings.json` 含明文 API Key，只应保存在用户目录，不能提交到项目仓库；控制台也明确显示了这一警告。

### 6.2 Claude Code 可以连接哪些分组

#### Anthropic 分组

这是原生路径：

```text
Claude Code /v1/messages
  → GatewayHandler.Messages
  → GatewayService.SelectAccountWithLoadAwareness
  → GatewayService.Forward
  → Anthropic API / 自定义 Anthropic Base URL / Bedrock / Vertex
```

核心 Handler 位于 [`gateway_handler.go`](../../code/sub2api/backend/internal/handler/gateway_handler.go)，原生 Anthropic 转发位于 [`gateway_forward.go`](../../code/sub2api/backend/internal/service/gateway_forward.go)，上游 URL、认证头、beta header 和客户端指纹处理位于 [`gateway_upstream_request.go`](../../code/sub2api/backend/internal/service/gateway_upstream_request.go)。

#### OpenAI 分组

管理员必须为分组开启 `allow_messages_dispatch`。该字段默认是 `false`，定义见 [`backend/ent/schema/group.go`](../../code/sub2api/backend/ent/schema/group.go)。开启后，控制台才会为这个 OpenAI Key 显示“Claude Code”标签。

转发链是：

```text
Claude Code Anthropic Messages
  → POST /v1/messages
  → OpenAIGatewayHandler.Messages
  → Anthropic request 转 OpenAI Responses request
  → OpenAI OAuth/API Key 上游
  → Responses JSON/SSE 转回 Anthropic JSON/SSE
  → Claude Code
```

协议转换核心在 [`OpenAIGatewayService.ForwardAsAnthropic`](../../code/sub2api/backend/internal/service/openai_gateway_messages.go)。它会进行 Claude 模型到 GPT/Codex 模型映射、prompt cache key 推导、会话续接和流式事件转换。如果目标 API Key 上游明确不支持 Responses API，还可以走 Anthropic → Chat Completions 的兼容回退。

模型映射不是只替换一个固定字符串。OpenAI 分组同时提供 `default_mapped_model` 和 `messages_dispatch_model_config`：前者作为账号级映射未命中时的默认目标，后者可按 Claude 精确模型或模型系列映射到不同 GPT/Codex 模型；字段定义与更新逻辑分别见 [`backend/ent/schema/group.go`](../../code/sub2api/backend/ent/schema/group.go) 和 [`admin_group.go`](../../code/sub2api/backend/internal/service/admin_group.go)。如果 Claude Code 报“模型不可用”，需要同时检查客户端发送的 Claude 模型名、分组映射和账号自身的模型映射。

这一能力的本质是“让 Claude Code 作为客户端使用 OpenAI/Codex 上游”，并不是把 GPT 模型伪装成真正的 Claude 模型。模型能力、工具行为、上下文长度和计费仍由最终上游及映射规则决定。

#### Grok 分组

Grok 分组固定允许 Messages 调度，不依赖 `allow_messages_dispatch`。控制台会把 Claude Code 的各类默认模型环境变量映射到 `grok-4.5`，并让 `ANTHROPIC_BASE_URL` 指向 Sub2API 根地址。

请求同样进入 `OpenAIGatewayHandler.Messages`，先转 Responses，再走 Grok Responses 转发。Grok 特有的缓存身份和工具兼容处理也位于 [`openai_gateway_messages.go`](../../code/sub2api/backend/internal/service/openai_gateway_messages.go)。

#### Antigravity 分组

Claude Code 的 Base URL 改为：

```bash
export ANTHROPIC_BASE_URL="https://sub2api.example.com/antigravity"
export ANTHROPIC_AUTH_TOKEN="sk-your-sub2api-key"
```

Claude Code 最终访问 `/antigravity/v1/messages`。这个专用路由通过 `ForcePlatform(antigravity)` 强制只选 Antigravity 账号，不与普通 Anthropic 账号混合，见 [`gateway.go`](../../code/sub2api/backend/internal/server/routes/gateway.go)。

项目 README 还描述了 Antigravity 混合调度：开启后通用 `/v1/messages` 也可能调度 Antigravity 账号。但源码和 README 都提醒 Anthropic Claude 与 Antigravity Claude 不应在同一上下文中混用，见 [`README_CN.md`](../../code/sub2api/README_CN.md)。

### 6.3 Claude Code 客户端识别与限制

在进入原生 [`GatewayHandler.Messages`](../../code/sub2api/backend/internal/handler/gateway_handler.go) 的 Anthropic/Antigravity 等路径中，Sub2API 不只检查 `User-Agent`。对于 `/v1/messages`，当前 `ClaudeCodeValidator` 要求：

1. `User-Agent` 匹配 `claude-cli/X.Y.Z`；
2. system prompt 命中 Claude Code/Agent SDK 模板或计费归因块；
3. `X-App`、`anthropic-beta`、`anthropic-version` 非空；
4. `metadata.user_id` 符合 Claude Code 格式。

`/messages/count_tokens` 和 `max_tokens=1 + haiku` 连通性探测存在特定放行路径。实现见 [`claude_code_validator.go`](../../code/sub2api/backend/internal/service/claude_code_validator.go) 与 [`gateway_helper.go`](../../code/sub2api/backend/internal/handler/gateway_helper.go)，测试见 [`claude_code_validator_test.go`](../../code/sub2api/backend/internal/service/claude_code_validator_test.go)。

如果分组启用了 `claude_code_only`：

- 真正的 Claude Code 请求可继续使用该分组；
- 非 Claude Code 客户端若配置了 fallback group，会降级到 fallback group；
- 没有 fallback group 时返回限制错误。

相关调度逻辑在 [`gateway_scheduling.go`](../../code/sub2api/backend/internal/service/gateway_scheduling.go)。这也意味着只伪造一个 `claude-cli/...` User-Agent 并不足以稳定绕过限制。

OpenAI/Grok 分组的 Messages 协议桥由另一套 `OpenAIGatewayHandler.Messages` 处理，入口主要受 `allow_messages_dispatch`、模型映射和 OpenAI/Grok 账号调度约束，不能把上述原生 Claude Code Validator 的所有检查机械套到这条桥接路径上。

## 7. Gemini CLI、Grok CLI 和 OpenCode

### 7.1 Gemini CLI

Gemini 分组的控制台配置为：

```bash
export GOOGLE_GEMINI_BASE_URL="https://sub2api.example.com"
export GEMINI_API_KEY="sk-your-sub2api-key"
export GEMINI_MODEL="gemini-2.0-flash"
```

Windows 可改用 `set` 或 `$env:`。Gemini CLI 最终请求 `/v1beta/models/...:generateContent` 或 `:streamGenerateContent`，并以 `x-goog-api-key` 发送 Sub2API 用户 Key。

路由和方法解析位于 [`gemini_v1beta_handler.go`](../../code/sub2api/backend/internal/handler/gemini_v1beta_handler.go)，原生 Gemini 转发与响应处理位于 [`gemini_messages_compat_service.go`](../../code/sub2api/backend/internal/service/gemini_messages_compat_service.go)。

Antigravity Gemini 的配置只需把 Base URL 改为：

```bash
export GOOGLE_GEMINI_BASE_URL="https://sub2api.example.com/antigravity"
```

对应请求会进入 `/antigravity/v1beta` 并被强制调度到 Antigravity 账号。

### 7.2 Grok CLI

控制台为 Grok CLI 生成 `~/.grok/config.toml`，Windows 为 `%USERPROFILE%\.grok\config.toml`：

```toml
[models]
default = "grok"
web_search = "grok"

[model."grok"]
model = "grok-4.5"
base_url = "https://sub2api.example.com/v1"
name = "Grok 4.5"
api_key = "sk-your-sub2api-key"
api_backend = "responses"
context_window = 1000000
supports_backend_search = true
```

保存后可使用 `grok inspect` 检查生效配置，并在客户端 `/model` 中选择对应模型。模型名和上下文值是当前源码生成器的配置，不代表所有 Grok 上游账号都一定具备同样能力。

### 7.3 Codex 通过 Grok 分组

Grok 分组也可以给 Codex 使用。控制台生成一个自定义 provider：

```toml
model_provider = "sub2api_grok"
model = "grok-4.5"
review_model = "grok-4.5"
model_reasoning_effort = "xhigh"
model_context_window = 1000000

[model_providers.sub2api_grok]
name = "Sub2API Grok"
base_url = "https://sub2api.example.com/v1"
env_key = "SUB2API_API_KEY"
wire_api = "responses"
supports_websockets = true

[features]
responses_websockets_v2 = true
```

启动 Codex 前设置：

```bash
export SUB2API_API_KEY="sk-your-sub2api-key"
```

这里虽然客户端启用了 WebSocket，但后端对 Grok 分组选择 HTTP/SSE 上游，并在 Sub2API 内完成 WS 入站桥接。

### 7.4 OpenCode

控制台为五种直接平台提供专用 `opencode.json`，其他平台使用通用 OpenAI/Anthropic 模板。路径通常是 `~/.config/opencode/opencode.json` 或项目级 `opencode.jsonc`。Base URL 规则为：

| 分组 | OpenCode provider | Base URL |
|---|---|---|
| Anthropic | `@ai-sdk/anthropic` | `https://sub2api.example.com/v1` |
| OpenAI | OpenAI provider | `https://sub2api.example.com/v1` |
| Gemini | `@ai-sdk/google` | `https://sub2api.example.com/v1beta` |
| Antigravity Claude | `@ai-sdk/anthropic` | `https://sub2api.example.com/antigravity/v1` |
| Antigravity Gemini | `@ai-sdk/google` | `https://sub2api.example.com/antigravity/v1beta` |
| Grok | `@ai-sdk/openai` | `https://sub2api.example.com/v1` |

最小结构类似：

```json
{
  "provider": {
    "anthropic": {
      "npm": "@ai-sdk/anthropic",
      "options": {
        "baseURL": "https://sub2api.example.com/v1",
        "apiKey": "sk-your-sub2api-key"
      }
    }
  },
  "$schema": "https://opencode.ai/config.json"
}
```

实际生成内容还包含模型、上下文、输出限制、thinking 和 reasoning variants。由于这些列表容易随版本变化，建议直接复制 [`generateOpenCodeConfig`](../../code/sub2api/frontend/src/components/keys/UseKeyModal.vue) 当前生成的配置，而不是长期维护一份手写模型清单。

OpenCode 属于第三方客户端。它走 Anthropic OAuth 上游时，Sub2API 会识别它不是真正的 Claude Code，并按配置执行 Claude Code 风格的 system、metadata 和 header mimicry；这条逻辑位于 [`GatewayService.Forward`](../../code/sub2api/backend/internal/service/gateway_forward.go)。

## 8. 一次请求如何完成鉴权、调度和计费

不同协议的 Handler 不同，但公共状态流转基本一致：

```text
1. 路由层限制请求体大小，生成 request ID
2. API Key 中间件读取 Bearer/x-api-key/x-goog-api-key
3. 加载 Key 及其 User、Group
4. 检查 Key、用户、分组、IP ACL、订阅和额度
5. Handler 解析 model、stream、system/tools/input
6. 执行内容安全检查
7. 获取用户并发槽位
8. 等待后再次检查余额/订阅
9. 生成 session hash，优先保持粘性账号
10. 按平台、模型、传输能力、负载和限流选择账号
11. 获取账号并发槽位
12. 注入真正的上游凭据并发起请求
13. 流式返回；未输出语义内容前可按策略切换账号
14. 提取 token/缓存/图片等用量并异步记录
```

这里有三个容易混淆的身份：

| 身份 | 来源 | 用途 |
|---|---|---|
| Sub2API 用户 | 用户 API Key 关联的 `User` | 余额、订阅、用户并发、审计 |
| Sub2API 分组 | 用户 API Key 关联的 `Group` | 平台、可用模型、倍率、账号池、协议开关 |
| 上游账号 | 调度器选中的 `Account` | 最终 OAuth/API Key、代理、TLS、上游并发与限流 |

所以“同一个 Key 有时使用不同上游账号”是正常行为；Sub2API 会通过 session hash、`session_id`、`conversation_id`、`prompt_cache_key` 或请求 metadata 尽量维持粘性。发生可切换错误且尚未向客户端写出语义内容时，Handler 可以排除失败账号后重新选择；流式内容已经开始后则不能随意拼接另一个账号的响应。

## 9. 用 curl 分层验证

在启动 Agent 客户端前，先验证网络和 Key，能更快区分客户端配置错误与后台账号错误。

### 9.1 健康检查

```bash
curl https://sub2api.example.com/health
```

### 9.2 Anthropic Messages

```bash
curl https://sub2api.example.com/v1/messages \
  -H "Authorization: Bearer sk-your-sub2api-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Reply with OK"}]
  }'
```

如果测试 OpenAI 分组的 Claude Code 桥，必须先启用 `allow_messages_dispatch`，并将模型改成分组映射能够识别的名称。

### 9.3 OpenAI Responses

```bash
curl https://sub2api.example.com/v1/responses \
  -H "Authorization: Bearer sk-your-sub2api-key" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "Reply with OK",
    "stream": false
  }'
```

### 9.4 Gemini 原生接口

```bash
curl "https://sub2api.example.com/v1beta/models/gemini-2.0-flash:generateContent" \
  -H "x-goog-api-key: sk-your-sub2api-key" \
  -H "content-type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with OK"}]}]}'
```

模型名只是示例，必须以当前分组实际配置为准。收到 `401` 通常先查 Key；`403` 先查分组、订阅、额度或协议开关；`404`/`405` 先查 Base URL 是否重复或缺少 `/v1`、`/v1beta`。

## 10. 反向代理要求

### 10.1 Codex 的下划线请求头

Codex 会使用 `session_id` 等带下划线的 Header。Nginx 默认可能丢弃它们，使多账号粘性会话失效，因此 README 要求在 `http` 块启用：

```nginx
underscores_in_headers on;
```

依据见 [`README_CN.md`](../../code/sub2api/README_CN.md)。这些 Header 不是普通装饰信息：OpenAI 转发代码会读取会话标识，并在转发 OAuth 上游前按 Sub2API API Key 做隔离。

### 10.2 WebSocket Upgrade

使用 Codex WSv2 时，代理必须把 `GET /v1/responses` 的 `Upgrade: websocket` 和 `Connection: upgrade` 传给后端。后端发现不是 Upgrade 请求会返回 `426 WebSocket upgrade required`。同时应避免对 SSE/WS 做响应缓冲，并确保代理空闲超时足够覆盖长任务。

### 10.3 HTTPS 和 Base URL

远程客户端应使用 HTTPS。推荐对外只暴露反向代理端口，不直接把 Sub2API 管理和网关端口裸露到公网。修改后台 `api_base_url` 后，控制台“使用密钥”弹窗才会生成正确的公网地址；它从公共设置读取该字段，见 [`KeysView.vue`](../../code/sub2api/frontend/src/views/user/KeysView.vue)。

## 11. 常见故障定位

| 现象 | 优先检查 | 原因 |
|---|---|---|
| `401 API_KEY_REQUIRED` | 客户端是否发送 Bearer、`x-api-key` 或 `x-goog-api-key` | 登录密码、管理员 API Key 和用户 API Key 不是同一凭据 |
| `401 INVALID_API_KEY` | Key 是否复制完整、状态是否有效 | 中间件未找到该用户 Key |
| 未分组或无可用分组错误 | Key 是否绑定 Group，Group 是否启用 | 网关必须从 Group 推导平台与账号池 |
| `/v1/messages` 返回 403 | OpenAI 分组是否开启 `allow_messages_dispatch` | 该开关默认关闭；Grok 例外 |
| Claude Code only 限制错误 | 是否为官方 Claude Code 请求；是否配置 fallback group | 服务端会检查 UA、system、Header 和 metadata |
| Codex WS 连接失败 | 反向代理 Upgrade、账号 WSv2 开关、Key 并发限制 | WS 入口和每个 turn 都有独立容量检查 |
| HTTP Responses 携带 `previous_response_id` 被拒绝 | 改用 WSv2 | 当前实现只允许 WSv2 原生续链 |
| `No available accounts` | 分组账号、模型映射、账号状态、并发、配额和传输能力 | 有账号不等于该账号支持当前模型/端点 |
| Claude Code 能连但工具行为异常 | 最终上游模型和 Messages 映射 | OpenAI/Grok 桥是协议转换，不保证模型能力完全等同 Claude |
| Codex 多轮任务粘性异常 | Nginx `underscores_in_headers`、`session_id`、代理头 | 丢失会话头会降低粘性命中 |
| OpenCode 走 OAuth Anthropic 被拦 | mimicry 配置、system/header 改写、账号策略 | OpenCode 不会被当作真正 Claude Code |
| 余额查询正常但模型调用失败 | `/v1/usage` 会跳过部分计费拦截 | 用量自省可用不代表模型请求一定满足额度和账号条件 |

排查时建议按“客户端生成配置 → 网关入口 → Key/Group → 模型映射 → 账号调度 → 上游错误”的顺序，不要一开始就把所有问题归因于客户端。

## 12. 限制和安全注意事项

1. **不要提交客户端密钥文件**：`~/.codex/auth.json`、`~/.claude/settings.json` 和 `opencode.json` 都可能包含明文 Sub2API API Key。
2. **客户端 Key 仍有真实权限**：可为 Key 配置额度、有效期、IP 白名单和周期限额，避免所有机器共用一个无限制 Key。
3. **协议转换不是模型等价**：Claude Code 走 OpenAI/Grok，或 Responses 走 Anthropic 时，工具、thinking、缓存、事件类型和上下文限制都可能发生转换或降级。
4. **WSv2 是显式能力**：客户端开启 WS 不代表任意 OpenAI 上游账号都能使用 WSv2；调度器还会检查账号传输能力。
5. **模型清单不是永久事实**：控制台当前生成的 `gpt-5.5`、`grok-4.5`、Gemini/Claude 模型列表绑定本次源码版本，应以部署实例的分组配置和 `/models` 返回为准。
6. **OAuth 内部接口有额外兼容逻辑**：Sub2API 会管理 Codex/Claude Code 身份头、指纹、beta token 和会话隔离。随意在代理层删除或覆盖 Header 可能导致上游 404、第三方客户端判定或缓存失效。
7. **遵守上游条款**：使用订阅账号中转或共享请求可能受到 Anthropic、OpenAI、Google、xAI 等上游服务条款限制，部署者需要自行确认合规性。

## 13. 推荐源码阅读顺序

1. [`UseKeyModal.vue`](../../code/sub2api/frontend/src/components/keys/UseKeyModal.vue)：先看每种分组给客户端生成什么配置。
2. [`gateway.go`](../../code/sub2api/backend/internal/server/routes/gateway.go)：理解 URL 如何按 Group Platform 分派。
3. [`api_key_auth.go`](../../code/sub2api/backend/internal/server/middleware/api_key_auth.go)：理解客户端 Key 怎样变成 User、Group 和订阅上下文。
4. [`openai_gateway_handler.go`](../../code/sub2api/backend/internal/handler/openai_gateway_handler.go)：跟踪 Codex HTTP/WS 和 OpenAI 分组的 Claude Code 桥。
5. [`openai_gateway_forward.go`](../../code/sub2api/backend/internal/service/openai_gateway_forward.go)：理解 OpenAI OAuth/API Key、Responses/Chat 回退和 Codex 请求改写。
6. [`openai_gateway_messages.go`](../../code/sub2api/backend/internal/service/openai_gateway_messages.go)：理解 Anthropic Messages 与 OpenAI Responses 的双向转换。
7. [`gateway_handler.go`](../../code/sub2api/backend/internal/handler/gateway_handler.go) 与 [`gateway_forward.go`](../../code/sub2api/backend/internal/service/gateway_forward.go)：理解原生 Claude Code 主链。
8. [`claude_code_validator.go`](../../code/sub2api/backend/internal/service/claude_code_validator.go)：理解 `claude_code_only` 为什么不只检查 UA。
9. [`gemini_v1beta_handler.go`](../../code/sub2api/backend/internal/handler/gemini_v1beta_handler.go)：理解 Gemini CLI 的原生 API 入口。
10. [`gateway_test.go`](../../code/sub2api/backend/internal/server/routes/gateway_test.go)、[`UseKeyModal.spec.ts`](../../code/sub2api/frontend/src/components/keys/__tests__/UseKeyModal.spec.ts)、[`gateway_forward_as_responses_test.go`](../../code/sub2api/backend/internal/service/gateway_forward_as_responses_test.go) 和 [`openai_ws_forwarder_ingress_test.go`](../../code/sub2api/backend/internal/service/openai_ws_forwarder_ingress_test.go)：最后用测试确认路由别名、生成配置、协议转换和 WS 生命周期边界。

## 14. 核心结论

Sub2API 连接 Codex、Claude Code 等工具的核心，不是简单修改一个 Base URL，而是用“用户 Key → 分组 → 账号池”把客户端协议与上游账号解耦：

```text
Codex Responses ───────┬─→ OpenAI Responses / ChatGPT Codex
                       ├─→ Grok Responses
                       └─→ Anthropic Messages（兼容转换）

Claude Messages ───────┬─→ Anthropic / Bedrock / Vertex
                       ├─→ OpenAI Responses（双向转换）
                       ├─→ Grok Responses（双向转换）
                       └─→ Antigravity Claude

Gemini v1beta ─────────┬─→ Gemini 原生上游
                       └─→ Antigravity Gemini
```

客户端只需要 Sub2API 的公网地址和用户 API Key；真正决定“最终调用谁、用什么协议、能否切换账号、如何计费”的，是 Key 所绑定分组及其账号池配置。
