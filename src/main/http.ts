/**
 * 主进程统一用 Electron 的 net.fetch。
 *
 * Node 自带的 fetch 不读系统的 HTTP(S)_PROXY；在需要代理的网络环境里，
 * 直接连 Maven / jsDelivr / GitHub 很容易卡到超时。net.fetch 走 Chromium
 * 网络栈，会自动遵循系统代理。测试脚本跑在普通 Node 里，没有 Electron，
 * 这时退回全局 fetch。
 *
 * 不能在文件顶部静态 import electron：在纯 Node 环境下它会直接抛
 * "Electron failed to install correctly"，连测试都加载不了。
 */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

let cached: FetchLike | null | undefined

function electronNetFetch(): FetchLike | undefined {
  if (cached !== undefined) return cached ?? undefined
  if (!process.versions.electron) {
    cached = null
    return undefined
  }
  try {
    // 运行在 Electron 主进程里时才 require；测试环境上面已经提前返回
    const electron = require('electron') as {
      net?: { fetch?: FetchLike }
    }
    cached = typeof electron.net?.fetch === 'function' ? electron.net.fetch : null
  } catch {
    cached = null
  }
  return cached ?? undefined
}

export function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  const electronFetch = electronNetFetch()
  if (electronFetch) return electronFetch(url, init)
  return fetch(url, init)
}
