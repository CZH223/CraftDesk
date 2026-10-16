import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { McdrPlugin, McdrRelease, ModrinthHit, ModrinthVersion } from '../shared/types'

/**
 * 扩展下载源。
 *
 * - Modrinth：有正式的 v2 API，直接按文档调用
 * - MCDReforged：官网没有公开 API（/api/* 和 plugins.json 都是 SSR 回退页，
 *   列表页也只在服务端渲染第一页，JS chunk 里也没有接口），
 *   改用官方 PluginCatalogue 仓库 catalogue 分支构建出来的
 *   full-zh_cn.md —— 一份文件就是全部插件，带中文名、中文描述、
 *   已翻译的标签、依赖关系，以及每个版本的直链。
 */

const UA = 'CraftDesk/1.0 (Minecraft server manager)'
const TIMEOUT = 25000

async function getJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function getText(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- Modrinth

export interface ModrinthSearchOptions {
  query: string
  /** mod / plugin / datapack */
  projectType: string
  gameVersion?: string
  /** fabric / forge / neoforge / paper / spigot ... */
  loader?: string
  category?: string
  index?: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'
  limit?: number
  offset?: number
}

export async function searchModrinth(
  opts: ModrinthSearchOptions
): Promise<{ hits: ModrinthHit[]; total: number }> {
  // facets 是数组的数组：外层 AND，内层 OR
  const facets: string[][] = [[`project_type:${opts.projectType}`]]
  if (opts.gameVersion) facets.push([`versions:${opts.gameVersion}`])
  if (opts.loader) facets.push([`categories:${opts.loader}`])
  if (opts.category) facets.push([`categories:${opts.category}`])

  const params = new URLSearchParams({
    query: opts.query || '',
    limit: String(opts.limit ?? 20),
    offset: String(opts.offset ?? 0),
    index: opts.index ?? 'relevance',
    facets: JSON.stringify(facets)
  })

  const data = await getJson<{
    hits: {
      project_id: string
      slug: string
      title: string
      description: string
      author: string
      downloads: number
      follows: number
      categories: string[]
      display_categories?: string[]
      versions: string[]
      icon_url: string | null
      project_type: string
      license: string
      date_modified: string
      server_side?: string
      client_side?: string
    }[]
    total_hits: number
  }>(`https://api.modrinth.com/v2/search?${params}`)

  return {
    total: data.total_hits,
    hits: data.hits.map((h) => ({
      source: 'modrinth' as const,
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      follows: h.follows,
      categories: h.display_categories ?? h.categories,
      gameVersions: h.versions,
      iconUrl: h.icon_url,
      projectType: h.project_type,
      license: h.license,
      updatedAt: h.date_modified,
      serverSide: h.server_side ?? '',
      clientSide: h.client_side ?? ''
    }))
  }
}

/** 拉一个项目的可用版本，按加载器和游戏版本过滤 */
export async function modrinthVersions(
  projectId: string,
  filter: { gameVersion?: string; loader?: string }
): Promise<ModrinthVersion[]> {
  const params = new URLSearchParams()
  if (filter.gameVersion) params.set('game_versions', JSON.stringify([filter.gameVersion]))
  if (filter.loader) params.set('loaders', JSON.stringify([filter.loader]))

  const list = await getJson<
    {
      id: string
      name: string
      version_number: string
      version_type: string
      game_versions: string[]
      loaders: string[]
      date_published: string
      downloads: number
      dependencies: { project_id: string | null; dependency_type: string }[]
      files: {
        url: string
        filename: string
        size: number
        primary: boolean
      }[]
    }[]
  >(`https://api.modrinth.com/v2/project/${projectId}/version?${params}`)

  return list.map((v) => {
    const primary = v.files.find((f) => f.primary) ?? v.files[0]
    return {
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      versionType: v.version_type,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      publishedAt: v.date_published,
      downloads: v.downloads,
      fileName: primary?.filename ?? '',
      fileUrl: primary?.url ?? '',
      fileSize: primary?.size ?? 0,
      requiredDependencies: v.dependencies
        .filter((d) => d.dependency_type === 'required' && d.project_id)
        .map((d) => d.project_id as string)
    }
  })
}

// ---------------------------------------------------------------- MCDReforged

const MCDR_CATALOGUE_URL =
  'https://raw.githubusercontent.com/MCDReforged/PluginCatalogue/catalogue/full-zh_cn.md'
const MCDR_CACHE_TTL = 12 * 60 * 60 * 1000

/** "2.46KB" / "1.2MB" → 字节数 */
function parseSize(text: string): number {
  const m = text.trim().match(/^([\d.]+)\s*(B|KB|MB|GB)?$/i)
  if (!m) return 0
  const n = Number(m[1])
  const unit = (m[2] || 'B').toUpperCase()
  const scale = unit === 'GB' ? 1 << 30 : unit === 'MB' ? 1 << 20 : unit === 'KB' ? 1 << 10 : 1
  return Math.round(n * scale)
}

/** 从 markdown 里抽出 [文本](链接) 形式的条目 */
function parseLinks(line: string): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = []
  const re = /\[([^\]]*)\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push({ text: m[1].trim(), url: m[2].trim() })
  return out
}

