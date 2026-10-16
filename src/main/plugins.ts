import { promises as fs } from 'node:fs'
import { join, basename, relative, sep } from 'node:path'
import type { PluginInfo, PluginKind } from '../shared/types'
import { ZipReader } from './zip'
import { emptyMeta, parseMcdrDeps, pickAuthor, pickLocalized, readJarMeta } from './extmeta'
import { buildRelations } from './relations'
import { safeJoin } from './files'
import { isInside } from './removal'
import type { ServerLayout } from './layout'

/** 新条目先铺好依赖关系的空位，最后统一由 buildRelations 填 */
function emptyRelations(): Pick<
  PluginInfo,
  | 'depends'
  | 'softDepends'
  | 'provides'
  | 'breaks'
  | 'ranges'
  | 'broken'
  | 'side'
  | 'requires'
  | 'usedBy'
> {
  return {
    depends: [],
    softDepends: [],
    provides: [],
    breaks: [],
    ranges: {},
    broken: false,
    // MCDR 插件跑在服务端的包装层里，属于服务端侧
    side: 'server',
    requires: [],
    usedBy: []
  }
}

interface McdrMeta {
  id: string
  name: string
  version: string
  author: string
  description: string
  dependencies: string[]
  ranges: Record<string, string>
}

/** 解析 mcdreforged.plugin.json 的内容 */
function parseMcdrMeta(raw: string): Partial<McdrMeta> {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    const { hard, ranges } = parseMcdrDeps(j.dependencies)
    return {
      id: typeof j.id === 'string' ? j.id : '',
      name: typeof j.name === 'string' ? j.name : '',
      version: typeof j.version === 'string' ? j.version : '',
      author: pickAuthor(j.author),
      description: pickLocalized(j.description),
      dependencies: hard,
      ranges
    }
  } catch {
    return {}
  }
}

