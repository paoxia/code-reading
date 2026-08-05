# mini-swe-agent 跨平台适配分析

> 源码版本：`main@a83fcae`
>
> 研究范围：本地命令执行环境；Docker、SWE-ReX、Singularity 和 bubblewrap 等可替换环境只说明边界。

## 1. 结论

mini-swe-agent 没有建立完整的 OS 适配层，而是把大部分差异交给 Python 标准库和宿主默认 Shell。它只在进程终止处明确区分 POSIX 与非 POSIX。因此它的代码最小，但“可在 Windows 启动”不等于“Windows 与 Linux/macOS 命令语义一致”。

## 2. 核心调用链

[`LocalEnvironment.execute()`](../../code/mini-swe-agent/src/minisweagent/environments/local.py) 将模型产生的 `command` 传给 `_run()`：

```text
bash tool call
  → LocalEnvironment.execute()
  → subprocess.Popen(command, shell=True)
  → communicate(timeout)
  → stdout + returncode
```

`shell=True` 没有显式指定 Shell。Unix 通常由 `/bin/sh` 解释，Windows 则由 Python/系统规则选择命令处理器。实现注释称其执行 bash command，但源码没有保证 Windows 上存在或启动 Bash。

## 3. 系统差异

| 方面 | Linux/macOS（POSIX） | Windows/其他非 POSIX |
| --- | --- | --- |
| Shell | `shell=True` 的系统默认值 | `shell=True` 的系统默认值，未强制 Bash |
| 进程创建 | `start_new_session=True` | 不创建 POSIX session |
| 超时终止 | `os.killpg(pid, SIGKILL)`，终止进程组 | `process.kill()`，只直接终止子进程 |
| 编码 | 强制 UTF-8，非法字节替换 | 相同 |
| OS 信息 | `platform.uname()` 注入模板变量 | 相同 |

POSIX 分支能够回收命令派生的进程组；Windows fallback 可能遗留孙进程。这里没有 Job Object、`taskkill /T` 或其他 Windows 进程树机制。

## 4. 平台信息如何影响 Agent

`get_template_vars()` 合并配置、`platform.uname()`、环境变量和调用方参数，模型提示模板可以看到系统事实。但“把 OS 名称告诉模型”只是提示层适配，并不改变命令执行器的语法、路径或权限能力。

## 5. 环境替换是主要扩展点

项目通过 `Environment` 多态提供 Docker、SWE-ReX、Singularity、bubblewrap 等实现。若任务需要一致的 Linux 用户空间，与其扩张 `LocalEnvironment` 的平台判断，项目更倾向替换整个 Environment。bubblewrap 本身是 Linux 能力，不能视为三平台通用沙箱。

## 6. 限制与风险

- Windows 上模型生成 Bash 语法时，默认 Shell 不一定能解释。
- Windows 超时终止不保证清理完整进程树。
- 没有内建盘符、UNC、大小写、`.exe/.cmd` 或 PATH 分隔符适配。
- 没有三平台统一的本机沙箱；隔离能力取决于所选 Environment。
- 当前分析是源码静态检查，未在 Windows/macOS 上运行验证。

## 7. 推荐阅读顺序

1. [`LocalEnvironment`](../../code/mini-swe-agent/src/minisweagent/environments/local.py)
2. [`Environment` 工厂](../../code/mini-swe-agent/src/minisweagent/environments/__init__.py)
3. [`环境扩展说明](../../code/mini-swe-agent/docs/advanced/environments.md)
4. [`bubblewrap 环境](../../code/mini-swe-agent/src/minisweagent/environments/extra/bubblewrap.py)
