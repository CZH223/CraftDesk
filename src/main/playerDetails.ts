import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { PlayerItem, PlayerProfile, ServerConfig } from '../shared/types'
import type { ServerLayout } from './layout'
import { getProperty, parsePropertiesFile } from './properties'
import {
  nbtArray,
  nbtCompound,
  nbtNumber,
  nbtString,
  parseNbt,
  type NbtCompound
} from './nbt'
import { normalizeDimension } from './positions'

/**
 * 地图右侧玩家面板的数据来源。
 *
 * 坐标来自正在运行的服务端；经验 / 背包 / 末影箱 / 潜影盒来自
 * `world/playerdata/<uuid>.dat` 的最近一次保存（服务端会在自动保存时写盘）。
 * 正版状态和 UUID 用 Mojang 的公开接口核对，皮肤用 Mineatar 的全身渲染，
 * 物品图标按当前 Minecraft 版本从公开的资源仓库取。所有网络结果都做缓存，
 * 取不到只影响对应字段，不会让整个档案失败。
 */

const UA = 'CraftDesk/1.2 (Minecraft server manager)'
const PREMIUM_TTL = 7 * 24 * 60 * 60 * 1000
const PREMIUM_MISS_TTL = 60 * 60 * 1000
const PREMIUM_ERROR_TTL = 5 * 60 * 1000
const IMAGE_TTL = 7 * 24 * 60 * 60 * 1000
const IMAGE_MISS_TTL = 60 * 60 * 1000
const ICON_MISS_TTL = 10 * 60 * 1000
const MAX_ITEM_ICONS = 200

/**
 * 走 Electron 的 net.fetch，而不是 Node 的全局 fetch。
 *
 * 公司 / 校园网里 jsDelivr、Mojang 往往需要系统代理；Node fetch 不读
 * HTTP(S)_PROXY，会一直挂到超时（图标看起来像永远加载不出来）。net.fetch
 * 用 Chromium 的网络栈，自动遵循系统代理设置。
 */
async function httpFetch(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await net.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA }
    })
  } finally {
    clearTimeout(timer)
  }
}

interface PremiumLookup {
  at: number
  premium: boolean | null
  uuid: string | null
  name: string | null
  ttl: number
}

const premiumCache = new Map<string, PremiumLookup>()
const iconMemory = new Map<string, string | null>()
const skinMemory = new Map<string, string | null>()

function validName(name: string): string | null {
  return /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : null
}

function dataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

function isPng(buf: Buffer): boolean {
  return buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
}

function dashed(uuid: string): string {
  const clean = uuid.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(clean)) return uuid
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`
}

/** Java 的离线 UUID：md5("OfflinePlayer:" + 名字)，版本 3 */
export function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`).digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function uuidFromInts(arr: unknown[]): string | null {
  if (arr.length !== 4) return null
  const hex = arr
    .map((n) => (Number(n) >>> 0).toString(16).padStart(8, '0'))
    .join('')
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function lookupPremium(name: string): Promise<PremiumLookup> {
  const key = name.toLowerCase()
  const hit = premiumCache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit

  let result: PremiumLookup
  try {
    const res = await httpFetch(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
      8000
    )
    if (res.status === 200) {
      const body = (await res.json()) as { id?: string; name?: string }
      result = {
        at: Date.now(),
        premium: Boolean(body.id),
        uuid: body.id ? dashed(body.id) : null,
        name: body.name ?? null,
        ttl: PREMIUM_TTL
      }
    } else if (res.status === 404) {
      result = { at: Date.now(), premium: false, uuid: null, name: null, ttl: PREMIUM_MISS_TTL }
    } else {
      result = { at: Date.now(), premium: null, uuid: null, name: null, ttl: PREMIUM_ERROR_TTL }
    }
  } catch {
    result = { at: Date.now(), premium: null, uuid: null, name: null, ttl: PREMIUM_ERROR_TTL }
  }
  premiumCache.set(key, result)
  return result
}

async function readUsercacheUuids(playersDir: string, name: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(join(playersDir, 'usercache.json'), 'utf-8')
    const list = JSON.parse(raw) as { name?: string; uuid?: string }[]
    return list
      .filter((e) => e.name?.toLowerCase() === name.toLowerCase() && e.uuid)
      .map((e) => e.uuid!)
  } catch {
    return []
  }
}

async function worldDirOf(layout: ServerLayout): Promise<string> {
  let levelName = 'world'
  try {
    const props = await parsePropertiesFile(layout.serverProperties)
    levelName = getProperty(props, 'level-name') || 'world'
  } catch {
    /* 默认 world */
  }
  const candidate = join(layout.core, levelName)
  try {
    const st = await fs.stat(candidate)
    if (st.isDirectory()) return candidate
  } catch {
    /* 再看默认目录 */
  }
  return join(layout.core, 'world')
}

