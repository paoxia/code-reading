# Codex 跨平台适配分析

> 原始研究版本：`main@6d4d9442c`
>
> 2026-08-19 增量复核版本：`main@f5a3dc55404d`
>
> 2026-08-24 增量复核版本：`main@339751715c64`
>
> 研究范围：原生二进制分发、Shell/进程执行、沙箱选择和进程启动前加固。

## 1. 结论

Codex 的跨平台设计不止是选择不同 Shell，而是把“平台原生二进制 + 平台沙箱后端 + 条件编译的进程安全能力”组合起来。macOS、Linux、Windows 对外提供相近的执行权限模型，但底层强制机制不同，部分能力也明确不等价。

增量复核中，Linux sandbox 增加了对旧版 Bubblewrap FD mount 的兼容；Windows 则继续补强沙箱诊断、ACL 更新失败传递和 reparse point 防护。这些是平台后端的健壮性修复，不改变本文的“统一策略、多种强制机制”结论。

2026-08-24 的变化继续沿这条路线：Linux Bubblewrap 加固 synthetic mount registry 隔离，统一执行器开始严格遵守 granular sandbox approval；macOS Seatbelt 和 Windows restricted-token 的职责边界没有被合并。平台后端仍各自强制执行，上层只共享 permission/sandbox policy。

## 2. 原生发行包选择

[`codex-cli/bin/codex.js`](../../code/codex/codex-cli/bin/codex.js) 根据 `process.platform` 和 `process.arch` 映射 npm 平台包：

| OS | x64 | arm64 |
| --- | --- | --- |
| macOS | `x86_64-apple-darwin` | `aarch64-apple-darwin` |
| Linux | `x86_64-unknown-linux-musl` | `aarch64-unknown-linux-musl` |
| Windows | `x86_64-pc-windows-msvc` | `aarch64-pc-windows-msvc` |

启动器从平台包的 `vendor/<triple>/codex/` 找到二进制；Windows 文件名是 `codex.exe`。这种“薄 JavaScript launcher + 原生 Rust binary”让 npm 安装入口统一，同时保留 OS 原生实现。

## 3. 沙箱选择是统一策略的窄腰

[`get_platform_sandbox()`](../../code/codex/codex-rs/sandboxing/src/manager.rs) 在编译期选择：

```text
macOS   → MacosSeatbelt
Linux   → LinuxSeccomp
Windows → WindowsRestrictedToken（仅配置启用时）
其他    → None
```

上层提交统一的 sandbox policy 和 permission profile，`SandboxManager` 再把命令转换成相应后端所需的 argv、环境和文件系统覆盖。统一的是策略输入和执行结果，不是底层实现。

## 4. macOS：Seatbelt

macOS 后端生成 Seatbelt profile，限制可读写路径与网络，再通过系统 sandbox 机制启动命令。拒绝信息也有 Seatbelt 专用分类，便于 Agent 判断失败来自命令本身还是沙箱。

相关入口：[`sandboxing manager`](../../code/codex/codex-rs/sandboxing/src/manager.rs)、[`Seatbelt 实现`](../../code/codex/codex-rs/sandboxing/src/seatbelt.rs)

## 5. Linux：bubblewrap、seccomp 与 Landlock

当前 [`linux_run_main.rs`](../../code/codex/codex-rs/linux-sandbox/src/linux_run_main.rs) 注释说明：

- 文件系统隔离默认采用 bubblewrap；
- seccomp 约束系统调用；
- Landlock 保留为 legacy/backup 路径，可通过 feature 选择旧实现。

因此类型名 `LinuxSeccomp` 不能简单理解成“只有 seccomp”；实际管线还涉及 mount namespace/文件系统规则。内核、容器 profile 或 bwrap 可用性会影响能否强制执行，测试中也会在无法 enforcement 的宿主上跳过相关用例。

## 6. Windows：restricted token 与文件系统覆盖

Windows 选择 `WindowsRestrictedToken`，执行路径会解析 restricted/elevated backend 的文件系统覆盖，并使用 Windows 原生 token、ACL 等机制。与 Unix 不同，它的沙箱默认选择还受 `windows_sandbox_enabled` 控制；禁用时 `get_platform_sandbox()` 返回 `None`。

Windows 路径、可执行文件和进程启动的专门逻辑集中在 [`sandboxing/src/windows.rs`](../../code/codex/codex-rs/sandboxing/src/windows.rs) 以及独立 [`windows-sandbox-rs`](../../code/codex/codex-rs/windows-sandbox-rs) crate，而不是散落为字符串分隔符判断。

## 7. 进程启动前加固

[`process-hardening`](../../code/codex/codex-rs/process-hardening/src/lib.rs) 在 `main()` 前执行：

| OS | 加固动作 |
| --- | --- |
| Linux | `PR_SET_DUMPABLE=0`、core size 设为 0、清理 `LD_*` |
| macOS | `PT_DENY_ATTACH`、core size 设为 0、清理 `DYLD_*` |
| Windows | 函数存在，但当前仍标记 `TODO` |

因此不能声称 Windows 与 Unix 的 pre-main hardening 已完全对齐。这也是源码明确暴露的未完成项。

## 8. 进程与 Shell

Codex 保存和探测用户 Shell，并为 PowerShell 提供 snapshot/命令语义支持。执行服务器把 sandbox type 连同进程请求传递给本机执行层，Windows 不依赖 Unix signal/process group 的假设。相比只在 `spawn()` 旁写平台分支，Codex 将执行生命周期和 sandbox type 放入协议，便于 app-server、CLI 与统一 exec 复用。

## 9. 限制与注意事项

- Windows sandbox 是否生效取决于配置和后端支持，不应只凭 OS 推断。
- Linux enforcement 受内核、bubblewrap 和容器环境影响。
- Windows pre-main hardening 当前有明确 `TODO`。
- “审批”是用户决策机制，“沙箱”才是 OS 强制边界，两者不能混为一谈。
- 本次未执行跨平台沙箱集成测试。

## 10. 推荐阅读顺序

1. [`npm launcher`](../../code/codex/codex-cli/bin/codex.js)
2. [`SandboxManager`](../../code/codex/codex-rs/sandboxing/src/manager.rs)
3. [`Linux sandbox`](../../code/codex/codex-rs/linux-sandbox/src/linux_run_main.rs)
4. [`Windows sandbox adapter`](../../code/codex/codex-rs/sandboxing/src/windows.rs)
5. [`process-hardening`](../../code/codex/codex-rs/process-hardening/src/lib.rs)
6. [`exec server protocol`](../../code/codex/codex-rs/exec-server-protocol/src/protocol.rs)
