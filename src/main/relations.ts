import type { PluginInfo } from '../shared/types'

/**
 * 扩展之间的依赖关系。
 *
 * 磁盘上只有一堆 jar，谁要谁得挨个把描述文件翻出来对。这里做三件事：
 *
 * 1. **谁提供什么**：模组的 id，加上它额外声明的 provides。
 *    Fabric API 那种一个 jar 装 44 个小模组的写法，内层 id 也算它提供
 *    （见 extmeta.ts 的嵌套读取）——不这么做，所有依赖 fabric-api-base
 *    的模组都会被误报成「缺前置」。
 * 2. **谁要谁**：硬前置（缺了根本不加载）和软前置（没装也能跑）分开。
 * 3. **缺没缺**：没找到 = 缺失；找到了但被禁用 = 前置被禁用。
 *    这两个是「装完起不来」最常见的原因，也是这个界面存在的理由。
 *
 * 平台自带的 id（minecraft / fabricloader / forge / paper …）不算缺失：
 * 它们不是扩展，任何一台服务器上都当存在。
 */

/** 平台自带、永远当存在的 id。少了这一条，每个模组都会因为依赖 minecraft 而报缺失 */
const PLATFORM_IDS = new Set([
  'minecraft',
  'java',
  'forge',
  'neoforge',
  'fml',
  'fabricloader',
  'fabric',
  'quilt_loader',
  'bukkit',
  'craftbukkit',
  'spigot',
  'paper',
  'purpur',
  'folia',
  'velocity',
  'bungeecord',
  'waterfall',
  'mcdreforged',
  // MCDR 插件的 dependencies 里可以写 python 运行时要求（KPI 就这么写的）
  'python',
  'python3',
  'sponge',
  'server'
])

/** 规范化 id：大小写、空格、下划线在写描述文件时经常被随手写 */
export function normId(id: string): string {
  return id.trim().toLowerCase()
}

export interface RelationEdge {
  /** 被依赖的 id（原样显示，不转小写） */
  id: string
  /** 硬前置还是软前置 */
  hard: boolean
  /** 依赖方声明的要求，形如 >=0.15 / [1.21,1.22)，没写就是空 */
  range: string
  /**
   * ok      已装（满足它的那个扩展，可能是 provides）
   * disabled 装了但被禁用
   * missing  没有
   * platform 平台自带，不用管
   */
  state: 'ok' | 'disabled' | 'missing' | 'platform'
  /** 提供它的那个扩展的 path，界面上点一下能跳过去 */
  provider: string | null
  /** 提供它的扩展的名字（给界面显示用） */
  providerName: string | null
}

export interface DependentRef {
  /** 依赖方的 path */
  path: string
  name: string
  soft: boolean
}

export interface RelationIssue {
  kind: 'missing' | 'disabled'
  id: string
  /** 需要它的那些扩展 */
  neededBy: string[]
  /** 前置被禁用时，它自己的 path */
  provider: string | null
}

/**
 * 给一份扩展列表算好依赖关系，直接写在每个 item 上。
 * 返回整体的问题汇总（界面上那条提示栏用）。
 */
export function buildRelations(items: PluginInfo[]): RelationIssue[] {
  // 谁提供了哪些 id。同一个 id 可能被多个文件提供（两份不同版本的模组），
  // 优先取已启用的那个——否则会把「其实能跑」的情况报成缺前置
  const offer = new Map<string, PluginInfo[]>()
  for (const item of items) {
    const ids = new Set<string>()
    if (item.id) ids.add(normId(item.id))
    for (const p of item.provides) ids.add(normId(p))
    for (const id of ids) {
      if (!offer.has(id)) offer.set(id, [])
      offer.get(id)!.push(item)
    }
  }

  const issues = new Map<string, RelationIssue>()
  const addIssue = (kind: 'missing' | 'disabled', id: string, by: string, provider: string | null): void => {
    const key = `${kind}:${normId(id)}`
    const found = issues.get(key)
    if (found) {
      if (!found.neededBy.includes(by)) found.neededBy.push(by)
      return
    }
    issues.set(key, { kind, id, neededBy: [by], provider })
  }

  for (const item of items) {
    const edges: RelationEdge[] = []
    const seen = new Set<string>()

    const addEdge = (rawId: string, hard: boolean): void => {
      const id = rawId.trim()
      if (!id || seen.has(normId(id))) return
      seen.add(normId(id))

      const range = item.ranges[id] ?? ''
      const key = normId(id)

      if (PLATFORM_IDS.has(key)) {
        edges.push({ id, hard, range, state: 'platform', provider: null, providerName: null })
        return
      }

      const candidates = offer.get(key) ?? []
      const enabled = candidates.find((c) => c.enabled)
      const pick = enabled ?? candidates[0]
      if (!pick) {
        edges.push({ id, hard, range, state: 'missing', provider: null, providerName: null })
        // 软前置缺失不算问题：没装也能跑，报出来只是噪音
        if (hard) addIssue('missing', id, item.path, null)
        return
      }

      edges.push({
        id,
        hard,
        range,
        state: pick.enabled ? 'ok' : 'disabled',
        provider: pick.path,
        providerName: pick.name
      })
      if (!pick.enabled && hard) addIssue('disabled', id, item.path, pick.path)
    }

    for (const id of item.depends) addEdge(id, true)
    for (const id of item.softDepends) addEdge(id, false)

    item.requires = edges
  }

  // 反向索引：谁被依赖
  const usedBy = new Map<string, DependentRef[]>()
  for (const item of items) {
    for (const edge of item.requires) {
      if (!edge.provider || edge.id === item.id) continue
      if (!usedBy.has(edge.provider)) usedBy.set(edge.provider, [])
      usedBy.get(edge.provider)!.push({ path: item.path, name: item.name, soft: !edge.hard })
    }
  }
  for (const item of items) {
    item.usedBy = usedBy.get(item.path) ?? []
  }

  // 缺前置排在前面：那是「服务器起不来」的原因，被禁用的通常还能跑
  const list = [...issues.values()]
  list.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'missing' ? -1 : 1))
  return list
}
