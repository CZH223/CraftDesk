/**
 * 验证扩展之间的依赖关系。
 *
 * 前半段是构造出来的样本：五种加载器的描述文件格式各写各的，
 * 解析错了不会报错，只会显示成「没有前置」——用户看不出来，所以要有断言。
 *
 * 后半段是拿真实的服务器目录跑一遍：关系图最怕的是**误报**，
 * 比如把 minecraft 当成缺失的前置，或者因为 Fabric API 把 44 个小模组
 * 打包在 META-INF/jars 里就报「缺 fabric-api-base」。这些只有跑真目录才发现。
 *
 * npx esbuild scripts/test-relations.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-relations.cjs && node tmp/test-relations.cjs [服务器目录 ...]
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  readJarMeta,
  parseBukkitMeta,
  parseBungeeMeta,
  parseFabricMeta,
  parseMcdrDeps,
  parseModsToml,
  parseVelocityMeta
} from '../src/main/extmeta'
import { buildRelations, normId } from '../src/main/relations'
import { listPlugins } from '../src/main/plugins'
import { resolveLayout } from '../src/main/layout'
import type { PluginInfo, ServerConfig, ServerKind } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

function serverConfig(patch: Partial<ServerConfig>): ServerConfig {
  return {
    id: 'test',
    name: '测试',
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
    kind: 'fabric' as ServerKind,
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

/** 造一个只用于算关系的条目 */
function item(patch: Partial<PluginInfo>): PluginInfo {
  return {
    id: '',
    name: '',
    file: '',
    path: '',
    size: 0,
    enabled: true,
    kind: 'mod',
    version: '',
    author: '',
    description: '',
    dependencies: [],
    group: 'mods',
    depends: [],
    softDepends: [],
    provides: [],
    breaks: [],
    ranges: {},
    broken: false,
    requires: [],
    usedBy: [],
    ...patch
  }
}

