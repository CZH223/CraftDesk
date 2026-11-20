/**
 * 给 Java 安装器找系统代理。
 *
 * Electron 的网络栈会自动使用系统代理，但 Forge / NeoForge 的安装器是一个
 * 独立 Java 进程，默认只直连。需要把 Chromium 解析出的代理翻译成 JVM 参数，
 * 否则安装器下载运行库时会 SSL/连接失败（典型报错只有一句
 * "There was an error during installation"）。
 */

export interface ProxyInfo {
  type: 'http' | 'socks'
  host: string
  port: number
  user?: string
  pass?: string
}

function fromUrl(raw: string | undefined): ProxyInfo | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!url.hostname) return null
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    if (!Number.isFinite(port) || port <= 0) return null
    return {
      type: url.protocol.startsWith('socks') ? 'socks' : 'http',
      host: url.hostname,
      port,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      pass: url.password ? decodeURIComponent(url.password) : undefined
    }
  } catch {
    return null
  }
}

function fromEnv(): ProxyInfo | null {
  return (
    fromUrl(process.env.HTTPS_PROXY ?? process.env.https_proxy) ??
    fromUrl(process.env.HTTP_PROXY ?? process.env.http_proxy) ??
    fromUrl(process.env.ALL_PROXY ?? process.env.all_proxy)
  )
}

/**
 * 优先问 Chromium 当前 URL 走什么代理，再退回环境变量。
 * 测试环境没有 Electron session，不会执行 require('electron')。
 */
export async function resolveProxyFor(url: string): Promise<ProxyInfo | null> {
  let chromium: string | null = null
  if (process.versions.electron) {
    try {
      const { session } = require('electron') as {
        session?: { defaultSession?: { resolveProxy: (u: string) => Promise<string> } }
      }
      chromium = (await session?.defaultSession?.resolveProxy(url)) ?? null
    } catch {
      chromium = null
    }
  }

  if (chromium) {
    const parts = chromium.split(';').map((s) => s.trim())
    for (const part of parts) {
      if (part === 'DIRECT' || part === 'PROXY DIRECT') continue
      const m = part.match(/^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/i)
      if (!m) continue
      const address = m[2]
      // host:port；IPv6 不是这个场景的常见形态
      const idx = address.lastIndexOf(':')
      if (idx <= 0) continue
      const host = address.slice(0, idx)
      const port = Number(address.slice(idx + 1))
      if (!host || !Number.isFinite(port) || port <= 0) continue
      const env = envMatching(host, port)
      return {
        type: /^SOCKS/i.test(m[1]) ? 'socks' : 'http',
        host,
        port,
        ...(env ? { user: env.user, pass: env.pass } : {})
      }
    }
  }

  return fromEnv()
}

function envMatching(host: string, port: number): ProxyInfo | null {
  const env = fromEnv()
  return env && env.host === host && env.port === port ? env : null
}

/** 给安装器用的 JVM 参数；没有代理由 Java 自己按系统设置尝试 */
export function proxyJvmArgs(proxy: ProxyInfo | null): string[] {
  const args = ['-Djava.net.useSystemProxies=true', '-Dhttp.nonProxyHosts=localhost|127.*|[::1]']
  if (!proxy) return args
  if (proxy.type === 'socks') {
    args.push(`-DsocksProxyHost=${proxy.host}`, `-DsocksProxyPort=${proxy.port}`)
    if (proxy.user) {
      args.push(`-Djava.net.socks.username=${proxy.user}`)
      if (proxy.pass) args.push(`-Djava.net.socks.password=${proxy.pass}`)
    }
    return args
  }
  args.push(
    `-Dhttp.proxyHost=${proxy.host}`,
    `-Dhttp.proxyPort=${proxy.port}`,
    `-Dhttps.proxyHost=${proxy.host}`,
    `-Dhttps.proxyPort=${proxy.port}`
  )
  if (proxy.user) {
    args.push(`-Dhttp.proxyUser=${proxy.user}`, `-Dhttps.proxyUser=${proxy.user}`)
    if (proxy.pass) {
      args.push(`-Dhttp.proxyPassword=${proxy.pass}`, `-Dhttps.proxyPassword=${proxy.pass}`)
    }
  }
  return args
}
