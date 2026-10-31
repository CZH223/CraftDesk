import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import type { NetworkJoinResult, ServerConfig, ServerKind, VelocityFile } from '../shared/types'
import { isProxyKind } from '../shared/types'
import { resolveLayout, type ServerLayout } from './layout'
import { getProperty, parsePropertiesFile, writeProperties } from './properties'
import { readProxyFile, writeProxyFields, writeProxyServers } from './proxyConfig'
import { modrinthVersions } from './registry'
import { downloadFile } from './downloader'

/**
 * 把一台服务端接入某个跨服网络（代理端）。
 *
 * 「加进代理端配置」只是第一步。真正能让玩家进去的，是后端也要知道
 * 自己在一个代理后面，并且用同一种转发方式和代理端说话：
 *
 *   BungeeCord / Waterfall   legacy 转发，没有密钥；Paper 系改 spigot.yml，
 *                            Fabric 装 Fabric-Bungeecord-Proxy，
 *                            Forge / NeoForge 装 ProxyCompatibleForge（LEGACY）
 *   Velocity                 modern 转发，需要 forwarding.secret；
 *                            Paper 改 paper-global.yml，Fabric 装 FabricProxy-Lite，
 *                            Forge / NeoForge 用 PCF（MODERN）
 *
 * 所有修改都尽量按行打补丁，保留用户自己的注释和配置项。能自动下载的
 * 桥接模组直接下进 mods/；下不到就退化成一条明确的警告，而不是让接入失败。
 */

export type JoinProgress = (message: string, received: number, total: number) => void

/** 加入网络时由主进程传入的运行环境 */
export interface JoinOptions {
  /** 跑安装器 / 更新 Fabric Loader 用的 Java */
  javaPath?: string
  /** 服务端是否正在运行（运行时不能改 Loader） */
  running?: boolean
}

const UA = 'CraftDesk/1.2 (Minecraft server manager)'
const execFileAsync = promisify(execFile)

function slugAlias(name: string, existing: string[], port: number): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || `server-${port}`
  if (!existing.includes(base)) return base
  let i = 2
  while (existing.includes(`${base}-${i}`)) i++
  return `${base}-${i}`
}

async function portOf(cfg: ServerConfig, layout: ServerLayout): Promise<number> {
  const props = await parsePropertiesFile(layout.serverProperties)
  const raw = getProperty(props, 'server-port')
  const port = Number(raw) || layout.configuredPort || 0
  if (!port || port <= 0 || port > 65535) {
    throw new Error('读不到这台服务端的端口。请先启动一次，或确认 server.properties 里的 server-port')
  }
  return port
}

/** 端口能不能绑上（只用来挑一个真正空闲的新端口） */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port)
  })
}

/** 所有托管服务器已经占用的端口：代理端的监听端口 + 后端的 server-port */
async function configuredPorts(
  servers: ServerConfig[],
  excludeId: string
): Promise<Set<number>> {
  const out = new Set<number>()
  for (const s of servers) {
    if (s.id === excludeId) continue
    try {
      const layout = await resolveLayout(s)
      let port = layout.configuredPort
      if (!port) {
        const props = await parsePropertiesFile(layout.serverProperties)
        port = Number(getProperty(props, 'server-port')) || null
      }
      if (port && port > 0 && port <= 65535) out.add(port)
    } catch {
      /* 单台读不出来就跳过 */
    }
  }
  return out
}

async function pickFreePort(start: number, avoid: Set<number>): Promise<number> {
  const candidates: number[] = []
  for (let p = Math.max(start, 1024); p <= 65535; p++) candidates.push(p)
  for (let p = 1024; p < Math.max(start, 1024); p++) candidates.push(p)

  for (const port of candidates) {
    if (avoid.has(port)) continue
    if (await portFree(port)) {
      avoid.add(port)
      return port
    }
  }
  throw new Error('找不到空闲端口，请先关掉一些正在运行的服务器')
}

// ---------------------------------------------------------------- 配置文件补丁

/** 把值写成 YAML 标量；布尔裸写 */
function yamlScalar(value: string): string {
  if (value === 'true' || value === 'false') return value
  if (/^-?\d+$/.test(value)) return value
  if (!value) return "''"
  return `'${value.replace(/'/g, "''")}'`
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim()
  return !t || t.startsWith('#')
}

