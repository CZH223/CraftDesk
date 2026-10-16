import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './java'
import { UTF8_CONSOLE_FLAGS } from '../shared/jvmArgs'
import type { ServerKind } from '../shared/types'

/**
 * 把一台服务端安进 MCDReforged 里。
 *
 * MCDReforged 是套在外面的包装层：它自己是个 Python 程序，服务端核心放在
 * `server/` 子目录，根目录只放它自己的配置和插件。所以「用 MCDR 建服」=
 *   1. 核心装进 <服务器目录>/server/
 *   2. 根目录写一份 config.yml，告诉 MCDR 用什么命令起服务端
 *   3. 写一个启动脚本（python -X utf8 -m mcdreforged）
 *
 * config.yml 的字段照抄一份能跑的实例（用户机器上那台 生存服 就是），
 * 尤其是 handler：MCDR 靠它解析服务端的输出，选错了玩家进服/聊天都认不出来。
 */

/** 各核心类型对应的 MCDR 处理器 */
const HANDLERS: Partial<Record<ServerKind, (mcVersion: string) => string>> = {
  vanilla: () => 'vanilla_handler',
  fabric: () => 'vanilla_handler',
  paper: (v) => (needsBukkit14(v) ? 'bukkit14_handler' : 'bukkit_handler'),
  purpur: (v) => (needsBukkit14(v) ? 'bukkit14_handler' : 'bukkit_handler'),
  spigot: (v) => (needsBukkit14(v) ? 'bukkit14_handler' : 'bukkit_handler'),
  bukkit: (v) => (needsBukkit14(v) ? 'bukkit14_handler' : 'bukkit_handler'),
  forge: () => 'forge_handler',
  neoforge: () => 'forge_handler',
  bungeecord: () => 'bungeecord_handler',
  waterfall: () => 'waterfall_handler',
  velocity: () => 'velocity_handler'
}

function needsBukkit14(mcVersion: string): boolean {
  const m = mcVersion.match(/^1\.(\d+)/)
  if (m) return Number(m[1]) >= 14
  const modern = mcVersion.match(/^(\d+)/)
  return modern ? Number(modern[1]) >= 26 : true
}

export function handlerFor(kind: ServerKind, mcVersion: string): string {
  return HANDLERS[kind]?.(mcVersion) ?? 'vanilla_handler'
}

export interface McdrSetup {
  /** MCDR 根目录 */
  root: string
  /** 核心所在的子目录名（相对根目录） */
  coreDir: string
  /** 核心 jar 相对 coreDir 的文件名 */
  jar: string
  /** Forge / NeoForge 的参数文件，相对 coreDir。有它就按 `java @文件` 启动 */
  launchArgs?: string
  kind: ServerKind
  mcVersion: string
  memoryMin: number
  memoryMax: number
  /** 跑 MCDR 的 python.exe */
  pythonPath: string
  /** 代理端不接受 nogui */
  isProxy: boolean
}

/** 拼出 MCDR 要执行的那行启动命令 */
function buildStartCommand(setup: McdrSetup): string {
  const tail = setup.isProxy ? '' : ' nogui'
  // Forge / NeoForge 1.17+ 没有可 -jar 的核心，参数在参数文件里
  const target = setup.launchArgs
    ? `@${setup.launchArgs}${tail}`
    : `-jar${setup.jar ? ` ${setup.jar}` : ''}${tail}`
  return [
    // 编码参数不能省：MCDR 按 UTF-8 解服务端的输出，Java 默认用系统编码（GBK），
    // 目录名里有中文时它会直接抛 UnicodeDecodeError 把那行输出丢掉
    `java ${UTF8_CONSOLE_FLAGS.join(' ')} -Xms${setup.memoryMin}M -Xmx${setup.memoryMax}M`,
    target
  ].join(' ')
}

/** 兜底用的最小配置：init 没跑成（或者版本太老不认识 init）时写这份 */
function fallbackConfig(setup: McdrSetup, startCommand: string): string {
  return `# 由 CraftDesk 生成
# 启动命令。不要删掉 -Dfile.encoding=UTF-8，否则中文输出会乱码。
# 注意：CraftDesk 里改内存不会同步到这里，MCDR 用的是这一行命令。
start_command: |-
  ${startCommand}

# 处理器，用于解析服务端的标准输出以及服务器控制的正确命令
# vanilla_handler  -> Vanilla / Fabric / Carpet
# bukkit14_handler -> 1.14 及以上的 Bukkit / Spigot / Paper 系
# bukkit_handler   -> 1.14 以下的 Bukkit 系
# forge_handler    -> Forge / NeoForge
# velocity_handler / bungeecord_handler / waterfall_handler -> 各类代理端
handler: ${handlerFor(setup.kind, setup.mcVersion)}

# 插件目录（相对本目录）
plugin_directories:
- plugins

# RCON 设置
rcon:
  enable: false
  address: 127.0.0.1
  port: 25575
  password: password

language: zh_cn
# 服务端核心所在目录，MCDR 会切进去再执行上面的启动命令
working_directory: ${setup.coreDir}
encoding: utf8
decoding: utf8
check_update: true
# 简易控制台。CraftDesk 是从界面进程里把它拉起来的，这个进程没有 Windows
# 控制台，prompt_toolkit 那套高级控制台会一路报 NoConsoleScreenBufferError；
# 换成简易控制台照样能收 CraftDesk 通过 stdin 发过去的命令。
advanced_console: false
disable_console_thread: false
disable_console_color: false
custom_handlers:
custom_info_reactors:
watchdog_threshold: 10
debug:
  all: false
  mcdr: false
  handler: false
  reactor: false
  plugin: false
  permission: false
  command: false
  task_executor: false
  telemetry: false
  process: false
`
}

