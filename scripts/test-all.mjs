/**
 * 一把跑完所有测试脚本。
 *
 * 每个 test-*.ts 都能单独跑（文件头写了怎么跑），但一条条敲 esbuild 太烦，
 * 而且哪些要联网、哪些要几分钟、哪些得先有台服务器，也记不住。
 * 这里按「代价」分了组：
 *
 *   fast   离线、几秒内（默认跑这些）
 *   net    要联网（拉官方接口，几十秒）
 *   slow   要下几百 MB 或者真的把服务端跑起来（几分钟）
 *   dir    得给一个服务器目录才有意义
 *
 * 用法：
 *   node scripts/test-all.mjs             只跑 fast
 *   node scripts/test-all.mjs --net       加上联网的
 *   node scripts/test-all.mjs --all       全跑（含几分钟的重活）
 *   node scripts/test-all.mjs --only mcdr 只跑名字里带 mcdr 的
 *   node scripts/test-all.mjs --list      列出都有什么
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'
const TMP = join(ROOT, 'tmp')

/** group: fast / net / slow / dir；args 是必须给的外部参数 */
const TESTS = [
  {
    name: 'test-relations.ts',
    group: 'fast',
    what: '扩展依赖关系（五种描述文件 + 关系图 + 容错）'
  },
  { name: 'test-startscript.ts', group: 'fast', what: '启动脚本生成（含纯 ASCII 检查）' },
  { name: 'test-removal.ts', group: 'fast', what: '删除的守门逻辑与落盘行为' },
  { name: 'test-forwarding.ts', group: 'fast', what: '判定「这台能不能当代理端的后端」' },
  {
    name: 'test-graph.ts',
    group: 'fast',
    what: '模组关系星图的布局（坐标、数量上限、缺失前置、真实数据）'
  },
  {
    name: 'test-network-import.ts',
    group: 'fast',
    what: '跨服网络导入：读代理端配置 + 在磁盘上找回后端（本机没有跨服目录时只跑解析部分）'
  },
  { name: 'test-mcdr.ts', group: 'fast', what: 'MCDR 配置生成 / handler / 布局 / 真启动（约 40 秒）' },
  {
    name: 'test-ui-prefs.ts',
    group: 'fast',
    what: '界面尺寸与背景的取值（夹取、窗口变窄时收窄、默认值一致性）'
  },
  {
    name: 'test-server-icon.ts',
    group: 'fast',
    what: '服务器图标：解析 / 文件名安全 / 导入与清理（真实复制文件）'
  },
  {
    name: 'test-portable.ts',
    group: 'fast',
    what: '便携版的数据目录选择（能不能写、退回系统目录、exe 旁边的 data）'
  },
  {
    name: 'test-core-dir.ts',
    group: 'fast',
    what: '核心目录识别：整合包服不会把 mods/ 当成核心（模组列表为空的那个 bug）'
  },
  {
    name: 'test-proxy-setup.ts',
    group: 'fast',
    what: '代理端初始配置：velocity.toml / config.yml 生成，能被自己的解析器读回来'
  },
  { name: 'test-installers.ts', group: 'net', what: 'Forge / NeoForge 版本表与安装器地址' },
  {
    name: 'test-remote-icon.ts',
    group: 'net',
    what: '下载源图标：地址白名单 + 真抓一张 + 缓存与坏地址'
  },
  {
    name: 'test-proxy-download.ts',
    group: 'net',
    what: '代理端下载源：Velocity / Waterfall / BungeeCord（真下一个 25 MB 的验证）'
  },
  { name: 'test-download.ts', group: 'net', what: '下载器：字节数与校验和（要下 60 MB）' },
  { name: 'test-registry.ts', group: 'net', what: 'Modrinth 与 MCDR 插件源' },
  { name: 'test-sources.ts', group: 'net', what: 'Hangar / SpigotMC / CurseForge 源' },
  {
    name: 'test-forge-install.ts',
    group: 'slow',
    what: '真装一遍 Forge / NeoForge 并启动到 Done（几分钟，几百 MB）',
    args: ['neoforge', '1.21.1']
  },
  {
    name: 'test-mcdr-host.ts',
    group: 'slow',
    what: '下一个真核心交给 MCDR 托管，验证启动与优雅停止',
    args: ['1.21.1']
  },
  // 这几个给一个服务器目录就能跑
  {
    name: 'test-scan.ts',
    group: 'dir',
    what: '对一个目录跑识别 → 布局 → 扩展 → 配置',
    takesDir: true
  },
  { name: 'test-detect.ts', group: 'dir', what: '服务端目录类型识别', takesDir: true },
  // 这几个要的参数不是一个普通服务器目录，只在自己点名跑时执行
  {
    name: 'test-proxy.ts',
    group: 'dir',
    what: '代理端识别与日志解析',
    manual: '要的是代理端目录（velocity.toml / config.yml 那一层）'
  },
  {
    name: 'test-backends.ts',
    group: 'dir',
    what: '后端转发配置核对',
    manual: '要两个参数：CraftDesk 的配置文件和代理端目录'
  },
  {
    name: 'test-ping.ts',
    group: 'dir',
    what: 'Server List Ping',
    manual: '要一台正在跑的服务器，参数形如 127.0.0.1:25565'
  }
]