/** 从单文件 .py 插件的 PLUGIN_METADATA 里抠出 id、版本与依赖 */
function parsePyMetadata(text: string): Partial<McdrMeta> {
  const block = text.match(/PLUGIN_METADATA\s*=\s*\{[\s\S]*?\n\}/)
  if (!block) return {}
  const body = block[0]
  const get = (key: string): string =>
    body.match(new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]*)['"]`))?.[1] ?? ''

  const depsBlock = body.match(/['"]dependencies['"]\s*:\s*\[([\s\S]*?)\]/)
  const dependencies = depsBlock
    ? [...depsBlock[1].matchAll(/['"]([^'"]+)['"]/g)]
        .map((m) => m[1])
        .filter((d) => d !== 'mcdreforged')
    : []

  return {
    id: get('id'),
    version: get('version'),
    author: get('author'),
    description: get('description'),
    dependencies,
    ranges: {}
  }
}

const MCDR_META_NAMES = ['mcdreforged.plugin.json', 'mcdr.plugin.json']

/** 读一个 MCDR 插件包的元数据（.mcdr / .pyz 本质都是 zip） */
async function readMcdrPackMeta(file: string): Promise<Partial<McdrMeta>> {
  const zip = await ZipReader.open(file)
  if (!zip) return {}
  try {
    for (const name of MCDR_META_NAMES) {
      const raw = await zip.read(name)
      if (raw) return parseMcdrMeta(raw)
    }
    // 有些包把元数据放在顶层目录里
    const nested = zip.list().find((n) => MCDR_META_NAMES.some((m) => n.endsWith(`/${m}`)))
    if (nested) {
      const raw = await zip.read(nested)
      if (raw) return parseMcdrMeta(raw)
    }
    return {}
  } finally {
    await zip.close()
  }
}

/** 目录式 MCDR 插件：目录里有 mcdreforged.plugin.json */
async function readMcdrDirMeta(dir: string): Promise<Partial<McdrMeta>> {
  for (const name of MCDR_META_NAMES) {
    try {
      return parseMcdrMeta(await fs.readFile(join(dir, name), 'utf-8'))
    } catch {
      /* 下一个 */
    }
  }
  return {}
}

/** 扫一个目录本身（不递归），收集 MCDR 插件 */
async function scanMcdrPlugins(
  layout: ServerLayout,
  dir: string,
  groupRel: string
): Promise<PluginInfo[]> {
  const out: PluginInfo[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }

  const packExts = ['.mcdr', '.pyz']

  for (const e of entries) {
    // 目录式插件
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === '__pycache__') continue
      const full = join(dir, e.name)
      const disabled = e.name.endsWith('.disabled')
      let meta: Partial<McdrMeta> = {}
      try {
        meta = await readMcdrDirMeta(full)
      } catch {
        /* 不是插件目录就跳过 */
      }
      if (!meta.id && !meta.name) continue

      let size = 0
      try {
        size = (await fs.stat(full)).size
      } catch {
        /* ignore */
      }
      const relPath = relative(layout.root, full).split(sep).join('/')
      out.push({
        ...emptyRelations(),
        id: meta.id || e.name,
        name: meta.name || meta.id || e.name.replace(/\.disabled$/, ''),
        file: e.name,
        path: relPath,
        size,
        enabled: !disabled,
        kind: 'mcdr',
        version: meta.version || '',
        author: meta.author || '',
        description: meta.description || '',
        // MCDR 的 dependencies 全是硬前置，另外单独留一份给下载扩展界面用
        dependencies: meta.dependencies || [],
        depends: meta.dependencies || [],
        ranges: meta.ranges || {},
        group: groupRel
      })
      continue
    }

    if (!e.isFile()) continue

    const lower = e.name.toLowerCase()
    const disabled = lower.endsWith('.disabled')
    const bare = disabled ? e.name.replace(/\.disabled$/i, '') : e.name
    const bareLower = bare.toLowerCase()

    // 只认插件包与单文件插件，其它东西不是插件
    const isPack = packExts.some((x) => bareLower.endsWith(x))
    const isSingle = bareLower.endsWith('.py')
    if (!isPack && !isSingle) continue
    if (bareLower.startsWith('__')) continue

    const full = join(dir, e.name)
    let size = 0
    try {
      size = (await fs.stat(full)).size
    } catch {
      /* ignore */
    }

    let meta: Partial<McdrMeta> = {}
    try {
      meta = isPack
        ? await readMcdrPackMeta(full)
        : parsePyMetadata(await fs.readFile(full, 'utf-8'))
    } catch {
      /* 元数据读不出来就只显示文件名 */
    }

    // 文件名形如 QuickBackupM-v1.10.1.mcdr，元数据缺失时从名字里补
    const nameMatch = bare.match(/^(.*?)-v?(\d[\w.+-]*)$/)
    const fallbackName = (nameMatch?.[1] ?? basename(bare, bareLower.slice(bareLower.lastIndexOf('.')))).trim()

    out.push({
      ...emptyRelations(),
      id: meta.id || '',
      name: meta.name || meta.id || fallbackName,
      file: e.name,
      path: relative(layout.root, full).split(sep).join('/'),
      size,
      enabled: !disabled,
      kind: 'mcdr',
      version: meta.version || nameMatch?.[2] || '',
      author: meta.author || '',
      description: meta.description || '',
      dependencies: meta.dependencies || [],
      depends: meta.dependencies || [],
      ranges: meta.ranges || {},
      group: groupRel
    })
  }

  return out
}