function yamlKeyOf(line: string): { key: string; comment: string } | null {
  const body = line.trim()
  if (!body || body.startsWith('#') || body.startsWith('- ')) return null
  const m = body.match(/^([^:#][^:]*):\s*(.*)$/)
  if (!m) return null
  const rest = m[2]
  const ci = rest.indexOf(' #')
  return {
    key: m[1].trim().replace(/^['"]|['"]$/g, ''),
    comment: ci >= 0 ? rest.slice(ci).trim() : ''
  }
}

function childIndent(lines: string[], start: number, end: number, parent: number): number | null {
  let min = Infinity
  for (let i = start; i < end; i++) {
    if (isBlankOrComment(lines[i])) continue
    const ind = indentOf(lines[i])
    if (ind > parent) min = Math.min(min, ind)
  }
  return min === Infinity ? null : min
}

function blockEnd(lines: string[], idx: number, indent: number, hardEnd: number): number {
  for (let i = idx + 1; i < hardEnd; i++) {
    if (isBlankOrComment(lines[i])) continue
    if (indentOf(lines[i]) <= indent) return i
  }
  return hardEnd
}

/**
 * 在一个 YAML 文件里按嵌套路径写一个标量。
 * 路径里缺的段会补出来；已有的段只换值，注释留在行尾。
 */
export function setYamlPath(raw: string, keys: string[], value: string): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  let start = 0
  let end = lines.length
  let parent = -1
  let missing = -1

  for (let k = 0; k < keys.length; k++) {
    const ci = childIndent(lines, start, end, parent)
    let found = -1
    if (ci != null) {
      for (let i = start; i < end; i++) {
        if (isBlankOrComment(lines[i]) || indentOf(lines[i]) !== ci) continue
        if (yamlKeyOf(lines[i])?.key === keys[k]) {
          found = i
          break
        }
      }
    }

    if (found < 0) {
      missing = k
      break
    }

    if (k === keys.length - 1) {
      const indent = ' '.repeat(ci ?? 0)
      const comment = yamlKeyOf(lines[found])?.comment
      lines[found] = `${indent}${keys[k]}: ${yamlScalar(value)}${comment ? ` ${comment}` : ''}`
      return lines.join(eol)
    }

    start = found + 1
    end = blockEnd(lines, found, ci ?? indentOf(lines[found]), end)
    parent = ci ?? indentOf(lines[found])
  }

  if (missing < 0) return lines.join(eol)
  const baseIndent = childIndent(lines, start, end, parent) ?? (parent < 0 ? 0 : parent + 2)
  let at = end
  while (at > start && !lines[at - 1].trim()) at--

  const block: string[] = []
  if (at > 0 && lines[at - 1].trim()) block.push('')
  let indent = baseIndent
  for (let k = missing; k < keys.length; k++) {
    const tail = k === keys.length - 1 ? ` ${yamlScalar(value)}` : ''
    block.push(`${' '.repeat(indent)}${keys[k]}:${tail}`)
    indent += 2
  }
  lines.splice(at, 0, ...block)
  return lines.join(eol)
}

async function patchYamlFile(path: string, updates: { keys: string[]; value: string }[]): Promise<void> {
  let raw = ''
  try {
    raw = await fs.readFile(path, 'utf-8')
  } catch {
    raw = ''
  }
  let next = raw
  for (const u of updates) next = setYamlPath(next, u.keys, u.value)
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, next.endsWith('\n') ? next : `${next}\n`, 'utf-8')
}

/** 补一条顶层 TOML 键；已有则换值，没有就插在第一个 [section] 之前 */
export function setTomlTopLevel(raw: string, key: string, value: string): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  const firstSection = lines.findIndex((l) => /^\s*\[/.test(l))
  const limit = firstSection < 0 ? lines.length : firstSection

  for (let i = 0; i < limit; i++) {
    const m = lines[i].match(new RegExp(`^(\\s*)${key}\\s*=`))
    if (m && !lines[i].trimStart().startsWith('#')) {
      lines[i] = `${m[1]}${key} = ${value}`
      return lines.join(eol)
    }
  }

  const at = limit < 0 ? lines.length : limit
  lines.splice(at, 0, `${key} = ${value}`, '')
  return lines.join(eol)
}

/** 在指定的 [section] 里写键；段不存在就追加 */
export function setTomlSection(raw: string, section: string, values: Record<string, string>): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  let start = lines.findIndex((l) => new RegExp(`^\\s*\\[${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`).test(l))
  if (start < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('')
    lines.push(`[${section}]`)
    for (const [k, v] of Object.entries(values)) lines.push(`${k} = ${v}`)
    return lines.join(eol)
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i
      break
    }
  }
  for (const [key, value] of Object.entries(values)) {
    let hit = -1
    for (let i = start + 1; i < end; i++) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i]) && !lines[i].trimStart().startsWith('#')) {
        hit = i
        break
      }
    }
    if (hit >= 0) {
      const indent = lines[hit].match(/^\s*/)?.[0] ?? ''
      lines[hit] = `${indent}${key} = ${value}`
    } else {
      lines.splice(end, 0, `${key} = ${value}`)
      end++
    }
  }
  return lines.join(eol)
}

async function patchTomlTop(path: string, values: Record<string, string>, template: string): Promise<void> {
  let raw = ''
  try {
    raw = await fs.readFile(path, 'utf-8')
  } catch {
    raw = template
  }
  let next = raw
  for (const [k, v] of Object.entries(values)) next = setTomlTopLevel(next, k, v)
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, next, 'utf-8')
}

async function patchTomlSection(
  path: string,
  section: string,
  values: Record<string, string>,
  template: string
): Promise<void> {
  let raw = ''
  try {
    raw = await fs.readFile(path, 'utf-8')
  } catch {
    raw = template
  }
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, setTomlSection(raw, section, values), 'utf-8')
}

// ---------------------------------------------------------------- 下载桥接模组

async function modsDirOf(layout: ServerLayout): Promise<string> {
  const dir = layout.modsDir ?? join(layout.core, 'mods')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function listJars(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => /\.jar$/i.test(n))
  } catch {
    return []
  }
}

/**
 * 把不适用于当前代理端格式的转发模组改成 .jar.disabled。
 *
 * FabricProxy-Lite 与 Fabric-Bungeecord-Proxy 都会改登录握手：两个同时启用时，
 * Lite 会先用自己的逻辑处理连接，BungeeCord 玩家会被它的 disconnectMessage
 * 直接踢掉。接入时只保留对当前代理端有效的那一个。
 */
async function disableJar(
  dir: string,
  match: RegExp,
  reason: string,
  changes: string[],
  warnings: string[]
): Promise<void> {
  for (const name of await listJars(dir)) {
    if (!match.test(name)) continue
    const from = join(dir, name)
    const to = `${from}.disabled`
    try {
      await fs.rename(from, to)
      changes.push(`已禁用 ${name}（${reason}）`)
    } catch (err) {
      warnings.push(`无法禁用 ${name}（${reason}）：${(err as Error).message}。请手动把它改名成 .disabled。`)
    }
  }
}

