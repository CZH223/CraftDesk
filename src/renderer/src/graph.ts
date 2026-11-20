import type {
  McmodRelationCategory,
  McmodRelationNode,
  McmodRelations,
  ModCompat,
  PluginInfo,
  PluginKind
} from '../../shared/types'

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

export type GraphRole = 'center' | 'dep' | 'dependent' | 'related' | 'linked' | 'other'

export interface GraphNode {
  /** 唯一键：模组的目录内路径，缺失的前置用 missing:<id> */
  key: string
  name: string
  /** 模组 id（界面上小字显示） */
  modId: string
  /** 扩展类型：缺失的前置用中心扩展的类型，下载时据此决定装到 mods/ 还是 plugins/ */
  kind: PluginKind
  role: GraphRole
  x: number
  y: number
  /** 画多大 */
  radius: number
  /** 连了几条线，用来定大小与排序 */
  degree: number
  /** 第几圈：0 = 中心，1 = 直接关系，2 = 挂在第一圈旁边的，3 = 无依赖关系的其它模组 */
  ring: 0 | 1 | 2 | 3
  /** 已启用 / 被禁用 */
  enabled: boolean
  /** 缺的前置：没有对应文件 */
  missing: boolean
  /** 缺的是硬前置（软前置只做提示，不强制补） */
  hardMissing: boolean
  /** 找不到对应条目的东西点不动 */
  focusable: boolean
  /** 来自 MC百科、本地没有对应 jar */
  external?: boolean
  /** MC百科给这条关系分的类 */
  externalCategory?: Exclude<McmodRelationCategory, 'center'>
  /** MC百科 class id；本地安装的模组匹配上时也会补上 */
  classId?: string
  /** MC百科收录了这个模组 */
  onMcmod?: boolean
}

export interface GraphLink {
  from: string
  to: string
  hard: boolean
  /** 来自 MC百科的补充关系，画成虚线 */
  external?: boolean
}

export interface Graph {
  nodes: GraphNode[]
  links: GraphLink[]
  /** 这份数据里一共有多少个模组 */
  total: number
  /** 总数减图上节点数：数量上限和「不显示无关系模组」都会算进来 */
  hidden: number
  /** 和中心没有任何依赖路径的模组数量（不管这次有没有画出来） */
  unrelated: number
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
 * @param showUnrelated 是否把和中心没有依赖路径的模组也画在外圈
 */
export function buildStarGraph(
  items: PluginInfo[],
  focusPath?: string | null,
  limit = DEFAULT_LIMIT,
  showUnrelated = true
): Graph {
  const total = items.length
  const byPath = new Map(items.map((i) => [i.path, i]))
  const center = pickCenter(items, focusPath)
  if (!center) {
    return { nodes: [], links: [], total, hidden: 0, unrelated: total, center: null }
  }

  const cap = Math.max(5, limit)
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const placed = new Set<string>()

  // platform 是 minecraft / neoforge 这类平台依赖，不算「关系」，否则
  // 中心明明只依赖一个 API，悬停却会显示「关系 3」
  const degreeOf = (i: PluginInfo): number =>
    i.requires.filter((e) => e.state !== 'platform').length + i.usedBy.length

  const centerNode: GraphNode = {
    key: center.path,
    name: center.name,
    modId: center.id,
    kind: center.kind,
    role: 'center',
    x: 0,
    y: 0,
    radius: 26,
    degree: degreeOf(center),
    ring: 0,
    enabled: center.enabled,
    missing: false,
    hardMissing: false,
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
    kind: PluginKind,
    role: GraphRole,
    ring: 1 | 2 | 3,
    angleDeg: number,
    distance: number,
    focusable: boolean,
    opts: { enabled?: boolean; missing?: boolean; hardMissing?: boolean; degree?: number } = {}
  ): GraphNode => {
    const rad = (angleDeg * Math.PI) / 180
    const degree = opts.degree ?? 0
    const node: GraphNode = {
      key,
      name,
      modId,
      kind,
      role,
      x: Math.cos(rad) * distance,
      y: Math.sin(rad) * distance,
      // 连得越多画得越大：一眼能看出哪个是枢纽
      radius: role === 'center' ? 26 : 6 + Math.min(12, degree * 0.8),
      degree,
      ring,
      enabled: opts.enabled ?? true,
      missing: opts.missing ?? false,
      hardMissing: opts.hardMissing ?? false,
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
      target?.kind ?? center.kind,
      'dep',
      1,
      pos?.angle ?? 180,
      pos?.distance ?? RING1,
      Boolean(target),
      {
        enabled: target ? target.enabled : false,
        missing: !target,
        hardMissing: !target && edge.hard,
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
      target.kind,
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
          target?.kind ?? center.kind,
          n.missing ? 'dep' : 'related',
          2,
          angles[i] ?? parentAngle,
          RING2 + ringOffset,
          Boolean(target),
          {
            enabled: target ? target.enabled : false,
            missing: n.missing,
            hardMissing: n.missing && n.hard,
            degree: target ? degreeOf(target) : 0
          }
        )
        links.push({ from: parent.key, to: n.key, hard: n.hard })
      })
    }
  }

  /*
   * 和中心没有任何依赖路径的模组。
   *
   * 以前这些模组完全不出现在图上，但顶部又写着「共 7 个、图上 2 个」，
   * 看起来像图出了问题。现在默认把它们放到最外圈，用「无关系」区分；
   * 不想看时可以关掉，但计数会明确写出来，而不是含糊地说「省去」。
   */
  const relationKeys = new Set(nodes.map((n) => n.key))
  const others = items.filter((i) => !relationKeys.has(i.path))
  const unrelated = others.length

  if (showUnrelated && others.length > 0 && nodes.length < cap) {
    const chosen = [...others]
      .sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) ||
          degreeOf(b) - degreeOf(a) ||
          a.name.localeCompare(b.name)
      )
      .slice(0, cap - nodes.length)
    const n = chosen.length
    // 数量多时分成几条道，否则外圈名字会挤在一起
    const perLane = 22
    const lanes = Math.min(4, Math.max(1, Math.ceil(n / perLane)))
    chosen.forEach((item, i) => {
      const lane = lanes === 1 ? 0 : i % lanes
      const indexInLane = Math.floor(i / lanes)
      const inLane = Math.ceil((n - lane) / lanes)
      const angle = -90 + (360 / Math.max(1, inLane)) * indexInLane + lane * 3
      put(
        item.path,
        item.name,
        item.id,
        item.kind,
        'other',
        3,
        angle,
        RING2 + 140 + lane * 74,
        true,
        { enabled: item.enabled, degree: degreeOf(item) }
      )
    })
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
      unrelated,
      center: centerNode
    }
  }

  return { nodes, links, total, hidden, unrelated, center: centerNode }
}