function unitTests(): void {
  console.log('══ Fabric：fabric.mod.json ══')
  const fab = parseFabricMeta(
    JSON.stringify({
      id: 'architectury',
      name: 'Architectury',
      version: '19.0.1',
      authors: ['shedaniel'],
      description: { zh_cn: '架构前置', en_us: 'Architecture' },
      depends: { minecraft: '~1.21.11', fabricloader: '>=0.15.4', 'fabric-api': '>=0.127.0' },
      recommends: { 'cloth-config': '*' },
      suggests: { 'modmenu': '*' },
      provides: ['arch-api'],
      breaks: { optifabric: '<1.13.0' }
    })
  )!
  check('id / 名称 / 版本', fab.id === 'architectury' && fab.version === '19.0.1')
  check('中文描述优先', fab.description === '架构前置', fab.description)
  check('硬前置解析成 3 项', fab.depends.length === 3, fab.depends.join(', '))
  check('软前置合并 recommends 与 suggests', fab.softDepends.length === 2, fab.softDepends.join(', '))
  check('软前置里不会重复硬前置', !fab.softDepends.includes('fabric-api'))
  check('版本范围被记下来', fab.ranges['fabric-api'] === '>=0.127.0', fab.ranges['fabric-api'])
  check('provides 解析', fab.provides.includes('arch-api'))
  check('breaks 解析', fab.breaks.includes('optifabric'))

  console.log('\n══ Forge / NeoForge：mods.toml ══')
  const toml = parseModsToml(`
modLoader="javafml"
loaderVersion="[47,)"
license="MIT"

[[mods]]
modId="examplemod"
version="2.1.0"
displayName="Example Mod"
authors="someone"
description='''一个例子'''

[[dependencies.examplemod]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20.1,1.21)"
    ordering="NONE"
    side="BOTH"

[[dependencies.examplemod]]
    modId="forge"
    mandatory=true
    versionRange="[47,)"
    ordering="NONE"
    side="BOTH"

[[dependencies.examplemod]]
    modId="curios"
    mandatory=false
    versionRange="[5.2,)"
    ordering="AFTER"
    side="BOTH"
`)
  check('从 [[mods]] 里取到 id', toml.id === 'examplemod', toml.id)
  check('取到显示名与版本', toml.name === 'Example Mod' && toml.version === '2.1.0')
  check('只把 mandatory 的算硬前置', toml.depends.join(',') === 'minecraft,forge', toml.depends.join(','))
  check('mandatory=false 归到软前置', toml.softDepends.includes('curios'), toml.softDepends.join(','))
  check('版本范围记在正确的 id 上', toml.ranges.minecraft === '[1.20.1,1.21)', toml.ranges.minecraft)
  // 依赖块里的 modId 不能当成模组自己的 id——这是最容易写错的地方
  check('没把自己的 id 认成 minecraft', toml.id !== 'minecraft')

  console.log('\n══ Bukkit / Bungee / Velocity / MCDR ══')
  const bukkit = parseBukkitMeta(`
name: MyPlugin
version: 1.2.3
author: someone
depend: [Vault, PlaceholderAPI]
softdepend:
  - LuckPerms
loadbefore: [ProtocolLib]
provides: [MyPluginAPI]
`)
  check('plugin.yml 硬前置', bukkit.depends.join(',') === 'Vault,PlaceholderAPI', bukkit.depends.join(','))
  check('softdepend 与 loadbefore 都算软前置', bukkit.softDepends.length === 2, bukkit.softDepends.join(','))
  check('provides 解析', bukkit.provides.includes('MyPluginAPI'))

  const bungee = parseBungeeMeta(`
name: MyBungee
main: com.example.Main
version: 1.0
depends: [BungeeTabListPlus]
softDepends: [LuckPerms]
`)
  check('bungee.yml 依赖', bungee.depends[0] === 'BungeeTabListPlus' && bungee.softDepends[0] === 'LuckPerms')

  const vel = parseVelocityMeta(
    JSON.stringify({
      id: 'myproxy',
      name: 'MyProxy',
      version: '1.0',
      authors: ['someone'],
      dependencies: [
        { id: 'velocity', optional: false },
        { id: 'luckperms', optional: true }
      ]
    })
  )!
  check('velocity-plugin.json 依赖', vel.depends[0] === 'velocity' && vel.softDepends[0] === 'luckperms')

  const mcdr = parseMcdrDeps({
    mcdreforged: '>=2.0.0',
    'minecraft_data_api': '>=1.4.0',
    'player_list': { predicate: '>=1.0' }
  })
  check('MCDR 依赖剔除 mcdreforged 自身', !mcdr.hard.includes('mcdreforged'), mcdr.hard.join(','))
  check('MCDR 版本要求（对象写法）', mcdr.ranges.player_list === '>=1.0', mcdr.ranges.player_list)

  console.log('\n══ 关系图 ══')
  const items: PluginInfo[] = [
    item({ id: 'fabric-api', name: 'Fabric API', path: 'mods/fabric-api.jar' }),
    item({ id: 'fabric-api-base', name: 'Fabric API Base', path: 'mods/fabric-api.jar' }), // 同一个 jar 提供的
    item({ id: 'cloth-config', name: 'Cloth Config', path: 'mods/cloth.jar', provides: ['cloth-config2'] }),
    item({ id: 'sodium', name: 'Sodium', path: 'mods/sodium.jar', enabled: false }),
    item({
      id: 'examplemod',
      name: 'Example',
      path: 'mods/example.jar',
      depends: ['minecraft', 'fabricloader', 'fabric-api-base', 'sodium'],
      softDepends: ['modmenu', 'cloth-config2'],
      ranges: { 'fabric-api-base': '>=1.0' }
    })
  ]
  buildRelations(items)
  const example = items.find((i) => i.id === 'examplemod')!
  const edge = (id: string): PluginInfo['requires'][number] => example.requires.find((e) => e.id === id)!

  check('平台 id（minecraft）不算缺失', edge('minecraft').state === 'platform')
  check('平台 id（fabricloader）不算缺失', edge('fabricloader').state === 'platform')
  check('嵌套提供的 id 能找到', edge('fabric-api-base').state === 'ok')
  check('被禁用的前置标成 disabled', edge('sodium').state === 'disabled')
  check('禁用前置能指到是哪个文件', edge('sodium').provider === 'mods/sodium.jar')
  check('provides 也能满足依赖（cloth-config2）', edge('cloth-config2').state === 'ok')
  check('软前置缺失不标红', edge('modmenu').state === 'missing' && !edge('modmenu').hard)
  check('版本要求带在边上', edge('fabric-api-base').range === '>=1.0')

  const cloth = items.find((i) => i.id === 'cloth-config')!
  check('反向索引：谁依赖我', cloth.usedBy.length === 1 && cloth.usedBy[0].name === 'Example')
  check('反向索引标出软依赖', cloth.usedBy[0].soft === true)

  const missingOnly: PluginInfo[] = [
    item({ id: 'a', name: 'A', path: 'mods/a.jar', depends: ['nowhere'] })
  ]
  buildRelations(missingOnly)
  check('真的缺失才算缺失', missingOnly[0].requires[0].state === 'missing')
  check('id 规范化（大小写 / 空格）', normId('  Fabric-API ') === 'fabric-api')

  console.log('\n══ 生效范围（在服务端有没有用）══')
  const def = parseFabricMeta('{"id":"x","version":"1","depends":{}}')!
  check('Fabric 没写 environment 时默认两边都要', def.side === 'both', def.side)
  const asClient = parseFabricMeta('{"id":"x","version":"1","environment":"client"}')!
  check('environment: client → client', asClient.side === 'client')
  const asServer = parseFabricMeta('{"id":"x","version":"1","environment":"server"}')!
  check('environment: server → server', asServer.side === 'server')
  const asBoth = parseFabricMeta('{"id":"x","version":"1","environment":"*"}')!
  check('environment: * → both', asBoth.side === 'both')
  check('Bukkit 插件天然是服务端侧', parseBukkitMeta('name: A\nversion: 1').side === 'server')
  check('代理插件也是服务端侧', parseBungeeMeta('name: B\nversion: 1').side === 'server')
  // Forge 的 mods.toml 里没有这个字段，不猜
  check('Forge 系只能是 unknown', parseModsToml('[[mods]]\nmodId="x"\nversion="1"').side === 'unknown')

  console.log('\n══ 容错：BOM 与坏文件 ══')
  // 真有模组（BetterGrassify）的描述文件带 BOM，JSON.parse 会直接抛异常，
  // 结果它在依赖图里成了一个谁也不认识的空条目
  const bom = parseFabricMeta(
    String.fromCharCode(0xfeff) + '{"id":"bommod","version":"1.0","depends":{"minecraft":"*"}}'
  )
  check('带 BOM 的 fabric.mod.json 也能解析', bom?.id === 'bommod', bom?.id ?? '(解析失败)')

  // 字符串里带裸换行：不合 JSON 规范，但 Fabric Loader 认。
  // 严格解析会让 BetterGrassify 这类模组读不出 id 与前置。
  const raw = parseFabricMeta(
    '{"id":"rawmod","version":"1.0","description":"第一行\n第二行","depends":{"fabric-api":"*"}}'
  )
  check('字符串里有裸换行也能解析', raw?.id === 'rawmod', raw?.id ?? '(解析失败)')
  check('裸换行不影响后面的字段', raw?.depends[0] === 'fabric-api', raw?.depends.join(',') ?? '')

  // 真 · 坏 JSON 仍然要老老实实返回 null，不能瞎猜
  check('真正的坏 JSON 返回 null', parseFabricMeta('{"id": ') === null)
}

