import { deflateSync, inflateSync } from 'node:zlib'

/**
 * 最小 PNG 编码器（RGBA，8 位）。
 *
 * 地图瓦片在 Node / 测试脚本里都要能生成，所以不依赖 Electron 的 nativeImage。
 * 只支持我们要用的那一种：颜色类型 6、无交错、滤波器用 Sub（每行减左邻像素，
 * 对区块地图这种大片同色的图压缩率明显比不做滤波好）。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 给流式导出用：把一段数据包成完整的 PNG chunk（带长度与 CRC） */
export function pngChunk(type: string, data: Buffer): Buffer {
  return chunk(type, data)
}

/** RGBA8 的 IHDR 数据 */
export function pngIhdr(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return ihdr
}

export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  // 每行前面加一个滤波器字节；Sub 滤波：每个通道减去左边一个像素
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 1 // filter: Sub
    const src = y * stride
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[src + x - 4] : 0
      raw[rowStart + 1 + x] = (rgba[src + x] - left) & 0xff
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // 地图瓦片对体积不敏感、对生成速度敏感；level 3 比 6 快得多，解码速度不变
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export interface DecodedPng {
  width: number
  height: number
  rgba: Uint8Array
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 解出我们自己的 PNG（RGBA8、非交错）。
 *
 * 地图导出要把已经缓存 / 渲染好的瓦片拼成一张大图，需要读回像素。
 * 支持标准的 0–4 五种行滤波，其它颜色类型直接报错；我们的编码器只会写 RGBA8。
 */
export function decodePng(png: Buffer): DecodedPng {
  const signature = '89504e470d0a1a0a'
  if (png.length < 8 || png.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('不是 PNG 文件')
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []

  let off = 8
  while (off + 12 <= png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    off += 12 + len
    if (type === 'IHDR') {
      if (data.length < 13) throw new Error('PNG IHDR 不完整')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  if (!width || !height) throw new Error('PNG 缺少 IHDR')
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error('只支持 RGBA8 非交错 PNG')
  }
  if (width * height > 64 * 1024 * 1024) throw new Error('PNG 尺寸过大')
  if (!idat.length) throw new Error('PNG 没有 IDAT')

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  if (raw.length < (stride + 1) * height) throw new Error('PNG 像素数据不完整')

  const rgba = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    const filter = raw[rowStart]
    const src = rowStart + 1
    const dst = y * stride
    const prevDst = dst - stride
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]
      const left = x >= 4 ? rgba[dst + x - 4] : 0
      const up = y > 0 ? rgba[prevDst + x] : 0
      const upLeft = y > 0 && x >= 4 ? rgba[prevDst + x - 4] : 0
      let out: number
      switch (filter) {
        case 0:
          out = v
          break
        case 1:
          out = v + left
          break
        case 2:
          out = v + up
          break
        case 3:
          out = v + Math.floor((left + up) / 2)
          break
        case 4:
          out = v + paeth(left, up, upLeft)
          break
        default:
          throw new Error(`未知 PNG 行滤波 ${filter}`)
      }
      rgba[dst + x] = out & 0xff
    }
  }

  return { width, height, rgba }
}
