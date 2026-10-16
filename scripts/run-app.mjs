/**
 * 起一个用来测试的 CraftDesk。
 *
 * 手写那几条命令踩过的坑都收在这里了：
 * - 单实例锁：同一个 userData 只允许一个实例，前一个不退，新的直接静默退出 →
 *   启动前先把它停掉，并等你确认它真的退了
 * - ELECTRON_RUN_AS_NODE：在某些终端里被设上，Electron 会当成 node 跑，
 *   窗口根本不出现 → 启动前清掉
 * - 调试端口：手工拼 --remote-debugging-port 容易和别的实例撞车 →
 *   固定一个端口并检查是否可用，顺便打印现成的 ui-drive 命令
 * - 残留进程：被强杀的实例会留下孤儿服务端，占着端口还会让人以为是 bug →
 *   --clean 一次清干净（只清 CraftDesk 自己的测试进程）
 *
 * 用法（也可以直接 npm run app / npm run app:test）：
 *   node scripts/run-app.mjs                 构建 + 用你平时的配置启动（带调试端口）
 *   node scripts/run-app.mjs --isolated      用一份干净的测试配置启动（不碰真实服务器列表）
 *   node scripts/run-app.mjs --isolated --fresh   干净配置，并把上一次的测试数据删掉
 *   node scripts/run-app.mjs --dev           开发模式（改代码自动重载）
 *   node scripts/run-app.mjs --stop          只停掉正在跑的实例
 *   node scripts/run-app.mjs --clean         停实例 + 清理残留的服务端进程
 *   node scripts/run-app.mjs --no-build      跳过构建（改的是纯渲染层时够用）
 *   node scripts/run-app.mjs --port 9400     换一个调试端口
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, promises as fs, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'
const ELECTRON = join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  IS_WIN ? 'electron.exe' : 'electron'
)

/** 测试实例的配置目录：和真实配置分开，删了也不心疼 */
const ISOLATED_DIR = join(ROOT, 'tmp', 'test-userdata')

// ---------------------------------------------------------------- 参数

const args = process.argv.slice(2)
const has = (...names) => names.some((n) => args.includes(n))
const value = (name, fallback) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (i < 0) return fallback
  const inline = args[i].includes('=') ? args[i].split('=')[1] : null
  return inline ?? args[i + 1] ?? fallback
}

const opts = {
  dev: has('--dev', '-d'),
  isolated: has('--isolated', '-i'),
  fresh: has('--fresh'),
  noBuild: has('--no-build'),
  stop: has('--stop'),
  clean: has('--clean'),
  help: has('--help', '-h'),
  port: Number(value('--port', '9222')),
  keep: has('--keep')
}

if (opts.help) {
  console.log(
    [
      '用法: node scripts/run-app.mjs [选项]',
      '',
      '  --dev            开发模式（electron-vite dev，改代码自动重载）',
      '  --isolated       用干净的测试配置目录（tmp/test-userdata），不碰真实服务器列表',
      '  --fresh          先把测试配置目录删掉再启动（要配合 --isolated）',
      '  --no-build       跳过构建，直接用现有的 out/',
      '  --port <n>       远程调试端口，默认 9222',
      '  --stop           停掉正在跑的实例，然后退出',
      '  --clean          停实例，并清理残留的服务端进程（孤儿 java / MCDR）',
      '  --keep           启动后不跟踪日志（默认会一直挂在终端上，Ctrl+C 就停）',
      '  -h, --help       显示这段帮助'
    ].join('\n')
  )
  process.exit(0)
}

