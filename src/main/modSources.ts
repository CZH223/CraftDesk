import type {
  McmodDownloadFile,
  McmodExternalLink,
  RegistryVersion,
  ServerKind
} from '../shared/types'
import { httpFetch } from './http'

/**
 * Modrinth 之外的下载源。
 *
 * MC百科的模组页会把 CurseForge / GitHub 的项目地址放在 base64 跳转链接里。
 * 当 Modrinth 没有当前服务端版本时，可以顺着这些链接找到对应文件：
 *
 * - CurseForge：用 api.cfwidget.com 的公开数据，拿文件 id / 文件名 / 版本，
 *   再拼出 forgecdn 的直链（不需要 API Key，也不需要走 CurseForge 的网页）；
 * - GitHub：读 Releases API，从附件里挑名字带当前 MC 版本 / 加载器的 jar。
 *
 * 两个源都只接受「版本对得上」的文件，宁可返回 null 也不装一个不兼容的 jar。
 */

const UA = 'CraftDesk/1.0 (Minecraft server manager)'
const TIMEOUT = 25000
const CACHE_TTL = 20 * 60 * 1000

export interface ExternalResolution {
  source: 'curseforge' | 'github'
  version: RegistryVersion
  pageUrl: string
}

const cache = new Map<string, { at: number; value: ExternalResolution | null }>()
const cfDataCache = new Map<string, { at: number; value: CfWidgetData | null }>()
const ghFilesCache = new Map<
  string,
  { at: number; value: { name: string; url: string; size: number; pageUrl: string }[] }
>()
const modrinthFilesCache = new Map<
  string,
  { at: number; value: { name: string; url: string; size: number; pageUrl: string }[] }
>()

async function getJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await httpFetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'
      },
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

function loaderTokens(kind: ServerKind): string[] {
  switch (kind) {
    case 'forge':
      return ['Forge']
    case 'neoforge':
      return ['NeoForge', 'Forge']
    case 'fabric':
      return ['Fabric']
    case 'paper':
    case 'purpur':
    case 'spigot':
    case 'bukkit':
      return ['Paper', 'Spigot', 'Bukkit']
    case 'velocity':
      return ['Velocity']
    case 'waterfall':
    case 'bungeecord':
      return ['BungeeCord', 'Waterfall']
    default:
      return []
  }
}

function hasLoader(versions: string[], kind: ServerKind): boolean {
  const wanted = loaderTokens(kind)
  if (!wanted.length) return true
  return versions.some((v) => wanted.some((w) => v.toLowerCase() === w.toLowerCase()))
}

function hasGameVersion(versions: string[], mcVersion: string): boolean {
  if (!mcVersion) return true
  return versions.some((v) => v === mcVersion)
}

function isServerFile(versions: string[]): boolean {
  const hasClient = versions.some((v) => v.toLowerCase() === 'client')
  const hasServer = versions.some((v) => v.toLowerCase() === 'server')
  return !hasClient || hasServer
}

export interface CfFile {
  id?: number
  url?: string
  display?: string
  name?: string
  type?: string
  filesize?: number
  downloads?: number
  uploaded_at?: string
  versions?: string[]
}

interface CfWidgetData {
  files?: CfFile[]
  versions?: Record<string, CfFile[]>
}

export function curseforgeApiPath(url: string): string | null {
  try {
    const u = new URL(url)
    if (!u.hostname.toLowerCase().endsWith('curseforge.com')) return null
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'minecraft' || parts.length < 3) return null
    return `/minecraft/${parts[1]}/${parts[2]}`
  } catch {
    return null
  }
}

export function forgeCdnFileUrl(file: CfFile): string | null {
  const id = Number(file.id)
  const name = file.name?.trim()
  if (!Number.isFinite(id) || id <= 0 || !name) return null
  const s = String(id)
  if (s.length < 4) return null
  const dir = s.slice(0, -3)
  const tail = s.slice(-3)
  const encoded = encodeURIComponent(name).replace(/%2B/gi, '+')
  return `https://edge.forgecdn.net/files/${dir}/${tail}/${encoded}`
}

