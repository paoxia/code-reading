# Skills 实现

> 源码版本：`spring-ai-alibaba/main@84ca19a12`

## 1. 结论

Spring AI Alibaba 的 Skill 是一个可发现、按需加载的 Prompt/工作流知识包，而不是
另一种 Agent，也不等于一个 ToolCallback。

它采用渐进式披露：

```text
启动时：只把 Skill 名称、描述、路径放进 system prompt
                           │
                           ▼
模型判断某个 Skill 与当前任务相关
                           │
                           ▼
                    调用 read_skill
                           │
                           ▼
                  读取完整 SKILL.md
                           │
                           ▼
下一轮模型调用：开放该 Skill 关联的动态工具
```

核心组合是：

```text
SkillRegistry      → 发现、索引和读取 Skill
SkillsAgentHook    → 生命周期管理 + 注册 Skill 工具
SkillsInterceptor  → 注入 Prompt + 动态开放工具
AgentToolNode      → 执行 read_skill 和 Skill 专属工具
```

## 2. Skill 目录与 SKILL.md

典型结构：

```text
skills/
└─ sales-analysis/
   ├─ SKILL.md
   ├─ scripts/
   ├─ references/
   └─ assets/
```

`SKILL.md` 由 YAML frontmatter 和正文组成：

```yaml
---
name: sales-analysis
description: Analyze sales data and generate business reports
allowed_tools:
  - query_database
  - export_report
---

# Sales analysis workflow

1. Read the schema reference.
2. Query the required metrics.
3. Validate totals.
4. Generate the report.
```

框架把 frontmatter 转换为 `SkillMetadata`，正文作为完整 Skill 内容。supporting files
仍保留在 Skill 目录中，由 Skill 指令告诉 Agent 如何使用。

主要源码：

- [`SkillMetadata`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/SkillMetadata.java)
- [`SkillScanner`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/registry/filesystem/SkillScanner.java)
- [`SkillRegistry`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/registry/SkillRegistry.java)
- [`SkillsAgentHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/skills/SkillsAgentHook.java)
- [`SkillsInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/skills/SkillsInterceptor.java)

## 3. SkillMetadata

`SkillMetadata` 保存：

| 字段 | 含义 |
|---|---|
| `name` | Registry 中的唯一标识 |
| `description` | 用于模型发现和选择 Skill |
| `skillPath` | Skill 目录路径 |
| `source` | user/project/classpath 等来源 |
| `fullContent` | 去掉 frontmatter 后的 SKILL.md 正文 |
| `allowedTools` | 加载 Skill 后可动态添加的工具名 |

读取全文时优先使用已缓存的 `fullContent`；没有缓存时从
`skillPath/SKILL.md` 读取并移除 frontmatter。

`description` 是渐进式披露中最关键的字段。模型在未读正文之前，只能依赖名称和描述
判断是否需要调用 `read_skill`。

## 4. SkillScanner

[`SkillScanner`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/registry/filesystem/SkillScanner.java)
扫描目标目录的一级子目录，每个子目录必须存在 `SKILL.md`。

加载过程：

```text
skills directory
      │ Files.list()
      ▼
skill subdirectory
      │
      ├─ 检查 SKILL.md
      ├─ 读取文件
      ├─ 解析 YAML frontmatter
      ├─ 校验 name/description
      ├─ 解析 allowed_tools
      ├─ 移除 frontmatter
      └─ 创建 SkillMetadata
```

### 4.1 名称规则

按照 Agent Skills 规范检查：

- 最长 64 字符；
- 只能包含小写字母、数字和单连字符；
- 不能以连字符开头或结尾；
- 不允许连续连字符；
- name 应与父目录名一致。

当前实现为向后兼容只记录 warning，命名不合规的 Skill 仍会加载。

### 4.2 Description

- 必填；
- 最大长度 1024；
- 超长时会截断，而不是拒绝整个 Skill。

### 4.3 allowed_tools

Scanner 同时兼容：

```yaml
allowed_tools:
```