// ---------------------------------------------------------------- 进程工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 找出命令行里带某个标记的进程（只认自己起的那些，不碰别人的） */
function findProcesses(marker) {
  if (!IS_WIN) {
    const res = spawnSync('pgrep', ['-fl', marker], { encoding: 'utf-8' })
    return (res.stdout || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ pid: Number(line.split(' ')[0]), cmd: line }))
  }
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker.replace(/'/g, "''")}') } |`,
    '  ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'
  ].join('\n')
  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf-8' }
  )
  return (res.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split('\t')
      return { pid: Number(pid), cmd: rest.join('\t') }
    })
    .filter((p) => Number.isFinite(p.pid))
}

/** 结束一整棵进程树（Windows 上必须用 taskkill /T，否则子进程会变孤儿） */
function killTree(pid) {
  if (!pid) return
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已经退出了 */
      }
    }
  }
}

/**
 * 找出 CraftDesk 的实例进程。
 *
 * 认「命令行里有本项目路径 + electron」这两条，别的一概不动：
 * 命令行里带项目路径的不止它一个（这条 node 命令自己就是），
 * 所以还要排除 shell 与 node，不然等于把自己砍了。
 */
function findAppInstances({ port } = {}) {
  return findProcesses(ROOT).filter((p) => {
    if (p.pid === process.pid) return false
    if (/powershell|cmd\.exe|bash\.exe|node\.exe|run-app\.mjs/i.test(p.cmd)) return false
    if (!/electron/i.test(p.cmd)) return false
    // 指定端口时只认那一个实例，省得把别的测试实例一起关了
    if (port && !p.cmd.includes(`--remote-debugging-port=${port}`) && !p.cmd.includes('electron-vite')) {
      return false
    }
    return true
  })
}

/** 停掉实例进程，返回停掉的数量 */
async function stopInstances({ port, quiet = false } = {}) {
  const found = findAppInstances({ port })
  if (!found.length) return 0
  if (!quiet) {
    for (const p of found) console.log(`   停掉 ${p.pid}：${p.cmd.slice(0, 90)}`)
  }
  for (const p of found) killTree(p.pid)
  // taskkill 是异步生效的，等它们真的没了再继续
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    if (!findAppInstances({ port }).length) break
  }
  return found.length
}

/** 端口能不能用（被占了就说明前一个实例还没走干净） */
function portFree(port) {
  return new Promise((res) => {
    const srv = createServer()
    srv.once('error', () => res(false))
    srv.once('listening', () => srv.close(() => res(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/** 等调试端口起来（truncate 说明不了什么，直接问它要不要求生） */
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500)
      })
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  return null
}

// ---------------------------------------------------------------- 清理

/**
 * 清理测试留下的孤儿进程。
 *
 * 只认「命令行里带本项目的 tmp 目录」的 java / python —— 那些是被强杀的
 * 测试实例留下的服务端。你自己在跑的服务端不会匹配到，别担心误伤。
 */
async function cleanLeftovers() {
  const markers = [
    join(ROOT, 'tmp'),
    ROOT.replace(/\\/g, '/') + '/tmp'
  ]
  let killed = 0
  for (const m of markers) {
    for (const p of findProcesses(m)) {
      // 别把自己（和这条 powershell 命令）杀了
      if (p.pid === process.pid) continue
      if (/powershell|node\.exe|run-app\.mjs/i.test(p.cmd)) continue
      console.log(`   清理残留进程 ${p.pid}：${p.cmd.slice(0, 100)}`)
      killTree(p.pid)
      killed++
    }
  }
  if (!killed) console.log('   没有残留的测试进程')
  return killed
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const userData = opts.isolated ? ISOLATED_DIR : null

  console.log('CraftDesk 测试启动器')
  console.log(`   项目目录：${ROOT}`)
  console.log(
    `   配置目录：${userData ?? '(系统默认：AppData\\Roaming\\CraftDesk，也就是你平时用的那份)'}`
  )
  console.log(`   模式：${opts.dev ? '开发（自动重载）' : '构建产物'}`)

  if (opts.stop || opts.clean) {
    console.log('\n停止正在运行的实例')
    // 指定了端口就只停那一个，否则停掉所有 CraftDesk 实例
    const n = await stopInstances({ port: args.includes('--port') ? opts.port : null })
    if (opts.clean) {
      console.log('\n清理残留的服务端进程')
      await cleanLeftovers()
    }
    console.log(n ? `   已停掉 ${n} 个实例` : '   没有在跑的实例')
    return
  }

  if (opts.fresh && !opts.isolated) {
    console.log('\n注意：--fresh 只在 --isolated 下有意义，忽略了')
  }

  console.log('\n[1/4] 停掉上一个实例')
  // 同一个配置目录上第二个实例只会静默退出（单实例锁），所以先停掉
  const stopped = await stopInstances({ port: opts.port })
  if (!stopped) console.log('   没有在跑的实例')

  if (opts.fresh && opts.isolated) {
    console.log('\n[2/4] 清空测试配置目录')
    rmSync(ISOLATED_DIR, { recursive: true, force: true })
    console.log('   已删除 tmp/test-userdata')
  } else if (opts.isolated) {
    console.log('\n[2/4] 保留上次的测试配置（要重来加 --fresh）')
    await fs.mkdir(ISOLATED_DIR, { recursive: true })
  } else {
    console.log('\n[2/4] 使用你平时的配置')
  }

  if (!opts.dev && !opts.noBuild) {
    console.log('\n[3/4] 构建')
    const build = spawnSync('npx', ['electron-vite', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: IS_WIN
    })
    if (build.status !== 0) {
      console.error('构建失败，先修掉上面的报错再启动')
      process.exit(build.status ?? 1)
    }
  } else {
    console.log(`\n[3/4] 跳过构建${opts.dev ? '（开发模式自带构建）' : '（--no-build）'}`)
  }

  if (!existsSync(ELECTRON)) {
    console.error(`找不到 Electron：${ELECTRON}\n先跑一次 npm install`)
    process.exit(1)
  }
  if (!(await portFree(opts.port))) {
    console.error(
      `端口 ${opts.port} 被占用了。可能是别的程序在用，换一个：--port 9400`
    )
    process.exit(1)
  }

  console.log('\n[4/4] 启动')
  const env = { ...process.env }
  // 有的终端会设这个变量，Electron 会当成 node 跑，窗口根本不出现
  delete env.ELECTRON_RUN_AS_NODE
  if (userData) env.CRAFTDESK_USER_DATA = userData

  const command = opts.dev ? 'npx' : ELECTRON
  const cmdArgs = opts.dev
    ? ['electron-vite', 'dev', `--remoteDebuggingPort=${opts.port}`]
    : [
        join(ROOT, 'out', 'main', 'index.js'),
        `--remote-debugging-port=${opts.port}`,
        // 同时用命令行和环境变量传测试目录：命令行让进程「找得到」（停实例靠它），
        // 环境变量让主进程把配置写进去
        ...(userData ? [`--user-data-dir=${userData}`] : [])
      ]

  console.log(`   ${command} ${cmdArgs.join(' ')}`)
  if (userData) console.log(`   CRAFTDESK_USER_DATA=${userData}`)

  const child = spawn(command, cmdArgs, {
    cwd: ROOT,
    stdio: opts.keep ? 'ignore' : 'inherit',
    shell: opts.dev && IS_WIN,
    env,
    detached: false
  })

  const cdp = await waitForCdp(opts.port, opts.dev ? 45000 : 25000)
  console.log('')
  if (cdp) {
    console.log(`   窗口起来了。调试端口 ${opts.port}（${cdp.Browser}）`)
    console.log('')
    console.log('   界面里可以直接用的命令：')
    console.log(`     node scripts/ui-drive.mjs "shot:tmp/a.png"                     截个图`)
    console.log(`     node scripts/ui-drive.mjs "eval:document.body.innerText"      读界面文字`)
    console.log(`     CDP_PORT=${opts.port} node scripts/ui-drive.mjs "eval:..."       （端口不是 9222 时）`)
    console.log('')
    console.log('   想让它自己点着走一遍，看 scripts/ui-drive.mjs 开头那几行')
  } else {
    console.log('   没等到调试端口。窗口可能开了但没接受连接，或者启动就失败了。')
    console.log('   用 npm run app -- --keep 看看窗口本身；开发模式还会打印构建错误。')
  }

  console.log('')
  console.log('   按 Ctrl+C 停掉这个实例（连同它启动的服务端一起）。')
  console.log('   测试配置目录不会被清掉，下次接着用；要重来加 --fresh。')

  const shutdown = () => {
    console.log('\n正在停止…')
    if (child.pid) killTree(child.pid)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // 输出被管道截断（比如 `| head`）时不要带着子进程一起跑掉
  process.stdout.on('error', (err) => {
    if (err.code !== 'EPIPE') throw err
  })
  process.on('exit', () => {
    if (child.pid) killTree(child.pid)
  })

  child.on('exit', (code) => {
    console.log(`\n应用已退出（代码 ${code}）`)
    process.exit(code ?? 0)
  })
}

void main()