async function installFromModrinth(
  layout: ServerLayout,
  slug: string,
  loader: string,
  mcVersion: string,
  match: RegExp,
  emit?: JoinProgress
): Promise<string | null> {
  const dir = await modsDirOf(layout)
  const existing = (await listJars(dir)).find((n) => match.test(n))
  if (existing) return existing

  let versions = mcVersion
    ? await modrinthVersions(slug, { gameVersion: mcVersion, loader })
    : []
  if (!versions.length) versions = await modrinthVersions(slug, { loader })
  const version = versions.find((v) => v.fileUrl && v.fileName)
  if (!version) return null

  emit?.(`正在下载 ${version.fileName}`, 0, version.fileSize || 0)
  await downloadFile(
    version.fileUrl,
    join(dir, version.fileName),
    (received, total) => emit?.(`正在下载 ${version.fileName}`, received, total),
    { size: version.fileSize || undefined }
  )
  return version.fileName
}

interface GithubAsset {
  name: string
  size: number
  browser_download_url: string
}

async function githubJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub 接口返回 HTTP ${res.status}`)
  return (await res.json()) as T
}

/** Fabric 的 BungeeCord 桥接没有发在 Modrinth，从它自己的 GitHub Releases 取 */
async function installFabricBungee(
  layout: ServerLayout,
  emit?: JoinProgress
): Promise<string | null> {
  const dir = await modsDirOf(layout)
  // 注意排除 Lite：它只支持 Velocity，不能因为装了它就跳过 Bungee 桥接
  const existing = (await listJars(dir)).find(
    (n) => /^fabric[-_]?proxy/i.test(n) && !/lite/i.test(n)
  )
  if (existing) return existing

  const release = await githubJson<{ tag_name?: string; assets?: GithubAsset[] }>(
    'https://api.github.com/repos/disymayufei/Fabric-Bungeecord-Proxy/releases/latest'
  )
  const asset = release.assets?.find((a) => /\.jar$/i.test(a.name) && !/sources|javadoc/i.test(a.name))
  if (!asset) return null
  emit?.(`正在下载 ${asset.name}`, 0, asset.size || 0)
  await downloadFile(
    asset.browser_download_url,
    join(dir, asset.name),
    (received, total) => emit?.(`正在下载 ${asset.name}`, received, total),
    { size: asset.size || undefined }
  )
  return asset.name
}

/**
 * ProxyForward 目前只发布了三个 Minecraft 版本的构建。
 * 它同时支持 Bungee 与 Velocity，是 1.21.11 上唯一还能用的 Fabric Bungee 桥接
 * （Fabric-Bungeecord-Proxy 在 1.21.11 会因 UserCacheMixin 找不到字段直接崩溃）。
 */
function proxyForwardSupported(mcVersion: string): boolean {
  return /^(1\.21\.11|26\.1\.2|26\.2(?:\.\d+)?)$/.test(mcVersion)
}

/** 从 zip 里读一个文件（Fabric 启动 jar 的 MANIFEST.MF），不需要额外依赖 */
function readZipEntry(buf: Buffer, wanted: string): Buffer | null {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen)

    if (name === wanted) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
        return null
      }
      const localNameLen = buf.readUInt16LE(localOffset + 26)
      const localExtraLen = buf.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLen + localExtraLen
      const data = buf.subarray(start, start + compressedSize)
      if (method === 0) return data
      if (method === 8) {
        try {
          return inflateRawSync(data)
        } catch {
          return null
        }
      }
      return null
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/** 从 Fabric 启动 jar 的 manifest 里读 Class-Path 指定的 Loader 版本 */
export function fabricLoaderFromLauncher(jar: Buffer): string | null {
  const manifest = readZipEntry(jar, 'META-INF/MANIFEST.MF')
  if (!manifest) return null
  const lines: string[] = []
  for (const line of manifest.toString('utf-8').split(/\r?\n/)) {
    if (line.startsWith(' ') && lines.length) lines[lines.length - 1] += line.slice(1)
    else lines.push(line)
  }
  const classPath = lines.find((l) => /^Class-Path:/i.test(l))
  const hit = classPath?.match(/libraries\/net\/fabricmc\/fabric-loader\/([^/\s]+)\//)
  return hit?.[1] ?? null
}

/**
 * 服务端实际使用的 Fabric Loader 版本。
 *
 * 同一个服务端目录里可能留着多个 Loader（升级后旧目录不会删）。只看目录名
 * 取最大值会把「装过 0.20.1 但启动器仍指向 0.18.6」误判成已升级，所以优先读
 * Fabric 启动 jar 的 manifest —— Class-Path 里写死了本次启动用的 Loader。
 */
async function fabricLoaderVersion(layout: ServerLayout): Promise<string | null> {
  try {
    const launcher = await fs.readFile(join(layout.core, 'fabric-server-launch.jar'))
    const fromLauncher = fabricLoaderFromLauncher(launcher)
    if (fromLauncher) return fromLauncher
  } catch {
    /* 没有启动 jar，退回目录扫描 */
  }

  try {
    const base = join(layout.core, 'libraries', 'net', 'fabricmc', 'fabric-loader')
    const versions: Array<{ version: string; mtime: number }> = []
    for (const version of await fs.readdir(base)) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) continue
      try {
        const st = await fs.stat(join(base, version))
        versions.push({ version, mtime: st.mtimeMs })
      } catch {
        /* 单个目录读不到就跳过 */
      }
    }
    versions.sort((a, b) => {
      if (a.mtime !== b.mtime) return a.mtime - b.mtime
      const pa = a.version.split('.').map(Number)
      const pb = b.version.split('.').map(Number)
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
      return 0
    })
    return versions.at(-1)?.version ?? null
  } catch {
    return null
  }
}

/** ProxyForward 的 class tweaker 是 v2，Loader 0.19 之前读不了 */
export function loaderSupportsProxyForward(version: string): boolean {
  const [major, minor] = version.split('.').map((n) => Number(n) || 0)
  return major > 0 || minor >= 19
}

const FABRIC_INSTALLER_VERSION = '1.1.2'
const FABRIC_INSTALLER_URL =
  `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${FABRIC_INSTALLER_VERSION}/` +
  `fabric-installer-${FABRIC_INSTALLER_VERSION}.jar`
const PROXYFORWARD_MIN_LOADER = '0.20.1'

/**
 * 自动把 Fabric Loader 升到 ProxyForward 能读的版本。
 *
 * ProxyForward 用了 classTweaker v2，Loader 0.19 之前会在启动时直接报
 * "Unsupported class tweaker format: v2"。这一步用官方安装器原地升级，
 * 只在后端停止时执行；失败不吞掉，转成一条可操作的警告。
 */
async function ensureFabricLoader(
  layout: ServerLayout,
  mcVersion: string,
  opts: JoinOptions,
  changes: string[],
  warnings: string[],
  emit?: JoinProgress
): Promise<void> {
  const before = await fabricLoaderVersion(layout)
  if (!before || loaderSupportsProxyForward(before)) return

  if (opts.running) {
    warnings.push(
      `Fabric Loader ${before} 太旧，ProxyForward 需要 0.19 以上。` +
        '服务端正在运行，停止后重新点一次「加入网络」即可自动更新。'
    )
    return
  }

  // 不是 CraftDesk 启动的服务器不会出现在 manager.isRunning 里；端口还在监听就说明它在跑
  try {
    const props = await parsePropertiesFile(layout.serverProperties)
    const port = Number(getProperty(props, 'server-port')) || layout.configuredPort || 0
    if (port > 0 && !(await portFree(port))) {
      warnings.push(
        `服务端端口 ${port} 仍在监听，可能正在运行。为避免改坏运行中的实例，` +
          `没有自动更新 Fabric Loader ${before}；停止后重新点一次「加入网络」即可。`
      )
      return
    }
  } catch {
    /* 读不到端口就继续，后续安装器失败会转成警告 */
  }

  try {
    await fs.access(join(layout.core, 'server.jar'))
  } catch {
    warnings.push(
      `Fabric Loader ${before} 太旧，但 core/server.jar 不存在，无法自动运行安装器。` +
        '请手动把 Fabric Loader 更新到 0.19 以上。'
    )
    return
  }

  try {
    const installer = join(
      tmpdir(),
      `craftdesk-fabric-installer-${FABRIC_INSTALLER_VERSION}.jar`
    )
    try {
      await fs.access(installer)
    } catch {
      emit?.('正在下载 Fabric 安装器…', 0, 0)
      await downloadFile(FABRIC_INSTALLER_URL, installer)
    }
    emit?.(`正在更新 Fabric Loader ${before} → ${PROXYFORWARD_MIN_LOADER}…`, 0, 0)
    await execFileAsync(
      opts.javaPath || 'java',
      [
        '-jar',
        installer,
        'server',
        '-dir',
        layout.core,
        '-mcversion',
        mcVersion,
        '-loader',
        PROXYFORWARD_MIN_LOADER
      ],
      { timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
    )
    const after = await fabricLoaderVersion(layout)
    if (after && loaderSupportsProxyForward(after)) {
      changes.push(`Fabric Loader 已自动更新：${before} → ${after}`)
    } else {
      warnings.push(
        `Fabric Loader 自动更新后仍是 ${after ?? '未知'}，请手动更新到 0.19 以上；` +
          '否则 ProxyForward 启动会报 "Unsupported class tweaker format: v2"。'
      )
    }
  } catch (err) {
    warnings.push(
      `Fabric Loader 自动更新失败：${(err as Error).message}。` +
        `当前是 ${before}，请手动更新到 0.19 以上。`
    )
  }
}

/**
 * 实际安装的 Minecraft 版本。
 *
 * 不能只信导入时记下的 `cfg.mcVersion`：Fabric 服务端经常被按 mods 目录里
 * 某个模组的文件名识别成旧版本。intermediary 目录名是 Fabric 自己写的，
 * 和启动日志里的 "Loading Minecraft x with Fabric Loader" 一样可靠。
 */
export async function detectInstalledMcVersion(layout: ServerLayout): Promise<string | null> {
  try {
    const base = join(layout.core, 'libraries', 'net', 'fabricmc', 'intermediary')
    const versions = (await fs.readdir(base)).filter((v) => /^\d+\.\d+(?:\.\d+)?$/.test(v))
    if (versions.length) {
      versions.sort((a, b) => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pa[i] ?? 0) - (pb[i] ?? 0)
          if (d) return d
        }
        return 0
      })
      return versions[versions.length - 1]
    }
  } catch {
    /* 不是 Fabric */
  }

  try {
    const file = join(layout.core, 'logs', 'latest.log')
    const fh = await fs.open(file, 'r')
    try {
      const st = await fh.stat()
      const len = Math.min(st.size, 262144)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, st.size - len)
      const hit = buf
        .toString('utf-8')
        .match(/Loading Minecraft\s+([0-9][^\s]*)\s+with Fabric Loader/i)
      if (hit) return hit[1]
    } finally {
      await fh.close()
    }
  } catch {
    /* 没有日志 */
  }
  return null
}

async function installProxyForward(
  layout: ServerLayout,
  mcVersion: string,
  mode: 'bungee' | 'velocity',
  secret: string | null,
  emit?: JoinProgress
): Promise<string | null> {
  const dir = await modsDirOf(layout)
  const existing = (await listJars(dir)).find((n) => /^proxyforward/i.test(n))
  let file = existing ?? null

  if (!file) {
    const release = await githubJson<{ assets?: GithubAsset[] }>(
      'https://api.github.com/repos/jirmjahu/proxyforward/releases/latest'
    )
    const targets = mcVersion.startsWith('26.2') ? ['26.2', mcVersion] : [mcVersion]
    const asset = release.assets?.find(
      (a) =>
        /^proxyforward-fabric-/i.test(a.name) &&
        /\.jar$/i.test(a.name) &&
        targets.some((v) => a.name.includes(`+${v}`))
    )
    if (!asset) return null
    emit?.(`正在下载 ${asset.name}`, 0, asset.size || 0)
    await downloadFile(
      asset.browser_download_url,
      join(dir, asset.name),
      (received, total) => emit?.(`正在下载 ${asset.name}`, received, total),
      { size: asset.size || undefined }
    )
    file = asset.name
  }

  const configDir = layout.configDir ?? join(layout.core, 'config')
  await patchTomlTop(
    join(configDir, 'proxyforward.toml'),
    {
      forwarding_mode: `"${mode}"`,
      velocity_secret: `"${secret ?? ''}"`
    },
    `# "bungee" or "velocity" (use "bungee" for velocity legacy forwarding)\n` +
      `forwarding_mode = "${mode}"\n\n# Only needed when forwarding_mode = "velocity"\n` +
      `velocity_secret = "${secret ?? ''}"\n`
  )
  return file
}

