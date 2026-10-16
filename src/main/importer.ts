import { promises as fs, existsSync } from 'node:fs'
import { join, basename, extname, relative, sep } from 'node:path'
import { isProxyKind, type DetectedServer, type ServerKind } from '../shared/types'
import { findArgsFile } from './installers'
import { parsePropertiesFile } from './properties'
import { isContentDirName } from '../shared/contentDirs'
import { readMcdrConfig } from './layout'
import { readProxyMeta } from './proxy'

/** 从 jar 文件名推断服务端类型 */
export function classifyJar(fileName: string): ServerKind {
  const n = fileName.toLowerCase()
  if (n.includes('velocity')) return 'velocity'
  if (n.includes('waterfall')) return 'waterfall'
  if (n.includes('bungeecord') || n.includes('bungee')) return 'bungeecord'
  if (n.includes('purpur')) return 'purpur'
  if (n.includes('paper')) return 'paper'
  if (n.includes('spigot')) return 'spigot'
  if (n.includes('craftbukkit') || n.includes('bukkit')) return 'bukkit'
  if (n.includes('neoforge')) return 'neoforge'
  if (n.includes('forge')) return 'forge'
  if (n.includes('fabric')) return 'fabric'
  if (n.includes('minecraft_server') || n === 'server.jar' || n.includes('vanilla')) return 'vanilla'
  return 'unknown'
}

const KIND_LABEL: Record<ServerKind, string> = {
  vanilla: '原版',
  paper: 'Paper',
  purpur: 'Purpur',
  spigot: 'Spigot',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  bukkit: 'Bukkit',
  velocity: 'Velocity',
  bungeecord: 'BungeeCord',
  waterfall: 'Waterfall',
  unknown: '未知'
}

export function kindLabel(kind: ServerKind): string {
  return KIND_LABEL[kind] || '未知'
}

const KIND_COLOR: Record<ServerKind, string> = {
  vanilla: '#6b7280',
  paper: '#f59e0b',
  purpur: '#a855f7',
  spigot: '#eab308',
  fabric: '#dbb69b',
  forge: '#60a5fa',
  neoforge: '#f97316',
  bukkit: '#84cc16',
  // 代理端统一用青色，和「真正的服务端」在列表里一眼能区分开
  velocity: '#06b6d4',
  bungeecord: '#0891b2',
  waterfall: '#22d3ee',
  unknown: '#64748b'
}

export function kindColor(kind: ServerKind): string {
  return KIND_COLOR[kind] || '#64748b'
}

/**
 * jar 打分。分数最高的会被当作服务端核心。
 * 注意 Fabric 要先于 server.jar：装了 Fabric 的目录里两个 jar 都在，
 * 但真正该启动的是 fabric-server-launch.jar。
 */
function scoreJar(name: string, hasFabricMarker: boolean): number {
  const lower = name.toLowerCase()
  if (lower.includes('installer') || lower.includes('setup')) return -100
  if (lower.includes('sources') || lower.includes('javadoc')) return -80
  if (lower.includes('fabric-server-launch') || lower.includes('fabric-server-launcher')) return 120
  if (lower.includes('fabric') && hasFabricMarker) return 115
  if (lower === 'server.jar') return 100
  // 代理端核心，名字里一定带版本号，比如 velocity-3.5.0-SNAPSHOT-592.jar
  if (lower.includes('velocity')) return 95
  if (lower.includes('waterfall')) return 94
  if (lower.includes('bungeecord') || lower.includes('bungee')) return 92
  if (lower.includes('paper')) return 90
  if (lower.includes('purpur')) return 90
  if (lower.includes('neoforge')) return 88
  if (lower.includes('forge')) return 86
  if (lower.includes('spigot')) return 80
  if (lower.includes('minecraft_server')) return 76
  if (lower.startsWith('server')) return 60
  return classifyJar(name) === 'unknown' ? -50 : 40
}

/**
 * 脚本打分。中文社区里「启动 MCDR.bat」「开服.bat」很常见，
 * 只匹配 start/run 会全部漏掉。
 */
function scoreScript(name: string): number {
  const n = name.toLowerCase()
  // 安装器 / 更新器不是启动入口
  if (/install|update|setup|安装|更新|卸载|uninstall/.test(n)) return -100
  let score = 0
  if (/start|run|launch|boot/.test(n)) score += 60
  if (/启动|开服|运行|开始/.test(name)) score += 60
  // 带 [1] [2] [3] 这种序号前缀的是给用户双击的入口，通常排在前面
  if (/^\[\d+\]/.test(name)) score += 10
  if (/mcdr|mcdreforged/.test(n)) score += 15
  return score
}

