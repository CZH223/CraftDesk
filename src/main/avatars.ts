import { app } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 玩家头像。
 *
 * 服务端本身不存皮肤，离线模式下更是只有一个「离线 UUID」，所以头像只能
 * 从第三方渲染服务拿（mc-heads / Minotar / Crafatar）。这里做三件事：
 *   - 名字、UUID 都做格式校验，URL 只拼经过 encodeURIComponent 的合法值；
 *   - 按「名字 + UUID」缓存 7 天，取不到也缓存 1 小时，避免反复请求；
 *   - 最多 4 个并发、8 秒超时，失败就交给界面显示首字母占位。
 *
 * 不依赖具体某个服务：一个挂了就换下一个。
 */

const TTL = 7 * 24 * 60 * 60 * 1000
const MISS_TTL = 60 * 60 * 1000
const MAX_PLAYERS = 200
const CONCURRENCY = 6

const inFlight = new Map<string, Promise<string | null>>()

function cacheDir(): string {
  return join(app.getPath('userData'), 'avatars')
}

function validName(name: string): string | null {
  return /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : null
}

function validUuid(uuid: string | undefined): string | null {
  if (!uuid) return null
  const clean = uuid.replace(/-/g, '')
  return /^[0-9a-f]{32}$/i.test(clean) ? clean : null
}

function dataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

async function fetchHead(name: string, uuid: string | null): Promise<Buffer | null> {
  // 先按名字查：离线服的 usercache 里是离线 UUID，拿它去查头像多半是默认皮肤；
  // 名字能匹配到正版皮肤（正版服和离线服都更接近玩家实际看到的样子）。
  const urls = [
    `https://mc-heads.net/avatar/${encodeURIComponent(name)}/64`,
    `https://minotar.net/helm/${encodeURIComponent(name)}/64.png`,
    ...(uuid
      ? [
          // ccvaults.com/skins 背后用的就是 Mineatar；它只接受 UUID
          `https://api.mineatar.io/head/${uuid}?scale=8&overlay=true`,
          `https://crafatar.com/avatars/${uuid}?size=64&overlay`,
          `https://minotar.net/helm/${uuid}/64.png`
        ]
      : [])
  ]

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'CraftDesk/1.0 (Minecraft server manager)' }
      })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      // 只收真正的 PNG，别把错误页当头像存下来
      if (buf.length < 100 || buf.length > 1024 * 1024) continue
      if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) continue
      return buf
    } catch {
      /* 下一个源 */
    }
  }
  return null
}

async function one(name: string, uuid: string | null): Promise<string | null> {
  const dir = cacheDir()
  const hash = createHash('sha1').update(`${name.toLowerCase()}|${uuid ?? ''}`).digest('hex')
  const png = join(dir, `${hash}.png`)
  const miss = join(dir, `${hash}.miss`)

  try {
    const st = await fs.stat(png)
    if (Date.now() - st.mtimeMs < TTL) return dataUrl(await fs.readFile(png))
  } catch {
    /* 没缓存 */
  }
  try {
    const st = await fs.stat(miss)
    if (Date.now() - st.mtimeMs < MISS_TTL) return null
  } catch {
    /* 没有失败记录 */
  }

  const buf = await fetchHead(name, uuid)
  try {
    await fs.mkdir(dir, { recursive: true })
    if (buf) {
      await fs.writeFile(png, buf)
      await fs.rm(miss, { force: true })
      return dataUrl(buf)
    }
    await fs.writeFile(miss, '')
  } catch {
    /* 缓存写不进去也照样返回图片 */
  }
  return buf ? dataUrl(buf) : null
}

async function pooled<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = index++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

export async function getAvatars(
  players: { name: string; uuid?: string }[]
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  const unique = new Map<string, { name: string; uuid: string | null }>()

  for (const p of players.slice(0, MAX_PLAYERS)) {
    const name = validName(p.name)
    if (!name) continue
    unique.set(name.toLowerCase(), { name, uuid: validUuid(p.uuid) })
  }

  await pooled([...unique.values()], CONCURRENCY, async (p) => {
    const key = p.name.toLowerCase()
    let task = inFlight.get(key)
    if (!task) {
      task = one(p.name, p.uuid).finally(() => inFlight.delete(key))
      inFlight.set(key, task)
    }
    out[p.name] = await task
  })

  return out
}
