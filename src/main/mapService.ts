import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  inspectWorld,
  REGION_PX,
  regionAverageFromBuffer,
  renderRegionAllSteps
} from './worldmap'
import { renderRegionInWorker } from './mapWorkers'
import { encodePng } from './png'
import type {
  MapOverview,
  MapTileResult,
  ServerConfig,
  WorldMapInfo
} from '../shared/types'

/**
 * 地图瓦片的缓存与调度。
 *
 * 渲染一个 region 要拆 1024 个区块、解压、解 NBT，约 1–2 秒。
 * 所以：
 *   - 结果按「region 文件的 mtime + 大小」缓存在磁盘上，存档没变就直接读；
 *   - 同时最多跑 2 个渲染，避免把主进程和磁盘占满；
 *   - 同一块瓦片同时只渲染一次（界面滚动时会重复请求）。
 */

const CACHE_VERSION = 4
const INFO_TTL = 5000
const MAX_RENDER = 4

const infoCache = new Map<string, { at: number; info: WorldMapInfo }>()
/** 同一个 region 的任意 step 共用一次渲染，避免 1× / 2× / 3× / 4× 各解析一遍 */
const regionInFlight = new Map<string, Promise<{ ms: number; explored: number }>>()
const overviewInFlight = new Map<string, Promise<MapOverview>>()
const heightsCache = new Map<string, Buffer>()
/** 已经转成 data URL 的瓦片，最近用过的放最后 */
const tileUrlCache = new Map<string, string>()
const MAX_TILE_URLS = 160

function rememberTile(path: string, url: string): void {
  if (tileUrlCache.has(path)) tileUrlCache.delete(path)
  tileUrlCache.set(path, url)
  while (tileUrlCache.size > MAX_TILE_URLS) {
    const oldest = tileUrlCache.keys().next().value
    if (!oldest) break
    tileUrlCache.delete(oldest)
  }
}

function recallTile(path: string): string | undefined {
  const url = tileUrlCache.get(path)
  if (!url) return undefined
  tileUrlCache.delete(path)
  tileUrlCache.set(path, url)
  return url
}

let active = 0
const waiting: (() => void)[] = []

async function acquire(): Promise<void> {
  if (active < MAX_RENDER) {
    active++
    return
  }
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function release(): void {
  const next = waiting.shift()
  if (next) next()
  else active--
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    return await fn()
  } finally {
    release()
  }
}

function cacheRoot(): string {
  return join(app.getPath('userData'), 'worldmap', `v${CACHE_VERSION}`)
}

export async function getMapInfo(
  cfg: ServerConfig,
  core: string,
  properties: string,
  force = false
): Promise<WorldMapInfo> {
  const hit = infoCache.get(cfg.id)
  if (!force && hit && Date.now() - hit.at < INFO_TTL) return hit.info
  const info = await inspectWorld(core, properties)
  infoCache.set(cfg.id, { at: Date.now(), info })
  return info
}

export function forgetMapInfo(id: string): void {
  infoCache.delete(id)
}

function dataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

async function regionMeta(
  dimDir: string,
  rx: number,
  rz: number
): Promise<{ path: string; base: string } | null> {
  const path = join(dimDir, `r.${rx}.${rz}.mca`)
  try {
    const stat = await fs.stat(path)
    return { path, base: `r.${rx}.${rz}.${Math.floor(stat.mtimeMs)}-${stat.size}` }
  } catch {
    return null
  }
}

