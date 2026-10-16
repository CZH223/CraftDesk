import { promises as fs, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { isProxyKind, type ServerConfig } from '../shared/types'
import { findProxyConfigFile, readProxyMeta } from './proxy'
import { parsePropertiesFile } from './properties'
import { isContentDirName } from '../shared/contentDirs'

/**
 * 服务器的实际目录布局。
 *
 * 一个「服务器」目录未必就是 Minecraft 服务端所在的地方：
 * MCDReforged 之类的包装层会把服务端放在 server/ 子目录里，
 * 根目录只放包装层自己的配置和插件。server.properties、ops.json、
 * mods/、config/ 全都在子目录里，找错地方就会什么都读不到。
 */
export interface ServerLayout {
  /** 服务器根目录（绝对路径），也是备份的起点 */
  root: string
  /** MC 服务端核心目录（绝对路径） */
  core: string
  /** 核心目录相对 root 的路径，空表示就是 root */
  coreRel: string
  /** 是否由 MCDReforged 托管 */
  isMcdr: boolean
  /** MCDR 从 config.yml 里读到的启动命令，用于提示内存设置不会生效 */
  mcdrStartCommand: string | null
  /** MCDR 的 Python 插件目录 */
  mcdrPluginsDir: string | null
  /** MCDR 的配置目录（根目录下的 config/） */
  mcdrConfigDir: string | null
  /** MCDR 主配置 config.yml */
  mcdrConfigFile: string | null
  /** 服务端插件的 plugins/（Bukkit 系） */
  mcPluginsDir: string | null
  /** 模组的 mods/ */
  modsDir: string | null
  /** 模组与服务端的 config/ */
  configDir: string | null
  /** server.properties 的绝对路径 */
  serverProperties: string
  /** ops.json / whitelist.json 等所在的目录 */
  playersDir: string
  /** 是否是代理端（Velocity / BungeeCord / Waterfall） */
  isProxy: boolean
  /** 代理端的配置文件：velocity.toml / config.yml */
  proxyConfigFile: string | null
  /** 配置里声明的监听端口，运行时的真实端口以日志为准 */
  configuredPort: number | null
}

/** 相对 root 的路径，统一用 / 分隔 */
function rel(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name
}

/** 目录里是否存在指定扩展名的文件 */
async function hasFileWithExt(dir: string, exts: string[]): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.some((e) => {
      if (!e.isFile()) return false
      const lower = e.name.toLowerCase().replace(/\.disabled$/, '')
      return exts.some((x) => lower.endsWith(x))
    })
  } catch {
    return false
  }
}

/**
 * 判断根目录是不是一个 MCDReforged 实例，并读出它的启动命令与插件目录。
 * config.yml 这个名字太通用了，必须靠 MCDR 特有的键来确认身份。
 */