// ---------------------------------------------------------------- 参数

const args = process.argv.slice(2)
const has = (...names) => names.some((n) => args.includes(n))
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}

const groups = new Set(['fast'])
if (has('--net', '--network')) groups.add('net')
if (has('--all')) {
  groups.add('net')
  groups.add('slow')
  groups.add('dir')
}
const only = value('--only', null)
const dirArg = value('--dir', null)
const listOnly = has('--list', '-l')

if (has('--help', '-h')) {
  console.log(
    [
      '用法: node scripts/test-all.mjs [选项]',
      '',
      '  --net          加上要联网的测试',
      '  --all          全跑（含几分钟的重活）',
      '  --only <词>    只跑名字里带这个词的，例如 --only mcdr',
      '  --dir <目录>   给需要目录的测试（识别 / 代理端 / ping）',
      '  --list         列出所有测试',
      '  -h, --help     这段帮助'
    ].join('\n')
  )
  process.exit(0)
}

if (listOnly) {
  console.log('可跑的测试：\n')
  for (const t of TESTS) {
    console.log(`  [${t.group.padEnd(4)}] ${t.name.padEnd(24)} ${t.what}`)
  }
  console.log('\n  fast = 离线几秒 | net = 要联网 | slow = 几分钟 | dir = 要给目录')
  process.exit(0)
}

// ---------------------------------------------------------------- 执行

/**
 * 用 esbuild 的 JS 接口打包，不拼命令行。
 * 路径里有空格（"M:\PCL CE\…"），走 shell 拼参数会被拆开，
 * 之前就是这么失败在一个看不懂的报错上的。
 */
function bundle(test) {
  const out = join(TMP, test.name.replace(/\.ts$/, '.cjs'))
  try {
    buildSync({
      entryPoints: [join(ROOT, 'scripts', test.name)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: out,
      logLevel: 'silent'
    })
    return { out, error: null }
  } catch (err) {
    const text = (err.errors ?? []).map((e) => `${e.location?.file}:${e.location?.line} ${e.text}`).join('；')
    return { out: null, error: text || String(err.message ?? err) }
  }
}

function runTest(test) {
  const { out, error } = bundle(test)
  if (!out) return { ok: false, detail: `打包失败：${error}` }

  const extra = test.args ?? (test.takesDir && dirArg ? [dirArg] : [])
  const res = spawnSync(process.execPath, [out, ...extra], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30 * 60 * 1000
  })
  const output = `${res.stdout || ''}${res.stderr || ''}`

  // 脚本自己会打「通过 N，失败 M」
  const m = output.match(/通过\s*(\d+)[，,]\s*失败\s*(\d+)/)
  const pass = m ? Number(m[1]) : null
  const fail = m ? Number(m[2]) : null
  const ok = res.status === 0 && fail === 0

  /*
   * 连不上站点和测试没写对是两回事，得分开说。
   * 这台机器（或者所处的网络）不一定连得上 GitHub / Modrinth / Mojang，
   * 那种情况下报出来的错误信息长得像代码问题，很容易白查半天。
   */
  const network =
    /UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|ECONNRESET|ENOTFOUND|ETIMEDOUT|Connect Timeout|fetch failed/i.test(
      output
    )

  const detail = m
    ? `通过 ${pass}，失败 ${fail}`
    : network
      ? '连不上外部站点（网络问题，不是代码问题）'
      : output.trim().split('\n').slice(-3).join(' / ') || `退出码 ${res.status}`

  return { ok, detail, output, network }
}