/** 只读文件尾部若干字节，避免为了找版本号读整个日志 */
async function readTail(file: string, bytes = 262144): Promise<string> {
  try {
    const st = await fs.stat(file)
    if (!st.size) return ''
    const start = Math.max(0, st.size - bytes)
    const fh = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(bytes, st.size))
      await fh.read(buf, 0, buf.length, start)
      return buf.toString('utf-8')
    } finally {
      await fh.close()
    }
  } catch {
    return ''
  }
}

/** 依次尝试几种办法猜出 MC 版本 */
async function detectMcVersion(rootDir: string, coreDir: string): Promise<string> {
  const dirs = coreDir && coreDir !== rootDir ? [coreDir, rootDir] : [rootDir]

  for (const dir of dirs) {
    // 1) 从 logs/latest.log 里找
    const log = await readTail(join(dir, 'logs', 'latest.log'))
    const fromLog =
      log.match(/Starting minecraft server version\s+([0-9][^\s]*)/i) ||
      log.match(/This server is running .*?version\s+([0-9][^\s]+)/i)
    if (fromLog) return fromLog[1].replace(/[^\d.]/g, '')

    // 2) version.json（原版服务端会生成）
    for (const f of ['version.json', join('META-INF', 'version.json')]) {
      try {
        const j = JSON.parse(await fs.readFile(join(dir, f), 'utf-8'))
        const v = j.name || j.id || j.version
        if (v) return String(v)
      } catch {
        /* 下一个 */
      }
    }

    // 3) Forge / NeoForge 的 libraries 目录名，形如 1.20.1-47.2.0
    for (const lib of [
      join('libraries', 'net', 'minecraftforge', 'forge'),
      join('libraries', 'net', 'neoforged', 'neoforge')
    ]) {
      try {
        const entries = await fs.readdir(join(dir, lib))
        const m = entries[0]?.match(/^(1\.\d+(?:\.\d+)?)/)
        if (m) return m[1]
      } catch {
        /* 下一个 */
      }
    }

    // 4) Fabric 的 mods 目录里的 mod 文件名通常带版本
    try {
      const entries = await fs.readdir(join(dir, 'mods'))
      for (const e of entries) {
        const m = e.match(/(1\.\d{1,2}(?:\.\d{1,2})?)/)
        if (m) return m[1]
      }
    } catch {
      /* 忽略 */
    }

    // 5) 客户端 jar 的版本文件名，比如 versions/1.20.1/1.20.1.jar
    try {
      const entries = await fs.readdir(join(dir, 'versions'))
      for (const e of entries) {
        const m = e.match(/^(1\.\d{1,2}(?:\.\d{1,2})?)$/)
        if (m) return m[1]
      }
    } catch {
      /* 忽略 */
    }

    // 6) fabric-server-launcher.properties 里可能写着 jar 名
    try {
      const txt = await fs.readFile(join(dir, 'fabric-server-launcher.properties'), 'utf-8')
      const m = txt.match(/serverJar\s*=\s*.*?(1\.\d{1,2}(?:\.\d{1,2})?)/)
      if (m) return m[1]
    } catch {
      /* 忽略 */
    }
  }

  return ''
}

