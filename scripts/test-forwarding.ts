/**
 * 验证「这台服务端能不能当代理端的后端」的判定。
 *
 * 判定错了两头都难看：把没装转发模组的服务器当成后端，它会挂在代理端下面
 * 带着个红标签（用户以为代理端配错了）；把装了原生转发的 Paper 后端判成
 * 不是后端，它又会从代理端子树里掉出去。
 *
 * npx esbuild scripts/test-forwarding.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-forwarding.cjs && node tmp/test-forwarding.cjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { probeProxyReady, yamlFlagUnder } from '../src/main/forwarding'
import type { ServerLayout } from '../src/main/layout'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`)
}

const BASE = join(process.cwd(), 'tmp', 'fwd-test')

function layoutOf(core: string, mods: string | null): ServerLayout {
  return {
    root: core,
    core,
    coreRel: '',
    isMcdr: false,
    mcdrStartCommand: null,
    mcdrPluginsDir: null,
    mcdrConfigDir: null,
    mcdrConfigFile: null,
    mcPluginsDir: null,
    modsDir: mods,
    configDir: null,
    serverProperties: join(core, 'server.properties'),
    playersDir: core,
    isProxy: false,
    proxyConfigFile: null,
    configuredPort: 25565
  } as ServerLayout
}

async function server(name: string, files: Record<string, string>, withMods = true): Promise<ServerLayout> {
  const core = join(BASE, name)
  const mods = join(core, 'mods')
  await fs.mkdir(mods, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const p = join(core, rel)
    await fs.mkdir(join(p, '..'), { recursive: true })
    await fs.writeFile(p, content, 'utf-8')
  }
  return layoutOf(core, withMods ? mods : null)
}

async function main(): Promise<void> {
  await fs.rm(BASE, { recursive: true, force: true })

  console.log('══ Fabric + FabricProxy-Lite ══')
  const fabric = await server('fabric', {
    'mods/FabricProxy-Lite-2.0.0.jar': 'x',
    'config/FabricProxy-Lite.toml': 'secret = "abc"\n'
  })
  check('算后端', (await probeProxyReady(fabric, 'fabric')).ready, true)
  check('说明是哪个模组', (await probeProxyReady(fabric, 'fabric')).via, 'FabricProxy-Lite')

  console.log('\n══ Fabric + FabricProxy-Lite 接 BungeeCord ══')
  // Lite 版只支持 Velocity：Bungee 连上来会被它的 disconnectMessage 踢掉
  check('Lite 版不能当 Bungee 后端', (await probeProxyReady(fabric, 'fabric', 'bungee')).ready, false)
  check('仍能指出是 Lite 版', (await probeProxyReady(fabric, 'fabric', 'bungee')).via, 'FabricProxy-Lite')

  const fabricFull = await server('fabric-full', {
    'mods/FabricProxy-2.0.0.jar': 'x',
    'config/FabricProxy/config.toml': 'secret = "abc"\n'
  })
  check('完整版 FabricProxy 可以接 Bungee', (await probeProxyReady(fabricFull, 'fabric', 'bungee')).ready, true)

  console.log('\n══ 什么都没装的 Fabric ══')
  const bare = await server('bare', { 'mods/sodium.jar': 'x' })
  check('不算后端', (await probeProxyReady(bare, 'fabric')).ready, false)
  check('没有转发方式', (await probeProxyReady(bare, 'fabric')).via, null)

  console.log('\n══ Paper + 原生 Velocity 转发 ══')
  const paper = await server('paper', {
    'config/paper-global.yml': [
      '_version: 29',
      'proxies:',
      '  proxy-protocol: false',
      '  velocity:',
      '    enabled: true   # 打开原生转发',
      '    online-mode: true',
      '    secret: abc',
      '  bungee-cord:',
      '    online-mode: false'
    ].join('\n')
  })
  check('算后端', (await probeProxyReady(paper, 'paper')).ready, true)
  check('说明是原生转发', (await probeProxyReady(paper, 'paper')).via, 'Paper 原生 Velocity 转发')

  console.log('\n══ Paper 原生转发关着 ══')
  const paperOff = await server('paper-off', {
    'config/paper-global.yml': 'proxies:\n  velocity:\n    enabled: false\n'
  })
  check('不算后端', (await probeProxyReady(paperOff, 'paper')).ready, false)
  // 开了原生 Velocity 转发，但接的是 Bungee：这条转发对 Bungee 无效
  check('Paper 原生转发不能当 Bungee 后端', (await probeProxyReady(paper, 'paper', 'bungee')).ready, false)

  console.log('\n══ Paper + BungeeCord 传统转发 ══')
  const bungee = await server('bungee', {
    'spigot.yml': 'settings:\n  bungeecord: true\n  restart-on-crash: true\n'
  })
  check('算后端', (await probeProxyReady(bungee, 'paper')).ready, true)
  check('说明是 BungeeCord', (await probeProxyReady(bungee, 'paper')).via, 'BungeeCord 转发')
  check('Bungee 代理下同样算后端', (await probeProxyReady(bungee, 'paper', 'bungee')).ready, true)

  console.log('\n══ 有 mods 目录但没装转发模组 ══')
  const modsNoFw = await server('mods-no-fw', { 'mods/lithium.jar': 'x', 'config/paper-global.yml': 'proxies:\n' })
  check('不算后端', (await probeProxyReady(modsNoFw, 'paper')).ready, false)

  console.log('\n══ 缩进解析的边界 ══')
  check(
    '同级后面的键不算',
    yamlFlagUnder('proxies:\n  velocity:\n    enabled: false\n    online-mode: true\n', ['proxies', 'velocity', 'enabled'], 'true'),
    false
  )
  check(
    '块结束后不再往里找',
    yamlFlagUnder('proxies:\n  velocity:\n    enabled: false\nother:\n  enabled: true\n', ['proxies', 'velocity', 'enabled'], 'true'),
    false
  )
  check(
    '注释里的不算',
    yamlFlagUnder('spigot.yml: x\nsettings:\n  # bungeecord: true\n  bungeecord: false\n', ['settings', 'bungeecord'], 'true'),
    false
  )
  check(
    '引号包起来的 true 也算',
    yamlFlagUnder('settings:\n  bungeecord: "true"\n', ['settings', 'bungeecord'], 'true'),
    true
  )

  await fs.rm(BASE, { recursive: true, force: true })
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
