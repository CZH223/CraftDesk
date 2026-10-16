import { promises as fs } from 'node:fs'
import { join, basename, resolve, relative, sep } from 'node:path'
import type { BackupInfo } from '../shared/types'
import { safeJoin } from './files'

export const BACKUP_DIR = 'backups'

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function dirSize(dir: string, budgetMs = 2000): Promise<number> {
  const deadline = Date.now() + budgetMs
  let total = 0
  const stack = [dir]
  while (stack.length) {
    if (Date.now() > deadline) break
    const cur = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else {
        try {
          total += (await fs.stat(p)).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total
}

/**
 * 递归复制服务端目录。skip 里的相对路径会被排除，
 * 用来避免把 backups 自身再备份一遍。
 */
async function copyTree(src: string, dst: string, skip: Set<string>, root: string): Promise<number> {
  await fs.mkdir(dst, { recursive: true })
  let copied = 0

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(src, { withFileTypes: true })
  } catch {
    return 0
  }

  for (const e of entries) {
    const from = join(src, e.name)
    const rel = relative(root, from).split(sep).join('/')
    if (skip.has(rel)) continue
    const to = join(dst, e.name)

    if (e.isDirectory()) {
      copied += await copyTree(from, to, skip, root)
    } else if (e.isFile()) {
      try {
        await fs.copyFile(from, to)
        copied++
      } catch {
        /* 单个文件失败不影响整体 */
      }
    }
  }
  return copied
}

export async function listBackups(serverDir: string): Promise<BackupInfo[]> {
  const root = join(serverDir, BACKUP_DIR)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const out: BackupInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(root, e.name)
    let createdAt = 0
    try {
      createdAt = (await fs.stat(p)).mtimeMs
    } catch {
      /* ignore */
    }
    out.push({
      name: e.name,
      path: `${BACKUP_DIR}/${e.name}`,
      size: await dirSize(p),
      createdAt
    })
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export async function createBackup(
  serverDir: string,
  label: string,
  onProgress?: (msg: string) => void
): Promise<BackupInfo> {
  const safeLabel = (label || '').replace(/[\\/:*?"<>|]/g, '').trim()
  const name = safeLabel ? `${stamp()}-${safeLabel}` : stamp()
  const dst = safeJoin(serverDir, `${BACKUP_DIR}/${name}`)
  if (!dst) throw new Error('备份路径越界')

  onProgress?.('正在复制文件…')
  const copied = await copyTree(serverDir, dst, new Set([BACKUP_DIR]), serverDir)
  onProgress?.(`已复制 ${copied} 个文件`)

  const st = await fs.stat(dst)
  return {
    name,
    path: `${BACKUP_DIR}/${name}`,
    size: await dirSize(dst),
    createdAt: st.mtimeMs
  }
}

export async function deleteBackup(serverDir: string, relPath: string): Promise<void> {
  const full = safeJoin(serverDir, relPath)
  if (!full) throw new Error('路径越界')
  const rel = relative(serverDir, full).split(sep).join('/')
  if (!rel.startsWith(`${BACKUP_DIR}/`)) throw new Error('只能删除备份目录内的文件')
  await fs.rm(full, { recursive: true, force: true })
}

/**
 * 还原备份。会先把当前内容里即将被覆盖的项移到一个 .before-restore 目录，
 * 出问题还能捞回来。调用方必须确保服务器已经停止。
 */
export async function restoreBackup(serverDir: string, relPath: string): Promise<string> {
  const src = safeJoin(serverDir, relPath)
  if (!src) throw new Error('路径越界')
  const rel = relative(serverDir, src).split(sep).join('/')
  if (!rel.startsWith(`${BACKUP_DIR}/`)) throw new Error('只能还原备份目录内的内容')

  const rescueName = `.before-restore-${stamp()}`
  const rescue = join(serverDir, rescueName)
  await fs.mkdir(rescue, { recursive: true })

  // 把当前内容（除 backups 和救援目录）挪走
  const entries = await fs.readdir(serverDir, { withFileTypes: true })
  for (const e of entries) {
    if (e.name === BACKUP_DIR || e.name.startsWith('.before-restore-')) continue
    try {
      await fs.rename(join(serverDir, e.name), join(rescue, e.name))
    } catch {
      /* 挪不动就跳过，稍后被覆盖 */
    }
  }

  await copyTree(src, serverDir, new Set(), src)
  return rescueName
}

export function backupSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export { basename, resolve }
