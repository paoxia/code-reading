import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import GithubSlugger from "github-slugger";
import hljs from "highlight.js";
import { Marked } from "marked";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const notesRoot = path.join(repoRoot, "notes");
const codeRoot = path.join(repoRoot, "code");
const outputRoot = path.join(repoRoot, "html");
const assetsRoot = path.join(scriptDir, "assets");

const toPosix = (value) => value.split(path.sep).join("/");
const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const escapeAttribute = escapeHtml;
const canonicalPath = (value) =>
  process.platform === "win32"
    ? path.normalize(value).toLowerCase()
    : path.normalize(value);
const isInside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const stripHtml = (value = "") =>
  String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const stripMarkdown = (value = "") =>
  value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const firstParagraph = (markdown) => {
  const body = markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#.+$/gm, "")
    .split(/\n\s*\n/)
    .map(stripMarkdown)
    .find((part) => part.length > 24);
  return body ? `${body.slice(0, 168)}${body.length > 168 ? "…" : ""}` : "";
};
const extractTitle = (markdown, fallback) => {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? stripMarkdown(match[1]) : fallback;
};
const languageAliases = {
  bat: "dos",
  shell: "bash",
  sh: "bash",
  ts: "typescript",
  js: "javascript",
  md: "markdown",
  yml: "yaml",
  vue: "html",
  xml: "xml",
};
const extensionLanguages = {
  ".bat": "dos",
  ".css": "css",
  ".go": "go",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mjs": "javascript",
  ".py": "python",
  ".sh": "bash",
  ".toml": "ini",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "html",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

async function walk(root, predicate = () => true) {
  const result = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (predicate(fullPath)) {
        result.push(fullPath);
      }
    }
  }
  await visit(root);
  return result;
}

const projectConfig = JSON.parse(
  await fs.readFile(path.join(repoRoot, "projects.json"), "utf8"),
);
const markdownFiles = await walk(notesRoot, (file) =>
  file.toLowerCase().endsWith(".md"),
);

const notes = [];
for (const absolutePath of markdownFiles) {
  const relativeToNotes = toPosix(path.relative(notesRoot, absolutePath));
  const [projectName] = relativeToNotes.split("/");
  const sourceName = path.basename(absolutePath, ".md");
  const markdown = await fs.readFile(absolutePath, "utf8");
  const outputName =
    sourceName.toLowerCase() === "readme" ? "index.html" : `${sourceName}.html`;
  notes.push({
    absolutePath,
    key: canonicalPath(absolutePath),
    projectName,
    relativeToNotes,
    markdown,
    title: extractTitle(markdown, sourceName),
    description: firstParagraph(markdown),
    outputRelative: `projects/${projectName}/${outputName}`,
    headings: [],
    html: "",
  });
}

const noteByPath = new Map(notes.map((note) => [note.key, note]));
const configuredProjects = projectConfig.projects ?? [];
const configuredGroups = projectConfig.groups ?? [];
const configuredByName = new Map(
  configuredProjects.map((project) => [project.name, project]),
);
const encounteredNames = [...new Set(notes.map((note) => note.projectName))];
const orderedProjectNames = [
  ...configuredProjects
    .map((project) => project.name)
    .filter((name) => encounteredNames.includes(name)),
  ...encounteredNames.filter((name) => !configuredByName.has(name)).sort(),
];
const projects = orderedProjectNames.map((name) => {
  const docs = notes
    .filter((note) => note.projectName === name)
    .sort((a, b) => {
      const aReadme = path.basename(a.absolutePath).toLowerCase() === "readme.md";
      const bReadme = path.basename(b.absolutePath).toLowerCase() === "readme.md";
      if (aReadme !== bReadme) return aReadme ? -1 : 1;
      return a.title.localeCompare(b.title, "zh-CN");
    });
  const configured = configuredByName.get(name) ?? {};
  return {
    name,
    label: configured.name ?? name,
    description:
      configured.description ?? docs[0]?.description ?? "源码阅读学习笔记",
    repo: configured.repo ?? "",
    status: configured.status ?? "",
    group: configured.group ?? "other",
    docs,
    home: docs[0]?.outputRelative,
  };
});
const projectByName = new Map(projects.map((project) => [project.name, project]));
const configuredGroupById = new Map(
  configuredGroups.map((group) => [group.id, group]),
);
const projectGroupIds = [...new Set(projects.map((project) => project.group))];
const orderedProjectGroupIds = [
  ...configuredGroups
    .map((group) => group.id)
    .filter((id) => projectGroupIds.includes(id)),
  ...projectGroupIds.filter((id) => !configuredGroupById.has(id)).sort(),
];
const projectGroups = orderedProjectGroupIds.map((id) => {
  const configured = configuredGroupById.get(id) ?? {};
  return {
    id,
    label: configured.label ?? (id === "other" ? "其他项目" : id),
    description: configured.description ?? "尚未归入预设分类的项目",
    projects: projects.filter((project) => project.group === id),
  };
});

