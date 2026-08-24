# Kimi Code 跨平台适配分析

> 原始研究版本：`main@119a33f`
>
> 2026-08-19 增量复核版本：`main@2ea2ef62e42b`。本次直接影响的环境探测、login shell、host process 和 `rg` 定位逻辑未改变“Windows 使用 Git Bash、上层依赖 ExecutionEnvironment”的主结论。
>
> 2026-08-24 增量复核版本：`main@dceb3fd634aa`。新增 Shell path bridge 会把 Git Bash 产生的 POSIX 路径解析回宿主文件路径，供 Bash tool 与 path-access policy 使用；主结论不变，但“统一 Bash”现在明确包含命令路径与文件系统路径之间的双向桥接。
>
> 研究范围：v2 的执行环境探测、OS backend、工具定位、capability，以及与平台相关的存储语义。

## 1. 结论

Kimi Code v2 把跨平台事实集中建模为 `ExecutionEnvironment`，再通过 OS backend 和 capability service 向上提供统一接口。Shell 策略与 pi 相似：Unix 优先 Bash，Windows 强制寻找 Git Bash，从而保持 Agent 的主要命令语言一致；平台专属能力则显式报告 supported/unsupported。

## 2. `ExecutionEnvironment` 是平台事实快照

[`environmentProbe.ts`](../../code/kimi-code/packages/agent-core-v2/src/_base/execEnv/environmentProbe.ts) 产出：

- `osKind`：`macos`、`linux`、`windows` 或其他平台值；
- `arch`；
- `pathClass`：`posix` 或 `win32`；
- `shellName` 与 `shellPath`；
- 文件系统大小写敏感性和换行符等信息。

上层无需反复直接读取 `process.platform`，也便于测试时注入 platform、env、文件探测和命令执行依赖。

## 3. Shell 探测

### Linux/macOS

依次检查 `/bin/bash`、`/usr/bin/bash`、`/usr/local/bin/bash`；找不到时回退 `/bin/sh`。因此 Unix 上优先统一 Bash，但保留最小 POSIX Shell fallback。

### Windows

Windows 不退回 cmd.exe，而是调用 `locateWindowsGitBash()`。候选来源包括：

1. 用户/环境显式指定的 Shell；
2. Git 可执行文件位置反推 Git 根目录；
3. Node 可执行文件位置附近的可能安装；
4. `Program Files`、`Program Files (x86)`、`LOCALAPPDATA` 常见 Git for Windows 路径。

候选同时覆盖 `bin\bash.exe` 和 `usr\bin\bash.exe`。找不到时抛出明确错误，要求安装 Git for Windows 或设置 `KIMI_SHELL_PATH`，而不是静默切换成语义不同的 cmd.exe。

## 4. PATH 与路径类别

[`loginShellPath.ts`](../../code/kimi-code/packages/agent-core-v2/src/_base/execEnv/loginShellPath.ts) 解决 GUI 启动时 PATH 不完整的问题：非 Windows 上运行用户登录 Shell的 `-l -c /usr/bin/env`，提取 profile 加载后的 PATH，再与进程 PATH 合并。Windows 直接跳过这条 Unix 探测。

环境探测还区分：

- Windows PATH 列表分隔符 `;`，POSIX 为 `:`；
- Windows 目录分隔符 `\`，POSIX 为 `/`；
- Windows 路径去重时大小写不敏感；
- Git Bash 来源必须是可验证的绝对 Windows 路径。

## 5. 本机进程后端

[`HostProcessService`](../../code/kimi-code/packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts) 将 Node ChildProcess 包装为领域接口。Unix 默认可 detached；Windows 分支使用不同的进程树终止策略。调用方只处理 `IHostProcess`，无需了解 signal 和平台细节。

这是 v2 架构的重要边界：平台差异属于 backend，而不是 Agent Loop 或 Bash Tool。

## 6. 内置工具下载

[`rgLocator.ts`](../../code/kimi-code/packages/agent-core-v2/src/os/backends/node-local/tools/rgLocator.ts) 的流程是：

```text
先查 PATH
  → 再查托管工具目录
  → 根据 OS/arch 计算 release triple
  → Windows 下载 zip/rg.exe
  → macOS/Linux 下载 tar.gz/rg
  → 校验并返回路径
```

Linux 还需区分对应构建目标；不支持的 OS/arch 会抛出带平台详情的错误，而不是下载一个可能不可运行的产物。

## 7. Capability 显式表达支持矩阵

[`capabilityService.ts`](../../code/kimi-code/packages/agent-core-v2/src/app/capability/capabilityService.ts) 让每项可选能力先 `probe` 再使用。不支持时会报告具体的 `platform/arch`。

例如：

- [`kimiCu`](../../code/kimi-code/packages/agent-core-v2/src/app/capability/entries/kimiCu.ts) 当前只支持 macOS；
- [`kimiWebbridge`](../../code/kimi-code/packages/agent-core-v2/src/app/capability/entries/kimiWebbridge.ts) 为 macOS/Linux/Windows 的不同架构选择不同二进制，Windows 使用 `.exe` 且不检查 Unix executable bit。

这种设计将“核心可运行”和“某个增强能力可用”分开，避免用一个粗粒度 supported OS 列表掩盖能力差异。

## 8. Windows 文件系统语义

跨平台问题还进入持久化层：

- [`rename-replace.ts`](../../code/kimi-code/packages/minidb/src/rename-replace.ts) 针对 Windows 不能直接覆盖已有目标执行替换流程；
- compaction 在 Windows 替换文件前关闭 reader；
- lockfile 对 Windows `EPERM` 做有限重试；
- 路径比较和迁移逻辑在 Windows 使用 win32 normalize/resolve 并折叠大小写。

这比只处理 Shell 更完整，因为 Agent 自身的 session/index 数据也必须遵守宿主文件系统规则。

## 9. 限制与注意事项

- Windows 原生运行依赖 Git Bash；这不是零外部依赖方案。
- Git Bash 统一命令语言，但仍要区分其 POSIX 路径与 Windows API 路径。
- 某些 capability 仅支持特定 OS/arch，核心启动成功不代表全部能力可用。
- 本专题未发现 Codex 式三平台强制沙箱矩阵。
- 当前仓库同时存在 v1/v2，本文结论主要针对 v2 边界，不能无条件套到全部旧实现。

## 10. 推荐阅读顺序

1. [`environmentProbe`](../../code/kimi-code/packages/agent-core-v2/src/_base/execEnv/environmentProbe.ts)
2. [`loginShellPath`](../../code/kimi-code/packages/agent-core-v2/src/_base/execEnv/loginShellPath.ts)
3. [`HostProcessService`](../../code/kimi-code/packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts)
4. [`rgLocator`](../../code/kimi-code/packages/agent-core-v2/src/os/backends/node-local/tools/rgLocator.ts)
5. [`capabilityService`](../../code/kimi-code/packages/agent-core-v2/src/app/capability/capabilityService.ts)
6. [`rename-replace`](../../code/kimi-code/packages/minidb/src/rename-replace.ts)
