# pi 跨平台适配分析

> 源码版本：`main@97f0ccdd9`
>
> 研究范围：Coding Agent 的 Shell、子进程、路径、终端、剪贴板、浏览器、工具下载和发行目标。

## 1. 结论

pi 选择“核心统一为 Bash，外围能力按宿主系统适配”。Windows 用户必须提供 Bash；核心工具因此能继续使用 POSIX 风格命令，而子进程、路径、TTY、剪贴板、浏览器和二进制分发分别做平台分支。

## 2. Windows 上如何获得 Bash

[`windows.md`](../../code/pi/packages/coding-agent/docs/windows.md) 给出的查找顺序是：

1. `~/.pi/agent/settings.json` 的 `shellPath`；
2. `C:\Program Files\Git\bin\bash.exe`；
3. PATH 中的 `bash.exe`，可能来自 Cygwin、MSYS2 或 WSL。

这避免让模型同时学习 Bash、cmd 和 PowerShell，但引入了一个明确前置条件：原生 Windows 并非零依赖运行。

## 3. 子进程与进程树

[`spawnProcess()`](../../code/pi/packages/coding-agent/src/utils/child-process.ts) 在 Windows 使用 `cross-spawn`，其他系统使用 Node `spawn`，用于规避 Windows 可执行文件解析和 shebang 差异。Shell 工具创建进程时，Unix 使用 detached 进程组，Windows 不使用。

`waitForChildProcess()` 还处理一个跨平台细节：父进程已 exit，但后代仍持有 stdout/stderr pipe 时，Node 的 `close` 可能迟迟不来。实现以“输出停止后的短宽限期”收口，既避免永远等待，也避免固定截止时间截断仍在写入的数据。

## 4. 路径和工具分发

[`tools-manager.ts`](../../code/pi/packages/coding-agent/src/utils/tools-manager.ts) 为 `fd`、`ripgrep` 建立 OS/CPU 到 release asset 的映射：

- macOS：x64/arm64 Darwin tar.gz；
- Linux：x64/arm64 GNU/MUSL tar.gz；
- Windows：x64/arm64 MSVC zip，文件名追加 `.exe`。

Windows 解压优先尝试 PowerShell，Unix 解压后补执行位。发行脚本同样构建 macOS/Linux/Windows 的 x64 与 arm64，并把对应剪贴板原生模块、Windows console mode 模块放入产物。

## 5. TTY、剪贴板和桌面能力

- 浏览器：macOS `open`、Windows `rundll32`、Linux `xdg-open`。Windows 特意避免 `cmd /c start`，防止目标字符串中的元字符被二次解析。
- 文本剪贴板：区分 macOS、Windows、Linux X11/Wayland。
- 图片剪贴板：额外探测 WSL；通过 `wslpath` 把 Linux 临时文件转成 Windows 路径，再调用 `powershell.exe`。
- TUI：Windows 使用原生 console mode 模块处理终端模式，相关预编译产物按 x64/arm64 打包。

这说明 Coding Agent 的跨平台成本往往集中在终端外围，而不只是 Shell 工具。

## 6. 沙箱边界

仓库有 sandbox extension 示例，只接受 macOS 和 Linux；它不是核心运行时三平台统一沙箱。不能因为 pi 可在 Windows 运行，就推导出 Windows 具备与 macOS/Linux 相同的隔离能力。

## 7. 优点与风险

优点：模型命令语言一致；工具提示简单；Windows 用户仍可借 Git Bash 使用成熟 Unix 工具链。

风险：依赖 Git Bash/MSYS 路径规则；Windows 原生命令和 POSIX 命令混用时需要转换；WSL、Git Bash、Cygwin 虽都叫 Bash，进程和路径语义并不完全相同。

## 8. 推荐阅读顺序

1. [`Windows 设置](../../code/pi/packages/coding-agent/docs/windows.md)
2. [`Bash 工具](../../code/pi/packages/coding-agent/src/core/tools/bash.ts)
3. [`子进程兼容层](../../code/pi/packages/coding-agent/src/utils/child-process.ts)
4. [`工具管理器](../../code/pi/packages/coding-agent/src/utils/tools-manager.ts)
5. [`图片剪贴板](../../code/pi/packages/coding-agent/src/utils/clipboard-image.ts)
6. [`浏览器启动](../../code/pi/packages/coding-agent/src/utils/open-browser.ts)
7. [`发行脚本](../../code/pi/scripts/build-binaries.sh)
