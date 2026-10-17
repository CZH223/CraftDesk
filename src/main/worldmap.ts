import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, inflateSync } from 'node:zlib'
import { nbtCompound, nbtNumber, parseChunkNbt, parseNbt, unpackLongs, type ChunkNbt } from './nbt'
import { encodePng } from './png'
import { parsePropertiesFile } from './properties'
import type {
  MapBounds,
  MapDimensionInfo,
  MapRegionRef,
  WorldMapInfo
} from '../shared/types'

/**
 * 世界地图：把 region 文件里的地表方块画成一张俯视图。
 *
 * 目标是「一眼能看懂地形」而不是复刻游戏里的材质：
 *   - 每个方块取最上面那个非空气方块的颜色（树叶、草、沙、水……）；
 *   - 用水深把海/湖分成深浅几档；
 *   - 用相邻格子的高度差做晕渲（西北方向光），平原和山区的立体感来自这里。
 *
 * 一个 region 固定输出 512×512 像素（1 像素 = 1 方块），画面上的缩放交给界面，
 * 这样切瓦片、缓存和缩放都不用重复解析存档。
 */

export const REGION_PX = 512
/** 高度存成 y + 128，0 表示这一格没有数据 */
const HEIGHT_BIAS = 128

const DIMENSIONS: { id: MapDimensionInfo['id']; label: string; rel: string[] }[] = [
  { id: 'overworld', label: '主世界', rel: ['region'] },
  { id: 'nether', label: '下界', rel: [join('DIM-1', 'region'), join('world_nether', 'region')] },
  { id: 'end', label: '末地', rel: [join('DIM1', 'region'), join('world_the_end', 'region')] }
]

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function scanRegionDir(dir: string): Promise<MapRegionRef[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: MapRegionRef[] = []
  for (const name of names) {
    const m = name.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/i)
    if (!m) continue
    out.push({ rx: Number(m[1]), rz: Number(m[2]) })
  }
  out.sort((a, b) => a.rz - b.rz || a.rx - b.rx)
  return out
}

/**
 * 最大的连通区块（region 按八邻接算）。
 *
 * 技术服常见的形状是：主城区连成一大片，天边散着几个孤零零的 region
 * （传送、结构、误加载）。直接按全集缩放会把这些孤立点也算进去，
 * 主城变成一个小点。这里取最大的一块，作为「适应画面」的范围。
 */
function largestClusterBounds(regions: MapRegionRef[]): MapBounds | null {
  const set = new Set(regions.map((r) => `${r.rx},${r.rz}`))
  const seen = new Set<string>()
  let best: MapRegionRef[] = []

  for (const start of regions) {
    const startKey = `${start.rx},${start.rz}`
    if (seen.has(startKey)) continue
    const stack: MapRegionRef[] = [start]
    const comp: MapRegionRef[] = []
    seen.add(startKey)
    while (stack.length) {
      const cur = stack.pop()!
      comp.push(cur)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue
          const key = `${cur.rx + dx},${cur.rz + dz}`
          if (!set.has(key) || seen.has(key)) continue
          seen.add(key)
          stack.push({ rx: cur.rx + dx, rz: cur.rz + dz })
        }
      }
    }
    if (comp.length > best.length) best = comp
  }
  if (!best.length) return null
  let minRx = Infinity
  let maxRx = -Infinity
  let minRz = Infinity
  let maxRz = -Infinity
  for (const r of best) {
    minRx = Math.min(minRx, r.rx)
    maxRx = Math.max(maxRx, r.rx)
    minRz = Math.min(minRz, r.rz)
    maxRz = Math.max(maxRz, r.rz)
  }
  return {
    minX: minRx * REGION_PX,
    maxX: (maxRx + 1) * REGION_PX - 1,
    minZ: minRz * REGION_PX,
    maxZ: (maxRz + 1) * REGION_PX - 1
  }
}

