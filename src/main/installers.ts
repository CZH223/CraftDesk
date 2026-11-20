import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { httpFetch } from './http'

/**
 * Forge 和 NeoForge 的安装。
 *
 * 这两家都不提供「下载一个 jar 就能跑」的服务端：官方给的是一个**安装器**，
 * 它要联网拉一堆运行库，再生成启动用的参数文件。所以这里的流程是
 * 「下安装器 → 让它自己装 → 找它生成的启动入口」。
 *
 * 启动入口有两种形态，得都认：
 * - 1.17 以后：不靠 -jar 启动，而是 `java @libraries/.../win_args.txt`
 * - 更早的版本：安装器直接产出一个 `forge-<mc>-<版本>.jar`，可以 -jar
 */

const UA = 'CraftDesk/1.0 (Minecraft server manager)'

async function getJson<T>(url: string, timeoutMs = 30000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await httpFetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export interface InstallerOption {
  /** Minecraft 版本 */
  id: string
  /** 要装的构建号，例如 Forge 的 47.2.0、NeoForge 的 21.1.209 */
  latestBuild?: string
  /** recommended / latest / beta，给界面做提示 */
  note?: string
}

/** MC 版本比较：1.7.10 / 1.20.1 / 26.3 混在一起也能排对 */
function compareMc(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x) || 0)
  const pb = b.split('.').map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** 构建号比较：21.1.9 和 21.1.10 不能按字符串比 */
function compareBuild(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => Number(x) || 0)
  const pb = b.split(/[.\-+]/).map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

// ---------------------------------------------------------------- Forge

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'

interface ForgePromos {
  promos?: Record<string, string>
}

/**
 * Forge 的版本表。
 * 官方在 files 站上直接放了一份 promotions_slim.json：
 * 每个 MC 版本给出 recommended 和 latest 两条（老版本可能只有 latest）。
 */
export async function listForgeVersions(): Promise<InstallerOption[]> {
  const data = await getJson<ForgePromos>(
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
  )
  const byMc = new Map<string, { rec?: string; latest?: string }>()
  for (const [key, ver] of Object.entries(data.promos ?? {})) {
    const m = key.match(/^(.+)-(recommended|latest)$/)
    if (!m) continue
    const slot = byMc.get(m[1]) ?? {}
    if (m[2] === 'recommended') slot.rec = ver
    else slot.latest = ver
    byMc.set(m[1], slot)
  }

  return [...byMc.entries()]
    .filter(([, slot]) => slot.rec || slot.latest)
    .map(([mc, slot]) => ({
      id: mc,
      latestBuild: slot.rec ?? slot.latest,
      note: slot.rec ? 'recommended' : 'latest'
    }))
    .sort((a, b) => compareMc(b.id, a.id))
}

export interface InstallerFile {
  url: string
  name: string
  /** 官方没给 size/sha256 时至少能对一下 sha1 */
  checksumFile?: string
}

export function forgeInstaller(mcVersion: string, build: string): InstallerFile {
  const full = `${mcVersion}-${build}`
  const name = `forge-${full}-installer.jar`
  return {
    url: `${FORGE_MAVEN}/${full}/${name}`,
    name,
    checksumFile: `${FORGE_MAVEN}/${full}/${name}.sha1`
  }
}

// ---------------------------------------------------------------- NeoForge

const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
/** 1.20.1 的 NeoForge 还挂在 net.neoforged:forge 这个旧坐标下面 */
const NEOFORGE_LEGACY_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/forge'

/**
 * NeoForge 的版本表。
 *
 * 版本号就是 MC 版本的前缀 + 构建号，但有两套历史：
 * - 1.20.2 起：20.4.237 对应 1.20.4，21.1.209 对应 1.21.1；
 * - 1.20.1：47.1.106，放在旧的 net.neoforged:forge 坐标里；
 * - 26.x 换了新 MC 版本号：26.1.2.126 对应 26.1.2，前缀要保留三段。
 *
 * 它没有 Forge 那种 promotions 文件，只能把 maven 上的全量版本拉下来自己分组。
 */
export async function listNeoForgeVersions(): Promise<InstallerOption[]> {
  const [modern, legacy] = await Promise.all([
    getJson<{ versions?: string[] }>(
      'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'
    ),
    getJson<{ versions?: string[] }>(
      'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge'
    ).catch(() => ({ versions: [] }))
  ])
  return parseNeoForgeVersions(modern.versions ?? [], legacy.versions ?? [])
}

/**
 * 把 maven 的全量版本号分组成「一个 MC 版本一条」。
 *
 * 单独拆出来是为了能离线测试：26.1 / 26.1.1 / 26.1.2 必须各自成条，
 * 1.20.1 的 47.1.x 也必须能从旧坐标里找回来。
 */
