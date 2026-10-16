import { promises as fs } from 'node:fs'
import { join, relative, sep, extname, basename } from 'node:path'
import type { ConfigFile } from '../shared/types'
import type { ServerLayout } from './layout'

/** 这些扩展名基本可以确定是文本配置 */
const TEXT_EXTS = new Set([
  '.yml',
  '.yaml',
  '.json',
  '.json5',
  '.toml',
  '.properties',
  '.txt',
  '.conf',
  '.cfg',
  '.ini',
  '.env',
  '.md'
])

/** 有些目录是缓存/日志，翻进去没意义 */
const SKIP_DIRS = new Set([
  '__pycache__',
  'node_modules',
  '.git',
  'logs',
  'cache',
  'backups',
  '.cache'
])

const MAX_DEPTH = 4
const MAX_FILES = 600

interface WalkOptions {
  root: string
  configRoot: string
  source: 'mcdr' | 'server'
  out: ConfigFile[]
}

async function walk(dir: string, depth: number, opts: WalkOptions): Promise<void> {
  if (depth > MAX_DEPTH || opts.out.length >= MAX_FILES) return

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const e of entries) {
    if (opts.out.length >= MAX_FILES) return
    if (e.name.startsWith('.') && e.name !== '.env') continue

    const full = join(dir, e.name)

    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue
      await walk(full, depth + 1, opts)
      continue
    }
    if (!e.isFile()) continue

    // .bak / .old 之类的备份副本也留着，用户有时正需要翻
    const ext = extname(e.name.toLowerCase().replace(/\.(bak|old|orig)$/, ''))
    if (!TEXT_EXTS.has(ext)) continue

    let size = 0
    let mtime = 0
    try {
      const st = await fs.stat(full)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      continue
    }

    const relFromConfig = relative(opts.configRoot, full).split(sep)
    // 分组名取配置根目录下的第一层子目录，直接放在根目录的归到 "."
    const group = relFromConfig.length > 1 ? relFromConfig[0] : '.'

    opts.out.push({
      name: basename(full),
      path: relative(opts.root, full).split(sep).join('/'),
      size,
      mtime,
      source: opts.source,
      group
    })
  }
}

/**
 * 列出一个服务器上所有可编辑的配置文件。
 *
 * 两处来源刻意分开：
 * - mcdr   ：MCDReforged 自己的 config.yml 和 config/（Python 插件的配置）
 * - server ：Minecraft 服务端的 config/（模组的配置）
 * 它们在磁盘上是两个不同的目录，混在一起用户会找不到东西。
 */
export async function listConfigs(layout: ServerLayout): Promise<ConfigFile[]> {
  const out: ConfigFile[] = []

  // MCDR 主配置单独列一条，它决定启动命令，最常改
  if (layout.mcdrConfigFile) {
    try {
      const st = await fs.stat(layout.mcdrConfigFile)
      out.push({
        name: basename(layout.mcdrConfigFile),
        path: relative(layout.root, layout.mcdrConfigFile).split(sep).join('/'),
        size: st.size,
        mtime: st.mtimeMs,
        source: 'mcdr',
        group: '.'
      })
    } catch {
      /* 文件被删了 */
    }
  }

  if (layout.mcdrConfigDir) {
    await walk(layout.mcdrConfigDir, 0, {
      root: layout.root,
      configRoot: layout.mcdrConfigDir,
      source: 'mcdr',
      out
    })
  }

  if (layout.configDir) {
    await walk(layout.configDir, 0, {
      root: layout.root,
      configRoot: layout.configDir,
      source: 'server',
      out
    })
  }

  out.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'mcdr' ? -1 : 1
    if (a.group !== b.group) {
      if (a.group === '.') return -1
      if (b.group === '.') return 1
      return a.group.localeCompare(b.group, 'zh-CN', { sensitivity: 'base' })
    }
    return a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' })
  })

  return out
}
