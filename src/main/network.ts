import { promises as fs } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  isProxyKind,
  type NetworkBackendPlan,
  type NetworkPlan,
  type ServerConfig,
  type VelocityServerEntry
} from '../shared/types'
import { detectServer } from './importer'
import { readVelocityFile } from './velocity'
import { parsePropertiesFile } from './properties'
import { resolveLayout } from './layout'

/**
 * 导入一整个跨服网络：代理端 + 它配置里列的后端。
 *
 * 代理端（Velocity / BungeeCord）自己不是「一台服务器」，它是一组服务器的入口：
 * `[servers]` 里每一行都指向另一个服务端目录。按普通服务端那样导入，只能得到
 * 一台没有世界、没有 EULA 的代理端，剩下的后端得用户自己挨个找、挨个导 ——
 * 而它们通常就躺在隔壁目录里。
 *
 * 这里做的事：把代理端配置里的后端读出来，逐个在磁盘上找对应的目录，
 * 让用户勾选要导入哪些。全程只读。
 *
 * 找目录靠两条线：
 * 1. **端口**：目录里的 server.properties 写着 server-port，和配置里的端口对上就是它。
 *    这是唯一可靠的依据 —— 别名和目录名完全可能是两回事，端口才对得上。
 * 2. **名字**：别名与目录名互相包含（`lobby` ↔ `Lobby`），端口对不上时才用，且会标注「猜的」。
 */

/** 候选目录的搜索范围：代理端所在目录的父目录，往下两层 */
const SEARCH_DEPTH = 2
const MAX_CANDIDATES = 60

/** 名字比较用：小写、去掉空格与常见分隔符 */
function normName(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_\-.]/g, '')
}

function splitAddress(address: string): { host: string; port: number } {
  const idx = address.lastIndexOf(':')
  if (idx < 0) return { host: address.trim(), port: 0 }
  return {
    host: address.slice(0, idx).replace(/^\[|\]$/g, '').trim(),
    port: Number(address.slice(idx + 1)) || 0
  }
}

/**
 * BungeeCord / Waterfall 的后端写在 config.yml 里：
 *
 *   servers:
 *     lobby:
 *       address: localhost:25566
 *       restricted: false
 *
 * 缩进表达层级：先记住 `lobby:`，再在同一层级更深处找它的 address。
 */