// ---------------------------------------------------------------- 后端配置

type ProxyFormat = 'bungee' | 'velocity'

const BUKKIT_KINDS: ServerKind[] = ['paper', 'purpur', 'spigot', 'bukkit']

async function setOnlineModeOff(layout: ServerLayout, changes: string[], warnings: string[]): Promise<void> {
  let entries = await parsePropertiesFile(layout.serverProperties)
  if (!entries.length) {
    entries = [{ key: 'online-mode', value: 'false' }]
    warnings.push('没有读到 server.properties，只写入了 online-mode=false，首次启动后请再检查一次。')
  } else {
    const hit = entries.find((e) => e.key === 'online-mode')
    if (hit) hit.value = 'false'
    else entries.push({ key: 'online-mode', value: 'false' })
  }
  await writeProperties(layout.serverProperties, entries)
  changes.push('server.properties：online-mode=false')
}

async function configurePaper(
  layout: ServerLayout,
  format: ProxyFormat,
  secret: string | null,
  changes: string[],
  warnings: string[]
): Promise<void> {
  if (format === 'bungee') {
    const path = join(layout.core, 'spigot.yml')
    await patchYamlFile(path, [{ keys: ['settings', 'bungeecord'], value: 'true' }])
    changes.push('spigot.yml：settings.bungeecord=true')
    return
  }

  const path = join(layout.core, 'config', 'paper-global.yml')
  // 接入时代理端会被切到 offline，这里也要跟着关，否则 Paper 会按正版 UUID 校验
  const updates = [
    { keys: ['proxies', 'velocity', 'enabled'], value: 'true' },
    { keys: ['proxies', 'velocity', 'online-mode'], value: 'false' }
  ]
  if (secret) updates.push({ keys: ['proxies', 'velocity', 'secret'], value: secret })
  await patchYamlFile(path, updates)
  changes.push('paper-global.yml：proxies.velocity.enabled=true')
  if (!secret) warnings.push('代理端没有转发密钥，Paper 的 proxies.velocity.secret 暂时是空的。')
}

