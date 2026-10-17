/**
 * 地图上的在线玩家位置：解析服务端 `data get entity` 的输出，以及轮询流程。
 *
 * 这里用一个假的服务端（sendCommand 立即把响应行塞进日志）验证：
 *   - Pos / Dimension 两种输出都能解析；
 *   - 名字、维度映射正确；
 *   - usercache 里的 UUID 能带上（头像要用）；
 *   - 3 秒缓存生效，不会每次打开地图都重复发指令。
 *
 * npx esbuild scripts/test-positions.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-positions.cjs && node tmp/test-positions.cjs
 */
import { promises as fs } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  getPlayerPositions,
  normalizeDimension,
  parseDataGetLine,
  parseListOutput,
  type PositionSource
} from '../src/main/positions'
import {
  decodeRconPackets,
  encodeRconPacket,
  readRconConfig,
  runRconCommands,
  withRconEnabled
} from '../src/main/rcon'
import type { ServerConfig } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`)
}

console.log('══ 解析 data get entity ══')
check(
  'Pos（带 d 后缀）',
  parseDataGetLine('CZH223 has the following entity data: [-211.5d, 64.0d, 224.25d]'),
  { name: 'CZH223', kind: 'pos', x: -211.5, y: 64, z: 224.25 }
)
check(
  'Pos（整型 / 无后缀）',
  parseDataGetLine('Steve has the following entity data: [1, 2, 3]'),
  { name: 'Steve', kind: 'pos', x: 1, y: 2, z: 3 }
)
check(
  'Dimension',
  parseDataGetLine('CZH223 has the following entity data: "minecraft:the_nether"'),
  { name: 'CZH223', kind: 'dimension', dimension: 'nether' }
)
check('普通聊天不误判', parseDataGetLine('<CZH223> hello'), null)
check('RCON 返回带日志前缀也能解析', parseDataGetLine('[Server thread/INFO]: CZH223 has the following entity data: [1.0d, 2.0d, 3.0d]')?.kind, 'pos')
check(
  'list 输出（英文）',
  parseListOutput('There are 2 of a max of 20 players online: CZH223, Steve'),
  ['CZH223', 'Steve']
)
check('list 输出（中文）', parseListOutput('当前有 1/20 名玩家在线：CZH223'), ['CZH223'])
check('list 空服', parseListOutput('There are 0 of a max of 20 players online:'), [])
check('维度名归一化', [normalizeDimension('minecraft:overworld'), normalizeDimension('minecraft:the_end')], [
  'overworld',
  'end'
])

class FakeServer implements PositionSource {
  lines: { text: string }[] = []
  commands: string[] = []
  onlinePlayers = ['CZH223', 'Steve']

  isRunning(): boolean {
    return true
  }

  runtime(): { onlinePlayers: string[] } {
    return { onlinePlayers: this.onlinePlayers }
  }

  logs(): { text: string }[] {
    return this.lines
  }

  sendCommand(_id: string, cmd: string): boolean {
    this.commands.push(cmd)
    if (cmd.endsWith(' Pos')) {
      const name = cmd.split(' ')[3]
      const pos = name === 'CZH223' ? '[-211.5d, 64.0d, 224.25d]' : '[10.0d, 70.0d, -20.0d]'
      this.lines.push({ text: `${name} has the following entity data: ${pos}` })
    } else if (cmd.endsWith(' Dimension')) {
      const name = cmd.split(' ')[3]
      const dim = name === 'CZH223' ? 'minecraft:overworld' : 'minecraft:the_end'
      this.lines.push({ text: `${name} has the following entity data: "${dim}"` })
    }
    return true
  }
}

const RCON_RESPONSES: Record<string, string> = {
  list: 'There are 2 of a max of 20 players online: CZH223, Steve',
  'data get entity CZH223 Pos': 'CZH223 has the following entity data: [-1.5d, 64.0d, 2.5d]',
  'data get entity CZH223 Dimension': 'CZH223 has the following entity data: "minecraft:overworld"',
  'data get entity Steve Pos': 'Steve has the following entity data: [8.0d, 70.0d, -9.0d]',
  'data get entity Steve Dimension': 'Steve has the following entity data: "minecraft:the_nether"'
}

/** 一个只会说 RCON 的假服务端 */
async function fakeRconServer(): Promise<{ port: number; close: () => void }> {
  const server = createServer((sock) => {
    let buf: Buffer = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const { packets, rest } = decodeRconPackets(buf)
      buf = Buffer.from(rest)
      for (const p of packets) {
        if (p.type === 3) {
          sock.write(encodeRconPacket(p.body === 'test' ? p.id : -1, 2, ''))
        } else if (p.type === 2) {
          sock.write(encodeRconPacket(p.id, 0, RCON_RESPONSES[p.body] ?? 'Unknown command'))
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => server.close()
  }
}

console.log('\n══ 开启 RCON 的配置改写 ══')
const base = [
  { key: 'server-port', value: '25565', comment: '# 游戏端口' },
  { key: 'enable-rcon', value: 'false' },
  { key: 'rcon.password', value: '' },
  { key: 'rcon.port', value: '0' },
  { key: 'motd', value: 'hi' }
]
const enabled = withRconEnabled(base)
check('enable-rcon 写成 true', enabled.entries.find((e) => e.key === 'enable-rcon')?.value, 'true')
check('空密码会生成', enabled.generatedPassword && Boolean(enabled.entries.find((e) => e.key === 'rcon.password')?.value), true)
check('端口默认为 25575', enabled.port, 25575)
check('注释和其它键保留', [enabled.entries[0].comment, enabled.entries.find((e) => e.key === 'motd')?.value], [
  '# 游戏端口',
  'hi'
])
const kept = withRconEnabled([{ key: 'rcon.password', value: 'abc' }])
check('已有密码不覆盖', kept.entries.find((e) => e.key === 'rcon.password')?.value, 'abc')
check('已有密码不标记生成', kept.generatedPassword, false)

async function rconTests(root: string): Promise<void> {
  console.log('\n══ RCON ══')
  const fake = await fakeRconServer()
  const cfg = { host: '127.0.0.1', port: fake.port, password: 'test' }
  const props = join(root, 'rcon.properties')
  await fs.writeFile(
    props,
    `enable-rcon=true