export async function getMapTile(
  cfg: ServerConfig,
  dimId: string,
  rx: number,
  rz: number,
  info: WorldMapInfo,
  step = 1
): Promise<MapTileResult> {
  const dim = info.dimensions.find((d) => d.id === dimId)
  if (!dim) throw new Error('这个维度没有区块数据')
  const meta = await regionMeta(dim.regionDir, rx, rz)
  if (!meta) throw new Error('这个区域还没有生成')

  // 1 像素 = 1 / 2 / 3 / 4 个方块
  const s = Math.max(1, Math.min(4, Math.floor(step) || 1))
  const dir = join(cacheRoot(), cfg.id, dimId)
  const pngPath = join(dir, `${meta.base}.s${s}.png`)
  const hgtPath = join(dir, `${meta.base}.hgt`)
  const size = Math.ceil(REGION_PX / s)

  // 1. 内存里已经有这张 data URL，直接返回
  const memoryHit = recallTile(pngPath)
  if (memoryHit) {
    return { png: memoryHit, ms: 0, cached: true, explored: 0, step: s, size }
  }

  // 2. 磁盘缓存
  try {
    const png = await fs.readFile(pngPath)
    const url = dataUrl(png)
    rememberTile(pngPath, url)
    return { png: url, ms: 0, cached: true, explored: 0, step: s, size }
  } catch {
    /* 缓存不完整，重新渲染 */
  }

  // 3. 同一个 region 只解析一次，一次产出全部四档
  let render = regionInFlight.get(meta.path)
  if (!render) {
    const started = Date.now()
    render = (async () => {
      return await withSlot(async () => {
        // 排队期间别的请求可能已经渲染好了
        try {
          const png = await fs.readFile(pngPath)
          rememberTile(pngPath, dataUrl(png))
          return { ms: 0, explored: 0 }
        } catch {
          /* 继续渲染 */
        }

        let res: {
          pngs: Map<number, Buffer>
          heights: Uint16Array
          explored: number
        }
        try {
          // CPU 重的解析放在 worker 池里，主进程只负责写盘
          res = await renderRegionInWorker(meta.path)
        } catch {
          res = renderRegionAllSteps(await fs.readFile(meta.path))
        }
        await fs.mkdir(dir, { recursive: true })

        for (const [renderStep, png] of res.pngs) {
          const target = join(dir, `${meta.base}.s${renderStep}.png`)
          const tmp = `${target}.${process.pid}.tmp`
          await fs.writeFile(tmp, png)
          await fs.rename(tmp, target)
          rememberTile(target, dataUrl(png))
        }

        const tmpHgt = `${hgtPath}.${process.pid}.tmp`
        await fs.writeFile(
          tmpHgt,
          Buffer.from(res.heights.buffer, res.heights.byteOffset, res.heights.byteLength)
        )
        await fs.rename(tmpHgt, hgtPath)

        return { ms: Date.now() - started, explored: res.explored }
      })
    })().finally(() => regionInFlight.delete(meta.path))

    regionInFlight.set(meta.path, render)
  }

  const renderInfo = await render
  let url = recallTile(pngPath)
  if (!url) {
    const png = await fs.readFile(pngPath)
    url = dataUrl(png)
    rememberTile(pngPath, url)
  }
  return {
    png: url,
    ms: renderInfo.ms,
    cached: renderInfo.ms === 0,
    explored: renderInfo.explored,
    step: s,
    size
  }
}

/**
 * 一个 region 的平均色。第一次要完整渲染一遍，之后从 .avg 缓存读。
 * step=4 只是为了让 downsample 少算几十万像素；平均色本身取自完整分辨率。
 */
async function regionAverage(
  dimDir: string,
  rx: number,
  rz: number,
  cacheDir: string
): Promise<[number, number, number] | null> {
  const meta = await regionMeta(dimDir, rx, rz)
  if (!meta) return null
  const avgPath = join(cacheDir, `${meta.base}.avg`)

  const read = async (): Promise<[number, number, number] | null> => {
    try {
      const buf = await fs.readFile(avgPath)
      if (buf.length === 4 && buf[3]) return [buf[0], buf[1], buf[2]]
    } catch {
      /* 还没算过 */
    }
    return null
  }

  const hit = await read()
  if (hit) return hit

  const again = await read()
  if (again) return again

  // 只抽样 16 个区块，不完整渲染整片区域；几百个 region 的总览才做得完
  const avg = regionAverageFromBuffer(await fs.readFile(meta.path))
  await fs.mkdir(cacheDir, { recursive: true })
  const tmp = `${avgPath}.${process.pid}.tmp`
  await fs.writeFile(tmp, Buffer.from(avg ? [...avg, 255] : [0, 0, 0, 0]))
  await fs.rename(tmp, avgPath)
  return avg
}

/**
 * 最缩小的那一级：每个 .mca 只画一个像素。
 *
 * 世界由几百个 region 组成时，一张 512px 的瓦片仍然太多；把每个 region
 * 压成一个平均色，一眼就能看出主城、远点和孤立区域。结果按 region 文件的
 * mtime / 大小做签名缓存，存档变了才会重算。
 */