async function configureFabric(
  layout: ServerLayout,
  format: ProxyFormat,
  secret: string | null,
  mcVersion: string,
  opts: JoinOptions,
  changes: string[],
  warnings: string[],
  emit?: JoinProgress
): Promise<void> {
  const configDir = layout.configDir ?? join(layout.core, 'config')
  await fs.mkdir(configDir, { recursive: true })

  if (format === 'bungee') {
    // 1.21.11 / 26.x 上 Fabric-Bungeecord-Proxy 的 mixin 已经对不上，
    // 会以 UserCacheMixin 找不到字段直接让服务端起不来，改用 ProxyForward。
    if (proxyForwardSupported(mcVersion)) {
      let pf: string | null = null
      try {
        pf = await installProxyForward(layout, mcVersion, 'bungee', null, emit)
      } catch (err) {
        warnings.push(`自动下载 ProxyForward 失败：${(err as Error).message}`)
      }
      await disableJar(
        await modsDirOf(layout),
        /^fabricproxy[-_]?lite/i,
        'BungeeCord 网络下 FabricProxy-Lite 会踢掉玩家',
        changes,
        warnings
      )
      await disableJar(
        await modsDirOf(layout),
        /^fabricproxy(?![-_]?lite)/i,
        '这个版本上 Fabric-Bungeecord-Proxy 与服务端不兼容',
        changes,
        warnings
      )
      if (pf) {
        changes.push(`已安装 ${pf}，并写入 config/proxyforward.toml（forwarding_mode="bungee"）`)
        await ensureFabricLoader(layout, mcVersion, opts, changes, warnings, emit)
      } else {
        warnings.push(
          'ProxyForward 没有装上。这个版本的旧桥接会让服务端崩溃，所以没有自动安装；' +
            '玩家仍然能连接，但拿不到真实 UUID / 皮肤。可以手动从 GitHub Releases 下载对应版本的 proxyforward-fabric。'
        )
      }
      return
    }

    let file: string | null = null
    try {
      file = await installFabricBungee(layout, emit)
    } catch (err) {
      warnings.push(`自动下载 Fabric-Bungeecord-Proxy 失败：${(err as Error).message}`)
    }
    // 无论桥接有没有装上，Lite 都必须停用：它接 Bungee 会直接踢人
    await disableJar(
      await modsDirOf(layout),
      /^fabricproxy[-_]?lite/i,
      'BungeeCord 网络下 FabricProxy-Lite 会踢掉玩家',
      changes,
      warnings
    )
    if (!file) {
      warnings.push(
        '没有自动装上 Fabric-Bungeecord-Proxy。请手动把支持 BungeeCord 的 Fabric 桥接模组放进 mods/，' +
          '否则玩家会以离线身份进入。FabricProxy-Lite 只支持 Velocity，不能用于 BungeeCord。'
      )
      return
    }
    await patchTomlTop(
      join(configDir, 'FabricProxy.toml'),
      {
        BungeeCord: 'true',
        alwaysOfficialUUID: 'false',
        allowBypassProxy: 'false',
        secret: "''"
      },
      'BungeeCord = true\nalwaysOfficialUUID = false\nallowBypassProxy = false\nsecret = \'\'\n'
    )
    changes.push(`已安装 ${file}，并写入 config/FabricProxy.toml（BungeeCord=true）`)
    return
  }

  let file: string | null = null
  try {
    file = await installFromModrinth(
      layout,
      'fabricproxy-lite',
      'fabric',
      mcVersion,
      /^fabricproxy[-_]?lite/i,
      emit
    )
  } catch (err) {
    warnings.push(`自动下载 FabricProxy-Lite 失败：${(err as Error).message}`)
  }
  if (!file) {
    warnings.push(
      '没有自动装上 FabricProxy-Lite。请从 Modrinth 手动下载并放进 mods/，' +
        '再在 config/FabricProxy-Lite.toml 里填入代理端的 secret。'
    )
    return
  }
  // Velocity 下保留 Lite，停用只支持 Bungee 的完整版桥接，避免两个模组抢握手
  await disableJar(
    await modsDirOf(layout),
    /^fabricproxy(?![-_]?lite)/i,
    'Velocity 网络下应使用 FabricProxy-Lite',
    changes,
    warnings
  )
  await disableJar(
    await modsDirOf(layout),
    /^proxyforward/i,
    'Velocity 网络下已使用 FabricProxy-Lite',
    changes,
    warnings
  )
  await patchTomlTop(
    join(configDir, 'FabricProxy-Lite.toml'),
    {
      secret: `"${secret ?? ''}"`,
      hackOnlineMode: 'true'
    },
    `secret = "${secret ?? ''}"\nhackOnlineMode = true\nhackEarlySend = false\nhackMessageChain = false\n` +
      'disconnectMessage = "This server requires you to connect with Velocity."\n'
  )
  changes.push(`已安装 ${file}，并写入 config/FabricProxy-Lite.toml`)
}

