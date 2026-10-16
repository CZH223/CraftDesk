/**
 * 验证代理端的初始配置生成。
 *
 * 这里最要紧的是「生成出来的东西代理端真的能读」：
 * - Velocity 的 velocity.toml 拿我们自己的解析器读回来，bind / motd 必须对得上；
 * - BungeeCord 的 config.yml 拿网络拓扑那套解析器读回来，lobby 那条后端要能读出来；
 * - 用户填的 MOTD 里带引号、带反斜杠时，不能把配置写坏（写坏了代理端起不来，
 *   而报错信息是 YAML / TOML 的解析错误，用户根本看不出是自己填的引号干的）。
 *
 * 如果 tmp/proxy-probe/velocity.jar 在（跑过联网测试会留下），还会拿官方的
 * default-velocity.toml 真跑一遍 —— 那才是真正会被用到的模板。
 *
 * npx esbuild scripts/test-proxy-setup.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-proxy-setup.cjs && node tmp/test-proxy-setup.cjs
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  bungeeConfigYaml,
  fallbackVelocityToml,
  patchVelocityToml,
  proxyConfigName,
  proxyConfigText
} from '../src/main/proxySetup'
import { parseVelocityToml } from '../src/main/velocity'
import { parseBungeeServers } from '../src/main/network'
import { ZipReader } from '../src/main/zip'
import { handlerFor } from '../src/main/mcdr'
import { proxyJavaHintText, proxyJavaMajor } from '../src/shared/javaHint'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

/** 一份「像官方模板」的 velocity.toml：注释比配置多，正是我们要保住的东西 */
const TEMPLATE = `# This is the main configuration file for Velocity.
# Comments here must survive our patching.

config-version = "2.7"

# What port should the proxy be bound to?
bind = "0.0.0.0:25577"

# What should be the MOTD?
motd = "<#09add3>A Velocity Server"

# How many players can be on the proxy at once?
show-max-players = 500

# Should we authenticate players with Mojang?
online-mode = true

# Whether to use the modern forwarding
player-info-forwarding-mode = "NONE"

[servers]
# Define your servers here.
try = []
`

const INPUT = { kind: 'velocity' as const, port: 25566, motd: '我的跨服入口', onlineMode: true }

