/**
 * 真装一遍 Forge / NeoForge，并且真的启动它。
 *
 * 这条链路有太多「看起来对」的地方：安装器地址、参数文件位置、java @文件 的
 * 工作目录、装完之后那个目录到底能不能跑起来。只对着代码看是看不出来的，
 * 所以这里从头到尾走一遍：下载安装器 → 跑 --installServer → 找参数文件
 * → 按 CraftDesk 的方式启动 → 等到服务端自己打出 Done。
 *
 * npx esbuild scripts/test-forge-install.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-forge-install.cjs && node tmp/test-forge-install.cjs neoforge 1.21.1
 */
import { promises as fs, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { installServer } from '../src/main/downloader'
import { listForgeVersions, listNeoForgeVersions } from '../src/main/installers'
import { detectJava } from '../src/main/java'
import type { ServerKind } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

/**
 * 按 server-manager 里那条分支拼启动命令，跑一会儿看它能不能起来。
 * 只要看到 Done，就说明参数文件、工作目录、运行库都是齐的。
 */
function bootAndWait(
  java: string,
  dir: string,
  argsFile: string,
  port: number,
  timeoutMs: number
): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      java,
      [
        '-Xms1024M',
        '-Xmx2048M',
        '-Dfile.encoding=UTF-8',
        '-Dstdout.encoding=UTF-8',
        '-Dstderr.encoding=UTF-8',
        `@${argsFile}`,
        'nogui'
      ],
      { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )

    let log = ''
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* 已经退出了 */
      }
      // Windows 上 kill 之后子进程可能还占着文件，等它真的退出
      setTimeout(() => resolvePromise({ ok, log }), 1500)
    }

    const onData = (d: Buffer): void => {
      const text = d.toString('utf-8')
      log += text
      if (/Done \([\d.]+s\)! For help/.test(log)) finish(true)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', () => finish(false))
    child.on('exit', () => finish(/Done \([\d.]+s\)! For help/.test(log)))

    const timer = setTimeout(() => finish(false), timeoutMs)
    console.log(`     （启动中，最多等 ${Math.round(timeoutMs / 1000)} 秒，端口 ${port}）`)
  })
}

async function main(): Promise<void> {
  const kind = (process.argv[2] ?? 'neoforge') as ServerKind
  const mcVersion = process.argv[3] ?? (kind === 'forge' ? '1.20.1' : '1.21.1')

  console.log(`══ ${kind} ${mcVersion}：完整装一遍 ══`)

  const list = kind === 'forge' ? await listForgeVersions() : await listNeoForgeVersions()
  const entry = list.find((v) => v.id === mcVersion)
  if (!entry?.latestBuild) {
    console.log(`  ✗ 版本表里没有 ${mcVersion}`)
    process.exit(1)
  }
  console.log(`  构建号 ${entry.latestBuild}（${entry.note}）`)

  const javas = await detectJava()
  const java = javas.find((j) => j.valid && j.major >= 17)
  if (!java) {
    console.log('  ✗ 没有找到 Java 17 及以上，跳过')
    process.exit(1)
  }
  console.log(`  Java ${java.major} · ${java.path}`)

  const dir = resolve('tmp', `real-${kind}-${mcVersion}`)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })

  console.log('\n── 下载安装器并运行 ──')
  const started = Date.now()
  const result = await installServer(
    dir,
    kind,
    mcVersion,
    {
      motd: 'CraftDesk 安装测试',
      port: 25991,
      maxPlayers: 20,
      acceptEula: true,
      onlineMode: false,
      build: entry.latestBuild,
      javaPath: java.path
    },
    `test-${kind}`,
    (p) => {
      if (p.message && p.stage !== 'download') console.log(`     [${p.stage}] ${p.message}`)
    }
  )
  const usedSec = Math.round((Date.now() - started) / 1000)
  console.log(`     安装耗时 ${usedSec} 秒`)

  console.log('\n── 安装产物 ──')
  check('拿到了启动入口', Boolean(result.launchArgs || result.jar), result.launchArgs || result.jar)
  if (result.launchArgs) {
    const argsPath = join(dir, result.launchArgs)
    check('参数文件真的在磁盘上', existsSync(argsPath), result.launchArgs)
    const body = await fs.readFile(argsPath, 'utf-8')
    check('参数文件里有 JVM 参数', body.includes('-p ') || body.length > 100, `${body.length} 字节`)
    check(
      '参数文件指向了运行库目录',
      body.includes('libraries'),
      body.split(/\s+/).find((x) => x.includes('libraries'))?.slice(0, 60) ?? ''
    )
  }
  check('eula.txt 写好了', existsSync(join(dir, 'eula.txt')))
  check('server.properties 写好了', existsSync(join(dir, 'server.properties')))
  const props = await fs.readFile(join(dir, 'server.properties'), 'utf-8')
  check('server.properties 里是测试端口', props.includes('server-port=25991'))
  check('运行库拉下来了', existsSync(join(dir, 'libraries')), 'libraries/')

  console.log('\n── 真的启动它 ──')
  const boot = await bootAndWait(
    java.path,
    dir,
    join(dir, result.launchArgs ?? ''),
    25991,
    8 * 60 * 1000
  )
  check('服务端启动到 Done', boot.ok)
  if (!boot.ok) {
    const tail = boot.log.split(/\r?\n/).filter(Boolean).slice(-12).join('\n     ')
    console.log(`     最后几行：\n     ${tail}`)
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  console.log(`测试目录：${dir}（看过之后可以整个删掉）`)
  process.exit(fail ? 1 : 0)
}

void main()