async function configureForge(
  layout: ServerLayout,
  format: ProxyFormat,
  secret: string | null,
  mcVersion: string,
  loader: 'forge' | 'neoforge',
  changes: string[],
  warnings: string[],
  emit?: JoinProgress
): Promise<void> {
  let file: string | null = null
  try {
    file = await installFromModrinth(
      layout,
      'proxy-compatible-forge',
      loader,
      mcVersion,
      /proxy[-_]?compatible[-_]?forge/i,
      emit
    )
  } catch (err) {
    warnings.push(`自动下载 ProxyCompatibleForge 失败：${(err as Error).message}`)
  }
  if (!file) {
    warnings.push(
      '没有自动装上 ProxyCompatibleForge。Forge / NeoForge 需要桥接模组才能接代理端：' +
        '可从 Modrinth 下载 Proxy Compatible Forge 放进 mods/，再配置 config/proxy-compatible-forge.toml。'
    )
    return
  }

  const configDir = layout.configDir ?? join(layout.core, 'config')
  await patchTomlSection(
    join(configDir, 'proxy-compatible-forge.toml'),
    'forwarding',
    {
      enabled: 'true',
      mode: format === 'bungee' ? '"LEGACY"' : '"MODERN"',
      secret: `"${secret ?? ''}"`
    },
    `[forwarding]\nenabled = true\nmode = "${format === 'bungee' ? 'LEGACY' : 'MODERN'}"\n` +
      `secret = "${secret ?? ''}"\napprovedProxyHosts = []\n\n[crossStitch]\nenabled = true\n` +
      'forceWrappedArguments = []\nforceWrapVanillaArguments = false\n\n[debug]\nenabled = false\n'
  )
  changes.push(
    `已安装 ${file}，并写入 config/proxy-compatible-forge.toml（${format === 'bungee' ? 'LEGACY' : 'MODERN'}）`
  )
  const [major, minor] = mcVersion.split('.').map((n) => Number(n) || 0)
  if (major === 1 && minor > 0 && minor < 14) {
    warnings.push('这个 Forge 版本较老，PCF 可能还需要 MixinBootstrap / MixinBooter 等前置，请按它的说明补装。')
  }
}

/**
 * 代理端已接入的后端里是否有 Forge / NeoForge。
 *
 * BungeeCord / Waterfall 的 `forge_support` 是一个全局开关：只要有一台 Forge
 * 后端就必须开；纯 Fabric 网络开着它，代理端会注入 FML 握手（legacy:fml|hs），
 * 干扰 Fabric 的注册表同步，表现为客户端被踢回「需要安装 Fabric API」。
 *
 * 代理端里可能有 CraftDesk 没导入的服务器，读不到它的核心类型。这时不能
 * 断言「一定是纯 Fabric」，否则会误关 forge_support 把外部的 Forge 后端弄坏。
 */
async function proxyForgeState(
  proxyFile: VelocityFile,
  cfg: ServerConfig,
  allServers?: ServerConfig[]
): Promise<{ hasForge: boolean; unknown: boolean }> {
  if (cfg.kind === 'forge' || cfg.kind === 'neoforge') {
    return { hasForge: true, unknown: false }
  }
  if (!proxyFile.servers.length) return { hasForge: false, unknown: false }
  if (!allServers?.length) return { hasForge: false, unknown: true }

  const kindsByPort = new Map<number, ServerKind>()
  for (const server of allServers) {
    if (server.id === cfg.id || isProxyKind(server.kind)) continue
    try {
      kindsByPort.set(await portOf(server, await resolveLayout(server)), server.kind)
    } catch {
      /* 单个服务器读不出端口就跳过 */
    }
  }

  let hasForge = false
  let unknown = false
  for (const entry of proxyFile.servers) {
    // 新建代理端会自带一个 lobby 占位后端，它不是真实服务器
    if (isPlaceholderProxyEntry(proxyFile, entry)) continue
    const kind = kindsByPort.get(entry.port)
    if (kind === undefined) unknown = true
    else if (kind === 'forge' || kind === 'neoforge') hasForge = true
  }
  return { hasForge, unknown }
}