/**
 * 把 MC百科的「前置 / 拓展 / 联动」并进本地星图。
 *
 * 本地 jar 只能告诉我们真实加载依赖；MC百科知道的是「这个模组和谁一起用
 * 更完整」（联动），以及大量没有写进 jar 的拓展关系。这里只并中心直接
 * 相连的一圈：
 * - 能和本地模组对上的，不重复建节点，只补一条虚线关系；
 * - 对不上的建成外圈节点，标记「百科」，可以选中下载。
 *
 * 外圈按类别分弧：前置在左、拓展在右、联动在上方，和本地关系保持一致。
 */
export function mergeMcmodRelations(
  graph: Graph,
  items: PluginInfo[],
  rel: McmodRelations | null,
  limit = DEFAULT_LIMIT,
  compat?: Record<string, ModCompat>
): Graph {
  if (!rel || !graph.center) return graph
  const cap = Math.max(5, limit)
  const centerKey = graph.center.key

  // 浅拷贝，避免把 classId 写到 useMemo 缓存的上一次结果里
  const nodes = graph.nodes.map((n) => ({ ...n }))
  const links = graph.links.map((l) => ({ ...l }))
  const nodeByKey = new Map(nodes.map((n) => [n.key, n]))

  const norm = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const byName = new Map<string, PluginInfo>()
  const byId = new Map<string, PluginInfo>()
  for (const item of items) {
    byName.set(norm(item.name), item)
    byId.set(norm(item.id), item)
  }

  const centerNode = nodeByKey.get(centerKey)
  if (centerNode) {
    centerNode.classId = rel.classId
    centerNode.onMcmod = true
  }

  const hasLink = (a: string, b: string): boolean =>
    links.some((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a))

  const roleOf = (category: 'required' | 'extends' | 'linked'): GraphRole =>
    category === 'required' ? 'dep' : category === 'extends' ? 'dependent' : 'linked'

  type Candidate = { extra: McmodRelationNode; local?: PluginInfo }
  const candidates: Candidate[] = []
  const seenClass = new Set<string>()
  for (const extra of rel.nodes) {
    if (extra.category === 'center') continue
    if (extra.classId) {
      if (seenClass.has(extra.classId)) continue
      seenClass.add(extra.classId)
    }
    const en = norm(extra.englishName)
    const local = byId.get(en) ?? byName.get(en) ?? byName.get(norm(extra.name))
    if (local) {
      const target = nodeByKey.get(local.path)
      if (target) {
        target.classId = extra.classId ?? target.classId
        target.onMcmod = true
        // 本地图里原本是「无关系」的节点，按百科关系换个颜色
        if (target.role === 'other') {
          target.role = roleOf(extra.category)
          target.externalCategory = extra.category
        }
        if (!hasLink(local.path, centerKey)) {
          links.push(
            extra.category === 'required'
              ? { from: local.path, to: centerKey, hard: true, external: true }
              : { from: centerKey, to: local.path, hard: true, external: true }
          )
        }
      } else {
        // 被「无关系」开关或节点上限隐藏了：百科既然说它有关系，就补进来。
        // 边等节点真正放进图里再加，避免和下面的摆放逻辑重复。
        candidates.push({ extra, local })
      }
      continue
    }
    const key = `mcmod:${extra.classId ?? extra.englishName}`
    // 服务器版本 / 加载器下没有任何可用版本：不画出来
    if (compat?.[key] === 'bad') continue
    candidates.push({ extra })
  }

  const slots = Math.max(0, cap - nodes.length)
  const chosen = candidates.slice(0, slots)
  if (!chosen.length) {
    const hidden = Math.max(0, graph.total - nodes.filter((n) => !n.external).length)
    return { ...graph, nodes, links, hidden, center: nodeByKey.get(centerKey) ?? graph.center }
  }

  // 外圈半径：比现有最远节点再大一截，避免和本地关系/无关系环叠在一起
  const baseRadius =
    Math.max(0, ...nodes.map((n) => Math.hypot(n.x, n.y))) + 130
  const arcs: Record<'required' | 'extends' | 'linked', [number, number]> = {
    required: [150, 210], // 左
    extends: [-60, 60], // 右
    linked: [240, 300] // 上
  }
  for (const category of ['required', 'extends', 'linked'] as const) {
    const group = chosen.filter((c) => c.extra.category === category)
    if (!group.length) continue
    const [a0, a1] = arcs[category]
    const perLane = 16
    const lanes = Math.min(4, Math.max(1, Math.ceil(group.length / perLane)))
    group.forEach((candidate, i) => {
      const extra = candidate.extra
      const local = candidate.local
      const lane = lanes === 1 ? 0 : i % lanes
      const indexInLane = Math.floor(i / lanes)
      const inLane = Math.ceil((group.length - lane) / lanes)
      const angle =
        inLane <= 1 ? (a0 + a1) / 2 : a0 + ((a1 - a0) / (inLane - 1)) * indexInLane
      const rad = (angle * Math.PI) / 180
      const distance = baseRadius + lane * 74
      const key = local?.path ?? `mcmod:${extra.classId ?? extra.englishName}`
      if (nodeByKey.has(key)) return
      const node: GraphNode = {
        key,
        name: local?.name ?? extra.name,
        modId: local?.id ?? (extra.englishName || extra.name),
        kind: local?.kind ?? graph.center!.kind,
        role: roleOf(category),
        x: Math.cos(rad) * distance,
        y: Math.sin(rad) * distance,
        radius: local ? 6 + Math.min(12, local.requires.length + local.usedBy.length) : 9,
        degree: local ? local.requires.length + local.usedBy.length : 0,
        ring: 3,
        enabled: local?.enabled ?? false,
        missing: !local,
        hardMissing: !local && category === 'required',
        focusable: Boolean(local),
        external: !local,
        externalCategory: category,
        classId: extra.classId ?? undefined,
        onMcmod: true
      }
      nodes.push(node)
      nodeByKey.set(key, node)
      links.push(
        category === 'required'
          ? { from: key, to: centerKey, hard: true, external: true }
          : { from: centerKey, to: key, hard: true, external: true }
      )
    })
  }

  const hidden = Math.max(0, graph.total - nodes.filter((n) => !n.external).length)
  return {
    ...graph,
    nodes,
    links,
    hidden,
    center: nodeByKey.get(centerKey) ?? graph.center
  }
}

