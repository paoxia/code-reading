# Aider：代码编辑策略、Repository Map 与 Git 工作流

> 源码版本：`Aider-AI/aider main@5dc9490`（2026-05-22）

## 研究范围

Aider 是终端 AI Pair Programming 工具。与强调通用工具调用的 Coding Agent 不同，它的核心竞争力集中在三个问题：给模型哪些仓库上下文、要求模型以什么格式描述修改、如何把修改可靠地落到 Git 工作区。

## 核心对象

```text
CLI main
  → Model 配置
  → GitRepo + RepoMap + InputOutput
  → Coder.create(edit_format)
       → 选择具体 Coder
  → Coder.run()
       → 组装 chat files / repo map / history
       → 模型请求
       → 解析编辑块并写文件
       → lint / test / reflection
       → Git commit
```

| 类/模块 | 职责 |
|---|---|
| [`main.py`](../../code/aider/aider/main.py) | CLI 参数、模型和运行时装配 |
| [`Coder`](../../code/aider/aider/coders/base_coder.py) | 会话、上下文、模型调用、应用编辑与反馈循环 |
| [`coders`](../../code/aider/aider/coders) | 各种模型编辑格式的 Prompt 与 Parser |
| [`RepoMap`](../../code/aider/aider/repomap.py) | 仓库符号抽取、图排序与 token 预算裁剪 |
| [`GitRepo`](../../code/aider/aider/repo.py) | dirty 状态、diff、commit、undo 与作者信息 |
| [`Model`](../../code/aider/aider/models.py) | 模型元数据、能力与推荐编辑格式 |

## Coder 与编辑循环

[`Coder.create()`](../../code/aider/aider/coders/base_coder.py) 根据模型配置或显式参数选择具体编辑格式，并实例化相应子类。切换编辑格式时，旧 Assistant 消息可能被摘要，因为让新模型继续看到旧格式示例会诱导它模仿错误协议。

主循环由 `run()`、`run_one()` 和 `send_message()` 共同完成：

```text
用户请求
  → 识别提到的文件和 URL
  → 构造 system + examples + repo map + chat files + history
  → 模型 stream
  → concrete Coder 解析 edits
  → apply_updates()
  → lint / test
  → 若失败且允许 reflection，将错误反馈给模型
  → 可选 auto commit
```

Aider 的循环通常围绕“生成并应用一组文件编辑”展开，不是给模型无限制的通用 Shell 工具集。Shell 命令建议和 `/run` 等命令存在，但代码修改的主通道仍是编辑协议。

### 一轮请求的真实控制流

只写成 `run() → send_message()` 会漏掉决定行为的中间阶段。按 [`base_coder.py`](../../code/aider/aider/coders/base_coder.py) 展开，一轮请求实际经历：

1. `run()` 负责交互循环，`run_one()` 清理本轮状态并进入 `send_message()`。
2. `format_chat_chunks()` 将 system prompt、格式示例、只读文件、Repo Map、完整 chat files、历史和当前请求分块；`format_messages()` 再生成最终模型消息。
3. `check_tokens()` 在发送前估算各分块成本。超限时必须提前摘要或报错，并非让模型自行忽略末尾。
4. `send()` 处理模型调用与流式增量；`send_message()` 收集响应、usage 和 shell command 建议。
5. concrete `Coder.get_edits()` 把模型文本解析成统一编辑描述；`prepare_to_edit()` 做路径、dirty file、新文件和用户授权检查；`apply_updates()` 协调真正落盘。
6. 子类的 `apply_edits()` 实现具体替换。成功后进入 lint、test 和 `auto_commit()`；可恢复失败会写回会话形成 reflection。

所以“模型输出了正确 diff”不等于文件一定改变。失败可能发生在协议解析、文件授权、dirty 检查、片段定位或写入阶段。排查时应依次检查 `get_edits()`、`prepare_to_edit()` 和具体 parser，而不是只看模型原文。

`Coder` 还维护 `done_messages` 与 `cur_messages`：前者是已稳定历史，后者属于仍可能被反思、重试或摘要改写的当前轮。文件状态同样分层：`abs_fnames` 可编辑，`abs_read_only_fnames` 只供参考，其他文件通常只以 Repo Map 形式出现。模型提到某个路径并不会自动获得写权限，最终仍由 `allowed_to_edit()` 决定。

## 多种编辑格式

不同模型对 Patch 协议的遵循能力不同，Aider 将编辑格式实现为独立 `Coder`：

| 格式 | 实现 | 特点 |
|---|---|---|
| Search/Replace | [`editblock_coder.py`](../../code/aider/aider/coders/editblock_coder.py) | 用原片段与替换片段定位修改 |
| Unified Diff | [`udiff_coder.py`](../../code/aider/aider/coders/udiff_coder.py) | 解析近似 unified diff，并做容错匹配 |
| Whole File | [`wholefile_coder.py`](../../code/aider/aider/coders/wholefile_coder.py) | 返回完整文件，简单但 token 成本高 |
| Patch | [`patch_coder.py`](../../code/aider/aider/coders/patch_coder.py) | 使用专门 Patch 格式 |
| Architect | [`architect_coder.py`](../../code/aider/aider/coders/architect_coder.py) | 推理模型提出方案，Editor 模型实施编辑 |

