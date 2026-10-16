import { useEffect, useState } from 'react'

/**
 * 服务器图标的缓存。
 *
 * 同一张图会在左树、工具栏、总览、属性页同时出现，每次都走一次 IPC
 * 把图片读成 base64 太浪费（一张 200 KB 的图来回读四遍）。
 * 按文件名缓存：文件名就是 `<serverId>.<ext>`，换图必然换名字或覆盖同一
 * 个名字 —— 覆盖的情况由导入方主动 prime 一次（见 ServerIconDialog）。
 */

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

/** 读一张图标；失败记成 null，不再反复重试 */
export function loadIcon(name: string): Promise<string | null> {
  const hit = cache.get(name)
  if (hit !== undefined) return Promise.resolve(hit)
  const running = inflight.get(name)
  if (running) return running

  const task = window.api.app
    .readIcon(name)
    .then((res) => (res.ok ? res.data!.dataUrl : null))
    .catch(() => null)
    .then((url) => {
      cache.set(name, url)
      inflight.delete(name)
      return url
    })

  inflight.set(name, task)
  return task
}

/** 刚保存的图直接放进缓存，界面上立刻就是新的，不用再读一遍 */
export function primeIcon(name: string, dataUrl: string): void {
  cache.set(name, dataUrl)
}

export function forgetIcon(name: string): void {
  cache.delete(name)
}

/** 给组件用的图标地址；没有图标、还没读完、读失败都返回 null */
export function useIcon(name: string | null): string | null {
  const [url, setUrl] = useState<string | null>(() => (name ? cache.get(name) ?? null : null))

  useEffect(() => {
    if (!name) {
      setUrl(null)
      return
    }
    const hit = cache.get(name)
    if (hit !== undefined) {
      setUrl(hit)
      return
    }
    let alive = true
    void loadIcon(name).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [name])

  return url
}