export async function getMapOverview(
  cfg: ServerConfig,
  dimId: string,
  info: WorldMapInfo
): Promise<MapOverview> {
  const dim = info.dimensions.find((d) => d.id === dimId)
  if (!dim) throw new Error('这个维度没有区块数据')
  if (!dim.regions.length) throw new Error('这个维度还没有 region 文件')

  /*
   * 每个 .mca 都要有一个像素。
   *
   * 技术服常有一堆传送/误加载生成的孤立 region，离主城几千格；它们也照样画出来。
   * 只有区域数特别离谱时才截断：按到主城中心的距离排序取最近的一批，
   * 否则一张总览图本身就会大到没有意义。
   */
  let regions = dim.regions
  if (regions.length > 2048) {
    const cx = (dim.coreBounds.minX + dim.coreBounds.maxX) / 2
    const cz = (dim.coreBounds.minZ + dim.coreBounds.maxZ) / 2
    const dist = (r: { rx: number; rz: number }): number => {
      const dx = r.rx * REGION_PX + REGION_PX / 2 - cx
      const dz = r.rz * REGION_PX + REGION_PX / 2 - cz
      return dx * dx + dz * dz
    }
    regions = [...regions].sort((a, b) => dist(a) - dist(b)).slice(0, 2048)
  }

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
  const cols = maxRx - minRx + 1
  const rows = maxRz - minRz + 1
  if (cols * rows > 4096 * 4096) throw new Error('区域文件分布得过于分散，无法生成总览')

  const dir = join(cacheRoot(), cfg.id, dimId)
  const sigParts: string[] = []
  for (const r of [...regions].sort((a, b) => a.rz - b.rz || a.rx - b.rx)) {
    const meta = await regionMeta(dim.regionDir, r.rx, r.rz)
    sigParts.push(`${r.rx},${r.rz}:${meta?.base ?? 'missing'}`)
  }
  const sig = createHash('sha1').update(sigParts.join('|')).digest('hex').slice(0, 16)
  const pngPath = join(dir, `overview-${sig}.png`)

  const bounds = {
    minX: minRx * REGION_PX,
    maxX: (maxRx + 1) * REGION_PX - 1,
    minZ: minRz * REGION_PX,
    maxZ: (maxRz + 1) * REGION_PX - 1,
    minRx,
    minRz,
    cols,
    rows
  }

  const running = overviewInFlight.get(pngPath)
  if (running) return running

  const task = (async (): Promise<MapOverview> => {
    try {
      const png = await fs.readFile(pngPath)
      return { png: dataUrl(png), ...bounds, ms: 0, cached: true }
    } catch {
      /* 重新生成 */
    }

    const started = Date.now()
    const rgba = new Uint8Array(cols * rows * 4)
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < regions.length) {
        const r = regions[index++]
        const avg = await regionAverage(dim.regionDir, r.rx, r.rz, dir)
        if (!avg) continue
        const px = r.rx - minRx
        const pz = r.rz - minRz
        const i = (pz * cols + px) * 4
        rgba[i] = avg[0]
        rgba[i + 1] = avg[1]
        rgba[i + 2] = avg[2]
        rgba[i + 3] = 255
      }
    }
    // 抽样很快，可以多开几条；仍限制住，别把磁盘同时打满
    await Promise.all([worker(), worker(), worker(), worker()])

    const png = encodePng(rgba, cols, rows)
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${pngPath}.${process.pid}.tmp`
    await fs.writeFile(tmp, png)
    await fs.rename(tmp, pngPath)
    return { png: dataUrl(png), ...bounds, ms: Date.now() - started, cached: false }
  })().finally(() => overviewInFlight.delete(pngPath))

  overviewInFlight.set(pngPath, task)
  return task
}

/**
 * 查某个方块的地表高度。只读已经渲染过的区域 —— 鼠标划过时不该触发一次
 * 1 秒的渲染，没缓存就返回 null，界面显示「未加载」。
 */
export async function getMapHeight(
  cfg: ServerConfig,
  dimId: string,
  x: number,
  z: number,
  info: WorldMapInfo
): Promise<number | null> {
  const dim = info.dimensions.find((d) => d.id === dimId)
  if (!dim) return null
  const rx = Math.floor(x / REGION_PX)
  const rz = Math.floor(z / REGION_PX)
  const meta = await regionMeta(dim.regionDir, rx, rz)
  if (!meta) return null

  const hgtPath = join(cacheRoot(), cfg.id, dimId, `${meta.base}.hgt`)
  let buf = heightsCache.get(hgtPath)
  if (!buf) {
    try {
      buf = await fs.readFile(hgtPath)
      heightsCache.set(hgtPath, buf)
      // 只留最近几块，避免开着地图久了内存一直涨
      if (heightsCache.size > 8) {
        const oldest = heightsCache.keys().next().value
        if (oldest) heightsCache.delete(oldest)
      }
    } catch {
      return null
    }
  }
  if (buf.length < REGION_PX * REGION_PX * 2) return null
  const lx = x - rx * REGION_PX
  const lz = z - rz * REGION_PX
  const v = buf.readUInt16LE((lz * REGION_PX + lx) * 2)
  return v ? v - 128 : null
}

/** 清掉一台服务器的地图缓存（「刷新」按钮用） */
export async function clearMapCache(id: string): Promise<void> {
  infoCache.delete(id)
  for (const key of [...regionInFlight.keys()]) if (key.includes(id)) regionInFlight.delete(key)
  for (const key of [...overviewInFlight.keys()]) if (key.includes(id)) overviewInFlight.delete(key)
  heightsCache.clear()
  tileUrlCache.clear()
  await fs.rm(join(cacheRoot(), id), { recursive: true, force: true }).catch(() => {})
}