和：

```yaml
allowedTools:
```

可以是单个字符串或字符串集合，最终规范化为不可变 List。

## 5. SkillRegistry 抽象

[`SkillRegistry`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/registry/SkillRegistry.java)
提供统一能力：

- `get(name)`
- `getByPath(path)`
- `listAll()`
- `search(query)`
- `contains(name)`
- `size()`
- `reload()`
- `readSkillContent(name)`
- `readSkillContentByPath(path)`
- `disable/disableByPath`
- `getRegistryType()`
- `getSkillLoadInstructions()`
- `getSystemPromptTemplate()`

Registry 不要求底层一定是文件系统，可以实现数据库、远程服务或其他存储。

## 6. AbstractSkillRegistry

[`AbstractSkillRegistry`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/registry/AbstractSkillRegistry.java)
提供公共实现：

- 基于 Map 保存 SkillMetadata；
- 使用并发 Set 保存当前实例禁用的 Skill 名；
- list/get/search 自动过滤禁用 Skill；
- 路径标准化后再比较；
- search 按名称、描述和路径匹配并排序；
- `reload()` 委托子类重新加载数据。

禁用只改变当前 Registry 实例中的可见性：

- 不修改 SKILL.md；
- 不删除 Skill 目录；
- 不等于权限封禁；
- 当前实现重新加载 Skill 数据时不会主动清空 disabled set。

## 7. FileSystemSkillRegistry

[`FileSystemSkillRegistry`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/registry/filesystem/FileSystemSkillRegistry.java)
默认加载两个位置：

```text
用户级：~/saa/skills
项目级：./skills
```

加载顺序：

```text
user skills
    │ put(name, metadata)
    ▼
project skills
    │ put(name, metadata)
    ▼
最终 registry
```

所以同名时项目 Skill 覆盖用户 Skill。这使用户可以拥有全局技能，同时允许具体项目
定制相同名称的工作流。

Builder 支持：

- 自定义用户 Skill 目录；
- 自定义项目 Skill 目录；
- Spring `Resource`；
- 禁用初始化自动加载；
- 自定义 system prompt template。

## 8. ClasspathSkillRegistry

[`ClasspathSkillRegistry`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/registry/classpath/ClasspathSkillRegistry.java)
用于将 Skill 随应用打包，默认读取 classpath 下的 `skills/`。

它需要处理两种运行环境：

### 8.1 展开的 classpath 目录

开发环境中可以直接把 classpath URL 转换为 Path，扫描方式与普通文件系统类似。

### 8.2 JAR 内资源

JAR 内路径不能直接交给普通文件工具长期使用，因此 Registry 会：

1. 打开 JAR FileSystem；
2. 扫描 Skill；
3. 缓存已经读取的 SKILL.md 正文；
4. 把 scripts/references/assets 等资源复制到 `basePath`；
5. 将 SkillMetadata.skillPath 改成复制后的真实文件系统路径。

默认 `basePath` 是 `/tmp`。在 Windows 或受限生产环境中，建议显式配置可写目录。

## 9. SkillsAgentHook

ReactAgent 推荐通过
[`SkillsAgentHook`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/skills/SkillsAgentHook.java)
接入 Skill：

```java
SkillsAgentHook hook = SkillsAgentHook.builder()
    .skillRegistry(registry)
    .autoReload(false)
    .groupedTools(groupedTools)
    .toolCallbackResolver(resolver)
    .build();

ReactAgent agent = ReactAgent.builder()
    .name("assistant")
    .model(chatModel)
    .hooks(hook)
    .build();
```

Hook 只运行在 `BEFORE_AGENT`，职责是：

- 可选地在每次 Agent 调用前 `registry.reload()`；
- 提供 Skill 管理工具；
- 创建共享同一个 Registry 的 `SkillsInterceptor`。

如果 Registry 不支持 reload，autoReload 会捕获 `UnsupportedOperationException` 并记录
debug 日志。

## 10. 三个内置 Skill 工具

### 10.1 search_skills