interface PlayerData {
  file: string
  uuid: string
  savedAt: number
  root: NbtCompound
}

async function findPlayerData(
  layout: ServerLayout,
  candidates: string[]
): Promise<PlayerData | null> {
  const world = await worldDirOf(layout)
  const dirs = [
    // 26.x 的新世界布局：players/ 或 players/data/
    join(world, 'players'),
    join(world, 'players', 'data'),
    join(world, 'playerdata'),
    join(world, 'DIM-1', 'playerdata'),
    join(world, 'DIM1', 'playerdata'),
    join(world, 'dimensions', 'minecraft', 'overworld', 'playerdata'),
    join(world, 'dimensions', 'minecraft', 'the_nether', 'playerdata'),
    join(world, 'dimensions', 'minecraft', 'the_end', 'playerdata')
  ]

  const ids = [...new Set(candidates.map(dashed).filter((u) => /^[0-9a-f-]{36}$/i.test(u)))]
  let best: { file: string; uuid: string; savedAt: number } | null = null
  for (const dir of dirs) {
    for (const uuid of ids) {
      for (const suffix of ['.dat', '.dat_old']) {
        const file = join(dir, `${uuid}${suffix}`)
        try {
          const st = await fs.stat(file)
          if (!best || st.mtimeMs > best.savedAt) {
            best = { file, uuid, savedAt: st.mtimeMs }
          }
        } catch {
          /* 这个维度没有该玩家 */
        }
      }
    }
  }
  if (!best) return null

  try {
    const raw = await fs.readFile(best.file)
    let root: NbtCompound
    try {
      root = parseNbt(gunzipSync(raw))
    } catch {
      root = parseNbt(raw)
    }
    const actual = uuidFromInts(nbtArray(root.UUID)) ?? best.uuid
    return { file: best.file, uuid: actual, savedAt: best.savedAt, root }
  } catch {
    return null
  }
}

/** 1.20.5+ 的组件式物品 / 旧版 tag 物品都认 */
function containerOf(raw: NbtCompound, depth: number): PlayerItem[] | null {
  if (depth > 3) return null

  const components = nbtCompound(raw.components)
  const componentContainer = nbtArray(components['minecraft:container'])
  if (componentContainer.length) {
    const out: PlayerItem[] = []
    for (let i = 0; i < componentContainer.length; i++) {
      const entry = nbtCompound(componentContainer[i])
      const item = parseItem(nbtCompound(entry.item), depth + 1, nbtNumber(entry.slot) || i)
      if (item) out.push(item)
    }
    return out.length ? out : null
  }

  const bundle = nbtArray(components['minecraft:bundle_contents'])
  if (bundle.length) {
    const out: PlayerItem[] = []
    for (let i = 0; i < bundle.length; i++) {
      const item = parseItem(bundle[i], depth + 1, i)
      if (item) out.push(item)
    }
    return out.length ? out : null
  }

  const tag = nbtCompound(raw.tag)
  const blockEntity = nbtCompound(tag.BlockEntityTag)
  const legacy = nbtArray(blockEntity.Items).length
    ? nbtArray(blockEntity.Items)
    : nbtArray(tag.Items)
  if (legacy.length) {
    const out: PlayerItem[] = []
    for (const entry of legacy) {
      const item = parseItem(entry, depth + 1)
      if (item) out.push(item)
    }
    return out.length ? out : null
  }
  return null
}

function parseItem(raw: unknown, depth = 0, slotOverride?: number): PlayerItem | null {
  if (depth > 3) return null
  const item = nbtCompound(raw)
  let id = nbtString(item.id)
  // 很老的版本会把 id 写成数字，现代存档用字符串
  if (!id) return null
  if (id === 'minecraft:air' || id === 'air') return null

  const count = Math.max(
    1,
    nbtNumber(item.count) || nbtNumber(item.Count) || 1
  )
  const slot = slotOverride ?? nbtNumber(item.Slot)
  const container = containerOf(item, depth)
  return {
    slot: Number.isFinite(slot) ? slot : 0,
    id: id.replace(/^minecraft:/, ''),
    count: Math.min(9999, Math.round(count)),
    container
  }
}

function parseItems(raw: unknown[]): PlayerItem[] {
  const out: PlayerItem[] = []
  for (const entry of raw) {
    const item = parseItem(entry)
    if (item) out.push(item)
  }
  return out
}

function inventoryFrom(root: NbtCompound): Pick<
  PlayerProfile,
  'inventory' | 'armor' | 'offhand' | 'enderItems' | 'selectedSlot'
