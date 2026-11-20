import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { createDeflate } from 'node:zlib'
import type { MapExportEstimate, MapRegionRef } from '../shared/types'
import { pngChunk, PNG_SIGNATURE, pngIhdr } from './png'

/**
 * 地图导出的纯逻辑：连通块拆分、尺寸规划、瓦片重采样、流式 PNG 写出。
 *
 * 导出尺寸由用户选一个「长边像素」上限。规划器会挑一个不会低于目标分辨率
 * 的瓦片 step，再把每个 region 瓦片重采样到最终尺寸；如果地图本身比目标小，
 * 不强行放大，实际尺寸会在导出前显示出来。
 *
 * 大图（例如 32768×32768）不能先拼成一个 RGBA 再编码：那需要 4 GB 以上内存。
 * 这里按「region 行」拼一条横带，逐行通过 zlib 流写 IDAT，内存只和图像宽度
 * 有关，不会随高度增长。
 */

export const MIN_EXPORT_PX = 256
export const DEFAULT_EXPORT_PX = 4096
export const MAX_EXPORT_PX = 32768
const REGION_PX = 512

export interface ExportTile {
  /** 源瓦片边长 = ceil(512 / step) */
  size: number
  rgba: Uint8Array
}

export interface ExportTarget {
  key: string
  label: string
  regions: MapRegionRef[]
  minRx: number
  maxRx: number
  minRz: number
  maxRz: number
  /** 源瓦片用哪个 step 渲染 */
  step: number
  /** 最终每个 region 在输出图里占多少像素 */
  tileSize: number
  /** 源瓦片边长 / 输出瓦片边长；≥1 表示降采样 */
  scale: number
  width: number
  height: number
}

function key(r: MapRegionRef): string {
  return `${r.rx},${r.rz}`
}

/** 8 邻接的连通块；同一条边或同一个角挨着就算连接 */
export function regionComponents(regions: MapRegionRef[]): MapRegionRef[][] {
  const set = new Set(regions.map(key))
  const seen = new Set<string>()
  const out: MapRegionRef[][] = []

  for (const start of regions) {
    const sk = key(start)
    if (seen.has(sk)) continue
    const stack = [start]
    const comp: MapRegionRef[] = []
    seen.add(sk)
    while (stack.length) {
      const cur = stack.pop()!
      comp.push(cur)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue
          const next = { rx: cur.rx + dx, rz: cur.rz + dz }
          const nk = key(next)
          if (!set.has(nk) || seen.has(nk)) continue
          seen.add(nk)
          stack.push(next)
        }
      }
    }
    comp.sort((a, b) => a.rz - b.rz || a.rx - b.rx)
    out.push(comp)
  }

  out.sort((a, b) => b.length - a.length || a[0].rz - b[0].rz || a[0].rx - b[0].rx)
  return out
}

function boundsOf(regions: MapRegionRef[]): {
  minRx: number
  maxRx: number
  minRz: number
  maxRz: number
} {
  let minRx = Infinity
  let maxRx = -Infinity
  let minRz = Infinity
  let maxRz = -Infinity
  for (const r of regions) {
    minRx = Math.min(minRx, r.rx)
    maxRx = Math.max(maxRx, r.rx)
    minRz = Math.min(minRz, r.rz)
    maxRz = Math.max(maxRz, r.rz)
  }
  return { minRx, maxRx, minRz, maxRz }
}

function clampPx(maxPx: number): number {
  const n = Math.floor(Number(maxPx) || DEFAULT_EXPORT_PX)
  return Math.max(MIN_EXPORT_PX, Math.min(MAX_EXPORT_PX, n))
}

/**
 * 选源 step 和最终每 region 的像素数。
 *
 * needTile = 目标长边 / region 列数（或行数）。挑 baseTile >= needTile 的
 * 最小 baseTile（也就是最大的 step），这样是用较高分辨率降采样，而不是
 * 从低分辨率放大。地图本身不够大时保持原生尺寸，不强行放大。
 */
