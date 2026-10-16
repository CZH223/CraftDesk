import type {
  ModrinthHit,
  RegistryHit,
  RegistrySource,
  RegistryVersion,
  ServerKind
} from '../shared/types'

/**
 * 扩展下载源。
 *
 * 每个站点的字段差别很大，这里统一成 RegistryHit / RegistryVersion，
 * 界面只认这一份形状，加新源不用改界面。
 *
 * 各站点的可用性（都实测过）：
 * - Modrinth   官方 v2 API，完整可用
 * - Hangar     官方 v1 API，搜索带平台/版本过滤，下载是 CDN 直链
 * - SpigotMC   没有官方 API，走第三方 Spiget。下载会被 Cloudflare 拦，
 *              只有 external（托管在 GitHub 等）的资源能下
 * - CurseForge 官方 API 必须要 key，让用户自己填
 */

const UA = 'CraftDesk/1.0 (Minecraft server manager)'
const TIMEOUT = 25000

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export interface SearchOptions {
  query: string
  /** 目标服务器的 MC 版本 */
  gameVersion?: string
  /** fabric / paper / velocity ... */
  loader?: string
  /** mod 还是 plugin */
  kind: 'mod' | 'plugin'
  limit?: number
  offset?: number
  /** CurseForge 用 */
  apiKey?: string
}

// ---------------------------------------------------------------- Hangar

const HANGAR = 'https://hangar.papermc.io/api/v1'

/** Hangar 的平台标识 */
function hangarPlatform(kind: ServerKind | string): string {
  switch (kind) {
    case 'velocity':
      return 'VELOCITY'
    case 'waterfall':
      return 'WATERFALL'
    case 'bungeecord':
      return 'BUNGEECORD'
    default:
      return 'PAPER'
  }
}

interface HangarProject {
  name: string
  namespace: { owner: string; slug: string }
  description: string
  stats?: { downloads?: number }
  category?: string
  avatarUrl?: string
  lastUpdated?: string
}

export async function searchHangar(
  opts: SearchOptions,
  platform: string
): Promise<{ hits: RegistryHit[]; total: number }> {
  const params = new URLSearchParams({
    q: opts.query || '',
    limit: String(opts.limit ?? 20),
    offset: String(opts.offset ?? 0),
    platform
  })
  // 有搜索词时 Hangar 默认按相关度排；只有空查询（浏览热门）才需要显式指定 sort。
  // 注意 -relevance 不是合法值，传了会直接 400。
  if (!opts.query.trim()) params.set('sort', '-downloads')
  if (opts.gameVersion) params.set('version', opts.gameVersion)

  const data = await getJson<{ pagination: { count: number }; result: HangarProject[] }>(
    `${HANGAR}/projects?${params}`
  )

  return {
    total: data.pagination?.count ?? 0,
    hits: (data.result ?? []).map((p) => ({
      source: 'hangar' as const,
      id: `${p.namespace.owner}/${p.namespace.slug}`,
      name: p.name,
      description: p.description ?? '',
      authors: [p.namespace.owner],
      downloads: p.stats?.downloads ?? 0,
      iconUrl: p.avatarUrl ?? null,
      categories: p.category ? [p.category] : [],
      pageUrl: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
      extra: [],
      installable: true
    }))
  }
}

interface HangarVersion {
  name: string
  channel?: { name: string }
  createdAt?: string
  platformDependencies?: Record<string, string[]>
  downloads?: Record<
    string,
    {
      fileInfo?: { name: string; sizeBytes: number }
      downloadUrl?: string
      externalUrl?: string
    }
  >
}

export async function hangarVersions(
  id: string,
  platform: string,
  gameVersion?: string
): Promise<RegistryVersion[]> {
  const params = new URLSearchParams({ limit: '25', platform })
  if (gameVersion) params.set('platformVersion', gameVersion)

  const data = await getJson<{ result: HangarVersion[] }>(
    `${HANGAR}/projects/${id}/versions?${params}`
  )

  return (data.result ?? [])
    .map((v) => {
      const d = v.downloads?.[platform]
      return {
        id: v.name,
        name: v.name,
        channel: (v.channel?.name ?? 'Release').toLowerCase(),
        fileName: d?.fileInfo?.name ?? '',
        fileUrl: d?.downloadUrl ?? d?.externalUrl ?? '',
        fileSize: d?.fileInfo?.sizeBytes ?? 0,
        downloads: 0,
        publishedAt: v.createdAt ?? '',
        gameVersions: v.platformDependencies?.[platform] ?? [],
        loaders: [platform.toLowerCase()]
      }
    })
    .filter((v) => v.fileUrl)
}