/** 坏文件：zip 结构不完整时不能装作「这个文件没有元数据」 */
async function brokenFileTest(): Promise<void> {
  console.log('\n══ 容错：坏文件 ══')
  const dir = resolve('tmp', 'relations-broken')
  await fs.mkdir(dir, { recursive: true })

  // 一个只有本地文件头、没有中央目录的「zip」——下载被截断就是这样
  const truncated = join(dir, 'truncated.jar')
  await fs.writeFile(truncated, Buffer.concat([Buffer.from('PK'), Buffer.alloc(200, 7)]))
  const meta = await readJarMeta(truncated)
  check('截断的 jar 标成 broken', meta.broken, JSON.stringify({ id: meta.id, broken: meta.broken }))

  const notZip = join(dir, 'notzip.jar')
  await fs.writeFile(notZip, 'this is not a jar at all')
  check('不是 zip 的文件也标成 broken', (await readJarMeta(notZip)).broken)

  await fs.rm(dir, { recursive: true, force: true })
}

async function realServer(dir: string): Promise<void> {
  if (!(await exists(dir))) {
    console.log(`\n（跳过 ${dir}：目录不存在）`)
    return
  }
  console.log(`\n══ 真实目录：${dir} ══`)
  const cfg = serverConfig({ dir, coreDir: 'server', mcdr: true, kind: 'fabric' })
  // 核心目录可能是 server/，也可能就在根目录
  const layout = await resolveLayout({ ...cfg, coreDir: (await exists(join(dir, 'server'))) ? 'server' : '' })

  const started = Date.now()
  const items = await listPlugins(layout)
  const ms = Date.now() - started

  const mods = items.filter((i) => i.kind === 'mod')
  const withDeps = mods.filter((m) => m.depends.length > 0)
  const missing = new Map<string, string[]>()
  const disabled = new Map<string, string[]>()
  for (const m of items) {
    for (const e of m.requires) {
      if (!e.hard) continue
      const bucket = e.state === 'missing' ? missing : e.state === 'disabled' ? disabled : null
      if (!bucket) continue
      bucket.set(e.id, [...(bucket.get(e.id) ?? []), m.name])
    }
  }

  console.log(
    `     扫到 ${items.length} 个扩展（模组 ${mods.length} 个，其中 ${withDeps.length} 个声明了前置），耗时 ${ms} ms`
  )
  const top = [...items]
    .filter((i) => i.usedBy.length > 0)
    .sort((a, b) => b.usedBy.length - a.usedBy.length)
    .slice(0, 8)
  console.log('     被依赖最多的：')
  for (const t of top) {
    console.log(`       ${t.name} ← ${t.usedBy.length} 个（${t.id || t.file}）`)
  }

  const brokenMods = mods.filter((m) => m.broken)
  check(
    '读不出 id 的都是「文件损坏」这一类',
    mods.every((m) => m.id !== '' || m.broken),
    mods.filter((m) => !m.id && !m.broken).map((m) => m.file).join(', ') || '（没有）'
  )
  if (brokenMods.length) {
    console.log('     文件损坏（zip 结构不完整，Java 也读不了，得重新下载）：')
    for (const b of brokenMods) console.log(`       ${b.file}`)
  }
  check(
    '没有把平台 id 报成缺失',
    ![...missing.keys()].some((id) =>
      ['minecraft', 'java', 'forge', 'neoforge', 'fabricloader', 'fabric'].includes(normId(id))
    ),
    [...missing.keys()].join(',') || '（无缺失）'
  )
  check('已装模组之间没有互相报缺失（抽样）', missing.size < mods.length * 0.5, `${missing.size} 个缺失 id`)

  // 生效范围：Fabric 一定读得出来（要么声明、要么默认 both），插件必须是服务端侧
  const sides = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.side] = (acc[i.side] ?? 0) + 1
    return acc
  }, {})
  const intact = mods.filter((m) => !m.broken)
  const clientMods = intact.filter((m) => m.side === 'client')
  console.log(
    `     生效范围：仅客户端 ${sides.client ?? 0} · 仅服务端 ${sides.server ?? 0}` +
      ` · 两边都要 ${sides.both ?? 0} · 未知 ${sides.unknown ?? 0}`
  )
  if (clientMods.length) {
    console.log('     仅客户端的（服务端会加载，但不起作用）：')
    for (const m of clientMods.slice(0, 8)) console.log(`       ${m.name}`)
    if (clientMods.length > 8) console.log(`       …等 ${clientMods.length} 个`)
  }
  check(
    'Fabric 模组的生效范围都读得出来（不会留下 unknown）',
    intact.every((m) => m.side !== 'unknown'),
    intact.filter((m) => m.side === 'unknown').map((m) => m.file).join(',') || '（都读到了）'
  )
  check(
    '插件与 MCDR 插件的生效范围都是 server',
    items.filter((i) => i.kind !== 'mod' && !i.broken).every((i) => i.side === 'server')
  )

  if (missing.size) {
    console.log('     缺失的前置：')
    for (const [id, by] of [...missing.entries()].slice(0, 15)) {
      console.log(`       ${id}  ← ${by.slice(0, 3).join('、')}${by.length > 3 ? ` 等 ${by.length} 个` : ''}`)
    }
  }
  if (disabled.size) {
    console.log('     被禁用的前置：')
    for (const [id, by] of [...disabled.entries()].slice(0, 10)) {
      console.log(`       ${id}  ← ${by.join('、')}`)
    }
  }
  if (!missing.size && !disabled.size) console.log('     没有缺前置，也没有被禁用的前置')
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
  await brokenFileTest()

  const targets = process.argv.slice(2)
  if (targets.length) {
    for (const t of targets) await realServer(resolve(t))
  } else {
    console.log('\n（没给参数，只跑了合成用例）')
    console.log('  想看真实数据：node tmp/test-relations.cjs <服务器目录> [另一个服务器目录]')
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