function planSize(
  cols: number,
  rows: number,
  maxPx: number
): { step: number; tileSize: number; scale: number; width: number; height: number } {
  const maxDim = Math.max(cols, rows)
  const needTile = maxPx / maxDim
  let step = 1
  for (const candidate of [4, 3, 2, 1]) {
    const base = Math.ceil(REGION_PX / candidate)
    if (base >= needTile) {
      step = candidate
      break
    }
  }
  const baseTile = Math.ceil(REGION_PX / step)
  const wanted = Math.floor(maxPx / maxDim)
  // 区域数比目标像素还多时至少每个 region 占 1 px；实际尺寸会超过所选上限，
  // 预估值会显示真实尺寸
  const tileSize = Math.max(1, Math.min(baseTile, wanted > 0 ? wanted : 1))
  return {
    step,
    tileSize,
    scale: baseTile / tileSize,
    width: cols * tileSize,
    height: rows * tileSize
  }
}

function makeTarget(
  regions: MapRegionRef[],
  keyName: string,
  label: string,
  maxPx: number
): ExportTarget {
  const b = boundsOf(regions)
  const cols = b.maxRx - b.minRx + 1
  const rows = b.maxRz - b.minRz + 1
  const size = planSize(cols, rows, maxPx)
  return { key: keyName, label, regions, ...b, ...size }
}

/** all：整张地图一张图；components：每个互不相连的区域单独一张图 */
export function makeExportTargets(
  regions: MapRegionRef[],
  mode: 'all' | 'components',
  maxPx = DEFAULT_EXPORT_PX
): ExportTarget[] {
  if (!regions.length) return []
  const px = clampPx(maxPx)
  if (mode === 'all') return [makeTarget(regions, 'all', '全图', px)]
  return regionComponents(regions).map((comp, i) =>
    makeTarget(comp, `part-${i + 1}`, `区域 ${i + 1}`, px)
  )
}

/** 任意比例 box 重采样；透明像素不参与平均，整块透明则输出透明 */
export function resampleTile(
  rgba: Uint8Array,
  size: number,
  outSize: number
): Uint8Array {
  if (outSize === size || outSize <= 0) return rgba
  const out = new Uint8Array(outSize * outSize * 4)
  for (let oy = 0; oy < outSize; oy++) {
    const y0 = Math.floor((oy * size) / outSize)
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * size) / outSize))
    for (let ox = 0; ox < outSize; ox++) {
      const x0 = Math.floor((ox * size) / outSize)
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * size) / outSize))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1 && y < size; y++) {
        for (let x = x0; x < x1 && x < size; x++) {
          const i = (y * size + x) * 4
          if (!rgba[i + 3]) continue
          r += rgba[i]
          g += rgba[i + 1]
          b += rgba[i + 2]
          n++
        }
      }
      if (!n) continue
      const o = (oy * outSize + ox) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = 255
    }
  }
  return out
}

/** 方形 tile 的整数倍 box 降采样；保留给旧调用和测试 */
export function downsampleSquare(rgba: Uint8Array, size: number, factor: number): Uint8Array {
  const f = Math.max(1, Math.floor(factor))
  if (f === 1) return rgba
  return resampleTile(rgba, size, Math.ceil(size / f))
}

/** 把拿到的瓦片按 region 网格拼成一张 RGBA（背景透明） */
export function composeTarget(
  target: ExportTarget,
  tiles: Map<string, ExportTile>
): Uint8Array {
  const out = new Uint8Array(target.width * target.height * 4)
  for (const r of target.regions) {
    const tile = tiles.get(key(r))
    if (!tile) continue
    const rgba = resampleTile(tile.rgba, tile.size, target.tileSize)
    const ox = (r.rx - target.minRx) * target.tileSize
    const oz = (r.rz - target.minRz) * target.tileSize
    const rowBytes = target.tileSize * 4
    for (let y = 0; y < target.tileSize; y++) {
      const dest = ((oz + y) * target.width + ox) * 4
      out.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), dest)
    }
  }
  return out
}

/** 预估值：地图 PNG 的压缩率大致在原始 RGBA 的 6%–35% 之间 */
export function estimateExport(
  targets: ExportTarget[],
  maxPx: number
): MapExportEstimate {
  const list = targets.map((t) => ({
    width: t.width,
    height: t.height,
    regions: t.regions.length
  }))
  let totalPixels = 0
  let largest = { width: 0, height: 0, pixels: 0 }
  for (const t of list) {
    const pixels = t.width * t.height
    totalPixels += pixels
    if (pixels > largest.pixels) largest = { ...t, pixels }
  }
  const raw = totalPixels * 4
  const px = clampPx(maxPx)
  let warning: string | null = null
  if (px > 16384) {
    warning =
      `所选长边 ${px} px 超过 16384，导出时间和文件体积都会明显增加；` +
      '32768 级别可能需要数分钟并占用数 GB 磁盘。'
  } else if (totalPixels > 16384 * 16384) {
    warning = `总像素约 ${(totalPixels / 1e6).toFixed(0)} 百万，文件可能达到数 GB。`
  }
  return {
    targets: list,
    width: largest.width,
    height: largest.height,
    totalPixels,
    estimatedBytesLow: Math.round(raw * 0.06),
    estimatedBytesHigh: Math.round(raw * 0.35),
    warning
  }
}

