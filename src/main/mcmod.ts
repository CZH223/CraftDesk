import type {
  McmodDownloadFile,
  McmodDownloadList,
  McmodExternalLink,
  McmodRelationCategory,
  McmodRelationNode,
  McmodRelationRequest,
  McmodRelations,
  McmodSearchHit
} from '../shared/types'
import { httpFetch } from './http'

/**
 * MC百科关系数据。
 *
 * MC百科的「Mod关系」页已经把关系直接渲染在 HTML 里，页面上的
 * 「打开星图」按钮带一个 data-id，对应一份静态 JSON：
 *
 *   /static/public/json/relation/class/<data-id>.json
 *
 * 里面包含 categories（前置 / 拓展 / 联动）、nodes 和 links。
 * 我们只取和中心直接相连的一圈，避免把 200 多个节点的整张图塞进界面；
 * 同时用英文名和本地 jar 的 name/id 匹配，匹配上的就不再重复画。
 *
 * 缓存放在内存里：同一台服务器来回切星图不会反复打 MC百科，失败也缓存
 * 一小段时间，避免站点抽风时每次点开都卡十秒。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CraftDesk/1.0'
const TIMEOUT = 20000
const CACHE_TTL = 30 * 60 * 1000
const FAIL_TTL = 5 * 60 * 1000

interface CacheEntry {
  at: number
  value: McmodRelations | null
}

const cache = new Map<string, CacheEntry>()
/** 搜索页结果单独缓存：依赖 id 到「YUNG's API」这种名字的翻译经常要用 */
const classCache = new Map<string, { at: number; value: McmodSearchHit | null }>()

export interface McmodPage {
  classId: string
  title: string
  pageUrl: string
  chartId: string | null
  links: McmodExternalLink[]
}

/** 模组页缓存：关系图和外部下载链接都从同一张页面来 */
const pageCache = new Map<string, { at: number; value: McmodPage | null }>()

/** 搜索结果 / 下载页缓存 */
const searchAllCache = new Map<string, { at: number; value: McmodSearchHit[] }>()
const downloadCache = new Map<string, { at: number; value: McmodDownloadList | null }>()

async function getText(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await httpFetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'
      },
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

export function mcmodNormalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 「YUNG 的矿井优化 (YUNG's Better Mineshafts)」→ YUNG's Better Mineshafts */
export function mcmodEnglishName(name: string): string {
  const m = name.trim().match(/\(([^()]*)\)\s*$/)
  if (m && /[A-Za-z]/.test(m[1])) return m[1].trim()
  return name.trim()
}

/**
 * 解析搜索页。MC百科的搜索结果是服务端渲染的，`/class/<数字>.html`
 * 就是模组条目；结果里还有分类、用户等其它类型，必须过滤掉。
 */
export function parseMcmodSearchAll(html: string): McmodSearchHit[] {
  const blocks = html.split('class="result-item"').slice(1)
  const hits: McmodSearchHit[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    const m = block.match(
      /href="(?:https?:\/\/www\.mcmod\.cn)?\/class\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/
    )
    if (!m) continue
    const title = stripTags(m[2])
    if (!title || seen.has(m[1])) continue
    seen.add(m[1])
    hits.push({ classId: m[1], title })
  }
  return hits
}

export function parseMcmodSearch(html: string, query = ''): McmodSearchHit | null {
  const hits = parseMcmodSearchAll(html)
  if (!hits.length) return null
  const q = mcmodNormalize(query)
  let best = hits[0]
  let bestScore = -1
  for (const hit of hits) {
    const t = mcmodNormalize(hit.title)
    const score = t === q ? 4 : t.includes(q) || q.includes(t) ? 2 : 1
    if (score > bestScore) {
      best = hit
      bestScore = score
    }
  }
  return best
}

/** 从模组页里找「打开星图」按钮的 data-id */
export function parseMcmodChartId(html: string): string | null {
  const direct = html.match(/id="class-relation-chart-btn"[^>]*data-id="([^"]+)"/)
  if (direct) return direct[1]
  const reversed = html.match(/data-id="([^"]+)"[^>]*id="class-relation-chart-btn"/)
  return reversed?.[1] ?? null
}

export function parseMcmodTitle(html: string, fallback: string): string {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i)
  if (!m) return fallback
  return stripTags(m[1]).replace(/\s*-\s*MC百科.*$/i, '').trim() || fallback
}