const sourceFiles = new Map();
const sourceDirectories = new Map();
const copiedAssets = new Map();
const brokenLinks = [];

function relativeHref(fromOutput, targetOutput, hash = "") {
  let relative = toPosix(
    path.posix.relative(path.posix.dirname(fromOutput), targetOutput),
  );
  if (!relative) relative = path.posix.basename(targetOutput);
  return `${encodeURI(relative)}${hash}`;
}

function sourceOutputRelative(absolutePath, isDirectory) {
  const repoRelative = toPosix(path.relative(repoRoot, absolutePath));
  return isDirectory
    ? `source/${repoRelative}/index.html`
    : `source/${repoRelative}.html`;
}

function normalizeSourceHash(hash) {
  const match = hash.match(/^#L(\d+)(?:-L?\d+)?$/i);
  return match ? `#L${match[1]}` : hash;
}

function splitHref(href) {
  const hashIndex = href.indexOf("#");
  return hashIndex < 0
    ? { pathname: href, hash: "" }
    : { pathname: href.slice(0, hashIndex), hash: href.slice(hashIndex) };
}

function rewriteLocalHref(note, rawHref, isImage = false) {
  if (!rawHref) return { href: rawHref, external: false };
  if (
    rawHref.startsWith("#") ||
    /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(rawHref)
  ) {
    return {
      href: rawHref,
      external: /^https?:/i.test(rawHref),
    };
  }

  const { pathname: rawPathname, hash } = splitHref(rawHref);
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(rawPathname);
  } catch {
    decodedPathname = rawPathname;
  }
  const absoluteTarget = path.resolve(path.dirname(note.absolutePath), decodedPathname);

  if (isInside(notesRoot, absoluteTarget)) {
    const targetNote = noteByPath.get(canonicalPath(absoluteTarget));
    if (targetNote) {
      return {
        href: relativeHref(note.outputRelative, targetNote.outputRelative, hash),
        external: false,
      };
    }

    if (fsSync.existsSync(absoluteTarget) && fsSync.statSync(absoluteTarget).isFile()) {
      const repoRelative = toPosix(path.relative(repoRoot, absoluteTarget));
      const targetOutput = `media/${repoRelative}`;
      copiedAssets.set(canonicalPath(absoluteTarget), {
        absolutePath: absoluteTarget,
        outputRelative: targetOutput,
      });
      return {
        href: relativeHref(note.outputRelative, targetOutput, hash),
        external: false,
      };
    }
  }

  if (isInside(codeRoot, absoluteTarget) && fsSync.existsSync(absoluteTarget)) {
    const stat = fsSync.statSync(absoluteTarget);
    if (stat.isDirectory()) {
      const outputRelative = sourceOutputRelative(absoluteTarget, true);
      sourceDirectories.set(canonicalPath(absoluteTarget), {
        absolutePath: absoluteTarget,
        outputRelative,
        projectName: toPosix(path.relative(codeRoot, absoluteTarget)).split("/")[0],
      });
      return {
        href: relativeHref(note.outputRelative, outputRelative, normalizeSourceHash(hash)),
        external: false,
      };
    }
    if (stat.isFile()) {
      const outputRelative = sourceOutputRelative(absoluteTarget, false);
      sourceFiles.set(canonicalPath(absoluteTarget), {
        absolutePath: absoluteTarget,
        outputRelative,
        projectName: toPosix(path.relative(codeRoot, absoluteTarget)).split("/")[0],
      });
      return {
        href: relativeHref(note.outputRelative, outputRelative, normalizeSourceHash(hash)),
        external: false,
      };
    }
  }

  if (!isImage && /\.(?:md|java|go|py|ts|tsx|js|vue|ya?ml|json|xml)$/i.test(decodedPathname)) {
    brokenLinks.push({
      note: note.relativeToNotes,
      href: rawHref,
      resolved: toPosix(path.relative(repoRoot, absoluteTarget)),
    });
  }
  return { href: rawHref, external: false };
}

