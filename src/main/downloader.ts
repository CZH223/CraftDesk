import { promises as fs } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { DownloadProgress, ServerKind } from '../shared/types'
import { isProxyKind } from '../shared/types'
import { serializeProperties } from './properties'
import { ZipReader } from './zip'
import {
  type ProxyKind,
  proxyConfigName,
  proxyConfigText
} from './proxySetup'
import { run } from './java'
import {
  fetchSha1,
  findArgsFile,
  findUniversalJar,
  forgeInstaller,
  listForgeVersions,
  listNeoForgeVersions,
  neoforgeInstaller
} from './installers'

const UA = 'CraftDesk/1.0 (Minecraft server manager)'
const TIMEOUT = 30000

async function getJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载完之后用来核对的东西。
 * 能给出 size / checksum 的接口就尽量给——校验一次比事后让用户猜
 * 「为什么服务器起不来」便宜太多。
 */
export interface DownloadExpect {
  size?: number
  checksum?: { algo: 'sha1' | 'sha256' | 'md5'; value: string }
}

/** 支持重定向与进度回调的文件下载 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
  expect?: DownloadExpect
): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`)

    /*
     * content-length 对得上「传输了多少」，对不上「写到磁盘的有多少」：
     * 响应带 gzip / br 时它记的是压缩后的大小，而 fetch 会自动解压，
     * 落到磁盘的是解压后的字节。拿它去核对会得出假的「下载不完整」。
     * 所以有 content-encoding 时就不用这个头，改用接口给的 size。
     */
    const encoded = res.headers.get('content-encoding')
    const headerLen = encoded && encoded !== 'identity' ? 0 : Number(res.headers.get('content-length') || 0)
    const total = headerLen || expect?.size || 0
    let received = 0
    let lastEmit = 0

    /*
     * 计数和校验都在管道内部做。
     *
     * 这里原来是在源流上挂了个 'data' 监听来数进度——那个监听会让流立刻
     * 进入 flowing 模式，而 pipeline 还没把写入端接上，中间挤出来的数据块
     * 就直接丢了：文件少几 KB，进度却照样显示 100%。
     * Paper 的 jar 少 4 KB 就是「Invalid or corrupt jarfile」，
     * 表现是新建的服务器怎么都起不来。
     */
    const hash = expect?.checksum ? createHash(expect.checksum.algo) : null
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length
        hash?.update(chunk)
        const now = Date.now()
        if (onProgress && now - lastEmit > 120) {
          lastEmit = now
          onProgress(received, total)
        }
        cb(null, chunk)
      }
    })

    await fs.mkdir(dirname(dest), { recursive: true })
    await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), counter, createWriteStream(dest))
    onProgress?.(received, total || received)

    // 落盘之后就核对。宁可在这里报错重来，也不要留一个坏文件让用户去猜。
    const want = expect?.size ?? headerLen
    if (want && received !== want) {
      await fs.rm(dest, { force: true })
      throw new Error(`下载不完整：期望 ${want} 字节，实际 ${received} 字节。已删除这个文件，请重试`)
    }
    if (hash && expect?.checksum) {
      const got = hash.digest('hex')
      if (got.toLowerCase() !== expect.checksum.value.toLowerCase()) {
        await fs.rm(dest, { force: true })
        throw new Error(
          `文件校验失败：期望 ${expect.checksum.algo} ${expect.checksum.value}，实际 ${got}。` +
            `已删除这个文件，请重试`
        )
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- 版本清单

export interface VersionOption {
  id: string
  /** 最新构建号，Paper/Purpur 用得上 */
  latestBuild?: string
}

/** 原版：Mojang 官方版本清单，只取正式版 */
export async function listVanillaVersions(): Promise<VersionOption[]> {
  const data = await getJson<{ versions: { id: string; type: string }[] }>(
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
  )
  return data.versions.filter((v) => v.type === 'release').map((v) => ({ id: v.id }))
}

/**
 * PaperMC 系的版本表（Paper / Velocity / Waterfall）。
 *
 * v2 接口已经被官方 sunset 了（返回 `{"ok":false,"error":"sunset"}`），
 * 所以先走新的 fill v3，失败再退回 v2 —— 万一哪天 v2 又被谁代理起来了，
 * 至少还能用。
 */
async function paperVersions(project: string): Promise<VersionOption[]> {
  try {
    const data = await getJson<{ versions: Record<string, string[]> }>(
      `https://fill.papermc.io/v3/projects/${project}`
    )
    return flattenPaperVersions(data.versions)
  } catch {
    const data = await getJson<{ versions: string[] }>(
      `https://api.papermc.io/v2/projects/${project}`
    )
    return [...data.versions].reverse().map((v) => ({ id: v }))
  }
}

/**
 * fall v3 把版本按大版本分组返回，例如 Velocity：
 * `{ "4.0.0": ["4.2.1-SNAPSHOT", "4.2.0", ...], "3.0.0": [...] }`。
 *
 * 顺序上把正式版排在快照前面：默认选中第一个，谁都不想一上来就装快照。
 * 组内保持接口给的顺序（新版本在前）。
 */
export function flattenPaperVersions(versions: Record<string, string[]>): VersionOption[] {
  const all = Object.values(versions || {}).flat()
  const stable = all.filter((v) => !/snapshot|pre|rc|beta/i.test(v))
  const snapshot = all.filter((v) => /snapshot|pre|rc|beta/i.test(v))
  return [...stable, ...snapshot].map((v) => ({ id: v }))
}

/** Paper */
export async function listPaperVersions(): Promise<VersionOption[]> {
  return paperVersions('paper')
}

/** Velocity（代理端） */
export async function listVelocityVersions(): Promise<VersionOption[]> {
  return paperVersions('velocity')
}

/** Waterfall（代理端，BungeeCord 的下游分支） */
export async function listWaterfallVersions(): Promise<VersionOption[]> {
  return paperVersions('waterfall')
}

/**
 * BungeeCord 没有「版本」这个概念，官方只按构建号发。
 *
 * 版本表给最近若干个成功的构建号（构建号就是个数字），
 * 最新的排前面。取不到就退回「latest」一个选项。
 */
export async function listBungeeVersions(): Promise<VersionOption[]> {
  try {
    const data = await getJson<{ builds: { number: number; result: string | null }[] }>(
      'https://ci.md-5.net/job/BungeeCord/api/json?tree=builds%5Bnumber,result%5D'
    )
    const ok = data.builds.filter((b) => b.result === 'SUCCESS').slice(0, 20)
    if (!ok.length) throw new Error('没有成功的构建')
    return ok.map((b) => ({ id: String(b.number), latestBuild: String(b.number) }))
  } catch {
    return [{ id: 'latest' }]
  }
}

/** Purpur */
export async function listPurpurVersions(): Promise<VersionOption[]> {
  const data = await getJson<{ versions: string[] }>('https://api.purpurmc.org/v2/purpur')
  return [...data.versions].reverse().map((v) => ({ id: v }))
}

/** Fabric：只列稳定版游戏版本 */
export async function listFabricVersions(): Promise<VersionOption[]> {
  const data = await getJson<{ version: string; stable: boolean }[]>(
    'https://meta.fabricmc.net/v2/versions/game'
  )
  return data.filter((v) => v.stable).map((v) => ({ id: v.version }))
}

export async function listVersions(kind: ServerKind): Promise<VersionOption[]> {
  switch (kind) {
    case 'vanilla':
      return listVanillaVersions()
    case 'paper':
      return listPaperVersions()
    case 'purpur':
      return listPurpurVersions()
    case 'fabric':
      return listFabricVersions()
    // 代理端：本身不加载世界，只有版本 / 构建号之分
    case 'velocity':
      return listVelocityVersions()
    case 'waterfall':
      return listWaterfallVersions()
    case 'bungeecord':
      return listBungeeVersions()
    // 这两家官方只给安装器，版本表也从官方接口拿
    case 'forge':
      return listForgeVersions()
    case 'neoforge':
      return listNeoForgeVersions()
    default:
      throw new Error('该服务端类型需要手动安装后导入')
  }
}

// ---------------------------------------------------------------- 各类型的下载

/** 各类型的下载信息。参数能拿到校验值就一起带回来，下载完当场核对 */
interface ResolvedDownload {
  url: string
  name: string
  size?: number
  checksum?: DownloadExpect['checksum']
  /** 主地址失败时按顺序再试的镜像地址 */
  fallbacks?: string[]
}

async function resolveVanillaUrl(mcVersion: string): Promise<ResolvedDownload> {
  const manifest = await getJson<{ versions: { id: string; url: string }[] }>(
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
  )
  const entry = manifest.versions.find((v) => v.id === mcVersion)
  if (!entry) throw new Error(`找不到原版版本 ${mcVersion}`)
  const detail = await getJson<{
    downloads: { server?: { url: string; size?: number; sha1?: string } }
  }>(entry.url)
  const server = detail.downloads?.server
  if (!server?.url) throw new Error(`${mcVersion} 没有服务端下载（可能是太老的版本）`)
  return {
    url: server.url,
    name: `minecraft_server.${mcVersion}.jar`,
    size: server.size,
    checksum: server.sha1 ? { algo: 'sha1', value: server.sha1 } : undefined
  }
}

async function resolvePaperUrl(mcVersion: string): Promise<ResolvedDownload> {
  // 先试 v2（注意：v2 已被官方 sunset，正常会直接失败落到下面）
  try {
    const builds = await getJson<{
      builds: {
        build: number
        channel: string
        downloads: { application: { name: string; size?: number; sha256?: string } }
      }[]
    }>(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds`)
    const usable = builds.builds.filter((b) => b.channel === 'default' || b.channel === 'STABLE')
    const list = usable.length ? usable : builds.builds
    const latest = list[list.length - 1]
    if (!latest) throw new Error('没有可用构建')
    const app = latest.downloads.application
    return {
      url: `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${latest.build}/downloads/${app.name}`,
      name: app.name,
      size: app.size,
      checksum: app.sha256 ? { algo: 'sha256', value: app.sha256 } : undefined
    }
  } catch (err) {
    // 新版 fill API：带 size 和 sha256，正好用来核对下载
    const builds = await getJson<
      {
        id: string
        channel: string
        downloads: Record<
          string,
          { url: string; name: string; size?: number; checksums?: { sha256?: string } }
        >
      }[]
    >(`https://fill.papermc.io/v3/projects/paper/versions/${mcVersion}/builds`)
    const usable = builds.filter((b) => b.channel === 'STABLE')
    const list = usable.length ? usable : builds
    const latest = list[0]
    const dl = latest?.downloads?.['server:default']
    if (!dl) throw new Error(`无法获取 Paper ${mcVersion} 下载地址：${String(err)}`)
    return {
      url: dl.url,
      name: dl.name,
      size: dl.size,
      checksum: dl.checksums?.sha256 ? { algo: 'sha256', value: dl.checksums.sha256 } : undefined
    }
  }
}

async function resolvePurpurUrl(mcVersion: string): Promise<ResolvedDownload> {
  const data = await getJson<{ builds: { latest: string } }>(
    `https://api.purpurmc.org/v2/purpur/${mcVersion}`
  )
  const build = data.builds?.latest
  if (!build) throw new Error(`Purpur ${mcVersion} 没有可用构建`)
  // Purpur 的构建详情里有 md5，多一次请求换一次校验，值
  const detail = await getJson<{ md5?: string }>(
    `https://api.purpurmc.org/v2/purpur/${mcVersion}/${build}`
  ).catch(() => ({}) as { md5?: string })
  return {
    url: `https://api.purpurmc.org/v2/purpur/${mcVersion}/${build}/download`,
    name: `purpur-${mcVersion}-${build}.jar`,
    checksum: detail.md5 ? { algo: 'md5', value: detail.md5 } : undefined
  }
}

async function resolveFabricUrl(mcVersion: string): Promise<ResolvedDownload> {
  const [loaders, installers] = await Promise.all([
    getJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/loader'),
    getJson<{ version: string; stable: boolean }[]>(
      'https://meta.fabricmc.net/v2/versions/installer'
    )
  ])
  const loader = loaders.find((l) => l.stable) || loaders[0]
  const installer = installers.find((i) => i.stable) || installers[0]
  if (!loader || !installer) throw new Error('无法获取 Fabric 加载器版本')
  return {
    url: `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loader.version}/${installer.version}/server/jar`,
    name: `fabric-server-mc${mcVersion}-loader${loader.version}.jar`
  }
}

export async function resolveDownloadUrl(
  kind: ServerKind,
  mcVersion: string
): Promise<ResolvedDownload> {
  switch (kind) {
    case 'vanilla':
      return resolveVanillaUrl(mcVersion)
    case 'paper':
      return resolvePaperUrl(mcVersion)
    case 'purpur':
      return resolvePurpurUrl(mcVersion)
    case 'fabric':
      return resolveFabricUrl(mcVersion)
    case 'velocity':
      return resolvePaperLikeUrl('velocity', mcVersion)
    case 'waterfall':
      return resolvePaperLikeUrl('waterfall', mcVersion)
    case 'bungeecord':
      return resolveBungeeUrl(mcVersion)
    default:
      throw new Error('该服务端类型暂不支持自动下载，请手动安装后导入')
  }
}

/**
 * PaperMC 系（Paper / Velocity / Waterfall）的下载地址。
 *
 * 只取 STABLE 通道里最新的那个构建，并且只认 `server:default` 这一项 ——
 * Waterfall 的构建里还有一堆 `module:*`（拆分出来的小模块），
 * 拿错了会下回一个几 KB 的东西。
 */
async function resolvePaperLikeUrl(project: string, version: string): Promise<ResolvedDownload> {
  interface Build {
    id: string | number
    channel: string
    downloads: Record<
      string,
      { url: string; name: string; size?: number; checksums?: { sha256?: string } }
    >
  }
  const pick = (builds: Build[]): ResolvedDownload => {
    const stable = builds.filter((b) => b.channel === 'STABLE')
    const list = stable.length ? stable : builds
    // fill v3 的列表是新的在前
    const build = list[0]
    const dl = build?.downloads?.['server:default']
    if (!dl) throw new Error(`没有找到 ${project} ${version} 的下载文件`)
    return {
      url: dl.url,
      name: dl.name,
      size: dl.size,
      checksum: dl.checksums?.sha256 ? { algo: 'sha256', value: dl.checksums.sha256 } : undefined
    }
  }

  try {
    const builds = await getJson<Build[]>(
      `https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds`
    )
    return pick(builds)
  } catch (err) {
    // 老接口兜底：字段名不一样，单独映射一次
    const builds = await getJson<{
      builds: {
        build: number
        channel: string
        downloads: { application: { name: string; size?: number; sha256?: string } }
      }[]
    }>(`https://api.papermc.io/v2/projects/${project}/versions/${version}/builds`)
    const usable = builds.builds.filter((b) => b.channel === 'default')
    const latest = (usable.length ? usable : builds.builds).slice(-1)[0]
    if (!latest) throw new Error(`没有找到 ${project} ${version} 的可用构建：${String(err)}`)
    return {
      url: `https://api.papermc.io/v2/projects/${project}/versions/${version}/builds/${latest.build}/downloads/${latest.downloads.application.name}`,
      name: latest.downloads.application.name,
      size: latest.downloads.application.size,
      checksum: latest.downloads.application.sha256
        ? { algo: 'sha256', value: latest.downloads.application.sha256 }
        : undefined
    }
  }
}

/**
 * BungeeCord 的下载地址。
 *
 * 官方 Jenkins（ci.md-5.net）给的是「构建号 → 产物」的固定路径；
 * `latest` 走 lastSuccessfulBuild。后面那个地址是 SpigotMC 的 Jenkins，
 * 作为备选 —— 两边是同一个东西，一边抽风时还能下得下来。
 */
async function resolveBungeeUrl(build: string): Promise<ResolvedDownload> {
  const id = /^\d+$/.test(build.trim()) ? build.trim() : 'lastSuccessfulBuild'
  const name = 'BungeeCord.jar'
  return {
    url: `https://ci.md-5.net/job/BungeeCord/${id}/artifact/bootstrap/target/${name}`,
    name,
    fallbacks: [`https://hub.spigotmc.org/jenkins/job/BungeeCord/${id}/artifact/bootstrap/target/${name}`]
  }
}

// ---------------------------------------------------------------- 新建服务器

export interface CreateResult {
  /** 可以 -jar 启动时的核心；Forge 1.17+ 这类没有，就是空字符串 */
  jar: string
  jarPath: string
  /** Forge / NeoForge 的参数文件（相对服务器目录），有它就按 `java @文件` 启动 */
  launchArgs?: string
}

export async function installServer(
  dir: string,
  kind: ServerKind,
  mcVersion: string,
  options: {
    motd: string
    port: number
    maxPlayers: number
    acceptEula: boolean
    onlineMode: boolean
    /** Forge / NeoForge 要装的构建号 */
    build?: string
    /** 官方安装器本身也是 java 程序，得用配置好的 Java 去跑 */
    javaPath?: string
  },
  taskId: string,
  emit: (p: DownloadProgress) => void
): Promise<CreateResult> {
  const progress = (
    stage: DownloadProgress['stage'],
    message: string,
    received = 0,
    total = 0
  ): void => {
    emit({
      taskId,
      stage,
      message,
      received,
      total,
      percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
    })
  }

  await fs.mkdir(dir, { recursive: true })

  // 代理端：下个 jar + 生成它自己的那份配置，没有 EULA 和 server.properties
  if (isProxyKind(kind)) {
    const proxy = kind as ProxyKind
    progress('meta', `正在解析 ${kind} ${mcVersion} 的下载地址…`)
    const resolved = await resolveDownloadUrl(proxy, mcVersion)

    const jarPath = join(dir, resolved.name)
    progress('download', `正在下载 ${resolved.name}`, 0, resolved.size ?? 0)
    await downloadWithFallback(
      [resolved.url, ...(resolved.fallbacks ?? [])],
      jarPath,
      (received, total) => progress('download', `正在下载 ${resolved.name}`, received, total),
      { size: resolved.size, checksum: resolved.checksum }
    )

    progress('extract', `正在生成 ${proxyConfigName(proxy)}…`)
    await writeProxyConfig(dir, proxy, jarPath, options)
    progress('done', '安装完成')
    return { jar: resolved.name, jarPath }
  }

  // Forge / NeoForge 没有「下个 jar 就能跑」这回事，交给官方安装器
  if (kind === 'forge' || kind === 'neoforge') {
    const installed = await installWithOfficialInstaller(dir, kind, mcVersion, options, progress)
    progress('extract', '正在写入配置文件…')
    await writeBaseConfig(dir, options)
    progress('done', '安装完成')
    return installed
  }

  progress('meta', `正在解析 ${kind} ${mcVersion} 的下载地址…`)
  const { url, name, size, checksum } = await resolveDownloadUrl(kind, mcVersion)

  const jarPath = join(dir, name)
  progress(
    'download',
    `正在下载 ${name}${checksum ? `（下载完会核对 ${checksum.algo}）` : ''}`,
    0,
    size ?? 0
  )
  // 带上接口给的 size / 校验和：坏文件必须在这里就被拦下，
  // 而不是等用户点了启动、看到一句「Invalid or corrupt jarfile」
  await downloadWithFallback(
    [url],
    jarPath,
    (received, total) => {
      progress('download', `正在下载 ${name}`, received, total)
    },
    { size, checksum }
  )

  progress('extract', '正在写入配置文件…')
  await writeBaseConfig(dir, options)

  progress('done', '安装完成')
  return { jar: name, jarPath }
}

/**
 * 下载，主地址不通就跟备选地址。
 *
 * BungeeCord 那个官方 Jenkins 偶尔抽风，SpigotMC 的 Jenkins 上有同一个产物；
 * 两个地址都试一遍，比让用户对着「下载失败：HTTP 502」发呆强。
 */
async function downloadWithFallback(
  urls: string[],
  dest: string,
  onProgress: (received: number, total: number) => void,
  expect?: DownloadExpect
): Promise<void> {
  let lastError: unknown = null
  for (const [i, url] of urls.entries()) {
    try {
      await downloadFile(url, dest, onProgress, expect)
      return
    } catch (err) {
      lastError = err
      if (i < urls.length - 1) continue
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * 写代理端的初始配置。
 *
 * Velocity 的模板从**官方核心里取**（jar 根目录的 default-velocity.toml）：
 * 那是它第一次启动时会自己复制出来的同一份文件，`config-version` 一定对得上
 * 这个版本 —— 手写版本号写新了它会拒绝启动。取不到就用内置的兜底模板。
 *
 * 目录里已经有配置文件就不动：用户改过的配置比我们的默认值重要
 * （重新创建一台服务器时也不该覆盖已有配置）。
 */
async function writeProxyConfig(
  dir: string,
  kind: ProxyKind,
  jarPath: string,
  options: { port: number; motd: string; onlineMode: boolean }
): Promise<void> {
  const target = join(dir, proxyConfigName(kind))
  try {
    await fs.access(target)
    return
  } catch {
    /* 还没有配置文件，继续 */
  }

  let official: string | null = null
  if (kind === 'velocity') official = await readJarText(jarPath, 'default-velocity.toml')

  const text = proxyConfigText(
    { kind, port: options.port, motd: options.motd, onlineMode: options.onlineMode },
    official
  )
  await fs.writeFile(target, text, 'utf-8')
}

/** 从 jar 里读一个文本文件（代理端的官方配置模板） */
async function readJarText(jarPath: string, name: string): Promise<string | null> {
  const zip = await ZipReader.open(jarPath)
  if (!zip) return null
  try {
    const entry = zip.has(name) ? name : zip.list().find((n) => n.endsWith(`/${name}`))
    return entry ? await zip.read(entry) : null
  } catch {
    return null
  } finally {
    await zip.close()
  }
}

/**
 * 用官方安装器装 Forge / NeoForge。
 *
 * 流程：下安装器 → 跑 `--installServer`（它会联网拉一两百 MB 运行库，
 * 慢是正常的，所以输出要实时转出去）→ 找它生成的启动入口。
 * 1.17 之后没有可 -jar 的核，启动入口是一个参数文件，只能 `java @文件`。
 */
async function installWithOfficialInstaller(
  dir: string,
  kind: 'forge' | 'neoforge',
  mcVersion: string,
  options: { build?: string; javaPath?: string },
  progress: (stage: DownloadProgress['stage'], message: string, received?: number, total?: number) => void
): Promise<CreateResult> {
  const build = options.build?.trim()
  if (!build) {
    throw new Error(
      kind === 'forge'
        ? '没有指定要装的 Forge 构建号。回到上一步重新选一次版本。'
        : '没有指定要装的 NeoForge 构建号。回到上一步重新选一次版本。'
    )
  }
  const java = options.javaPath?.trim()
  if (!java) throw new Error('安装 Forge / NeoForge 需要 Java，请先在设置里配好 Java 路径')

  const file = kind === 'forge' ? forgeInstaller(mcVersion, build) : neoforgeInstaller(build)
  const installerPath = join(dir, file.name)

  progress('download', `正在下载 ${file.name}`, 0, 0)
  const expect: DownloadExpect = {}
  if (file.checksumFile) {
    const sha1 = await fetchSha1(file.checksumFile)
    if (sha1) expect.checksum = { algo: 'sha1', value: sha1 }
  }
  await downloadFile(
    file.url,
    installerPath,
    (received, total) => progress('download', `正在下载 ${file.name}`, received, total),
    expect
  )

  progress('extract', '正在运行官方安装器（要下载一两百 MB 运行库，第一次会慢）')
  let lastLine = ''
  const res = await run(java, ['-Djava.awt.headless=true', '-jar', installerPath, '--installServer', dir], {
    cwd: dir,
    timeout: 30 * 60 * 1000,
    onChunk: (text) => {
      // 安装器输出很啰嗦，只把「有新东西」的那几行转出去
      const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
      if (line && line !== lastLine) {
        lastLine = line
        progress('extract', line.slice(0, 160))
      }
    }
  })
  if (res.code !== 0) {
    const tail = `${res.stderr}\n${res.stdout}`.trim().split(/\r?\n/).slice(-4).join(' ')
    throw new Error(`安装器退出码 ${res.code}：${tail.slice(0, 400)}`)
  }

  const argsFile = await findArgsFile(dir)
  if (argsFile) {
    const rel = relative(dir, argsFile).split(sep).join('/')
    return { jar: '', jarPath: '', launchArgs: rel }
  }

  // 1.17 以前：安装器给出一个可以 -jar 的通用 jar
  const universal = await findUniversalJar(dir)
  if (universal) {
    return { jar: basename(universal), jarPath: universal }
  }

  throw new Error(
    '安装器跑完了，但既没有参数文件也没有找到可启动的 jar。' +
      '打开服务器目录看一下，或者用「导入已有服务端」把这个目录加进来。'
  )
}

/** EULA 和 server.properties：所有类型都写同一份，端口得先定下来 */
async function writeBaseConfig(
  dir: string,
  options: { motd: string; port: number; maxPlayers: number; acceptEula: boolean; onlineMode: boolean }
): Promise<void> {
  if (options.acceptEula) {
    await fs.writeFile(
      join(dir, 'eula.txt'),
      `# 由 CraftDesk 生成\neula=true\n`,
      'utf-8'
    )
  } else {
    await fs.writeFile(join(dir, 'eula.txt'), `eula=false\n`, 'utf-8')
  }

  // server.properties
  const props = [
    { key: 'motd', value: options.motd || 'A Minecraft Server' },
    { key: 'server-port', value: String(options.port) },
    { key: 'max-players', value: String(options.maxPlayers) },
    { key: 'online-mode', value: String(options.onlineMode) },
    { key: 'level-name', value: 'world' },
    { key: 'gamemode', value: 'survival' },
    { key: 'difficulty', value: 'easy' },
    { key: 'view-distance', value: '10' },
    { key: 'simulation-distance', value: '10' },
    { key: 'enable-command-block', value: 'true' },
    { key: 'spawn-protection', value: '16' }
  ]
  await fs.writeFile(
    join(dir, 'server.properties'),
    `#Minecraft server properties\n#由 CraftDesk 生成\n${serializeProperties(props)}\n`,
    'utf-8'
  )
}