/** level.dat 里的出生点（gzip 的 NBT） */
async function readSpawn(worldDir: string): Promise<{ x: number; z: number } | null> {
  try {
    const raw = await fs.readFile(join(worldDir, 'level.dat'))
    const data = nbtCompound(parseNbt(gunzipSync(raw)).Data)
    const x = nbtNumber(data.SpawnX)
    const z = nbtNumber(data.SpawnZ)
    if (Number.isFinite(x) && Number.isFinite(z)) return { x, z }
  } catch {
    /* 没有 level.dat 或格式不认识 */
  }
  return null
}

/** 找到世界目录与各维度；只读目录列表，不解析区块 */
export async function inspectWorld(core: string, propertiesPath: string): Promise<WorldMapInfo> {
  let levelName = 'world'
  try {
    const props = await parsePropertiesFile(propertiesPath)
    levelName = props.find((p) => p.key === 'level-name')?.value || 'world'
  } catch {
    /* 没有 server.properties 就按默认的 world 找 */
  }

  let worldDir = join(core, levelName)
  if (!(await exists(worldDir))) worldDir = join(core, 'world')

  const dimensions: MapDimensionInfo[] = []
  for (const dim of DIMENSIONS) {
    let regionDir = ''
    let regions: MapRegionRef[] = []
    for (const rel of dim.rel) {
      const candidate = join(worldDir, rel)
      const found = await scanRegionDir(candidate)
      if (found.length) {
        regionDir = candidate
        regions = found
        break
      }
    }
    if (!regions.length) continue
    let minRx = Infinity
    let maxRx = -Infinity
    let minRz = Infinity
    let maxRz = -Infinity
    for (const r of regions) {
      minRx = Math.min(minRx, r.rx)
      maxRx = Math.max(maxRx, r.rx)
      minRz = Math.min(minRz, r.rz)
      maxRz = Math.max(maxRz, r.rz)
    }
    const cluster = largestClusterBounds(regions)
    dimensions.push({
      id: dim.id,
      label: dim.label,
      regionDir,
      regions,
      minX: minRx * REGION_PX,
      maxX: (maxRx + 1) * REGION_PX - 1,
      minZ: minRz * REGION_PX,
      maxZ: (maxRz + 1) * REGION_PX - 1,
      coreBounds: cluster ?? {
        minX: minRx * REGION_PX,
        maxX: (maxRx + 1) * REGION_PX - 1,
        minZ: minRz * REGION_PX,
        maxZ: (maxRz + 1) * REGION_PX - 1
      }
    })
  }

  return {
    exists: dimensions.length > 0,
    worldDir,
    levelName,
    spawn: await readSpawn(worldDir),
    dimensions
  }
}

// ---------------------------------------------------------------- 颜色

type RGB = [number, number, number]

/**
 * 方块 → 地图颜色。
 *
 * 颜色偏「卫星图」而不是材质原色：草是草绿、水是深蓝、石头是灰，
 * 这样远处看的是地形而不是一张花花的材质贴图。
 */
