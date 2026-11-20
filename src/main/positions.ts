import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { readRconConfig, RconClient } from './rcon'
import type { MapPlayerPosition, ServerConfig } from '../shared/types'

/**
 * 外部启动的服务端：RCON 没开时，至少从 latest.log 的登录 / 退出事件里
 * 认出谁在线。登录行通常带初始坐标，可以在地图上先标一个位置；真正实时的
 * 坐标仍然需要 RCON 或 CraftDesk 自己管理的 stdin。
 */

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

interface LogOnline {
  name: string
  x?: number
  y?: number
  z?: number
}

/** 读 latest.log 的尾部；从最近一次服务器启动开始解析，避免把上个会话的玩家算进来 */
async function readLogTail(core: string): Promise<string> {
  try {
    const file = join(core, 'logs', 'latest.log')
    const fh = await fs.open(file, 'r')
    try {
      const st = await fh.stat()
      const len = Math.min(st.size, 4 * 1024 * 1024)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, st.size - len)
      const text = buf.toString('utf-8')
      const start = text.lastIndexOf('Starting minecraft server version')
      return start >= 0 ? text.slice(start) : text
    } finally {
      await fh.close()
    }
  } catch {
    return ''
  }
}

/** 从日志行里重建在线名单；login 行带坐标，join/leave 维护在线状态 */
export function parseLogOnline(text: string): LogOnline[] {
  const online = new Map<string, LogOnline>()
  for (const line of text.split(/\r?\n/)) {
    if (/Stopping (?:the )?server/.test(line)) {
      online.clear()
      continue
    }
    const login = line.match(
      /([A-Za-z0-9_]{1,16})\[[^\]]*\] logged in with entity id \d+ at \(([-\d.]+), ([-\d.]+), ([-\d.]+)\)/
    )
    if (login) {
      online.set(login[1], {
        name: login[1],
        x: Number(login[2]),
        y: Number(login[3]),
        z: Number(login[4])
      })
      continue
    }
    const joined = line.match(/: ([A-Za-z0-9_]{1,16}) joined the game/)
    if (joined && !online.has(joined[1])) online.set(joined[1], { name: joined[1] })
    const left = line.match(/: ([A-Za-z0-9_]{1,16}) (?:left the game|lost connection)/)
    if (left) online.delete(left[1])
    const kicked = line.match(/Disconnecting ([A-Za-z0-9_]{1,16}) /)
    if (kicked) online.delete(kicked[1])
  }
  return [...online.values()]
}

/** 只给玩家列表用的在线名字（不需要坐标） */
export async function logOnlineNames(core: string): Promise<string[]> {
  if (!core) return []
  return parseLogOnline(await readLogTail(core)).map((p) => p.name)
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

/** 外部启动且没有 RCON 时：从日志里的登录事件得到在线名单与初始坐标 */
async function pollLog(coreDir: string, playersDir: string): Promise<MapPlayerPosition[]> {
  if (!coreDir) return []
  const online = parseLogOnline(await readLogTail(coreDir))
  const names = online.map((p) => p.name)
  const uuids = await readUuidMap(playersDir, names)
  const out: MapPlayerPosition[] = []
  for (const p of online) {
    if (p.x === undefined || p.y === undefined || p.z === undefined) continue
    out.push({
      name: p.name,
      uuid: uuids.get(p.name.toLowerCase()),
      x: p.x,
      y: p.y,
      z: p.z,
      // 登录行没有维度信息；绝大多数情况是主世界。开 RCON 后才会有实时维度
      dimension: 'overworld'
    })
  }
  return out
}

/** 缓存 3 秒；同一台服务器同时只轮询一次 */
export async function getPlayerPositions(
  source: PositionSource,
  cfg: ServerConfig,
  playersDir: string,
  propertiesPath = '',
  coreDir = ''
): Promise<MapPlayerPosition[]> {
  const hit = cache.get(cfg.id)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.list

  const running = inFlight.get(cfg.id)
  if (running) return running

  // 开了 RCON 就优先走 RCON：MCDR 托管时 stdin 是 MCDR 的输入，不一定能到服务端；
  // RCON 是直接连服务端的，稳定得多。没开 RCON / 外部启动时退到日志登录位置。
  const rconReady = propertiesPath ? await readRconConfig(propertiesPath) : null
  let task: Promise<MapPlayerPosition[]>
  if (rconReady) {
    task = pollRcon(propertiesPath, playersDir).catch(() =>
      coreDir ? pollLog(coreDir, playersDir) : []
    )
  } else if (source.isRunning(cfg.id)) {
    task = pollStdin(source, cfg, playersDir).then((list) =>
      list.length || !coreDir ? list : pollLog(coreDir, playersDir)
    )
  } else {
    task = coreDir ? pollLog(coreDir, playersDir) : Promise.resolve([])
  }
  const finalTask = task
    .then((list) => {
      cache.set(cfg.id, { at: Date.now(), list })
      return list
    })
    .finally(() => inFlight.delete(cfg.id))
  inFlight.set(cfg.id, finalTask)
  return finalTask
}

export function forgetPositions(id: string): void {
  cache.delete(id)
}
