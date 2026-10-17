import { useMemo, useState } from 'react'
import { Icon } from './Icon'
import { useStore, type ViewKey } from '../store'
import { kindLabel } from '../utils'
import { ServerAvatar } from './ServerAvatar'
import { isProxyKind, type ServerView, type TopoEdge, type TopoNode } from '../../../shared/types'

export function ServerList({ onAdd }: { onAdd: () => void }): JSX.Element {
  const servers = useStore((s) => s.servers)
  const topology = useStore((s) => s.topology)
  const activeId = useStore((s) => s.activeId)
  const select = useStore((s) => s.select)
  const setView = useStore((s) => s.setView)
  const view = useStore((s) => s.view)
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)

  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const byId = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers])

  const matches = (s: ServerView): boolean => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return (
      s.name.toLowerCase().includes(q) ||
      s.dir.toLowerCase().includes(q) ||
      s.mcVersion.toLowerCase().includes(q) ||
      kindLabel(s.kind).toLowerCase().includes(q)
    )
  }

  const toggle = async (s: ServerView): Promise<void> => {
    const res =
      s.runtime.status === 'stopped' || s.runtime.status === 'crashed'
        ? await window.api.server.start(s.id)
        : await window.api.server.stop(s.id)
    if (!res.ok) toast(res.error ?? '操作失败', 'error')
    else void refresh()
  }

  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const rowProps = (s: ServerView) => ({
    server: s,
    active: s.id === activeId,
    view,
    onSelect: () => select(s.id),
    onToggle: () => void toggle(s),
    onOpenView: (v: ViewKey) => {
      select(s.id)
      setView(v)
    }
  })

  // 没有拓扑数据时退回平铺列表，至少不会因为解析失败而空掉
  const proxies = topology?.proxies ?? []
  const standalone = (topology?.standalone ?? [])
    .map((n) => byId.get(n.id))
    .filter((s): s is ServerView => Boolean(s))

  const hasTree = proxies.length > 0

  const flat = servers.filter(matches)

  return (
    <div className="side">
      <div className="side-head">
        <button className="side-add" onClick={onAdd}>
          <Icon name="plus" size={17} />
          <span>添加服务器</span>
        </button>
      </div>

      <div className="side-search">
        <Icon name="search" size={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索服务器"
          spellCheck={false}
        />
        {query && (
          <button className="icon-btn" style={{ width: 20, height: 20 }} onClick={() => setQuery('')}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      <div className="side-list">
        {servers.length === 0 && (
          <div className="side-empty">
            还没有任何服务器
            <br />
            点击上方「添加服务器」开始
          </div>
        )}

        {!hasTree && servers.length > 0 && (
          <>
            {flat.length === 0 && <div className="side-empty">没有匹配的服务器</div>}
            {flat.map((s) => (
              <ServerRow key={s.id} {...rowProps(s)} depth={0} />
            ))}
          </>
        )}

        {hasTree &&
          proxies.map((p) => {
            const proxy = byId.get(p.node.id)
            if (!proxy) return null
            const isCollapsed = collapsed.has(proxy.id)
            const children = p.backends

            // 搜索时只保留命中的分支
            const q = query.trim().toLowerCase()
            const proxyHit = !q || matches(proxy)
            const shownChildren = q
              ? children.filter(
                  (c) => proxyHit || c.name.toLowerCase().includes(q) || c.address.includes(q)
                )
              : children
            if (q && !proxyHit && shownChildren.length === 0) return null

            return (
              <div key={proxy.id} className="tree-branch">
                <ServerRow
                  {...rowProps(proxy)}
                  depth={0}
                  tree={{ collapsed: isCollapsed, count: children.length, onToggle: () => toggleCollapse(proxy.id) }}
                />
                {!isCollapsed &&
                  shownChildren.map((child) => {
                    const edge = p.edges.find((e) => e.backendId === child.id)
                    const managed = child.managed ? byId.get(child.id) : undefined
                    return (
                      <BackendRow
                        key={child.id}
                        node={child}
                        edge={edge}
                        server={managed}
                        active={child.id === activeId}
                        view={view}
                        runningCount={shownChildren.filter((c) => c.running).length}
                        onSelect={() => managed && select(managed.id)}
                        onToggle={() => managed && void toggle(managed)}
                        onOpenView={(v) => {
                          if (!managed) return
                          select(managed.id)
                          setView(v)
                        }}
                      />
                    )
                  })}
              </div>
            )
          })}

        {hasTree && standalone.length > 0 && (
          <>
            <div className="group-label">
              <span className="dot stopped" />
              独立服务器 · {standalone.length}
            </div>
            {standalone.filter(matches).map((s) => (
              <ServerRow key={s.id} {...rowProps(s)} depth={0} />
            ))}
          </>
        )}

        {servers.length > 0 && hasTree && proxies.length === 0 && standalone.length === 0 && (
          <div className="side-empty">没有匹配的服务器</div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 顶层节点

function ServerRow({
  server,
  active,
  view,
  depth,
  tree,
  onSelect,
  onToggle,
  onOpenView
}: {
  server: ServerView
  active: boolean
  view: ViewKey
  depth: number
  tree?: { collapsed: boolean; count: number; onToggle: () => void }
  onSelect: () => void
  onToggle: () => void
  onOpenView: (v: ViewKey) => void
}): JSX.Element {
  const rt = server.runtime
  const running = rt.status !== 'stopped' && rt.status !== 'crashed'

  const sub = rt.externalRunning
    ? [`在线 ${rt.onlineCount}/${rt.maxPlayers}`, rt.port != null ? `:${rt.port}` : null, '外部启动']
        .filter(Boolean)
        .join(' · ')
    : running
    ? [
        rt.onlineCount > 0 ? `在线 ${rt.onlineCount}/${rt.maxPlayers}` : '已启动',
        rt.port != null ? `:${rt.port}` : null,
        rt.pid != null ? `PID ${rt.pid}` : null
      ]
        .filter(Boolean)
        .join(' · ')
    : [kindLabel(server.kind), server.mcVersion || null].filter(Boolean).join(' · ') ||
      '未识别服务端类型'

  return (
    <>
      <button
        className={`server-item ${active ? 'active' : ''}`}
        onClick={onSelect}
        style={{ paddingLeft: 10 + depth * 16 }}
      >
        {tree && (
          <span
            role="button"
            tabIndex={0}
            className="tree-toggle"
            title={tree.collapsed ? `展开 ${tree.count} 个后端` : '收起后端'}
            onClick={(e) => {
              e.stopPropagation()
              tree.onToggle()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation()
                tree.onToggle()
              }
            }}
          >
            <Icon name={tree.collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
          </span>
        )}
        <ServerAvatar server={server} />
        <span className="server-main">
          <span className="server-name">
            {server.name}
            {isProxyKind(server.kind) && <span className="tag cyan">入口</span>}
            <span className={`dot ${rt.status}`} />
          </span>
          <span className="server-sub">{sub}</span>
        </span>
        <span className="server-actions">
          <span
            role="button"
            tabIndex={0}
            className="icon-btn"
            style={{ width: 24, height: 24 }}
            title={running ? '停止服务器' : '启动服务器'}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation()
                onToggle()
              }
            }}
          >
            <Icon name={running ? 'stop' : 'play'} size={running ? 12 : 13} />
          </span>
        </span>
      </button>

      {active && (
        <div style={{ paddingLeft: 36 + depth * 16, paddingBottom: 4 }}>
          <SubItem
            active={view === 'console'}
            icon="terminal"
            label={running ? '控制台 · 实时日志' : '控制台'}
            onClick={() => onOpenView('console')}
          />
          <SubItem
            active={view === 'properties'}
            icon="sliders"
            label={isProxyKind(server.kind) ? '跨服配置' : '服务器属性'}
            onClick={() => onOpenView('properties')}
          />
          {!isProxyKind(server.kind) && (
            <SubItem
              active={view === 'map'}
              icon="map"
              label="世界地图"
              onClick={() => onOpenView('map')}
            />
          )}
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------ 后端子节点

function BackendRow({
  node,
  edge,
  server,
  active,
  view,
  onSelect,
  onToggle,
  onOpenView
}: {
  node: TopoNode
  edge?: TopoEdge
  server?: ServerView
  active: boolean
  view: ViewKey
  runningCount: number
  onSelect: () => void
  onToggle: () => void
  onOpenView: (v: ViewKey) => void
}): JSX.Element {
  const rt = server?.runtime
  const running = rt ? rt.status !== 'stopped' && rt.status !== 'crashed' : false

  return (
    <div className="tree-child">
      <button
        className={`backend-row ${active ? 'active' : ''} ${node.managed ? '' : 'external'}`}
        onClick={onSelect}
        disabled={!node.managed}
        title={node.managed ? server?.dir : `${node.address} · CraftDesk 未导入这个服务端`}
      >
        <span className={`dot-line ${running ? 'on' : ''}`} />
        <span className="backend-name">
          {node.name}
          {edge?.isTry && (
            <span className="tag green" title="try 列表里的默认入口">
              默认
            </span>
          )}
          {node.sharedPort && (
            <span className="tag red" title="有另一个服务器配了同一个端口，两者不能同时启动">
              同端口
            </span>
          )}
        </span>
        <span className="backend-meta">
          {node.running && node.onlinePlayers > 0 && (
            <span className="tag orange" title="本机在线人数">
              {node.onlinePlayers}
              {node.maxPlayers > 0 && `/${node.maxPlayers}`}
            </span>
          )}
          {node.port != null && <span className="mono">:{node.port}</span>}
          {edge?.proxyMod ? (
            <span
              className={`tag ${edge.secretOk === false ? 'red' : 'green'}`}
              title={`${edge.proxyMod}${edge.secretOk === false ? ' · 密钥不一致' : ''}`}
            >
              {edge.secretOk === false ? '密钥不符' : '已转发'}
            </span>
          ) : node.managed ? (
            <span className="tag red" title="后端没装 FabricProxy / FabricProxy-Lite">
              无转发
            </span>
          ) : (
            <span className="tag">未导入</span>
          )}
        </span>
        {node.managed && (
          <span
            role="button"
            tabIndex={0}
            className="icon-btn"
            style={{ width: 22, height: 22 }}
            title={running ? '停止' : '启动'}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation()
                onToggle()
              }
            }}
          >
            <Icon name={running ? 'stop' : 'play'} size={running ? 10 : 11} />
          </span>
        )}
      </button>

      {active && node.managed && (
        <div style={{ paddingLeft: 34, paddingBottom: 4 }}>
          <SubItem
            active={view === 'console'}
            icon="terminal"
            label="控制台"
            onClick={() => onOpenView('console')}
          />
          <SubItem
            active={view === 'properties'}
            icon="sliders"
            label="服务器属性"
            onClick={() => onOpenView('properties')}
          />
          {server && !isProxyKind(server.kind) && (
            <SubItem
              active={view === 'map'}
              icon="map"
              label="世界地图"
              onClick={() => onOpenView('map')}
            />
          )}
        </div>
      )}
    </div>
  )
}

function SubItem({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean
  icon: Parameters<typeof Icon>[0]['name']
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px 10px',
        borderRadius: 7,
        fontSize: 13,
        color: active ? 'var(--text)' : 'var(--text-muted)',
        background: active ? 'var(--bg-active)' : 'transparent',
        textAlign: 'left'
      }}
    >
      <Icon name={icon} size={14} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  )
}
