import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isProxyKind, type ServerKind } from '../shared/types'
import type { ServerLayout } from './layout'

/**
 * 「这台服务端到底能不能当代理端的后端」。
 *
 * 只把地址写进代理端的 `[servers]` 是不够的：后端还得有办法接收代理端传来的
 * 玩家 IP 和 UUID，否则玩家一到转发那步就被踢回去。转发方式有三种：
 *
 * 1. Fabric 系装 FabricProxy / FabricProxy-Lite（读它的 config 拿密钥）
 *    - FabricProxy-Lite 只支持 Velocity 的 modern 转发；BungeeCord / Waterfall
 *      连上来会被它用 disconnectMessage 踢掉（默认文案是「This server requires
 *      you to connect with Velocity.」）。Bungee 后端要用完整版 FabricProxy。
 * 2. Paper 系用原生的 Velocity 转发（config/paper-global.yml 里 proxies.velocity）
 * 3. Bukkit 系用传统的 BungeeCord 转发（spigot.yml 里 settings.bungeecord）
 *
 * 只看第 1 种会把最常见的那套（Paper + 原生转发）判成「不是后端」，
 * 所以三种都要认。判定结果用来决定它在拓扑里挂在代理端下面、还是算独立服务器。
 */

export const PROXY_MODS: { key: string; pattern: RegExp; config: string[] }[] = [
  {
    key: 'FabricProxy-Lite',
    pattern: /^fabricproxy[-_]?lite/i,
    config: ['config/FabricProxy-Lite.toml']
  },
  {
    key: 'FabricProxy',
    pattern: /^fabricproxy(?![-_]?lite)/i,
    config: [
      'config/FabricProxy.toml',
      'config/FabricProxy/config.toml',
      'config/fabricproxy.toml'
    ]
  },
  {
    // Forge / NeoForge 的桥接。Bungee 用 LEGACY，Velocity 用 MODERN，
    // 都写在 config/proxy-compatible-forge.toml 的 [forwarding] 里。
    key: 'ProxyCompatibleForge',
    pattern: /^proxy[-_]?compatible[-_]?forge/i,
    config: ['config/proxy-compatible-forge.toml']
  },
  {
    // 同时支持 Bungee 与 Velocity 的 Fabric / NeoForge 桥接，
    // 主要用于 1.21.11 这类 Fabric-Bungeecord-Proxy 已经跟不上的版本。
    key: 'ProxyForward',
    pattern: /^proxyforward/i,
    config: ['config/proxyforward.toml']
  }
]

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/** 在模组目录里找转发模组 */
export async function findProxyMod(
  layout: ServerLayout,
  /** 以代理端格式为准挑一个能用的模组（Lite 只支持 Velocity） */
  proxyFormat?: 'velocity' | 'bungee'
): Promise<{ name: string; file: string; configPath: string | null } | null> {
  if (!layout.modsDir) return null
  let entries: string[]
  try {
    entries = await fs.readdir(layout.modsDir)
  } catch {
    return null
  }

  const jars = entries.filter((e) => /\.jar$/i.test(e))
  const found: { name: string; file: string; configPath: string | null }[] = []

  for (const mod of PROXY_MODS) {
    const hit = jars.find((j) => mod.pattern.test(j.replace(/\.jar$/i, '')))
    if (!hit) continue

    let configPath: string | null = null
    for (const rel of mod.config) {
      const p = join(layout.core, rel)
      try {
        await fs.access(p)
        configPath = p
        break
      } catch {
        /* 下一个候选路径 */
      }
    }
    found.push({ name: mod.key, file: hit, configPath })
  }

  if (!found.length) return null
  /*
   * 两个转发模组同时存在时（比如用户原来用 Velocity、后来改接 Bungee），
   * 不能只看目录顺序：FabricProxy-Lite 排在前面，但它接 Bungee 会把玩家踢掉。
   * 按代理端格式优先挑真正支持的那一个。
   */
  if (proxyFormat === 'bungee') {
    return (
      found.find((m) => m.name === 'ProxyForward') ??
      found.find((m) => m.name !== 'FabricProxy-Lite') ??
      found[0]
    )
  }
  if (proxyFormat === 'velocity') {
    return (
      found.find((m) => m.name === 'FabricProxy-Lite') ??
      found.find((m) => m.name === 'ProxyForward') ??
      found[0]
    )
  }
  return found[0]
}

