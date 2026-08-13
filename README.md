# code-reading

开源项目研究与阅读笔记

## 目录结构

```
├── projects.json    # 研究中的GitHub项目列表
├── code/            # 克隆的项目源码（已忽略）
├── notes/           # 研究笔记
│   └── {project}/   # 每个项目一个文件夹
├── .vitepress/      # VitePress 配置与主题
├── package.json     # 笔记站依赖与本地命令
└── html/            # 生成后的静态知识站
```

## 使用方法

1. 在 `projects.json` 中添加要研究的GitHub项目
2. 将项目克隆到 `code/` 目录
3. 在 `notes/{project-name}/` 中记录研究笔记

## 浏览笔记站

使用 VitePress 在浏览器中阅读渲染后的 Markdown，支持项目导航、全文搜索、代码高亮、文章目录和深色模式。

本地启动：

```bash
make install
make dev
```

默认访问 `http://127.0.0.1:5173`。构建静态站点执行 `make build`，预览构建结果执行 `make preview`。使用 `make help` 查看端口覆盖和源码克隆等完整命令。