/**
 * 解析模组页「相关链接」里的外链。
 *
 * MC百科把真实地址藏在一个跳转链接里：
 *   href="//link.mcmod.cn/target/<base64>"
 * 解出来通常是 CurseForge / GitHub / Modrinth 的项目页。
 * 这些链接正好可以用来在 Modrinth 没有适配版本时换一个下载源。
 */
export function parseMcmodExternalLinks(html: string): McmodExternalLink[] {
  const out: McmodExternalLink[] = []
  const seen = new Set<string>()
  const re = /<a\b([^>]*)>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = m[1]
    const href = attrs.match(/href="([^"]+)"/i)?.[1] ?? ''
    const target = href.match(/link\.mcmod\.cn\/target\/([A-Za-z0-9+/=]+)/i)?.[1]
    if (!target) continue
    let url = ''
    try {
      url = Buffer.from(target, 'base64').toString('utf-8')
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(url)) continue
    let provider: McmodExternalLink['provider'] = 'other'
    try {
      const host = new URL(url).hostname.toLowerCase()
      if (host.endsWith('curseforge.com')) provider = 'curseforge'
      else if (host === 'github.com' || host.endsWith('.github.com')) provider = 'github'
      else if (host.endsWith('modrinth.com')) provider = 'modrinth'
    } catch {
      continue
    }
    if (provider === 'other') continue
    const rawLabel =
      attrs.match(/data-original-title="([^"]*)"/i)?.[1] ??
      attrs.match(/title="([^"]*)"/i)?.[1] ??
      provider
    const label = decodeEntities(rawLabel).replace(/\s+/g, ' ').trim() || provider
    const loaderText = label.match(/CurseForge:\s*(.+)$/i)?.[1]
    const loaders = loaderText
      ? loaderText
          .split(/[\/,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined
    const key = `${provider}:${url}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ provider, url, label, ...(loaders?.length ? { loaders } : {}) })
  }
  return out
}

/** 搜索并返回多个候选（下载页的 MC百科栏目用） */
export async function searchMcmodClasses(query: string): Promise<McmodSearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const key = q.toLowerCase()
  const now = Date.now()
  const cached = searchAllCache.get(key)
  if (cached && now - cached.at < CACHE_TTL) return cached.value
  try {
    const html = await getText(`https://www.mcmod.cn/s?key=${encodeURIComponent(q)}`)
    const hits = parseMcmodSearchAll(html)
    searchAllCache.set(key, { at: now, value: hits })
    return hits
  } catch {
    searchAllCache.set(key, { at: now, value: [] })
    return []
  }
}

/**
 * 解析「Mod下载」页的文件表。
 *
 * 这张表只有文件的元数据（文件名、MC 版本、加载器、大小、校验值），
 * MC百科自己的下载按钮要过验证码，所以这里不碰它；文件真正从哪下载，
 * 由上层按同名文件去 CurseForge / GitHub / Modrinth 匹配。
 */
export function parseMcmodDownloads(
  html: string,
  pageUrl: string
): McmodDownloadFile[] {
  const out: McmodDownloadFile[] = []
  const seen = new Set<string>()
  // data-head 里嵌了 <span>，属性值里会出现 ">"；不能用 [^>]* 截断
  const rowRe = /<tr\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/tr>/gi
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(html))) {
    const attrs = m[1]
    const data = (name: string): string => {
      const hit = attrs.match(new RegExp(`data-${name}=(?:"([^"]*)"|'([^']*)')`, 'i'))
      return hit?.[1] ?? hit?.[2] ?? ''
    }
    const id = data('id').trim()
    const baseName = data('filename').trim()
    if (!id || !baseName || seen.has(id)) continue
    seen.add(id)
    const suffix = data('suffix').trim()
    const fileName = suffix && !baseName.toLowerCase().endsWith(`.${suffix.toLowerCase()}`)
      ? `${baseName}.${suffix}`
      : baseName
    const head = stripTags(decodeEntities(data('head')))
    const loaderPool = ['NeoForge', 'Forge', 'Fabric', 'Quilt', 'Paper', 'Spigot', 'Bukkit', 'Velocity', 'BungeeCord', 'Waterfall']
    const loaders = loaderPool.filter((l) => new RegExp(`\\b${l}\\b`, 'i').test(head))
    const mcVersions = data('version')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
    const sizeMatch = m[2].match(/data-original-title="(\d+)\s*bytes"/i)
    const size = sizeMatch ? Number(sizeMatch[1]) : 0
    const dateMatch = m[2].match(/(20\d\d-\d\d-\d\d(?:\s+\d\d:\d\d:\d\d)?)/)
    out.push({
      id,
      fileName,
      mcVersions,
      loaders,
      size,
      uploadedAt: dateMatch?.[1] ?? '',
      pageUrl
    })
  }
  return out
}

