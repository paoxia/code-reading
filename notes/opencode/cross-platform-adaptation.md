# OpenCode 跨平台适配分析

> 源码版本：`dev@aefaf140c`
>
> 研究范围：Shell 选择、提示、解析、权限路径、进程执行和 CLI 分发。

## 1. 结论

OpenCode 没有强制所有平台使用 Bash，而是把 Shell kind 提升为一等概念。Bash、PowerShell 7、Windows PowerShell 5.1 和 cmd.exe 从提示词、语法解析、命令启动到权限路径识别均有独立处理。这种路线最贴近宿主环境，也使安全分析复杂度最高。

## 2. Shell 识别与选择

[`packages/core/src/shell.ts`](../../code/opencode/packages/core/src/shell.ts) 负责发现和筛选可接受 Shell；[`ShellID`](../../code/opencode/packages/opencode/src/tool/shell/id.ts) 将其归为 `bash`、`pwsh`、`powershell`、`cmd`。

Shell Tool 初始化时取得最终 Shell，识别名称，再把名称和 `process.platform` 交给 Prompt renderer。平台差异因此在模型第一次调用工具之前就已显式呈现。

## 3. 分 Shell 提示不是装饰

[`prompt.ts`](../../code/opencode/packages/opencode/src/tool/shell/prompt.ts) 为不同 Shell 说明：

- PowerShell 的变量、转义和管道规则；
- Windows PowerShell 5.1 不支持 `&&`，依赖前一步成功时应用 `if ($?)`；
- cmd.exe 的转义、路径和临时文件写法；
- Bash 的常规 POSIX 规则。

模型因此不会被一个固定的“运行 bash 命令”描述误导。专用 read/write/edit 工具也被优先推荐，以减少不同 Shell 文件操作语法带来的风险。

## 4. 解析、权限与路径必须同步适配

Shell Tool 使用 Bash/PowerShell 对应的 tree-sitter parser 拆解命令。解析结果用于找出命令和路径参数，再向权限系统申请具体目录或命令权限，而不是把整个字符串当黑盒。

Windows 分支还会：

- 大小写不敏感地查找环境变量；
- 展开 `$HOME`、`$PWD`、`$PSHOME`；
- 归一化外部目录和 glob pattern；
- POSIX Shell 返回 `/...` 路径时调用 `cygpath -w`；
- 识别 cmd.exe 自己的文件操作命令集合。

这揭示了一个关键约束：切换 Shell 后，权限解析器若不切换，就可能漏报写入目标或误判命令边界。

## 5. 启动参数与进程行为

PowerShell 使用：

```text
-NoLogo -NoProfile -NonInteractive -Command <command>
```

这样避免用户 profile 修改非交互执行语义。Unix 使用 detached 进程组，Windows 不使用。路径解析还区分 PowerShell 与 POSIX Shell 的引用和 home 展开。

## 6. 分发

CLI 构建目标覆盖 macOS、Linux、Windows，并包含 x64/arm64 以及部分 x64 非 AVX2 变体。安装/发布脚本在 Windows 跳过 Unix `chmod`，并按 OS 选择包名和可执行文件。

## 7. 限制与风险

- 多 Shell 解析器和提示必须保持一致，否则权限判断与实际执行可能分叉。
- PowerShell 5.1 与 7 不能只按同一种 PowerShell 处理。
- Git Bash/MSYS 路径转换依赖 `cygpath` 可用。
- 本专题没有发现类似 Codex 的三平台原生沙箱矩阵；Shell 权限审批不等同于 OS 强制隔离。
- 本次未在三个系统上运行集成测试。

## 8. 推荐阅读

1. [`Shell 核心抽象](../../code/opencode/packages/core/src/shell.ts)
2. [`Shell kind](../../code/opencode/packages/opencode/src/tool/shell/id.ts)
3. [`Shell Prompt](../../code/opencode/packages/opencode/src/tool/shell/prompt.ts)
4. [`Shell Tool](../../code/opencode/packages/opencode/src/tool/shell.ts)
5. [`CLI 构建目标](../../code/opencode/packages/cli/script/build.ts)
