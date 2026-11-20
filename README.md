# code-reading

开源项目研究与阅读笔记

## 目录结构

```
├── projects.json    # 研究中的GitHub项目列表
├── code/            # 克隆的项目源码（已忽略）
├── notes/           # 单项目研究笔记
│   └── {project}/   # 每个项目一个文件夹
├── summary/         # 跨项目总结
│   └── {topic}/     # 每个主题一个文件夹
├── .vitepress/      # VitePress 配置与主题
├── package.json     # 笔记站依赖与本地命令
└── html/            # 生成后的静态知识站
```

## 研究索引

当前清单共 **51 个项目、6 个分类**，涵盖 Coding Agent、Agent 框架、Agent 平台与助手、AI 基础设施、模型原理和 AI 应用。2026-11-02 建立了原有 48 个项目的研究基线。下列项目为后续新增，研究版本与历史状态见项目总览。

- [WeKnora](notes/weknora/README.md)（2026-11-20）：企业知识库的文档导入、RAG 问答、Agent 和自动 Wiki。
- [MCode Stack](notes/mcode-stack/README.md)：MiniMax Code 团队的 Agent 工程工作流、Skills、插件组织与审查机制。
- [Daily Stock Analysis](notes/daily-stock-analysis/README.md)：多市场股票数据、LLM 分析、报告与推送的工程参考。

- [全部项目总览与阅读路线](summary/project-landscape/overview.md)
- [AI 基础设施分层与阅读路线](summary/ai-infrastructure/architecture-and-reading-guide.md)
- [跨项目主题索引](summary/README.md)

## 使用方法

1. 在 `projects.json` 中添加要研究的GitHub项目
2. 将项目克隆到 `code/` 目录
3. 在 `notes/{project-name}/` 中记录研究笔记
4. 在 `summary/{topic}/` 中沉淀跨项目比较和总结

执行 `make update` 可一键克隆缺失项目、补全已有浅克隆的历史，并通过 `--ff-only` 更新所有本地项目。此命令通过 HTTPS 拉取，不修改已有远程地址配置，不设置下载超时或低速中断限制；失败后可重新执行，已补全历史的仓库会跳过补全步骤。

执行 `make clone` 可通过 SSH 克隆所有缺失项目，默认获取完整历史；`make clone-one PROJECT=nano-vllm` 可单独克隆一个项目。需要浅克隆时显式指定 `DEPTH=1`。已有仓库会跳过，已有浅克隆可通过 `make pull` 补全历史并更新。

## 浏览笔记站

使用 VitePress 在浏览器中阅读渲染后的 Markdown，支持项目笔记与跨项目总结导航、全文搜索、代码高亮、文章目录和深色模式。

本地启动：

```bash
make install
make dev
```

默认访问 `http://127.0.0.1:5173`。构建静态站点执行 `make build`，预览构建结果执行 `make preview`。使用 `make help` 查看端口覆盖和源码克隆等完整命令。
