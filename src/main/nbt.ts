/**
 * 最小 NBT 解析器（只读）。
 *
 * 地图预览要读 region 文件里的区块数据，而项目不引运行时依赖，
 * 所以这里只实现区域文件里会出现的那几种标签：
 * 标量、字符串、数组、列表、Compound。够用就好，不做写入。
 */

export type NbtCompound = Record<string, unknown>

const TAG_END = 0
const TAG_BYTE = 1
const TAG_SHORT = 2
const TAG_INT = 3
const TAG_LONG = 4
const TAG_FLOAT = 5
const TAG_DOUBLE = 6
const TAG_BYTE_ARRAY = 7
const TAG_STRING = 8
const TAG_LIST = 9
const TAG_COMPOUND = 10
const TAG_INT_ARRAY = 11
const TAG_LONG_ARRAY = 12

const MAX_DEPTH = 256

class Reader {
  pos = 0

  constructor(readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('NBT 数据越界')
  }

  u8(): number {
    this.need(1)
    return this.buf[this.pos++]
  }

  i8(): number {
    this.need(1)
    return this.buf.readInt8(this.pos++)
  }

  u16(): number {
    this.need(2)
    const v = this.buf.readUInt16BE(this.pos)
    this.pos += 2
    return v
  }

  i16(): number {
    this.need(2)
    const v = this.buf.readInt16BE(this.pos)
    this.pos += 2
    return v
  }

  i32(): number {
    this.need(4)
    const v = this.buf.readInt32BE(this.pos)
    this.pos += 4
    return v
  }

  i64(): bigint {
    this.need(8)
    const v = this.buf.readBigInt64BE(this.pos)
    this.pos += 8
    return v
  }

  f32(): number {
    this.need(4)
    const v = this.buf.readFloatBE(this.pos)
    this.pos += 4
    return v
  }

  f64(): number {
    this.need(8)
    const v = this.buf.readDoubleBE(this.pos)
    this.pos += 8
    return v
  }

  str(): string {
    const len = this.u16()
    this.need(len)
    const s = this.buf.toString('utf8', this.pos, this.pos + len)
    this.pos += len
    return s
  }

  bytes(n: number): Buffer {
    this.need(n)
    const b = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return b
  }

  /** 跳过一段标签，不做任何分配（区块里一大半数据是我们不看的实体/方块实体） */
  skip(type: number, depth = 0): void {
    if (depth > MAX_DEPTH) throw new Error('NBT 嵌套过深')
    switch (type) {
      case TAG_BYTE:
        this.pos += 1
        break
      case TAG_SHORT:
        this.pos += 2
        break
      case TAG_INT:
      case TAG_FLOAT:
        this.pos += 4
        break
      case TAG_LONG:
      case TAG_DOUBLE:
        this.pos += 8
        break
      case TAG_BYTE_ARRAY: {
        const n = this.i32()
        this.pos += Math.max(0, n)
        break
      }
      case TAG_STRING: {
        const n = this.u16()
        this.pos += n
        break
      }
      case TAG_LIST: {
        const itemType = this.u8()
        const n = this.i32()
        for (let i = 0; i < n; i++) this.skip(itemType, depth + 1)
        break
      }
      case TAG_COMPOUND: {
        for (;;) {
          const t = this.u8()
          if (t === TAG_END) break
          this.str()
          this.skip(t, depth + 1)
        }
        break
      }
      case TAG_INT_ARRAY: {
        const n = this.i32()
        this.pos += Math.max(0, n) * 4
        break
      }
      case TAG_LONG_ARRAY: {
        const n = this.i32()
        this.pos += Math.max(0, n) * 8
        break
      }
      default:
        throw new Error(`未知 NBT 标签类型 ${type}`)
    }
    if (this.pos > this.buf.length) throw new Error('NBT 数据越界')
  }
}

function readPayload(r: Reader, type: number, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('NBT 嵌套过深')
  switch (type) {
    case TAG_BYTE:
      return r.i8()
    case TAG_SHORT:
      return r.i16()
    case TAG_INT:
      return r.i32()
    case TAG_LONG:
      return r.i64()
    case TAG_FLOAT:
      return r.f32()
    case TAG_DOUBLE:
      return r.f64()
    case TAG_BYTE_ARRAY: {
      const n = r.i32()
      if (n < 0 || n > 64 * 1024 * 1024) throw new Error('NBT 字节数组长度异常')
      return Buffer.from(r.bytes(n))
    }
    case TAG_STRING:
      return r.str()
    case TAG_LIST: {
      const itemType = r.u8()
      const n = r.i32()
      if (n < 0 || n > 16 * 1024 * 1024) throw new Error('NBT 列表长度异常')
      const out: unknown[] = new Array(n)
      for (let i = 0; i < n; i++) out[i] = readPayload(r, itemType, depth + 1)
      return out
    }
    case TAG_COMPOUND: {
      const out: NbtCompound = {}
      for (;;) {
        const t = r.u8()
        if (t === TAG_END) break
        const name = r.str()
        out[name] = readPayload(r, t, depth + 1)
      }
      return out
    }
    case TAG_INT_ARRAY: {
      const n = r.i32()
      if (n < 0 || n > 16 * 1024 * 1024) throw new Error('NBT 整型数组长度异常')
      const out = new Array<number>(n)
      for (let i = 0; i < n; i++) out[i] = r.i32()
      return out
    }
    case TAG_LONG_ARRAY: {
      const n = r.i32()
      if (n < 0 || n > 16 * 1024 * 1024) throw new Error('NBT 长整型数组长度异常')
      const out = new Array<bigint>(n)
      for (let i = 0; i < n; i++) out[i] = r.i64()
      return out
    }
    default:
      throw new Error(`未知 NBT 标签类型 ${type}`)
  }
}

