import { ZipReader, parseSimpleYaml, yamlList } from './zip'

/**
 * 从扩展文件里读出「它是什么」以及「它要什么」。
 *
 * 五种加载器的描述文件格式完全不一样，依赖关系的写法更是各写各的：
 *   Fabric    fabric.mod.json    depends / recommends / provides / breaks
 *   Forge     META-INF/mods.toml [[dependencies.<id>]] modId + mandatory
 *   Bukkit    plugin.yml         depend / softdepend / loadbefore
 *   Bungee    bungee.yml         depends / softDepends
 *   Velocity  velocity-plugin.json  dependencies: [{id, optional}]
 *   MCDR      mcdreforged.plugin.json  dependencies: {id: version}
 *
 * 这里只负责「读出来」，谁依赖谁、缺没缺是 relations.ts 的事。
 */

export type ModSide = 'both' | 'client' | 'server' | 'unknown'

export interface ExtMeta {
  id: string
  name: string
  version: string
  author: string
  description: string
  /** 硬前置：没有它这个扩展根本不加载 */
  depends: string[]
  /** 软前置：没装也能跑，装了功能更全 */
  softDepends: string[]
  /** 除自己之外还提供的 id（Fabric 的 provides、嵌套 jar 里的模组） */
  provides: string[]
  /** 明确声明不兼容的 */
  breaks: string[]
  /** 依赖的版本要求，只用于界面显示 */
  ranges: Record<string, string>
  /**
   * 这个扩展在哪一侧起作用。
   *
   * Fabric 在 fabric.mod.json 里明写 `environment`（client / server / *），
   * 这是唯一可靠的来源 —— 服务端加载了纯客户端模组不会有任何效果，
   * 正是「这个 mods 目录里是不是有一堆用不上的东西」的答案。
   *
   * Forge / NeoForge 的 mods.toml 里没有对应字段（分侧是运行期用 Dist 判的），
   * 所以那边只能是 unknown，不猜。
   */
  side: ModSide
  /**
   * 文件本身读不动（zip 结构坏了、被截断）。
   * 和「这个 jar 里没有元数据」是两回事：前者要重新下载，
   * 后者可能只是个普通的库 jar。
   */
  broken: boolean
}

export const emptyMeta = (): ExtMeta => ({
  id: '',
  name: '',
  version: '',
  author: '',
  description: '',
  depends: [],
  softDepends: [],
  provides: [],
  breaks: [],
  ranges: {},
  side: 'unknown',
  broken: false
})

/**
 * 解析 JSON，对现实里的描述文件宽容一点。
 *
 * 标准库的 JSON.parse 很严，模组的描述文件却经常不那么标准：
 * - **带 BOM**：JSON.parse 看到开头那个 ﻿ 直接抛异常
 * - **字符串里带裸换行/制表符**：JSON 规范不允许，但 Fabric Loader
 *   用的是宽容模式，所以模组在游戏里跑得好好的。BetterGrassify 的
 *   description 就是这么写的（一个多行字符串），严格解析直接失败
 *
 * 解析失败不会报错，只会让这个模组读不出 id 和前置 —— 在依赖图里
 * 变成谁也认不出来的空条目，所以这两种情况都得兜住。
 */