/** 扫 jar 目录（服务端插件或模组） */
async function scanJars(
  layout: ServerLayout,
  dir: string,
  kind: PluginKind
): Promise<PluginInfo[]> {
  const out: PluginInfo[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }

  const jars = entries.filter((e) => e.isFile() && /\.jar(\.disabled)?$/i.test(e.name))
  // 分批读取，避免同时打开过多文件
  const BATCH = 8
  for (let i = 0; i < jars.length; i += BATCH) {
    const slice = jars.slice(i, i + BATCH)
    const results = await Promise.all(
      slice.map(async (e) => {
        const full = join(dir, e.name)
        const disabled = e.name.toLowerCase().endsWith('.disabled')
        const base = disabled ? e.name.replace(/\.disabled$/i, '') : e.name
        let size = 0
        try {
          size = (await fs.stat(full)).size
        } catch {
          /* ignore */
        }

        let meta = emptyMeta()
        try {
          meta = await readJarMeta(full)
        } catch {
          /* 元数据读不出来就只显示文件名 */
        }

        const relPath = relative(layout.root, full).split(sep).join('/')
        const groupRel = relative(layout.root, dir).split(sep).join('/')
        const info: PluginInfo = {
          id: meta.id,
          name: meta.name || basename(base, '.jar'),
          file: e.name,
          path: relPath,
          size,
          enabled: !disabled,
          kind,
          version: meta.version,
          author: meta.author,
          description: meta.description,
          dependencies: [],
          depends: meta.depends,
          softDepends: meta.softDepends,
          provides: meta.provides,
          breaks: meta.breaks,
          ranges: meta.ranges,
          broken: meta.broken,
          side: meta.side,
          requires: [],
          usedBy: [],
          group: groupRel
        }
        return info
      })
    )
    out.push(...results)
  }

  return out
}

/**
 * 收集一个服务器上的全部扩展。
 * 三类分开扫描、分开标注，界面上不会再把 MCDR 的 Python 插件
 * 和 Minecraft 的模组混在一起。
 */
export async function listPlugins(layout: ServerLayout): Promise<PluginInfo[]> {
  const jobs: Promise<PluginInfo[]>[] = []

  if (layout.mcdrPluginsDir) {
    const groupRel = relative(layout.root, layout.mcdrPluginsDir).split(sep).join('/')
    jobs.push(scanMcdrPlugins(layout, layout.mcdrPluginsDir, groupRel))
  }
  if (layout.mcPluginsDir) {
    // 代理端的 plugins/ 装的是 Velocity / BungeeCord 插件，不是服务端插件
    jobs.push(scanJars(layout, layout.mcPluginsDir, layout.isProxy ? 'proxy' : 'plugin'))
  }
  if (layout.modsDir) {
    jobs.push(scanJars(layout, layout.modsDir, 'mod'))
  }

  const results = (await Promise.all(jobs)).flat()

  // 依赖关系要等所有扩展都扫完才能算：跨目录、跨加载器的引用都得对上
  buildRelations(results)

  const rank: Record<PluginKind, number> = { mcdr: 0, proxy: 1, plugin: 2, mod: 3 }
  results.sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind]
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' })
  })
  return results
}

/**
 * 删除扩展时的守门：把「相对服务器根目录的路径」解析成绝对路径，
 * 并且要求它确实落在布局解析出来的扩展目录里。
 *
 * 界面传进来的只是一个字符串，要是它指向 server.properties 或者世界存档，
 * 光靠界面自觉是拦不住的——删除这个动作必须自己认路。
 */
export function resolveExtensionFile(layout: ServerLayout, relPath: string): string {
  const full = safeJoin(layout.root, relPath)
  if (!full) throw new Error('路径越界')

  const dirs = [layout.mcdrPluginsDir, layout.mcPluginsDir, layout.modsDir].filter(
    (d): d is string => Boolean(d)
  )
  if (!dirs.some((d) => isInside(d, full))) {
    throw new Error('只能删除插件与模组目录里的文件')
  }
  return full
}

/** 启用 / 禁用：改扩展名，和大多数面板的做法一致 */
export async function togglePlugin(rootDir: string, relPath: string): Promise<string> {
  const full = join(rootDir, relPath)
  const disabled = full.toLowerCase().endsWith('.disabled')
  const target = disabled ? full.replace(/\.disabled$/i, '') : `${full}.disabled`
  await fs.rename(full, target)
  return relative(rootDir, target).split(sep).join('/')
}
