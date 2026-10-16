import { promises as fs } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

interface CentralEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

/**
 * 数据来源：磁盘上的文件，或者已经在内存里的字节。
 *
 * 后者是为了读「嵌套 jar」——Fabric API 那种把 44 个小模组打包在一个 jar 里
 * （META-INF/jars/*.jar）的写法，得先把里层 jar 的字节读出来才能看它的 id。
 */
interface Source {
  size: number
  readAt(pos: number, len: number): Promise<Buffer>
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50

/**
 * 只读 ZIP 中央目录，按需解压指定条目。
 * 用来从插件/模组 jar 里读出名称、版本和依赖关系，
 * 避免为了看一眼元数据把整个 jar 读进内存。
 */
export class ZipReader {
  private constructor(
    private readonly src: Source,
    private readonly entries: CentralEntry[],
    private readonly closer: (() => Promise<void>) | null
  ) {}

  static async open(file: string): Promise<ZipReader | null> {
    let fh: import('node:fs/promises').FileHandle | null = null
    try {
      fh = await fs.open(file, 'r')
      const st = await fh.stat()
      const src: Source = {
        size: st.size,
        readAt: async (pos, len) => {
          const buf = Buffer.alloc(len)
          if (len > 0) await fh!.read(buf, 0, len, pos)
          return buf
        }
      }
      const entries = await readCentralDirectory(src)
      if (!entries) {
        await fh.close()
        return null
      }
      return new ZipReader(src, entries, async () => {
        await fh!.close()
      })
    } catch {
      try {
        await fh?.close()
      } catch {
        /* ignore */
      }
      return null
    }
  }

  /** 直接读内存里的一份 zip（嵌套 jar 用） */
  static async openBuffer(buf: Buffer): Promise<ZipReader | null> {
    const src: Source = {
      size: buf.length,
      readAt: async (pos, len) => buf.subarray(pos, pos + len)
    }
    const entries = await readCentralDirectory(src)
    return entries ? new ZipReader(src, entries, null) : null
  }

  list(): string[] {
    return this.entries.map((e) => e.name)
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name)
  }

  /** 读取一个条目，找不到或解压失败返回 null */
  async read(name: string, maxBytes = 512 * 1024): Promise<string | null> {
    const raw = await this.readBuffer(name, maxBytes)
    return raw ? raw.toString('utf-8') : null
  }

  /** 读原始字节（嵌套 jar 要靠它） */
  async readBuffer(name: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | null> {
    const entry = this.entries.find((e) => e.name === name)
    if (!entry) return null
    if (entry.uncompressedSize > maxBytes) return null

    try {
      const header = await this.src.readAt(entry.localOffset, 30)
      const nameLen = header.readUInt16LE(26)
      const extraLen = header.readUInt16LE(28)
      const dataStart = entry.localOffset + 30 + nameLen + extraLen

      const raw =
        entry.compressedSize > 0
          ? await this.src.readAt(dataStart, entry.compressedSize)
          : Buffer.alloc(0)

      if (entry.method === 0) return raw
      if (entry.method === 8) return inflateRawSync(raw)
      return null
    } catch {
      return null
    }
  }

  async close(): Promise<void> {
    await this.closer?.()
  }
}

/** 从尾部找 EOCD，再读中央目录。坏文件一律返回 null，不抛 */
async function readCentralDirectory(src: Source): Promise<CentralEntry[] | null> {
  if (src.size < 22) return null

  // 从尾部往前找 EOCD 签名（最多回退 64KB + 22）
  const tailLen = Math.min(src.size, 65558)
  const tail = await src.readAt(src.size - tailLen, tailLen)

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null

  const count = tail.readUInt16LE(eocd + 10)
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cdOffset = tail.readUInt32LE(eocd + 16)

  // zip64 不支持（插件 jar 基本不会用到）
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) return null

  const cd = await src.readAt(cdOffset, cdSize)

  const entries: CentralEntry[] = []
  let p = 0
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
    const method = cd.readUInt16LE(p + 10)
    const compressedSize = cd.readUInt32LE(p + 20)
    const uncompressedSize = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const localOffset = cd.readUInt32LE(p + 42)
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf-8')
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }

  return entries
}

/** 解析 plugin.yml 这种简单的扁平 YAML，够用即可 */
export function parseSimpleYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

/**
 * 取一个 YAML 键的值，顺便把列表拆出来。
 * 三种写法都要认，插件描述文件里都出现过：
 *   depend: [Vault, PlaceholderAPI]
 *   depend: Vault
 *   depend:
 *     - Vault
 */
export function yamlList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/)
    if (!m || m[1] !== key) continue

    const inline = m[2].trim()
    if (inline) {
      const bracket = inline.match(/^\[(.*)\]$/)
      const body = bracket ? bracket[1] : inline
      return body
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    }

    // 块状列表：往下读缩进更深的 - xxx
    const out: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      const item = line.match(/^\s+-\s*(.+?)\s*$/)
      if (!item) break
      out.push(item[1].replace(/^["']|["']$/g, ''))
    }
    return out
  }

  return []
}
