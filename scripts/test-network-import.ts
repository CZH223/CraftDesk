/**
 * 验证「导入跨服网络」的扫描：代理端配置里那些后端，能不能在磁盘上找回来。
 *
 * 这是整条路上最容易出错的一步：找错了目录，用户勾完导进来的是别人的服务器。
 * 所以匹配只认端口（server.properties 里的 server-port），名字匹配只当补充、
 * 而且会在界面上标成「按名字猜的」。
 *
 * npx esbuild scripts/test-network-import.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-network-import.cjs && node tmp/test-network-import.cjs \
 *   "<代理端目录>" [CraftDesk 配置文件]
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseBungeeServers, scanNetworkImport } from '../src/main/network'
import type { ServerConfig } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

const STATUS_LABEL: Record<string, string> = {
  managed: '已在列表',
  found: '可导入',
  'address-only': '只有地址',
  'not-a-server': '目录不是服务端'
}

function unitTests(): void {
  console.log('══ BungeeCord 的 config.yml 后端列表 ══')
  const yml = `
# 注释行
listeners:
- query_port: 25577
  motd: '&1Another Bungee server'
  host: 0.0.0.0:25577
servers:
  lobby:
    address: localhost:25566
    restricted: false
    motd: '&1Just another BungeeCord - Forced Host'
  survival:
    address: 127.0.0.1:25565
    restricted: false
ip_forward: true
`
  const list = parseBungeeServers(yml)
  check('解析出 2 个后端', list.length === 2, `${list.length}`)
  check('键名是别名', list[0]?.name === 'lobby' && list[1]?.name === 'survival')
  check('address 拆成 host:port', list[0]?.host === 'localhost' && list[0]?.port === 25566)
  check('IP 形式的地址也对', list[1]?.host === '127.0.0.1' && list[1]?.port === 25565)
  check('不会把 listeners 里的 host 当成后端', !list.some((s) => s.port === 25577))

  const empty = parseBungeeServers('listeners:\n- host: 0.0.0.0:25577\n')
  check('没有 servers 段时返回空', empty.length === 0)
}

async function realProxy(dir: string, storePath: string): Promise<void> {
  if (!(await exists(dir))) {
    console.log(`\n（跳过 ${dir}：目录不存在）`)
    return
  }

  console.log(`\n══ 真实代理端：${dir} ══`)

  let managed: ServerConfig[] = []
  if (storePath && (await exists(storePath))) {
    try {
      const raw = JSON.parse(await fs.readFile(storePath, 'utf-8')) as { servers?: ServerConfig[] }
      managed = raw.servers ?? []
      console.log(`     用 ${storePath} 里的 ${managed.length} 台已托管服务器做对照`)
    } catch (err) {
      console.log(`     读配置失败（就当列表是空的）：${String(err)}`)
    }
  }

  const started = Date.now()
  const plan = await scanNetworkImport(dir, managed)
  const ms = Date.now() - started

  console.log(
    `     代理端：${plan.proxy.name} · ${plan.proxy.kind} · 监听 ${plan.proxyPort ?? '?'} · ` +
      `配置里 ${plan.backends.length} 个后端 · 附近扫了 ${plan.scanned} 个目录 · ${ms} ms`
  )

  const counts = plan.backends.reduce<Record<string, number>>((acc, b) => {
    acc[b.status] = (acc[b.status] ?? 0) + 1
    return acc
  }, {})
  console.log(
    '     ' +
      Object.entries(counts)
        .map(([k, v]) => `${STATUS_LABEL[k] ?? k} ${v}`)
        .join(' · ')
  )

  console.log('     后端：')
  for (const b of plan.backends) {
    console.log(
      `       ${b.alias.padEnd(14)} ${b.address.padEnd(18)} ${(STATUS_LABEL[b.status] ?? b.status).padEnd(12)}` +
        `${b.displayDir || '—'}${b.foundBy === 'name' ? '（按名字猜）' : ''}`
    )
  }

  check('认出了这是代理端', ['velocity', 'bungeecord', 'waterfall'].includes(plan.proxy.kind))
  check('配置里读到了后端', plan.backends.length > 0, `${plan.backends.length} 个`)
  check(
    '每个后端都有别名和端口',
    plan.backends.every((b) => b.alias && b.port > 0),
    plan.backends.filter((b) => !b.port).map((b) => b.alias).join(',') || '（都有）'
  )
  check(
    '能找到的后端都带着识别结果',
    plan.backends.every((b) => b.status !== 'found' || Boolean(b.detected)),
    ''
  )
  // 找错目录比找不到更糟：端口对不上的绝不能认成 found
  const wrong = plan.backends.filter(
    (b) => b.status === 'found' && b.foundBy === 'port' && b.detected?.port !== b.port
  )
  check('按端口匹配的，端口真的对得上', wrong.length === 0, wrong.map((w) => w.alias).join(','))

  const resolved = plan.backends.filter((b) => b.status === 'managed' || b.status === 'found').length
  check('多数后端在磁盘上找得到', resolved >= Math.ceil(plan.backends.length / 2), `${resolved}/${plan.backends.length}`)
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
  unitTests()

  const dir = process.argv[2]
  const store = process.argv[3] ?? join(process.env.APPDATA ?? '', 'CraftDesk', 'craftdesk.json')
  if (dir) {
    await realProxy(resolve(dir), store)
  } else {
    console.log('\n（没给代理端目录，只跑了配置解析部分）')
    console.log('  想看真实的目录找回：node tmp/test-network-import.cjs "<代理端目录>" [CraftDesk 配置文件]')
  }
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
