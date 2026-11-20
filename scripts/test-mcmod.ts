/**
 * 验证 MC百科关系解析与星图合并。
 *
 * MC百科的 HTML 结构不是 API，字段和标签都可能变，所以这里用真实的
 * 片段做回归：搜索页 → 模组页 data-id → 静态关系 JSON。
 * 合并部分检查三件事：本地已装的不要重复建节点、联动要单独成类、
 * 百科条目能选中下载（missing = true）。
 *
 * npx esbuild scripts/test-mcmod.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-mcmod.cjs && node tmp/test-mcmod.cjs
 */
import {
  mcmodEnglishName,
  mcmodNormalize,
  parseMcmodChartId,
  parseMcmodDownloads,
  parseMcmodExternalLinks,
  parseMcmodRelationsJson,
  parseMcmodSearch,
  parseMcmodTitle
} from '../src/main/mcmod'
import {
  curseforgeApiPath,
  forgeCdnFileUrl,
  pickCurseForgeFile,
  pickMcmodDownloadFile
} from '../src/main/modSources'
import { buildStarGraph, mergeMcmodRelations } from '../src/renderer/src/graph'
import type { McmodRelations, PluginInfo } from '../src/shared/types'

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
    loaders: [],
    loaderMismatch: false,
    requires: [],
    usedBy: [],
    ...patch
  }
}

console.log('名称与编码')
check(
  '从括号里抽英文名',
  mcmodEnglishName("YUNG 的矿井优化 (YUNG's Better Mineshafts)") ===
    "YUNG's Better Mineshafts"
)
check('没有括号时保留原名', mcmodEnglishName("YUNG's Extras") === "YUNG's Extras")
check('归一化忽略空格和标点', mcmodNormalize("YUNG's API") === 'yungsapi')
check('归一化保留中文', mcmodNormalize('联动模组') === '联动模组')

console.log('\n搜索页')
const searchHtml = `
<div class="result-item"><div class="head"><div class="class-category"><ul>
<li><a class="c_7" href="//www.mcmod.cn/class/category/7-1.html" target="_blank"></a></li>
</ul></div><a target="_blank" href="https://www.mcmod.cn/class/3372.html"><em>YUNG</em>'s <em>API</em></a></div>
<div class="body">由 Nick Young 制作的前置库</div></div>
<div class="result-item"><div class="head"><a href="/class/9384.html">YUNG 的下界要塞优化</a></div></div>`
const hit = parseMcmodSearch(searchHtml, "YUNG's API")
check('找到 class id', hit?.classId === '3372', hit?.classId)
check('标题去掉高亮标签', hit?.title === "YUNG's API", hit?.title)
check(
  '精确匹配排在前面',
  parseMcmodSearch(searchHtml, 'YUNG 的下界要塞优化')?.classId === '9384'
)
check('没有结果返回 null', parseMcmodSearch('<div>无结果</div>', 'x') === null)

console.log('\n模组页')
const pageHtml = `<title>YUNG's API - MC百科|最大的Minecraft中文MOD百科</title>
<button type="button" id="class-relation-chart-btn" data-id="wwbjlTitrWNTjUvn">打开星图</button>`
check('提取 data-id', parseMcmodChartId(pageHtml) === 'wwbjlTitrWNTjUvn')
check(
  'data-id 属性顺序反过来也能读',
  parseMcmodChartId('<button data-id="abc" id="class-relation-chart-btn">x</button>') === 'abc'
)
check('标题去掉站点后缀', parseMcmodTitle(pageHtml, 'fallback') === "YUNG's API")
check('没有关系按钮时返回 null', parseMcmodChartId('<div>nothing</div>') === null)

