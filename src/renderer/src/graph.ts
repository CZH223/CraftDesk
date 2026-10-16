import type { PluginInfo } from '../../shared/types'

/**
 * 模组关系星图：把「谁需要谁」画成一张以某个模组为中心的星图。
 *
 * 为什么是这种形状：依赖关系是「一个中心 + 一圈关系」的，用径向布局一眼能看出
 * 中心是谁的什么（左边是它的前置、右边是依赖它的），比列表或树更适合回答
 * 「这个模组到底牵扯到哪些东西」。
 *
 * 为什么不用力导向（force layout）：那样每帧都要迭代、节点会飘，
 * 而且同一份数据两次打开位置不一样。这里全是确定性计算 —— 打开就稳定，
 * 也才能在测试里断言「没有 NaN、都在画布内、上限真的生效」。
 *
 * 角度约定：前置在左半边（180° 附近），依赖它的在右半边（0° 附近），
 * 第二圈挂到各自那一环的节点旁边。
 */

export type GraphRole = 'center' | 'dep' | 'dependent' | 'related'

export interface GraphNode {
  /** 唯一键：模组的目录内路径，缺失的前置用 missing:<id> */
  key: string
  name: string
  /** 模组 id（界面上小字显示） */
  modId: string
  role: GraphRole
  x: number
  y: number
  /** 画多大 */
  radius: number
  /** 连了几条线，用来定大小与排序 */
  degree: number
  /** 第几圈：0 = 中心，1 = 直接关系，2 = 挂在第一圈旁边的 */
  ring: 0 | 1 | 2
  /** 已启用 / 被禁用 */
  enabled: boolean
  /** 缺的前置：没有对应文件 */
  missing: boolean
  /** 找不到对应条目的东西点不动 */
  focusable: boolean
}

export interface GraphLink {
  from: string
  to: string
  hard: boolean
}

export interface Graph {
  nodes: GraphNode[]
  links: GraphLink[]
  /** 这份数据里一共有多少个模组 */
  total: number
  /** 因为数量上限被省掉的 */
  hidden: number
  /** 中心节点 */
  center: GraphNode | null
}

/** 画布半径：布局算在这个范围内，界面再按缩放适配 */
export const GRAPH_RADIUS = 460
const RING1 = 170
const RING2 = 320

export const DEFAULT_LIMIT = 150

/**
 * 选一个中心：优先用户点开的那个，否则选被依赖最多的（通常是 Fabric API 这种大前置）。
 * 谁都依赖不上、也没依赖别人的时候，就退回第一个。
 */
export function pickCenter(items: PluginInfo[], focusPath?: string | null): PluginInfo | null {
  if (!items.length) return null
  if (focusPath) {
    const hit = items.find((i) => i.path === focusPath)
    if (hit) return hit
  }
  return [...items].sort((a, b) => b.usedBy.length - a.usedBy.length)[0] ?? null
}

/**
 * 算一张星图。
 *
 * @param items  当前服务器的全部扩展
 * @param focusPath 中心模组；不给就自动挑一个
 * @param limit  节点上限（中心永远保留）
 */