/** CraftDesk 新建 BungeeCord / Waterfall 时写入的占位 lobby */
function isPlaceholderProxyEntry(
  proxyFile: VelocityFile,
  entry: VelocityFile['servers'][number]
): boolean {
  return (
    proxyFile.format !== 'velocity' &&
    entry.name === 'lobby' &&
    entry.address === '127.0.0.1:25566' &&
    proxyFile.raw.includes('默认入口，请在 CraftDesk 里改成真实的后端地址')
  )
}

async function configureBackend(
  cfg: ServerConfig,
  layout: ServerLayout,
  format: ProxyFormat,
  secret: string | null,
  mcVersion: string,
  opts: JoinOptions,
  changes: string[],
  warnings: string[],
  emit?: JoinProgress
): Promise<void> {
  await setOnlineModeOff(layout, changes, warnings)
  const kind = cfg.kind

  if (BUKKIT_KINDS.includes(kind)) {
    await configurePaper(layout, format, secret, changes, warnings)
    return
  }
  if (kind === 'fabric') {
    await configureFabric(layout, format, secret, mcVersion, opts, changes, warnings, emit)
    return
  }
  if (kind === 'forge' || kind === 'neoforge') {
    await configureForge(
      layout,
      format,
      secret,
      mcVersion,
      kind === 'neoforge' ? 'neoforge' : 'forge',
      changes,
      warnings,
      emit
    )
    return
  }
  if (kind === 'vanilla') {
    warnings.push(
      '原版服务端不支持代理端转发。玩家能进来，但拿不到真实 IP / UUID；' +
        '需要转发的话请换成 Paper / Purpur，或安装 Fabric / Forge 的桥接模组。'
    )
    return
  }
  warnings.push(`还不认识 ${kind} 类型的转发方式，只关闭了 online-mode，请手动检查后端的转发配置。`)
}

// ---------------------------------------------------------------- 入口

