# Codex Rollout：JSONL 事实记录、恢复与索引

> 原始研究版本：`code/codex@28aacbb`
>
> 2026-08-19 增量复核版本：`code/codex@f5a3dc55404d`

## 1. 结论

Rollout 是 Codex thread 的可追加事实记录，不是简单聊天 transcript。它同时保存 session metadata、模型 input/output item、turn context 和关键事件，使 thread 能恢复、fork、compact、搜索与审计。SQLite state DB/索引用于加速列表和查询，但 JSONL rollout 仍是可移植的主要记录来源。

增量复核确认这个主从关系未变。新修复主要集中在迁移和恢复边界：保留 thread name、分别恢复 thread 时间戳最大值、去重 archive 触发的 rollout move，并在 compaction 后保留 MCP resource origin。这些修复强化了“JSONL 保留 canonical facts，索引可重建”的原有设计。

核心实现位于独立 [`rollout`](../../code/codex/codex-rs/rollout) crate，Core 通过 `Session` 调用 recorder。

## 2. 文件与记录类型

`RolloutRecorder` 为 thread 创建按日期组织的 JSONL 文件，首部写 session metadata，后续追加 `RolloutItem`。常见 item 包括：

- session meta；
- Responses input/output item；
- `EventMsg` 中需要持久化的生命周期事实；
- `TurnContextItem`；
- compaction、rollback 等重建标记。

不是每个 UI delta 都必须写入。持久层保留能重建模型 history、turn 边界和 thread metadata 的 canonical items，流式字符 delta 可以从最终 item 或客户端实时事件获得。

## 3. 写入链

```text
Session 产生 canonical items
  → persist_rollout_items
  → RolloutRecorder.record_canonical_items
  → writer queue / JSON serialization
  → append JSONL
  → state DB / session index 更新
  → flush / shutdown
```

[`record_canonical_items()`](../../code/codex/codex-rs/rollout/src/recorder.rs) 负责批量记录，`persist()`/`flush()` 提供不同持久化边界，`shutdown()` 排空 writer。发出客户端 `TurnComplete` 与数据真正 fsync 不是天然同一时刻；需要强 durability 的调用方应依赖 recorder 的 flush/shutdown 合同。

单独的 [`append_rollout_item_to_path()`](../../code/codex/codex-rs/rollout/src/recorder.rs) 用于已知文件的追加操作，但正常 Session 应走 recorder，避免绕过索引和并发序列化。

## 4. 恢复不是逐行原样回放

[`get_rollout_history()`](../../code/codex/codex-rs/rollout/src/recorder.rs) 和 Core 的 [`rollout_reconstruction.rs`](../../code/codex/codex-rs/core/src/session/rollout_reconstruction.rs) 共同恢复 thread。过程需要：

1. 读取/校验 session metadata；
2. 识别 turn started/complete/aborted 边界；
3. 应用 rollback/truncation 语义；
4. 选择仍有效的 model items 与 compaction summary；
5. 恢复最近 turn settings/context；
6. 重建客户端可见状态与模型 history。

因此直接 `jq` 把所有 message 拼起来不能得到正确上下文。被 rollback 的 item 仍可能物理存在于 append-only 文件中，但逻辑视图已排除它。

## 5. Rollback、Fork 与 Compaction

Rollback 通过追加 `ThreadRolledBack` 等标记表达逻辑截断，而非破坏性删除历史。[`thread_rollout_truncation.rs`](../../code/codex/codex-rs/core/src/thread_rollout_truncation.rs) 计算有效视图，并处理嵌套/重复 rollback。

Fork 读取某个有效历史前缀，为新 thread 写独立 metadata/rollout。父子 thread 后续互不共享 append stream。Rollout reference index 用于追踪引用关系，避免只靠目录扫描猜父子关系。

Compaction 把较长历史总结成新上下文 item。原始记录仍留在 rollout，模型恢复时使用 compacted view；审计工具仍可查看压缩前事实。摘要不是数据库清理操作。

## 6. 列表、搜索与 SQLite

[`list.rs`](../../code/codex/codex-rs/rollout/src/list.rs) 能从 rollout 文件读取 `ThreadItem`、分页 cursor、排序与摘要；反向 JSONL scanner 用于从文件尾高效寻找最近信息。目录布局包含日期，因此 `rollout_date_parts()` 和 thread id 查找函数负责路径解析。

[`state_db.rs`](../../code/codex/codex-rs/rollout/src/state_db.rs) 将 thread metadata 投影到 SQLite，支持更快列表、筛选、archived 状态和 migration/backfill。数据库损坏时 app-server 有备份并重建的恢复路径，这也说明 state DB 是可重建投影，不应成为唯一事实源。

## 7. 并发与崩溃边界

- 同一 recorder 的写入必须保持顺序，否则 tool call/output 和 turn terminal event 会错位。
- 最后一行若因崩溃不完整，读取器需要把尾部损坏与中间记录损坏区别处理。
- 列表读取不能假设每个文件都完整；无效/正在写入文件应被跳过或降级。
- archive 通常是路径/状态迁移，不等于删除；unarchive 需要同步索引。
- 恢复 provider/model 时要使用 session metadata，不能无条件套当前默认配置。

## 8. 测试证据

| 主题 | 测试 |
|---|---|
| 写入、恢复、metadata | [`recorder_tests.rs`](../../code/codex/codex-rs/rollout/src/recorder_tests.rs) |
| compaction 后视图 | [`compression_tests.rs`](../../code/codex/codex-rs/rollout/src/compression_tests.rs) |
| SQLite 投影 | [`state_db_tests.rs`](../../code/codex/codex-rs/rollout/src/state_db_tests.rs) |
| session index | [`session_index_tests.rs`](../../code/codex/codex-rs/rollout/src/session_index_tests.rs) |
| rollback 有效历史 | [`thread_rollout_truncation_tests.rs`](../../code/codex/codex-rs/core/src/thread_rollout_truncation_tests.rs) |
| Core 恢复 | [`rollout_reconstruction_tests.rs`](../../code/codex/codex-rs/core/src/session/rollout_reconstruction_tests.rs) |

## 9. 推荐阅读顺序

1. `rollout/src/recorder.rs`：文件生命周期和 canonical write。
2. `rollout/src/list.rs`：如何从文件构造 thread 列表。
3. `core/src/session/rollout_reconstruction.rs`：恢复语义。
4. `core/src/thread_rollout_truncation.rs`：append-only rollback。
5. `rollout/src/state_db.rs`：JSONL 到 SQLite 投影。
