# AgentScope Java Tool、Skill 与动态披露

> 本轮复核：2026-11-02；本地源码 `1d8f9dc04e0e6c7e4d54074331cd5059a87cfa1d`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## Tool 的定义与注册

公共工具合同是 [AgentTool](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/AgentTool.java)，可通过带注解的对象、[ToolBase](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/ToolBase.java) 或直接实现接口接入。[Toolkit](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/Toolkit.java) 是注册与调用门面，[ToolRegistry](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/ToolRegistry.java) 保存注册信息，schema/参数转换和执行基础设施分别由相应组件承担。

```text
工具定义 → registerTool → registry / group / schema
模型 tool call → ToolCallParam
  → Toolkit.callTool / callTools
  → ToolExecutor：校验、middleware、执行与结果
  → ToolResultBlock → Agent 历史
```

## 单工具与批次执行

Toolkit 的 callTool 进入 executor 的 infrastructure 路径，callTools 负责批次与调用级配置。默认并行执行不代表所有共享外部状态的工具都可以无约束并发，调用方仍要考虑互斥、取消和结果配对。

[ToolExecutor](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/ToolExecutor.java) 承担执行与验证。当前还区分 external tool：这类调用交由框架外执行，不能见到模型发出调用就认为本地 handler 已运行。

## Skill 的位置

Skill 是工作方法、指令与资源，Tool 是可执行能力，两者由注册与按需加载协作。相关入口：

| 对象 | 源码 | 职责 |
| --- | --- | --- |
| SkillRegistry | [SkillRegistry](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/skill/SkillRegistry.java) | Skill 注册与查询 |
| Repository | [AgentSkillRepository](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/skill/repository/AgentSkillRepository.java) | 文件、classpath 等来源的抽象 |
| DynamicSkillMiddleware | [DynamicSkillMiddleware](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/skill/DynamicSkillMiddleware.java) | 调用阶段的动态 Skill 处理 |
| SkillToolGroup | [SkillToolGroup](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/SkillToolGroup.java) | Skill 关联的工具组 |
| Tool search | [ToolSearchMiddleware](../../code/agentscope-java/agentscope-core/src/main/java/io/agentscope/core/tool/search/ToolSearchMiddleware.java) | 工具检索与披露策略 |

工具 schema 的加载、Skill 的完整正文、实际执行授权是三个独立边界。动态隐藏或展示工具主要控制模型看到什么，不能替代运行时权限判断。

## 与 Harness 的关系

HarnessAgent 继续组合 Skill 管理、curation、workspace 和 memory；它们依赖具体后端与配置，不表示一次普通 Toolkit 注册就自动得到学习闭环或沙箱。

建议按 Toolkit → ToolExecutor → SkillRegistry/Repository → DynamicSkillMiddleware → Harness 顺序阅读，再对照 [ToolExecutorTest](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/tool/ToolExecutorTest.java)、[DynamicSkillMiddlewareTest](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/skill/DynamicSkillMiddlewareTest.java) 与 [SkillToolGroupTest](../../code/agentscope-java/agentscope-core/src/test/java/io/agentscope/core/tool/SkillToolGroupTest.java)。