export function parseNeoForgeVersions(
  modern: string[],
  legacy: string[] = []
): InstallerOption[] {
  const out: InstallerOption[] = []

  const byPrefix = new Map<string, string[]>()
  for (const v of modern) {
    // 26.1.2.126 要保留三段前缀；21.1.209 只会匹配到 21.1
    const m = v.match(/^(\d+\.\d+(?:\.\d+)?)\./)
    if (!m) continue
    byPrefix.set(m[1], [...(byPrefix.get(m[1]) ?? []), v])
  }

  for (const [prefix, list] of byPrefix) {
    // 有正式版就用正式版，只有 beta 的时候才用 beta（新版刚出时经常如此）
    const stable = list.filter((v) => !v.includes('-'))
    const pool = stable.length ? stable : list
    const pick = pool.slice().sort(compareBuild).pop() as string
    out.push({
      id: mcFromNeoPrefix(prefix),
      latestBuild: pick,
      note: pick.includes('-') ? 'beta' : 'stable'
    })
  }

  // 旧坐标里的条目形如 1.20.1-47.1.106，MC 版本在第一个 "-" 前面
  const legacyByMc = new Map<string, string[]>()
  for (const v of legacy) {
    const m = v.match(/^(\d+\.\d+(?:\.\d+)?)-(.+)$/)
    if (!m) continue
    legacyByMc.set(m[1], [...(legacyByMc.get(m[1]) ?? []), v])
  }
  for (const [mc, list] of legacyByMc) {
    // 旧坐标里 "-" 是 MC 和构建号的分隔符，稳定性只看后缀里的 beta/alpha
    const stable = list.filter((v) => !/-(?:beta|alpha)/i.test(v.slice(mc.length + 1)))
    const pool = stable.length ? stable : list
    const pick = pool
      .slice()
      .sort((a, b) => compareBuild(a.slice(mc.length + 1), b.slice(mc.length + 1)))
      .pop() as string
    out.push({
      id: mc,
      latestBuild: pick,
      note: /-(?:beta|alpha)/i.test(pick.slice(mc.length + 1)) ? 'beta' : 'legacy'
    })
  }

  return out.sort((a, b) => compareMc(b.id, a.id))
}

/**
 * 21.1 → 1.21.1；21.0 → 1.21；47.1 → 1.20.1（旧坐标）。
 * 26.x 的 artifact 会在 MC 版本后面补一个 ".0"：26.3.0 → MC 26.3，
 * 而 26.1.2 → MC 26.1.2；不能一律照抄，也不能一律砍掉最后一段。
 */
export function mcFromNeoPrefix(prefix: string): string {
  const parts = prefix.split('.').map(Number)
  const [a, b, c] = parts
  // 47.x 是 NeoForge 最早的 1.20.1 版本号，数字上比 26 大，必须先判断
  if (a === 47 && b === 1) return '1.20.1'
  if (a >= 26) {
    if (parts.length >= 3 && c === 0) return `${a}.${b}`
    return prefix
  }
  if (!b || b === 0) return `1.${a}`
  return `1.${a}.${b}`
}

export function neoforgeInstaller(build: string): InstallerFile {
  // 1.20.1 的构建号形如 1.20.1-47.1.106；现代版本的 "-beta" 不能当成旧坐标
  if (/^1\.20\.1-/.test(build)) {
    const name = `forge-${build}-installer.jar`
    return {
      url: `${NEOFORGE_LEGACY_MAVEN}/${build}/${name}`,
      name,
      checksumFile: `${NEOFORGE_LEGACY_MAVEN}/${build}/${name}.sha1`
    }
  }
  const name = `neoforge-${build}-installer.jar`
  return {
    url: `${NEOFORGE_MAVEN}/${build}/${name}`,
    name,
    checksumFile: `${NEOFORGE_MAVEN}/${build}/${name}.sha1`
  }
}

/** maven 会同时放一个 .sha1，下载完顺手核对（几十 MB 的安装器，值得） */
export async function fetchSha1(checksumUrl: string): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    const res = await httpFetch(checksumUrl, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const text = (await res.text()).trim()
    return /^[0-9a-f]{40}$/i.test(text) ? text : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 装完之后的启动入口

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 找安装器生成的启动参数文件。
 *
 * 位置是 `libraries/net/minecraftforge/forge/<mc>-<forge>/win_args.txt`
 * （NeoForge 是把 forge 换成 neoforged/neoforge），但版本号和目录层级
 * 官方改过几次，所以直接扫，别硬拼路径。
 */
export async function findArgsFile(coreDir: string): Promise<string | null> {
  const win = process.platform === 'win32'
  const names = win ? ['win_args.txt', 'unix_args.txt'] : ['unix_args.txt', 'win_args.txt']

  for (const root of ['libraries/net/minecraftforge/forge', 'libraries/net/neoforged/neoforge']) {
    const base = join(coreDir, ...root.split('/'))
    let versions: string[]
    try {
      versions = await fs.readdir(base)
    } catch {
      continue
    }
    // 同一个目录下可能留着好几个版本的运行库，用最新的那个
    for (const ver of versions.sort(compareBuild).reverse()) {
      for (const name of names) {
        const p = join(base, ver, name)
        if (await exists(p)) return p
      }
    }
  }
  return null
}

/** 1.17 以前没有参数文件，安装器直接给一个可以 -jar 的 jar */
export async function findUniversalJar(coreDir: string): Promise<string | null> {
  let entries: string[]
  try {
    entries = await fs.readdir(coreDir)
  } catch {
    return null
  }
  const hit = entries
    .filter((e) => /^forge-.*\.jar$/i.test(e) && !/installer/i.test(e))
    .sort()
  return hit.length ? join(coreDir, hit[hit.length - 1]) : null
}
