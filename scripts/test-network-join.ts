/**
 * 跨服接入：配置补丁与一次真实的「加进 BungeeCord + 配置 Paper 后端」。
 *
 * 这些改动会写用户的真实文件，所以哪怕是小函数也值得单独测：
 * YAML 嵌套少缩进一格，BungeeCord 就会启动失败；server.properties 覆盖错，
 * 整台服务器的设置都会消失。
 *
 * npx esbuild scripts/test-network-join.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-network-join.cjs && node tmp/test-network-join.cjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import type { ServerConfig } from '../src/shared/types'
import {
  fabricLoaderFromLauncher,
  findJoinedNetwork,
  leaveNetwork,
  loaderSupportsProxyForward,
  setTomlSection,
  setTomlTopLevel,
  setYamlPath
} from '../src/main/networkJoin'
import { joinServerToNetwork } from '../src/main/networkJoin'
import { bungeeConfigYaml } from '../src/main/proxySetup'
import { writeProperties } from '../src/main/properties'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(
    `  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`
  )
}
function includes(label: string, text: string, needle: string): void {
  check(label, text.includes(needle), true)
}

const BASE = join(process.cwd(), 'tmp', 'test-network-join')

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 造一个只有一个文件的 zip，用来测 Fabric 启动 jar 的 manifest 读取 */
function makeZip(name: string, content: string): Buffer {
  const nameBuf = Buffer.from(name)
  const data = deflateRawSync(Buffer.from(content))
  const crc = 0 // 读取端不解压校验

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(Buffer.byteLength(content), 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(Buffer.byteLength(content), 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(0, 42)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + nameBuf.length, 12)
  eocd.writeUInt32LE(local.length + nameBuf.length + data.length, 16)

  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd])
}

function makeServer(partial: Partial<ServerConfig>): ServerConfig {
  return {
    id: 'id',
    name: 'server',
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
    kind: 'paper',
    mcVersion: '1.20.1',
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
    networkId: '',
    networkAlias: '',
    ...partial
  }
}