function highlightCode(text, language) {
  const requested = (language ?? "").trim().split(/\s+/)[0].toLowerCase();
  const normalized = languageAliases[requested] ?? requested;
  if (normalized && hljs.getLanguage(normalized)) {
    return {
      html: hljs.highlight(text, { language: normalized }).value,
      label: requested,
    };
  }
  return { html: escapeHtml(text), label: requested || "text" };
}

function renderMarkdown(note) {
  const slugger = new GithubSlugger();
  const headings = [];
  const renderer = {
    heading({ tokens, depth }) {
      const content = this.parser.parseInline(tokens);
      const id = slugger.slug(stripHtml(content));
      if (depth <= 3) {
        headings.push({ depth, id, text: stripHtml(content) });
      }
      return `<h${depth} id="${escapeAttribute(id)}"><a class="heading-anchor" href="#${escapeAttribute(id)}" aria-label="定位到本节">${content}</a></h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const content = this.parser.parseInline(tokens);
      const rewritten = rewriteLocalHref(note, href, false);
      const titleAttribute = title
        ? ` title="${escapeAttribute(title)}"`
        : "";
      const externalAttributes = rewritten.external
        ? ' target="_blank" rel="noreferrer"'
        : "";
      return `<a href="${escapeAttribute(rewritten.href)}"${titleAttribute}${externalAttributes}>${content}</a>`;
    },
    image({ href, title, text }) {
      const rewritten = rewriteLocalHref(note, href, true);
      const titleAttribute = title
        ? ` title="${escapeAttribute(title)}"`
        : "";
      return `<img src="${escapeAttribute(rewritten.href)}" alt="${escapeAttribute(text)}"${titleAttribute} loading="lazy">`;
    },
    code({ text, lang }) {
      const highlighted = highlightCode(text, lang);
      return `<div class="code-block"><div class="code-toolbar"><span>${escapeHtml(highlighted.label)}</span><button class="copy-code" type="button">复制</button></div><pre><code class="hljs language-${escapeAttribute(highlighted.label)}">${highlighted.html}</code></pre></div>\n`;
    },
  };
  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer,
  });
  note.html = marked
    .parse(note.markdown)
    .replaceAll("<table>", '<div class="table-wrap"><table>')
    .replaceAll("</table>", "</table></div>");
  note.headings = headings;
}

for (const note of notes) renderMarkdown(note);

function projectNavigation(currentOutput, currentProjectName, currentNoteOutput) {
  return projectGroups
    .map((group) => {
      const items = group.projects
        .map((project) => {
          const projectHref = relativeHref(currentOutput, project.home);
          const isProjectActive = project.name === currentProjectName;
          const docs = isProjectActive
            ? `<div class="project-docs">${project.docs
                .map((doc) => {
                  const active = doc.outputRelative === currentNoteOutput;
                  return `<a class="doc-link${active ? " is-active" : ""}" href="${relativeHref(currentOutput, doc.outputRelative)}"${active ? ' aria-current="page"' : ""}>${escapeHtml(doc.title)}</a>`;
                })
                .join("")}</div>`
            : "";
          return `<div class="project-nav-item"><a class="project-link${isProjectActive ? " is-active" : ""}" href="${projectHref}"><span>${escapeHtml(project.label)}</span><span class="nav-count">${project.docs.length}</span></a>${docs}</div>`;
        })
        .join("");
      return `<section class="project-nav-group">
        <div class="project-nav-group-heading"><span>${escapeHtml(group.label)}</span><span>${group.projects.length}</span></div>
        ${items}
      </section>`;
    })
    .join("");
}

function tableOfContents(headings) {
  const visible = headings.filter((heading) => heading.depth >= 2 && heading.depth <= 3);
  if (!visible.length) {
    return `<p class="toc-empty">本页暂无二、三级标题</p>`;
  }
  return visible
    .map(
      (heading) =>
        `<a class="toc-link depth-${heading.depth}" href="#${escapeAttribute(heading.id)}">${escapeHtml(heading.text)}</a>`,
    )
    .join("");
}

function siteRootFor(outputRelative) {
  const relative = toPosix(
    path.posix.relative(path.posix.dirname(outputRelative), "."),
  );
  return relative ? `${relative}/` : "./";
}

function pageTemplate({
  outputRelative,
  title,
  description,
  currentProjectName = "",
  currentNoteOutput = "",
  headings = [],
  breadcrumbs = [],
  content,
  pageKind = "note",
}) {
  const root = siteRootFor(outputRelative);
  const breadcrumbHtml = breadcrumbs
    .map((item, index) => {
      const isLast = index === breadcrumbs.length - 1;
      if (isLast || !item.href) return `<span>${escapeHtml(item.label)}</span>`;
      return `<a href="${relativeHref(outputRelative, item.href)}">${escapeHtml(item.label)}</a>`;
    })
    .join('<span class="breadcrumb-separator">/</span>');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeAttribute(description)}">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)} · Code Reading Notes</title>
  <link rel="stylesheet" href="${root}assets/styles.css">
  <script defer src="${root}assets/search-data.js"></script>
  <script defer src="${root}assets/app.js"></script>
</head>
<body data-site-root="${escapeAttribute(root)}" data-page-kind="${escapeAttribute(pageKind)}">
  <a class="skip-link" href="#main-content">跳到正文</a>
  <header class="topbar">
    <button class="icon-button mobile-menu-button" type="button" aria-label="打开导航" data-mobile-menu>
      <span></span><span></span><span></span>
    </button>
    <a class="brand" href="${root}index.html">
      <span class="brand-mark">&lt;/&gt;</span>
      <span><strong>Code Reading</strong><small>源码学习笔记</small></span>
    </a>
    <div class="topbar-actions">
      <button class="search-trigger" type="button" data-search-open>
        <span>搜索所有笔记</span><kbd>Ctrl K</kbd>
      </button>
      <button class="icon-button theme-button" type="button" aria-label="切换主题" data-theme-toggle>
        <span class="theme-icon">◐</span>
      </button>
    </div>
  </header>

  <div class="site-layout">
    <aside class="sidebar" data-sidebar>
      <div class="sidebar-heading">项目导航</div>
      <nav aria-label="项目和文档">${projectNavigation(outputRelative, currentProjectName, currentNoteOutput)}</nav>
      <div class="sidebar-footer">
        <span>${projects.length} 个项目</span><span>${notes.length} 篇笔记</span>
      </div>
    </aside>
    <div class="sidebar-backdrop" data-sidebar-backdrop></div>

    <main class="main-column" id="main-content">
      <nav class="breadcrumbs" aria-label="面包屑">
        <a href="${root}index.html">首页</a>
        ${breadcrumbs.length ? `<span class="breadcrumb-separator">/</span>${breadcrumbHtml}` : ""}
      </nav>
      ${content}
      <footer class="page-footer">
        <span>由 <code>notes-site/build.mjs</code> 从 Markdown 自动生成</span>
        <a href="${root}index.html">返回知识站首页</a>
      </footer>
    </main>

    <aside class="toc-panel" aria-label="本页目录">
      <div class="toc-title">本页目录</div>
      <nav>${tableOfContents(headings)}</nav>
    </aside>
  </div>

  <dialog class="search-dialog" data-search-dialog>
    <div class="search-box">
      <div class="search-input-row">
        <span>⌕</span>
        <input type="search" placeholder="搜索项目、标题、章节或正文…" autocomplete="off" data-search-input>
        <button type="button" data-search-close aria-label="关闭搜索">Esc</button>
      </div>
      <div class="search-results" data-search-results>
        <p class="search-hint">输入关键词搜索全部 ${notes.length} 篇笔记</p>
      </div>
    </div>
  </dialog>
</body>
</html>`;
}

function notePage(note) {
  const project = projectByName.get(note.projectName);
  const lead = `<header class="article-header">
    <div class="eyebrow">${escapeHtml(project.label)} · 源码阅读</div>
    <h1>${escapeHtml(note.title)}</h1>
    ${note.description ? `<p>${escapeHtml(note.description)}</p>` : ""}
  </header>`;
  return pageTemplate({
    outputRelative: note.outputRelative,
    title: note.title,
    description: note.description || `${project.label} 源码阅读笔记`,
    currentProjectName: note.projectName,
    currentNoteOutput: note.outputRelative,
    headings: note.headings,
    breadcrumbs: [
      { label: project.label, href: project.home },
      { label: note.title },
    ],
    content: `<article class="article">${lead}<div class="markdown-body">${note.html}</div></article>`,
  });
}

function homePage() {
  const totalWords = notes.reduce(
    (sum, note) => sum + stripMarkdown(note.markdown).length,
    0,
  );
  const projectIndex = new Map(
    projects.map((project, index) => [project.name, index]),
  );
  const groupedCards = projectGroups
    .map((group) => {
      const cards = group.projects
        .map((project) => {
          const index = projectIndex.get(project.name) ?? 0;
          const accent = ["violet", "blue", "green", "amber"][index % 4];
          const docLinks = project.docs
            .slice(0, 4)
            .map(
              (doc) =>
                `<a href="${doc.outputRelative}"><span>${escapeHtml(doc.title)}</span><span>→</span></a>`,
            )
            .join("");
          const remaining =
            project.docs.length > 4
              ? `<span class="more-docs">另有 ${project.docs.length - 4} 篇笔记</span>`
              : "";
          return `<section class="project-card accent-${accent}">
            <div class="project-card-top">
              <span class="project-index">${String(index + 1).padStart(2, "0")}</span>
              <span class="project-count">${project.docs.length} 篇</span>
            </div>
            <h2><a href="${project.home}">${escapeHtml(project.label)}</a></h2>
            <p>${escapeHtml(project.description)}</p>
            <div class="project-card-links">${docLinks}${remaining}</div>
          </section>`;
        })
        .join("");
      return `<section class="project-group" id="group-${escapeAttribute(group.id)}">
        <header class="project-group-heading">
          <div><span>${escapeHtml(group.label)}</span><strong>${group.projects.length} 个项目</strong></div>
          <p>${escapeHtml(group.description)}</p>
        </header>
        <div class="project-grid">${cards}</div>
      </section>`;
    })
    .join("");
  const content = `<section class="home-hero">
      <div class="hero-copy">
        <div class="eyebrow">LOCAL KNOWLEDGE BASE</div>
        <h1>把源码读懂，<br><span>把脉络留下。</span></h1>
        <p>汇总 <code>notes/</code> 下的中文源码分析，支持项目导航、章节定位、全文搜索和源码引用跳转。</p>
        <button class="primary-search" type="button" data-search-open>开始搜索 <span>Ctrl K</span></button>
      </div>
      <div class="hero-stats">
        <div><strong>${projects.length}</strong><span>研究项目</span></div>
        <div><strong>${notes.length}</strong><span>篇笔记</span></div>
        <div><strong>${Math.max(1, Math.round(totalWords / 10000))}w+</strong><span>中文内容</span></div>
      </div>
    </section>
    <section class="project-section">
      <div class="section-heading"><div><span>PROJECT GROUPS</span><h2>按领域浏览</h2></div><p>先选择项目类型，再沿整体架构、调用链和核心抽象深入源码。</p></div>
      <div class="project-groups">${groupedCards}</div>
    </section>`;
  return pageTemplate({
    outputRelative: "index.html",
    title: "源码学习笔记",
    description: "开源项目源码阅读与中文学习笔记知识站",
    content,
    pageKind: "home",
  });
}

function sourceBreadcrumbs(source, displayPath) {
  const project = projectByName.get(source.projectName);
  return [
    project
      ? { label: project.label, href: project.home }
      : { label: source.projectName },
    { label: "源码" },
    { label: displayPath },
  ];
}

async function sourceFilePage(source) {
  const sourceText = await fs.readFile(source.absolutePath, "utf8");
  const repoRelative = toPosix(path.relative(repoRoot, source.absolutePath));
  const projectRelative = toPosix(path.relative(path.join(codeRoot, source.projectName), source.absolutePath));
  const extension = path.extname(source.absolutePath).toLowerCase();
  const language = extensionLanguages[extension] ?? "";
  const highlighted = highlightCode(sourceText, language);
  const lines = highlighted.html.split("\n");
  const codeLines = lines
    .map(
      (line, index) =>
        `<span class="source-line" id="L${index + 1}"><a class="line-number" href="#L${index + 1}" aria-label="第 ${index + 1} 行">${index + 1}</a><span class="line-code">${line || " "}</span></span>`,
    )
    .join("\n");
  const content = `<article class="article source-article">
    <header class="article-header source-header">
      <div class="eyebrow">SOURCE VIEWER · ${escapeHtml(source.projectName)}</div>
      <h1>${escapeHtml(path.basename(source.absolutePath))}</h1>
      <p class="source-path">${escapeHtml(projectRelative)}</p>
    </header>
    <div class="source-toolbar">
      <span>${lines.length} 行</span>
      <span>${escapeHtml(language || "text")}</span>
      <button class="copy-source-path" type="button" data-copy-text="${escapeAttribute(repoRelative)}">复制仓库相对路径</button>
    </div>
    <pre class="source-view"><code class="hljs">${codeLines}</code></pre>
  </article>`;
  return pageTemplate({
    outputRelative: source.outputRelative,
    title: path.basename(source.absolutePath),
    description: `${repoRelative} 源码查看`,
    currentProjectName: source.projectName,
    headings: [],
    breadcrumbs: sourceBreadcrumbs(source, projectRelative),
    content,
    pageKind: "source",
  });
}

async function sourceDirectoryPage(source) {
  const repoRelative = toPosix(path.relative(repoRoot, source.absolutePath));
  const projectRelative = toPosix(path.relative(path.join(codeRoot, source.projectName), source.absolutePath));
  const referenced = [...sourceFiles.values()]
    .filter((item) => isInside(source.absolutePath, item.absolutePath))
    .sort((a, b) => a.absolutePath.localeCompare(b.absolutePath))
    .map((item) => {
      const relative = toPosix(path.relative(source.absolutePath, item.absolutePath));
      return `<a class="directory-file" href="${relativeHref(source.outputRelative, item.outputRelative)}"><span class="file-icon">&lt;/&gt;</span><span>${escapeHtml(relative)}</span><span>→</span></a>`;
    })
    .join("");
  const content = `<article class="article source-article">
    <header class="article-header source-header">
      <div class="eyebrow">SOURCE DIRECTORY · ${escapeHtml(source.projectName)}</div>
      <h1>${escapeHtml(path.basename(source.absolutePath))}</h1>
      <p class="source-path">${escapeHtml(projectRelative || source.projectName)}</p>
    </header>
    <div class="directory-panel">
      <div class="directory-title"><strong>笔记引用的源码文件</strong><span>${referenced ? "点击文件进入带行号的源码视图" : "当前笔记只引用了该目录"}</span></div>
      <div class="directory-list">${referenced || '<p class="empty-state">这个目录下暂无被笔记单独引用的文件。</p>'}</div>
    </div>
  </article>`;
  return pageTemplate({
    outputRelative: source.outputRelative,
    title: `${path.basename(source.absolutePath)} 目录`,
    description: `${repoRelative} 源码目录`,
    currentProjectName: source.projectName,
    headings: [],
    breadcrumbs: sourceBreadcrumbs(source, projectRelative),
    content,
    pageKind: "source-directory",
  });
}

function safeSearchJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true });
await fs.cp(assetsRoot, path.join(outputRoot, "assets"), { recursive: true });