/** 读取一个模组的 Mod下载页（只取文件表，不碰验证码下载） */
export async function lookupMcmodDownloads(classId: string): Promise<McmodDownloadList | null> {
  const key = classId.trim()
  if (!key) return null
  const now = Date.now()
  const cached = downloadCache.get(key)
  if (cached && now - cached.at < CACHE_TTL) return cached.value
  try {
    const pageUrl = `https://www.mcmod.cn/download/${encodeURIComponent(key)}.html`
    const html = await getText(pageUrl)
    const value: McmodDownloadList = {
      classId: key,
      title: parseMcmodTitle(html, `#${key}`),
      pageUrl,
      files: parseMcmodDownloads(html, pageUrl)
    }
    downloadCache.set(key, { at: now, value })
    return value
  } catch {
    downloadCache.set(key, { at: now, value: null })
    return null
  }
}

/** 读取一个模组页，缓存标题、星图 id 和相关外链 */
export async function lookupMcmodPage(classId: string): Promise<McmodPage | null> {
  const key = classId.trim()
  if (!key) return null
  const now = Date.now()
  const cached = pageCache.get(key)
  if (cached && now - cached.at < CACHE_TTL) return cached.value
  try {
    const pageUrl = `https://www.mcmod.cn/class/${encodeURIComponent(key)}.html`
    const html = await getText(pageUrl)
    const value: McmodPage = {
      classId: key,
      title: parseMcmodTitle(html, `#${key}`),
      pageUrl,
      chartId: parseMcmodChartId(html),
      links: parseMcmodExternalLinks(html)
    }
    pageCache.set(key, { at: now, value })
    return value
  } catch {
    pageCache.set(key, { at: now, value: null })
    return null
  }
}

interface RawRelationJson {
  categories?: { name?: string | null }[]
  nodes?: {
    id?: number
    classID?: string | number | null
    name?: string
    category?: number
  }[]
  links?: { source?: number; target?: number }[]
}

function categoryFromName(name: string | null | undefined): McmodRelationCategory | null {
  if (!name) return null
  if (name.includes('前置')) return 'required'
  if (name.includes('拓展') || name.includes('扩展')) return 'extends'
  if (name.includes('联动')) return 'linked'
  return null
}

/**
 * 解析星图 JSON，只保留中心以及和中心直接相连的节点。
 * 边的方向不重要 —— MC百科已经用节点的 category 标好了它是前置、拓展还是联动。
 */