/** 从 CurseForge 文件列表里挑当前服务端可用的最新文件（纯函数，方便测试） */
export function pickCurseForgeFile(
  files: CfFile[],
  kind: ServerKind,
  mcVersion: string
): CfFile | null {
  return (
    files
      .filter((f) => {
        const versions = f.versions ?? []
        return (
          hasLoader(versions, kind) &&
          hasGameVersion(versions, mcVersion) &&
          isServerFile(versions) &&
          Boolean(f.name) &&
          Boolean(f.url)
        )
      })
      .sort((a, b) => {
        const ta = a.uploaded_at ?? ''
        const tb = b.uploaded_at ?? ''
        return tb.localeCompare(ta) || Number(b.id) - Number(a.id)
      })[0] ?? null
  )
}

async function fromCurseForge(
  links: McmodExternalLink[],
  kind: ServerKind,
  mcVersion: string
): Promise<ExternalResolution | null> {
  const wanted = loaderTokens(kind)
  const cfLinks = links.filter((l) => l.provider === 'curseforge')
  if (!cfLinks.length) return null
  // MC百科会分别给出 Forge / Fabric / NeoForge 的 CurseForge 地址
  const link =
    cfLinks.find((l) => l.loaders?.some((x) => wanted.some((w) => x.toLowerCase().includes(w.toLowerCase())))) ??
    cfLinks.find((l) => !l.loaders?.length) ??
    cfLinks[0]
  const slugPath = curseforgeApiPath(link.url)
  if (!slugPath) return null

  const key = `cf|${slugPath}|${kind}|${mcVersion}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value

  try {
    const data = await getJson<CfWidgetData>(`https://api.cfwidget.com${slugPath}`)
    const raw = [...(data.files ?? []), ...Object.values(data.versions ?? {}).flat()]
    const seen = new Set<number>()
    const files: CfFile[] = []
    for (const f of raw) {
      const id = Number(f.id)
      if (!Number.isFinite(id) || seen.has(id)) continue
      seen.add(id)
      files.push(f)
    }
    const file = pickCurseForgeFile(files, kind, mcVersion)
    if (!file) {
      cache.set(key, { at: Date.now(), value: null })
      return null
    }
    const fileUrl = forgeCdnFileUrl(file)
    if (!fileUrl) {
      cache.set(key, { at: Date.now(), value: null })
      return null
    }
    const versions = file.versions ?? []
    const value: ExternalResolution = {
      source: 'curseforge',
      pageUrl: file.url ?? link.url,
      version: {
        id: `cf-${file.id}`,
        name: file.display || file.name || `#${file.id}`,
        channel: file.type || 'release',
        fileName: file.name || '',
        fileUrl,
        fileSize: file.filesize ?? 0,
        downloads: file.downloads ?? 0,
        publishedAt: file.uploaded_at ?? '',
        gameVersions: versions.filter((v) => /^\d/.test(v)),
        loaders: versions.filter((v) => /[A-Za-z]/.test(v) && !/^(client|server)$/i.test(v))
      }
    }
    cache.set(key, { at: Date.now(), value })
    return value
  } catch {
    cache.set(key, { at: Date.now(), value: null })
    return null
  }
}

interface GhRelease {
  tag_name?: string
  name?: string
  html_url?: string
  prerelease?: boolean
  draft?: boolean
  published_at?: string
  assets?: { id?: number; name?: string; size?: number; browser_download_url?: string }[]
}

function githubRepo(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname.toLowerCase() !== 'github.com') return null
    const parts = u.pathname.split('/').filter(Boolean)
    // 只认仓库根地址；/wiki、/tree/... 不是发布 jar 的地方
    if (parts.length !== 2) return null
    return `${parts[0]}/${parts[1]}`
  } catch {
    return null
  }
}