export async function readMcdrConfig(root: string): Promise<{
  isMcdr: boolean
  startCommand: string | null
  pluginDirs: string[]
}> {
  const file = join(root, 'config.yml')
  let text = ''
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch {
    return { isMcdr: false, startCommand: null, pluginDirs: [] }
  }

  // config.yml 到处都有，必须靠 MCDR 特有的键来确认身份
  const isMcdr =
    /^\s*plugin_directories\s*:/m.test(text) ||
    /^\s*handler\s*:/m.test(text) ||
    /^\s*start_command\s*:/m.test(text) ||
    /mcdreforged/i.test(text)

  // start_command: |-  换行后跟真正的命令
  let startCommand: string | null = null
  const block = text.match(/^\s*start_command\s*:\s*[|>]-?\s*\n((?:[ \t]+.*\n?)+)/m)
  if (block) {
    startCommand = block[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
  } else {
    const inline = text.match(/^\s*start_command\s*:\s*(.+)$/m)
    if (inline) startCommand = inline[1].trim().replace(/^["']|["']$/g, '')
  }

  const pluginDirs: string[] = []
  const listBlock = text.match(/^\s*plugin_directories\s*:\s*\n((?:[ \t]*-.*\n?)+)/m)
  if (listBlock) {
    for (const line of listBlock[1].split('\n')) {
      const m = line.match(/^\s*-\s*(.+?)\s*$/)
      if (m) pluginDirs.push(m[1].replace(/^["']|["']$/g, ''))
    }
  }
  if (!pluginDirs.length) pluginDirs.push('plugins')

  return { isMcdr, startCommand, pluginDirs }
}

/** 从启动命令里挑出 -Xms / -Xmx，用于界面提示 */
export function parseMemoryFromCommand(cmd: string): { min: number | null; max: number | null } {
  const toMb = (raw: string): number | null => {
    const m = raw.match(/^(\d+)([kKmMgG]?)$/)
    if (!m) return null
    const n = Number(m[1])
    switch (m[2].toLowerCase()) {
      case 'k':
        return Math.round(n / 1024)
      case 'g':
        return n * 1024
      default:
        return n
    }
  }
  const min = cmd.match(/-Xms(\S+)/)?.[1]
  const max = cmd.match(/-Xmx(\S+)/)?.[1]
  return { min: min ? toMb(min) : null, max: max ? toMb(max) : null }
}

/**
 * 解析服务器布局。cfg.coreDir 有值时直接采用，
 * 否则自动探测（优先找含 server.properties 或核心 jar 的目录）。
 */
export async function resolveLayout(cfg: ServerConfig): Promise<ServerLayout> {
  const root = cfg.dir

  /*
   * 配置里的 coreDir 有可能是历史遗留的错误值。
   *
   * 曾经有过这么一版识别逻辑：根目录没有 jar 就认领第一个「有 jar 的子目录」。
   * Forge / NeoForge 1.17+ 的服根目录本来就没有 jar，于是 mods/ 被当成了核心目录
   * —— 后果是 mods/ 变成「核心目录下的 mods」，模组一个都读不到。
   * 这种值一定不对（内容目录不可能是核心），直接忽略、走下面的自动探测，
   * 用户不用为了修一个已导入的服务器重新导入一遍。
   */
  const stored = cfg.coreDir || ''
  let coreRel = stored && !isContentDirName(stored) ? stored : ''

  if (!coreRel) {
    // 根目录有 server.properties 就认为核心在根目录
    const rootHasProps = existsSync(join(root, 'server.properties'))
    if (!rootHasProps) {
      // 否则找一层子目录，看谁更像服务端核心
      try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith('.')) continue
          const sub = join(root, e.name)
          if (
            existsSync(join(sub, 'server.properties')) ||
            existsSync(join(sub, 'fabric-server-launch.jar')) ||
            existsSync(join(sub, 'eula.txt'))
          ) {
            coreRel = e.name
            break
          }
        }
      } catch {
        /* 忽略，退回根目录 */
      }
    }
  }

  const core = coreRel ? join(root, coreRel) : root

  const mcdrCfg = await readMcdrConfig(root)
  // 根目录 plugins/ 里是 Python 插件包，也说明这是 MCDR
  const rootPlugins = join(root, 'plugins')
  const hasMcdrPlugins =
    (await hasFileWithExt(rootPlugins, ['.mcdr', '.pyz'])) ||
    existsSync(join(root, 'config', 'mcdreforged'))

  const isMcdr = coreRel !== '' && (mcdrCfg.isMcdr || hasMcdrPlugins)

  const exists = (p: string): boolean => existsSync(p)

  // MCDR 的插件目录以 config.yml 的 plugin_directories 为准
  let mcdrPluginsDir: string | null = null
  if (isMcdr) {
    for (const d of mcdrCfg.pluginDirs) {
      if (exists(join(root, d))) {
        mcdrPluginsDir = join(root, d)
        break
      }
    }
  }

  const mcdrConfigDir = isMcdr && exists(join(root, 'config')) ? join(root, 'config') : null
  const mcdrConfigFile = isMcdr && exists(join(root, 'config.yml')) ? join(root, 'config.yml') : null

  // 服务端插件的 plugins/ 在核心目录下；根目录那个已经归 MCDR 了
  const candidatePlugins = join(core, 'plugins')
  const mcPluginsDir =
    exists(candidatePlugins) && (await hasFileWithExt(candidatePlugins, ['.jar']))
      ? candidatePlugins
      : null

  const candidateMods = join(core, 'mods')
  const modsDir = exists(candidateMods) ? candidateMods : null

  const candidateConfig = join(core, 'config')
  const configDir = exists(candidateConfig) ? candidateConfig : null

  // 代理端（Velocity / BungeeCord / Waterfall）完全不同的配置体系
  const proxy = isProxyKind(cfg.kind)
  const proxyConfigFile = proxy ? await findProxyConfigFile(core, cfg.kind) : null
  const proxyMeta = proxy ? await readProxyMeta(core, cfg.kind) : null

  return {
    root,
    core,
    coreRel,
    isMcdr,
    mcdrStartCommand: isMcdr ? mcdrCfg.startCommand : null,
    mcdrPluginsDir,
    mcdrConfigDir,
    mcdrConfigFile,
    mcPluginsDir,
    modsDir,
    configDir,
    serverProperties: join(core, 'server.properties'),
    playersDir: core,
    isProxy: proxy,
    proxyConfigFile,
    configuredPort: proxyMeta?.port ?? null
  }
}

/**
 * 服务器实际占用的端口。
 * 服务端读 server.properties，代理端读 velocity.toml / config.yml。
 */
export async function resolveServerPort(cfg: ServerConfig): Promise<number | null> {
  const layout = await resolveLayout(cfg)
  if (layout.isProxy) return layout.configuredPort
  const props = await parsePropertiesFile(layout.serverProperties)
  const raw = props.find((p) => p.key === 'server-port')?.value
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : layout.configuredPort
}

/** 把绝对路径转成相对 root 的 / 分隔路径 */
export function toRootRel(layout: ServerLayout, abs: string): string {
  const root = layout.root.replace(/\\/g, '/').replace(/\/$/, '')
  const full = abs.replace(/\\/g, '/')
  if (full === root) return ''
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : abs
}

export { dirname }
