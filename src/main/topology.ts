import type {
  ServerConfig,
  ServerKind,
  ServerRuntime,
  TopoEdge,
  TopoNode,
  TopoProxy,
  Topology
} from '../shared/types'
import { isProxyKind } from '../shared/types'
import { networkCounts } from '../shared/network'
import { resolveLayout, type ServerLayout } from './layout'
import { probeForwarding, probeProxyReady } from './forwarding'
import { parsePropertiesFile } from './properties'
import { readProxyFile } from './proxyConfig'

/**
 * 网络拓扑。
 *
 * 代理端和它后面的服务端不是平级关系：代理端是玩家唯一的入口，
 * 后端只是被转发的下游。平铺在一个列表里会把这个结构藏起来，
 * 所以这里解析出「谁挂在谁下面」，交给界面画成树 / 星图。
 */

interface Managed {
  cfg: ServerConfig
  layout: ServerLayout
  port: number | null
}

async function loadManaged(
  servers: ServerConfig[],
  runtimeOf: (id: string) => ServerRuntime
): Promise<Map<string, Managed>> {
  const map = new Map<string, Managed>()
  for (const cfg of servers) {
    try {
      const layout = await resolveLayout(cfg)
      // 优先用运行中解析出来的真实端口，没跑就读配置文件
      let port = runtimeOf(cfg.id).port
      if (port == null) {
        const props = await parsePropertiesFile(layout.serverProperties)
        const raw = props.find((p) => p.key === 'server-port')?.value
        port = raw ? Number(raw) : layout.configuredPort
      }
      map.set(cfg.id, { cfg, layout, port })
    } catch {
      /* 单个服务器解析失败不影响整体 */
    }
  }
  return map
}

function toNode(
  cfg: ServerConfig,
  port: number | null,
  runtimeOf: (id: string) => ServerRuntime,
  sharedPort: boolean
): TopoNode {
  const rt = runtimeOf(cfg.id)
  /*
   * 外部启动的也算「在跑」。
   * 手动双击 start.bat、或者 MCDR 自己拉起来的服务端，进程不归 CraftDesk 管，
   * 但它确实在给玩家提供服务，人数也是真的——不算进来的话，星图上会显示成
   * 「离线、0 人」，而客户端里明明有人在玩。界面上另外用「外部启动」标注
   * 它不受这里控制。
   */
  const running = rt.status !== 'stopped' && rt.status !== 'crashed' || rt.externalRunning
  return {
    id: cfg.id,
    name: cfg.name,
    kind: cfg.kind,
    managed: true,
    running,
    status: rt.externalRunning ? 'external' : running ? rt.status : 'stopped',
    port,
    address: cfg.dir,
    onlinePlayers: running ? rt.onlineCount : 0,
    maxPlayers: rt.maxPlayers,
    sharedPort
  }
}