function nameMatchesVersion(name: string, mcVersion: string): boolean {
  if (!mcVersion) return true
  const escaped = mcVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^0-9])${escaped}(?:[^0-9]|$)`, 'i').test(name)
}

function nameMatchesLoader(name: string, kind: ServerKind): boolean {
  const tokens = loaderTokens(kind)
  if (!tokens.length) return true
  const lower = name.toLowerCase()
  return (
    tokens.some((t) => lower.includes(t.toLowerCase())) ||
    /\b(?:all|universal)\b/i.test(name)
  )
}

async function fromGitHub(
  links: McmodExternalLink[],
  kind: ServerKind,
  mcVersion: string
): Promise<ExternalResolution | null> {
  const link = links.find((l) => l.provider === 'github')
  if (!link) return null
  const repo = githubRepo(link.url)
  if (!repo) return null

  const key = `gh|${repo}|${kind}|${mcVersion}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value

  try {
    const releases = await getJson<GhRelease[]>(
      `https://api.github.com/repos/${repo}/releases?per_page=20`
    )
    for (const release of releases) {
      if (release.draft) continue
      for (const asset of release.assets ?? []) {
        const name = asset.name ?? ''
        if (!/\.jar$/i.test(name)) continue
        if (/(?:sources|javadoc|dev|api)\.jar$/i.test(name)) continue
        if (!asset.browser_download_url) continue
        if (!nameMatchesVersion(name, mcVersion)) continue
        if (!nameMatchesLoader(name, kind)) continue
        const value: ExternalResolution = {
          source: 'github',
          pageUrl: release.html_url || link.url,
          version: {
            id: `gh-${asset.id ?? name}`,
            name: release.tag_name || release.name || name,
            channel: release.prerelease ? 'beta' : 'release',
            fileName: name,
            fileUrl: asset.browser_download_url,
            fileSize: asset.size ?? 0,
            downloads: 0,
            publishedAt: release.published_at ?? '',
            gameVersions: mcVersion ? [mcVersion] : [],
            loaders: loaderTokens(kind)
          }
        }
        cache.set(key, { at: Date.now(), value })
        return value
      }
    }
    cache.set(key, { at: Date.now(), value: null })
    return null
  } catch {
    cache.set(key, { at: Date.now(), value: null })
    return null
  }
}

async function getCfData(slugPath: string): Promise<CfWidgetData | null> {
  const key = `cfdata|${slugPath}`
  const cached = cfDataCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value
  try {
    const value = await getJson<CfWidgetData>(`https://api.cfwidget.com${slugPath}`)
    cfDataCache.set(key, { at: Date.now(), value })
    return value
  } catch {
    cfDataCache.set(key, { at: Date.now(), value: null })
    return null
  }
}

async function getGitHubFiles(repo: string): Promise<{
  name: string
  url: string
  size: number
  pageUrl: string
}[]> {
  const key = `ghfiles|${repo}`
  const cached = ghFilesCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value
  try {
    const releases = await getJson<GhRelease[]>(
      `https://api.github.com/repos/${repo}/releases?per_page=20`
    )
    const out: { name: string; url: string; size: number; pageUrl: string }[] = []
    for (const release of releases) {
      if (release.draft) continue
      for (const asset of release.assets ?? []) {
        if (!asset.name || !asset.browser_download_url) continue
        if (!/\.jar$/i.test(asset.name)) continue
        out.push({
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size ?? 0,
          pageUrl: release.html_url || ''
        })
      }
    }
    ghFilesCache.set(key, { at: Date.now(), value: out })
    return out
  } catch {
    ghFilesCache.set(key, { at: Date.now(), value: [] })
    return []
  }
}

async function getModrinthFiles(slug: string): Promise<{
  name: string
  url: string
  size: number
  pageUrl: string
}[]> {
  const key = `mrfile|${slug}`
  const cached = modrinthFilesCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value
  try {
    const list = await getJson<
      {
        id: string
        files?: { filename?: string; url?: string; size?: number }[]
      }[]
    >(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version`)
    const out: { name: string; url: string; size: number; pageUrl: string }[] = []
    for (const v of list) {
      for (const f of v.files ?? []) {
        if (!f.filename || !f.url) continue
        out.push({
          name: f.filename,
          url: f.url,
          size: f.size ?? 0,
          pageUrl: `https://modrinth.com/project/${slug}/version/${v.id}`
        })
      }
    }
    modrinthFilesCache.set(key, { at: Date.now(), value: out })
    return out
  } catch {
    modrinthFilesCache.set(key, { at: Date.now(), value: [] })
    return []
  }
}

