import { promises as fs } from 'node:fs'
import { resolve, sep, extname, join, basename, relative } from 'node:path'
import type { FileEntry } from '../shared/types'

const MAX_TEXT_BYTES = 4 * 1024 * 1024

/** 把相对路径解析到 root 之内，越界返回 null */
export function safeJoin(root: string, rel: string): string | null {
  if (!root) return null
  const base = resolve(root)
  const full = resolve(base, rel || '.')
  const cmpBase = process.platform === 'win32' ? base.toLowerCase() : base
  const cmpFull = process.platform === 'win32' ? full.toLowerCase() : full
  if (cmpFull !== cmpBase && !cmpFull.startsWith(cmpBase + sep)) return null
  return full
}

/** 界面里显示的相对路径，统一用 / 分隔 */
export function toRel(root: string, full: string): string {
  const r = relative(root, full)
  return r.split(sep).join('/')
}

const TEXT_EXT = new Set([
  '.txt', '.log', '.json', '.yml', '.yaml', '.properties', '.toml', '.conf', '.cfg', '.ini',
  '.md', '.sh', '.bat', '.cmd', '.html', '.css', '.js', '.ts', '.xml', '.csv', '.env', '.gitignore'
])

/** 没有扩展名但通常是文本的文件 */
const TEXT_NAMES = new Set(['eula.txt', 'banned-ips.json', 'server.properties', 'README', 'LICENSE'])

export async function listDir(root: string, rel: string): Promise<FileEntry[]> {
  const full = safeJoin(root, rel)
  if (!full) return []

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(full, { withFileTypes: true })
  } catch {
    return []
  }

  const out: FileEntry[] = []
  for (const e of entries) {
    const p = join(full, e.name)
    let size = 0
    let mtime = 0
    try {
      const st = await fs.stat(p)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      continue
    }
    out.push({
      name: e.name,
      path: toRel(root, p),
      isDir: e.isDirectory(),
      size,
      mtime,
      ext: e.isDirectory() ? '' : extname(e.name).toLowerCase(),
      hidden: e.name.startsWith('.')
    })
  }

  // 目录在前，然后按名称排序（忽略大小写）
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
  })
  return out
}

export interface ReadResult {
  content: string
  size: number
  truncated: boolean
  binary: boolean
}

export async function readTextFile(root: string, rel: string): Promise<ReadResult> {
  const full = safeJoin(root, rel)
  if (!full) return { content: '', size: 0, truncated: false, binary: false }

  const st = await fs.stat(full)
  const truncated = st.size > MAX_TEXT_BYTES
  const fh = await fs.open(full, 'r')
  try {
    const len = Math.min(st.size, MAX_TEXT_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)

    const probe = buf.subarray(0, Math.min(8192, buf.length))
    const binary = probe.includes(0)
    if (binary) return { content: '', size: st.size, truncated, binary: true }

    let content = buf.toString('utf-8')
    // UTF-8 解出来大量替换字符，说明多半是 GBK
    const bad = (content.match(/�/g) || []).length
    if (bad > 2) {
      try {
        const gbk = new TextDecoder('gbk').decode(buf)
        if ((gbk.match(/�/g) || []).length < bad) content = gbk
      } catch {
        /* 保持 utf-8 */
      }
    }
    // 去掉 BOM
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)

    return { content, size: st.size, truncated, binary: false }
  } finally {
    await fh.close()
  }
}

export async function writeTextFile(root: string, rel: string, content: string): Promise<void> {
  const full = safeJoin(root, rel)
  if (!full) throw new Error('路径越界')
  await fs.mkdir(resolve(full, '..'), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}

export async function createDir(root: string, rel: string): Promise<void> {
  const full = safeJoin(root, rel)
  if (!full) throw new Error('路径越界')
  await fs.mkdir(full, { recursive: true })
}

export async function renamePath(root: string, rel: string, newName: string): Promise<void> {
  const full = safeJoin(root, rel)
  if (!full) throw new Error('路径越界')
  if (/[\\/:*?"<>|]/.test(newName) || !newName.trim()) throw new Error('名称包含非法字符')
  await fs.rename(full, join(resolve(full, '..'), newName))
}

/**
 * 文件是不是被别的进程占着。
 *
 * 为什么用改名来探：「打开看看能不能写」在 Windows 上探不出来——Python 的
 * open() 用的是共享读写模式，另一个进程占着文件时照样能打开；真正会失败的
 * 是改名 / 删除这类需要独占的操作（MCDR 轮转日志就栽在 unlink 上）。
 * 改名成自己没有任何副作用：成功说明没人占，抛 EBUSY/EPERM 说明有人占。
 */
export async function fileLockInfo(
  path: string
): Promise<{ locked: boolean; size: number } | null> {
  let size = 0
  try {
    size = (await fs.stat(path)).size
  } catch {
    return null // 文件还不存在，也就谈不上占用
  }

  try {
    await fs.rename(path, path)
    return { locked: false, size }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return { locked: true, size }
    // 其它错误（路径不对之类）当作没探出来，别拿它去拦启动
    return null
  }
}

/**
 * 删除到回收站，避免误删世界存档无法恢复。
 *
 * 回收站不可用时退回直接删除，并把实际用的方式返回去——界面得如实告诉
 * 用户文件到底还能不能找回来，不能一律说「已移到回收站」。
 */
export async function deletePath(
  root: string,
  rel: string,
  trash: (p: string) => Promise<void>
): Promise<'trash' | 'permanent'> {
  const full = safeJoin(root, rel)
  if (!full) throw new Error('路径越界')
  try {
    await trash(full)
    return 'trash'
  } catch {
    await fs.rm(full, { recursive: true, force: true })
    return 'permanent'
  }
}

export function isProbablyText(name: string): boolean {
  const base = basename(name)
  if (TEXT_NAMES.has(base)) return true
  const ext = extname(base).toLowerCase()
  return TEXT_EXT.has(ext)
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export interface DirSizeResult {
  bytes: number
  files: number
  /** 超出时间预算就是估算值，不是精确值 */
  partial: boolean
}

/**
 * 递归统计目录体积。
 *
 * 世界存档动辄几个 GB，不能为了显示一个数字把界面卡住：
 * 带时间预算，超时就返回已经统计到的部分并标记 partial，
 * 由界面显示成「≥ 2.3 GB」而不是假装是精确值。
 */
export async function dirSize(absDir: string, budgetMs = 3000): Promise<DirSizeResult> {
  const deadline = Date.now() + budgetMs
  let bytes = 0
  let files = 0
  let partial = false
  const stack = [absDir]

  while (stack.length) {
    if (Date.now() > deadline) {
      partial = true
      break
    }
    const cur = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.isFile()) {
        try {
          bytes += (await fs.stat(p)).size
          files++
        } catch {
          /* 单个文件读不到就跳过 */
        }
      }
    }
  }

  return { bytes, files, partial }
}