/** 统计目录大小，带时间预算，避免大世界把界面卡住 */
async function dirSize(dir: string, budgetMs = 1500): Promise<number> {
  const deadline = Date.now() + budgetMs
  let total = 0
  const stack = [dir]
  while (stack.length) {
    if (Date.now() > deadline) break
    const cur = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else {
        try {
          total += (await fs.stat(p)).size
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return total
}

const SCRIPT_EXT = ['.bat', '.sh', '.cmd']
/** 值得再往里看一眼的子目录名（MCDR / 各类面板常见布局） */
const NESTED_NAMES = new Set([
  'server',
  'core',
  'server_core',
  'mcserver',
  'minecraft',
  '服务器',
  '服务端',
  '核心',
  '服务端核心'
])

interface ScanResult {
  jars: string[]
  scripts: string[]
  markers: { fabric: boolean; forge: boolean; neoforge: boolean; paper: boolean; purpur: boolean }
}

/** 扫描一个目录本身（不递归进子目录） */
async function scanDir(rel: string, absDir: string): Promise<ScanResult> {
  const out: ScanResult = {
    jars: [],
    scripts: [],
    markers: { fabric: false, forge: false, neoforge: false, paper: false, purpur: false }
  }

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return out
  }

  const prefix = rel ? `${rel}/` : ''
  for (const e of entries) {
    if (e.isDirectory()) continue
    const ext = extname(e.name).toLowerCase()
    if (ext === '.jar') out.jars.push(prefix + e.name)
    else if (SCRIPT_EXT.includes(ext)) out.scripts.push(prefix + e.name)
  }

  // 用文件标记判断加载器，比看 jar 名字可靠
  const has = (n: string): boolean => entries.some((e) => e.name.toLowerCase() === n)
  if (has('fabric-server-launch.jar') || has('fabric-server-launcher.properties')) {
    out.markers.fabric = true
  }
  try {
    if (existsSync(join(absDir, 'libraries', 'net', 'fabricmc'))) out.markers.fabric = true
  } catch {
    /* ignore */
  }
  out.markers.forge = existsSync(join(absDir, 'libraries', 'net', 'minecraftforge'))
  out.markers.neoforge = existsSync(join(absDir, 'libraries', 'net', 'neoforged'))
  // bukkit 系会有 bukkit.yml / spigot.yml / paper 相关配置
  out.markers.paper = existsSync(join(absDir, 'bukkit.yml')) || existsSync(join(absDir, 'spigot.yml'))
  out.markers.purpur = existsSync(join(absDir, 'purpur.yml'))

  return out
}

/**
 * 扫描一个目录，尽量判断它是不是一个可用的 MC 服务端。
 * 会先看根目录，根目录没有核心 jar 时再往常见的子目录里找一层，
 * 这样 MCDReforged 这种「配置在外、服务端在 server/ 里」的布局也能识别。
 *
 * skipSize：跳过目录体积统计。体积要遍历整棵目录树，一个 12 GB 的服务器
 * 要卡好几秒 —— 批量探测候选目录、或者导入时（体积只用于预览）没必要算。
 */
export async function detectServer(
  dir: string,
  opts: { skipSize?: boolean } = {}
): Promise<DetectedServer> {
  const result: DetectedServer = {
    dir,
    name: basename(dir),
    jars: [],
    scripts: [],
    kind: 'unknown',
    mcVersion: '',
    suggestedJar: '',
    suggestedScript: '',
    suggestedArgs: '',
    preferScript: false,
    coreDir: '',
    isMcdr: false,
    eulaAccepted: false,
    hasWorld: false,
    port: null,
    motd: null,
    sizeBytes: 0
  }

  const root = await scanDir('', dir)

  /*
   * 根目录已经像个服务端了，就别再往子目录里找核心。
   *
   * Forge / NeoForge 1.17 以后是「根目录没有 jar，但有 libraries/ 和参数文件」，
   * 只看「有没有 jar」会以为这不是服务端，然后跑去子目录里认领一个装满模组的
   * mods/ 当核心 —— 模组列表就是这么空的。
   */
  const rootIsServer =
    root.jars.length > 0 ||
    root.markers.fabric ||
    root.markers.forge ||
    root.markers.neoforge ||
    root.markers.paper ||
    root.markers.purpur ||
    existsSync(join(dir, 'server.properties')) ||
    existsSync(join(dir, 'eula.txt'))

  // 根目录没有 jar 就往子目录找一层
  let coreRel = ''
  let core = root
  if (!rootIsServer) {
    let candidates: string[] = []
    try {
      candidates = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    } catch {
      return result
    }
    // 常见名字优先，其次按目录名排序，保证结果稳定
    candidates.sort((a, b) => {
      const na = NESTED_NAMES.has(a.toLowerCase()) ? 0 : 1
      const nb = NESTED_NAMES.has(b.toLowerCase()) ? 0 : 1
      if (na !== nb) return na - nb
      return a.localeCompare(b)
    })

    for (const sub of candidates) {
      // 内容目录永远不是核心：mods / plugins / config / logs……
      if (isContentDirName(sub)) continue

      const scanned = await scanDir(sub, join(dir, sub))
      if (!scanned.jars.length) continue

      /*
       * 还得看它像不像一个服务端核心：要么有加载器标记，
       * 要么最高分的那个 jar 真的是个核心（server.jar、paper-*.jar、forge-*.jar）。
       * 少了这一关，随便一个塞满 jar 的目录（整合包的 kubejs/、脚本目录）都会被认领。
       */
      const hasMarker =
        scanned.markers.fabric ||
        scanned.markers.forge ||
        scanned.markers.neoforge ||
        scanned.markers.paper ||
        scanned.markers.purpur
      const best = Math.max(
        ...scanned.jars.map((j) => scoreJar(basename(j), scanned.markers.fabric))
      )
      if (hasMarker || best >= 60) {
        coreRel = sub
        core = scanned
        break
      }
    }
  }

  result.jars = core.jars
  result.scripts = [...root.scripts, ...core.scripts]
  result.coreDir = coreRel

  /*
   * Forge / NeoForge 1.17 以后没有能 -jar 的核心：安装器把启动入口写成
   * libraries/ 下的参数文件。不找它的话，导入进来的 Forge 服只会看到
   * 一堆模组 jar，谁都点不动。
   */
  const argsAbs = await findArgsFile(join(dir, coreRel))
  result.suggestedArgs = argsAbs ? relative(dir, argsAbs).split(sep).join('/') : ''

  // ---- 类型判定：先看标记，再看 jar 名 ----
  let kind: ServerKind = 'unknown'
  if (core.markers.fabric) kind = 'fabric'
  else if (core.markers.neoforge) kind = 'neoforge'
  else if (core.markers.forge) kind = 'forge'
  else if (core.markers.purpur) kind = 'purpur'
  else if (core.markers.paper) kind = 'paper'

  const scored = core.jars
    .map((name) => ({ name, score: scoreJar(basename(name), core.markers.fabric) }))
    .sort((a, b) => b.score - a.score)

  if (kind === 'unknown' && scored[0]) {
    kind = classifyJar(basename(scored[0].name))
  }
  result.kind = kind

  // ---- 核心 jar ----
  if (kind === 'fabric') {
    const launcher = scored.find((s) => /fabric-server-launch/i.test(s.name))
    result.suggestedJar = launcher?.name ?? scored[0]?.name ?? ''
  } else {
    // 排除装了 fabric 却没有 fabric 标记时误选到的模组 jar
    const usable = scored.find((s) => s.score > 0)
    result.suggestedJar = usable?.name ?? ''
  }

  // ---- 启动脚本 ----
  const rankedScripts = result.scripts
    .map((name) => ({ name, score: scoreScript(basename(name)) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  result.suggestedScript = rankedScripts[0]?.score && rankedScripts[0].score > 0 ? rankedScripts[0].name : ''

  // 脚本在根目录、核心却在子目录，说明这是个包装层（比如 MCDR），优先用脚本启动
  result.preferScript = Boolean(
    result.suggestedScript && !result.suggestedScript.includes('/') && coreRel
  )

  // 确认外层是不是 MCDReforged，是的话插件和配置要分开对待
  if (coreRel) {
    const mcdr = await readMcdrConfig(dir)
    let hasMcdrPluginPack = false
    try {
      const entries = await fs.readdir(join(dir, 'plugins'), { withFileTypes: true })
      hasMcdrPluginPack = entries.some(
        (e) => e.isFile() && /\.(mcdr|pyz)(\.disabled)?$/i.test(e.name)
      )
    } catch {
      /* 没有 plugins 目录 */
    }
    result.isMcdr =
      mcdr.isMcdr || existsSync(join(dir, 'config', 'mcdreforged')) || hasMcdrPluginPack
  }

  const coreAbs = join(dir, coreRel)

  // ---- 代理端走另一套：没有世界、没有 EULA，配置也在自己的文件里 ----
  if (isProxyKind(result.kind)) {
    const meta = await readProxyMeta(coreAbs, result.kind)
    result.port = meta.port
    result.motd = meta.motd
    result.eulaAccepted = true // 代理端不需要同意 EULA，别在界面上报错
    result.hasWorld = false
    // 代理端没有 Minecraft 版本的概念，这里放的是代理自身的版本号
    result.mcVersion = meta.version
    if (!opts.skipSize) result.sizeBytes = await dirSize(dir)
    return result
  }

  // ---- eula / 属性 / 世界：以核心目录为准，找不到再看根目录 ----
  const eulaDirs = coreRel ? [coreAbs, dir] : [dir]
  for (const d of eulaDirs) {
    try {
      const eula = await fs.readFile(join(d, 'eula.txt'), 'utf-8')
      result.eulaAccepted = /^\s*eula\s*=\s*true/im.test(eula)
      break
    } catch {
      /* 下一个 */
    }
  }

  let props: Awaited<ReturnType<typeof parsePropertiesFile>> = []
  for (const d of eulaDirs) {
    props = await parsePropertiesFile(join(d, 'server.properties'))
    if (props.length) break
  }
  if (props.length) {
    const get = (k: string): string | undefined => props.find((p) => p.key === k)?.value
    const port = get('server-port')
    result.port = port ? Number(port) : null
    result.motd = get('motd') ?? null
    result.hasWorld = existsSync(join(coreAbs, get('level-name') || 'world', 'level.dat'))
  } else {
    result.hasWorld = existsSync(join(coreAbs, 'world', 'level.dat'))
  }

  result.mcVersion = await detectMcVersion(dir, coreAbs)
  if (!opts.skipSize) result.sizeBytes = await dirSize(dir)

  return result
}
