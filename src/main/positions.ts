import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { readRconConfig, RconClient } from './rcon'
import type { MapPlayerPosition, ServerConfig } from '../shared/types'

/**
 * 实时玩家位置。
 *
 * 服务端没有「查所有人坐标」的接口，但控制台可以执行
 * `data get entity <玩家> Pos` / `Dimension`。这里在打开地图时向正在运行的
 * 服务端发这两条只读指令，把控制台返回的行解析出来。
 *
 * 只在有人打开地图时调用（界面每 4 秒一次），关掉地图就不再打扰服务端。
 * CraftDesk 启动的服务端直接写 stdin；外部启动的没有 stdin，改走 RCON
 * （server.properties 里 enable-rcon=true 才可用）。
 */

export interface PositionSource {
  isRunning(id: string): boolean
  runtime(id: string): { onlinePlayers: string[] }
  logs(id: string): { text: string }[]
  sendCommand(id: string, cmd: string, quiet?: boolean): boolean
}

const CACHE_TTL = 3000
const MAX_WAIT = 3200

const cache = new Map<string, { at: number; list: MapPlayerPosition[] }>()
const inFlight = new Map<string, Promise<MapPlayerPosition[]>>()

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `minecraft:the_nether` → `nether`，和地图的维度 id 对齐 */
export function normalizeDimension(raw: string): string {
  const v = raw.replace(/^minecraft:/, '')
  if (v === 'overworld') return 'overworld'
  if (v === 'the_nether' || v === 'nether') return 'nether'
  if (v === 'the_end' || v === 'end') return 'end'
  return v
}

/**
 * 解析一行 `data get entity` 的输出。
 * 返回 { kind: 'pos', x, y, z } / { kind: 'dimension', dimension }。
 */
export function parseDataGetLine(
  text: string
): { name: string; kind: 'pos'; x: number; y: number; z: number } | { name: string; kind: 'dimension'; dimension: string } | null {
  const clean = text
    .replace(/^\[[^\]]+\]:\s*/, '')
    .replace(/§./g, '')
    .trim()
  const m = clean.match(/^([A-Za-z0-9_]{1,16}) has the following entity data: (.+)$/)
  if (!m) return null
  const name = m[1]
  const rest = m[2].trim()

  if (rest.startsWith('[')) {
    const inside = rest.match(/^\[([^\]]+)\]/)?.[1]
    if (!inside) return null
    const nums = inside.split(',').map((s) => Number.parseFloat(s.trim()))
    if (nums.length < 3 || nums.some((n) => !Number.isFinite(n))) return null
    return { name, kind: 'pos', x: nums[0], y: nums[1], z: nums[2] }
  }

  const dim = rest.match(/^"?((?:[a-z0-9_.-]+:)?[a-z0-9_/.-]+)"?$/i)?.[1]
  if (dim) return { name, kind: 'dimension', dimension: normalizeDimension(dim) }
  return null
}

/** 解析 `list` 的返回：`There are 2 ... online: A, B` / 中文的「在线：A, B」 */
export function parseListOutput(text: string): string[] {
  const clean = text.replace(/§./g, '').trim()
  const idx = Math.max(clean.lastIndexOf(':'), clean.lastIndexOf('：'))
  if (idx < 0) return []
  return clean
    .slice(idx + 1)
    .split(',')
    .map((s) => s.trim())
    .filter((n) => /^[A-Za-z0-9_]{1,16}$/.test(n))
}

async function readUuidMap(playersDir: string, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const raw = await fs.readFile(join(playersDir, 'usercache.json'), 'utf-8')
    const list = JSON.parse(raw) as { name?: string; uuid?: string }[]
    const want = new Set(names.map((n) => n.toLowerCase()))
    for (const e of list) {
      if (e.name && e.uuid && want.has(e.name.toLowerCase())) out.set(e.name.toLowerCase(), e.uuid)
    }
  } catch {
    /* 没有 usercache 就只按名字显示 */
  }
  return out
}

