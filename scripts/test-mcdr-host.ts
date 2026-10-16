/**
 * 端到端：让 CraftDesk 那套「MCDR 托管」真的跑起来一台服务端。
 *
 * 前面那些测试验证的是「文件写得对不对」，这一份验证的是「照这么做能不能开服」：
 * 下一个真的原版核心 → 装进 server/ → mcdreforged init → 写 config.yml
 * → 用 CraftDesk 启动它的那条命令拉起来 → 等服务端打出 Done
 * → 像控制台面板那样从 stdin 发指令 → 发 stop 让它优雅关闭。
 *
 * 最后一步很关键：CraftDesk 的「停止」就是把 stop 写进 stdin，
 * 如果 MCDR 不认（或者根本不读 stdin），服务器就永远停不下来。
 *
 * npx esbuild scripts/test-mcdr-host.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-mcdr-host.cjs && node tmp/test-mcdr-host.cjs [mc版本]
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { installServer } from '../src/main/downloader'
import { detectJava } from '../src/main/java'
import { detectPython } from '../src/main/python'
import { initMcdrEnvironment, writeMcdrConfig } from '../src/main/mcdr'
import { resolveLayout } from '../src/main/layout'
import type { ServerConfig, ServerKind } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

function serverConfig(patch: Partial<ServerConfig>): ServerConfig {
  return {
    id: 'e2e',
    name: 'e2e',
    dir: '',
    jar: '',
    startScript: '',
    launchArgs: '',
    pythonPath: '',
    javaPath: '',
    memoryMin: 1024,
    memoryMax: 2048,
    jvmArgs: '',
    serverArgs: 'nogui',
    kind: 'vanilla' as ServerKind,
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

async function main(): Promise<void> {
  const mcVersion = process.argv[2] ?? '1.21.1'
  const python = (await detectPython()).find((p) => p.suitable && p.mcdr)
  if (!python) {
    console.log('没有可用的 Python + MCDReforged，跳过')
    process.exit(0)
  }
  const java = (await detectJava()).find((j) => j.valid && j.major >= 21)
  if (!java) {
    console.log('没有 Java 21 及以上，跳过')
    process.exit(0)
  }

  const root = resolve('tmp', 'mcdr-host')
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  const coreDir = 'server'
  const core = join(root, coreDir)
  await fs.mkdir(core, { recursive: true })

  console.log(`══ 1. 下载原版核心 ${mcVersion}（走 CraftDesk 的下载器）══`)
  const result = await installServer(
    core,
    'vanilla',
    mcVersion,
    {
      motd: 'CraftDesk MCDR 测试',
      port: 25992,
      maxPlayers: 20,
      acceptEula: true,
      onlineMode: false
    },
    'e2e',
    (p) => {
      if (p.stage === 'download' && p.percent % 25 === 0) console.log(`     ${p.percent}% ${p.message}`)
    }
  )
  check('核心下载完成', Boolean(result.jar), result.jar)
  check('eula.txt 已生成', await exists(join(core, 'eula.txt')))

  console.log('\n══ 2. 初始化 MCDR 并写入配置 ══')
  await initMcdrEnvironment(root, python.path)
  const setup = {
    root,
    coreDir,
    jar: result.jar,
    kind: 'vanilla' as ServerKind,
    mcVersion,
    memoryMin: 1024,
    memoryMax: 2048,
    pythonPath: python.path,
    isProxy: false
  }
  await writeMcdrConfig(setup)
  check('config.yml 写好了', await exists(join(root, 'config.yml')))
  check('permission.yml 写好了', await exists(join(root, 'permission.yml')))

  // CraftDesk 就是从配置里认出这是 MCDR 托管的，认不出来界面上的功能都会错位
  const layout = await resolveLayout(
    serverConfig({ dir: root, coreDir, mcdr: true, jar: `${coreDir}/${result.jar}`, mcVersion })
  )
  check('CraftDesk 认出这是 MCDR 布局', layout.isMcdr && layout.coreRel === coreDir)
  check('读得到启动命令', Boolean(layout.mcdrStartCommand), layout.mcdrStartCommand ?? '')

  console.log('\n══ 3. 用 CraftDesk 的方式启动（python -m mcdreforged，管道接 stdin）══')
  const child = spawn(python.path, ['-X', 'utf8', '-m', 'mcdreforged'], {
    cwd: root,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let output = ''
  let exited = false
  child.stdout?.on('data', (d) => (output += d.toString('utf-8')))
  child.stderr?.on('data', (d) => (output += d.toString('utf-8')))
  child.on('exit', () => (exited = true))

  // 服务端起来要一会儿，最多等 5 分钟
  const started = Date.now()
  const bootOk = await waitFor(() => /Done \([\d.]+s\)! For help/.test(output), 5 * 60 * 1000)
  const secs = Math.round((Date.now() - started) / 1000)
  check('MCDR 把服务端拉起来了（看到 Done）', bootOk, `${secs} 秒`)
  check('MCDR 自己还活着', !exited)
  if (!bootOk) {
    console.log('     最后几行输出：')
    for (const line of output.split(/\r?\n/).filter(Boolean).slice(-15)) {
      console.log(`     ${line.slice(0, 120)}`)
    }
  }

  if (bootOk) {
    console.log('\n══ 4. 从 stdin 发指令（控制台面板就是这么做的）══')
    child.stdin?.write('list\n')
    check('list 有回应（MCDR 转发给了服务端）', await waitFor(() => /players online|There are \d/.test(output), 20000))

    console.log('\n══ 5. 发 stop，看它能不能优雅关掉 ══')
    const stopAt = Date.now()
    child.stdin?.write('stop\n')
    const stopped = await waitFor(() => exited, 90000)
    check('进程退出了', stopped, `${Math.round((Date.now() - stopAt) / 1000)} 秒`)
    check('服务端是正常关闭（日志里有关闭字样）', /Stopping server|服务器进程已停止|已关闭/.test(output))
  }

  // 兜底：没退干净就杀进程树，别把服务端留在后台占着端口
  if (!exited && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  console.log(`测试目录：${root}`)
  process.exit(fail ? 1 : 0)
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return pred()
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

void main()
