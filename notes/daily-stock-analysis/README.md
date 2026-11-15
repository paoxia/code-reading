# Daily Stock Analysis：行情、LLM 报告与推送链路

> 收录与静态阅读日期：2026-11-15。研究版本 `f044e95f2156d6c53cdeabf4bf27c60df4e366d5`，提交日期 2026-11-14。未部署、调用模型或行情服务，也未运行上游测试及收益评估。

历史下载多次停滞，本次先以深度 1、按需对象及稀疏检出获取当前源码，保留根目录文件和 `src/`、`data_provider/`、`api/`、`strategies/`、`bot/`、`tests/`、`.github/`。尚未补全历史或下载其余目录；后续 `make pull` 会尝试补全浅克隆历史，需要更多目录时再扩展稀疏检出范围。

## 定位与研究范围

[ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) 将行情、技术指标、新闻和 LLM 分析组合成股票分析报告，并提供 Web、Bot、API、定时任务及通知入口。

本笔记聚焦主流程、数据与模型协作、报告发送及回测解释的边界。多市场能力和部署选项以 [上游 README](../../code/daily-stock-analysis/README.md) 为入口；具体数据覆盖仍取决于数据源和配置。

## 源码入口

| 模块 | 入口 | 主要职责 |
| --- | --- | --- |
| 命令与运行模式 | [main.py](../../code/daily-stock-analysis/main.py) | 参数解析、环境与日志初始化、一次性分析、定时与服务入口 |
| 分析编排 | [pipeline.py](../../code/daily-stock-analysis/src/core/pipeline.py) | `StockAnalysisPipeline` 协调抓取、保存、分析、进度和通知 |
| 数据源 | [data_provider](../../code/daily-stock-analysis/data_provider) | 统一获取接口与多种行情适配器；管理器位于 `base.py` |
| 模型分析 | [analyzer.py](../../code/daily-stock-analysis/src/analyzer.py) | 模型分析与结果处理的进一步阅读入口 |
| 通知 | [notification.py](../../code/daily-stock-analysis/src/notification.py) | `NotificationService` 生成报告、选择路由并返回发送结果 |
| 历史与存储 | [storage.py](../../code/daily-stock-analysis/src/storage.py) | 数据持久化入口；细分仓储在 `src/repositories/` |
| 回测逻辑 | [backtest_engine.py](../../code/daily-stock-analysis/src/core/backtest_engine.py) | 对历史分析与后续日线进行评价的纯逻辑 |
| Web 分析入口 | [analysis.py](../../code/daily-stock-analysis/api/v1/endpoints/analysis.py) | API 侧的后续阅读入口；本次未完整追踪所有端点 |

## 单次分析的主链

```text
main / 定时入口
  → run_full_analysis：确定目标、交易日与运行配置
  → StockAnalysisPipeline.run
  → process_single_stock
  → fetch_and_save_stock_data
  → analyze_stock
  → 分析结果、历史及报告处理
  → 单股或汇总通知
```

这描述的是核心个股链路；大盘复盘、API、Agent 和各类运行模式还有自己的分支，不能把它当成所有入口完全相同的调用图。

`StockAnalysisPipeline.__init__()` 装配数据库、`DataFetcherManager`、技术趋势分析器、`GeminiAnalyzer` 和 `NotificationService`，并尝试初始化搜索等辅助服务。搜索服务初始化失败时可进入无搜索模式，因此流程完成与获得了完整新闻输入是两个不同事实。

`fetch_and_save_stock_data()` 先按冻结的运行参考时间确定可复用交易日，再检查数据库；非强制刷新且已有对应数据时跳过网络获取，否则抓取日线并带来源名称保存。这里的缓存目标是交易日语义，不宜简单理解为“今天有任意一条数据就不更新”。

`process_single_stock()` 设置冻结目标日期、查询与诊断上下文，协调数据获取和分析；`run()` 负责批量处理。阅读失败处理时，应继续核对成功结果列表与完整目标列表之间的差异，避免把部分股票成功理解成全批次成功。

## 数据、模型和通知的边界

- 数据源包提供多种实现；支持某个市场、免费可用、稳定可用和相同字段口径需要分别核对，不能从适配器数量直接推断。
- 技术指标计算和 LLM 判断属于不同阶段。追踪报告时应保留数据来源、生成时间和模型上下文，而不是只阅读最终评分。
- `NotificationService` 包含报告生成、路由、噪声控制、上下文回复及 `send_with_results()`。报告已保存、选中了通知渠道和渠道发送成功应分别观察。
- 本次没有验证所有市场的数据源优先级、模型路由或推送渠道，也未检查整个系统的交易执行能力。

## 回测模块实际说明了什么

`BacktestEngine` 将自身定义为日线、仅做多的评价引擎。`evaluate_single()` 接收历史分析日期、起始价格、后续 OHLC、止盈止损与评价窗口；样本不足返回 `insufficient_data`，无效起始价格返回错误状态。

日线无法判断同一根 K 线内先触及止盈还是止损。该实现会记录歧义，并对模拟退出作保守处理。方法中的 `simulated_return_pct` 使用起始与模拟退出价格计算；不能仅凭此字段认定已经覆盖手续费、滑点、流动性、组合管理与真实成交约束。

因此，这里的历史分析评价可以作为后续研究入口，但本次没有形成策略有效或可实盘执行的结论。

## 推荐阅读顺序与后续问题

先读 `main.py` 的 `run_full_analysis()`，再跟踪 `StockAnalysisPipeline.run()`、`process_single_stock()`、数据获取和 `analyze_stock()`；随后分别进入数据源、模型分析和通知。回测作为独立分支阅读，避免把报告生成与策略验证混为一个成功条件。

后续可重点核对交易日和时区、数据回退时的字段口径、上下文快照、失败与部分成功的返回语义、重复运行和重复通知，以及回测使用的信息在历史时点是否已经可用。本次为首次静态阅读，未开展这些场景的运行验证。
