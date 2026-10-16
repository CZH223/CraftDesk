import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { useStore, type ViewKey } from '../store'
import {
  formatBytes,
  formatDuration,
  kindLabel,
  relativeTime,
  statusLabel
} from '../utils'
import { ServerAvatar } from '../components/ServerAvatar'
import { isProxyKind, type ServerStatus, type ServerView } from '../../../shared/types'
import { networkCounts } from '../../../shared/network'

/**
 * 总览页。
 *
 * 布局参考常见启动器的服务器列表：上面一个「快捷操作」盒子，下面一条条
 * 通栏的服务器行，每行左边是图标和状态，右边是状态文字加两个按钮
 * （启动/停止、启动配置）。整行可点，点进去就是那台服务器的控制台。
 *
 * 和卡片网格相比，通栏行在服务器多的时候更好扫：名字、状态、端口在同一列上
 * 对齐，眼睛不用在网格里跳。
 */
export function DashboardView({
  onAdd,
  onOpenServer
}: {
  onAdd: () => void
  onOpenServer: (id: string, view?: ViewKey) => void
}): JSX.Element {
  const servers = useStore((s) => s.servers)
  const stats = useStore((s) => s.stats)
  const topology = useStore((s) => s.topology)
  const activeId = useStore((s) => s.activeId)
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)
  const [info, setInfo] = useState<{ cpus: number; totalMem: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    void window.api.app
      .info()
      .then((r) => r.ok && info === null && setInfo({ cpus: r.data!.cpus, totalMem: r.data!.totalMem }))
    // 运行时长实时走秒
    const t = setInterval(() => setTick((v) => v + 1), 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * 总览只列「服务器」，代理端不混在里面。
   *
   * 代理端是网络入口，它和它的后端不是平级关系：平铺成一行行的，
   * 看着就像跨服只是「又一台服务器」。代理端的位置在左树（作为那一组的根）
   * 和网络拓扑（星图正中），总览这边只留一个入口提示。
   */
  const proxies = servers.filter((s) => isProxyKind(s.kind))
  const listable = servers.filter((s) => !isProxyKind(s.kind))

  const running = servers.filter((s) => s.runtime.status !== 'stopped' && s.runtime.status !== 'crashed')
  const crashed = servers.filter((s) => s.runtime.status === 'crashed')

  /*
   * 在线人数：拓扑只提供「谁挂在谁下面」这层结构，人数按**当前**的运行时状态
   * 现算——不然玩家进服了，这行小字还得等下次刷拓扑才会变。
   * 代理端在跑就以它为准，否则退回去数后端：规则在 shared/network.ts 里，
   * 和主进程用的是同一份。
   */
  const { online: onlineTotal, max: onlineMax } = networkCounts(topology, (id) => {
    const s = servers.find((x) => x.id === id)
    if (!s) return null
    return {
      running:
        (s.runtime.status !== 'stopped' && s.runtime.status !== 'crashed') || s.runtime.externalRunning,
      online: s.runtime.onlineCount,
      max: s.runtime.maxPlayers
    }
  })
  const memTotal = Object.values(stats).reduce((n, s) => n + (s.mem || 0), 0)
  const uptimeTotal = servers.reduce((n, s) => {
    const live = s.runtime.startedAt ? Math.floor((Date.now() - s.runtime.startedAt) / 1000) : 0
    return n + (s.totalUptime || 0) + live
  }, 0)

  /**
   * 配了同一个端口的服务器（它们互斥，不能同时启动）。
   * 这件事只有拓扑算得出来——要跨服务器比对端口，单个 ServerView 里没有这个信息。
   */
  const sharedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of topology?.proxies ?? []) {
      for (const b of p.backends) if (b.sharedPort && b.managed) ids.add(b.id)
    }
    for (const n of topology?.standalone ?? []) {
      if (n.sharedPort && n.managed) ids.add(n.id)
    }
    return ids
  }, [topology])

  const startAll = async (): Promise<void> => {
    setBusy(true)
    const stopped = servers.filter((s) => s.runtime.status === 'stopped')
    for (const s of stopped) {
      const res = await window.api.server.start(s.id)
      if (!res.ok) toast(`${s.name}：${res.error}`, 'error')
    }
    setBusy(false)
    void refresh()
  }

  const stopAll = async (): Promise<void> => {
    setBusy(true)
    for (const s of running) await window.api.server.stop(s.id)
    setBusy(false)
    void refresh()
  }

  return (
    <div className="dash">
      <section className="quick-box">
        <h3>快捷操作</h3>
        <div className="quick-row">
          <button className="qb" disabled={busy || running.length === servers.length} onClick={() => void startAll()}>
            <Icon name="play" size={13} />
            全部启动
          </button>
          <button className="qb" disabled={busy || running.length === 0} onClick={() => void stopAll()}>
            <Icon name="stop" size={12} />
            全部停止
          </button>
          <button
            className="qb"
            disabled={busy}
            onClick={() => {
              void refresh()
              toast('已刷新服务器状态', 'success')
            }}
          >
            <Icon name="refresh" size={14} />
            刷新所有服务器
          </button>
          <button className="qb primary" onClick={onAdd}>
            <Icon name="plus" size={15} />
            添加新服务器
          </button>
        </div>
        <div className="quick-note">
          {listable.length} 个服务器 · 运行中 {running.length} · 在线{' '}
          {onlineMax > 0 ? `${onlineTotal} / ${onlineMax}` : onlineTotal} · 内存{' '}
          {memTotal > 0 ? formatBytes(memTotal) : '—'} · 累计运行 {formatDuration(uptimeTotal)}
          {info && ` · 本机 ${info.cpus} 核 / ${formatBytes(info.totalMem)}`}
        </div>
        {proxies.length > 0 && (
          <div className="quick-note" style={{ marginTop: 6 }}>
            代理端（{proxies.map((p) => p.name).join('、')}）不列在这里 —— 它是整张网络的入口，
            在左侧列表里作为那一组的根、在
            <button className="link-btn" onClick={() => useStore.getState().setView('topology')}>
              网络拓扑
            </button>
            里看。
          </div>
        )}
      </section>

      {crashed.length > 0 && (
        <div className="issue-bar error" style={{ margin: '0 0 12px' }}>
          <Icon name="alert" size={16} />
          <span className="issue-text">
            有 {crashed.length} 个服务器上次异常退出，点开看看最后的日志。
          </span>
        </div>
      )}

      {listable.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
          还没有添加任何服务器。点「添加新服务器」导入已有的服务端目录，或者直接下载一个新的。
        </div>
      ) : (
        <div className="srv-list">
          {listable.map((s) => (
            <ServerLine
              key={s.id}
              server={s}
              mem={stats[s.id]?.mem ?? 0}
              active={s.id === activeId}
              sharedPort={sharedIds.has(s.id)}
              onOpen={(view) => onOpenServer(s.id, view)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 状态文字的颜色档位 */
function stateClass(status: ServerStatus, external: boolean): string {
  if (external) return 'external'
  if (status === 'running') return 'running'
  if (status === 'crashed') return 'crashed'
  if (status === 'starting' || status === 'stopping') return 'busy'
  return ''
}

function ServerLine({
  server,
  mem,
  active,
  sharedPort,
  onOpen
}: {
  server: ServerView
  mem: number
  active: boolean
  sharedPort: boolean
  onOpen: (view?: ViewKey) => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)
  const rt = server.runtime
  const running = rt.status !== 'stopped' && rt.status !== 'crashed'
  const uptime = rt.startedAt ? Math.floor((Date.now() - rt.startedAt) / 1000) : 0

  const toggle = async (): Promise<void> => {
    const res = running
      ? await window.api.server.stop(server.id)
      : await window.api.server.start(server.id)
    if (!res.ok) toast(res.error ?? '操作失败', 'error')
    else void refresh()
  }

  // 副标题只放「现在是什么状态」这件事，细节跟着状态变：
  // 跑着的服务器关心端口、人数、PID，没跑的关心它是什么核心、上次什么时候开的
  const sub = rt.externalRunning
    ? [
        rt.port != null ? `:${rt.port}` : null,
        `${rt.onlineCount}/${rt.maxPlayers} 人在线`,
        '进程不是 CraftDesk 启的'
      ]
    : running
      ? [
          rt.port != null ? `:${rt.port}` : null,
          rt.onlineCount > 0 ? `${rt.onlineCount}/${rt.maxPlayers} 人在线` : '无人在线',
          rt.pid != null ? `PID ${rt.pid}` : null,
          mem > 0 ? formatBytes(mem) : null,
          `已运行 ${formatDuration(uptime)}`
        ]
      : [
          server.mcVersion,
          kindLabel(server.kind),
          server.lastStartedAt ? `上次启动 ${relativeTime(server.lastStartedAt)}` : '从未启动过'
        ]

  return (
    <div
      className={`srv-row ${active ? 'active' : ''}`}
      onClick={() => onOpen('console')}
      title={server.dir}
    >
      <ServerAvatar server={server} size={44} className="srv-avatar" />

      <div className="srv-main">
        <div className="srv-name">
          {server.name}
          {isProxyKind(server.kind) && <span className="tag cyan">入口</span>}
          {sharedPort && (
            <span className="tag red" title="有另一个服务器配了同一个端口，两者不能同时启动">
              同端口
            </span>
          )}
        </div>
        <div className="srv-sub">
          <span className={`dot ${rt.status}`} />
          {sub.filter(Boolean).join(' · ')}
        </div>
      </div>

      <span className={`srv-state ${stateClass(rt.status, rt.externalRunning)}`}>
        {rt.externalRunning ? '外部启动' : statusLabel(rt.status)}
      </span>

      <div className="srv-actions">
        <button
          className={running ? 'stop' : 'play'}
          disabled={rt.status === 'starting' || rt.status === 'stopping'}
          title={
            rt.externalRunning
              ? '端口上已经有服务端在跑（不是 CraftDesk 启的），先关掉它再从这里启动'
              : running
                ? '停止服务器'
                : '启动服务器'
          }
          onClick={(e) => {
            e.stopPropagation()
            void toggle()
          }}
        >
          <Icon name={running ? 'stop' : 'play'} size={running ? 13 : 14} />
        </button>
        <button
          title="启动配置：Java、内存、核心"
          onClick={(e) => {
            e.stopPropagation()
            onOpen('properties')
          }}
        >
          <Icon name="settings" size={16} />
        </button>
      </div>
    </div>
  )
}
