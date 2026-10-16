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
    config: ['config/FabricProxy/config.toml', 'config/fabricproxy.toml']
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
  layout: ServerLayout
): Promise<{ name: string; file: string; configPath: string | null } | null> {
  if (!layout.modsDir) return null
  let entries: string[]
  try {
    entries = await fs.readdir(layout.modsDir)
  } catch {
    return null
  }

  const jars = entries.filter((e) => /\.jar$/i.test(e))
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
    return { name: mod.key, file: hit, configPath }
  }
  return null
}

/** 转发模组的密钥（要和代理端 forwarding.secret 一致） */
export async function probeForwarding(
  layout: ServerLayout
): Promise<{ mod: string | null; secret: string | null }> {
  const mod = await findProxyMod(layout)
  if (!mod) return { mod: null, secret: null }
  if (!mod.configPath) return { mod: mod.name, secret: null }

  const text = await readIfExists(mod.configPath)
  if (!text) return { mod: mod.name, secret: null }
  const secret = text.match(/^\s*secret\s*=\s*["']([^"']*)["']/m)?.[1] ?? null
  return { mod: mod.name, secret }
}

export interface ProxyReady {
  ready: boolean
  /** 靠什么接转发，用于界面上的说明 */
  via: string | null
}

/** 这台服务端能不能接代理端的转发 */
export async function probeProxyReady(
  layout: ServerLayout,
  kind: ServerKind | ''
): Promise<ProxyReady> {
  const fw = await probeForwarding(layout)
  if (fw.mod) return { ready: true, via: fw.mod }

  // Paper 系原生支持 Velocity 转发，不需要模组
  if (['paper', 'purpur', 'spigot', 'bukkit'].includes(kind)) {
    for (const rel of ['config/paper-global.yml', 'config/paper-global.yaml']) {
      const text = await readIfExists(join(layout.core, rel))
      if (text && yamlFlagUnder(text, ['proxies', 'velocity', 'enabled'], 'true')) {
        return { ready: true, via: 'Paper 原生 Velocity 转发' }
      }
    }
  }

  // BungeeCord 传统转发：spigot.yml 里开 bungeecord
  const spigot = await readIfExists(join(layout.core, 'spigot.yml'))
  if (spigot && yamlFlagUnder(spigot, ['settings', 'bungeecord'], 'true')) {
    return { ready: true, via: 'BungeeCord 转发' }
  }

  return { ready: false, via: null }
}

/**
 * 按缩进在 YAML 里找嵌套的开关，例如 ['proxies','velocity','enabled'] → true。
 *
 * 只为了读这三份格式固定的服务端配置，所以不去引入 YAML 解析器：
 * 按行缩进一块块钻进去，找不到就算了。
 */
export function yamlFlagUnder(text: string, path: string[], value: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, ''))
    .filter((l) => l.trim().length > 0)

  let start = 0
  let parentIndent = -1

  for (const want of path) {
    let next = -1
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]
      const indent = line.length - line.trimStart().length
      // 缩进回到父级或更浅，说明这个块已经结束了
      if (parentIndent >= 0 && indent <= parentIndent) break

      const m = line.trim().match(/^([^:#][^:]*):\s*(.*)$/)
      if (!m || m[1].trim() !== want) continue

      if (want === path[path.length - 1]) {
        return unquote(m[2].trim()) === value
      }
      parentIndent = indent
      next = i
      break
    }
    if (next < 0) return false
    start = next + 1
  }
  return false
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '')
}

/** 代理端才有后端这回事 */
export function mayHaveBackends(kind: ServerKind | ''): boolean {
  return Boolean(kind) && isProxyKind(kind)
}
