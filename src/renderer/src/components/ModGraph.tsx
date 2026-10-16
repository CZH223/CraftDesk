import { useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui'
import { DEFAULT_LIMIT, buildStarGraph, graphBounds, type GraphNode } from '../graph'
import type { PluginInfo } from '../../../shared/types'

/**
 * 模组关系星图。
 *
 * 中心是当前关注的模组，左半边是它的前置（红），右半边是依赖它的（蓝），
 * 外面一圈是这些模组各自的其它关系（灰）。点任意节点就换中心，
 * 「回到当前模组位置」退回最初那个。
 *
 * 自己画 SVG 而不引第三方图库：整个项目零运行时依赖，而且这里的布局是
 * 确定性的（见 graph.ts），不需要每帧迭代，几百个节点直接渲染就很流畅。
 */

const ROLE_COLOR: Record<GraphNode['role'], string> = {
  center: '#f43f5e',
  dep: '#ef4444',
  dependent: '#3b82f6',
  related: '#71717a'
}

const ROLE_LABEL: Record<GraphNode['role'], string> = {
  center: '当前模组',
  dep: '前置模组',
  dependent: '拓展模组',
  related: '联动模组'
}

export function ModGraph({
  items,
  focusPath,
  serverName,
  onClose,
  onPick
}: {
  items: PluginInfo[]
  /** 打开时聚焦的模组（面板里点「星图」时传当前那个） */
  focusPath?: string | null
  serverName: string
  onClose: () => void
  /** 双击节点时跳到那个模组的详情 */
  onPick?: (path: string) => void
}): JSX.Element {
  const [focus, setFocus] = useState<string | null>(focusPath ?? null)
  const [limit, setLimit] = useState(String(DEFAULT_LIMIT))
  const [hover, setHover] = useState<string | null>(null)
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  const limitNum = Math.max(5, Math.min(2000, Number(limit) || DEFAULT_LIMIT))

  const graph = useMemo(() => {
    const list = onlyEnabled ? items.filter((i) => i.enabled) : items
    return buildStarGraph(list, focus, limitNum)
  }, [items, focus, limitNum, onlyEnabled])

  const hovered = hover ? graph.nodes.find((n) => n.key === hover) ?? null : null
  const linkedKeys = useMemo(() => {
    if (!hovered) return null
    const set = new Set<string>([hovered.key])
    for (const l of graph.links) {
      if (l.from === hovered.key) set.add(l.to)
      if (l.to === hovered.key) set.add(l.from)
    }
    return set
  }, [hovered, graph.links])

  const byKey = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph.nodes])
  const bounds = graphBounds(graph)
  const padding = 90
  const width = Math.max(320, bounds.maxX - bounds.minX + padding * 2)
  const height = Math.max(320, bounds.maxY - bounds.minY + padding * 2)

  /** 拖动画布 */
  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>): void => {
    dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
  }
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const d = dragRef.current
    if (!d) return
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }))
  }
  const endDrag = (): void => {
    dragRef.current = null
  }

  /**
   * 滚轮缩放：以鼠标位置为中心，缩放手感才对。
   *
   * 注意 rect 必须在事件处理函数里当场取出来 —— React 的 setState 更新函数
   * 是延迟执行的（可能在渲染阶段才跑），那时候事件对象已经被回收，
   * `e.currentTarget` 是 null，读它会抛异常并把整个界面搞成白屏。
   */
  const onWheel = (e: React.WheelEvent<SVGSVGElement>): void => {
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left - rect.width / 2
    const cy = e.clientY - rect.top - rect.height / 2

    setView((v) => {
      const k = Math.max(0.15, Math.min(4, v.k * factor))
      const scale = k / v.k
      return { k, x: cx - (cx - v.x) * scale, y: cy - (cy - v.y) * scale }
    })
  }

  const reset = (): void => {
    setFocus(focusPath ?? null)
    setView({ x: 0, y: 0, k: 1 })
  }

  const centerName = graph.center?.name ?? '（没有可显示的模组）'

  return (
    <Modal
      title={`模组关系星图 · ${centerName}`}
      onClose={onClose}
      size="full"
      footer={
        <>
          <span className="hint">
            点节点换中心 · 拖拽平移 · 滚轮缩放
            {onPick && ' · 双击跳到该模组'}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
            复位视图
          </button>
          <button className="btn primary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="graph-bar">
        <button className="btn sm" onClick={reset} disabled={!focusPath}>
          <Icon name="refresh" size={14} />
          回到当前模组位置
        </button>
        <label className="graph-field">
          模组数量限制
          <input
            className="input"
            style={{ width: 78 }}
            value={limit}
            onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ''))}
          />
        </label>
        <span className="hint">
          共 {graph.total} 个
          {graph.hidden > 0 && `（图上 ${graph.nodes.length} 个，省去 ${graph.hidden} 个）`}
        </span>
        <label className="graph-field">
          <input
            type="checkbox"
            className="net-check"
            checked={onlyEnabled}
            onChange={(e) => setOnlyEnabled(e.target.checked)}
          />
          只看已启用
        </label>
        <div className="spacer" />
        <div className="graph-legend">
          {(['dep', 'dependent', 'related'] as GraphNode['role'][]).map((role) => (
            <span key={role} className="graph-legend-item">
              <span className="graph-dot" style={{ background: ROLE_COLOR[role] }} />
              {ROLE_LABEL[role]}
            </span>
          ))}
        </div>
      </div>

      {graph.nodes.length === 0 ? (
        <div className="panel-empty">
          {serverName} 里没有可显示的扩展。装几个模组再来看看。
        </div>
      ) : (
        <div className="graph-canvas">
          <svg
            width="100%"
            height="100%"
            viewBox={`${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}`}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={() => {
              endDrag()
              setHover(null)
            }}
            onWheel={onWheel}
            style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
          >
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {/* 线画在节点下面，免得盖住名字 */}
              {graph.links.map((l, i) => {
                const a = byKey.get(l.from)
                const b = byKey.get(l.to)
                if (!a || !b) return null
                const dim = linkedKeys && !(linkedKeys.has(l.from) && linkedKeys.has(l.to))
                const active = hovered && (l.from === hovered.key || l.to === hovered.key)
                return (
                  <line
                    key={`${l.from}->${l.to}-${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={active ? '#e4e4e7' : l.hard ? '#52525b' : '#3f3f46'}
                    strokeWidth={active ? 1.6 : 1}
                    strokeDasharray={l.hard ? undefined : '3 3'}
                    opacity={dim ? 0.18 : 1}
                  />
                )
              })}

              {graph.nodes.map((n) => {
                const dim = linkedKeys && !linkedKeys.has(n.key)
                const isHover = hovered?.key === n.key
                return (
                  <g
                    key={n.key}
                    transform={`translate(${n.x} ${n.y})`}
                    opacity={dim ? 0.25 : 1}
                    style={{ cursor: n.focusable ? 'pointer' : 'default' }}
                    onMouseEnter={() => setHover(n.key)}
                    onClick={() => n.focusable && setFocus(n.key)}
                    onDoubleClick={() => n.focusable && onPick?.(n.key)}
                  >
                    <circle
                      r={n.radius}
                      fill={ROLE_COLOR[n.role]}
                      fillOpacity={n.role === 'related' ? 0.85 : 1}
                      stroke={isHover ? '#fafafa' : n.missing ? '#fca5a5' : 'transparent'}
                      strokeWidth={isHover ? 2 : 1.5}
                      strokeDasharray={n.missing ? '3 2' : undefined}
                    />
                    {/* 被禁用的打个空心环：和「已启用」区分开 */}
                    {!n.enabled && (
                      <circle r={n.radius + 3} fill="none" stroke="#f59e0b" strokeWidth={1.4} />
                    )}
                    <text
                      x={n.x >= 0 ? n.radius + 6 : -(n.radius + 6)}
                      y={4}
                      textAnchor={n.x >= 0 ? 'start' : 'end'}
                      fontSize={n.role === 'center' ? 15 : 12}
                      fill={isHover ? '#fafafa' : 'var(--text-dim)'}
                      style={{ pointerEvents: 'none' }}
                    >
                      {n.name}
                      {n.role === 'center' && n.modId ? `（${n.modId}）` : ''}
                    </text>
                  </g>
                )
              })}
            </g>
          </svg>

          {hovered && (
            <div className="graph-tip">
              <b>{hovered.name}</b>
              {hovered.modId && <span className="hint"> · {hovered.modId}</span>}
              <br />
              <span className="hint">
                {ROLE_LABEL[hovered.role]}
                {hovered.missing && ' · 没有安装'}
                {!hovered.enabled && !hovered.missing && ' · 被禁用'}
                {hovered.degree > 0 && ` · 关系 ${hovered.degree}`}
              </span>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
