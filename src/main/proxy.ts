import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ServerKind } from '../shared/types'

/** 代理端的核心文件名：velocity-3.5.0-SNAPSHOT-592.jar / waterfall-1.20-547.jar */
const PROXY_JAR_RE = /^(?:velocity|waterfall|bungeecord)[-_]?v?(\d+\.\d+(?:\.\d+)?)/i

export interface ProxyMeta {
  port: number | null
  motd: string | null
  version: string
}

const stripQuotes = (s: string): string => s.trim().replace(/^["']|["']$/g, '')

/**
 * 读代理端的监听端口、MOTD 与版本。
 *
 * 代理端不是 Minecraft 服务端：它没有 server.properties、没有 eula.txt、
 * 没有 world 目录，配置在 velocity.toml 或 config.yml 里，版本号也只能
 * 从核心 jar 的文件名里取。
 */
export async function readProxyMeta(dir: string, kind: ServerKind): Promise<ProxyMeta> {
  const out: ProxyMeta = { port: null, motd: null, version: '' }

  try {
    for (const name of await fs.readdir(dir)) {
      const m = name.match(PROXY_JAR_RE)
      if (m) {
        out.version = m[1]
        break
      }
    }
  } catch {
    /* 目录读不到就算了 */
  }

  if (kind === 'velocity') {
    try {
      const toml = await fs.readFile(join(dir, 'velocity.toml'), 'utf-8')
      const bind = toml.match(/^\s*bind\s*=\s*(.+)$/m)
      if (bind) {
        // bind 形如 "0.0.0.0:25566" 或 "[::]:25566"
        const m = stripQuotes(bind[1]).match(/:(\d+)\s*$/)
        if (m) out.port = Number(m[1])
      }
      const motd = toml.match(/^\s*motd\s*=\s*(.+)$/m)
      if (motd) out.motd = stripQuotes(motd[1])
    } catch {
      /* 没有 velocity.toml */
    }
    return out
  }

  // BungeeCord / Waterfall：listeners 下的 host: 0.0.0.0:25577
  for (const file of ['config.yml', 'waterfall.yml']) {
    try {
      const yml = await fs.readFile(join(dir, file), 'utf-8')
      const host = yml.match(/^\s*host\s*:\s*(.+)$/m)
      if (host) {
        const m = stripQuotes(host[1]).match(/:(\d+)\s*$/)
        if (m) out.port = Number(m[1])
      }
      if (!out.motd) {
        const motd = yml.match(/^\s*motd\s*:\s*(.+)$/m)
        if (motd) out.motd = stripQuotes(motd[1])
      }
      if (out.port) break
    } catch {
      /* 下一个 */
    }
  }
  return out
}

/** 代理端的配置文件在哪 */
export async function findProxyConfigFile(dir: string, kind: ServerKind): Promise<string | null> {
  const candidates =
    kind === 'velocity' ? ['velocity.toml'] : ['config.yml', 'waterfall.yml', 'bungeecord.yml']
  for (const name of candidates) {
    try {
      await fs.access(join(dir, name))
      return join(dir, name)
    } catch {
      /* 下一个 */
    }
  }
  return null
}