await fs.writeFile(path.join(outputRoot, "index.html"), homePage(), "utf8");
for (const note of notes) {
  const outputPath = path.join(outputRoot, ...note.outputRelative.split("/"));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, notePage(note), "utf8");
}
for (const source of sourceFiles.values()) {
  const outputPath = path.join(outputRoot, ...source.outputRelative.split("/"));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, await sourceFilePage(source), "utf8");
}
for (const source of sourceDirectories.values()) {
  const outputPath = path.join(outputRoot, ...source.outputRelative.split("/"));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, await sourceDirectoryPage(source), "utf8");
}
for (const asset of copiedAssets.values()) {
  const outputPath = path.join(outputRoot, ...asset.outputRelative.split("/"));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(asset.absolutePath, outputPath);
}

const searchData = notes.map((note) => ({
  project: projectByName.get(note.projectName)?.label ?? note.projectName,
  title: note.title,
  description: note.description,
  url: note.outputRelative,
  headings: note.headings
    .filter((heading) => heading.depth >= 2 && heading.depth <= 3)
    .map(({ text, id }) => ({ text, id })),
  text: stripMarkdown(note.markdown).slice(0, 12000),
}));
await fs.writeFile(
  path.join(outputRoot, "assets", "search-data.js"),
  `window.__NOTES_SEARCH__ = ${safeSearchJson(searchData)};\n`,
  "utf8",
);

const manifest = {
  generatedAt: new Date().toISOString(),
  projects: projects.length,
  notes: notes.length,
  sourceFiles: sourceFiles.size,
  sourceDirectories: sourceDirectories.size,
  copiedAssets: copiedAssets.size,
};
await fs.writeFile(
  path.join(outputRoot, "site-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

if (brokenLinks.length) {
  console.warn(`发现 ${brokenLinks.length} 个疑似失效的源码/笔记链接：`);
  for (const item of brokenLinks) {
    console.warn(`- ${item.note}: ${item.href} -> ${item.resolved}`);
  }
}
console.log(
  `站点生成完成：${projects.length} 个项目，${notes.length} 篇笔记，${sourceFiles.size} 个源码页，${sourceDirectories.size} 个源码目录页。`,
);