export function buildStarGraph(
  items: PluginInfo[],
  focusPath?: string | null,
  limit = DEFAULT_LIMIT
): Graph {
  const total = items.length
  const byPath = new Map(items.map((i) => [i.path, i]))
  const center = pickCenter(items, focusPath)
  if (!center) {
    return { nodes: [], links: [], total, hidden: 0, center: null }
  }

  const cap = Math.max(5, limit)
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const placed = new Set<string>()

  const degreeOf = (i: PluginInfo): number => i.requires.length + i.usedBy.length

  const centerNode: GraphNode = {
    key: center.path,
    name: center.name,
    modId: center.id,
    role: 'center',
    x: 0,
    y: 0,
    radius: 26,
    degree: degreeOf(center),
    ring: 0,
    enabled: center.enabled,
    missing: false,
    focusable: true
  }
  nodes.push(centerNode)
  placed.add(center.path)

  /**
   * 第一圈：左边当前置、右边当被依赖。
   * 两边各自按角度均匀铺开，铺的是「被依赖多的先占正位置」的顺序 ——
   * 大前置靠近水平线，一眼就能看到。
   */
  // 连得多的排中间：spread 会把中间那个放在 180° / 0°，也就是正左 / 正右
  const byDegree = (path: string | null): number => {
    const item = path ? byPath.get(path) : null
    return item ? degreeOf(item) : 0
  }
  const deps = center.requires
    .filter((e) => e.state !== 'platform')
    .sort((a, b) => byDegree(b.provider) - byDegree(a.provider))
  const dependents = [...center.usedBy].sort((a, b) => byDegree(b.path) - byDegree(a.path))

  const put = (
    key: string,
    name: string,
    modId: string,
    role: GraphRole,
    ring: 1 | 2,
    angleDeg: number,
    distance: number,
    focusable: boolean,
    opts: { enabled?: boolean; missing?: boolean; degree?: number } = {}
  ): GraphNode => {
    const rad = (angleDeg * Math.PI) / 180
    const degree = opts.degree ?? 0
    const node: GraphNode = {
      key,
      name,
      modId,
      role,
      x: Math.cos(rad) * distance,
      y: Math.sin(rad) * distance,
      // 连得越多画得越大：一眼能看出哪个是枢纽
      radius: role === 'center' ? 26 : 6 + Math.min(12, degree * 0.8),
      degree,
      ring,
      enabled: opts.enabled ?? true,
      missing: opts.missing ?? false,
      focusable
    }
    nodes.push(node)
    placed.add(key)
    return node
  }

  /** 把 n 个角度铺在 [start, end] 区间里，两端各留一点边距 */
  const spread = (n: number, start: number, end: number): number[] => {
    if (n <= 0) return []
    if (n === 1) return [(start + end) / 2]
    const step = (end - start) / (n - 1)
    return Array.from({ length: n }, (_, i) => start + step * i)
  }

  /**
   * 一环里的节点位置。
   *
   * 全都放在同一个半径上会挤成一条弧：Fabric API 那 74 个「依赖它的」
   * 铺在 124° 里，名字全叠在一起没法看。所以按「泳道」错开半径 ——
   * 同一环里最多 18 个占一条道，多的往下一条道放，越靠中间的道越靠外，
   * 名字之间就有纵向间隙了。
   */
  const ringPositions = (
    count: number,
    baseRadius: number,
    arc: [number, number]
  ): { angle: number; distance: number }[] => {
    const perLane = 18
    const lanes = Math.min(4, Math.max(1, Math.ceil(count / perLane)))
    const laneGap = 74
    const [a0, a1] = arc

    return Array.from({ length: count }, (_, i) => {
      const lane = lanes === 1 ? 0 : i % lanes
      const indexInLane = Math.floor(i / lanes)
      const inLane = Math.ceil((count - lane) / lanes)
      // 每条道自己在自己的角度区间里均分，并稍微错开起点，避免上下对齐
      const offset = lane * (6 / Math.max(1, lanes))
      const angles = spread(inLane, a0 + offset, a1 + offset)
      return {
        angle: angles[indexInLane] ?? (a0 + a1) / 2,
        distance: baseRadius + lane * laneGap
      }
    })
  }

  // 前置：左半边（180° 是正左方）。多了就往弧更宽、道更多
  const depArc: [number, number] = [
    180 - Math.min(86, 46 + deps.length),
    180 + Math.min(86, 46 + deps.length)
  ]
  const depPos = ringPositions(deps.length, RING1, depArc)
  deps.forEach((edge, i) => {
    const target = edge.provider ? byPath.get(edge.provider) : null
    const key = target ? target.path : `missing:${edge.id}`
    if (placed.has(key)) return
    const pos = depPos[i]
    const node = put(
      key,
      target?.name ?? edge.id,
      target?.id ?? edge.id,
      'dep',
      1,
      pos?.angle ?? 180,
      pos?.distance ?? RING1,
      Boolean(target),
      {
        enabled: target ? target.enabled : false,
        missing: !target,
        degree: target ? degreeOf(target) : 0
      }
    )
    links.push({ from: key, to: center.path, hard: edge.hard })
    return node
  })

  // 被依赖：右半边（0° 是正右方）
  const depArc2: [number, number] = [
    -Math.min(86, 46 + dependents.length),
    Math.min(86, 46 + dependents.length)
  ]
  const depPos2 = ringPositions(dependents.length, RING1, depArc2)
  dependents.forEach((ref, i) => {
    const target = byPath.get(ref.path)
    if (!target || placed.has(target.path)) return
    const pos = depPos2[i]
    put(
      target.path,
      target.name,
      target.id,
      'dependent',
      1,
      pos?.angle ?? 0,
      pos?.distance ?? RING1,
      true,
      { enabled: target.enabled, degree: degreeOf(target) }
    )
    links.push({ from: target.path, to: center.path, hard: !ref.soft })
  })

  /*
   * 第二圈：第一圈每个节点自己的其它关系（灰线）。
   * 挂到父节点角度附近，再往外一圈 —— 这样整张图还是围绕中心展开的，
   * 不会出现一条线横穿画面。
   */
  if (nodes.length < cap) {
    const firstRing = nodes.filter((n) => n.role === 'dep' || n.role === 'dependent')
    let parentIndex = 0
    for (const parent of firstRing) {
      parentIndex++
      if (nodes.length >= cap) break
      const item = byPath.get(parent.key)
      if (!item) continue
      const parentAngle = (Math.atan2(parent.y, parent.x) * 180) / Math.PI

      /*
       * 邻居分两种：装了的（画成灰点）和没装的（画成红点）。
       * 少了后一种，第二圈里「这个模组缺的那个前置」就看不见了 ——
       * 而缺前置正是这张图最该指出来的东西。
       */
      const neighbours: { key: string; missing: boolean; hard: boolean }[] = []
      for (const e of item.requires) {
        if (e.state === 'platform') continue
        if (e.provider && byPath.has(e.provider)) {
          neighbours.push({ key: e.provider, missing: false, hard: e.hard })
        } else if (e.state === 'missing') {
          neighbours.push({ key: `missing:${e.id}`, missing: true, hard: e.hard })
        }
      }
      for (const u of item.usedBy) {
        if (byPath.has(u.path)) neighbours.push({ key: u.path, missing: false, hard: !u.soft })
      }

      const fresh = neighbours.filter((n) => !placed.has(n.key)).slice(0, 3)
      const angles = spread(fresh.length, parentAngle - 20, parentAngle + 20)
      // 相邻父节点的孩子会挤在同一圈上，隔一个父节点往外挪一条道
      const ringOffset = (parentIndex % 2) * 58
      fresh.forEach((n, i) => {
        if (nodes.length >= cap) return
        const target = byPath.get(n.key)
        put(
          n.key,
          target?.name ?? n.key.replace(/^missing:/, ''),
          target?.id ?? n.key.replace(/^missing:/, ''),
          n.missing ? 'dep' : 'related',
          2,
          angles[i] ?? parentAngle,
          RING2 + ringOffset,
          Boolean(target),
          {
            enabled: target ? target.enabled : false,
            missing: n.missing,
            degree: target ? degreeOf(target) : 0
          }
        )
        links.push({ from: parent.key, to: n.key, hard: n.hard })
      })
    }
  }

  /*
   * 数量上限。
   *
   * 第一圈也可能爆掉 —— 像 Fabric API 那样被 70 多个模组依赖的中心，
   * 光第一圈就 70 个节点。所以两边都要按「关系多」排序后截断，
   * 而不是无脑保留第一圈（那样上限根本不起作用）。
   */
  const trim = (list: GraphNode[], keep: Set<string>): void => {
    for (const n of [...list].sort((a, b) => b.degree - a.degree)) {
      if (keep.size >= cap) break
      keep.add(n.key)
    }
  }

  let hidden = Math.max(0, total - nodes.length)
  if (nodes.length > cap) {
    const keep = new Set<string>([centerNode.key])
    trim(
      nodes.filter((n) => n.role === 'dep' || n.role === 'dependent'),
      keep
    )
    trim(
      nodes.filter((n) => n.role === 'related'),
      keep
    )

    const dropped = new Set(nodes.filter((n) => !keep.has(n.key)).map((n) => n.key))
    hidden += dropped.size
    return {
      nodes: nodes.filter((n) => keep.has(n.key)),
      links: links.filter((l) => !dropped.has(l.from) && !dropped.has(l.to)),
      total,
      hidden,
      center: centerNode
    }
  }

  return { nodes, links, total, hidden, center: centerNode }
}

/** 节点在画布上的包围盒，用来算「刚好放下」的初始缩放 */
export function graphBounds(graph: Graph): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = 0
  let maxX = 0
  let minY = 0
  let maxY = 0
  for (const n of graph.nodes) {
    minX = Math.min(minX, n.x - n.radius)
    maxX = Math.max(maxX, n.x + n.radius)
    minY = Math.min(minY, n.y - n.radius)
    maxY = Math.max(maxY, n.y + n.radius)
  }
  return { minX, maxX, minY, maxY }
}
