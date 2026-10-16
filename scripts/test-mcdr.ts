/**
 * 验证 MCDReforged 这一层。
 *
 * 建一台 MCDR 托管的服务器要走四步：核心装进 server/ → `mcdreforged init`
 * 铺环境 → 把 config.yml 改成这一台该有的样子 → 用 python -m mcdreforged 启动。
 * 每一步都有一个「看起来对、跑起来不对」的坑，所以这里真的把它跑起来：
 *
 * - handler 选错：玩家进服、聊天 MCDR 全认不出来
 * - 忘了 init：MCDR 启动时找不到 permission.yml 就直接退出，
 *   界面上只会看到一句「启动失败」，看不出为什么
 * - 整份替换 config.yml：新版 MCDR 每加一个选项就刷一排 missing 警告
 * - 管道方式启动：MCDR 的高级控制台要真控制台，没有就报 NoConsoleScreenBufferError
 *
 * npx esbuild scripts/test-mcdr.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-mcdr.cjs && node tmp/test-mcdr.cjs
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import {
  handlerFor,
  initMcdrEnvironment,
  prepareMcdrDirs,
  writeMcdrConfig,
  writeMcdrStartScript
} from '../src/main/mcdr'
import { detectPython, mcdrReady, probePython } from '../src/main/python'
import { resolveLayout } from '../src/main/layout'
import type { ServerConfig, ServerKind } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

/**
 * 自己拼一份配置，不走 store —— store 会拉进 electron，
 * 而这里跑的是普通 node，拿不到 electron 的运行时。
 */
function serverConfig(patch: Partial<ServerConfig>): ServerConfig {
  return {
    id: 'test',
    name: '测试',
    dir: '',
    jar: '',
    startScript: '',
    launchArgs: '',
    pythonPath: '',
    javaPath: '',
    memoryMin: 1024,
    memoryMax: 4096,
    jvmArgs: '',
    serverArgs: 'nogui',
    kind: 'unknown',
    mcVersion: '',
    coreDir: '',
    mcdr: false,
    pluginsDir: '',
    modsDir: '',
    autoRestart: false,
    createdAt: 0,
    lastStartedAt: 0,
    totalUptime: 0,
    color: '',
    icon: '',
    note: '',
    order: 0,
    ...patch
  }
}

/** MCDR 会往配置里补选项、把文件重写成 \r\n，比较之前统一一下换行 */
function lines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** 找一行形如 `key: value` 的配置，返回整行（找不到返回空串） */
function match(text: string, re: RegExp): string {
  return lines(text).find((l) => re.test(l)) ?? ''
}