> {
  const items = parseItems(nbtArray(root.Inventory))
  const bySlot = new Map<number, PlayerItem>()
  for (const item of items) bySlot.set(item.slot, item)

  const inventory = items.filter((i) => i.slot >= 0 && i.slot <= 35)
  const armor: PlayerItem[] = []
  for (const slot of [100, 101, 102, 103]) {
    const hit = bySlot.get(slot)
    if (hit) armor.push(hit)
  }

  const equipment = nbtCompound(root.equipment)
  const equipmentSlots: [string, number][] = [
    ['head', 100],
    ['chest', 101],
    ['legs', 102],
    ['feet', 103]
  ]
  for (const [key, slot] of equipmentSlots) {
    if (bySlot.has(slot)) continue
    const parsed = parseItem(equipment[key], 0, slot)
    if (parsed) armor.push(parsed)
  }
  armor.sort((a, b) => a.slot - b.slot)

  let offhand = bySlot.get(-106) ?? null
  if (!offhand) offhand = parseItem(equipment.offhand, 0, -106)

  const enderItems = parseItems(nbtArray(root.EnderItems))
    .filter((i) => i.slot >= 0 && i.slot <= 26)
    .sort((a, b) => a.slot - b.slot)

  return {
    inventory,
    armor,
    offhand,
    enderItems,
    selectedSlot: nbtNumber(root.SelectedItemSlot) || 0
  }
}

async function fetchPng(urls: string[], timeoutMs = 10000): Promise<Buffer | null> {
  for (const url of urls) {
    try {
      const res = await httpFetch(url, timeoutMs)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (!isPng(buf) || buf.length > 8 * 1024 * 1024) continue
      return buf
    } catch {
      /* 换下一个源 */
    }
  }
  return null
}

async function skinFor(
  name: string,
  premiumUuid: string | null,
  serverUuid: string
): Promise<string | null> {
  const key = `${name.toLowerCase()}|${premiumUuid ?? ''}|${serverUuid}`
  const cached = skinMemory.get(key)
  if (cached !== undefined) return cached

  const dir = join(app.getPath('userData'), 'skins')
  const hash = createHash('sha1').update(key).digest('hex')
  const pngPath = join(dir, `${hash}.png`)
  const missPath = join(dir, `${hash}.miss`)

  try {
    const st = await fs.stat(pngPath)
    if (Date.now() - st.mtimeMs < IMAGE_TTL) {
      const url = dataUrl(await fs.readFile(pngPath))
      skinMemory.set(key, url)
      return url
    }
  } catch {
    /* 无缓存 */
  }
  try {
    const st = await fs.stat(missPath)
    if (Date.now() - st.mtimeMs < IMAGE_MISS_TTL) {
      skinMemory.set(key, null)
      return null
    }
  } catch {
    /* 没有失败记录 */
  }

  const urls: string[] = []
  // ccvaults 的全身渲染来自 Mineatar；优先用正版 UUID，皮肤最准
  if (premiumUuid) {
    urls.push(
      `https://api.mineatar.io/body/full/${premiumUuid}?scale=8&overlay=true`
    )
  }
  urls.push(`https://mc-heads.net/body/${encodeURIComponent(name)}/256`)
  if (serverUuid) {
    urls.push(
      `https://api.mineatar.io/body/full/${serverUuid}?scale=8&overlay=true`,
      `https://crafatar.com/renders/body/${serverUuid}?scale=8&overlay`
    )
  }

  const buf = await fetchPng(urls)
  try {
    await fs.mkdir(dir, { recursive: true })
    if (buf) {
      await fs.writeFile(pngPath, buf)
      await fs.rm(missPath, { force: true })
      const url = dataUrl(buf)
      skinMemory.set(key, url)
      return url
    }
    await fs.writeFile(missPath, '')
  } catch {
    /* 缓存写不进去也照样返回 */
  }
  const url = buf ? dataUrl(buf) : null
  skinMemory.set(key, url)
  return url
}