export async function buildTopology(
  servers: ServerConfig[],
  runtimeOf: (id: string) => ServerRuntime
): Promise<Topology> {
  const managed = await loadManaged(servers, runtimeOf)

  // 一个端口可能被多个服务器配上——它们互斥，但同时存在于配置里是合法的
  const byPort = new Map<number, Managed[]>()
  for (const m of managed.values()) {
    if (m.port == null) continue
    byPort.set(m.port, [...(byPort.get(m.port) ?? []), m])
  }

  const proxies: TopoProxy[] = []
  const claimed = new Set<string>()

  for (const [, m] of managed) {
    if (!isProxyKind(m.cfg.kind)) continue

    const file = await readProxyFile(m.cfg)
    const field = (k: string): string =>
      file.fields.find((f) => f.section === '' && f.key === k)?.value ?? ''

    const edges: TopoEdge[] = []
    const backends: TopoNode[] = []

    for (const entry of file.servers) {
      const targets = entry.port ? byPort.get(entry.port) ?? [] : []

      if (targets.length === 0) {
        // [servers] 里写了、但 CraftDesk 没导入的后端，画成虚节点
        backends.push({
          id: `external:${entry.address}`,
          name: entry.name,
          kind: '',
          managed: false,
          running: false,
          status: 'unknown',
          port: entry.port || null,
          address: entry.address,
          onlinePlayers: 0,
          maxPlayers: 0,
          sharedPort: false
        })
        edges.push({
          proxyId: m.cfg.id,
          backendId: `external:${entry.address}`,
          alias: entry.name,
          address: entry.address,
          isTry: file.tryList.includes(entry.name),
          proxyMod: null,
          secretOk: null
        })
        continue
      }

      /*
       * 同一端口上可能有好几台服务器（配置里允许，只是不能同时启动），
       * 但**只有真的能接转发的才算这台代理端的后端**：
       * 装没装转发模组 / 开没开原生转发，决定它是「后端」还是「碰巧占了同一个端口」。
       *
       * 之前只按端口对号，结果一台没装转发模组的独立服务器会挂在代理端下面，
       * 还带着个红色「无转发」标签——读起来像是代理端配错了，
       * 其实它压根不该出现在这棵子树里。对不上号的那台照常算独立服务器，
       * 代理端界面里的后端核对仍然会提示「这个端口上的服务端没装转发模组」。
       */
      const ready: { target: Managed; fw: { mod: string | null; secret: string | null } }[] = []
      for (const target of targets) {
        const judge = await probeProxyReady(
          target.layout,
          target.cfg.kind,
          file.format === 'bungee' ? 'bungee' : 'velocity'
        )
        if (!judge.ready) continue
        ready.push({ target, fw: await probeForwarding(target.layout) })
      }

      // 一个都没接上转发：这条 [servers] 在 CraftDesk 里没有对应后端，
      // 当作「没导入」画个虚节点，别把不相干的服务端拉进来充数
      if (ready.length === 0) {
        backends.push({
          id: `external:${entry.address}`,
          name: entry.name,
          kind: '',
          managed: false,
          running: false,
          status: 'unknown',
          port: entry.port || null,
          address: entry.address,
          onlinePlayers: 0,
          maxPlayers: 0,
          sharedPort: false
        })
        edges.push({
          proxyId: m.cfg.id,
          backendId: `external:${entry.address}`,
          alias: entry.name,
          address: entry.address,
          isTry: file.tryList.includes(entry.name),
          proxyMod: null,
          secretOk: null
        })
        continue
      }

      for (const { target, fw } of ready) {
        claimed.add(target.cfg.id)
        const node = toNode(target.cfg, target.port, runtimeOf, ready.length > 1)

        backends.push(node)
        edges.push({
          proxyId: m.cfg.id,
          backendId: node.id,
          alias: entry.name,
          address: entry.address,
          isTry: file.tryList.includes(entry.name),
          proxyMod: fw.mod,
          secretOk: fw.mod ? (fw.secret && file.secret ? fw.secret === file.secret : null) : null
        })
      }
    }

    proxies.push({
      node: toNode(m.cfg, m.port, runtimeOf, false),
      backends,
      edges,
      forwardingMode: field('player-info-forwarding-mode') || 'none',
      secret: file.secret
    })
  }

  // 没被任何代理端引用的，就是独立服务器
  const standalone: TopoNode[] = []
  for (const [id, m] of managed) {
    if (claimed.has(id)) continue
    if (proxies.some((p) => p.node.id === id)) continue
    standalone.push(toNode(m.cfg, m.port, runtimeOf, (byPort.get(m.port ?? -1)?.length ?? 0) > 1))
  }

  const rank = (k: ServerKind | ''): number =>
    k === 'velocity' || k === 'bungeecord' || k === 'waterfall' ? 0 : 1
  standalone.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'zh-CN'))

  // ---- 网络层面的在线人数 ----
  // 算法在 shared/network.ts 里，界面算实时的那份用的是同一个函数
  const { online: networkOnline, max: networkMax } = networkCounts({
    proxies,
    standalone,
    networkOnline: 0,
    networkMax: 0
  })

  return { proxies, standalone, networkOnline, networkMax }
}
