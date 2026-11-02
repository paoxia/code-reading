# Coding Agent 跨平台适配总览

> 更新日期：2026-11-02；本地提交见 [项目总览](../project-landscape/overview.md)。本轮依据平台分支、执行抽象及已有测试静态复核，没有运行完整 Windows/Linux/macOS 矩阵。

## 跨平台至少有四层

```text
分发：OS / arch → 二进制、runtime、依赖
执行：Shell 选择 → 参数/路径语义 → 进程生命周期
权限：策略 → 审批 → OS sandbox / 远端隔离
存储：路径、锁、rename、文件权限与恢复
```

支持某个系统安装，不代表每项工具、沙箱或 GUI 能力都有等价实现。模型看到的命令语言也必须与实际 Shell 一致。

## 当前实现路线

| 项目 | 主要路线 | 源码笔记 |
| --- | --- | --- |
| Codex | 原生 Rust 运行时与平台沙箱，分发包按目标选择 | [跨平台专题](../../notes/codex/cross-platform-adaptation.md) |
| OpenCode | core 的 ShellSelect/Parse/Tool 与执行环境服务 | [跨平台专题](../../notes/opencode/cross-platform-adaptation.md) |
| Kimi Code | v2 HostEnvironmentInfo、OS backend、Git Bash 路径桥 | [跨平台专题](../../notes/kimi-code/cross-platform-adaptation.md) |
| pi | 产品层 Bash/进程与分发处理；Durable 为独立实验层 | [跨平台专题](../../notes/pi/cross-platform-adaptation.md) |
| Continue | CLI 与 IDE 适配分层，依赖各宿主环境 | [跨平台专题](../../notes/continue/cross-platform-adaptation.md) |
| mini-swe-agent | 环境接口隔离本地/容器等执行方式 | [跨平台专题](../../notes/mini-swe-agent/cross-platform-adaptation.md) |
| Trae Agent | Bash session 与 Unix/Windows 进程差异处理 | [跨平台专题](../../notes/trae-agent/cross-platform-adaptation.md) |
| Better Harness | 宿主会话路径、命令发现与证据采集适配 | [跨平台专题](../../notes/better-harness/cross-platform-adaptation.md) |
| Gemini CLI | Node 工具层、策略与各平台 sandbox 分支 | [项目笔记](../../notes/gemini-cli/README.md) |
| Goose | Rust 平台服务、扩展进程与多入口 | [项目笔记](../../notes/goose/README.md) |
| DeepSeek Harness | Provider 能力接缝与独立 native system workspace | [架构笔记](../../notes/deepseek-harness/architecture.md) |

## Shell 统一与平台原生选择

Kimi 的 [environmentProbe](../../code/kimi-code/packages/agent-core-v2/src/_base/execEnv/environmentProbe.ts) 在 Unix 优先 Bash、必要时 sh，在 Windows 寻找 Git Bash。当前类型为 HostEnvironmentInfo，字段使用 osArch/osVersion，osKind 为 macOS/Linux/Windows。它的 [ShellPathBridge](../../code/kimi-code/packages/agent-core-v2/src/_base/execEnv/shellPathBridge.ts) 负责 Shell 路径与宿主原生路径之间的转换。

OpenCode 的 [ShellSelect](../../code/opencode/packages/core/src/shell/select.ts) 同时考虑配置、兼容性和可执行文件；Windows 候选包含 PowerShell、Git Bash 和 COMSPEC，不能再笼统写成所有平台统一 Bash。工具 [描述和参数](../../code/opencode/packages/core/src/tool/plugin/shell.ts) 也写明实际环境。

选择统一命令语言可以减少 prompt 差异，但增加 runtime 依赖与路径桥接；选择原生 Shell 可贴近宿主，但解析、权限和模型指令都必须跟着分派。二者是设计取舍，没有单一策略能自动解决全部平台问题。

## 进程终止、后台任务与输出

超时或取消需要处理进程树，单独结束 Shell 父进程可能留下子进程。Windows 与 Unix 的信号、进程组和终止方式不同，相关实现应在宿主 backend，而不是让模型用命令自行补救。

后台任务还引入第二个完成边界：工具返回运行句柄之后，进程仍在执行。恢复时要确认句柄、输出文件、退出状态和通知所有权；不能只根据某条 tool result 判断后台任务已经完成。

## 沙箱和路径是权限的一部分

审批是决策，sandbox 是执行约束。Codex 的 [专题](../../notes/codex/cross-platform-adaptation.md) 与 DeepSeek 的 [native system](../../code/deepseek-harness/native/system/README.md) 展示平台能力需要独立实现和打包。存在 sandbox 接口并不证明所有平台具有相同的文件、网络或进程隔离。

路径规范化同样影响权限判断：盘符、大小写、符号链接、Git Bash `/c/...` 与 Windows `C:/...` 若被不同层按不同方式解释，可能导致误拒绝或越权。执行路径与授权路径必须基于相同环境事实。

## 存储与分发的验证边界

跨平台持久化要检查 rename replacement、锁、权限、reader 关闭与原子写入。分发要分别检查 OS、CPU arch、系统库、内置 runtime 和外部工具版本，不能只验证主可执行文件启动。

推荐验证一个完整纵切面：安装 → 创建会话 → 读取含空格/非 ASCII 路径 → 执行与取消命令 → 后台任务完成 → 关闭与恢复。上表的能力来自静态实现定位，本轮没有声称这些平台用例已运行通过。
