# OpenCode 跨平台适配分析

> 本轮复核：2026-11-02；本地源码 `67139d6827af3a337c80472c33f9cb7c6c2ce500`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 当前源码入口

跨平台实现已位于 `packages/core` 及 util 包。Shell 选择、命令解析、实际进程和权限是相互衔接的层次，不是只判断一次 `process.platform`。

| 职责 | 当前源码 |
| --- | --- |
| Shell 探测与选择 | [shell/select.ts](../../code/opencode/packages/core/src/shell/select.ts) |
| 命令解析与扫描 | [shell/parse.ts](../../code/opencode/packages/core/src/shell/parse.ts)、[shell/scan.ts](../../code/opencode/packages/core/src/shell/scan.ts) |
| Shell 工具 | [tool/plugin/shell.ts](../../code/opencode/packages/core/src/tool/plugin/shell.ts) |
| 执行服务 | [shell.ts](../../code/opencode/packages/core/src/shell.ts) |

## Shell 选择策略

`ShellSelect` 提供 configure 与 resolve，并区分 config/compat 的选择优先级。Windows 候选包含 pwsh、powershell、Git Bash 与 COMSPEC；Unix 从 `/etc/shells` 等信息探测。META 表还区分 login shell、PowerShell 与不兼容选项。

因此当前 OpenCode 不能概括为“所有平台统一 Bash”，也不能把候选枚举当作每次运行的固定选取顺序。最终还取决于显式配置、可执行文件存在性与 compatible 限制。

## 工具语义随 Shell 一起变化

Shell 工具在描述中写入实际 OS 与 Shell，向模型传达该用哪种命令语言。解析与权限检查必须使用相同的环境事实，否则命令可运行却可能被错误解释为另一种 shell 的路径或参数。

工具参数还区分前台超时和后台执行。后台返回 `running` 与 shellID，任务完成通过通知继续；收到 shellID 不能当作命令已经完成。输出截断标记、exit、signal、timeout 也应一起解释。

## 验证与限制

解析边界可读 [shell-parse-syntax.test.ts](../../code/opencode/packages/core/test/shell-parse-syntax.test.ts)。本轮未运行 Windows/macOS/Linux 矩阵，也不据静态分支推断各平台具有等价沙箱；平台支持、Shell 语义与强制隔离需要分别研究。
