# Coding Agent 跨平台适配总览

本文只保留横向结论；每个项目的实现、限制、源码入口和阅读顺序已经拆到项目目录。

## 2026-08-24 增量复核

四种路线没有变化，但发行与路径边界继续加强：pi 开始随 Coding Agent 分发 Node runtime，并支持托管安装原地升级；Kimi Code 增加 Git Bash POSIX 路径到宿主文件路径的桥接；Codex 加固 Bubblewrap synthetic mount registry；Better Harness 的 Studio 则开始通过 ACP 启动不同宿主 Agent。跨平台能力因此应同时检查 Shell 语义、runtime 分发、路径桥接和沙箱隔离，不能只看支持的 OS 名称。

## 1. 四种主要路线

1. **统一 Bash 语义**：pi、Kimi Code 在 Windows 寻找 Git Bash，减少模型面对的命令方言。
2. **接受原生 Shell**：OpenCode 同时理解 Bash、PowerShell 和 cmd；Continue Hook 按宿主选择 cmd 或 sh。
3. **薄兼容层**：mini-swe-agent 依赖系统默认 Shell；Trae Agent 用同一 sentinel 协议包装 Bash/cmd。
4. **平台原生后端**：Codex 为 macOS、Linux、Windows 使用不同原生沙箱；Kimi Code v2 把环境探测、进程和 capability 下沉到 OS backend。

## 2. 横向比较

| 项目 | Windows 命令策略 | Linux/macOS | 平台适配特点 | 详细笔记 |
| --- | --- | --- | --- | --- |
| mini-swe-agent | Python 默认 Shell | Python 默认 Shell | 仅进程组终止有明确 POSIX 分支 | [阅读](../../notes/mini-swe-agent/cross-platform-adaptation.md) |
| Trae Agent | `cmd.exe /v:on` | `/bin/bash` | 统一持久会话和退出码协议，未统一命令语言 | [阅读](../../notes/trae-agent/cross-platform-adaptation.md) |
| pi | 要求 Bash | Bash | 外围工具、TTY、剪贴板、WSL、分发逐项适配 | [阅读](../../notes/pi/cross-platform-adaptation.md) |
| OpenCode | Bash/PowerShell/cmd | Bash 或配置 Shell | 提示、parser、权限和路径共同感知 Shell kind | [阅读](../../notes/opencode/cross-platform-adaptation.md) |
| Continue | Hook 使用 cmd.exe | Hook 使用 `/bin/sh` | 构建 target + 各模块局部判断 | [阅读](../../notes/continue/cross-platform-adaptation.md) |
| Codex | 原生执行与 restricted-token sandbox | Linux seccomp/bwrap；macOS Seatbelt | 原生二进制和三套平台沙箱 | [阅读](../../notes/codex/cross-platform-adaptation.md) |
| Kimi Code | 要求 Git Bash | Bash，回退 sh | ExecutionEnvironment、OS backend、capability | [阅读](../../notes/kimi-code/cross-platform-adaptation.md) |
| Better Harness | 归一化 Windows 宿主数据 | 归一化 POSIX 宿主数据 | 解决“多 Agent 宿主 × 多 OS”的证据读取 | [阅读](../../notes/better-harness/cross-platform-adaptation.md) |

## 3. 核心认识

- “有平台安装包”不等于 Shell、沙箱和全部增强能力等价。
- 跨平台不只是 `/` 与 `\`：还包括盘符、UNC、大小写、PATH 分隔符、文件锁、rename、`.exe/.cmd` 和 Git Bash 路径。
- Unix process group 与 Windows 进程树的生命周期机制不同，超时只杀父进程通常不够。
- 浏览器、剪贴板、TTY、GUI 启动后的 PATH、Wayland 和 WSL 往往比核心文件工具更碎。
- 权限审批不等于 OS 沙箱；真正的强制隔离必须按平台后端实现。
- 支持矩阵应按“平台 × 架构 × Shell × capability”记录，并区分静态代码分支与真实系统验证。