const BLOCK_COLORS: Record<string, RGB> = {
  grass_block: [116, 164, 78],
  dirt: [134, 96, 67],
  coarse_dirt: [119, 85, 59],
  rooted_dirt: [124, 89, 62],
  podzol: [91, 62, 38],
  mycelium: [111, 98, 101],
  farmland: [104, 74, 43],
  dirt_path: [148, 124, 82],
  moss_block: [90, 125, 53],
  mud: [60, 56, 55],
  clay: [160, 166, 182],
  gravel: [139, 134, 126],
  sand: [219, 211, 160],
  suspicious_sand: [213, 204, 154],
  red_sand: [190, 102, 33],
  sandstone: [216, 203, 155],
  stone: [136, 136, 136],
  smooth_stone: [158, 158, 158],
  cobblestone: [122, 122, 122],
  mossy_cobblestone: [104, 120, 86],
  deepslate: [80, 80, 84],
  cobbled_deepslate: [88, 88, 92],
  tuff: [108, 109, 102],
  calcite: [223, 224, 220],
  dripstone_block: [134, 107, 92],
  andesite: [136, 136, 136],
  diorite: [188, 188, 190],
  granite: [154, 110, 92],
  bedrock: [85, 85, 85],
  obsidian: [35, 30, 48],
  crying_obsidian: [45, 27, 80],
  netherrack: [111, 54, 52],
  nether_bricks: [44, 22, 26],
  soul_sand: [82, 62, 50],
  soul_soil: [75, 57, 46],
  basalt: [73, 72, 77],
  blackstone: [42, 36, 40],
  end_stone: [219, 222, 158],
  purpur_block: [169, 125, 169],
  obsidian_pillar: [46, 40, 63],
  snow: [242, 247, 247],
  snow_block: [242, 247, 247],
  powder_snow: [238, 244, 246],
  ice: [155, 197, 235],
  packed_ice: [141, 180, 220],
  blue_ice: [116, 167, 226],
  frosted_ice: [160, 196, 230],
  water: [56, 108, 208],
  lava: [226, 96, 28],
  magma_block: [142, 60, 30],
  oak_leaves: [58, 94, 45],
  birch_leaves: [94, 128, 64],
  spruce_leaves: [48, 82, 54],
  jungle_leaves: [62, 120, 38],
  acacia_leaves: [104, 116, 46],
  dark_oak_leaves: [48, 78, 36],
  mangrove_leaves: [70, 108, 50],
  cherry_leaves: [206, 150, 186],
  azalea_leaves: [84, 120, 58],
  oak_log: [110, 86, 52],
  birch_log: [200, 196, 180],
  spruce_log: [78, 58, 38],
  jungle_log: [100, 80, 48],
  acacia_log: [110, 90, 58],
  dark_oak_log: [66, 48, 30],
  mossy_stone_bricks: [110, 120, 94],
  stone_bricks: [122, 122, 122],
  bricks: [150, 96, 76],
  terracotta: [152, 94, 67],
  white_terracotta: [209, 178, 161],
  orange_terracotta: [161, 83, 37],
  yellow_terracotta: [186, 133, 35],
  brown_terracotta: [77, 51, 35],
  red_terracotta: [143, 61, 46],
  light_gray_terracotta: [135, 107, 98],
  black_terracotta: [37, 23, 16],
  oak_planks: [162, 130, 78],
  spruce_planks: [114, 84, 48],
  birch_planks: [196, 178, 123],
  jungle_planks: [160, 115, 80],
  acacia_planks: [168, 90, 50],
  dark_oak_planks: [66, 43, 20],
  bookshelf: [158, 126, 76],
  crafting_table: [124, 95, 60],
  furnace: [110, 110, 110],
  glass: [180, 210, 220],
  white_wool: [233, 236, 236],
  orange_wool: [240, 118, 19],
  magenta_wool: [189, 68, 179],
  light_blue_wool: [58, 175, 217],
  yellow_wool: [248, 198, 39],
  lime_wool: [112, 185, 25],
  pink_wool: [237, 141, 172],
  gray_wool: [62, 68, 71],
  light_gray_wool: [142, 142, 134],
  cyan_wool: [21, 137, 145],
  purple_wool: [121, 42, 172],
  blue_wool: [53, 57, 157],
  brown_wool: [114, 71, 40],
  green_wool: [84, 109, 27],
  red_wool: [161, 39, 34],
  black_wool: [20, 21, 25],
  short_grass: [108, 156, 70],
  tall_grass: [102, 150, 66],
  fern: [96, 144, 62],
  large_fern: [92, 138, 58],
  dandelion: [230, 214, 74],
  poppy: [214, 62, 52],
  blue_orchid: [74, 156, 209],
  sunflower: [232, 198, 62],
  wheat: [188, 170, 84],
  hay_block: [178, 150, 54],
  pumpkin: [198, 120, 24],
  melon: [108, 164, 36],
  sugar_cane: [146, 180, 92],
  cactus: [84, 132, 58],
  bamboo: [150, 180, 66],
  lily_pad: [56, 116, 50],
  sea_pickle: [110, 132, 66],
  seagrass: [64, 130, 70],
  kelp: [56, 112, 64],
  coral_block: [204, 90, 90],
  sponge: [202, 196, 84],
  nether_portal: [122, 42, 190],
  beacon: [120, 220, 220],
  slime_block: [112, 190, 92]
}

