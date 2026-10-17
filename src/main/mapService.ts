import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { inspectWorld, REGION_PX, renderRegionFile } from './worldmap'
import type { MapTileResult, ServerConfig, WorldMapInfo } from '../shared/types'

/**
 * 地图瓦片的缓存与调度。
 *
 * 渲染一个 region 要拆 1024 个区块、解压、解 NBT，约 1–2 秒。
 * 所以：
 *   - 结果按「region 文件的 mtime + 大小」缓存在磁盘上，存档没变就直接读；
 *   - 同时最多跑 2 个渲染，避免把主进程和磁盘占满；
 *   - 同一块瓦片同时只渲染一次（界面滚动时会重复请求）。
 */

const CACHE_VERSION = 2
const INFO_TTL = 5000
const MAX_RENDER = 2

const infoCache = new Map<string, { at: number; info: WorldMapInfo }>()
const inFlight = new Map<string, Promise<MapTileResult>>()
const heightsCache = new Map<string, Buffer>()

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
  info: WorldMapInfo
): Promise<MapTileResult> {
  const dim = info.dimensions.find((d) => d.id === dimId)
  if (!dim) throw new Error('这个维度没有区块数据')
  const meta = await regionMeta(dim.regionDir, rx, rz)
  if (!meta) throw new Error('这个区域还没有生成')

  const dir = join(cacheRoot(), cfg.id, dimId)
  const pngPath = join(dir, `${meta.base}.png`)
  const hgtPath = join(dir, `${meta.base}.hgt`)
  const key = pngPath

  const running = inFlight.get(key)
  if (running) return running

  const task = (async (): Promise<MapTileResult> => {
    try {
      const png = await fs.readFile(pngPath)
      return { png: dataUrl(png), ms: 0, cached: true, explored: 0 }
    } catch {
      /* 缓存不完整，重新渲染 */
    }

    return await withSlot(async () => {
      // 排队期间别的请求可能已经渲染好了
      try {
        const png = await fs.readFile(pngPath)
        return { png: dataUrl(png), ms: 0, cached: true, explored: 0 }
      } catch {
        /* 继续渲染 */
      }

      const started = Date.now()
      const res = await renderRegionFile(meta.path)
      const ms = Date.now() - started

      await fs.mkdir(dir, { recursive: true })
      const tmpPng = `${pngPath}.${process.pid}.tmp`
      const tmpHgt = `${hgtPath}.${process.pid}.tmp`
      await fs.writeFile(tmpPng, res.png)
      await fs.writeFile(
        tmpHgt,
        Buffer.from(res.heights.buffer, res.heights.byteOffset, res.heights.byteLength)
      )
      await fs.rename(tmpPng, pngPath)
      await fs.rename(tmpHgt, hgtPath)

      return { png: dataUrl(res.png), ms, cached: false, explored: res.explored }
    })
  })().finally(() => inFlight.delete(key))

  inFlight.set(key, task)
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
  for (const key of [...inFlight.keys()]) if (key.includes(id)) inFlight.delete(key)
  heightsCache.clear()
  await fs.rm(join(cacheRoot(), id), { recursive: true, force: true }).catch(() => {})
}