/** 跑之前先看一眼要用的站点通不通，省得等着看一堆超时 */
async function checkNetwork() {
  const hosts = [
    ['GitHub（MCDR 插件目录）', 'https://raw.githubusercontent.com/'],
    ['Modrinth', 'https://api.modrinth.com/'],
    ['NeoForge maven', 'https://maven.neoforged.net/'],
    ['Mojang（原版核心）', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'],
    ['PaperMC', 'https://api.papermc.io/']
  ]
  console.log('网络自检（联网测试要用）：')
  for (const [label, url] of hosts) {
    let ok = false
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000), method: 'HEAD' })
      ok = res.status < 500
    } catch {
      ok = false
    }
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  }
  console.log('  （打叉的那些站点相关的测试会失败或走不动，和代码无关）\n')
}

async function main() {
  if (!existsSync(join(ROOT, 'node_modules', 'esbuild'))) {
    console.error('没有 node_modules，先跑 npm install')
    process.exit(1)
  }
  mkdirSync(TMP, { recursive: true })

  const selected = TESTS.filter((t) => {
    if (only) return t.name.includes(only)
    // 要专用参数的，只有点名才跑：随便塞个目录进去只会得到一句看不懂的报错
    if (t.manual) return false
    if (t.group === 'dir' && (!dirArg || !t.takesDir)) return false
    return groups.has(t.group)
  })

  const skipped = TESTS.filter((t) => !selected.includes(t))
  if (!selected.length) {
    console.log('没有选中任何测试。--list 看看都有什么。')
    process.exit(0)
  }

  // 联网的测试先看一眼站点通不通，省得对着一堆超时猜
  if (selected.some((t) => t.group !== 'fast')) await checkNetwork()

  console.log(`要跑 ${selected.length} 个测试：\n`)
  const results = []
  for (const test of selected) {
    const started = Date.now()
    process.stdout.write(`  ▶ ${test.name} … `)
    const r = runTest(test)
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`${r.ok ? '✓' : '✗'} ${r.detail}（${secs}s）`)
    if (!r.ok && r.output) {
      // 失败时把最后几行贴出来，省得再去翻
      const tail = r.output.trim().split('\n').slice(-8)
      for (const line of tail) console.log(`      ${line.slice(0, 140)}`)
    }
    results.push({ test, ...r, secs })
  }

  const failed = results.filter((r) => !r.ok)
  const netFailed = failed.filter((r) => r.network)
  const realFailed = failed.filter((r) => !r.network)
  const sums = results.reduce(
    (acc, r) => {
      const m = r.detail.match(/通过\s*(\d+)[，,]\s*失败\s*(\d+)/)
      if (m) {
        acc.pass += Number(m[1])
        acc.fail += Number(m[2])
      }
      return acc
    },
    { pass: 0, fail: 0 }
  )

  console.log(`\n${'─'.repeat(52)}`)
  console.log(
    `共 ${results.length} 个测试：${results.length - failed.length} 个通过，${failed.length} 个失败` +
      (sums.pass ? `（断言 ${sums.pass} 项通过${sums.fail ? `，${sums.fail} 项失败` : ''}）` : '')
  )
  if (realFailed.length) {
    console.log('失败的：')
    for (const f of realFailed) console.log(`  ✗ ${f.test.name}：${f.detail}`)
  }
  if (netFailed.length) {
    console.log('因网络不通没跑完的（看上面自检里哪些站点是通的）：')
    for (const f of netFailed) console.log(`  ⚠ ${f.test.name}：${f.detail}`)
  }
  if (skipped.length) {
    console.log(
      `\n跳过的 ${skipped.length} 个：` + skipped.map((t) => t.name.replace(/\.ts$/, '')).join('、')
    )
    console.log('  --net 加联网的，--all 全跑，--dir <目录> 加上能对目录跑的')
    const manual = skipped.filter((t) => t.manual)
    if (manual.length) {
      console.log('  这几个要专用参数，只在自己点名跑时执行：')
      for (const t of manual) console.log(`    ${t.name}：${t.manual}`)
    }
  }

  process.exit(failed.length ? 1 : 0)
}

main()