async function main(): Promise<void> {
  await fs.rm(BASE, { recursive: true, force: true })
  await fs.mkdir(BASE, { recursive: true })

  // ------------------------------------------------------------ 纯文本补丁
  const y1 = setYamlPath(
    'proxies:\n  velocity:\n    enabled: false\n    online-mode: true\n',
    ['proxies', 'velocity', 'enabled'],
    'true'
  )
  includes('YAML 已有的嵌套键被替换', y1, 'enabled: true')
  check('YAML 保留原有缩进', y1.includes('    enabled: true'), true)

  const y2 = setYamlPath('settings:\n  bungeecord: false\n', ['settings', 'bungeecord'], 'true')
  includes('YAML 顶层段落里的键被替换', y2, '  bungeecord: true')

  const y3 = setYamlPath('', ['proxies', 'velocity', 'secret'], "a'b")
  includes('YAML 空文件补出嵌套结构', y3, 'proxies:\n  velocity:\n    secret:')
  includes('YAML 字符串转义单引号', y3, "a''b")

  const y4 = setYamlPath(
    'proxies:\n  velocity:\n    enabled: true\nother: 1\n',
    ['proxies', 'velocity', 'secret'],
    'abc'
  )
  includes('YAML 缺键插在同级段末尾', y4, '    secret: \'abc\'\nother: 1')

  const t1 = setTomlTopLevel('secret = ""\nhackOnlineMode = false\n', 'secret', '"x"')
  includes('TOML 顶层键被替换', t1, 'secret = "x"')
  const t2 = setTomlTopLevel('[forwarding]\nmode = "MODERN"\n', 'secret', '"s"')
  check(
    'TOML 新键插在第一个 section 之前',
    t2.indexOf('secret = "s"') < t2.indexOf('[forwarding]'),
    true
  )
  const t3 = setTomlSection('[forwarding]\nmode = "MODERN"\n', 'forwarding', {
    mode: '"LEGACY"',
    enabled: 'true'
  })
  includes('TOML 段落键被替换', t3, 'mode = "LEGACY"')
  includes('TOML 段落缺失键被补上', t3, 'enabled = true')

  // ProxyForward 的 classTweaker v2 需要 Fabric Loader 0.19+
  check('Loader 0.18.6 不支持 ProxyForward', loaderSupportsProxyForward('0.18.6'), false)
  check('Loader 0.19.0 支持 ProxyForward', loaderSupportsProxyForward('0.19.0'), true)
  check('Loader 0.20.1 支持 ProxyForward', loaderSupportsProxyForward('0.20.1'), true)

  // 启动 jar 的 Class-Path 里写死了实际使用的 Loader；目录里可能还留着旧版本
  const launcher = makeZip(
    'META-INF/MANIFEST.MF',
    'Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.loader.impl.launch.server.FabricServerLauncher\r\n' +
      'Class-Path: libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar libraries/net/fabricmc/fabric-lo\r\n' +
      ' ader/0.20.1/fabric-loader-0.20.1.jar\r\n'
  )
  check('从启动 jar 读取实际 Loader 版本', fabricLoaderFromLauncher(launcher), '0.20.1')

  // ------------------------------------------------------------ 真实目录
  const proxyDir = join(BASE, 'proxy')
  const paperDir = join(BASE, 'paper')
  await fs.mkdir(proxyDir, { recursive: true })
  await fs.mkdir(paperDir, { recursive: true })

  await fs.writeFile(
    join(proxyDir, 'config.yml'),
    bungeeConfigYaml({
      kind: 'bungeecord',
      port: 45000,
      motd: 'test',
      onlineMode: true
    }),
    'utf-8'
  )
  // 新生成的代理端配置应当默认打开这两个开关
  const fresh = await fs.readFile(join(proxyDir, 'config.yml'), 'utf-8')
  includes('新建 BungeeCord 默认开启 ip_forward', fresh, 'ip_forward: true')
  includes('新建 BungeeCord 默认开启 forge_support', fresh, 'forge_support: true')

  await writeProperties(join(paperDir, 'server.properties'), [
    { key: 'server-port', value: '25666' },
    { key: 'online-mode', value: 'true' },
    { key: 'motd', value: 'keep me' }
  ])
  await fs.writeFile(
    join(paperDir, 'spigot.yml'),
    'settings:\n  bungeecord: false\n  save-user-cache-on-stop-only: false\n',
    'utf-8'
  )

  const proxy = makeServer({
    id: 'proxy',
    name: '入口',
    dir: proxyDir,
    kind: 'bungeecord',
    networkId: ''
  })
  const paper = makeServer({
    id: 'paper',
    name: 'Survival',
    dir: paperDir,
    kind: 'paper',
    networkId: '',
    networkAlias: ''
  })

  const result = await joinServerToNetwork(paper, proxy)
  check('别名是 ASCII 短横线形式', result.alias, 'survival')
  check('返回的地址', result.address, '127.0.0.1:25666')

  const proxyText = await fs.readFile(join(proxyDir, 'config.yml'), 'utf-8')
  includes('后端被写进 servers:', proxyText, 'survival:')
  check('后端地址正确', proxyText.includes('address: 127.0.0.1:25666'), true)
  includes('新后端进入 priorities', proxyText, '- survival')
  includes('ip_forward 被打开', proxyText, 'ip_forward: true')
  includes('online_mode 被关闭', proxyText, 'online_mode: false')
  includes('forge_support 仍在', proxyText, 'forge_support: true')

  const spigot = await fs.readFile(join(paperDir, 'spigot.yml'), 'utf-8')
  includes('spigot.yml 打开 bungeecord', spigot, '  bungeecord: true')
  includes('spigot.yml 其它设置保留', spigot, 'save-user-cache-on-stop-only: false')

  const props = await fs.readFile(join(paperDir, 'server.properties'), 'utf-8')
  includes('后端 online-mode 关闭', props, 'online-mode=false')
  includes('server.properties 其它设置保留', props, 'motd=keep me')

  // 重复接入：不应该产生第二条同名后端
  await joinServerToNetwork(paper, proxy)
  const again = await fs.readFile(join(proxyDir, 'config.yml'), 'utf-8')
  check('重复接入不会重复写条目', again.match(/survival:/g)?.length, 1)

  // 旧配置没有 networkId 时，按端口也能认出它挂在哪个代理端下面
  const found = await findJoinedNetwork(paper, [proxy, paper])
  check('按端口找到所属代理端', found?.proxy.id, 'proxy')
  check('按端口找到配置里的别名', found?.alias, result.alias)

  // ------------------------------------------------------------ 端口冲突
  // 后端和代理端用同一个端口时，加入网络必须自动换端口，而不是让两边抢绑定
  await writeProperties(join(paperDir, 'server.properties'), [
    { key: 'server-port', value: '45000' },
    { key: 'online-mode', value: 'true' },
    { key: 'motd', value: 'keep me' }
  ])
  const rejoined = await joinServerToNetwork(
    { ...paper, networkAlias: result.alias },
    proxy,
    undefined,
    [proxy, paper]
  )
  check('端口冲突时自动换端口', rejoined.backendPort !== 45000, true)
  check('换到了代理端端口之后的空闲端口', rejoined.backendPort > 45000, true)
  const propsAfter = await fs.readFile(join(paperDir, 'server.properties'), 'utf-8')
  includes('server.properties 写了新端口', propsAfter, `server-port=${rejoined.backendPort}`)
  includes('online-mode 仍是关闭的', propsAfter, 'online-mode=false')
  const proxyAfter = await fs.readFile(join(proxyDir, 'config.yml'), 'utf-8')
  includes('代理端地址跟着改了', proxyAfter, `address: 127.0.0.1:${rejoined.backendPort}`)
  check('没有多出重复条目', proxyAfter.match(/survival:/g)?.length, 1)
  check('冲突提示写进了 changes', rejoined.changes.some((c) => c.includes('冲突')), true)

  // ------------------------------------------------------------ Fabric + Bungee
  // 同时装了 Lite 和 Bungee 桥接时，必须停用 Lite，否则它会用「连接SB」把玩家踢掉
  const fabDir = join(BASE, 'fabric')
  await fs.mkdir(join(fabDir, 'mods'), { recursive: true })
  await fs.mkdir(join(fabDir, 'config'), { recursive: true })
  await fs.writeFile(join(fabDir, 'mods', 'FabricProxy-Lite-2.11.0.jar'), 'x')
  await fs.writeFile(join(fabDir, 'mods', 'fabricproxy-1.9.0.jar'), 'x')
  await fs.writeFile(join(fabDir, 'config', 'FabricProxy.toml'), 'BungeeCord = false\n')
  await writeProperties(join(fabDir, 'server.properties'), [
    { key: 'server-port', value: '25670' },
    { key: 'online-mode', value: 'true' }
  ])
  const fab = makeServer({
    id: 'fab',
    name: 'Parkour',
    dir: fabDir,
    kind: 'fabric',
    mcVersion: '1.20.1'
  })
  await joinServerToNetwork(fab, proxy, undefined, [proxy, paper, fab])
  check('保留 Bungee 桥接 jar', await exists(join(fabDir, 'mods', 'fabricproxy-1.9.0.jar')), true)
  check(
    '停用 FabricProxy-Lite',
    await exists(join(fabDir, 'mods', 'FabricProxy-Lite-2.11.0.jar.disabled')),
    true
  )
  check(
    '桥接配置打开 BungeeCord',
    (await fs.readFile(join(fabDir, 'config', 'FabricProxy.toml'), 'utf-8')).includes(
      'BungeeCord = true'
    ),
    true
  )
  includes(
    '纯 Fabric 网络自动关闭 forge_support',
    await fs.readFile(join(proxyDir, 'config.yml'), 'utf-8'),
    'forge_support: false'
  )

  // ------------------------------------------------------------ 1.21.11 + ProxyForward
  // 旧桥接在 1.21.11 上会崩、Lite 会踢人；1.21.11 应该改用 ProxyForward
  const newDir = join(BASE, 'fabric-1211')
  await fs.mkdir(join(newDir, 'mods'), { recursive: true })
  await fs.mkdir(join(newDir, 'config'), { recursive: true })
  await fs.writeFile(join(newDir, 'mods', 'FabricProxy-Lite-2.11.0.jar'), 'x')
  await fs.writeFile(join(newDir, 'mods', 'fabricproxy-1.9.0.jar'), 'x')
  await fs.writeFile(join(newDir, 'mods', 'proxyforward-fabric-1.0.1+1.21.11.jar'), 'x')
  await writeProperties(join(newDir, 'server.properties'), [
    { key: 'server-port', value: '25671' },
    { key: 'online-mode', value: 'true' }
  ])
  const fab211 = makeServer({
    id: 'fab211',
    name: 'Parkour211',
    dir: newDir,
    kind: 'fabric',
    mcVersion: '1.21.11'
  })
  await joinServerToNetwork(fab211, proxy, undefined, [proxy, paper, fab211])
  check(
    '1.21.11 保留 ProxyForward',
    await exists(join(newDir, 'mods', 'proxyforward-fabric-1.0.1+1.21.11.jar')),
    true
  )
  check(
    '1.21.11 停用 Lite',
    await exists(join(newDir, 'mods', 'FabricProxy-Lite-2.11.0.jar.disabled')),
    true
  )
  check(
    '1.21.11 停用旧 Bungee 桥接',
    await exists(join(newDir, 'mods', 'fabricproxy-1.9.0.jar.disabled')),
    true
  )
  includes(
    'ProxyForward 配置为 bungee',
    await fs.readFile(join(newDir, 'config', 'proxyforward.toml'), 'utf-8'),
    'forwarding_mode = "bungee"'
  )

  // 导入时把 1.21.11 记成了 1.21.5（按 mods 文件名猜错）：接入时要按
  // intermediary 目录实际读到的版本选桥接，否则会装回会崩的旧桥接
  const wrongDir = join(BASE, 'fabric-wrong-version')
  await fs.mkdir(join(wrongDir, 'mods'), { recursive: true })
  await fs.mkdir(join(wrongDir, 'config'), { recursive: true })
  await fs.mkdir(
    join(wrongDir, 'libraries', 'net', 'fabricmc', 'intermediary', '1.21.11'),
    { recursive: true }
  )
  await fs.writeFile(join(wrongDir, 'mods', 'fabricproxy-1.9.0.jar'), 'x')
  await fs.writeFile(join(wrongDir, 'mods', 'FabricProxy-Lite-2.11.0.jar'), 'x')
  await fs.writeFile(join(wrongDir, 'mods', 'proxyforward-fabric-1.0.1+1.21.11.jar'), 'x')
  await writeProperties(join(wrongDir, 'server.properties'), [
    { key: 'server-port', value: '25672' },
    { key: 'online-mode', value: 'true' }
  ])
  const wrong = makeServer({
    id: 'wrong',
    name: 'WrongVersion',
    dir: wrongDir,
    kind: 'fabric',
    mcVersion: '1.21.5'
  })
  const wrongJoin = await joinServerToNetwork(wrong, proxy, undefined, [proxy, wrong])
  check('按实际目录识别出 1.21.11', wrongJoin.mcVersion, '1.21.11')
  check(
    '错记版本时仍停用旧桥接',
    await exists(join(wrongDir, 'mods', 'fabricproxy-1.9.0.jar.disabled')),
    true
  )
  check(
    '错记版本时仍保留 ProxyForward',
    await exists(join(wrongDir, 'mods', 'proxyforward-fabric-1.0.1+1.21.11.jar')),
    true
  )
  includes(
    '错记版本时配置仍是 bungee',
    await fs.readFile(join(wrongDir, 'config', 'proxyforward.toml'), 'utf-8'),
    'forwarding_mode = "bungee"'
  )

  // ------------------------------------------------------------ 移出网络
  const left = await leaveNetwork({ ...paper, networkAlias: result.alias }, proxy)
  check('移出时找到并删除了别名', left.alias, 'survival')
  check('移出成功', left.removed, true)
  check('移出后还剩 lobby 与三个 Fabric 后端', left.remaining, 4)
  check('移出后按端口也找不到了', await findJoinedNetwork(paper, [proxy, paper]), null)
  const afterLeave = await fs.readFile(join(proxyDir, 'config.yml'), 'utf-8')
  check('移出后 servers 里没有该条目', afterLeave.includes('survival:'), false)

  console.log(`\n共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`)
  if (fail) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
