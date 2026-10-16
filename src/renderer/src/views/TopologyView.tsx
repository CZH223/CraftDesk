import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { useStore, type ViewKey } from '../store'
import { kindLabel, statusLabel } from '../utils'
import type { TopoNode, Topology } from '../../../shared/types'

/**
 * 网络拓扑。
 *
 * 代理端在最上面，它转发到的后端排成一行挂在下面——这是星形结构，
 * 不是平铺列表。连线画在 SVG 里，节点用 HTML 绝对定位叠在上面，
 * 这样节点能直接做成可点的按钮，样式也不用跟 SVG 较劲。
 */

const NODE_W = 168
const NODE_H = 58
const PROXY_W = 196
const GAP_X = 20
const GAP_Y = 46
const ROW_GAP = 84
const PER_ROW = 4

interface Placed {
  node: TopoNode
  x: number
  y: number
  w: number
  isProxy: boolean
  isTry: boolean
  forwardingOk: boolean | null
  hasForwardingMod: boolean
}

export function TopologyView({ onOpenServer }: { onOpenServer: (id: string, v: ViewKey) => void }): JSX.Element {
  const topology = useStore((s) => s.topology)
  const loadTopology = useStore((s) => s.loadTopology)
  const servers = useStore((s) => s.servers)
  const stats = useStore((s) => s.stats)
  const activeId = useStore((s) => s.activeId)
  const select = useStore((s) => s.select)
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)

  useEffect(() => {
    void loadTopology()
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 48))
    ro.observe(el)
    setWidth(el.clientWidth - 48)
    return () => ro.disconnect()
  }, [loadTopology])

  // 服务器状态变化时同步刷新拓扑（运行中/端口都会变）
  const sig = servers.map((s) => `${s.id}:${s.runtime.status}:${s.runtime.port}`).join('|')
  useEffect(() => {
    void loadTopology()
  }, [sig, loadTopology])

  const layout = useMemo(
    () => (topology ? computeLayout(topology, width) : null),
    [topology, width]
  )

  if (!topology || !layout) {
    return (
      <div className="topo" ref={containerRef}>
        <div className="center-state" style={{ minHeight: 200 }}>
          <div className="spin" />
          <div>正在解析服务器关系…</div>
        </div>
      </div>
    )
  }

  const hasAny = topology.proxies.length > 0 || topology.standalone.length > 0

  return (
    <div className="topo" ref={containerRef}>
      {!hasAny && (
        <div className="center-state" style={{ minHeight: 200 }}>
          <Icon name="server" size={26} />
          <div>还没有服务器</div>
          <div className="hint">添加服务器后，这里会画出代理端和后端的从属关系。</div>
        </div>
      )}

      {hasAny && (
        <>
          <div className="stat-cards" style={{ marginBottom: 14 }}>
            <div className="stat-card" style={{ padding: '10px 14px' }}>
              <div className="sv" style={{ fontSize: 19 }}>
                {topology.networkMax > 0
                  ? `${topology.networkOnline} / ${topology.networkMax}`
                  : topology.networkOnline}
              </div>
              <div className="sl">
                网络在线人数
                {topology.proxies.length > 0 && topology.networkMax > 0 && '（上限取自代理端）'}
              </div>
            </div>
            <div className="stat-card" style={{ padding: '10px 14px' }}>
              <div className="sv" style={{ fontSize: 19 }}>{topology.proxies.length}</div>
              <div className="sl">代理端入口</div>
            </div>
            <div className="stat-card" style={{ padding: '10px 14px' }}>
              <div className="sv" style={{ fontSize: 19 }}>
                {topology.proxies.reduce((n, p) => n + p.backends.filter((b) => b.managed).length, 0)}
                <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                  {' / '}
                  {topology.proxies.reduce((n, p) => n + p.backends.length, 0)}
                </span>
              </div>
              <div className="sl">后端已导入 / 全部</div>
            </div>
            <div className="stat-card" style={{ padding: '10px 14px' }}>
              <div className="sv" style={{ fontSize: 19 }}>{topology.standalone.length}</div>
              <div className="sl">独立服务器</div>
            </div>
          </div>

          <div className="topo-legend">
            <span className="item">
              <span className="swatch" style={{ borderColor: '#06b6d4' }} />
              代理端（玩家入口）
            </span>
            <span className="item">
              <span className="swatch" style={{ borderColor: '#22c55e' }} />
              try 默认入口
            </span>
            <span className="item">
              <span className="swatch" style={{ borderColor: '#3f3f46' }} />
              普通后端
            </span>
            <span className="item">
              <span className="swatch" style={{ borderColor: '#3f3f46', borderTopStyle: 'dashed' }} />
              未导入 CraftDesk
            </span>
            <span className="item">
              <span className="swatch" style={{ borderColor: '#ef4444' }} />
              同端口（互斥，不能同时启动）
            </span>
          </div>

          <div className="topo-stage" style={{ width: layout.width, height: layout.height }}>
            <svg className="topo-edges" width={layout.width} height={layout.height}>
              {layout.edges.map((e, i) => (
                <path
                  key={i}
                  d={e.d}
                  fill="none"
                  stroke={e.color}
                  strokeWidth={e.isTry ? 2 : 1.2}
                  strokeDasharray={e.dashed ? '4 4' : undefined}
                  opacity={e.dim ? 0.45 : 0.9}
                />
              ))}
              {layout.edges
                .filter((e): e is typeof e & { labelX: number; labelY: number } =>
                  e.isTry && e.labelX != null && e.labelY != null
                )
                .map((e, i) => (
                  <text key={`l${i}`} className="topo-edge-label" x={e.labelX} y={e.labelY}>
                    默认入口
                  </text>
                ))}
            </svg>

            {layout.placed.map((p) => {
              const s = servers.find((x) => x.id === p.node.id)
              const mem = stats[p.node.id]?.mem ?? 0
              return (
                <button
                  key={p.node.id}
                  className={[
                    'topo-node',
                    p.isProxy ? 'proxy' : '',
                    p.node.id === activeId ? 'active' : '',
                    p.node.managed ? '' : 'external'
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: p.x, top: p.y, width: p.w }}
                  title={p.node.managed ? p.node.address : `${p.node.address}（未导入 CraftDesk）`}
                  onClick={() => {
                    if (!p.node.managed) return
                    select(p.node.id)
                    onOpenServer(p.node.id, 'console')
                  }}
                >
                  <span className="tn-head">
                    <span className={`dot ${p.node.status}`} />
                    <span className="tn-name">{p.node.name}</span>
                    {p.isProxy && <Icon name="globe" size={13} style={{ color: '#06b6d4' }} />}
                  </span>
                  <span className="tn-sub">
                    {p.isProxy && <span className="tag cyan">入口</span>}
                    {p.node.kind && p.node.managed && <span>{kindLabel(p.node.kind)}</span>}
                    {p.node.port != null && <span className="mono">:{p.node.port}</span>}
                    {!p.node.managed && <span className="tag">未导入</span>}
                    {p.node.managed && (
                      <span className={`tag ${p.node.running ? 'green' : ''}`}>
                        {statusLabel(p.node.status)}
                      </span>
                    )}
                    {!p.isProxy && p.hasForwardingMod && (
                      <span className={`tag ${p.forwardingOk === false ? 'red' : 'green'}`}>
                        {p.forwardingOk === false ? '密钥不符' : '已转发'}
                      </span>
                    )}
                    {!p.isProxy && p.node.managed && !p.hasForwardingMod && (
                      <span className="tag red" title="后端没装 FabricProxy / FabricProxy-Lite">
                        无转发
                      </span>
                    )}
                    {p.node.managed && p.node.running && (
                      <span className="tag orange" title="本机在线人数">
                        {p.node.onlinePlayers}
                        {p.node.maxPlayers > 0 && `/${p.node.maxPlayers}`}
                      </span>
                    )}
                    {p.node.sharedPort && (
                      <span
                        className="tag red"
                        title="有另一个服务器配了同一个端口，两者不能同时启动"
                      >
                        同端口
                      </span>
                    )}
                    {mem > 0 && <span>{(mem / 1024 / 1024).toFixed(0)} MB</span>}
                  </span>
                </button>
              )
            })}
          </div>

          {topology.standalone.length > 0 && (
            <>
              <h2 style={{ fontSize: 14, margin: '28px 0 6px', color: 'var(--text-dim)' }}>
                独立服务器 · {topology.standalone.length}
              </h2>
              <div className="hint" style={{ marginBottom: 12 }}>
                这些服务器没有出现在任何代理端的 [servers] 里，玩家连不上它们，
                只能各自直连。
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {topology.standalone.map((n) => (
                  <button
                    key={n.id}
                    className={`topo-node ${n.id === activeId ? 'active' : ''}`}
                    style={{ position: 'relative', width: NODE_W }}
                    onClick={() => {
                      select(n.id)
                      onOpenServer(n.id, 'console')
                    }}
                  >
                    <span className="tn-head">
                      <span className={`dot ${n.status}`} />
                      <span className="tn-name">{n.name}</span>
                    </span>
                    <span className="tn-sub">
                      {n.kind && <span>{kindLabel(n.kind)}</span>}
                      {n.port != null && <span className="mono">:{n.port}</span>}
                      <span className={`tag ${n.running ? 'green' : ''}`}>{statusLabel(n.status)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ 布局计算

interface EdgePath {
  d: string
  color: string
  isTry: boolean
  dashed: boolean
  dim: boolean
  labelX: number | null
  labelY: number | null
}

function computeLayout(
  topology: Topology,
  available: number
): { width: number; height: number; placed: Placed[]; edges: EdgePath[] } {
  const width = Math.max(520, available)
  const placed: Placed[] = []
  const edges: EdgePath[] = []
  let y = 0

  for (const proxy of topology.proxies) {
    // 代理端节点居中
    const px = (width - PROXY_W) / 2
    placed.push({
      node: proxy.node,
      x: px,
      y,
      w: PROXY_W,
      isProxy: true,
      isTry: false,
      forwardingOk: null,
      hasForwardingMod: true
    })

    const childY = y + PROXY_W * 0 + ROW_GAP
    const n = proxy.backends.length
    const cols = Math.max(1, Math.min(PER_ROW, Math.floor((width + GAP_X) / (NODE_W + GAP_X))))
    const rows = Math.ceil(n / cols)

    proxy.backends.forEach((b, i) => {
      const row = Math.floor(i / cols)
      const col = i % cols
      // 每行实际用了几个，居中排
      const inRow = Math.min(cols, n - row * cols)
      const rowW = inRow * NODE_W + (inRow - 1) * GAP_X
      const startX = (width - rowW) / 2
      const x = startX + col * (NODE_W + GAP_X)
      const cy = childY + row * (NODE_H + GAP_Y)

      const edge = proxy.edges.find((e) => e.backendId === b.id)
      const isTry = edge?.isTry ?? false
      const hasFw = Boolean(edge?.proxyMod)
      const ok = edge?.secretOk ?? null

      placed.push({
        node: b,
        x,
        y: cy,
        w: NODE_W,
        isProxy: false,
        isTry,
        forwardingOk: ok,
        hasForwardingMod: hasFw
      })

      // 从代理端底部连到后端顶部，中间用一段竖直共用线再分叉
      const sx = px + PROXY_W / 2
      const sy = y + NODE_H
      const ex = x + NODE_W / 2
      const ey = cy
      const midY = sy + (ey - sy) * 0.55
      edges.push({
        d: `M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`,
        color: isTry ? '#22c55e' : b.managed ? '#3f3f46' : '#2f2f2f',
        isTry,
        dashed: !b.managed,
        dim: !b.managed,
        // try 的边标一下「默认入口」，放在曲线中点上方
        labelX: isTry ? (sx + ex) / 2 + 6 : null,
        labelY: isTry ? (sy + ey) / 2 - 6 : null
      })
    })

    y = childY + rows * (NODE_H + GAP_Y)
  }

  return { width, height: Math.max(y, 200), placed, edges }
}
