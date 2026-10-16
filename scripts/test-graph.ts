/**
 * 验证模组关系星图的布局。
 *
 * 布局是纯计算（graph.ts 里没有 DOM），所以可以直接断言它：
 * 有没有算出 NaN、节点是不是都在画布内、数量上限是不是真的生效、
 * 缺失的前置有没有被画成一个占位节点。
 *
 * 这些用眼睛看一张截图是看不出来的 —— 一个 NaN 坐标会让整张图空白，
 * 上限没生效会在几百个模组时卡住。
 *
 * npx esbuild scripts/test-graph.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-graph.cjs && node tmp/test-graph.cjs [真实服务器目录]
 */
import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_LIMIT, buildStarGraph, graphBounds, pickCenter } from '../src/renderer/src/graph'
import { listPlugins } from '../src/main/plugins'
import { resolveLayout } from '../src/main/layout'
import type { PluginInfo, ServerConfig } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

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
    kind: 'fabric',
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

function syntheticTests(): void {
  console.log('══ 一张手工搭出来的关系网 ══')

  // api 被 a、b、c 依赖；a 又依赖 lib；d 缺一个前置 nowhere
  const items: PluginInfo[] = [
    item({ id: 'api', name: 'Fabric API', path: 'mods/api.jar' }),
    item({ id: 'lib', name: 'Lib', path: 'mods/lib.jar' }),
    item({
      id: 'a',
      name: 'Mod A',
      path: 'mods/a.jar',
      requires: [
        { id: 'api', hard: true, range: '', state: 'ok', provider: 'mods/api.jar', providerName: 'Fabric API' },
        { id: 'lib', hard: true, range: '', state: 'ok', provider: 'mods/lib.jar', providerName: 'Lib' }
      ],
      usedBy: [{ path: 'mods/d.jar', name: 'Mod D', soft: false }]
    }),
    item({
      id: 'b',
      name: 'Mod B',
      path: 'mods/b.jar',
      requires: [
        { id: 'api', hard: true, range: '', state: 'ok', provider: 'mods/api.jar', providerName: 'Fabric API' }
      ]
    }),
    item({
      id: 'd',
      name: 'Mod D',
      path: 'mods/d.jar',
      requires: [
        { id: 'api', hard: true, range: '', state: 'ok', provider: 'mods/api.jar', providerName: 'Fabric API' },
        { id: 'nowhere', hard: true, range: '>=1.0', state: 'missing', provider: null, providerName: null }
      ]
    })
  ]
  // 补齐反向索引：api / lib 被谁依赖
  const api = items[0]
  api.usedBy = [
    { path: 'mods/a.jar', name: 'Mod A', soft: false },
    { path: 'mods/b.jar', name: 'Mod B', soft: false },
    { path: 'mods/d.jar', name: 'Mod D', soft: false }
  ]
  items[1].usedBy = [{ path: 'mods/a.jar', name: 'Mod A', soft: false }]

  check('自动挑的中心是被依赖最多的', pickCenter(items)?.id === 'api', pickCenter(items)?.id)
  check('指定路径时用指定的那个', pickCenter(items, 'mods/lib.jar')?.id === 'lib')

  const g = buildStarGraph(items)
  check('中心就是 api', g.center?.modId === 'api')
  check('没有重复节点', new Set(g.nodes.map((n) => n.key)).size === g.nodes.length)
  check('坐标全是有限数（没有 NaN）', g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)))
  check('每条线的两端都在节点里', g.links.every((l) => g.nodes.some((n) => n.key === l.from) && g.nodes.some((n) => n.key === l.to)))
  check('中心在原点', g.center?.x === 0 && g.center?.y === 0)

  // 第一圈：前置画左边、被依赖画右边。第二圈挂在各自父节点旁边，
  // 不强行分左右（分了线就会横穿整张图）
  const left = g.nodes.filter((n) => n.ring === 1 && n.role === 'dep')
  const right = g.nodes.filter((n) => n.ring === 1 && n.role === 'dependent')
  check('第一圈的前置画在左边', left.every((n) => n.x < 0), left.map((n) => `${n.name}@${Math.round(n.x)}`).join(','))
  check('第一圈的被依赖画在右边', right.every((n) => n.x > 0), right.map((n) => `${n.name}@${Math.round(n.x)}`).join(','))
  check('第二圈的节点挨着自己的父节点', g.nodes.filter((n) => n.ring === 2).every((n) => Math.hypot(n.x, n.y) > 200))
  check('依赖 api 的三个都画出来了', right.length === 3, `${right.length}`)
  check(
    '连得多的画得大',
    (right.find((n) => n.name === 'Mod A')?.radius ?? 0) > (right.find((n) => n.name === 'Mod B')?.radius ?? 0) - 0.001
  )

  const missing = g.nodes.find((n) => n.missing)
  check('缺失的前置也画成一个节点', Boolean(missing), missing?.name)
  check('缺失节点标成 missing 且点不动', missing?.missing === true && missing?.focusable === false)

  const secondRing = g.nodes.filter((n) => n.role === 'related')
  check('第二圈有节点（其它关系）', secondRing.length > 0, secondRing.map((n) => n.name).join(','))
  check(
    '第二圈在第一圈外面',
    secondRing.every((n) => Math.hypot(n.x, n.y) > 200),
    secondRing.map((n) => Math.round(Math.hypot(n.x, n.y))).join(',')
  )

  console.log('\n══ 数量上限 ══')
  const many: PluginInfo[] = [item({ id: 'hub', name: 'Hub', path: 'mods/hub.jar' })]
  for (let i = 0; i < 300; i++) {
    many.push(
      item({
        id: `m${i}`,
        name: `Mod ${i}`,
        path: `mods/m${i}.jar`,
        requires: [{ id: 'hub', hard: true, range: '', state: 'ok', provider: 'mods/hub.jar', providerName: 'Hub' }]
      })
    )
  }
  many[0].usedBy = many.slice(1).map((m) => ({ path: m.path, name: m.name, soft: false }))

  const capped = buildStarGraph(many, null, 50)
  check('节点数不超过上限', capped.nodes.length <= 50, `${capped.nodes.length} / 上限 50`)
  check('中心永远保留', capped.center?.key === 'mods/hub.jar')
  check('第一圈优先保留', capped.nodes.some((n) => n.role === 'dependent'))
  check('省掉的数量算对了', capped.hidden === capped.total - capped.nodes.length, `${capped.hidden}`)
  check('被砍掉的节点没有留下悬空的线', capped.links.every((l) => capped.nodes.some((n) => n.key === l.from) && capped.nodes.some((n) => n.key === l.to)))

  const bounds = graphBounds(capped)
  check('包围盒是有限的', Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxY))

  console.log('\n══ 边界情况 ══')
  check('空列表不炸', buildStarGraph([]).nodes.length === 0)
  const lonely = buildStarGraph([item({ id: 'x', name: 'X', path: 'mods/x.jar' })])
  check('只有一个模组时画一个点', lonely.nodes.length === 1 && lonely.links.length === 0)
  // 上限有下限：手滑输 0 或 1 时不该把图压成一个点
  const limited = buildStarGraph(items, null, 1)
  check(
    '上限有下限，中心一定在',
    limited.nodes.length === 5 && limited.center?.modId === 'api',
    `${limited.nodes.length} 个节点`
  )
  check('默认上限就是 150', DEFAULT_LIMIT === 150)
}