export interface StreamTileSource {
  size: number
  rgba: Uint8Array
}

/**
 * 流式写出目标 PNG。
 *
 * 按 region 行组装一条横带，逐行写进 zlib 流；每个 deflate 输出块包成一个
 * IDAT。这样 32768×32768 也不会先分配一张 4 GB 的 RGBA。
 */
export async function writeTargetPng(
  target: ExportTarget,
  file: string,
  getTile: (r: MapRegionRef) => Promise<StreamTileSource | null>,
  onRegion?: (r: MapRegionRef, ok: boolean) => void
): Promise<void> {
  const stream = createWriteStream(file, { highWaterMark: 1024 * 1024 })
  let failure: Error | null = null
  stream.on('error', (err) => {
    failure = err
  })

  const write = async (buf: Buffer): Promise<void> => {
    if (failure) throw failure
    if (!stream.write(buf)) await once(stream, 'drain')
    if (failure) throw failure
  }

  await write(PNG_SIGNATURE)
  await write(pngChunk('IHDR', pngIhdr(target.width, target.height)))

  const deflate = createDeflate({ level: 3 })
  let idatQueue: Promise<void> = Promise.resolve()
  deflate.on('data', (chunk: Buffer) => {
    idatQueue = idatQueue.then(() => write(pngChunk('IDAT', chunk)))
  })
  deflate.on('error', (err) => {
    failure = err
  })

  const byRow = new Map<number, MapRegionRef[]>()
  for (const r of target.regions) {
    const list = byRow.get(r.rz) ?? []
    list.push(r)
    byRow.set(r.rz, list)
  }

  const row = Buffer.alloc(target.width * 4 + 1)
  row[0] = 1 // Sub filter
  // 复用同一条横带，避免大图导出时每行都分配 / 丢弃一块几 MB 的缓冲
  const strip = new Uint8Array(target.width * target.tileSize * 4)

  for (let rz = target.minRz; rz <= target.maxRz; rz++) {
    const rowRegions = byRow.get(rz) ?? []
    strip.fill(0)
    const tiles = new Map<string, StreamTileSource | null>()
    let index = 0
    const workers = Array.from(
      { length: Math.min(4, Math.max(1, rowRegions.length)) },
      async () => {
        for (;;) {
          const i = index++
          if (i >= rowRegions.length) return
          const r = rowRegions[i]
          let tile: StreamTileSource | null = null
          try {
            tile = await getTile(r)
          } catch {
            tile = null
          }
          tiles.set(key(r), tile)
          onRegion?.(r, Boolean(tile))
        }
      }
    )
    await Promise.all(workers)

    for (const r of rowRegions) {
      const tile = tiles.get(key(r))
      if (!tile) continue
      const out = resampleTile(tile.rgba, tile.size, target.tileSize)
      const ox = (r.rx - target.minRx) * target.tileSize
      if (ox < 0 || ox + target.tileSize > target.width) continue
      for (let y = 0; y < target.tileSize; y++) {
        const src = y * target.tileSize * 4
        const dest = (y * target.width + ox) * 4
        strip.set(out.subarray(src, src + target.tileSize * 4), dest)
      }
    }

    const stride = target.width * 4
    for (let y = 0; y < target.tileSize; y++) {
      const start = y * stride
      for (let x = 0; x < stride; x++) {
        const left = x >= 4 ? strip[start + x - 4] : 0
        row[x + 1] = (strip[start + x] - left) & 0xff
      }
      // 必须等这一行被 zlib 处理完再复用 row；write() 返回 true 不代表已经拷走数据
      await new Promise<void>((resolve, reject) => {
        deflate.write(row, (err) => (err ? reject(err) : resolve()))
      })
    }
  }

  deflate.end()
  await Promise.race([
    once(deflate, 'end'),
    new Promise<void>((_, reject) => {
      deflate.once('error', reject)
    })
  ])
  await idatQueue
  await write(pngChunk('IEND', Buffer.alloc(0)))
  stream.end()
  await once(stream, 'finish')
}