export async function joinServerToNetwork(
  cfg: ServerConfig,
  proxyCfg: ServerConfig,
  emit?: JoinProgress,
  /** 全部托管服务器，用来挑一个真正没被占用的后端端口 */
  allServers?: ServerConfig[],
  /** Java 路径与运行状态：用于自动更新 Fabric Loader */
  opts: JoinOptions = {}
): Promise<NetworkJoinResult> {
  if (isProxyKind(cfg.kind)) throw new Error('代理端不能再加入另一个代理端')
  if (!isProxyKind(proxyCfg.kind)) throw new Error('目标不是代理端')

  const layout = await resolveLayout(cfg)
  const proxyLayout = await resolveLayout(proxyCfg)
  const proxyFile = await readProxyFile(proxyCfg)
  if (!proxyFile.exists) {
    throw new Error(
      `代理端还没有生成 ${proxyCfg.kind === 'velocity' ? 'velocity.toml' : 'config.yml'}。请先启动一次代理端。`
    )
  }

  const format: ProxyFormat = proxyFile.format === 'bungee' ? 'bungee' : 'velocity'
  const changes: string[] = []
  const warnings: string[] = []
  let proxyOnlineMode: boolean | null = null
  let secret = proxyFile.secret

  /*
   * 后端不能和代理端（或其它服务器）用同一个端口。
   *
   * 这是最隐蔽的一种「进不去」：代理端先启动就占住端口，后端启动失败；
   * 后端先启动则代理端绑定失败。配置看起来一切正常，玩家只是连不上。
   * 加入网络时直接发现并换到下一个空闲端口，用户不用自己去翻 server.properties。
   */
  let port = await portOf(cfg, layout)
  const originalAddress = `127.0.0.1:${port}`
  const used = allServers ? await configuredPorts(allServers, cfg.id) : new Set<number>()
  if (proxyLayout.configuredPort) used.add(proxyLayout.configuredPort)
  if (used.has(port)) {
    const next = await pickFreePort(port + 1, used)
    const props = await parsePropertiesFile(layout.serverProperties)
    const hit = props.find((e) => e.key === 'server-port')
    if (hit) hit.value = String(next)
    else props.push({ key: 'server-port', value: String(next) })
    await writeProperties(layout.serverProperties, props)
    changes.push(`后端端口 ${port} 与代理端或其它服务器冲突，已自动改为 ${next}`)
    warnings.push('端口改了，需要重启这台后端才生效。')
    port = next
  }
  const address = `127.0.0.1:${port}`

  // ---- 1. 代理端的 servers + 默认入口
  // 认已有条目时按别名、旧地址、新地址依次找：端口被自动改过时不能又加一条
  const sameAddress =
    proxyFile.servers.find((s) => cfg.networkAlias && s.name === cfg.networkAlias) ??
    proxyFile.servers.find((s) => s.address === originalAddress) ??
    proxyFile.servers.find((s) => s.address === address)
  const alias =
    sameAddress?.name ?? slugAlias(cfg.name, proxyFile.servers.map((s) => s.name), port)
  const servers = proxyFile.servers.map((s) =>
    s.name === alias ? { name: s.name, address } : { name: s.name, address: s.address }
  )
  if (!sameAddress) servers.push({ name: alias, address })
  // 新后端也放进 try：原来那个默认入口不可用时，玩家还能落到这一台上
  const tryList = [...proxyFile.tryList]
  if (!tryList.includes(alias)) tryList.push(alias)
  if (!proxyFile.tryList.length) {
    warnings.push(`代理端原本没有默认入口，已把 ${alias} 设为玩家登录后的第一个服务器。`)
  }
  await writeProxyServers(proxyCfg, servers, tryList)
  changes.push(
    `代理端 ${proxyCfg.kind === 'velocity' ? '[servers]' : 'servers:'}：已写入 ${alias} → ${address}`
  )

  // ---- 2. 代理端开关
  if (format === 'bungee') {
    const updates = [
      { section: '', key: 'online_mode', value: 'false', type: 'boolean' as const },
      { section: '', key: 'ip_forward', value: 'true', type: 'boolean' as const }
    ]
    const applied = ['online_mode=false', 'ip_forward=true']
    const forgeState = await proxyForgeState(proxyFile, cfg, allServers)

    if (cfg.kind === 'forge' || cfg.kind === 'neoforge') {
      updates.push({ section: '', key: 'forge_support', value: 'true', type: 'boolean' as const })
      applied.push('forge_support=true')
    } else if (cfg.kind === 'fabric') {
      if (forgeState.hasForge) {
        // 全局开关无法同时满足 Forge 与 Fabric；不要偷偷改掉现有值，留给用户决定
        warnings.push(
          '这个 BungeeCord / Waterfall 网络里还有 Forge 后端，forge_support 只能全局开启。' +
            'Forge 与 Fabric 混在同一张 Bungee 网络里时，Fabric 可能因 FML 握手注入而注册表同步失败。' +
            '建议把 Fabric 后端接到一个单独的 Velocity 网络。'
        )
      } else if (forgeState.unknown) {
        warnings.push(
          '代理端里还有未导入 CraftDesk 的服务器，无法确认其中是否有 Forge，因此没有自动修改 forge_support。' +
            '如果网络里全是 Fabric，请手动把 config.yml 的 forge_support 设为 false；' +
            '有 Forge 的话应保持 true，并考虑把 Fabric 拆到 Velocity。'
        )
      } else {
        updates.push({
          section: '',
          key: 'forge_support',
          value: 'false',
          type: 'boolean' as const
        })
        applied.push('forge_support=false（纯 Fabric 网络）')
        changes.push(
          '检测到网络中没有 Forge 后端，已关闭 forge_support，避免 Waterfall 注入 FML 握手干扰 Fabric 客户端。'
        )
      }
    }

    await writeProxyFields(proxyCfg, updates, true)
    proxyOnlineMode = false
    changes.push(`代理端 config.yml：${applied.join('、')}`)
  } else {
    if (!secret) {
      secret = randomBytes(16).toString('hex')
      const secretPath = join(proxyLayout.core, proxyFile.secretFile || 'forwarding.secret')
      await fs.mkdir(dirname(secretPath), { recursive: true })
      await fs.writeFile(secretPath, `${secret}\n`, 'utf-8')
      changes.push(`生成了代理端转发密钥：${proxyFile.secretFile || 'forwarding.secret'}`)
    }
    await writeProxyFields(proxyCfg, [
      { section: '', key: 'online-mode', value: 'false', type: 'boolean' },
      { section: '', key: 'player-info-forwarding-mode', value: 'modern', type: 'string' }
    ])
    proxyOnlineMode = false
    changes.push('代理端 velocity.toml：online-mode=false、player-info-forwarding-mode=modern')
  }

  // ---- 3. 后端
  const mcVersion = (await detectInstalledMcVersion(layout)) ?? cfg.mcVersion
  await configureBackend(cfg, layout, format, secret, mcVersion, opts, changes, warnings, emit)

  return {
    proxyId: proxyCfg.id,
    proxyName: proxyCfg.name,
    proxyKind: proxyCfg.kind,
    alias,
    address,
    backendPort: port,
    mcVersion,
    changes,
    warnings,
    proxyOnlineMode
  }
}

/**
 * 在现有代理端配置里找这台服务器。
 *
 * 有些服务器是在这个功能之前手动接进代理端的，`networkId` 还是空的；
 * 按端口扫一遍代理端的 servers 列表，用户仍然能看到「已加入」并且移出。
 */
export async function findJoinedNetwork(
  cfg: ServerConfig,
  servers: ServerConfig[]
): Promise<{ proxy: ServerConfig; alias: string } | null> {
  if (isProxyKind(cfg.kind)) return null
  let port = 0
  try {
    port = await portOf(cfg, await resolveLayout(cfg))
  } catch {
    return null
  }
  if (!port) return null

  for (const proxy of servers) {
    if (proxy.id === cfg.id || !isProxyKind(proxy.kind)) continue
    try {
      const file = await readProxyFile(proxy)
      if (!file.exists) continue
      const hit = file.servers.find((s) => s.port === port)
      if (hit) return { proxy, alias: hit.name }
    } catch {
      /* 单个代理端读不出来就跳过 */
    }
  }
  return null
}

/** 从代理端配置里摘掉这台服务器；后端自己的文件保持原样 */
export async function leaveNetwork(
  cfg: ServerConfig,
  proxyCfg: ServerConfig
): Promise<{ removed: boolean; alias: string; remaining: number }> {
  const layout = await resolveLayout(cfg)
  const port = await portOf(cfg, layout)
  const address = `127.0.0.1:${port}`
  const proxyFile = await readProxyFile(proxyCfg)
  if (!proxyFile.exists) return { removed: false, alias: '', remaining: 0 }

  const hit = proxyFile.servers.find((s) => s.name === cfg.networkAlias) ??
    proxyFile.servers.find((s) => s.address === address)
  if (!hit) return { removed: false, alias: '', remaining: proxyFile.servers.length }

  const servers = proxyFile.servers
    .filter((s) => s.name !== hit.name)
    .map((s) => ({ name: s.name, address: s.address }))
  const tryList = proxyFile.tryList.filter((n) => n !== hit.name)
  await writeProxyServers(proxyCfg, servers, tryList)
  return { removed: true, alias: hit.name, remaining: servers.length }
}