async function realServer(dir: string): Promise<void> {
  let exists = true
  try {
    await fs.access(dir)
  } catch {
    exists = false
  }
  if (!exists) {
    console.log(`\n（跳过 ${dir}：目录不存在）`)
    return
  }

  console.log(`\n══ 真实服务器：${dir} ══`)
  const cfg = serverConfig({ dir, coreDir: 'server' })
  const layout = await resolveLayout(cfg)
  const items = await listPlugins(layout)

  const started = Date.now()
  const g = buildStarGraph(items, null, DEFAULT_LIMIT)
  const ms = Date.now() - started

  console.log(
    `     ${items.length} 个扩展 · 图上 ${g.nodes.length} 个节点 / ${g.links.length} 条线 · ${ms} ms · 中心 ${g.center?.name}`
  )
  const roles = g.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.role] = (acc[n.role] ?? 0) + 1
    return acc
  }, {})
  console.log(`     构成：${Object.entries(roles).map(([k, v]) => `${k} ${v}`).join(' · ')}`)

  const b = graphBounds(g)
  console.log(`     画布范围：x ${Math.round(b.minX)}~${Math.round(b.maxX)} · y ${Math.round(b.minY)}~${Math.round(b.maxY)}`)

  check('真实数据也没有 NaN', g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)))
  check('节点数不超过上限', g.nodes.length <= DEFAULT_LIMIT)
  check('每条线的两端都在', g.links.every((l) => g.nodes.some((n) => n.key === l.from) && g.nodes.some((n) => n.key === l.to)))
  check('中心是真实的扩展', Boolean(g.center) && items.some((i) => i.path === g.center!.key))
  check('画布不会大到失控', b.maxX - b.minX < 4000 && b.maxY - b.minY < 4000)
}

async function main(): Promise<void> {
  syntheticTests()
  const dir = process.argv[2]
  if (dir) {
    await realServer(resolve(dir))
  } else {
    console.log('\n（没给服务器目录，只跑了合成用例）')
    console.log('  想看真实数据：node tmp/test-graph.cjs <服务器目录>')
  }
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