rcon.password=test
rcon.port=${fake.port}
server-ip=
`
  )

  const read = await readRconConfig(props)
  check('读到 RCON 配置', [read?.host, read?.port, read?.password], ['127.0.0.1', fake.port, 'test'])
  check('没开 RCON 时返回 null', await readRconConfig(join(root, 'nope.properties')), null)

  const out = await runRconCommands(cfg, ['list', 'data get entity CZH223 Pos'])
  check('RCON 执行两条指令', out, [RCON_RESPONSES.list, RCON_RESPONSES['data get entity CZH223 Pos']])

  let wrong = ''
  try {
    await runRconCommands({ ...cfg, password: 'bad' }, ['list'])
  } catch (err) {
    wrong = err instanceof Error ? err.message : String(err)
  }
  check('密码错误会抛错', wrong.includes('密码错误'), true)

  const external: PositionSource = {
    isRunning: () => false,
    runtime: () => ({ onlinePlayers: [] }),
    logs: () => [],
    sendCommand: () => false
  }
  const list = await getPlayerPositions(
    external,
    { id: 'rcon-svc' } as ServerConfig,
    root,
    props
  )
  check('外部服务端走 RCON 拿到两人', list.map((p) => `${p.name}:${p.dimension}`), [
    'CZH223:overworld',
    'Steve:nether'
  ])
  check('外部服务端的坐标', list.find((p) => p.name === 'Steve'), {
    name: 'Steve',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    x: 8,
    y: 70,
    z: -9,
    dimension: 'nether'
  })

  fake.close()
}

async function main(): Promise<void> {
  const root = join(process.cwd(), 'tmp', 'positions-test')
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    join(root, 'usercache.json'),
    JSON.stringify([
      { name: 'CZH223', uuid: '11111111-2222-3333-4444-555555555555' },
      { name: 'Steve', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    ])
  )

  const cfg = { id: 'p1', name: 'test' } as ServerConfig
  const fake = new FakeServer()

  console.log('\n══ 轮询流程 ══')
  const list = await getPlayerPositions(fake, cfg, root)
  check('两个在线玩家', list.length, 2)
  check(
    'CZH223 的坐标与维度',
    list.find((p) => p.name === 'CZH223'),
    {
      name: 'CZH223',
      uuid: '11111111-2222-3333-4444-555555555555',
      x: -211.5,
      y: 64,
      z: 224.25,
      dimension: 'overworld'
    }
  )
  check('Steve 在下界/末地也能识别', list.find((p) => p.name === 'Steve')?.dimension, 'end')
  check('每人两条指令', fake.commands.length, 4)

  const before = fake.commands.length
  const again = await getPlayerPositions(fake, cfg, root)
  check('3 秒内走缓存', [again.length, fake.commands.length], [2, before])

  await rconTests(root)

  fake.onlinePlayers = []
  fake.commands = []
  await fs.rm(root, { recursive: true, force: true })

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
