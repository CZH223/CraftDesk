/**
 * BungeeCord / Waterfall 的 config.yml：读得回来、改得出去、注释还在。
 *
 * 这一组用例盯的是真实用户会遇到的三件事：
 *   1. 官方模板里 priorities 排在 host 前面，而且列表项和字段同缩进 ——
 *      只按「以 - 开头」找 listener 边界会在 priorities 处截断，host 读不到；
 *   2. 布尔 / 数字必须裸写成 true / 200，写成 'true' 会让代理端启动报类型错误；
 *   3. 只加一台后端，不该冲掉别人配置里自己写的 motd / restricted / 注释。
 *
 * npx esbuild scripts/test-bungee-config.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-bungee-config.cjs && node tmp/test-bungee-config.cjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  parseBungeeConfig,
  patchBungeeConfig,
  readBungeeFile,
  writeBungeeFields,
  writeBungeeServers,
  writeBungeeServersIntoText
} from '../src/main/bungee'

let pass = 0
let fail = 0
function check(label: string, actual: unknown, want: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(want)}`}`)
}

/** 官方 BungeeCord 生成器的 config.yml，字段顺序与缩进都照抄 */
const OFFICIAL = `# This is the main configuration file for BungeeCord.
# 注释必须原样保留。

server_connect_timeout: 5000
remote_ping_cache: -1
network_compression_threshold: 256
enforce_linkage: false
permissions:
  default:
  - bungeecord.command.server
  - bungeecord.command.list
  admin:
  - bungeecord.command.alert
servers:
  lobby:
    motd: '&1Just another BungeeCord - Forced Host'
    address: localhost:25565
    restricted: false
  survival:
    address: 127.0.0.1:25566
    restricted: false
timeout: 30000
online_mode: true
disabled_commands:
- disabledcommandhere
log_pings: true
ip_forward: true
connection_throttle: 4000
connection_throttle_limit: 3
listeners:
- query_port: 25577
  motd: '&1Another Bungee server'
  tab_list: GLOBAL_PING
  query_enabled: false
  proxy_protocol: false
  forced_hosts:
    pvp.md-5.net: pvp
  ping_passthrough: false
  priorities:
  - lobby
  bind_local_address: true
  host: 0.0.0.0:25577
  max_players: 1
  tab_size: 60
  force_default_server: false
`

function field(parsed: ReturnType<typeof parseBungeeConfig>, section: string, key: string): string | undefined {
  return parsed.fields.find((f) => f.section === section && f.key === key)?.value
}

console.log('══ 读取官方模板 ══')
const parsed = parseBungeeConfig(OFFICIAL)
check('listener 的 host', field(parsed, 'listener', 'host'), '0.0.0.0:25577')
check('listener 的 motd（引号已去掉）', field(parsed, 'listener', 'motd'), '&1Another Bungee server')
check('priorities 之后的 max_players 也读到了', field(parsed, 'listener', 'max_players'), '1')
check('priorities 之后的 bind_local_address 也读到了', field(parsed, 'listener', 'bind_local_address'), 'true')
check('query_port', field(parsed, 'listener', 'query_port'), '25577')
check('顶层 online_mode', field(parsed, '', 'online_mode'), 'true')
check('顶层 ip_forward', field(parsed, '', 'ip_forward'), 'true')
check('顶层 timeout', field(parsed, '', 'timeout'), '30000')
check('permissions 里的命令不当作字段', parsed.fields.some((f) => f.key.includes('bungeecord')), false)
check('forced_hosts 里的映射不当作字段', parsed.fields.some((f) => f.key === 'pvp.md-5.net'), false)
check('读出不存在的段', parsed.fields.some((f) => f.key === 'servers'), false)

check('后端数量', parsed.servers.length, 2)
check('后端名与地址', parsed.servers.map((s) => `${s.name}=${s.host}:${s.port}`), ['lobby=localhost:25565', 'survival=127.0.0.1:25566'])
check('priorities', parsed.tryList, ['lobby'])