export async function getPlayerProfile(
  cfg: ServerConfig,
  layout: ServerLayout,
  rawName: string,
  uuidHint?: string
): Promise<PlayerProfile> {
  const name = validName(rawName)
  if (!name) throw new Error('玩家名格式不正确')

  const candidates = [uuidHint, offlineUuid(name), ...(await readUsercacheUuids(layout.playersDir, name))]
  const premiumTask = lookupPremium(name)
  let data = await findPlayerData(layout, candidates.filter(Boolean) as string[])
  const premium = await premiumTask
  if (!data && premium.uuid) data = await findPlayerData(layout, [premium.uuid])

  const serverUuid = data?.uuid ?? (uuidHint ? dashed(uuidHint) : offlineUuid(name))
  const skin = await skinFor(name, premium.uuid, serverUuid)

  const root = data?.root ?? {}
  const inv = inventoryFrom(root)
  return {
    name,
    uuid: serverUuid,
    premium: premium.premium,
    premiumUuid: premium.uuid,
    skin,
    xpLevel: nbtNumber(root.XpLevel) || 0,
    xpTotal: nbtNumber(root.XpTotal) || 0,
    health: nbtNumber(root.Health) || 0,
    food: nbtNumber(root.foodLevel) || 0,
    dimension: normalizeDimension(nbtString(root.Dimension)),
    savedAt: data?.savedAt ?? null,
    ...inv
  }
}

// ---------------------------------------------------------------- 物品图标

function assetsTag(version: string): string {
  return /^\d+\.\d+(?:\.\d+)?$/.test(version) ? version : 'master'
}

async function fetchIcon(
  tag: string,
  id: string,
  cacheDir: string
): Promise<string | null> {
  const safe = id.replace(/[^a-z0-9_./-]/gi, '')
  if (!safe || safe.includes('..') || safe.includes('/')) return null
  const cacheKey = `${tag}:${safe}`
  if (iconMemory.has(cacheKey)) return iconMemory.get(cacheKey)!

  const pngPath = join(cacheDir, `${safe}.png`)
  const missPath = join(cacheDir, `${safe}.miss`)
  try {
    const st = await fs.stat(pngPath)
    if (Date.now() - st.mtimeMs < IMAGE_TTL) {
      const url = dataUrl(await fs.readFile(pngPath))
      iconMemory.set(cacheKey, url)
      return url
    }
  } catch {
    /* 没缓存 */
  }
  try {
    const st = await fs.stat(missPath)
    if (Date.now() - st.mtimeMs < ICON_MISS_TTL) {
      iconMemory.set(cacheKey, null)
      return null
    }
  } catch {
    /* 没有失败记录 */
  }

  const base = `https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${tag}/assets/minecraft/textures`
  const special: string[] = []
  if (safe === 'shield') special.push(`${base}/entity/shield_base.png`)
  if (safe === 'ender_chest') special.push(`${base}/entity/chest/ender.png`)
  if (safe === 'chest' || safe === 'trapped_chest') {
    special.push(`${base}/entity/chest/normal.png`)
  }
  if (safe.endsWith('_banner')) special.push(`${base}/entity/banner_base.png`)
  if (safe === 'crossbow') special.push(`${base}/item/crossbow_standby.png`)
  if (safe === 'clock') special.push(`${base}/item/clock_00.png`)
  if (safe === 'compass') special.push(`${base}/item/compass_00.png`)
  if (safe === 'recovery_compass') {
    special.push(`${base}/item/recovery_compass_00.png`)
  }
  if (safe === 'enchanted_golden_apple') special.push(`${base}/item/golden_apple.png`)

  const buf = await fetchPng(
    [
      ...special,
      `${base}/item/${safe}.png`,
      `${base}/block/${safe}.png`,
      // 很多方块没有和 id 同名的贴图（grass_block 只有 _side / _top）
      `${base}/block/${safe}_side.png`,
      `${base}/block/${safe}_top.png`,
      `${base}/block/${safe}_front.png`
    ],
    6000
  )
  try {
    await fs.mkdir(cacheDir, { recursive: true })
    if (buf) {
      await fs.writeFile(pngPath, buf)
      await fs.rm(missPath, { force: true })
      const url = dataUrl(buf)
      iconMemory.set(cacheKey, url)
      return url
    }
    await fs.writeFile(missPath, '')
  } catch {
    /* 忽略缓存错误 */
  }
  const url = buf ? dataUrl(buf) : null
  iconMemory.set(cacheKey, url)
  return url
}

export async function getItemIcons(
  mcVersion: string,
  ids: string[]
): Promise<Record<string, string | null>> {
  const tag = assetsTag(mcVersion)
  const cacheDir = join(app.getPath('userData'), 'itemicons', tag)
  const unique = [...new Set(ids)]
    .filter((id) => /^[a-z0-9_.-]{1,80}$/i.test(id))
    .slice(0, MAX_ITEM_ICONS)

  const out: Record<string, string | null> = {}
  let index = 0
  const workers = Array.from({ length: Math.min(8, unique.length) }, async () => {
    for (;;) {
      const i = index++
      if (i >= unique.length) return
      const id = unique[i]
      out[id] = await fetchIcon(tag, id, cacheDir)
    }
  })
  await Promise.all(workers)
  return out
}
