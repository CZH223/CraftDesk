/**
 * 世界地图：位解包、PNG 编码、region 解析、世界目录扫描。
 *
 * 地图是只读的，但仍然值得单独测：位打包错一位，整张图就会变成横条纹，
 * 而那种「看起来像地形」的错误最难被用户发现。
 *
 * 可选参数：给一个真实的 .mca 文件，会额外跑一遍完整渲染。
 * npx esbuild scripts/test-worldmap.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-worldmap.cjs && node tmp/test-worldmap.cjs [r.x.z.mca]
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { unpackLongs } from '../src/main/nbt'
import { encodePng } from '../src/main/png'
import {
  decodeSectionIndices,
  inspectWorld,
  REGION_PX,
  renderRegionFromBuffer,
  renderRegionFile
} from '../src/main/worldmap'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`)
}

function pack(values: number[], bits: number, padded: boolean): bigint[] {
  if (padded) {
    const per = Math.floor(64 / bits)
    const out: bigint[] = []
    for (let i = 0; i < values.length; i += per) {
      let v = 0n
      for (let j = 0; j < per && i + j < values.length; j++) {
        v |= BigInt(values[i + j]) << BigInt(j * bits)
      }
      out.push(v)
    }
    return out
  }
  let total = 0n
  for (let i = 0; i < values.length; i++) total |= BigInt(values[i]) << BigInt(i * bits)
  const out: bigint[] = []
  for (let bit = 0; bit < values.length * bits; bit += 64) {
    out.push(BigInt.asIntN(64, (total >> BigInt(bit)) & ((1n << 64n) - 1n)))
  }
  return out
}

function decodePng(png: Buffer): { w: number; h: number; pixels: Buffer } {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG 签名不对')
  let off = 8
  let w = 0
  let h = 0
  const idat: Buffer[] = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6) throw new Error('不是 RGBA8')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * 4
  const pixels = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const row = raw.subarray(y * (stride + 1), (y + 1) * (stride + 1))
    if (row[0] !== 1) throw new Error(`第 ${y} 行滤波器不是 Sub`)
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0
      pixels[y * stride + x] = (row[1 + x] + left) & 0xff
    }
  }
  return { w, h, pixels }
}

console.log('══ Long 数组解包 ══')
const nibbles = Array.from({ length: 32 }, (_, i) => i % 16)
check('4 位（每 long 16 项）', [...unpackLongs(pack(nibbles, 4, false), 4, 32, true)], nibbles)
const fiveBits = Array.from({ length: 40 }, (_, i) => (i * 7) % 32)
// 连续打包只是通用工具的一种模式；区块和高度图都不用它
check('5 位连续打包（工具函数）', [...unpackLongs(pack(fiveBits, 5, false), 5, 40, true)], fiveBits)
check('5 位逐 long 补齐', [...unpackLongs(pack(fiveBits, 5, true), 5, 40, false)], fiveBits)

// 这一条盯的是调用点：区块的 block_states 必须用补齐模式。4 位时两种算法
// 结果相同，5 位以上会错位；用连续模式解 342 个 long 的 5 位 section，
// 会出现越界索引，地图上就是一片片颜色随机的「错误区块」。
const sectionValues = Array.from({ length: 4096 }, (_, i) => (i * 7) % 32)
check(
  '区块 5 位索引按逐 long 补齐解包',
  [...decodeSectionIndices(32, pack(sectionValues, 5, true))],
  sectionValues
)
check('长度不够时不越界', [...unpackLongs([1n << 60n], 8, 16, true)].length, 16)
// 高度图是 9 位、每个 long 放 7 个（37 个 long），不是连续打包
const hm = Array.from({ length: 256 }, (_, i) => 40 + (i % 30))
check('9 位高度图按 7 个/long 解包', [...unpackLongs(pack(hm, 9, true), 9, 256, false)], hm)

console.log('\n══ PNG 编码 ══')
const rgba = new Uint8Array([
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
  255, 255, 255, 0
])
const png = encodePng(rgba, 2, 2)
const decoded = decodePng(png)
check('尺寸', [decoded.w, decoded.h], [2, 2])
check('像素原样返回', [...decoded.pixels], [...rgba])

console.log('\n══ 损坏/空 region 不崩 ══')
const empty = renderRegionFromBuffer(Buffer.alloc(0))
check('空文件：没有地表', empty.explored, 0)
const tiny = renderRegionFromBuffer(Buffer.alloc(9000))
check('全是 0 的位置表：没有地表', tiny.explored, 0)

async function scanTest(): Promise<void> {
  console.log('\n══ 世界目录扫描与连通块 ══')
  const root = join(process.cwd(), 'tmp', 'worldmap-scan')
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(join(root, 'world', 'region'), { recursive: true })
  await fs.mkdir(join(root, 'world', 'DIM-1', 'region'), { recursive: true })
  await fs.writeFile(join(root, 'server.properties'), 'level-name=world\n')
  for (const n of ['r.0.0.mca', 'r.1.0.mca', 'r.0.1.mca', 'r.40.40.mca']) {
    await fs.writeFile(join(root, 'world', 'region', n), '')
  }
  await fs.writeFile(join(root, 'world', 'DIM-1', 'region', 'r.0.0.mca'), '')
  const info = await inspectWorld(root, join(root, 'server.properties'))
  check('找到主世界', info.dimensions.find((d) => d.id === 'overworld')?.regions.length, 4)
  check('找到下界', info.dimensions.find((d) => d.id === 'nether')?.regions.length, 1)
  check('没有末地', info.dimensions.some((d) => d.id === 'end'), false)
  const core = info.dimensions.find((d) => d.id === 'overworld')!.coreBounds
  check('适应范围排除了远处的孤立 region', [core.minX, core.maxX, core.minZ, core.maxZ], [0, 1023, 0, 1023])
  check('读不到 level.dat 时 spawn 为 null', info.spawn, null)
  await fs.rm(root, { recursive: true, force: true })
}

async function realRegion(path: string): Promise<void> {
  console.log('\n══ 真实 region 渲染 ══')
  const started = Date.now()
  const res = await renderRegionFile(path)
  const ms = Date.now() - started
  const decoded = decodePng(res.png)
  console.log(`  ${ms}ms，${res.chunks} 个区块，${res.explored} 个有地表的格子，PNG ${(res.png.length / 1024).toFixed(0)} KB`)
  check('尺寸 512×512', [decoded.w, decoded.h], [REGION_PX, REGION_PX])
  check('渲染出了地表', res.explored > 0, true)
  check('高度数组长度', res.heights.length, REGION_PX * REGION_PX)
}

async function main(): Promise<void> {
  await scanTest()
  const region = process.argv[2]
  if (region) await realRegion(region)
  else console.log('\n（没给 .mca 路径，跳过真实渲染；真实渲染可加一个 region 文件参数）')
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