console.log('\n关系 JSON')
const raw = {
  categories: [
    { name: '前置模组' },
    { name: '拓展模组' },
    { name: '联动模组' },
    { name: null }
  ],
  nodes: [
    { id: 0, name: 'Center', category: 3 },
    { id: 1, classID: '100', name: '前置 (Required Mod)', category: 0 },
    { id: 2, classID: '101', name: '拓展 (Extends Mod)', category: 1 },
    { id: 3, classID: '102', name: '联动 (Linked Mod)', category: 2 },
    { id: 4, classID: '103', name: '不相连 (Far Away)', category: 1 }
  ],
  links: [
    { source: 0, target: 1 },
    { source: 0, target: 2 },
    { source: 0, target: 3 }
  ]
}
const rel = parseMcmodRelationsJson(JSON.stringify(raw), {
  classId: '3372',
  title: 'Center',
  pageUrl: 'https://www.mcmod.cn/class/3372.html'
})
check('解析成功', Boolean(rel))
check('只保留中心直接相连的一圈', rel?.nodes.length === 4, `${rel?.nodes.length}`)
check('不相连的远端节点被排除', !rel?.nodes.some((n) => n.classId === '103'))
check(
  '分类映射正确',
  rel?.nodes.find((n) => n.classId === '100')?.category === 'required' &&
    rel?.nodes.find((n) => n.classId === '101')?.category === 'extends' &&
    rel?.nodes.find((n) => n.classId === '102')?.category === 'linked'
)
check(
  '英文名抽出来了',
  rel?.nodes.find((n) => n.classId === '102')?.englishName === 'Linked Mod'
)
check('坏 JSON 不炸', parseMcmodRelationsJson('{oops', {
  classId: 'x',
  title: 'x',
  pageUrl: 'x'
}) === null)

console.log('\n合并进星图')
const items = [
  item({ id: 'center', name: 'Center', path: 'mods/center.jar' }),
  item({ id: 'requiredmod', name: 'Required Mod', path: 'mods/required.jar' })
]
const localGraph = buildStarGraph(items, 'mods/center.jar', 15, false)
const merged = mergeMcmodRelations(
  localGraph,
  items,
  rel as McmodRelations,
  15
)
const external = merged.nodes.filter((n) => n.external)
check('本地已有的不再重复', merged.nodes.length === 4, `${merged.nodes.length}`)
check('新增两个百科节点', external.length === 2, `${external.length}`)
check(
  '联动单独成类',
  external.some((n) => n.role === 'linked' && n.externalCategory === 'linked')
)
check(
  '百科节点可选中下载',
  external.every((n) => n.missing === true && n.focusable === false)
)
const requiredNode = merged.nodes.find((n) => n.key === 'mods/required.jar')
check('匹配上的本地节点补上百科 id', requiredNode?.classId === '100' && requiredNode?.onMcmod === true)
check(
  '匹配上的关系用虚线补进图里',
  merged.links.some((l) => l.from === 'mods/required.jar' && l.to === 'mods/center.jar' && l.external)
)
check(
  '百科边都标成 external',
  merged.links.filter((l) => l.external).length === 3,
  `${merged.links.filter((l) => l.external).length}`
)
const manyRel: McmodRelations = {
  ...(rel as McmodRelations),
  nodes: [
    (rel as McmodRelations).nodes[0],
    ...Array.from({ length: 8 }, (_, i) => ({
      id: 10 + i,
      classId: `90${i}`,
      name: `Extra ${i} (Extra ${i})`,
      englishName: `Extra ${i}`,
      category: (i % 2 === 0 ? 'extends' : 'linked') as 'extends' | 'linked'
    }))
  ],
  links: Array.from({ length: 8 }, (_, i) => ({ from: 0, to: 10 + i }))
}
const capped = mergeMcmodRelations(localGraph, items, manyRel, 5)
check('节点上限对百科节点也生效', capped.nodes.length === 5, `${capped.nodes.length}`)

const filtered = mergeMcmodRelations(localGraph, items, rel as McmodRelations, 15, {
  'mcmod:101': 'bad',
  'mcmod:102': 'ok'
})
check(
  '不兼容的百科条目被忽略',
  !filtered.nodes.some((n) => n.classId === '101'),
  filtered.nodes.map((n) => n.classId).join(',')
)
check(
  '兼容的百科条目保留',
  filtered.nodes.some((n) => n.classId === '102')
)
check(
  '本地已安装节点不受兼容性过滤影响',
  filtered.nodes.some((n) => n.key === 'mods/required.jar')
)

