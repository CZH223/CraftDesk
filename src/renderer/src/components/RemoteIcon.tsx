import { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * 下载源给的图标。
 *
 * 渲染进程不能直接 `<img src="https://...">` —— 页面 CSP 是
 * `img-src 'self' data:`，外链图片会被拦掉。表现是**一排破图**：
 * 用户看到的是「图标加载不出来」，实际是浏览器根本没发那个请求。
 *
 * 所以统一走主进程抓一次、转成 data URL（见 main/images.ts）。
 * 抓不到（网络不通、站点 404、不是图片）就退回占位图 ——
 * 宁可显示一个方块，也不要一个破图。
 */

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

export function loadRemoteIcon(url: string): Promise<string | null> {
  const hit = cache.get(url)
  if (hit !== undefined) return Promise.resolve(hit)
  const running = inflight.get(url)
  if (running) return running

  const task = window.api.app
    .fetchImage(url)
    .then((res) => (res.ok ? res.data!.dataUrl : null))
    .catch(() => null)
    .then((dataUrl) => {
      cache.set(url, dataUrl)
      inflight.delete(url)
      return dataUrl
    })

  inflight.set(url, task)
  return task
}

export function useRemoteIcon(url: string | null): string | null {
  const [src, setSrc] = useState<string | null>(() => (url ? cache.get(url) ?? null : null))

  useEffect(() => {
    if (!url) {
      setSrc(null)
      return
    }
    const hit = cache.get(url)
    if (hit !== undefined) {
      setSrc(hit)
      return
    }
    let alive = true
    void loadRemoteIcon(url).then((dataUrl) => {
      if (alive) setSrc(dataUrl)
    })
    return () => {
      alive = false
    }
  }, [url])

  return src
}

export function RemoteIcon({
  url,
  className = 'mod-icon',
  fallback = 'package'
}: {
  url: string | null
  className?: string
  /** 没有图标（或者没抓下来）时显示的图标名 */
  fallback?: IconName
}): JSX.Element {
  const src = useRemoteIcon(url)
  if (!src) {
    return (
      <span className={`${className} placeholder`}>
        <Icon name={fallback} size={16} />
      </span>
    )
  }
  return <img className={className} src={src} alt="" draggable={false} />
}
