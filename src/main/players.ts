import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PlayerRecord } from '../shared/types'

interface MojangEntry {
  name?: string
  uuid?: string
  level?: number
  reason?: string
  expires?: string
  created?: string
  source?: string
  bypassesPlayerLimit?: boolean
}

async function readJsonArray<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

async function writeJsonArray(file: string, data: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
}

/** 汇总 ops / whitelist / banned / usercache 与当前在线列表 */
export async function listPlayers(dir: string, online: string[]): Promise<PlayerRecord[]> {
  if (!dir) return []

  const [ops, whitelist, banned, cache] = await Promise.all([
    readJsonArray<MojangEntry>(join(dir, 'ops.json')),
    readJsonArray<MojangEntry>(join(dir, 'whitelist.json')),
    readJsonArray<MojangEntry>(join(dir, 'banned-players.json')),
    readJsonArray<{ name?: string; uuid?: string; expiresOn?: string }>(join(dir, 'usercache.json'))
  ])

  const map = new Map<string, PlayerRecord>()
  const ensure = (name: string): PlayerRecord => {
    let r = map.get(name)
    if (!r) {
      r = { name, online: false, op: false, whitelisted: false, banned: false }
      map.set(name, r)
    }
    return r
  }

  for (const e of cache) if (e.name) ensure(e.name).uuid = e.uuid
  for (const e of whitelist) if (e.name) ensure(e.name).whitelisted = true
  for (const e of banned) if (e.name) ensure(e.name).banned = true
  for (const e of ops) if (e.name) ensure(e.name).op = true
  for (const name of online) ensure(name).online = true

  const list = [...map.values()]
  // 在线 > OP > 白名单 > 其他，同级按名字排
  list.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    if (a.op !== b.op) return a.op ? -1 : 1
    if (a.whitelisted !== b.whitelisted) return a.whitelisted ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return list
}

/** 切换 OP（直接改 ops.json，运行中会额外发一条指令） */
export async function setOp(dir: string, name: string, value: boolean): Promise<void> {
  const file = join(dir, 'ops.json')
  const ops = await readJsonArray<MojangEntry>(file)
  const idx = ops.findIndex((o) => o.name?.toLowerCase() === name.toLowerCase())
  if (value && idx < 0) {
    ops.push({
      uuid: await lookupUuid(dir, name),
      name,
      level: 4,
      bypassesPlayerLimit: false
    })
  } else if (!value && idx >= 0) {
    ops.splice(idx, 1)
  }
  await writeJsonArray(file, ops)
}

/** 切换白名单 */
export async function setWhitelist(dir: string, name: string, value: boolean): Promise<void> {
  const file = join(dir, 'whitelist.json')
  const wl = await readJsonArray<MojangEntry>(file)
  const idx = wl.findIndex((o) => o.name?.toLowerCase() === name.toLowerCase())
  if (value && idx < 0) {
    wl.push({ uuid: await lookupUuid(dir, name), name })
  } else if (!value && idx >= 0) {
    wl.splice(idx, 1)
  }
  await writeJsonArray(file, wl)
}

/** 解除封禁 */
export async function setBanned(dir: string, name: string, value: boolean): Promise<void> {
  const file = join(dir, 'banned-players.json')
  const list = await readJsonArray<MojangEntry>(file)
  const idx = list.findIndex((o) => o.name?.toLowerCase() === name.toLowerCase())
  if (value && idx < 0) {
    list.push({
      uuid: await lookupUuid(dir, name),
      name,
      created: new Date().toISOString(),
      source: 'CraftDesk',
      expires: 'forever',
      reason: '手动封禁'
    })
  } else if (!value && idx >= 0) {
    list.splice(idx, 1)
  }
  await writeJsonArray(file, list)
}

/** 从 usercache 里查 uuid；查不到就用离线 UUID 规则之外的空串 */
async function lookupUuid(dir: string, name: string): Promise<string> {
  const cache = await readJsonArray<{ name?: string; uuid?: string }>(join(dir, 'usercache.json'))
  const hit = cache.find((c) => c.name?.toLowerCase() === name.toLowerCase())
  return hit?.uuid ?? ''
}