console.log('Velocity（官方模板上改三行）：')
const patched = patchVelocityToml(TEMPLATE, INPUT)
check('bind 换成新的端口', patched.includes('bind = "0.0.0.0:25566"'))
check('旧的 bind 不再出现', !patched.includes('25577'))
check('motd 换成新的', patched.includes('motd = "我的跨服入口"'))
check('注释一条没丢', (patched.match(/^#/gm) || []).length === (TEMPLATE.match(/^#/gm) || []).length)
check('其它键原样不动', patched.includes('show-max-players = 500'))
check('config-version 没被动过', patched.includes('config-version = "2.7"'))

const parsed = parseVelocityToml(patched)
const field = (key: string): string | undefined =>
  parsed.fields.find((f) => f.key === key)?.value
check('解析器能把 bind 读回来', field('bind') === '0.0.0.0:25566', String(field('bind')))
check('解析器能把 motd 读回来', field('motd') === '我的跨服入口', String(field('motd')))
check('解析器读到的是顶层字段而不是段里的', parsed.fields.find((f) => f.key === 'bind')?.section === '')

console.log('\n改 online-mode：')
const offline = patchVelocityToml(TEMPLATE, { ...INPUT, onlineMode: false })
check('online-mode 能改成 false', offline.includes('online-mode = false'))
check('解析回来也是 false', parseVelocityToml(offline).fields.find((f) => f.key === 'online-mode')?.value === 'false')

console.log('\n会写坏配置的输入：')
const nasty = patchVelocityToml(TEMPLATE, { ...INPUT, motd: 'He said "hi"\\end' })
check('引号被转义', nasty.includes('motd = "He said \\"hi\\"\\\\end"'))
check(
  '转义之后按 TOML 规则解回来，还是用户填的原话',
  // 我们自己的解析器只负责去掉两边引号（它读的是「给人看的值」），
  // 这里用 JSON 的字符串语法模拟 TOML 基础字符串的反转义，
  // 确认转义是合法的、解出来不会多一个反斜杠
  JSON.parse(`"${(nasty.split('\n').find((l) => l.startsWith('motd =')) ?? '').slice(8, -1)}"`) ===
    'He said "hi"\\end'
)
check(
  '空 MOTD 有兜底',
  patchVelocityToml(TEMPLATE, { ...INPUT, motd: '' }).includes('motd = "A Minecraft Server"')
)

console.log('\n模板里缺键的时候：')
const noKeys = 'config-version = "2.7"\n\n[servers]\ntry = []\n'
const added = patchVelocityToml(noKeys, INPUT)
check('缺的键会补上', added.includes('bind = "0.0.0.0:25566"') && added.includes('online-mode = true'))
check(
  '补在第一个段之前（写到段里就变成那个段的键了）',
  added.indexOf('bind =') < added.indexOf('[servers]'),
  added.split('\n').findIndex((l) => l.startsWith('bind')) + ' < ' + added.split('\n').findIndex((l) => l.startsWith('[servers]'))
)

console.log('\n注释掉的键不算数：')
const commented = '# bind = "0.0.0.0:25577"\nbind = "0.0.0.0:25577"\n'
const fixed = patchVelocityToml(commented, INPUT)
check('不会改到注释行', fixed.startsWith('# bind = "0.0.0.0:25577"'))
check('真正那行改了', fixed.includes('\nbind = "0.0.0.0:25566"'))

console.log('\nCRLF 的文件：')
const crlf = patchVelocityToml(TEMPLATE.split('\n').join('\r\n'), INPUT)
check('保持原来的行尾风格', crlf.includes('\r\n') && !/[^\r]\n/.test(crlf))
check('值也改对了', crlf.includes('bind = "0.0.0.0:25566"'))

console.log('\nBungeeCord / Waterfall 的 config.yml：')
const yaml = bungeeConfigYaml({ ...INPUT, kind: 'bungeecord' })
check('端口写在 host 里', yaml.includes('host: 0.0.0.0:25566'))
check('query_port 跟着走', yaml.includes('query_port: 25566'))
check('online_mode 是布尔值不是字符串', /^online_mode: true$/m.test(yaml))
check('有一条占位后端', /^\s+lobby:$/m.test(yaml))
const servers = parseBungeeServers(yaml)
check('拓扑解析器能读出这条后端', servers.length === 1 && servers[0].name === 'lobby', JSON.stringify(servers))
check('地址读对了', servers[0]?.address === '127.0.0.1:25566', servers[0]?.address)

const yamlQuote = bungeeConfigYaml({ ...INPUT, kind: 'waterfall', motd: "It's mine" })
check('MOTD 里的单引号转义成两个', yamlQuote.includes("motd: 'It''s mine'"))
check('离线模式也能写', bungeeConfigYaml({ ...INPUT, kind: 'bungeecord', onlineMode: false }).includes('online_mode: false'))

console.log('\n兜底模板（取不到官方模板时）：')
const fallback = fallbackVelocityToml(INPUT)
check('兜底模板能被自己的解析器读', parseVelocityToml(fallback).fields.length >= 5)
check(
  '兜底模板的 bind 正确',
  parseVelocityToml(fallback).fields.find((f) => f.key === 'bind')?.value === '0.0.0.0:25566'
)
check('兜底模板有 [servers] 段', fallback.includes('[servers]'))
check('config-version 取偏旧的（迁移是单向的）', fallback.includes('config-version = "1.0.0"'))

console.log('\n入口分发：')
check('velocity 用 velocity.toml', proxyConfigName('velocity') === 'velocity.toml')
check('另外两个用 config.yml', proxyConfigName('bungeecord') === 'config.yml' && proxyConfigName('waterfall') === 'config.yml')
check('有官方模板时用官方模板', proxyConfigText(INPUT, TEMPLATE).includes('config-version = "2.7"'))
check('没有官方模板时用兜底', proxyConfigText(INPUT, null).includes('config-version = "1.0.0"'))
check('bungee 系不看官方模板参数', proxyConfigText({ ...INPUT, kind: 'bungeecord' }, TEMPLATE).includes('listeners:'))

console.log('\nJava 要求与 MCDR handler：')
check('Velocity 按 17 算（不会被版本号带跑）', proxyJavaMajor('velocity', '3.4.0') === 17)
check('BungeeCord 构建号不会算成 Java 25', proxyJavaMajor('bungeecord', '2100') === 17)
check('Waterfall 跟着 MC 版本走', proxyJavaMajor('waterfall', '1.21') === 21)
check('提示文案对得上', proxyJavaHintText('velocity', '3.4.0').includes('Java 17+'))
check('三种代理端都有 handler', ['velocity', 'bungeecord', 'waterfall'].every((k) => handlerFor(k as never, '').includes('_handler')))

// ---------------------------------------------------------------- 真实模板（可选）
//
// 要读文件，所以包在 async 函数里（esbuild 打成 cjs 时不支持顶层 await）。
async function checkOfficialTemplate(): Promise<void> {
  const JAR = join(resolve('.'), 'tmp', 'proxy-probe', 'velocity.jar')
  if (!existsSync(JAR)) {
    console.log('\n（跳过官方模板实测：tmp/proxy-probe/velocity.jar 不在）')
    return
  }
  console.log('\n用官方 jar 里的 default-velocity.toml 真跑一遍：')
  const zip = await ZipReader.open(JAR)
  const official = await zip?.read('default-velocity.toml')
  await zip?.close()
  if (official) {
    const applied = patchVelocityToml(official, INPUT)
    const p = parseVelocityToml(applied)
    const get = (k: string): string | undefined => p.fields.find((f) => f.key === k)?.value
    check('官方模板被改后 bind 正确', get('bind') === '0.0.0.0:25566', String(get('bind')))
    check('官方模板被改后 motd 正确', get('motd') === '我的跨服入口')
    check('官方模板的 config-version 保住了', applied.includes('config-version'))
    check('官方模板的注释没丢', (applied.match(/^#/gm) || []).length > 50, String((applied.match(/^#/gm) || []).length))
    check('规模基本没变（只改了值）', Math.abs(applied.length - official.length) < 120, `${official.length} → ${applied.length}`)
  } else {
    check('jar 里能读到 default-velocity.toml', false)
  }
}

void checkOfficialTemplate().then(() => {
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
})