// ---------------------------------------------------------------- SpigotMC（走 Spiget）

const SPIGET = 'https://api.spiget.org/v2'

interface SpigetResource {
  id: number
  name: string
  tag?: string
  description?: string
  external?: boolean
  premium?: boolean
  downloads?: number
  likes?: number
  file?: { type?: string; size?: number; sizeUnit?: string; url?: string; externalUrl?: string }
  rating?: { average?: number; count?: number }
  author?: { id?: number; name?: string }
}

export async function searchSpigot(
  opts: SearchOptions
): Promise<{ hits: RegistryHit[]; total: number }> {
  const size = opts.limit ?? 20
  const page = Math.floor((opts.offset ?? 0) / size) + 1

  // Spiget 没有关键词为空时的浏览接口，空查询就用热门资源列表
  const url = opts.query.trim()
    ? `${SPIGET}/search/resources/${encodeURIComponent(opts.query)}?size=${size}&page=${page}&sort=-downloads`
    : `${SPIGET}/resources?size=${size}&page=${page}&sort=-downloads&fields=id,name,tag,external,premium,downloads,file,rating`

  const list = await getJson<SpigetResource[]>(url)

  return {
    total: list.length + (opts.offset ?? 0) + (list.length === size ? size : 0),
    hits: list.map((r) => {
      // SpigotMC 的下载被 Cloudflare 挡着，只有 external 的资源（官方托管在
      // GitHub 等地方）能程序化下载，所以这两种要区别对待
      const blocked = r.premium
        ? '付费资源，需要到 SpigotMC 购买'
        : r.external
          ? undefined
          : 'SpigotMC 的下载有 Cloudflare 保护，无法自动下载，请点「主页」手动下载'
      return {
        source: 'spigot' as const,
        id: String(r.id),
        name: r.name,
        description: r.description?.replace(/<[^>]*>/g, '').slice(0, 200) ?? '',
        authors: r.author?.name ? [r.author.name] : [],
        downloads: r.downloads ?? 0,
        iconUrl: r.file?.type === 'external' ? null : null,
        categories: r.tag ? [r.tag] : [],
        pageUrl: `https://www.spigotmc.org/resources/${r.id}/`,
        extra: [r.external ? '外部托管' : 'Spigot 托管', r.premium ? '付费' : ''].filter(Boolean),
        installable: !blocked,
        blockedReason: blocked
      }
    })
  }
}

/** Spiget 只暴露最新版本，够用——插件一般只装最新 */
export async function spigotVersions(id: string): Promise<RegistryVersion[]> {
  const v = await getJson<{
    id: number
    name: string
    releaseDate: number
    downloads: number
  }>(`${SPIGET}/resources/${id}/versions/latest`)

  return [
    {
      id: String(v.id),
      name: v.name,
      channel: 'release',
      // 文件名只能从下载响应头拿，这里先给个合理的默认值
      fileName: `spigot-${id}-${v.name}.jar`,
      // Spiget 的 download 端点会 302 到真实地址，主进程下载时会自动跟随
      fileUrl: `${SPIGET}/resources/${id}/download`,
      fileSize: 0,
      downloads: v.downloads ?? 0,
      publishedAt: v.releaseDate ? new Date(v.releaseDate * 1000).toISOString() : '',
      gameVersions: [],
      loaders: []
    }
  ]
}

// ---------------------------------------------------------------- CurseForge

const CF = 'https://api.curseforge.com/v1'
const CF_GAME_ID = 432 // Minecraft

/** CurseForge 的加载器枚举 */
function cfLoader(loader: string | undefined): number | null {
  switch (loader) {
    case 'forge':
      return 1
    case 'fabric':
      return 4
    case 'quilt':
      return 5
    case 'neoforge':
      return 6
    default:
      return null
  }
}

interface CfMod {
  id: number
  name: string
  slug: string
  summary: string
  downloadCount: number
  logo?: { thumbnailUrl?: string }
  authors?: { name: string }[]
  categories?: { name: string }[]
  links?: { websiteUrl?: string }
}