export function parseMcmodRelationsJson(
  raw: string | RawRelationJson,
  opts: {
    classId: string
    title: string
    pageUrl: string
    externalLinks?: McmodExternalLink[]
  }
): McmodRelations | null {
  let data: RawRelationJson
  try {
    data = typeof raw === 'string' ? (JSON.parse(raw) as RawRelationJson) : raw
  } catch {
    return null
  }
  const rawNodes = data.nodes ?? []
  if (!rawNodes.length) return null
  const nodes = new Map<number, NonNullable<RawRelationJson['nodes']>[number]>()
  for (const n of rawNodes) {
    if (typeof n.id === 'number') nodes.set(n.id, n)
  }

  const centerCategoryIndex = (data.categories ?? []).findIndex((c) => !c?.name)
  const center =
    [...nodes.values()].find((n) => n.category === centerCategoryIndex && centerCategoryIndex >= 0) ??
    [...nodes.values()].find((n) => mcmodNormalize(n.name ?? '') === mcmodNormalize(opts.title)) ??
    [...nodes.values()].find((n) => n.id === 0) ??
    [...nodes.values()][0]
  if (!center || typeof center.id !== 'number') return null

  const catName = (index: number | undefined): string | null =>
    index === undefined ? null : data.categories?.[index]?.name ?? null
  const categoryOf = (n: NonNullable<RawRelationJson['nodes']>[number]): McmodRelationCategory =>
    categoryFromName(catName(n.category)) ?? 'center'

  const links = (data.links ?? []).filter(
    (l) =>
      typeof l.source === 'number' &&
      typeof l.target === 'number' &&
      (l.source === center.id || l.target === center.id)
  )
  const neighbourIds = new Set<number>()
  const directLinks: { from: number; to: number }[] = []
  for (const l of links) {
    const other: number = (l.source === center.id ? l.target : l.source) as number
    if (other === center.id) continue
    neighbourIds.add(other)
    directLinks.push({
      from: l.source === center.id ? center.id : other,
      to: l.source === center.id ? other : center.id
    })
  }

  const direct: McmodRelationNode[] = []
  for (const id of neighbourIds) {
    const n = nodes.get(id)
    if (!n) continue
    const name = n.name ?? `#${id}`
    const classId =
      typeof n.classID === 'string' || typeof n.classID === 'number'
        ? String(n.classID)
        : null
    direct.push({
      id,
      classId,
      name,
      englishName: mcmodEnglishName(name),
      category: categoryOf(n)
    })
  }
  // 前置优先，其次是联动，最后是拓展；这样截断时至少保住真正需要的依赖
  const rank: Record<McmodRelationCategory, number> = {
    required: 0,
    linked: 1,
    extends: 2,
    center: 3
  }
  direct.sort((a, b) => rank[a.category] - rank[b.category] || a.name.localeCompare(b.name))

  const centerCategory = categoryOf(center)
  const centerNode: McmodRelationNode = {
    id: center.id,
    classId:
      typeof center.classID === 'string' || typeof center.classID === 'number'
        ? String(center.classID)
        : null,
    name: center.name ?? opts.title,
    englishName: mcmodEnglishName(center.name ?? opts.title),
    category: centerCategory === 'center' ? 'center' : centerCategory
  }

  return {
    classId: opts.classId,
    title: opts.title,
    pageUrl: opts.pageUrl,
    centerId: center.id,
    nodes: [centerNode, ...direct],
    links: directLinks,
    externalLinks: opts.externalLinks ?? []
  }
}

async function searchClass(query: string): Promise<McmodSearchHit | null> {
  if (!query.trim()) return null
  const html = await getText(`https://www.mcmod.cn/s?key=${encodeURIComponent(query.trim())}`)
  return parseMcmodSearch(html, query)
}

/**
 * 按名字 / 依赖 id 找 MC百科条目。
 *
 * 依赖 id 经常和英文名差一个空格或连字符（yungsapi vs YUNG's API），
 * 直接拿去搜 Modrinth 会一个结果都没有；这里用 MC百科的搜索把 id
 * 翻成正常名字，再交给 Modrinth 解析。
 */
export async function lookupMcmodClass(query: string): Promise<McmodSearchHit | null> {
  const key = query.trim().toLowerCase()
  if (!key) return null
  const now = Date.now()
  const cached = classCache.get(key)
  if (cached && now - cached.at < (cached.value ? CACHE_TTL : FAIL_TTL)) return cached.value
  try {
    const value = await searchClass(query)
    classCache.set(key, { at: now, value })
    return value
  } catch {
    classCache.set(key, { at: now, value: null })
    return null
  }
}

/** 查一个模组在 MC百科上的关系；失败返回 null，由界面决定怎么提示 */
export async function lookupMcmodRelations(req: McmodRelationRequest): Promise<McmodRelations | null> {
  const key = `${req.id} ${req.name}`.toLowerCase()
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < (hit.value ? CACHE_TTL : FAIL_TTL)) return hit.value

  try {
    // 先按本地显示名搜，再按 mod id 搜；MC百科的搜索结果里通常能直接看到英文名
    const found = (await lookupMcmodClass(req.name)) ?? (await lookupMcmodClass(req.id))
    if (!found) {
      cache.set(key, { at: now, value: null })
      return null
    }

    const page = await lookupMcmodPage(found.classId)
    if (!page?.chartId) {
      cache.set(key, { at: now, value: null })
      return null
    }
    const json = await getText(
      `https://www.mcmod.cn/static/public/json/relation/class/${page.chartId}.json`
    )
    const parsed = parseMcmodRelationsJson(json, {
      classId: found.classId,
      title: page.title || found.title,
      pageUrl: page.pageUrl,
      externalLinks: page.links
    })
    cache.set(key, { at: now, value: parsed })
    return parsed
  } catch {
    cache.set(key, { at: now, value: null })
    return null
  }
}

/** 测试用：清掉内存缓存 */
export function clearMcmodCache(): void {
  cache.clear()
  classCache.clear()
  pageCache.clear()
  searchAllCache.clear()
  downloadCache.clear()
}
