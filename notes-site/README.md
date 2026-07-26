# Notes HTML 知识站

这个目录保存 `notes/` 的静态站点生成器。生成结果位于仓库根目录的 `html/`，不依赖后端服务，可以直接双击 `html/index.html` 浏览。

## 构建和检查

```powershell
cd notes-site
npm install
npm run build
npm run check
```

- `npm run build`：清空并重新生成 `html/`。
- `npm run check`：检查生成页面中的本地文件、资源和锚点链接。

## 生成规则

- `notes/{project}/README.md` 生成到 `html/projects/{project}/index.html`。
- 同一项目的其他 Markdown 文件生成到 `html/projects/{project}/{name}.html`。
- Markdown 笔记之间的相对链接会改写为对应的 HTML 链接。
- 指向 `code/` 中源码文件的链接会生成带语法高亮和行号的源码查看页。
- 指向 `code/` 中目录的链接会生成目录页，汇总该目录下被笔记引用的源码文件。
- 笔记中引用的本地图片等资源会复制到 `html/media/`。
- 首页项目分组、项目顺序、说明和仓库地址来自 `projects.json`。
- `projects.json` 的 `groups` 定义分组顺序和文案；每个项目通过 `group` 引用分组。
  没有配置或引用未知分组的项目会进入兜底分组，不影响旧项目展示。

## 站点能力

- 全局项目导航和项目内文档导航。
- 二、三级标题目录与滚动定位。
- 全文搜索，快捷键为 `Ctrl+K` 或 `⌘K`。
- 浅色/深色主题和移动端布局。
- 代码块复制、源码相对路径复制和源码行号锚点。

`html/` 是生成结果，不应手工修改；需要改变页面结构或样式时，修改 `build.mjs` 或 `assets/` 后重新构建。
