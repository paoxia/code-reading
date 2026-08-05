# Better Harness 跨平台适配分析

> 源码版本：`main@89809f2`
>
> 研究范围：CLI/runtime 自身，以及多 Coding Agent 宿主会话数据的路径适配。

## 1. 定位

Better Harness 不是负责执行用户命令的 Coding Agent。它需要在 Windows、Linux、macOS 上读取 Codex、Claude、Cursor、Kimi、Qwen 等宿主的配置和会话，再生成分析结果。因此它面对的是“多宿主 × 多 OS”矩阵，适配重点是路径、可执行文件发现、数据目录与报告预览。

## 2. 路径 API 的动态选择

[`plugin-lifecycle/runtime.mjs`](../../code/better-harness/scripts/plugin-lifecycle/runtime.mjs) 不只看当前 `process.platform`。如果输入、home 或 workspace 本身呈现 Windows 路径形态，也会选择 `path.win32`。这使 Linux 上分析来自 Windows 的离线证据时，不会用 POSIX 规则误解 `C:\...`。

路径脱敏同样先确定 path API，再把 home/workspace 替换为稳定标记，避免因分隔符不同泄漏真实目录或无法匹配。

## 3. 可执行文件发现

runtime 按平台处理：

- PATH delimiter：Windows 为 `;`，其他系统使用 Node 平台 delimiter；
- Windows 候选可追加 `.cmd`、`.exe` 等名称；
- Unix 用 `X_OK` 验证执行位，Windows 只需 `F_OK`；
- 比较 Windows canonical path 时转小写；
- 会话命令归一化使用 `path.win32.basename()` 并去掉 `.exe`。

这些逻辑服务于插件安装、宿主 CLI 探测和会话命令分类。

## 4. 多宿主数据目录

`scripts/session-analysis/platforms/` 下每个宿主拥有独立 adapter。adapter 会展开 `~`、解析 workspace，并在检测到 Windows 绝对路径时使用 `path.win32.normalize()`。这样宿主差异与 OS 差异被限制在 adapter 内，分析主流程只消费统一记录。

部分 provider 还需处理应用数据目录差异：macOS 常在 `~/Library/Application Support`，Windows 常在 `%APPDATA%`/`%LOCALAPPDATA%`，Linux 常按 XDG/home 目录。实际支持程度应以各 adapter 的探测代码为准，不能从一个统一 provider 名称推断三平台路径都已覆盖。

## 5. 报告预览

[`canvas-preview/platform.mjs`](../../code/better-harness/scripts/harness-analysis/canvas-preview/platform.mjs) 选择：

```text
macOS   → open <url>
Windows → cmd /c start "" <url>
Linux   → xdg-open <url>
```

调用通过参数数组而非拼成一整段 shell 字符串，降低引用和注入问题。Qoder 应用根目录探测也按 macOS/Windows/Linux 分支处理。

## 6. 与命令执行型 Agent 的区别

Better Harness 主要做“读取与归一化”，并不提供 Codex 式沙箱或 pi/Kimi Code 式统一 Bash。它的宿主 adapter 解决的是证据格式和数据位置，不应称为 Agent runtime 的 OS backend。

## 7. 限制与风险

- 当前宿主上运行时还可能读取另一平台产生的路径，因此不能处处只依赖 `process.platform`。
- Windows 路径大小写折叠适合路径比较，不应任意用于会区分大小写的数据字段。
- `cmd /c start` 有特殊 quoting 语义，所有外部输入必须保持参数化和验证。
- 不同宿主版本可能迁移数据目录；adapter 需要独立测试 fixture。
- 本次未在三种实际 OS 上执行测试。

## 8. 推荐阅读

1. [`plugin lifecycle runtime`](../../code/better-harness/scripts/plugin-lifecycle/runtime.mjs)
2. [`session platform adapters](../../code/better-harness/scripts/session-analysis/platforms)
3. [`canvas preview platform`](../../code/better-harness/scripts/harness-analysis/canvas-preview/platform.mjs)
4. [`core-change-watch common`](../../code/better-harness/scripts/core-change-watch/common.mjs)
5. [`Host Adapter 文档](../../code/better-harness/docs/adapters/contributing-new-coding-agent.md)