/** 解析一份完整的 NBT（根必须是 Compound） */
export function parseNbt(buf: Buffer): NbtCompound {
  const r = new Reader(buf)
  const type = r.u8()
  if (type !== TAG_COMPOUND) throw new Error('NBT 根标签不是 Compound')
  r.str() // 根名通常为空
  return readPayload(r, TAG_COMPOUND, 0) as NbtCompound
}

export function nbtNumber(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : NaN
}

export function nbtString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function nbtArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export function nbtCompound(v: unknown): NbtCompound {
  return v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)
    ? (v as NbtCompound)
    : {}
}

/**
 * 把 Long 数组按位宽解包成索引。
 *
 * 1.16（DataVersion 2529）之后区块的 block_states 改成「跨 long 连续打包」；
 * 更早的版本每个 long 内部独立打包（末尾补零）。两种都要认，否则老存档会错位。
 */
export function unpackLongs(
  longs: readonly bigint[],
  bits: number,
  count: number,
  continuous: boolean
): Uint16Array {
  const out = new Uint16Array(count)
  if (!longs.length || bits <= 0 || bits > 32) return out

  // 4 / 8 / 16 / 32 位都能整除 64：每个 long 内部独立，可以拆成两个 32 位整数
  // 用普通位运算解包。区块数据里 95% 以上是小调色板（bits = 4），这条快路径
  // 把 BigInt 运算从「每个方块一次」降到「每个 long 两次」。
  if (continuous && 64 % bits === 0) {
    const per = 64 / bits
    let o = 0
    for (let li = 0; li < longs.length && o < count; li++) {
      const v = longs[li]
      const lo = Number(v & 0xffffffffn)
      const hi = Number(BigInt.asUintN(64, v) >> 32n)
      const half = per / 2
      for (let j = 0; j < half && o < count; j++) out[o++] = (lo >>> (j * bits)) & ((1 << bits) - 1)
      for (let j = 0; j < half && o < count; j++) out[o++] = (hi >>> (j * bits)) & ((1 << bits) - 1)
    }
    return out
  }

  const mask = (1n << BigInt(bits)) - 1n

  if (continuous) {
    const totalBits = BigInt(bits) * BigInt(count)
    if (totalBits > BigInt(longs.length) * 64n) return out
    for (let i = 0; i < count; i++) {
      const start = i * bits
      const li = Math.floor(start / 64)
      const off = start % 64
      let v: bigint
      if (off + bits <= 64) {
        v = (longs[li] >> BigInt(off)) & mask
      } else {
        // 跨 long 时先把有符号 long 当成无符号：算术右移会在高位补 1，
        // 和下一段 OR 起来会把 5 位的 15 变成 31
        const hi = BigInt.asUintN(64, longs[li]) >> BigInt(off)
        const lo = BigInt.asUintN(64, longs[li + 1]) << BigInt(64 - off)
        v = (hi | lo) & mask
      }
      out[i] = Number(v)
    }
    return out
  }

  const perLong = Math.floor(64 / bits)
  if (perLong <= 0) return out
  for (let i = 0; i < count; i++) {
    const li = Math.floor(i / perLong)
    if (li >= longs.length) break
    const off = (i % perLong) * bits
    out[i] = Number((longs[li] >> BigInt(off)) & mask)
  }
  return out
}


// ---------------------------------------------------------------- 区块专用解析

export interface ChunkSectionNbt {
  y: number
  palette: string[]
  data: bigint[]
}

export interface ChunkNbt {
  dataVersion: number
  sections: ChunkSectionNbt[]
  motion: bigint[] | null
  floor: bigint[] | null
}

function readLongArray(r: Reader): bigint[] {
  const n = r.i32()
  if (n < 0 || n > 16 * 1024 * 1024) throw new Error('NBT 长整型数组长度异常')
  const out = new Array<bigint>(n)
  for (let i = 0; i < n; i++) out[i] = r.i64()
  return out
}

