import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type DefaultTheme } from 'vitepress'

const siteDir = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const repoDir = path.resolve(siteDir, '..')
const notesDir = path.join(repoDir, 'notes')
const catalog = JSON.parse(
  fs.readFileSync(path.join(repoDir, 'projects.json'), 'utf8'),
) as {
  groups: Array<{ id: string; label: string }>
  projects: Array<{ name: string; group: string; repo: string; notes?: string }>
}

function titleOf(file: string, fallback: string) {
  const source = fs.readFileSync(file, 'utf8')
  return source.match(/^#\s+(.+)$/m)?.[1].replace(/`/g, '') ?? fallback
}

function projectItems(project: string): DefaultTheme.SidebarItem[] {
  const dir = path.join(notesDir, project)
  if (!fs.existsSync(dir)) return []

  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => {
      if (a === 'README.md') return -1
      if (b === 'README.md') return 1
      return a.localeCompare(b, 'zh-CN')
    })
    .map((name) => ({
      text: titleOf(path.join(dir, name), name.replace(/\.md$/, '')),
      link: name === 'README.md'
        ? `/${project}/`
        : `/${project}/${name.replace(/\.md$/, '')}`,
    }))
}

const availableProjects = catalog.projects.filter((project) =>
  fs.existsSync(path.join(notesDir, project.name)),
)

const sidebar = Object.fromEntries(availableProjects.map((project) => [
  `/${project.name}/`,
  [{
    text: project.name,
    collapsed: false,
    items: projectItems(project.name),
  }],
]))

const groupMenu: DefaultTheme.NavItemWithChildren[] = catalog.groups.map((group) => ({
  text: group.label,
  items: availableProjects
    .filter((project) => project.group === group.id)
    .map((project) => ({ text: project.name, link: `/${project.name}/` })),
})).filter((group) => group.items.length > 0)

const rewrites = Object.fromEntries(availableProjects.map((project) => [
  `${project.name}/README.md`,
  `${project.name}/index.md`,
]))

const projectByName = new Map(catalog.projects.map((project) => [project.name, project]))

function configureMarkdown(md: any) {
  const defaultLinkOpen = md.renderer.rules.link_open
    ?? ((tokens: any[], index: number, options: any, env: any, self: any) =>
      self.renderToken(tokens, index, options))

  md.renderer.rules.link_open = (tokens: any[], index: number, options: any, env: any, self: any) => {
    const token = tokens[index]
    const hrefIndex = token.attrIndex('href')
    const href = hrefIndex >= 0 ? token.attrs[hrefIndex][1] : ''
    const match = href.match(/^(?:\.\/)?\.\.\/\.\.\/code\/([^/]+)\/?(.*)$/)

    if (match) {
      const [, projectName, sourcePath] = match
      const project = projectByName.get(projectName)
      if (project) {
        const localPath = path.join(repoDir, 'code', projectName, sourcePath)
        const kind = sourcePath && fs.existsSync(localPath) && fs.statSync(localPath).isFile()
          ? 'blob'
          : 'tree'
        token.attrs[hrefIndex][1] = `${project.repo.replace(/\.git$/, '')}/${kind}/HEAD/${sourcePath}`
      }
    }

    return defaultLinkOpen(tokens, index, options, env, self)
  }
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'Code Reading',
  description: '开源项目源码阅读与中文学习笔记',
  srcDir: 'notes',
  outDir: 'html',
  cleanUrls: true,
  rewrites,
  lastUpdated: true,
  vite: {
    // 显式固定 Vue SSR 依赖，避免 Markdown 位于自定义 srcDir 时解析到错误位置。
    resolve: {
      alias: [
        { find: /^vue$/, replacement: require.resolve('vue') },
        { find: /^vue\/server-renderer$/, replacement: require.resolve('@vue/server-renderer') },
      ],
    },
  },
  markdown: {
    lineNumbers: true,
    config: configureMarkdown,
  },
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: '首页', link: '/' },
      { text: '项目笔记', items: groupMenu },
      { text: 'GitHub', link: 'https://github.com/paoxia/code-reading' },
    ],
    sidebar,
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '最后更新' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '没有找到相关内容',
            resetButtonTitle: '清除查询',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },
    socialLinks: [],
  },
})