[`SearchSkillsTool`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/skills/SearchSkillsTool.java)
按名称、描述和路径搜索当前 Registry。

返回轻量结果：

```text
name | description | skill_path | source | allowed_tools
```

适合 Skill 数量较多、初始列表不足以定位技能的情况。

### 10.2 read_skill

[`ReadSkillTool`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/skills/ReadSkillTool.java)
接受：

- `skill_name`
- `skill_path`
- 或同时提供二者

同时提供时，它们必须指向同一个 Skill，避免名称和路径混用。成功后返回去掉
frontmatter 的完整正文。

### 10.3 disable_skill

[`DisableSkillTool`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/hook/skills/DisableSkillTool.java)
隐藏当前 Registry 中的 Skill。

它适合让 Agent 在当前进程中停止使用不相关或有问题的 Skill，但不应被视为安全删除、
租户权限控制或永久配置变更。

## 11. SkillsInterceptor

[`SkillsInterceptor`](../../code/spring-ai-alibaba/spring-ai-alibaba-agent-framework/src/main/java/com/alibaba/cloud/ai/graph/agent/interceptor/skills/SkillsInterceptor.java)
包装每一次模型调用。

主要流程：

```text
ModelRequest
    │
    ├─ registry.listAll()
    ├─ 扫描历史 AssistantMessage 中的 read_skill ToolCall
    ├─ 解析已经读取的 Skill
    ├─ 收集 groupedTools
    ├─ 通过 Resolver 解析 allowed_tools
    ├─ 构建 Skill metadata prompt
    ├─ 增强 SystemMessage
    └─ 写入 dynamicToolCallbacks
          │
          ▼
      下一个 ModelCallHandler
```

### 11.1 为什么扫描 ToolCall 而不是 ToolResponse

Interceptor 从历史 AssistantMessage 的 `read_skill` 调用参数中解析 Skill 名称或路径。
这样可以明确知道模型主动选择了哪个 Skill，并校验 name/path 是否一致。

解析失败、Skill 不存在或名称路径不匹配时，不会开放对应工具。

### 11.2 groupedTools

Java 配置可以显式建立映射：

```java
Map<String, List<ToolCallback>> groupedTools = Map.of(
    "sales-analysis", List.of(queryDatabase, exportReport)
);
```

只有模型调用过该 Skill 的 `read_skill` 后，这些工具才加入动态工具列表。

### 11.3 allowed_tools

SkillMetadata 中的 allowed tool 名称通过 `ToolCallbackResolver` 解析。解析不到时记录
debug 日志并跳过，不会使整个模型调用失败。

需要特别注意：

> 当前 `allowed_tools` 是“加载 Skill 后额外添加的工具”，不是限制 Agent 只能使用这些
> 工具的安全白名单。

Agent 原有的工具仍然存在。真正的权限隔离需要额外的 ToolInterceptor、工具选择策略
或独立 Agent 边界。

## 12. Progressive Disclosure 完整时序

```text
Builder
  │
  ├─ SkillsAgentHook.getTools()
  │      └─ 注册 search_skills/read_skill/disable_skill
  │
  └─ SkillsAgentHook.getModelInterceptors()
         └─ 注册 SkillsInterceptor

第一次模型调用
  │
  ├─ SkillsInterceptor 将轻量 Skill 列表加入 system prompt
  └─ 模型只看到基础工具和三个 Skill 工具

模型调用 read_skill
  │
  └─ AgentToolNode 返回完整 Skill 正文

第二次模型调用
  │
  ├─ SkillsInterceptor 找到历史 read_skill ToolCall
  ├─ 添加 groupedTools/allowed_tools
  ├─ AgentLlmNode 把动态工具发给模型
  └─ 同时写入 RunnableConfig.context

模型调用 Skill 专属工具
  │
  └─ AgentToolNode 从 RunnableConfig.context 解析并执行
```

这种方式减少初始 token 消耗，也避免在模型尚未理解 Skill 前暴露大量专用工具。