/**
 * 写 config.yml。
 *
 * 优先「改」而不是「换」：目录里已经有一份 MCDR 自己的模板时（init 生成的），
 * 只动我们关心的四个键，其余保留。这样配置项跟着用户装的 MCDR 版本走——
 * 整份替换成我们手写的那份，新版本每加一个选项启动时就会刷一排
 * "Option 'xxx' missing, use default value" 的警告。
 */
export async function writeMcdrConfig(setup: McdrSetup): Promise<string> {
  const path = join(setup.root, 'config.yml')
  const startCommand = buildStartCommand(setup)

  let existing = ''
  try {
    existing = await fs.readFile(path, 'utf-8')
  } catch {
    /* 还没有，写一份新的 */
  }

  if (existing && !existing.includes('由 CraftDesk 生成')) {
    const patched = patchOfficialConfig(existing, setup, startCommand)
    if (patched) {
      await fs.writeFile(path, patched, 'utf-8')
      return path
    }
  }

  await fs.writeFile(path, fallbackConfig(setup, startCommand), 'utf-8')
  return path
}

/** 在官方模板上改四个键；有一个对不上就返回 null，交给兜底模板 */
function patchOfficialConfig(text: string, setup: McdrSetup, startCommand: string): string | null {
  const setKey = (src: string, key: string, value: string): string | null => {
    const re = new RegExp(`^${key}:.*$`, 'm')
    if (!re.test(src)) return null
    return src.replace(re, `${key}: ${value}`)
  }

  let out = text
  // start_command 要用块标量：命令里带空格，直接写一行会被 YAML 当纯量读掉
  if (!/^start_command:.*$/m.test(out)) return null
  out = out.replace(/^start_command:.*$/m, `start_command: |-\n  ${startCommand}`)

  const handler = setKey(out, 'handler', handlerFor(setup.kind, setup.mcVersion))
  if (!handler) return null
  out = handler

  const wd = setKey(out, 'working_directory', setup.coreDir || 'server')
  if (!wd) return null
  out = wd

  const lang = setKey(out, 'language', 'zh_cn')
  if (lang) out = lang

  const adv = setKey(out, 'advanced_console', 'false')
  if (adv) out = adv

  return out.replace(/^/, `# 由 CraftDesk 生成：启动命令与处理器会随服务器的设置更新\n`)
}

/**
 * 初始化 MCDR 的运行环境。
 *
 * 这一步不能省：MCDR 启动时会检查 permission.yml，缺了就直接退出，
 * 界面上只会看到一句「启动失败」，日志里写的是
 * "Permission file 'permission.yml' is missing / Looks like MCDR is not
 * initialized at current directory"。官方给了 `mcdreforged init` 干这件事，
 * 那就用它——生成的 permission.yml 跟着用户装的 MCDR 版本走，比自己抄一份可靠。
 */
export async function initMcdrEnvironment(root: string, pythonPath: string): Promise<void> {
  const res = await run(pythonPath, ['-X', 'utf8', '-m', 'mcdreforged', 'init'], {
    cwd: root,
    timeout: 2 * 60 * 1000
  })
  const hasPermission = existsSync(join(root, 'permission.yml'))
  if (res.code === 0 && hasPermission) return

  // 退路：init 跑不动（老版本没有这个子命令、或者输出被什么东西吃了），
  // 至少把 MCDR 必需的文件补齐，剩下的交给它自己去补默认值
  await prepareMcdrDirs(root)
  await fs.writeFile(join(root, 'permission.yml'), PERMISSION_TEMPLATE, 'utf-8')
}

const PERMISSION_TEMPLATE = `# This is the permission config and storage file of MCDReforged
# It is used to storage permission level stuffs of MCDR
# See the document https://docs.mcdreforged.com/en/latest/permission.html for more details
#
# Available levels (top to down):
# - owner
# - admin
# - helper
# - user
# - guest


default_level: user

owner:
admin:
helper:
user:
guest:
`

/**
 * 写启动脚本。
 *
 * 内容只用 ASCII：cmd 按当前代码页解析 .bat，中文注释会变乱码把命令吃掉。
 * 和 CraftDesk 生成的那种 start.bat 一样，双击就能在窗口里看到 MCDR 的输出。
 */
export async function writeMcdrStartScript(setup: McdrSetup): Promise<string> {
  const win = process.platform === 'win32'
  const file = win ? 'start.bat' : 'start.sh'
  const cmd = `"${setup.pythonPath}" -X utf8 -m mcdreforged`
  const lines = win
    ? [
        '@echo off',
        'rem Generated by CraftDesk. Starts MCDReforged in this folder.',
        'chcp 65001 >nul',
        'cd /d "%~dp0"',
        cmd,
        'echo.',
        'echo MCDReforged exited with code %ERRORLEVEL%.',
        'pause'
      ]
    : [
        '#!/bin/sh',
        '# Generated by CraftDesk. Starts MCDReforged in this folder.',
        'cd "$(dirname "$0")" || exit 1',
        cmd.replace(/^"|"$/g, ''),
        'echo "MCDReforged exited with code $?"'
      ]
  const path = join(setup.root, file)
  await fs.writeFile(path, lines.join(win ? '\r\n' : '\n') + '\n', 'utf-8')
  if (!win) await fs.chmod(path, 0o755).catch(() => undefined)
  return file
}

/** MCDR 要的目录：插件目录和配置目录，先建出来省得面板显示「没有」 */
export async function prepareMcdrDirs(root: string): Promise<void> {
  for (const rel of ['plugins', 'config']) {
    await fs.mkdir(join(root, rel), { recursive: true })
  }
}
