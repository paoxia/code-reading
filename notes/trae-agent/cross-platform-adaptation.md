# Trae Agent 跨平台适配分析

> 源码版本：`main@e839e55`
>
> 研究范围：`BashTool` 的本机持久 Shell 会话。

## 1. 结论

Trae Agent 用一套 sentinel 协议统一采集持久 Shell 会话的输出和退出码，但底层命令语言并不统一：Unix 使用 Bash，Windows 使用 cmd.exe。它适配了会话生命周期和退出码格式，没有在 Windows 上提供 Bash 兼容环境。

## 2. 持久会话协议

[`_BashSession`](../../code/trae-agent/trae_agent/tools/bash_tool.py) 启动一个长生命周期子进程。每次调用不是创建新 Shell，而是把命令写入 stdin，并在命令后追加带退出码的 sentinel：

```text
command
  → 写入持久 Shell stdin
  → 执行 command + echo sentinel(exit_code)
  → 轮询 stdout buffer
  → 找到 sentinel 后拆出 output 和 error_code
```

这使 `cd`、Shell 变量等会话状态可以跨工具调用保留。

## 3. Unix 与 Windows 分支

| 语义 | Linux/macOS | Windows |
| --- | --- | --- |
| Shell | `/bin/bash` | `cmd.exe /v:on` |
| 进程组 | `preexec_fn=os.setsid` | 无 `setsid` |
| 上一命令退出码 | `$?` | `!errorlevel!` |
| 命令分隔符 | `;` | `&` |
| 延迟变量展开 | 不需要 | `/v:on` 启用 |

Windows 使用 `!errorlevel!` 是因为 `%errorlevel%` 可能在整段命令解析时过早展开。sentinel 两边使用固定文本，只有退出码表达式按 OS 替换。

## 4. 停止与超时

`stop()` 先 `terminate()`，等待 5 秒后再 `kill()`，又等待 2 秒；`run()` 超时后把 session 标记为 `_timed_out`，后续调用必须重启工具。Unix 虽创建了新 session，但当前 `stop()` 没有对进程组发送信号；Windows 也没有 Job Object 或进程树终止逻辑，因此子孙进程清理仍可能不完整。

## 5. 语义错位风险

工具公开名称仍是 `bash`，类和错误文案也称 Bash，但 Windows 实际执行 cmd.exe。若系统提示没有同步约束，模型可能生成 `export`、`$(...)`、`grep` 等 cmd.exe 无法解释的语法。这是“协议统一”与“命令语言统一”必须区分的典型例子。

## 6. 限制

- 没有 PowerShell 或 Git Bash 探测。
- 没有 Windows/POSIX 路径转换。
- macOS 与 Linux 共用 Unix 分支，没有分别处理桌面、PATH 或沙箱差异。
- 测试覆盖 BashTool 行为，但本次没有在三种真实系统上运行。

## 7. 推荐阅读

1. [`BashTool`](../../code/trae-agent/trae_agent/tools/bash_tool.py)
2. [`BashTool 测试](../../code/trae-agent/tests/tools/test_bash_tool.py)
3. [`工具基类](../../code/trae-agent/trae_agent/tools/base.py)