/**
 * 解析 full-zh_cn.md。
 *
 * 每个插件是一段 `## {id}` 开头的块，块内用 `### 小节` 分段。
 * 只需要「基本信息」「插件依赖」「下载」三节，介绍那节是整篇 README，
 * 又长又带表格，跳过不解析。
 */
export function parseMcdrCatalogue(md: string): McdrPlugin[] {
  const out: McdrPlugin[] = []
  // 按二级标题切块
  const blocks = md.split(/\n(?=## )/)

  for (const block of blocks) {
    const headMatch = block.match(/^##\s+([A-Za-z0-9_]+)\s*$/m)
    if (!headMatch) continue
    const id = headMatch[1]

    // 再按三级标题切成小节
    const sections = new Map<string, string>()
    const parts = block.split(/\n(?=###\s)/)
    for (const part of parts) {
      const sm = part.match(/^###\s+(.+?)\s*$/m)
      if (sm) sections.set(sm[1].trim(), part)
    }

    const basic = sections.get('基本信息') ?? ''
    const pick = (label: string): string => {
      const m = basic.match(new RegExp(`^-\\s*${label}\\s*[:：]\\s*(.+)$`, 'm'))
      return m ? m[1].trim() : ''
    }

    // README 正文里也有 ## 小标题，只有块内声明的插件 ID 与标题一致才算真插件
    const declaredId = pick('插件 ID').replace(/[`*]/g, '').trim()
    if (declaredId && declaredId !== id) continue
    if (!basic.includes('插件 ID')) continue

    const name = pick('插件名')
    const version = pick('版本')
    const downloadsRaw = pick('总下载量')
    const repository = pick('仓库')
    const description = pick('描述')

    const authors = parseLinks(pick('作者'))
      .map((a) => a.text)
      .filter(Boolean)
    const labels = parseLinks(pick('标签'))
      .map((l) => l.text.replace(/[`*]/g, ''))
      .filter(Boolean)

    // 插件依赖：表格里第一列是插件 id
    const dependencies: { id: string; requirement: string }[] = []
    const depSection = sections.get('插件依赖') ?? ''
    for (const line of depSection.split('\n')) {
      const cells = line.split('|').map((c) => c.trim())
      // | a | b | 会切成 ['', 'a', 'b', '']
      if (cells.length < 4) continue
      const depLinks = parseLinks(cells[1])
      const depId = (depLinks[0]?.text ?? cells[1]).replace(/[`*]/g, '').trim()
      if (!depId || depId === '插件 ID' || /^-+$/.test(depId)) continue
      dependencies.push({ id: depId, requirement: cells[2].trim() })
    }

    // 下载表：文件名 | 版本 | 时间 | 大小 | 下载数 | [下载](直链)
    const releases: McdrRelease[] = []
    const dlSection = sections.get('下载') ?? ''
    for (const line of dlSection.split('\n')) {
      if (!line.startsWith('|')) continue
      const cells = line.split('|').map((c) => c.trim())
      if (cells.length < 7) continue

      const fileLinks = parseLinks(cells[1])
      const fileName = fileLinks[0]?.text ?? cells[1]
      const ver = cells[2]
      if (!fileName || fileName === '文件' || /^-+$/.test(fileName)) continue

      // 最后一列是 [下载](直链)
      const actionLinks = parseLinks(cells[6])
      const url = actionLinks.find((l) => l.text === '下载')?.url ?? actionLinks[0]?.url ?? ''
      if (!url) continue

      releases.push({
        version: ver,
        fileName,
        size: parseSize(cells[4]),
        downloads: Number(cells[5].replace(/[^\d]/g, '')) || 0,
        uploadedAt: cells[3],
        url
      })
    }

    out.push({
      source: 'mcdr' as const,
      id,
      name: name || id,
      version,
      authors,
      description,
      labels,
      downloads: downloadsRaw ? Number(downloadsRaw.replace(/[^\d]/g, '')) || undefined : undefined,
      repository,
      dependencies,
      releases
    })
  }

  return out
}

interface McdrCache {
  fetchedAt: number
  plugins: McdrPlugin[]
}

/** 拉 MCDR 插件目录，带磁盘缓存（这份文件将近 1 MB，没必要每次开界面都拉） */
export async function listMcdrPlugins(cacheDir: string, force = false): Promise<McdrPlugin[]> {
  const file = join(cacheDir, 'mcdr-catalogue.json')

  if (!force) {
    try {
      const cached = JSON.parse(await fs.readFile(file, 'utf-8')) as McdrCache
      if (Date.now() - cached.fetchedAt < MCDR_CACHE_TTL && cached.plugins?.length) {
        return cached.plugins
      }
    } catch {
      /* 没有缓存或缓存损坏，重新拉 */
    }
  }

  const md = await getText(MCDR_CATALOGUE_URL)
  const plugins = parseMcdrCatalogue(md)
  if (!plugins.length) throw new Error('MCDReforged 插件目录解析为空，上游格式可能变了')

  try {
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ fetchedAt: Date.now(), plugins } satisfies McdrCache),
      'utf-8'
    )
  } catch {
    /* 缓存写不进去不影响使用 */
  }

  return plugins
}

/**
 * 兜底：目录里没有列出发布信息的插件（比如 MirrorServerReforged），
 * 直接查它自己的 GitHub Releases。GitHub 未认证接口每小时 60 次，
 * 只在用户点安装时调用，正常使用够用。
 */
export async function mcdrReleasesFromGithub(repository: string): Promise<McdrRelease[]> {
  const m = repository.match(/github\.com\/([^/]+)\/([^/#?]+)/i)
  if (!m) throw new Error('这个插件没有提供 GitHub 仓库地址，需要手动安装')
  const repo = m[2].replace(/\.git$/, '')

  const list = await getJson<
    {
      tag_name: string
      published_at: string
      draft: boolean
      assets: { name: string; browser_download_url: string; size: number; download_count: number }[]
    }[]
  >(`https://api.github.com/repos/${m[1]}/${repo}/releases?per_page=15`)

  return list
    .filter((r) => !r.draft)
    .map((r) => {
      // MCDR 只认 .mcdr 和 .pyz 两种包
      const asset =
        r.assets.find((a) => a.name.endsWith('.mcdr')) ??
        r.assets.find((a) => a.name.endsWith('.pyz'))
      return {
        version: r.tag_name,
        fileName: asset?.name ?? '',
        size: asset?.size ?? 0,
        downloads: asset?.download_count ?? 0,
        uploadedAt: r.published_at,
        url: asset?.browser_download_url ?? ''
      }
    })
    .filter((r) => r.url)
}