export function parseBungeeServers(text: string): VelocityServerEntry[] {
  const out: VelocityServerEntry[] = []
  let inServers = false
  let alias = ''
  let aliasIndent = 0

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    if (/^servers\s*:\s*$/.test(trimmed)) {
      inServers = true
      alias = ''
      continue
    }
    if (!inServers) continue
    // 回到顶层说明 servers 段结束了
    if (indent === 0) {
      inServers = false
      continue
    }

    const kv = trimmed.match(/^([^:]+):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].trim().replace(/^["']|["']$/g, '')
    const value = kv[2].trim()

    if (value === '') {
      alias = key
      aliasIndent = indent
      continue
    }
    if (key === 'address' && alias && indent > aliasIndent) {
      const clean = value.replace(/^["']|["']$/g, '')
      const { host, port } = splitAddress(clean)
      out.push({ name: alias, address: clean, host, port })
    }
  }

  return out
}

/** 候选目录：从起点往下最多 SEARCH_DEPTH 层，跳过代理端自己与已托管的目录 */
async function collectCandidates(root: string, skip: string[]): Promise<string[]> {
  const out: string[] = []
  const skipAbs = new Set(skip.map((s) => s.toLowerCase()))

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_CANDIDATES || depth > SEARCH_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (skipAbs.has(full.toLowerCase())) continue
      out.push(full)
      if (out.length >= MAX_CANDIDATES) return
      await walk(full, depth + 1)
    }
  }

  await walk(root, 1)
  return out
}

/** 读目录里 server.properties 的 server-port（核心在 server/ 时也认） */
async function readPort(dir: string): Promise<number | null> {
  for (const rel of ['server.properties', join('server', 'server.properties')]) {
    const props = await parsePropertiesFile(join(dir, rel))
    const port = props.find((p) => p.key === 'server-port')?.value
    if (port) {
      const n = Number(port)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

/** 已经在 CraftDesk 里的服务器各自监听哪个端口 */
async function managedPorts(managed: ServerConfig[]): Promise<Map<number, ServerConfig>> {
  const out = new Map<number, ServerConfig>()
  for (const m of managed) {
    try {
      const layout = await resolveLayout(m)
      const props = await parsePropertiesFile(layout.serverProperties)
      const raw = props.find((p) => p.key === 'server-port')?.value
      const port = Number(raw)
      if (Number.isFinite(port) && port > 0) out.set(port, m)
    } catch {
      /* 单台读不出来不影响别的 */
    }
  }
  return out
}

/**
 * 扫一个代理端目录，给出「能导入什么」。
 * 不写配置、不改磁盘，用户勾完之后再走正常的导入流程。
 */
export async function scanNetworkImport(
  dir: string,
  managed: ServerConfig[]
): Promise<NetworkPlan> {
  const proxy = await detectServer(dir)
  if (!isProxyKind(proxy.kind)) {
    throw new Error(
      '这个目录不像代理端。跨服网络的入口是 Velocity / BungeeCord / Waterfall，' +
        '目录里应该有 velocity.toml 或 config.yml，以及代理端的 jar。'
    )
  }

  // 代理端配置里的后端：Velocity 在 velocity.toml，Bungee 系在 config.yml
  let entries: VelocityServerEntry[] = []
  if (proxy.kind === 'velocity') {
    entries = (await readVelocityFile(dir)).servers
  } else {
    for (const file of ['config.yml', 'waterfall.yml']) {
      try {
        entries = parseBungeeServers(await fs.readFile(join(dir, file), 'utf-8'))
        if (entries.length) break
      } catch {
        /* 换下一个 */
      }
    }
  }

  const searchRoot = dirname(dir)
  const known = await managedPorts(managed)
  const candidates = await collectCandidates(searchRoot, [
    dir,
    ...managed.map((m) => m.dir)
  ])

  // 候选目录的端口先读一遍：读一个 properties 比完整识别一个目录便宜得多
  const ports = new Map<string, number | null>()
  for (const c of candidates) ports.set(c, await readPort(c))

  const backends: NetworkBackendPlan[] = []
  const used = new Set<string>()

  const show = (p: string): string => {
    const rel = relative(searchRoot, p)
    return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : p
  }

  for (const entry of entries) {
    const { host, port } = splitAddress(entry.address)
    const plan: NetworkBackendPlan = {
      alias: entry.name,
      address: entry.address,
      host,
      port,
      managedId: null,
      managedName: null,
      dir: null,
      displayDir: '',
      detected: null,
      status: 'address-only',
      foundBy: '',
      note: ''
    }

    // 1) 已经在 CraftDesk 里：按端口对（同一个端口就是同一台）
    const already = port ? known.get(port) : undefined
    if (already) {
      plan.managedId = already.id
      plan.managedName = already.name
      plan.dir = already.dir
      plan.displayDir = show(already.dir)
      plan.status = 'managed'
      plan.foundBy = 'port'
      plan.note = '已经在列表里'
      backends.push(plan)
      continue
    }

    // 2) 磁盘上按端口找
    let hit: string | null = null
    if (port) hit = candidates.find((c) => ports.get(c) === port) ?? null
    let foundBy: 'port' | 'name' = 'port'

    // 3) 端口对不上再按名字猜
    if (!hit) {
      const wanted = normName(entry.name)
      if (wanted.length >= 3) {
        hit =
          candidates.find(
            (c) => !used.has(c.toLowerCase()) && normName(basename(c)).includes(wanted)
          ) ?? null
        if (hit) foundBy = 'name'
      }
    }

    if (!hit) {
      plan.note = port
        ? `附近没有监听 ${port} 的目录（可能在别的机器上，或者还没建）`
        : '配置里的地址没写端口'
      backends.push(plan)
      continue
    }

    const detected = await detectServer(hit, { skipSize: true })
    plan.dir = hit
    plan.displayDir = show(hit)
    used.add(hit.toLowerCase())

    if (detected.kind === 'unknown') {
      plan.status = 'not-a-server'
      plan.note = '目录里的内容不像服务端'
      backends.push(plan)
      continue
    }

    plan.detected = detected
    plan.status = 'found'
    plan.foundBy = foundBy
    plan.note =
      foundBy === 'port'
        ? `端口 ${port} 与配置一致`
        : '按目录名猜的，导入前建议核对一下'
    backends.push(plan)
  }

  return { proxy, proxyPort: proxy.port, backends, scanned: candidates.length, searchRoot }
}