编辑格式包含 Prompt 和 Parser 两半。只比较输出文本样式不足以评价可靠性，还要研究定位失败、模糊匹配、文件名识别、重复片段和 malformed response 的恢复逻辑。

## Repository Map

[`RepoMap`](../../code/aider/aider/repomap.py) 不把所有源文件原文塞进上下文。它使用 Tree-sitter/grep-ast 提取定义与引用 Tag，构建符号关系，再根据当前 chat files、用户提及的文件和标识符进行排序，在 token 预算内输出带上下文的关键代码骨架。

```text
tracked files
  → language parser
  → definitions / references Tags
  → dependency graph / ranking
  → TreeContext 渲染关键行
  → token budget 裁剪
  → repo map message
```

解析结果缓存在 `.aider.tags.cache.*`。当没有明确 chat file 时，Repo Map 可以使用更大的预算给出全仓概览；已有 chat files 时，则用较小地图补充其他文件关系。解析失败或仓库过大时会降级，而不是保证所有语言都获得同等精度。

### Tag、图排序与预算裁剪

`get_tags_raw()` 根据扩展名选择 Tree-sitter language/query，产出 definition/reference Tag；`get_ranked_tags()` 再建立文件—符号关系图，把 chat files、用户文本中的 identifier、文件名命中和被引用关系转成排序信号。

`get_ranked_tags_map_uncached()` 会反复选择候选 Tag，经 `to_tree()`/`render_tree()` 生成带行级上下文的文本，再按 `token_count()` 调整规模。预算约束作用于最终渲染文本，而非简单限制 Tag 数量。因此相同仓库在 chat files、用户提及符号或 token budget 改变后，会得到不同地图。

缓存损坏走 `tags_cache_error()` 恢复；语言不支持、query 缺失或解析失败时会降级。Repo Map 适合导航和提高召回，不适合作为“仓库中不存在某定义”的证明。

## 上下文分层

Coder 把文件分为至少三类：

- chat files：完整内容进入上下文，并允许编辑；
- read-only files：提供完整参考但不应修改；
- other repository files：通常只通过 Repo Map 暴露结构。

这种显式集合比“每轮自动检索任意文件”更可控，但也要求用户或模型及时把目标文件加入 chat。文件提及检测和 token 预算策略直接影响修改质量。

## Git 工作流

[`GitRepo`](../../code/aider/aider/repo.py) 封装仓库状态和提交。Aider 可以在会话开始或编辑前处理已有 dirty changes，在成功修改后由 [`auto_commit()`](../../code/aider/aider/coders/base_coder.py) 生成提交消息并提交本轮涉及的文件。

Git 在这里不只是保存按钮：

- 用 diff 构造模型上下文或提交说明；
- 将 Aider 修改与用户原有修改区分；
- 支持 `/undo` 回退最近的 Aider commit；
- 记录 commit hash，便于继续会话和审计；
- 检查 ignored、tracked、dirty 与 detached 等状态。

关闭 auto-commit 后，文件编辑仍会发生，只是缺少每轮恢复点。用户已有未提交修改与 Agent 修改混合时，应谨慎解释“undo”的恢复范围。

## Lint、Test 与反思

文件应用后可自动运行 [`linter.py`](../../code/aider/aider/linter.py) 和配置的测试命令。失败结果会作为新上下文触发 reflection，直到修复、用户中断或达到限制。这个闭环提升编辑可靠性，但测试命令本身会在宿主环境执行，不构成沙箱。

## 限制与风险

- Repo Map 是 token 预算下的近似结构视图，不是完整语义索引。
- Search/Replace、diff 和 whole-file 各有失败模式，模型默认格式应结合模型元数据理解。
- 自动提交提高可恢复性，但也可能把错误选择的文件纳入提交；需检查 Git diff。
- Lint/test/命令在本地运行，处理不可信仓库时需要外部隔离。
- 当前源码版本的最新提交时间早于其他项目，活跃度和模型配置应结合后续上游状态复核。

## 推荐阅读顺序

1. [`aider/main.py`](../../code/aider/aider/main.py)：运行时装配。
2. [`coders/base_coder.py`](../../code/aider/aider/coders/base_coder.py)：主循环与上下文。
3. [`coders/editblock_coder.py`](../../code/aider/aider/coders/editblock_coder.py)：Search/Replace 落盘。
4. [`coders/udiff_coder.py`](../../code/aider/aider/coders/udiff_coder.py)：Diff 容错。
5. [`repomap.py`](../../code/aider/aider/repomap.py)：仓库地图。
6. [`repo.py`](../../code/aider/aider/repo.py)：Git 生命周期。
7. [`tests/basic`](../../code/aider/tests/basic)：从失败用例理解边界。