function readPalette(r: Reader): string[] {
  const itemType = r.u8()
  const n = r.i32()
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    if (itemType !== TAG_COMPOUND) {
      r.skip(itemType)
      continue
    }
    let name = ''
    for (;;) {
      const t = r.u8()
      if (t === TAG_END) break
      const key = r.str()
      if (key === 'Name' && t === TAG_STRING) name = r.str()
      else r.skip(t)
    }
    out.push(name.replace(/^minecraft:/, ''))
  }
  return out
}

function readBlockStates(r: Reader): { palette: string[]; data: bigint[] } {
  let palette: string[] = []
  let data: bigint[] = []
  for (;;) {
    const t = r.u8()
    if (t === TAG_END) break
    const key = r.str()
    if (key === 'palette' && t === TAG_LIST) palette = readPalette(r)
    else if (key === 'data' && t === TAG_LONG_ARRAY) data = readLongArray(r)
    else r.skip(t)
  }
  return { palette, data }
}

function readSection(r: Reader): ChunkSectionNbt | null {
  let y = NaN
  let palette: string[] = []
  let data: bigint[] = []
  let legacyPalette: string[] = []
  let legacyData: bigint[] = []
  for (;;) {
    const t = r.u8()
    if (t === TAG_END) break
    const key = r.str()
    if (key === 'Y' && t === TAG_BYTE) y = r.i8()
    else if (key === 'block_states' && t === TAG_COMPOUND) {
      const bs = readBlockStates(r)
      palette = bs.palette
      data = bs.data
    } else if (key === 'Palette' && t === TAG_LIST) legacyPalette = readPalette(r)
    else if (key === 'BlockStates' && t === TAG_LONG_ARRAY) legacyData = readLongArray(r)
    else r.skip(t)
  }
  const pal = palette.length ? palette : legacyPalette
  if (!Number.isFinite(y) || !pal.length) return null
  return { y, palette: pal, data: palette.length ? data : legacyData }
}

function readHeightmaps(r: Reader): { motion: bigint[] | null; floor: bigint[] | null } {
  let motion: bigint[] | null = null
  let floor: bigint[] | null = null
  for (;;) {
    const t = r.u8()
    if (t === TAG_END) break
    const key = r.str()
    if (key === 'MOTION_BLOCKING' && t === TAG_LONG_ARRAY) motion = readLongArray(r)
    else if (key === 'OCEAN_FLOOR' && t === TAG_LONG_ARRAY) floor = readLongArray(r)
    else r.skip(t)
  }
  return { motion, floor }
}

/**
 * 只解析地图需要的东西：DataVersion、sections、高度图。
 *
 * 区块里还有 entities / block_entities / structures / PostProcessing 等大块数据，
 * 通用解析器会把它们全部建成对象，地图渲染一半的时间花在这里。用 skip 跳过后，
 * 一个 region 的解析时间能少一大截。
 */
export function parseChunkNbt(buf: Buffer): ChunkNbt {
  const r = new Reader(buf)
  const type = r.u8()
  if (type !== TAG_COMPOUND) throw new Error('NBT 根标签不是 Compound')
  r.str()

  let dataVersion = 0
  const sections: ChunkSectionNbt[] = []
  let motion: bigint[] | null = null
  let floor: bigint[] | null = null

  for (;;) {
    const t = r.u8()
    if (t === TAG_END) break
    const key = r.str()

    if (key === 'DataVersion' && t === TAG_INT) {
      dataVersion = r.i32()
    } else if (key === 'sections' && t === TAG_LIST) {
      const itemType = r.u8()
      const n = r.i32()
      for (let i = 0; i < n; i++) {
        if (itemType !== TAG_COMPOUND) {
          r.skip(itemType)
          continue
        }
        const sec = readSection(r)
        if (sec) sections.push(sec)
      }
    } else if (key === 'Heightmaps' && t === TAG_COMPOUND) {
      const hm = readHeightmaps(r)
      motion = hm.motion
      floor = hm.floor
    } else if (key === 'Level' && t === TAG_COMPOUND) {
      // 1.17 及更早：区块数据在 Level 下面
      for (;;) {
        const lt = r.u8()
        if (lt === TAG_END) break
        const lk = r.str()
        if (lk === 'Sections' && lt === TAG_LIST) {
          const itemType = r.u8()
          const n = r.i32()
          for (let i = 0; i < n; i++) {
            if (itemType !== TAG_COMPOUND) {
              r.skip(itemType)
              continue
            }
            const sec = readSection(r)
            if (sec) sections.push(sec)
          }
        } else if (lk === 'Heightmaps' && lt === TAG_COMPOUND) {
          const hm = readHeightmaps(r)
          motion = hm.motion
          floor = hm.floor
        } else {
          r.skip(lt)
        }
      }
    } else {
      r.skip(t)
    }
  }

  return { dataVersion, sections, motion, floor }
}
