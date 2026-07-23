# code-reading

开源项目研究与阅读笔记

## 目录结构

```
├── projects.json    # 研究中的GitHub项目列表
├── code/            # 克隆的项目源码（已忽略）
├── notes/           # 研究笔记
│   └── {project}/   # 每个项目一个文件夹
├── notes-site/      # HTML 知识站生成器
└── html/            # 生成后的静态知识站
```

## 使用方法

1. 在 `projects.json` 中添加要研究的GitHub项目
2. 将项目克隆到 `code/` 目录
3. 在 `notes/{project-name}/` 中记录研究笔记

## 浏览 HTML 知识站

直接打开 [`html/index.html`](html/index.html)，可以按项目和文档浏览全部笔记、搜索正文，并从笔记跳转到带行号的源码视图。

更新 Markdown 后，在 `notes-site/` 目录执行：

```powershell
npm install
npm run build
npm run check
```

更详细的生成规则见 [`notes-site/README.md`](notes-site/README.md)。
