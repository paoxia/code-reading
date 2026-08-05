# Continue 跨平台适配分析

> 源码版本：`main@5522c6f44`
>
> 研究范围：二进制/原生依赖分发、VS Code 平台判断、CLI Hook 和资源监控。

## 1. 结论

Continue 采用分散式适配：构建层建立 target matrix，各产品模块在需要时读取 `process.platform`。CLI Hook 使用宿主原生 Shell，而不是统一 Bash；IDE、资源监控和原生依赖各自维护平台分支。

## 2. 分发目标

[`binary/utils/targets.js`](../../code/continue/binary/utils/targets.js) 声明：

| 系统 | 架构 |
| --- | --- |
| macOS | x64、arm64 |
| Linux | x64、arm64 |
| Windows | x64 |

ripgrep asset 随 target 选择 Darwin/Linux tar.gz 或 Windows zip；LanceDB 包映射还列出 Windows arm64，但主 `ALL_TARGETS` 没有 Windows arm64。不能把某个依赖存在 arm64 包误写成 Continue 完整发行目标已支持该组合。

## 3. IDE 平台抽象

VS Code 工具函数把 Node 的 `darwin`、`win32`、其他值映射为内部 `mac`、`windows`、`linux`。平台和架构可用于选择安装行为、原生依赖和错误提示。当前 `isUnsupportedPlatform()` 中有一段具体平台组合限制被注释，说明源码中的目标矩阵与运行时强制阻断并非完全相同概念。

## 4. CLI Hook 使用宿主 Shell

[`hookRunner.ts`](../../code/continue/extensions/cli/src/hooks/hookRunner.ts) 的命令 Hook：

```text
Windows → cmd.exe /c <command>
其他系统 → /bin/sh -c <command>
```

Hook 输入通过 stdin 发送 JSON，stdout 可返回结构化决定，退出码 2 表示阻止操作。这套协议跨平台统一，但用户配置的命令字符串必须符合对应宿主 Shell；一份含 Bash 语法的 Hook 配置不能自然移植到 Windows cmd.exe。

## 5. 系统指标能力不等价

[`ResourceMonitoringService`](../../code/continue/extensions/cli/src/services/ResourceMonitoringService.ts) 在 Windows 对部分指标走不同实现，并对 load average 返回 `[0, 0, 0]`；Unix 则使用 `os.loadavg()`。这是正确的能力降级信号：跨平台 API 可以统一形状，但不能假装 OS 都提供同一种指标。

## 6. 测试策略透露的边界

Hook 测试中依赖 `/bin/sh` 的用例在 Windows 跳过；CLI smoke test 则显式切换 Windows 命令、路径和空设备 `nul`/`/dev/null`。这说明项目既有跨平台 smoke 分支，也仍有只验证 Unix 语义的测试区域。

## 7. 限制与风险

- 平台判断分散在多个产品包，容易出现支持矩阵漂移。
- Hook 采用原生 Shell，配置可移植性取决于用户避免 Shell 方言。
- Windows arm64 在依赖映射与主发行目标之间不一致，应谨慎描述支持级别。
- 本次为静态源码研究，未执行三平台构建。

## 8. 推荐阅读

1. [`构建目标](../../code/continue/binary/utils/targets.js)
2. [`VS Code 平台工具](../../code/continue/extensions/vscode/src/util/util.ts)
3. [`CLI Hook Runner](../../code/continue/extensions/cli/src/hooks/hookRunner.ts)
4. [`资源监控](../../code/continue/extensions/cli/src/services/ResourceMonitoringService.ts)
5. [`CLI smoke test](../../code/continue/extensions/cli/smoke-test.mjs)
