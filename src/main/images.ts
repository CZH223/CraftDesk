import { promises as fs } from 'node:fs'
import { extname } from 'node:path'

const UA = 'CraftDesk/1.0 (Minecraft server manager)'

/**
 * 本地图片的读取与校验。
 *
 * 两处用得上：界面背景（`app:readImage`）和服务器图标（`app:readIcon`）。
 * 校验只有这一份 —— 白名单放在主进程，界面传什么都拦得住。
 *
 * 为什么不把 `file://` 路径直接交给 CSS：页面的 CSP 是 `img-src 'self' data:`，
 * 放开 `file:` 等于让渲染进程能读任意本地文件。走这里一次，
 * 还能顺手限制扩展名与体积（几 MB 的图转 base64 很占内存）。
 */

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

export const IMAGE_EXTS = Object.keys(IMAGE_MIME).map((e) => e.slice(1))

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

export interface ImageMeta {
  type: string
  ext: string
  bytes: number
}

/** 校验一张图片，返回它的类型与字节数。抛出的错误信息是给用户看的 */
export async function validateImage(file: string): Promise<ImageMeta> {
  const ext = extname(file).toLowerCase()
  const type = IMAGE_MIME[ext]
  if (!type) {
    throw new Error(
      `不支持的图片格式：${ext || '(没有扩展名)'}，请用 ${IMAGE_EXTS.join(' / ')}`
    )
  }

  let st: Awaited<ReturnType<typeof fs.stat>>
  try {
    st = await fs.stat(file)
  } catch {
    throw new Error('找不到这个文件')
  }
  if (!st.isFile()) throw new Error('选中的不是文件')
  if (st.size === 0) throw new Error('这个文件是空的')
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `图片太大了（${(st.size / 1024 / 1024).toFixed(1)} MB），请换一张 ${Math.round(
        MAX_IMAGE_BYTES / 1024 / 1024
      )} MB 以内的`
    )
  }
  return { type, ext, bytes: st.size }
}

export interface ImageData {
  dataUrl: string
  bytes: number
}

// ---------------------------------------------------------------- 网络图片

/**
 * 下载源给的图标（Modrinth / Hangar / MCDR 插件目录…）。
 *
 * 为什么不让渲染进程直接 `<img src="https://...">`：页面 CSP 是
 * `img-src 'self' data:`，放开 https 等于允许页面往任意地址发请求
 * （谁在看你、看你哪一页，都成了外部站点能收集的信息）。
 * 走主进程下载一次、转成 data URL，CSP 不用松，也能顺手限制体积。
 */
const REMOTE_CACHE_MAX = 120
const MAX_REMOTE_ICON_BYTES = 5 * 1024 * 1024
const REMOTE_TIMEOUT = 15000

/** url → 图片。Map 的插入顺序当 LRU 用：命中就挪到队尾，超了就丢队头 */
const remoteCache = new Map<string, ImageData>()

/**
 * 只接受 https 的图片地址。
 *
 * 单独拆出来是因为这一段是纯判断（不联网），可以离线断言：
 * 列表里的 url 来自外部接口，`file:` / `data:` 这些协议不能顺着往下走。
 */
export function assertRemoteImageUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`图片地址不合法：${raw || '(空)'}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`只允许 https 图片地址，收到的是 ${url.protocol}`)
  }
  return url
}

export async function fetchImageDataUrl(
  raw: string
): Promise<ImageData & { cached: boolean }> {
  const url = assertRemoteImageUrl(raw)
  const key = url.href

  const hit = remoteCache.get(key)
  if (hit) {
    // 挪到队尾，表示刚用过
    remoteCache.delete(key)
    remoteCache.set(key, hit)
    return { ...hit, cached: true }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REMOTE_TIMEOUT)
  let res: Response
  try {
    res = await fetch(key, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
  } catch (err) {
    throw new Error(`图片下载失败：${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw new Error(`图片下载失败：HTTP ${res.status}`)

  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!type.startsWith('image/')) {
    throw new Error(`这个地址返回的不是图片（${type || '没有 content-type'}）`)
  }
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_REMOTE_ICON_BYTES) {
    throw new Error(`图片太大（${(declared / 1024 / 1024).toFixed(1)} MB），已跳过`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > MAX_REMOTE_ICON_BYTES) {
    throw new Error(`图片太大（${(buf.byteLength / 1024 / 1024).toFixed(1)} MB），已跳过`)
  }

  const data: ImageData = {
    dataUrl: `data:${type};base64,${buf.toString('base64')}`,
    bytes: buf.byteLength
  }
  remoteCache.set(key, data)
  while (remoteCache.size > REMOTE_CACHE_MAX) {
    const oldest = remoteCache.keys().next().value
    if (oldest === undefined) break
    remoteCache.delete(oldest)
  }
  return { ...data, cached: false }
}

/** 读成 data URL，交给渲染进程用 */
export async function readImageDataUrl(file: string): Promise<ImageData> {
  const { type } = await validateImage(file)
  const buf = await fs.readFile(file)
  return { dataUrl: `data:${type};base64,${buf.toString('base64')}`, bytes: buf.byteLength }
}