console.log('\nMC百科下载文件表')
const downloadHtml = `<table><tr data-id="8850510" data-head='<span title="JAVA版">JAVA版</span><span title="NeoForge">NeoForge</span>' data-version="26.1.2/26.1.1" data-filename="YungsApi-26.1.2-NeoForge-6.1.3" data-suffix="jar"><td>YungsApi-26.1.2-NeoForge-6.1.3.jar</td><td>26.1.2/26.1.1</td><td data-original-title="439024 bytes">439 KB</td><td data-original-title="上传于: 1月前&amp;lt;br/&amp;gt;(2026-09-10 12:48:09)">2026-09-10 12:48:09</td></tr>
<tr data-id="8894735" data-head='<span title="Forge">Forge</span>' data-version="1.21.1/1.21" data-filename="YungsApi-1.21.1-Forge-5.1.9-all" data-suffix="jar"><td>YungsApi-1.21.1-Forge-5.1.9-all.jar</td><td data-original-title="1054561 bytes">1.01 MiB</td></tr></table>`
const downloads = parseMcmodDownloads(downloadHtml, 'https://www.mcmod.cn/download/3372.html')
check('解析下载文件行', downloads.length === 2, `${downloads.length}`)
check('拼出完整文件名', downloads[0]?.fileName === 'YungsApi-26.1.2-NeoForge-6.1.3.jar', downloads[0]?.fileName)
check('解析 MC 版本', downloads[0]?.mcVersions.join('/') === '26.1.2/26.1.1')
check('解析加载器', downloads[0]?.loaders.includes('NeoForge') === true)
check('解析文件大小', downloads[0]?.size === 439024, `${downloads[0]?.size}`)
check('解析上传时间', downloads[0]?.uploadedAt === '2026-09-10 12:48:09', downloads[0]?.uploadedAt)
check('第二个文件独立解析', downloads[1]?.fileName === 'YungsApi-1.21.1-Forge-5.1.9-all.jar')
const withUrls = downloads.map((f, i) => ({
  ...f,
  url: `https://example.invalid/${i}.jar`,
  source: i === 0 ? ('curseforge' as const) : ('github' as const)
}))
check(
  '从百科文件表挑当前版本',
  pickMcmodDownloadFile(withUrls, 'neoforge', '26.1.2')?.fileName ===
    'YungsApi-26.1.2-NeoForge-6.1.3.jar'
)
check(
  '百科文件表按加载器过滤',
  pickMcmodDownloadFile(withUrls, 'fabric', '26.1.2') === null
)

console.log('\n外部下载链接')
const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64')
const linkHtml = `
<a data-original-title="CurseForge: NeoForge/Forge" target="_blank" href="//link.mcmod.cn/target/${b64('https://www.curseforge.com/minecraft/mc-mods/yungs-api')}"><svg></svg></a>
<a data-original-title="GitHub" target="_blank" href="//link.mcmod.cn/target/${b64('https://github.com/yungnickyoung/YUNGs-API')}"><svg></svg></a>
<a href="https://github.com/Ahrwing/mcmod/issues/">意见反馈</a>`
const links = parseMcmodExternalLinks(linkHtml)
check('解析 CurseForge 外链', links.some((l) => l.provider === 'curseforge'))
check('解析 GitHub 外链', links.some((l) => l.provider === 'github'))
check('不把页脚 GitHub 当成模组链接', links.length === 2, `${links.length}`)
check(
  'CurseForge 变体带加载器',
  links.find((l) => l.provider === 'curseforge')?.loaders?.includes('NeoForge') === true
)
check(
  'CurseForge 项目路径',
  curseforgeApiPath('https://www.curseforge.com/minecraft/mc-mods/yungs-api') ===
    '/minecraft/mc-mods/yungs-api'
)
const cfFile = {
  id: 8850510,
  name: 'YungsApi-26.1.2-NeoForge-6.1.3.jar',
  url: 'https://www.curseforge.com/minecraft/mc-mods/yungs-api/files/8850510',
  versions: ['Client', 'NeoForge', 'Server', '26.1.1', '26.1.2'],
  uploaded_at: '2026-09-10T12:48:09Z'
}
check(
  'forgecdn 直链按文件 id 分目录',
  forgeCdnFileUrl(cfFile) ===
    'https://edge.forgecdn.net/files/8850/510/YungsApi-26.1.2-NeoForge-6.1.3.jar',
  forgeCdnFileUrl(cfFile) ?? ''
)
const cfFiles = [
  cfFile,
  {
    id: 8894735,
    name: 'YungsApi-1.21.1-Forge-5.1.9-all.jar',
    url: 'https://www.curseforge.com/minecraft/mc-mods/yungs-api/files/8894735',
    versions: ['1.21', 'Client', 'Forge', '1.21.1', 'Server'],
    uploaded_at: '2026-09-16T11:24:28Z'
  }
]
check(
  'CurseForge 选 NeoForge 26.1.2 文件',
  pickCurseForgeFile(cfFiles, 'neoforge', '26.1.2')?.id === 8850510
)
check(
  'CurseForge 选 Forge 1.21.1 文件',
  pickCurseForgeFile(cfFiles, 'forge', '1.21.1')?.id === 8894735
)
check('没有匹配加载器时返回 null', pickCurseForgeFile(cfFiles, 'fabric', '1.21.1') === null)

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