console.log('\n══ 改字段（类型要裸写）══')
const patched = patchBungeeConfig(OFFICIAL, [
  { section: '', key: 'online_mode', value: 'false', type: 'boolean' },
  { section: '', key: 'ip_forward', value: 'true', type: 'boolean' },
  { section: 'listener', key: 'max_players', value: '200', type: 'number' },
  { section: 'listener', key: 'motd', value: '我的跨服入口', type: 'string' },
  { section: 'listener', key: 'host', value: '0.0.0.0:25578', type: 'string' }
])
check('布尔写成裸 true/false', patched.includes('online_mode: false') && !patched.includes("online_mode: 'false'"), true)
check('数字写成裸数', patched.includes('max_players: 200') && !patched.includes("'200'"), true)
check('中文 motd 原样写进文件', patched.includes('motd: 我的跨服入口'), true)
check('listener 的 host 改了（地址里的冒号不加引号）', patched.includes('host: 0.0.0.0:25578'), true)
check(
  '含「冒号+空格」的值仍会加引号',
  patchBungeeConfig('motd: old' + String.fromCharCode(10), [
    { section: '', key: 'motd', value: 'a: b', type: 'string' }
  ]).includes("motd: 'a: b'"),
  true
)
check('端口那行没被误改', patched.includes('query_port: 25577'), true)
check('注释一条没丢', (patched.match(/^#/gm) || []).length, (OFFICIAL.match(/^#/gm) || []).length)
check('别人的字段没动', patched.includes('connection_throttle: 4000') && patched.includes('tab_size: 60'), true)

const reread = parseBungeeConfig(patched)
check('改完能读回来：online_mode', field(reread, '', 'online_mode'), 'false')
check('改完能读回来：max_players', field(reread, 'listener', 'max_players'), '200')
check('改完能读回来：host', field(reread, 'listener', 'host'), '0.0.0.0:25578')
check('改完能读回来：motd', field(reread, 'listener', 'motd'), '我的跨服入口')

console.log('\n══ 只加一台后端 ══')
const added = writeBungeeServersIntoText(
  OFFICIAL,
  [
    { name: 'lobby', address: 'localhost:25565' },
    { name: 'survival', address: '127.0.0.1:25566' },
    { name: 'minigame', address: '127.0.0.1:25568' }
  ],
  ['lobby']
)
const addedParsed = parseBungeeConfig(added)
check('三台都在', addedParsed.servers.map((s) => s.name), ['lobby', 'survival', 'minigame'])
check('新后端的地址', addedParsed.servers[2]?.port, 25568)
check('lobby 自己的 motd 没被冲掉', added.includes("motd: '&1Just another BungeeCord - Forced Host'"), true)
check('survival 的 restricted 还在', added.includes('restricted: false'), true)
check('priorities 仍是 lobby', addedParsed.tryList, ['lobby'])
check('注释还在', (added.match(/^#/gm) || []).length, (OFFICIAL.match(/^#/gm) || []).length)
check('listeners 还在', added.includes('tab_list: GLOBAL_PING') && added.includes('host: 0.0.0.0:25577'), true)

console.log('\n══ 改地址 / 删后端 / 换入口 ══')
const edited = writeBungeeServersIntoText(
  OFFICIAL,
  [
    { name: 'lobby', address: '127.0.0.1:25570' },
    { name: 'minigame', address: '127.0.0.1:25568' }
  ],
  ['lobby', 'survival']
)
const editedParsed = parseBungeeConfig(edited)
check('删掉的后端不在了', editedParsed.servers.some((s) => s.name === 'survival'), false)
check('lobby 地址已更新', editedParsed.servers[0]?.address, '127.0.0.1:25570')
check('priorities 里去掉了不存在的 survival', editedParsed.tryList, ['lobby'])
check('新后端还是写进来了', editedParsed.servers.some((s) => s.name === 'minigame'), true)

const switched = writeBungeeServersIntoText(OFFICIAL, [
  { name: 'lobby', address: 'localhost:25565' },
  { name: 'survival', address: '127.0.0.1:25566' }
], ['survival', 'lobby'])
check('入口顺序跟着 tryList 走', parseBungeeConfig(switched).tryList, ['survival', 'lobby'])

console.log('\n══ 没有 servers 段时追加 ══')
const noServers = 'online_mode: true\nlisteners:\n- host: 0.0.0.0:25577\n'
const appended = writeBungeeServersIntoText(noServers, [{ name: 'main', address: '127.0.0.1:25565' }], ['main'])
const appendedParsed = parseBungeeConfig(appended)
check('追加后读得到后端', appendedParsed.servers.map((s) => `${s.name}:${s.port}`), ['main:25565'])
check('原有内容没丢', appended.includes('online_mode: true'), true)

console.log('\n══ CRLF 与缩进式 listeners ══')
const crlf = PATH_CRLF(OFFICIAL)
const crlfOut = patchBungeeConfig(crlf, [{ section: 'listener', key: 'tab_size', value: '80', type: 'number' }])
check('改完仍是 CRLF', crlfOut.includes('\r\n') && !/[^\r]\n/.test(crlfOut), true)
check('CRLF 下字段确实改了', parseBungeeConfig(crlfOut).fields.some((f) => f.key === 'tab_size' && f.value === '80'), true)

const indented = `listeners:
  - query_port: 25577
    motd: 'indented'
    priorities:
    - lobby
    host: 0.0.0.0:25580
    max_players: 10
servers:
  lobby:
    address: localhost:25565
`
const indParsed = parseBungeeConfig(indented)
check('缩进式 listeners：host', field(indParsed, 'listener', 'host'), '0.0.0.0:25580')
check('缩进式 listeners：max_players', field(indParsed, 'listener', 'max_players'), '10')
const indPatched = patchBungeeConfig(indented, [{ section: 'listener', key: 'max_players', value: '20', type: 'number' }])
check('缩进式 listeners 也能改', parseBungeeConfig(indPatched).fields.some((f) => f.key === 'max_players' && f.value === '20'), true)
check(
  '缩进式 listeners 的缩进没被压平',
  indPatched.includes('    max_players: 20') && !indPatched.includes('\nmax_players:'),
  true
)

async function files(): Promise<void> {
  const dir = join(process.cwd(), 'tmp', 'bungee-config-test')
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'config.yml'), OFFICIAL, 'utf-8')

  console.log('\n══ 真读写文件 ══')
  const file = await readBungeeFile(dir)
  check('读到了文件', file.exists, true)
  check('格式标成 bungee（界面据此显示 config.yml 的字段）', file.format, 'bungee')
  check('文件里的后端', file.servers.map((s) => s.name), ['lobby', 'survival'])

  await writeBungeeFields(dir, [{ section: '', key: 'connection_throttle', value: '5000', type: 'number' }])
  await writeBungeeServers(dir, [
    { name: 'lobby', address: 'localhost:25565' },
    { name: 'survival', address: '127.0.0.1:25566' },
    { name: 'new', address: '127.0.0.1:25567' }
  ], ['lobby'])

  const after = await readBungeeFile(dir)
  check('写进文件的字段', after.fields.find((f) => f.key === 'connection_throttle')?.value, '5000')
  check('写进文件的后端', after.servers.map((s) => s.name), ['lobby', 'survival', 'new'])
  check('文件的注释仍在', after.raw.includes('# 注释必须原样保留。'), true)

  // 不存在的文件不能抛错：界面第一次打开还没启动过的代理端时要显示空状态
  const missing = await readBungeeFile(join(dir, 'nope'))
  check('文件不存在时 exists=false', missing.exists, false)
  check('文件不存在时格式仍标 bungee', missing.format, 'bungee')

  await fs.rm(dir, { recursive: true, force: true })
}

/** 把 LFLF 换成 CRLF（不经过 heredoc，避免 shell 吃掉反斜杠） */
function PATH_CRLF(text: string): string {
  return text.replace(/\n/g, String.fromCharCode(13) + '\n')
}

void files().then(() => {
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
})