export function parseJson(text: string): Record<string, unknown> | null {
  const clean = text.replace(/^﻿/, '')
  try {
    return JSON.parse(clean) as Record<string, unknown>
  } catch {
    try {
      return JSON.parse(escapeControlChars(clean)) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

const CONTROL_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f'
}

/**
 * 把字符串字面量里的裸控制字符转义掉。
 * 字符串外的换行是合法空白，不能动；所以得知道自己在不在引号里。
 */
function escapeControlChars(text: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        out += ch
        inString = false
        continue
      }
      if (code < 0x20) {
        out += CONTROL_ESCAPES[ch] ?? `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }

  return out
}

/** description 可能是按语言分组的对象，挑一个合适的 */
export function pickLocalized(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return ''
  const obj = value as Record<string, unknown>
  for (const key of ['zh_cn', 'zh_CN', 'zh', 'en_us', 'en_US', 'en']) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

export function pickAuthor(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((a) => (typeof a === 'string' ? a : (a as { name?: string })?.name ?? ''))
      .filter(Boolean)
      .join(', ')
  }
  return ''
}

/** 依赖声明的两种写法：对象 {id: 版本范围}，或者数组 ["id"] */
function readDepends(value: unknown): { ids: string[]; ranges: Record<string, string> } {
  const ids: string[] = []
  const ranges: Record<string, string> = {}

  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === 'string' && v.trim()) ids.push(v.trim())
    return { ids, ranges }
  }

  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      ids.push(k)
      if (typeof v === 'string' && v.trim()) ranges[k] = v.trim()
    }
  }
  return { ids, ranges }
}

/** Fabric：fabric.mod.json */
export function parseFabricMeta(json: string): ExtMeta | null {
  const j = parseJson(json)
  if (!j) return null

  const meta = emptyMeta()
  meta.id = typeof j.id === 'string' ? j.id : ''
  meta.name = (typeof j.name === 'string' ? j.name : '') || meta.id
  meta.version = typeof j.version === 'string' ? j.version : ''
  meta.author = pickAuthor(j.authors)
  meta.description = pickLocalized(j.description)

  const hard = readDepends(j.depends)
  const reco = readDepends(j.recommends)
  const sugg = readDepends(j.suggests)

  meta.depends = hard.ids
  meta.softDepends = [...reco.ids, ...sugg.ids].filter((id) => !hard.ids.includes(id))
  meta.ranges = { ...hard.ranges, ...reco.ranges }

  // environment: "*"（默认，两边都要）/ "client" / "server"
  const env = typeof j.environment === 'string' ? j.environment.trim().toLowerCase() : ''
  meta.side = env === 'client' ? 'client' : env === 'server' ? 'server' : 'both'

  const provides = readDepends(j.provides)
  meta.provides = provides.ids

  // breaks 和 conflicts 都是「装了会出事」，展示上不区分
  meta.breaks = [...readDepends(j.breaks).ids, ...readDepends(j.conflicts).ids]

  return meta
}

/**
 * Forge / NeoForge：META-INF/mods.toml。
 *
 * 只认两种块：
 *   [[mods]]                     自己是谁
 *   [[dependencies.<谁的依赖>]]  依赖谁，mandatory 决定硬软
 * 其余（license、displayTest 之类）不关心。
 */
export function parseModsToml(text: string): ExtMeta {
  const meta = emptyMeta()
  let section = ''

  const values: Record<string, string> = {}
  const deps: { id: string; mandatory: boolean; range: string }[] = []
  let cur: { id: string; mandatory: boolean; range: string } | null = null

  const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '')

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue

    const header = line.match(/^\[\[(.+?)\]\]$/)
    if (header) {
      if (cur) deps.push(cur)
      const name = header[1].trim()
      if (name.startsWith('dependencies.')) cur = { id: '', mandatory: true, range: '' }
      else cur = null
      section = name
      continue
    }
    if (/^\[.+?\]$/.test(line)) {
      // 普通段（[mods.xxx] 之类）——依赖块到此结束
      if (cur) {
        deps.push(cur)
        cur = null
      }
      section = line.slice(1, -1).trim()
      continue
    }

    const kv = line.match(/^([A-Za-z_][\w.]*)\s*=\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const value = unquote(kv[2])

    if (cur) {
      // 依赖块里的 modId / mandatory / versionRange
      if (key === 'modId') cur.id = value
      else if (key === 'mandatory') cur.mandatory = value !== 'false'
      else if (key === 'versionRange') cur.range = value
      continue
    }
    if (section === 'mods' || section.startsWith('mods.')) {
      if (key === 'modId' && !values.modId) values.modId = value
      else if (key === 'displayName' && !values.displayName) values.displayName = value
      else if (key === 'version' && !values.version) values.version = value
      else if (key === 'description' && !values.description) values.description = value
      else if (key === 'authors' && !values.authors) values.authors = value
    }
  }
  if (cur) deps.push(cur)

  meta.id = values.modId ?? ''
  meta.name = values.displayName || values.modId || ''
  meta.version = values.version ?? ''
  meta.author = values.authors ?? ''
  meta.description = values.description ?? ''

  for (const d of deps) {
    if (!d.id) continue
    if (d.mandatory) {
      meta.depends.push(d.id)
      if (d.range) meta.ranges[d.id] = d.range
    } else {
      meta.softDepends.push(d.id)
    }
  }

  return meta
}

/** 老式 Forge：mcmod.info */
export function parseMcmodInfo(json: string): ExtMeta | null {
  const j = parseJson(json) as unknown
  if (!j) return null
  const first = (
    Array.isArray(j) ? j[0] : (j as { modList?: unknown[] })?.modList?.[0]
  ) as Record<string, unknown> | undefined
  if (!first) return null

  const meta = emptyMeta()
  meta.id = String(first.modid ?? '')
  meta.name = String(first.name ?? first.modid ?? '')
  meta.version = String(first.version ?? '')
  meta.author = pickAuthor(first.authorList) || String(first.author ?? '')
  meta.description = String(first.description ?? '')
  return meta
}

/** Bukkit 系：plugin.yml / paper-plugin.yml */
export function parseBukkitMeta(text: string): ExtMeta {
  const y = parseSimpleYaml(text)
  const meta = emptyMeta()
  // 服务端插件不存在「客户端侧」，能装就说明服务端生效
  meta.side = 'server'
  meta.id = y.name || y.id || ''
  meta.name = y.name || y.id || ''
  meta.version = y.version || ''
  meta.author = y.authors || y.author || ''
  meta.description = y.description || ''

  const soft = yamlList(text, 'softdepend')
  // loadbefore 是「我要比它先加载」，它不在时插件照样能跑，按软依赖算
  meta.depends = yamlList(text, 'depend').filter(Boolean)
  meta.softDepends = [...soft, ...yamlList(text, 'loadbefore')].filter(
    (id) => !meta.depends.includes(id)
  )
  meta.provides = yamlList(text, 'provides')
  return meta
}

/** BungeeCord / Waterfall：bungee.yml */
export function parseBungeeMeta(text: string): ExtMeta {
  const y = parseSimpleYaml(text)
  const meta = emptyMeta()
  meta.side = 'server'
  meta.id = y.name || ''
  meta.name = y.name || ''
  meta.version = y.version || ''
  meta.author = y.author || ''
  meta.description = y.description || ''
  meta.depends = yamlList(text, 'depends')
  meta.softDepends = yamlList(text, 'softDepends')
  return meta
}

/** Velocity：velocity-plugin.json */
export function parseVelocityMeta(json: string): ExtMeta | null {
  const j = parseJson(json)
  if (!j) return null
  const meta = emptyMeta()
  meta.id = typeof j.id === 'string' ? j.id : ''
  meta.name = (typeof j.name === 'string' ? j.name : '') || meta.id
  meta.version = typeof j.version === 'string' ? j.version : ''
  meta.author = pickAuthor(j.authors)
  meta.description = pickLocalized(j.description)
  meta.side = 'server'

  const deps = j.dependencies
  if (Array.isArray(deps)) {
    for (const d of deps) {
      const entry = d as { id?: unknown; optional?: unknown }
      if (typeof entry?.id !== 'string') continue
      if (entry.optional) meta.softDepends.push(entry.id)
      else meta.depends.push(entry.id)
    }
  }
  return meta
}

/** MCDR：mcdreforged.plugin.json 的 dependencies 是 {id: 版本要求} */
export function parseMcdrDeps(rawDeps: unknown): { hard: string[]; ranges: Record<string, string> } {
  const hard: string[] = []
  const ranges: Record<string, string> = {}

  if (Array.isArray(rawDeps)) {
    for (const d of rawDeps) if (typeof d === 'string') hard.push(d)
  } else if (rawDeps && typeof rawDeps === 'object') {
    for (const [k, v] of Object.entries(rawDeps as Record<string, unknown>)) {
      hard.push(k)
      // 值形如 {predicate: ">=1.0", suggest: ...}，只在简单字符串时当版本要求
      if (typeof v === 'string') ranges[k] = v
      else if (v && typeof v === 'object') {
        const pred = (v as { predicate?: unknown }).predicate
        if (typeof pred === 'string') ranges[k] = pred
      }
    }
  }

  // mcdreforged 自己不是插件，版本要求由 MCDR 本体管
  return {
    hard: hard.filter((d) => d !== 'mcdreforged'),
    ranges
  }
}

/**
 * 读一个 jar 的元数据。
 *
 * 顺序有讲究：描述文件名越独特的越先判断。
 * mcmod.info 放最后——很多模组会把没用的旧元数据一起打包进来。
 */
export async function readJarMeta(jarPath: string): Promise<ExtMeta> {
  const zip = await ZipReader.open(jarPath)
  if (!zip) return { ...emptyMeta(), broken: true }

  try {
    // 中央目录一条都读不出来 = zip 结构坏了（下载被截断最常见），
    // 这种文件 Java 也读不了，得让界面直接说「重新下载」而不是显示成空条目
    if (!zip.list().length) return { ...emptyMeta(), broken: true }

    const vpj = await zip.read('velocity-plugin.json')
    if (vpj) {
      const m = parseVelocityMeta(vpj)
      if (m) return m
    }

    for (const f of ['bungee.yml', 'plugin.yml', 'paper-plugin.yml', 'bukkit.yml']) {
      const text = await zip.read(f)
      if (text) return parseBukkitMeta(text)
    }

    const fmj = await zip.read('fabric.mod.json')
    if (fmj) {
      const m = parseFabricMeta(fmj)
      if (m) {
        // Fabric API 这种「一个 jar 里装几十个小模组」的写法：
        // 里面每个小模组的 id 都算这个 jar 提供的，不然所有依赖
        // fabric-api-base 的模组都会被报成「缺前置」
        for (const id of await nestedIds(zip, 'META-INF/jars/')) m.provides.push(id)
        m.provides = [...new Set(m.provides)]
        return m
      }
    }

    for (const f of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
      const text = await zip.read(f)
      if (text) {
        const m = parseModsToml(text)
        for (const id of await jarJarIds(zip)) m.provides.push(id)
        m.provides = [...new Set(m.provides)]
        return m
      }
    }

    const mcmod = await zip.read('mcmod.info')
    if (mcmod) {
      const m = parseMcmodInfo(mcmod)
      if (m) return m
    }

    return emptyMeta()
  } finally {
    await zip.close()
  }
}

/** 读 META-INF/jars/ 下的嵌套 jar，返回它们各自的 id */
async function nestedIds(zip: ZipReader, prefix: string): Promise<string[]> {
  const out: string[] = []
  for (const name of zip.list()) {
    if (!name.startsWith(prefix) || !name.toLowerCase().endsWith('.jar')) continue
    const buf = await zip.readBuffer(name, 4 * 1024 * 1024)
    if (!buf) continue
    const inner = await ZipReader.openBuffer(buf)
    if (!inner) continue
    try {
      const json = await inner.read('fabric.mod.json', 256 * 1024)
      if (!json) continue
      const m = parseFabricMeta(json)
      if (m?.id) {
        out.push(m.id, ...m.provides)
      }
    } finally {
      await inner.close()
    }
  }
  return out
}

/**
 * Forge / NeoForge 的嵌套 jar（JarJar）：META-INF/jarjar/metadata.json
 * 列出每个内嵌 jar 的路径，把它们里面的 modId 也算进来。
 */
async function jarJarIds(zip: ZipReader): Promise<string[]> {
  const raw = await zip.read('META-INF/jarjar/metadata.json')
  if (!raw) return []

  let paths: string[] = []
  try {
    const j = JSON.parse(raw) as { jars?: { path?: unknown }[] }
    paths = (j.jars ?? [])
      .map((e) => (typeof e?.path === 'string' ? e.path : ''))
      .filter(Boolean)
  } catch {
    return []
  }

  const out: string[] = []
  for (const p of paths) {
    const buf = await zip.readBuffer(p, 8 * 1024 * 1024)
    if (!buf) continue
    const inner = await ZipReader.openBuffer(buf)
    if (!inner) continue
    try {
      for (const f of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
        const text = await inner.read(f, 512 * 1024)
        if (!text) continue
        const m = parseModsToml(text)
        if (m.id) out.push(m.id)
        break
      }
    } finally {
      await inner.close()
    }
  }
  return out
}
