/**
 * 地图导出：连通块、尺寸规划、瓦片拼接、透明背景、PNG 解码。
 *
 * npx esbuild scripts/test-map-export.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-map-export.cjs && node tmp/test-map-export.cjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { decodePng, encodePng } from '../src/main/png'
import {
  composeTarget,
  downsampleSquare,
  estimateExport,
  makeExportTargets,
  MAX_EXPORT_PX,
  regionComponents,
  resampleTile,
  writeTargetPng,
  type ExportTarget
} from '../src/main/mapExport'
import type { MapRegionRef } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(
    `  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`
  )
}

const r = (rx: number, rz: number): MapRegionRef => ({ rx, rz })

console.log('══ 连通块（8 邻接） ══')
const regions = [
  r(0, 0),
  r(1, 0),
  r(2, 2),
  r(3, 2),
  r(3, 3),
  r(10, 10)
]
const comps = regionComponents(regions)
check('连通块数量', comps.length, 3)
check('按大小排序', comps.map((c) => c.length), [3, 2, 1])
check('只靠一个角挨着也算连接', regionComponents([r(0, 0), r(1, 1)]).length, 1)
check('隔一格就不算连接', regionComponents([r(0, 0), r(2, 0)]).length, 2)

console.log('\n══ 导出目标与尺寸 ══')
const all = makeExportTargets(regions, 'all')
check('全部导出只有一个目标', all.length, 1)
check('全图包含全部区域', all[0].regions.length, 6)
check('默认长边不超过 4096', Math.max(all[0].width, all[0].height) <= 4096, true)
check('默认规划用 step 1 保留细节', all[0].step, 1)
const localTarget = makeExportTargets([r(0, 0), r(1, 0)], 'all')[0]
check('小图保持原生尺寸', [localTarget.step, localTarget.tileSize, localTarget.width], [1, 512, 1024])
const parts = makeExportTargets(regions, 'components')
check('分块导出得到三个目标', parts.length, 3)
check('分块目标互不重叠', parts.reduce((n, t) => n + t.regions.length, 0), 6)

const huge: MapRegionRef[] = []
for (let rz = 0; rz < 40; rz++) for (let rx = 0; rx < 40; rx++) huge.push(r(rx, rz))
const hugeTarget = makeExportTargets(huge, 'all')[0]
check('超大图被限制在 4096 px 内', Math.max(hugeTarget.width, hugeTarget.height) <= 4096, true)
check('超大图需要降采样', hugeTarget.scale > 1, true)
check('默认上限常量存在', MAX_EXPORT_PX, 32768)

const bigTarget = makeExportTargets(huge, 'all', 32768)[0]
check('可自选 32768 长边', Math.max(bigTarget.width, bigTarget.height) <= 32768, true)
check('小地图不强行放大', Math.max(bigTarget.width, bigTarget.height), 40 * 512)

const wide: MapRegionRef[] = []
for (let rz = 0; rz < 100; rz++) for (let rx = 0; rx < 100; rx++) wide.push(r(rx, rz))
const wideTarget = makeExportTargets(wide, 'all', 32768)[0]
check('大地图 32768 时接近目标', Math.max(wideTarget.width, wideTarget.height) > 30000, true)
check('大地图 32768 不超上限', Math.max(wideTarget.width, wideTarget.height) <= 32768, true)

const estimateAll = estimateExport([localTarget], 4096)
check('预估像素数', estimateAll.totalPixels, 1024 * 512)
check('预估文件大小有范围', estimateAll.estimatedBytesLow < estimateAll.estimatedBytesHigh, true)
const estimateMany = estimateExport([hugeTarget], 32768)
check('大尺寸给出提醒', Boolean(estimateMany.warning), true)

console.log('\n══ 降采样与拼接 ══')
const quad = new Uint8Array(16)
const put = (x: number, y: number, c: [number, number, number]): void => {
  const i = (y * 2 + x) * 4
  quad[i] = c[0]
  quad[i + 1] = c[1]
  quad[i + 2] = c[2]
  quad[i + 3] = 255
}
put(0, 0, [255, 0, 0])
put(1, 0, [0, 255, 0])
put(0, 1, [0, 0, 255])
put(1, 1, [255, 255, 255])
check('2×2 box 平均', [...downsampleSquare(quad, 2, 2)], [128, 128, 128, 255])
check('任意比例重采样', [...resampleTile(quad, 2, 1)], [128, 128, 128, 255])

const target: ExportTarget = localTarget
const tileA = new Uint8Array(512 * 512 * 4)
tileA[0] = 255
tileA[3] = 255
const tileB = new Uint8Array(512 * 512 * 4)
tileB[(512 * 512 - 1) * 4 + 1] = 255
tileB[(512 * 512 - 1) * 4 + 3] = 255
const stitched = composeTarget(
  target,
  new Map([
    ['0,0', { size: 512, rgba: tileA }],
    ['1,0', { size: 512, rgba: tileB }]
  ])
)
check('拼接尺寸', [target.width, target.height], [1024, 512])
check('左上区域像素', [...stitched.slice(0, 4)], [255, 0, 0, 255])
const lastOfB = (511 * 1024 + 1023) * 4
check('第二个区域像素', [...stitched.slice(lastOfB, lastOfB + 4)], [0, 255, 0, 255])

console.log('\n══ PNG 解码 ══')
const rgba = new Uint8Array([
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
  255, 255, 255, 0
])
const decoded = decodePng(encodePng(rgba, 2, 2))
check('解码尺寸', [decoded.width, decoded.height], [2, 2])
check('解码像素与编码前一致', [...decoded.rgba], [...rgba])

async function streamTest(): Promise<void> {
  console.log('\n══ 流式拼接导出 ══')
  const dir = join(process.cwd(), 'tmp')
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, 'test-map-export-stream.png')
  const tileA = new Uint8Array(512 * 512 * 4)
  tileA[0] = 255
  tileA[3] = 255
  const tileB = new Uint8Array(512 * 512 * 4)
  const last = (512 * 512 - 1) * 4
  tileB[last + 1] = 255
  tileB[last + 3] = 255
  await writeTargetPng(localTarget, file, async (region) => {
    if (region.rx === 0 && region.rz === 0) return { size: 512, rgba: tileA }
    if (region.rx === 1 && region.rz === 0) return { size: 512, rgba: tileB }
    return null
  })
  const streamed = decodePng(await fs.readFile(file))
  check('流式 PNG 尺寸', [streamed.width, streamed.height], [1024, 512])
  check('流式 PNG 左上像素', [...streamed.rgba.slice(0, 4)], [255, 0, 0, 255])
  const lastOfB = (511 * 1024 + 1023) * 4
  check('流式 PNG 第二块像素', [...streamed.rgba.slice(lastOfB, lastOfB + 4)], [0, 255, 0, 255])
  await fs.rm(file, { force: true })
}

void streamTest().then(() => {
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
})
