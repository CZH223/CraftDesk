import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { parse, resolve, sep } from 'node:path'

/**
 * 删除的守门逻辑。
 *
 * 删整台服务器是这个软件里破坏性最强的一步，一旦删错就是把别人几个月
 * 的世界存档抹掉，所以这里的原则是「宁可拒绝，不要猜」：
 * 路径看着不对就直接拒绝，回收站用不了也直接拒绝，绝不静默改成永久删除。
 */

/** Windows 下比较路径要忽略大小写 */
function norm(p: string): string {
  const full = resolve(p)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

/** child 是否在 parent 里面（不含相等） */
export function isInside(parent: string, child: string): boolean {
  const p = norm(parent)
  const c = norm(child)
  return c !== p && c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * 这个目录能不能整个删掉。返回拒绝原因，null 表示可以。
 *
 * `protectedDirs` 由调用方传入（比如应用自己的数据目录）——这里不直接
 * import electron，是为了这段逻辑能脱离 Electron 单独跑测试。
 */
export function whyNotDeletable(dir: string, protectedDirs: string[] = []): string | null {
  if (!dir || !dir.trim()) return '这台服务器没有记录目录'

  const full = resolve(dir)
  const parsed = parse(full)

  // 盘符根 / 文件系统根：M:\ 或 /
  if (full === parsed.root || full + sep === parsed.root) {
    return `${full} 是磁盘根目录，不像是服务器目录`
  }

  // 只挂在磁盘根目录下面一层的（D:\servers、/home 这种），删掉它
  // 牵连的东西太多，不值得赌。正常导入的服务器都是 盘:\某处\服务器名 这个深度。
  // 这条比看上去严，是有意的：删错的代价是不可逆的，删不掉只是麻烦。
  const depth = full.slice(parsed.root.length).split(sep).filter(Boolean).length
  if (depth < 2) {
    return (
      `${full} 直接挂在磁盘根目录下，删掉它可能牵连别的文件夹。` +
      `确实要删这个目录的话，请在资源管理器里手动删。`
    )
  }

  if (samePath(full, homedir())) return '这是当前用户的主目录'

  for (const p of protectedDirs) {
    if (!p) continue
    if (samePath(full, p)) return `${full} 是 CraftDesk 自己的数据目录`
    // 目标目录里装着 CraftDesk 的数据，删了等于把服务器列表也一起删了
    if (isInside(full, p)) return `CraftDesk 的数据目录（${p}）在它里面，删除会连带丢失服务器列表`
  }

  return null
}

/**
 * 把整个目录移进回收站。
 *
 * 这里**故意不做 fs.rm 兜底**：调用方（界面）向用户承诺的是「可以恢复」，
 * 回收站失败就说明这个承诺兑现不了，那就别删——报错让用户手动处理，
 * 总好过嘴上说可恢复、实际上永久删掉。
 */
export async function trashDirectory(
  dir: string,
  trash: (p: string) => Promise<void>
): Promise<void> {
  const full = resolve(dir)
  let st: import('node:fs').Stats
  try {
    st = await fs.stat(full)
  } catch {
    throw new Error(`目录不存在：${full}`)
  }
  if (!st.isDirectory()) throw new Error(`${full} 不是目录`)

  try {
    await trash(full)
  } catch (err) {
    throw new Error(
      `${full} 无法移入回收站（${err instanceof Error ? err.message : String(err)}），` +
        `已取消删除。需要的话请手动删除这个目录。`
    )
  }
}