async function pollStdin(source: PositionSource, cfg: ServerConfig, playersDir: string): Promise<MapPlayerPosition[]> {
  if (!source.isRunning(cfg.id)) return []
  const names = source.runtime(cfg.id).onlinePlayers.filter((n) => /^[A-Za-z0-9_]{1,16}$/.test(n))
  if (!names.length) return []

  const start = source.logs(cfg.id).length
  for (const name of names) {
    source.sendCommand(cfg.id, `data get entity ${name} Pos`, true)
    source.sendCommand(cfg.id, `data get entity ${name} Dimension`, true)
  }

  const found = new Map<string, { x?: number; y?: number; z?: number; dimension?: string }>()
  const deadline = Date.now() + Math.min(MAX_WAIT, 900 + names.length * 140)
  while (Date.now() < deadline) {
    await delay(70)
    const lines = source.logs(cfg.id)
    for (let i = start; i < lines.length; i++) {
      const parsed = parseDataGetLine(lines[i].text)
      if (!parsed) continue
      const item = found.get(parsed.name) ?? {}
      if (parsed.kind === 'pos') {
        item.x = parsed.x
        item.y = parsed.y
        item.z = parsed.z
      } else {
        item.dimension = parsed.dimension
      }
      found.set(parsed.name, item)
    }
    if (names.every((n) => {
      const f = found.get(n)
      return f && f.x !== undefined && f.dimension
    })) break
  }

  const uuids = await readUuidMap(playersDir, names)
  const out: MapPlayerPosition[] = []
  for (const name of names) {
    const f = found.get(name)
    if (!f || f.x === undefined || f.y === undefined || f.z === undefined || !f.dimension) continue
    out.push({
      name,
      uuid: uuids.get(name.toLowerCase()),
      x: f.x,
      y: f.y,
      z: f.z,
      dimension: f.dimension
    })
  }
  return out
}

/** 外部启动的服务端：走 RCON 读 `list` 和每个玩家的 Pos/Dimension */
async function pollRcon(
  propertiesPath: string,
  playersDir: string
): Promise<MapPlayerPosition[]> {
  const rcon = await readRconConfig(propertiesPath)
  if (!rcon) return []
  const client = await RconClient.open(rcon)
  try {
    const names = parseListOutput(await client.command('list'))
    if (!names.length) return []

    const found = new Map<string, { x?: number; y?: number; z?: number; dimension?: string }>()
    for (const name of names) {
      const posLine = await client.command(`data get entity ${name} Pos`)
      const dimLine = await client.command(`data get entity ${name} Dimension`)
      for (const line of [posLine, dimLine]) {
        const parsed = parseDataGetLine(line)
        if (!parsed) continue
        const item = found.get(parsed.name) ?? {}
        if (parsed.kind === 'pos') {
          item.x = parsed.x
          item.y = parsed.y
          item.z = parsed.z
        } else {
          item.dimension = parsed.dimension
        }
        found.set(parsed.name, item)
      }
    }

    const uuids = await readUuidMap(playersDir, names)
    const out: MapPlayerPosition[] = []
    for (const name of names) {
      const f = found.get(name)
      if (!f || f.x === undefined || f.y === undefined || f.z === undefined || !f.dimension) continue
      out.push({
        name,
        uuid: uuids.get(name.toLowerCase()),
        x: f.x,
        y: f.y,
        z: f.z,
        dimension: f.dimension
      })
    }
    return out
  } finally {
    client.close()
  }
}

/** 缓存 3 秒；同一台服务器同时只轮询一次 */
export async function getPlayerPositions(
  source: PositionSource,
  cfg: ServerConfig,
  playersDir: string,
  propertiesPath = ''
): Promise<MapPlayerPosition[]> {
  const hit = cache.get(cfg.id)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.list

  const running = inFlight.get(cfg.id)
  if (running) return running

  // 开了 RCON 就优先走 RCON：MCDR 托管时 stdin 是 MCDR 的输入，不一定能到服务端；
  // RCON 是直接连服务端的，稳定得多。
  const rconReady = propertiesPath ? await readRconConfig(propertiesPath) : null
  const task = (
    rconReady
      ? pollRcon(propertiesPath, playersDir)
      : source.isRunning(cfg.id)
        ? pollStdin(source, cfg, playersDir)
        : Promise.resolve([])
  )
    .then((list) => {
      cache.set(cfg.id, { at: Date.now(), list })
      return list
    })
    .finally(() => inFlight.delete(cfg.id))
  inFlight.set(cfg.id, task)
  return task
}

export function forgetPositions(id: string): void {
  cache.delete(id)
}