/**
 * 给 MC百科下载页里的文件表匹配同名外部文件。
 *
 * MC百科自己的「立即下载」要验证码，所以这里只使用它的文件清单：
 * 文件名在 CurseForge / GitHub / Modrinth 上是唯一的，按同名匹配即可
 * 找到同一个 jar，再走对应 CDN 下载到用户指定的 mods / plugins 目录。
 */
export async function attachDownloadUrls(
  files: McmodDownloadFile[],
  links: McmodExternalLink[]
): Promise<McmodDownloadFile[]> {
  if (!files.length || !links.length) return files
  const byName = new Map<
    string,
    { url: string; size: number; source: McmodDownloadFile['source'] }
  >()

  const put = (
    name: string,
    url: string,
    size: number,
    source: NonNullable<McmodDownloadFile['source']>
  ): void => {
    const key = name.toLowerCase()
    if (!byName.has(key)) byName.set(key, { url, size, source })
  }

  for (const link of links) {
    if (link.provider === 'curseforge') {
      const slugPath = curseforgeApiPath(link.url)
      if (!slugPath) continue
      const data = await getCfData(slugPath)
      if (!data) continue
      const raw = [...(data.files ?? []), ...Object.values(data.versions ?? {}).flat()]
      for (const f of raw) {
        const url = forgeCdnFileUrl(f)
        if (url && f.name) put(f.name, url, f.filesize ?? 0, 'curseforge')
      }
    } else if (link.provider === 'github') {
      const repo = githubRepo(link.url)
      if (!repo) continue
      for (const f of await getGitHubFiles(repo)) {
        put(f.name, f.url, f.size, 'github')
      }
    } else if (link.provider === 'modrinth') {
      try {
        const slug = new URL(link.url).pathname.split('/').filter(Boolean).pop() ?? ''
        if (!slug) continue
        for (const f of await getModrinthFiles(slug)) {
          put(f.name, f.url, f.size, 'modrinth')
        }
      } catch {
        /* ignore */
      }
    }
  }

  return files.map((file) => {
    const hit = byName.get(file.fileName.toLowerCase())
    return hit
      ? { ...file, url: hit.url, source: hit.source, size: hit.size || file.size }
      : file
  })
}

/** 从已经匹配好直链的 MC百科文件表里挑当前服务端最新的一条 */
export function pickMcmodDownloadFile(
  files: McmodDownloadFile[],
  kind: ServerKind,
  mcVersion: string
): McmodDownloadFile | null {
  const wanted = loaderTokens(kind)
  return (
    files
      .filter((f) => {
        if (!f.url) return false
        const loaderOk =
          wanted.length === 0 ||
          f.loaders.length === 0 ||
          f.loaders.some((l) => wanted.some((w) => l.toLowerCase() === w.toLowerCase()))
        const versionOk =
          !mcVersion || f.mcVersions.length === 0 || f.mcVersions.includes(mcVersion)
        return loaderOk && versionOk
      })
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || b.id.localeCompare(a.id))[0] ??
    null
  )
}

/** 按 MC百科外链找可下载文件：先 CurseForge，再 GitHub */
export async function resolveExternalDownload(
  links: McmodExternalLink[],
  kind: ServerKind,
  mcVersion: string
): Promise<ExternalResolution | null> {
  if (!links.length) return null
  const cf = await fromCurseForge(links, kind, mcVersion)
  if (cf) return cf
  return fromGitHub(links, kind, mcVersion)
}

/** 测试用 */
export function clearExternalSourceCache(): void {
  cache.clear()
}