/** 图上所有没安装的模组 */
export function missingGraphNodes(graph: Graph): GraphNode[] {
  return graph.nodes
    .filter((n) => n.missing)
    .sort((a, b) => Number(b.hardMissing) - Number(a.hardMissing))
}

/** 下载需要的字段；GraphNode 和「图外缺失项」都满足这个形状 */
export interface MissingDependency {
  key: string
  modId: string
  name: string
  kind: PluginKind
  hardMissing: boolean
}

/**
 * 整个服务器里所有缺失的前置，不只是画出来的那些。
 *
 * 节点数量上限会把一部分关系省掉；如果「一键补齐」只看图上的节点，
 * 这些省掉的缺失就会永远补不上。这里直接扫一遍全部扩展的依赖关系，
 * 按 id 去重，硬前置排在前面。
 */
export function allMissingDependencies(
  items: PluginInfo[],
  onlyEnabled = false
): MissingDependency[] {
  const seen = new Map<string, MissingDependency>()
  for (const item of items) {
    if (onlyEnabled && !item.enabled) continue
    for (const edge of item.requires) {
      if (edge.state !== 'missing') continue
      const key = `missing:${edge.id}`
      const prev = seen.get(key)
      if (prev && (prev.hardMissing || !edge.hard)) continue
      seen.set(key, {
        key,
        modId: edge.id,
        name: edge.providerName ?? edge.id,
        kind: item.kind,
        hardMissing: edge.hard
      })
    }
  }
  return [...seen.values()].sort(
    (a, b) => Number(b.hardMissing) - Number(a.hardMissing) || a.name.localeCompare(b.name)
  )
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
