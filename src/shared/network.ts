import type { Topology } from './types'

/**
 * 网络在线人数怎么算。
 *
 * 玩家是从代理端进来的，后端只是被转发到的下游：代理端记一次「已连接」，
 * 玩家被转到某个后端后后端又记一次，把两边相加等于把同一个人算两遍。
 *
 * 所以规则是：**代理端在跑就以它为准**；代理端没跑（玩家可能各自直连后端）
 * 才退回去数后端。人数上限同理——代理架构下后端 server.properties 里的
 * max-players 没有意义，玩家看到的由代理端决定。
 *
 * 主进程和界面共用这一份实现：主进程建拓扑时算一次，界面拿它按**实时**的
 * 服务器状态再算一次（拓扑结构是快照，人数不该是）。
 */
export interface LiveRuntime {
  running: boolean
  online: number
  max: number
}

interface CountNode {
  id: string
  managed: boolean
  running: boolean
  onlinePlayers: number
  maxPlayers: number
}

export function networkCounts(
  topo: Topology | null,
  live?: (id: string) => LiveRuntime | null
): { online: number; max: number } {
  if (!topo) return { online: 0, max: 0 }

  // 托管的服务器以调用方给的实时状态为准；外部节点（没导入的）只能用它自己那份
  const resolve = (n: CountNode): LiveRuntime => {
    if (n.managed && live) {
      const l = live(n.id)
      if (l) return l
    }
    return { running: n.running, online: n.onlinePlayers, max: n.maxPlayers }
  }

  let online = 0
  let max = 0

  for (const p of topo.proxies) {
    const proxy = resolve(p.node)
    if (proxy.running) {
      online += proxy.online
      max = Math.max(max, proxy.max)
      continue
    }
    for (const b of p.backends) {
      const back = resolve(b)
      if (back.running) online += back.online
    }
  }

  for (const n of topo.standalone) {
    const s = resolve(n)
    if (!s.running) continue
    online += s.online
    max = Math.max(max, s.max)
  }

  return { online, max }
}