/** 没收录的方块：按名字散列到一个低饱和的大地色，至少不会一片黑 */
function fallbackColor(name: string): RGB {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const hue = h % 360
  const sat = 0.16 + ((h >> 8) % 14) / 100
  const light = 0.36 + ((h >> 16) % 18) / 100
  // HSL → RGB（只为了拿一个柔和的地形色）
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) [r, g, b] = [c, x, 0]
  else if (hue < 120) [r, g, b] = [x, c, 0]
  else if (hue < 180) [r, g, b] = [0, c, x]
  else if (hue < 240) [r, g, b] = [0, x, c]
  else if (hue < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

/** 16 种染料色：混凝土、羊毛、陶瓦这些建筑方块都从它派生 */
const DYE_COLORS: Record<string, RGB> = {
  white: [233, 236, 236],
  orange: [240, 118, 19],
  magenta: [189, 68, 179],
  light_blue: [58, 175, 217],
  yellow: [248, 198, 39],
  lime: [112, 185, 25],
  pink: [237, 141, 172],
  gray: [62, 68, 71],
  light_gray: [142, 142, 134],
  cyan: [21, 137, 145],
  purple: [121, 42, 172],
  blue: [53, 57, 157],
  brown: [114, 71, 40],
  green: [84, 109, 27],
  red: [161, 39, 34],
  black: [20, 21, 25]
}

const DYE_RE =
  /^(white|orange|magenta|light_blue|yellow|lime|pink|light_gray|gray|cyan|purple|blue|brown|green|red|black)_(.+)$/

function scaleColor(c: RGB, f: number): RGB {
  // 必须夹到 0–255：写进 Uint8Array 时超出会取模，白色玻璃会变成近黑色
  return [
    Math.min(255, c[0] * f),
    Math.min(255, c[1] * f),
    Math.min(255, c[2] * f)
  ]
}

/** 建筑方块的派生色：白色混凝土是白，不是随机的紫灰 */
function dyeColor(name: string): RGB | null {
  const m = name.match(DYE_RE)
  if (!m) return null
  const base = DYE_COLORS[m[1]]
  if (!base) return null
  const kind = m[2]
  if (kind === 'concrete' || kind === 'wool' || kind === 'carpet' || kind === 'bed' || kind === 'shulker_box') {
    return base
  }
  if (kind === 'concrete_powder') return scaleColor(base, 1.08)
  if (kind === 'terracotta' || kind === 'glazed_terracotta') return scaleColor(base, 0.78)
  if (kind === 'stained_glass' || kind === 'stained_glass_pane') return scaleColor(base, 1.12)
  if (kind === 'banner' || kind === 'candle') return base
  return null
}

function hash2(x: number, z: number): number {
  let h = (x * 374761393 + z * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/** 方块名 → 颜色；树叶/植物带一点随位置变化的明暗，远看才像成片的树冠 */
function colorOf(rawName: string, x: number, z: number): RGB {
  const name = rawName.replace(/^minecraft:/, '')
  const exact = BLOCK_COLORS[name]
  if (exact) {
    if (name.endsWith('_leaves') || name === 'short_grass' || name === 'tall_grass') {
      const f = 0.94 + (hash2(x, z) % 13) / 100
      return scaleColor(exact, f)
    }
    return exact
  }
  if (name.endsWith('_leaves')) {
    const base = BLOCK_COLORS.oak_leaves
    const f = 0.93 + (hash2(x, z) % 15) / 100
    return scaleColor(base, f)
  }
  if (name.endsWith('_log') || name.endsWith('_wood')) return [104, 82, 52]
  if (name.endsWith('_planks')) return [162, 130, 78]
  const dye = dyeColor(name)
  if (dye) return dye
  return fallbackColor(name)
}

// ---------------------------------------------------------------- region 解析

const AIR = new Set([
  'minecraft:air',
  'minecraft:cave_air',
  'minecraft:void_air',
  'minecraft:light',
  'minecraft:barrier',
  'minecraft:structure_void',
  'minecraft:moving_piston'
])

/**
 * 解出一个 section 的 4096 个方块索引（YZX 顺序）。
 *
 * 注意：区块的 block_states 和高度图一样是「每个 long 放 floor(64/bits) 个，
 * 剩余位补零」，不是跨 long 连续打包。4 位（每 long 16 个）时两种算法恰好一致，
 * 所以只测小调色板看不出问题；5 位以上会错位，索引越界后画面会出现一片片
 * 颜色随机的「错误区块」。25 个方块的调色板对应 342 个 long 就是这个原因。
 */
export function decodeSectionIndices(
  paletteLength: number,
  data: readonly bigint[],
  count = 4096
): Uint16Array {
  if (paletteLength <= 1 || !data.length) return new Uint16Array(count) // 全是 palette[0]
  const bits = Math.max(4, Math.ceil(Math.log2(Math.max(1, paletteLength))))
  return unpackLongs(data, bits, count, false)
}

function sectionIndices(sec: { palette: string[]; data: bigint[] }): Uint16Array {
  return decodeSectionIndices(sec.palette.length, sec.data)
}

interface ColumnSurface {
  name: string
  y: number
  depth: number
}

/** 读一个区块的所有列的地表方块 */
function surfaceOfChunk(chunk: ChunkNbt): (ColumnSurface | null)[] {
  const sections = chunk.sections
    .filter((sec) => !sec.palette.every((n) => AIR.has(`minecraft:${n}`)))
    .map((sec) => ({
      y: sec.y,
      palette: sec.palette,
      data: sec.data,
    }))
    .sort((a, b) => b.y - a.y)

  const out: (ColumnSurface | null)[] = new Array(256).fill(null)
  let resolved = 0

  // 水深从高度图里拿：MOTION_BLOCKING（含水）减去 OCEAN_FLOOR（不含水）。
  // 高度图是 9 位、每个 long 里只放 7 个（末尾补 1 位），和 block_states 的
  // 连续打包不一样 —— 37 个 long 正好是 7 个一格的结果。
  const surfaceHm = chunk.motion ? unpackLongs(chunk.motion, 9, 256, false) : null
  const floorHm = chunk.floor ? unpackLongs(chunk.floor, 9, 256, false) : null

  for (const sec of sections) {
    if (resolved >= 256) break
    const indices = sectionIndices(sec)
    const baseY = sec.y * 16
    for (let ly = 15; ly >= 0; ly--) {
      const y = baseY + ly
      for (let z = 0; z < 16; z++) {
        const row = ly * 256 + z * 16
        for (let x = 0; x < 16; x++) {
          const col = z * 16 + x
          if (out[col]) continue
          const idx = indices[row + x]
          const name = sec.palette[idx] ?? 'air'
          if (AIR.has(`minecraft:${name}`)) continue
          let depth = 0
          if (name === 'water') {
            // 高度图里的值是「最高方块 + 1」；差 1 不影响深浅的观感
            const s = surfaceHm ? surfaceHm[col] - 1 : y
            const f = floorHm ? floorHm[col] - 1 : y - 1
            depth = Math.max(1, Math.min(64, s - f))
          }
          out[col] = { name, y, depth }
          resolved++
        }
      }
    }
  }
  return out
}

/** 解析一个 region，返回 RGBA 像素、高度（y + 128）与已探索格数 */
export function renderRegionFromBuffer(buf: Buffer): {
  rgba: Uint8Array
  heights: Uint16Array
  explored: number
  chunks: number
} {
  const rgba = new Uint8Array(REGION_PX * REGION_PX * 4)
  const heights = new Uint16Array(REGION_PX * REGION_PX)
  const depths = new Uint8Array(REGION_PX * REGION_PX)
  let explored = 0
  let chunks = 0

  if (buf.length < 8192) return { rgba, heights, explored, chunks }

  for (let lz = 0; lz < 32; lz++) {
    for (let lx = 0; lx < 32; lx++) {
      const locIndex = (lz * 32 + lx) * 4
      const offset = buf.readUIntBE(locIndex, 3) * 4096
      if (!offset) continue
      if (offset + 5 > buf.length) continue
      const length = buf.readUInt32BE(offset)
      if (length < 2 || offset + 4 + length > buf.length) continue
      const compression = buf[offset + 4]
      const data = buf.subarray(offset + 5, offset + 4 + length)

      let raw: Buffer
      try {
        if (compression === 1) raw = gunzipSync(data)
        else if (compression === 2) raw = inflateSync(data)
        else if (compression === 3) raw = data
        else continue // LZ4 等不常见的压缩方式
      } catch {
        continue
      }

      let chunk: ChunkNbt
      try {
        chunk = parseChunkNbt(raw)
      } catch {
        continue
      }
      chunks++

      const cols = surfaceOfChunk(chunk)

      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const surf = cols[z * 16 + x]
          if (!surf) continue
          const px = lx * 16 + x
          const py = lz * 16 + z
          const i = py * REGION_PX + px
          heights[i] = surf.y + HEIGHT_BIAS
          depths[i] = Math.min(255, surf.depth)
          const [r, g, b] = colorOf(surf.name, lx * 16 + x, lz * 16 + z)
          rgba[i * 4] = r
          rgba[i * 4 + 1] = g
          rgba[i * 4 + 2] = b
          rgba[i * 4 + 3] = 255
          explored++
        }
      }
    }
  }

  // ---- 晕渲：西北方向光，高度差决定明暗；水按深度变暗
  //
  // 高度先做一次 3×3 平均：树叶之间的高度差是「树冠噪声」，直接拿来做梯度
  // 会把森林画成横条；地形起伏（山、峡谷）平滑后仍然在。
  const smooth = new Uint16Array(REGION_PX * REGION_PX)
  for (let z = 0; z < REGION_PX; z++) {
    for (let x = 0; x < REGION_PX; x++) {
      let sum = 0
      let n = 0
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz
        if (zz < 0 || zz >= REGION_PX) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= REGION_PX) continue
          const v = heights[zz * REGION_PX + xx]
          if (!v) continue
          sum += v
          n++
        }
      }
      smooth[z * REGION_PX + x] = n ? sum / n : 0
    }
  }

  for (let z = 0; z < REGION_PX; z++) {
    for (let x = 0; x < REGION_PX; x++) {
      const i = z * REGION_PX + x
      if (!rgba[i * 4 + 3]) continue
      const h = heights[i]
      const xm = smooth[x > 0 ? i - 1 : i]
      const xp = smooth[x < REGION_PX - 1 ? i + 1 : i]
      const zm = smooth[z > 0 ? i - REGION_PX : i]
      const zp = smooth[z < REGION_PX - 1 ? i + REGION_PX : i]
      // 0 表示这一格没有数据，别让它把边缘拉黑
      const gx = xm && xp ? (xp - xm) : 0
      const gz = zm && zp ? (zp - zm) : 0
      let shade = Math.max(0.68, Math.min(1.32, 1 - gx * 0.045 - gz * 0.045))

      // 水深：水在颜色表里是 #386cd0，按深度再压暗
      const isWater = rgba[i * 4] === 56 && rgba[i * 4 + 1] === 108 && rgba[i * 4 + 2] === 208
      if (isWater) {
        shade *= 1 - Math.min(depths[i], 24) * 0.018
      }
      const high = (h - HEIGHT_BIAS - 64) * 0.0006
      shade *= 1 + Math.max(-0.06, Math.min(0.08, high))

      rgba[i * 4] = Math.max(0, Math.min(255, rgba[i * 4] * shade))
      rgba[i * 4 + 1] = Math.max(0, Math.min(255, rgba[i * 4 + 1] * shade))
      rgba[i * 4 + 2] = Math.max(0, Math.min(255, rgba[i * 4 + 2] * shade))
    }
  }

  return { rgba, heights, explored, chunks }
}

export interface RegionRender {
  png: Buffer
  heights: Uint16Array
  explored: number
  chunks: number
}

export async function renderRegionFile(path: string): Promise<RegionRender> {
  const buf = await fs.readFile(path)
  const { rgba, heights, explored, chunks } = renderRegionFromBuffer(buf)
  return {
    png: encodePng(rgba, REGION_PX, REGION_PX),
    heights,
    explored,
    chunks
  }
}