export async function searchCurseforge(
  opts: SearchOptions
): Promise<{ hits: RegistryHit[]; total: number }> {
  if (!opts.apiKey) {
    throw new Error('CurseForge 需要 API Key，请到「设置」里填写')
  }

  const params = new URLSearchParams({
    gameId: String(CF_GAME_ID),
    searchFilter: opts.query || '',
    pageSize: String(opts.limit ?? 20),
    index: String(opts.offset ?? 0),
    sortField: opts.query ? '2' : '6', // 2=人气 6=总下载
    sortOrder: 'desc'
  })
  if (opts.gameVersion) params.set('gameVersion', opts.gameVersion)
  const loader = cfLoader(opts.loader)
  if (loader) params.set('modLoaderType', String(loader))

  const data = await getJson<{ data: CfMod[]; pagination: { totalCount: number } }>(
    `${CF}/mods/search?${params}`,
    { 'x-api-key': opts.apiKey }
  )

  return {
    total: data.pagination?.totalCount ?? 0,
    hits: (data.data ?? []).map((m) => ({
      source: 'curseforge' as const,
      id: String(m.id),
      name: m.name,
      description: m.summary ?? '',
      authors: (m.authors ?? []).map((a) => a.name).filter(Boolean),
      downloads: m.downloadCount ?? 0,
      iconUrl: m.logo?.thumbnailUrl ?? null,
      categories: (m.categories ?? []).map((c) => c.name),
      pageUrl: m.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`,
      extra: [],
      installable: true
    }))
  }
}

export async function curseforgeVersions(
  id: string,
  opts: { apiKey?: string; gameVersion?: string; loader?: string }
): Promise<RegistryVersion[]> {
  if (!opts.apiKey) throw new Error('CurseForge 需要 API Key')

  const params = new URLSearchParams({ pageSize: '25' })
  if (opts.gameVersion) params.set('gameVersion', opts.gameVersion)
  const loader = cfLoader(opts.loader)
  if (loader) params.set('modLoaderType', String(loader))

  const data = await getJson<{
    data: {
      id: number
      displayName: string
      fileName: string
      fileLength: number
      downloadUrl: string | null
      fileDate: string
      releaseType: number
      downloadCount: number
      gameVersions: string[]
    }[]
  }>(`${CF}/mods/${id}/files?${params}`, { 'x-api-key': opts.apiKey })

  // releaseType: 1=release 2=beta 3=alpha
  const CHANNEL = ['release', 'release', 'beta', 'alpha']

  return (data.data ?? [])
    .filter((f) => f.downloadUrl)
    .map((f) => ({
      id: String(f.id),
      name: f.displayName,
      channel: CHANNEL[f.releaseType] ?? 'release',
      fileName: f.fileName,
      fileUrl: f.downloadUrl as string,
      fileSize: f.fileLength,
      downloads: f.downloadCount ?? 0,
      publishedAt: f.fileDate ?? '',
      gameVersions: f.gameVersions ?? [],
      loaders: []
    }))
}

// ---------------------------------------------------------------- Modrinth 适配

export function modrinthHitToRegistry(h: ModrinthHit): RegistryHit {
  return {
    source: 'modrinth',
    id: h.projectId,
    name: h.title,
    description: h.description,
    authors: [h.author],
    downloads: h.downloads,
    iconUrl: h.iconUrl,
    categories: h.categories,
    pageUrl: `https://modrinth.com/project/${h.slug}`,
    extra: h.serverSide === 'unsupported' ? ['仅客户端'] : [],
    installable: h.serverSide !== 'unsupported',
    blockedReason: h.serverSide === 'unsupported' ? '这个项目只支持客户端，装到服务端不会生效' : undefined
  }
}

// ---------------------------------------------------------------- 统一入口

export const SOURCES: { key: RegistrySource; label: string; hint: string }[] = [
  { key: 'modrinth', label: 'Modrinth', hint: '模组与插件，API 最完整' },
  { key: 'hangar', label: 'Hangar', hint: 'Paper 官方插件站' },
  { key: 'spigot', label: 'SpigotMC', hint: '老牌插件站，Spigot 自托管的资源无法自动下载' },
  { key: 'curseforge', label: 'CurseForge', hint: '模组为主，需要自备 API Key' },
  { key: 'mcdr', label: 'MCDR 插件', hint: 'MCDReforged 的 Python 插件' }
]

export { hangarPlatform, cfLoader }