/** 转发模组的密钥（要和代理端 forwarding.secret 一致） */
export async function probeForwarding(
  layout: ServerLayout,
  proxyFormat?: 'velocity' | 'bungee'
): Promise<{ mod: string | null; secret: string | null }> {
  const mod = await findProxyMod(layout, proxyFormat)
  if (!mod) return { mod: null, secret: null }
  if (!mod.configPath) return { mod: mod.name, secret: null }

  const text = await readIfExists(mod.configPath)
  if (!text) return { mod: mod.name, secret: null }
  // ProxyForward 用 velocity_secret，其它桥接用 secret
  const secret =
    text.match(/^\s*(?:velocity_secret|secret)\s*=\s*["']([^"']*)["']/m)?.[1] ?? null
  return { mod: mod.name, secret }
}

export interface ProxyReady {
  ready: boolean
  /** 靠什么接转发，用于界面上的说明 */
  via: string | null
  /** 接转发的方式：模组 / Paper 原生 / BungeeCord 传统 */
  viaKind: 'mod' | 'paper' | 'bungee' | null
}

/** 这台服务端能不能接代理端的转发 */
export async function probeProxyReady(
  layout: ServerLayout,
  kind: ServerKind | '',
  proxyFormat: 'velocity' | 'bungee' = 'velocity'
): Promise<ProxyReady> {
  const fw = await probeForwarding(layout, proxyFormat)
  if (fw.mod) {
    // Lite 版只实现了 Velocity 的 modern 转发，Bungee/Waterfall 的 legacy 握手它不认
    if (proxyFormat === 'bungee' && fw.mod === 'FabricProxy-Lite') {
      return { ready: false, via: fw.mod, viaKind: 'mod' }
    }
    // ProxyForward 两种都支持，但配置里的 forwarding_mode 必须和代理端对得上
    if (fw.mod === 'ProxyForward') {
      const mod = await findProxyMod(layout, proxyFormat)
      const text = mod?.configPath ? await readIfExists(mod.configPath) : null
      const mode = text?.match(/^\s*forwarding_mode\s*=\s*["']?([a-z]+)/m)?.[1]
      if (mode && (mode === 'bungee') !== (proxyFormat === 'bungee')) {
        return { ready: false, via: fw.mod, viaKind: 'mod' }
      }
    }
    return { ready: true, via: fw.mod, viaKind: 'mod' }
  }

  // Paper 系原生支持 Velocity 转发，不需要模组；但对 Bungee 无效
  if (proxyFormat !== 'bungee' && ['paper', 'purpur', 'spigot', 'bukkit'].includes(kind)) {
    for (const rel of ['config/paper-global.yml', 'config/paper-global.yaml']) {
      const text = await readIfExists(join(layout.core, rel))
      if (text && yamlFlagUnder(text, ['proxies', 'velocity', 'enabled'], 'true')) {
        return { ready: true, via: 'Paper 原生 Velocity 转发', viaKind: 'paper' }
      }
    }
  }

  // BungeeCord 传统转发：spigot.yml 里开 bungeecord
  const spigot = await readIfExists(join(layout.core, 'spigot.yml'))
  if (spigot && yamlFlagUnder(spigot, ['settings', 'bungeecord'], 'true')) {
    return { ready: true, via: 'BungeeCord 转发', viaKind: 'bungee' }
  }

  return { ready: false, via: null, viaKind: null }
}

/**
 * 按缩进在 YAML 里找嵌套的开关，例如 ['proxies','velocity','enabled'] → true。
 *
 * 只为了读这三份格式固定的服务端配置，所以不去引入 YAML 解析器：
 * 按行缩进一块块钻进去，找不到就算了。
 */
export function yamlFlagUnder(text: string, path: string[], value: string): boolean {
  return yamlValueUnder(text, path) === value
}

/** 按缩进读嵌套 YAML 的最后一个值；找不到返回 null */
export function yamlValueUnder(text: string, path: string[]): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, ''))
    .filter((l) => l.trim().length > 0)

  let start = 0
  let parentIndent = -1

  for (let p = 0; p < path.length; p++) {
    const want = path[p]
    let next = -1
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]
      const indent = line.length - line.trimStart().length
      // 缩进回到父级或更浅，说明这个块已经结束了
      if (parentIndent >= 0 && indent <= parentIndent) break

      const m = line.trim().match(/^([^:#][^:]*):\s*(.*)$/)
      if (!m || m[1].trim() !== want) continue

      if (p === path.length - 1) return unquote(m[2].trim())
      parentIndent = indent
      next = i
      break
    }
    if (next < 0) return null
    start = next + 1
  }
  return null
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '')
}

/** 代理端才有后端这回事 */
export function mayHaveBackends(kind: ServerKind | ''): boolean {
  return Boolean(kind) && isProxyKind(kind)
}