## 13. Skill Prompt

[`SkillPromptConstants`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/SkillPromptConstants.java)
构造的上下文主要包括：

- Registry 类型；
- Registry 给出的加载说明；
- 每个 Skill 的名称、描述和路径；
- supporting files 所在目录；
- 使用前必须先调用 `read_skill` 的提示。

最后交给 Registry 的 `SystemPromptTemplate` 渲染。这允许不同 Registry 对加载方式给出
不同说明。

## 14. 在普通 ChatClient 中使用 Skill

Graph Core 还提供：

- [`SpringAiSkillAdvisor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/skills/SpringAiSkillAdvisor.java)
- [`SkillPromptAugmentAdvisor`](../../code/spring-ai-alibaba/spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/advisors/SkillPromptAugmentAdvisor.java)

它们通过 Spring AI Advisor 在 `ChatClientRequest` 前增强 system prompt，适合不使用
ReactAgent 的普通 ChatClient。

但 Advisor 主要负责 Prompt 注入，不像 SkillsAgentHook 那样自动把 read/search/disable
工具和动态工具链完整接入 ReactAgent。使用 Advisor 时仍需要自行注册相应工具。

## 15. 示例

官方示例位于
[`examples/multiagent-patterns/skills`](../../code/spring-ai-alibaba/examples/multiagent-patterns/skills)。

核心配置见
[`SkillsConfig`](../../code/spring-ai-alibaba/examples/multiagent-patterns/skills/src/main/java/com/alibaba/cloud/ai/examples/multiagents/skills/SkillsConfig.java)：

```text
ClasspathSkillRegistry
       │
       ▼
SkillsAgentHook
       │
       ▼
ReactAgent.hooks(...)
```

示例中的 SQL Agent 先通过 Skill 描述发现业务领域，再读取具体领域的 schema 和业务
逻辑，避免把所有数据库知识一次性写入 system prompt。

## 16. 注意事项

### 16.1 Skill 不是安全边界

- Skill 正文是给模型的指令，不能强制限制模型行为；
- allowed_tools 是增量开放，不是 deny-by-default；
- read_skill 返回的内容应视为 Prompt 输入，需要信任来源；
- supporting scripts 的执行仍需要受控工具和文件系统权限。

### 16.2 autoReload 有成本

`autoReload=true` 会在每次 Agent 调用前扫描 Registry。开发时方便，Skill 很多或存储在
远程系统时可能增加延迟。生产环境可采用显式刷新或带缓存的自定义 Registry。

### 16.3 名称和 description 是发现协议

- name 必须稳定，因为 read_skill、groupedTools 和 allowed_tools 都依赖它；
- description 应写明何时使用，而不只是重复 Skill 名称；
- 同名项目 Skill 会覆盖用户 Skill，应避免无意覆盖。

### 16.4 动态工具只存在于运行时

动态 ToolCallback 通过 RunnableConfig context 传递，不应进入 Checkpoint。恢复复杂
流程时，模型历史中保留的 read_skill ToolCall 会让 SkillsInterceptor 再次计算动态
工具集合。

### 16.5 Classpath 资源复制目录

ClasspathSkillRegistry 需要把 supporting files 复制到真实文件系统。应确保 basePath：

- 可写；
- 不与不可信租户共享；
- 有清理策略；
- 符合目标操作系统路径规范。

## 17. 推荐阅读顺序

1. 示例 `SkillsConfig` 和示例 SKILL.md。
2. `SkillMetadata`。
3. `SkillScanner.loadSkill()`。
4. `SkillRegistry` 和 `AbstractSkillRegistry`。
5. `FileSystemSkillRegistry.loadSkillsToRegistry()`。
6. `ClasspathSkillRegistry.loadSkillsToRegistry()`。
7. `SkillsAgentHook`。
8. `ReadSkillTool`、`SearchSkillsTool`、`DisableSkillTool`。
9. `SkillsInterceptor.interceptModel()`。
10. `AgentLlmNode` 的动态工具传递逻辑。