function blockAfter(text: string, key: string): string {
  const all = lines(text)
  const i = all.findIndex((l) => l.startsWith(`${key}:`))
  return i >= 0 ? (all[i + 1] ?? '') : ''
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  console.log('══ handler 选择（选错了 MCDR 就不认服务端的输出）══')
  const cases: [ServerKind, string, string][] = [
    ['vanilla', '1.20.1', 'vanilla_handler'],
    ['fabric', '1.21.1', 'vanilla_handler'],
    ['paper', '1.20.1', 'bukkit14_handler'],
    ['paper', '1.12.2', 'bukkit_handler'],
    ['purpur', '1.21', 'bukkit14_handler'],
    ['forge', '1.20.1', 'forge_handler'],
    ['neoforge', '1.21.1', 'forge_handler'],
    ['velocity', '3.3.0', 'velocity_handler'],
    ['bungeecord', '1.20', 'bungeecord_handler']
  ]
  for (const [kind, mc, want] of cases) {
    check(`${kind} ${mc} → ${want}`, handlerFor(kind, mc) === want, handlerFor(kind, mc))
  }

  // ---------------------------------------------------------------- 兜底模板
  console.log('\n══ 目录里没有 MCDR 模板时：写兜底那份 ══')
  const plain = resolve('tmp', 'mcdr-fallback')
  await fs.rm(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  await fs.mkdir(join(plain, 'server'), { recursive: true })
  await writeMcdrConfig({
    root: plain,
    coreDir: 'server',
    // Forge / NeoForge 那种没有可 -jar 核心、只有参数文件的情况
    jar: '',
    launchArgs: 'libraries/net/neoforged/neoforge/21.1.252/win_args.txt',
    kind: 'neoforge' as ServerKind,
    mcVersion: '1.21.1',
    memoryMin: 2048,
    memoryMax: 2048,
    pythonPath: 'C:\\Python313\\python.exe',
    isProxy: false
  })
  const fb = await fs.readFile(join(plain, 'config.yml'), 'utf-8')
  check('写到了根目录的 config.yml', fb.includes('由 CraftDesk 生成'))
  check('handler 是 forge_handler', match(fb, /^handler: forge_handler$/) !== '')
  check('working_directory 指向 server', match(fb, /^working_directory: server$/) !== '')
  check(
    '启动命令带内存与 UTF-8 编码',
    fb.includes('-Xms2048M') && fb.includes('-Xmx2048M') && fb.includes('-Dfile.encoding=UTF-8')
  )
  // MCDR 按 UTF-8 解服务端的输出，而 Java 默认按系统编码写。
  // 目录名里有中文时（Java 打印 classpath 会带上它），差的这两行就是一个
  // UnicodeDecodeError，MCDR 会把那行输出直接丢掉。
  check(
    '启动命令让 JVM 用 UTF-8 写标准输出',
    fb.includes('-Dstdout.encoding=UTF-8') && fb.includes('-Dstderr.encoding=UTF-8')
  )
  check('没有核心 jar 时用 @参数文件 启动', /^\s+java .*@libraries\/.* nogui$/m.test(fb))
  check('中文界面（language: zh_cn）', match(fb, /^language: zh_cn$/) !== '')
  check('用简易控制台（管道启动时高级控制台会报错）', match(fb, /^advanced_console: false$/) !== '')

  // ---------------------------------------------------------------- 真实流程
  const root = resolve('tmp', 'mcdr-layout')
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  await fs.mkdir(join(root, 'server'), { recursive: true })
  await fs.writeFile(join(root, 'server', 'server.jar'), 'not a real jar')

  const setup = {
    root,
    coreDir: 'server',
    jar: 'server.jar',
    kind: 'fabric' as ServerKind,
    mcVersion: '1.21.1',
    memoryMin: 2048,
    memoryMax: 2048,
    pythonPath: 'C:\\Python313\\python.exe',
    isProxy: false
  }

  console.log('\n══ 这台机器上的 Python 与 MCDReforged ══')
  const pythons = await detectPython()
  check('找到了 Python', pythons.length > 0, `${pythons.length} 个`)
  for (const p of pythons.slice(0, 6)) {
    console.log(
      `     ${p.suitable ? '可用' : '版本过低'}  Python ${p.version}` +
        `  mcdreforged: ${p.mcdr ?? '未安装'}  ${p.path}`
    )
  }
  const ready = pythons.find((p) => p.suitable && p.mcdr)
  check('至少有一个能直接跑 MCDReforged 的 Python', Boolean(ready))

  if (ready) {
    const again = await probePython(ready.path)
    check('probePython 单独问同一个解释器结果一致', again?.mcdr === ready.mcdr, `${again?.mcdr}`)
    check('mcdrReady 判定为可用', mcdrReady(again).ok === true)
  }
  // 没有 Python 时不能崩，要给出理由——界面上就是靠这句话告诉用户去装
  check('没找到 Python 时 mcdrReady 给出原因', Boolean(mcdrReady(null).reason), mcdrReady(null).reason)
  check(
    'Python 版本过低时也给出原因',
    Boolean(
      mcdrReady({
        path: 'x',
        version: '3.7.9',
        major: 3,
        minor: 7,
        mcdr: '2.0',
        suitable: false,
        valid: true
      }).reason
    )
  )

  console.log('\n══ 初始化 MCDR 环境（mcdreforged init）══')
  check('init 之前没有 permission.yml', !(await exists(join(root, 'permission.yml'))))
  if (ready) {
    await initMcdrEnvironment(root, ready.path)
    check('init 生成了 permission.yml', await exists(join(root, 'permission.yml')))
    const perm = await fs.readFile(join(root, 'permission.yml'), 'utf-8')
    check('permission.yml 里有 MCDR 认的 default_level', /default_level:\s*\w+/.test(perm))
    check(
      'init 生成了 config/ 与 plugins/',
      (await exists(join(root, 'config'))) && (await exists(join(root, 'plugins')))
    )
  }

  console.log('\n══ 在官方模板上改，而不是整份替换 ══')
  const official = await fs.readFile(join(root, 'config.yml'), 'utf-8')
  check('官方模板在（init 留下的）', official.includes('The configuration file for MCDReforged'))
  await writeMcdrConfig(setup)
  const patched = await fs.readFile(join(root, 'config.yml'), 'utf-8')
  check('加上 CraftDesk 的标记', patched.includes('由 CraftDesk 生成'))
  check('模板原有的选项都还在', patched.includes('handler_detection'))
  check('启动命令换成了这一台的', patched.includes('-jar server.jar nogui'))
  check('默认那句 echo Hello world 没了', !patched.includes('echo Hello world'))
  check('handler 改成 vanilla_handler', match(patched, /^handler: vanilla_handler$/) !== '')
  check('working_directory 指向 server', match(patched, /^working_directory: server$/) !== '')
  check('界面语言改成中文', match(patched, /^language: zh_cn$/) !== '')
  check('控制台改成简易的', match(patched, /^advanced_console: false$/) !== '')
  check(
    'start_command 写成块标量（命令里的空格不会被 YAML 吃掉）',
    /^start_command: \|-/.test(match(patched, /^start_command: \|-/)) &&
      blockAfter(patched, 'start_command').startsWith('  java ')
  )

  // Forge / NeoForge 没有可 -jar 的核心，得换成参数文件
  await writeMcdrConfig({
    ...setup,
    kind: 'neoforge' as ServerKind,
    jar: '',
    launchArgs: 'libraries/net/neoforged/neoforge/21.1.252/win_args.txt'
  })
  const forgeCfg = await fs.readFile(join(root, 'config.yml'), 'utf-8')
  check(
    'Forge 改成 @参数文件 启动',
    forgeCfg.includes('@libraries/net/neoforged/neoforge/21.1.252/win_args.txt')
  )
  check('Forge 的 handler 是 forge_handler', match(forgeCfg, /^handler: forge_handler$/) !== '')
  await writeMcdrConfig(setup) // 换回 fabric 那份，后面的布局检查用

  console.log('\n══ 启动脚本与目录 ══')
  const script = await writeMcdrStartScript(setup)
  const scriptBody = await fs.readFile(join(root, script), 'utf-8')
  check('生成了 start.bat', script === 'start.bat')
  check('内容是纯 ASCII（cmd 不会吃乱码）', /^[\x20-\x7e\r\n]*$/.test(scriptBody))
  check('用 -X utf8 跑 mcdreforged', scriptBody.includes('-X utf8 -m mcdreforged'))
  check('用 %~dp0 切到脚本所在目录', scriptBody.includes('cd /d "%~dp0"'))

  const other = resolve('tmp', 'mcdr-dirs')
  await fs.rm(other, { recursive: true, force: true })
  await fs.mkdir(other, { recursive: true })
  await prepareMcdrDirs(other)
  check(
    'prepareMcdrDirs 建好了 plugins/ 与 config/',
    (await exists(join(other, 'plugins'))) && (await exists(join(other, 'config')))
  )

  console.log('\n══ CraftDesk 认得这个布局吗 ══')
  const cfgServer = serverConfig({
    name: '测试 MCDR 服',
    dir: root,
    coreDir: 'server',
    mcdr: true,
    jar: 'server/server.jar',
    kind: 'fabric'
  })
  const layout = await resolveLayout(cfgServer)
  check('认出了 MCDR', layout.isMcdr)
  check('核心在 server/ 子目录', layout.coreRel === 'server', layout.coreRel)
  check(
    'server.properties 指向 server/ 里',
    layout.serverProperties === join(root, 'server', 'server.properties')
  )
  check('ops.json 等也在 server/ 里', layout.playersDir === join(root, 'server'))
  check('MCDR 插件目录是根目录的 plugins/', layout.mcdrPluginsDir === join(root, 'plugins'))
  check(
    '读得到 config.yml 里的启动命令',
    (layout.mcdrStartCommand ?? '').includes('server.jar'),
    layout.mcdrStartCommand ?? '(读不到)'
  )

  if (!ready) {
    console.log(`\n通过 ${pass}，失败 ${fail}`)
    console.log('（这台机器上没有现成的 MCDReforged，跳过实际启动）')
    process.exit(fail ? 1 : 0)
  }

  /*
   * 最后一步：真的把它跑起来。
   *
   * 「文件里写了什么」全对不代表能跑：permission.yml 缺失、控制台初始化失败、
   * 启动命令解析不对，都只有真的启动一次才看得出来。服务端这边用一个假的
   * Python 脚本顶替（打印 vanilla 认得出的 Done，然后一直活着），
   * 这样不用下几十 MB 就能验证 MCDR 与 CraftDesk 的整套交互。
   */
  console.log('\n══ 真的用这份 config.yml 把 MCDR 跑起来 ══')
  const fake = [
    'import time',
    'print("Done (1.234s)! For help, type \\"help\\"", flush=True)',
    'time.sleep(600)'
  ].join('\n')
  await fs.writeFile(join(root, 'server', 'fake_server.py'), fake, 'utf-8')
  const cfgPath = join(root, 'config.yml')
  const cfgText = await fs.readFile(cfgPath, 'utf-8')
  await fs.writeFile(cfgPath, cfgText.replace(/^ {2}java .*$/m, `  ${ready.path} -X utf8 fake_server.py`), 'utf-8')

  const booted = await runMcdr(ready.path, root, 25000)
  check('MCDR 一直活着（没有自己退出）', booted.alive, `${Math.round(booted.ms / 1000)} 秒后仍在运行`)
  check(
    '没有「未初始化」或配置解析异常',
    !/not initialized|Traceback|Failed to load config/i.test(booted.output)
  )
  check('它按我们的配置拉起了服务端', /Done \(1\.234s\)/.test(booted.output))
  check('认下了 handler（日志里有处理器信息）', /vanilla_handler/.test(booted.output))
  check('从 stdin 发过去的命令它收到了', /MCDR 状态|MCDR status|服务端状态/.test(booted.output))

  console.log('     输出摘录：')
  for (const line of booted.output.split(/\r?\n/).filter(Boolean).slice(-14)) {
    console.log(`     ${stripAnsi(line).slice(0, 110)}`)
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  console.log(`测试目录：${root}`)
  process.exit(fail ? 1 : 0)
}

/**
 * 把 MCDR 用「和 CraftDesk 一样的方式」拉起来：管道接 stdout / stderr，
 * 命令从 stdin 喂进去。跑一段之后看它还活着没、有没有收到命令。
 */
async function runMcdr(
  python: string,
  cwd: string,
  ms: number
): Promise<{ output: string; alive: boolean; ms: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn(python, ['-X', 'utf8', '-m', 'mcdreforged'], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let output = ''
    let exited = false
    const started = Date.now()
    child.stdout?.on('data', (d) => (output += d.toString('utf-8')))
    child.stderr?.on('data', (d) => (output += d.toString('utf-8')))
    child.on('exit', () => (exited = true))
    child.on('error', (err) => (output += `\n${String(err)}`))

    // 等服务端起来之后再从 stdin 发一条命令（这就是控制台面板做的事）
    setTimeout(() => {
      try {
        child.stdin?.write('!!MCDR status\n')
      } catch {
        /* 已经退出了 */
      }
    }, Math.round(ms * 0.6))

    setTimeout(() => {
      const alive = !exited
      // 杀整棵进程树：MCDR 会用 cmd.exe 再拉起服务端，只杀它自己
      // 会留下一个还在跑的服务端进程（正式代码里用的是 taskkill /T）
      if (child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        } catch {
          child.kill()
        }
      }
      setTimeout(() => resolvePromise({ output, alive, ms: Date.now() - started }), 1500)
    }, ms)
  })
}

/** MCDR 的输出带 ANSI 颜色，去掉之后才看得清 */
function stripAnsi(s: string): string {
  return s.replace(new RegExp('\\u001b\\[[0-9;]*m', 'g'), '')
}

void main()
