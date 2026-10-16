import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { Confirm, Modal } from '../components/ui'
import { ModGraph } from '../components/ModGraph'
import { useStore } from '../store'
import { formatBytes } from '../utils'
import type { PluginInfo, PluginKind, RelationEdge, ServerView } from '../../../shared/types'

/**
 * 四类扩展的展示元数据。
 * MCDR 插件是跑在包装层里的 Python 程序，代理插件由 Velocity / BungeeCord 加载，
 * 服务端插件和模组才是 Minecraft 本体加载的 jar —— 它们的加载时机、
 * 生效方式、生效范围都不一样，混在一起展示会误导用户。
 */
const KIND_META: Record<
  PluginKind,
  { label: string; short: string; icon: IconName; color: string; tip: string }
> = {
  mcdr: {
    label: 'MCDR 插件',
    short: 'MCDR',
    icon: 'zap',
    color: '#a855f7',
    tip: 'Python 插件，由 MCDReforged 加载，改完在控制台执行 !!MCDR reload plugin 生效'
  },
  proxy: {
    label: '代理插件',
    short: '代理',
    icon: 'globe',
    color: '#06b6d4',
    tip: 'Velocity / BungeeCord 插件，由代理端加载，和下游服务端的插件互相独立'
  },
  plugin: {
    label: '服务端插件',
    short: '插件',
    icon: 'puzzle',
    color: '#f59e0b',
    tip: 'Bukkit 系插件，由服务端本体加载，需要重启服务器生效'
  },
  mod: {
    label: '模组',
    short: '模组',
    icon: 'package',
    color: '#3b82f6',
    tip: 'Fabric / Forge 模组，由服务端本体加载，需要重启服务器生效'
  }
}

type Filter = 'all' | PluginKind
type StatusFilter = 'all' | 'on' | 'off'

/** 依赖状态的措辞。状态只有四种，颜色由 CSS 按 class 决定 */
const STATE_TEXT: Record<RelationEdge['state'], string> = {
  ok: '已安装',
  disabled: '已装但被禁用',
  missing: '没有安装',
  platform: '平台自带'
}

export function PluginsPanel({ server }: { server: ServerView }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [items, setItems] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PluginInfo | null>(null)
  /** 正在看依赖详情的那个扩展 */
  const [detail, setDetail] = useState<PluginInfo | null>(null)
  /** 从依赖跳过去时高亮一下，让人知道点开的是哪一个 */
  const [flash, setFlash] = useState<string | null>(null)
  /** 只看有问题的（缺前置 / 前置被禁用 / 文件损坏） */
  const [onlyProblems, setOnlyProblems] = useState(false)
  /** 按生效侧过滤：只看纯客户端的，用来找多余模组 */
  const [sideFilter, setSideFilter] = useState<'all' | 'client' | 'server'>('all')
  /** 关系详情里「被依赖」列表是否全部展开 */
  const [showAllUsedBy, setShowAllUsedBy] = useState(false)
  /** 星图：null 表示关着，字符串（可以是空串）表示开着并聚焦某个模组 */
  const [graphFocus, setGraphFocus] = useState<string | null | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    const res = await window.api.plugins.list(server.id)
    setLoading(false)
    if (res.ok) setItems(res.data!)
    else toast(res.error ?? '读取失败', 'error')
  }, [server.id, toast])

  useEffect(() => {
    setLoading(true)
    setFilter('all')
    void load()
  }, [load])

  const counts = useMemo(() => {
    const c: Record<PluginKind, number> = { mcdr: 0, proxy: 0, plugin: 0, mod: 0 }
    for (const i of items) c[i.kind]++
    return c
  }, [items])

  /**
   * MCDR 按插件 id 去重，同一个插件同时存在解包目录和 .mcdr 包时
   * 会报 id 冲突并拒绝加载其中一个。磁盘上确实是两份文件，如实列出，
   * 但要标出来，否则用户看着两个一样的条目不知道哪里出了问题。
   */
  const duplicatedIds = useMemo(() => {
    const seen = new Map<string, number>()
    for (const i of items) {
      if (i.kind !== 'mcdr') continue
      const key = (i.id || i.name).toLowerCase()
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k))
  }, [items])

  const statusCounts = useMemo(() => {
    const on = items.filter((i) => i.enabled).length
    return { on, off: items.length - on }
  }, [items])

  /**
   * 依赖关系上的问题。分三类，都是「本来能跑起来」的原因：
   * 缺前置、前置被禁用、文件坏了。
   */
  const problems = useMemo(() => {
    const hasIssue = (i: PluginInfo): boolean =>
      i.broken ||
      i.requires.some((e) => e.hard && (e.state === 'missing' || e.state === 'disabled'))
    const list = items.filter(hasIssue)

    const missingIds = new Set<string>()
    const disabledIds = new Set<string>()
    for (const i of items) {
      for (const e of i.requires) {
        if (!e.hard) continue
        if (e.state === 'missing') missingIds.add(e.id)
        if (e.state === 'disabled') disabledIds.add(e.id)
      }
    }
    return {
      items: list,
      missing: [...missingIds],
      disabled: [...disabledIds],
      broken: items.filter((i) => i.broken)
    }
  }, [items])

  /**
   * 生效侧统计。纯客户端模组放在服务端的 mods/ 里不会起任何作用 ——
   * 「这个目录里是不是有一堆用不上的东西」就看这个数。
   */
  const sideCounts = useMemo(() => {
    const c = { client: 0, server: 0, both: 0, unknown: 0 }
    for (const i of items) c[i.side]++
    return c
  }, [items])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((i) => {
      if (filter !== 'all' && i.kind !== filter) return false
      if (status === 'on' && !i.enabled) return false
      if (status === 'off' && i.enabled) return false
      if (sideFilter !== 'all' && i.side !== sideFilter) return false
      if (onlyProblems && !problems.items.includes(i)) return false
      if (!q) return true
      return (
        i.name.toLowerCase().includes(q) ||
        i.file.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q) ||
        i.author.toLowerCase().includes(q)
      )
    })
  }, [items, filter, status, query, onlyProblems, problems, sideFilter])

  /** 打开依赖详情。列表默认折叠，「被依赖」可能有七十多个 */
  const openDetail = (p: PluginInfo): void => {
    setShowAllUsedBy(false)
    setDetail(p)
  }

  /** 跳到某个扩展：先把筛选放开，免得目标被筛掉，再滚过去闪一下 */
  const jumpTo = (path: string): void => {
    setDetail(null)
    setQuery('')
    setOnlyProblems(false)
    setStatus('all')
    setFlash(path)
    setTimeout(() => {
      const el = document.querySelector(`[data-dep-path="${CSS.escape(path)}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
    setTimeout(() => setFlash((cur) => (cur === path ? null : cur)), 2000)
  }

  const running = server.runtime.status !== 'stopped' && server.runtime.status !== 'crashed'

  const toggle = async (p: PluginInfo): Promise<void> => {
    if (running) {
      toast(
        p.kind === 'mcdr'
          ? '建议先停止服务器，或在控制台执行 !!MCDR reload plugin'
          : '请先停止服务器再启用/禁用，否则改动不会生效',
        'info'
      )
    }
    setBusy(p.path)
    const res = await window.api.plugins.toggle(server.id, p.path)
    setBusy(null)
    if (res.ok) void load()
    else toast(res.error ?? '操作失败', 'error')
  }

  const remove = async (p: PluginInfo): Promise<void> => {
    setRemoving(null)
    setBusy(p.path)
    const res = await window.api.plugins.remove(server.id, p.path)
    setBusy(null)
    if (!res.ok) {
      toast(res.error ?? '删除失败', 'error')
      return
    }
    // 回收站用不了的时候删除是永久的，措辞必须跟着变，不能一律说「可恢复」
    toast(
      res.data!.how === 'trash'
        ? `${p.file} 已移到回收站`
        : `${p.file} 已删除（回收站不可用，是永久删除）`,
      res.data!.how === 'trash' ? 'success' : 'info'
    )
    void load()
  }

  const openDir = (kind: PluginKind): void => {
    const first = items.find((i) => i.kind === kind)
    if (!first) return
    // path 是相对服务器根目录的，取它所在的目录
    const dir = first.group
    void window.api.fs.open(server.dir, dir)
  }

  const present = (['mcdr', 'proxy', 'plugin', 'mod'] as PluginKind[]).filter((k) => counts[k] > 0)

  return (
    <>
      {/*
        依赖问题单独列一条：缺前置是「服务器起不来」最常见的原因，
        藏在几百个模组里没人找得到，所以放在最上面，点一下只看有问题的。
      */}
      {!loading && (problems.missing.length > 0 || problems.broken.length > 0) && (
        <div className="issue-bar error" style={{ marginBottom: 8 }}>
          <Icon name="alert" size={15} />
          <span className="issue-text">
            {problems.missing.length > 0 && (
              <>
                <b>{problems.missing.length} 项前置没有安装</b>
                <span className="hint">（{problems.missing.slice(0, 3).join('、')}
                  {problems.missing.length > 3 ? ' 等' : ''}）</span>
              </>
            )}
            {problems.missing.length > 0 && problems.broken.length > 0 && ' · '}
            {problems.broken.length > 0 && (
              <>
                <b>{problems.broken.length} 个文件损坏</b>
                <span className="hint">（读不出元数据，建议重新下载）</span>
              </>
            )}
          </span>
          <button className="btn sm" onClick={() => setOnlyProblems((v) => !v)}>
            {onlyProblems ? '看全部' : '只看有问题的'}
          </button>
        </div>
      )}

      {!loading && problems.missing.length === 0 && problems.broken.length === 0 && problems.disabled.length > 0 && (
        <div className="issue-bar" style={{ marginBottom: 8 }}>
          <Icon name="alert" size={15} />
          <span className="issue-text">
            <b>{problems.disabled.length} 项前置被禁用</b>
            <span className="hint">（{problems.disabled.slice(0, 3).join('、')}）</span>
          </span>
          <button className="btn sm" onClick={() => setOnlyProblems((v) => !v)}>
            {onlyProblems ? '看全部' : '只看有问题的'}
          </button>
        </div>
      )}

      {/*
        纯客户端模组在服务端不起作用。不说清楚的话，用户看到「59 个」会直接删 ——
        而那些要把 mods 同步给客户端的服，它们是有意留着的。
      */}
      {!loading && sideCounts.client > 0 && (
        <div className="issue-bar" style={{ marginBottom: 8 }}>
          <Icon name="alert" size={15} />
          <span className="issue-text">
            <b>{sideCounts.client} 个模组只在客户端生效</b>
            <span className="hint">
              ：服务端会加载它们，但不产生任何作用。如果是上面那种要把 mods
              同步给客户端的目录，留着是正常的；否则可以考虑清理。
            </span>
          </span>
          <button
            className="btn sm"
            onClick={() => setSideFilter((v) => (v === 'client' ? 'all' : 'client'))}
          >
            {sideFilter === 'client' ? '看全部' : '只看这些'}
          </button>
        </div>
      )}

      <div className="panel-search">
        <Icon name="search" size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称、作者或 id"
          spellCheck={false}
        />
      </div>

      {present.length > 0 && (
        <div className="chips" style={{ padding: '0 12px 8px' }}>
          <button
            className={`chip-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            全部 {items.length}
          </button>
          {present.map((k) => (
            <button
              key={k}
              className={`chip-btn ${filter === k ? 'active' : ''}`}
              title={KIND_META[k].tip}
              onClick={() => setFilter(k)}
            >
              <span className="chip-dot" style={{ background: KIND_META[k].color }} />
              {KIND_META[k].label} {counts[k]}
            </button>
          ))}
        </div>
      )}

      {items.length > 0 && statusCounts.off > 0 && (
        <div className="chips" style={{ padding: '0 12px 8px' }}>
          {(
            [
              ['all', `全部状态`],
              ['on', `已启用 ${statusCounts.on}`],
              ['off', `已禁用 ${statusCounts.off}`]
            ] as [StatusFilter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              className={`chip-btn ${status === key ? 'active' : ''}`}
              onClick={() => setStatus(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* 生效侧筛选：找「多余的模组」就点这里 */}
      {items.length > 0 && (sideCounts.client > 0 || sideCounts.server > 0) && (
        <div className="chips" style={{ padding: '0 12px 8px' }}>
          {(
            [
              ['all', `全部生效范围`],
              ['client', `仅客户端 ${sideCounts.client}`],
              ['server', `仅服务端 ${sideCounts.server}`]
            ] as ['all' | 'client' | 'server', string][]
          )
            .filter(([key]) => key === 'all' || sideCounts[key] > 0)
            .map(([key, label]) => (
              <button
                key={key}
                className={`chip-btn ${sideFilter === key ? 'active' : ''}`}
                title={
                  key === 'client'
                    ? '这些模组在服务端不起作用'
                    : key === 'server'
                      ? '这些只在服务端 / 代理端生效，客户端不需要'
                      : '按「在哪一侧生效」筛选'
                }
                onClick={() => setSideFilter(key)}
              >
                {label}
              </button>
            ))}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '0 12px 8px',
          justifyContent: 'flex-end'
        }}
      >
        {present.map((k) => (
          <button
            key={k}
            className="icon-btn"
            style={{ width: 24, height: 24, color: KIND_META[k].color }}
            title={`打开${KIND_META[k].label}目录`}
            onClick={() => openDir(k)}
          >
            <Icon name="folder-open" size={13} />
          </button>
        ))}
        <button
          className="icon-btn"
          style={{ width: 24, height: 24, color: '#818cf8' }}
          title="关系星图：以某个模组为中心看它牵涉到的一切"
          onClick={() => setGraphFocus(null)}
        >
          <Icon name="network" size={13} />
        </button>
        <button
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          title="刷新"
          onClick={() => void load()}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>

      <div className="panel-scroll">
        {loading && <div className="panel-empty">正在读取扩展元数据…</div>}

        {!loading && items.length === 0 && (
          <div className="panel-empty">
            没有找到任何插件或模组。
            <br />
            <br />
            把对应的文件放进目录，重启服务器即可生效：
            <br />
            <span className="hint">
              MCDR 插件 → plugins/*.mcdr
              <br />
              代理插件 → plugins/*.jar
              <br />
              服务端插件 → 服务端目录 plugins/*.jar
              <br />
              模组 → 服务端目录 mods/*.jar
            </span>
          </div>
        )}

        {!loading && items.length > 0 && visible.length === 0 && (
          <div className="panel-empty">没有匹配的结果</div>
        )}

        {visible.map((p) => {
          const meta = KIND_META[p.kind]
          const dup = p.kind === 'mcdr' && duplicatedIds.has((p.id || p.name).toLowerCase())
          const missing = p.requires.filter((e) => e.hard && e.state === 'missing')
          const disabledDeps = p.requires.filter((e) => e.hard && e.state === 'disabled')
          // 平台自带的不占位置：每个 Fabric 模组都依赖 minecraft，列出来只是噪音
          const shown = p.requires.filter((e) => e.state !== 'platform')
          return (
            <div
              className={`row ${p.enabled ? '' : 'disabled'} ${flash === p.path ? 'flash' : ''}`}
              key={p.path}
              data-dep-path={p.path}
            >
              <span
                className="server-icon"
                style={{
                  background: p.enabled ? meta.color : '#3f3f46',
                  width: 30,
                  height: 30
                }}
                title={meta.label}
              >
                <Icon name={meta.icon} size={15} strokeWidth={2} />
              </span>
              <div className="row-main">
                {/* 类型由图标颜色 + 筛选标签表达，这里不再重复贴一个标签占位置 */}
                <div className="row-title" title={p.description || p.name}>
                  {p.name}
                  {p.version && <span className="tag">{p.version}</span>}
                  {!p.enabled && <span className="tag red">已禁用</span>}
                  {p.broken && (
                    <span className="tag red" title="这个文件的 zip 结构不完整（下载被截断），Java 也读不了，需要重新下载">
                      文件损坏
                    </span>
                  )}
                  {p.side === 'client' && (
                    <span
                      className="tag cyan"
                      title="模组自己声明只在客户端生效（fabric.mod.json 的 environment: client）——服务端加载了也不起作用"
                    >
                      仅客户端
                    </span>
                  )}
                  {p.side === 'server' && (
                    <span className="tag" title="只在服务端 / 代理端生效，客户端不需要它">
                      仅服务端
                    </span>
                  )}
                  {dup && (
                    <span
                      className="tag orange"
                      title={`存在同 id (${p.id || p.name}) 的另一个插件，MCDR 会拒绝加载其中一个`}
                    >
                      重复
                    </span>
                  )}
                </div>
                <div className="row-sub" title={p.description || p.file}>
                  {p.author ? `${p.author} · ` : ''}
                  {formatBytes(p.size)}
                </div>

                {/* 前置关系：缺了的和被禁用的排在前面，其余按原顺序 */}
                {(shown.length > 0 || p.usedBy.length > 0) && (
                  <div className="dep-line">
                    {shown.length > 0 && <span className="dep-label">前置</span>}
                    {[...missing, ...disabledDeps, ...shown.filter((e) => e.state === 'ok')]
                      .slice(0, 4)
                      .map((e) => (
                        <span
                          key={e.id}
                          className={`dep-chip ${e.state} ${e.provider ? 'clickable' : ''}`}
                          title={
                            `依赖 ${e.id}` +
                            (e.range ? `（要求 ${e.range}）` : '') +
                            ` · ${STATE_TEXT[e.state]}` +
                            (e.providerName ? `：${e.providerName}` : '') +
                            (e.provider ? '（点击跳过去）' : '')
                          }
                          onClick={() => e.provider && jumpTo(e.provider)}
                        >
                          {e.state === 'missing' ? '✗ ' : e.state === 'disabled' ? '! ' : ''}
                          {e.id}
                        </span>
                      ))}
                    {shown.length > 4 && (
                      <button className="dep-chip clickable" onClick={() => openDetail(p)}>
                        +{shown.length - 4}
                      </button>
                    )}
                    {p.usedBy.length > 0 && (
                      <button
                        className="dep-used"
                        title={`被这些扩展依赖：${p.usedBy.map((u) => u.name).join('、')}`}
                        onClick={() => openDetail(p)}
                      >
                        被 {p.usedBy.length} 个依赖
                      </button>
                    )}
                    {p.requires.length > 0 && (
                      <button className="dep-used" onClick={() => openDetail(p)}>
                        关系
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="row-actions">
                {/* 「禁用」写成字而不是只给个图标——图标是勾还是叉全靠猜 */}
                <button
                  className="btn sm ghost"
                  title={
                    p.enabled
                      ? '禁用：改名成 .disabled，服务器不会加载它，但文件还在'
                      : '启用：把 .disabled 后缀去掉'
                  }
                  disabled={busy === p.path}
                  onClick={() => void toggle(p)}
                >
                  {p.enabled ? '禁用' : '启用'}
                </button>
                <button
                  className="btn sm ghost"
                  title="删除这个文件（移到回收站）"
                  disabled={busy === p.path}
                  onClick={() => setRemoving(p)}
                >
                  <Icon name="trash" size={14} />
                </button>
                <button
                  className="btn sm ghost"
                  title="在资源管理器中显示"
                  onClick={() => void window.api.fs.reveal(server.dir, p.path)}
                >
                  <Icon name="external" size={14} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {detail && (
        <Modal
          title={`依赖关系 · ${detail.name}`}
          onClose={() => setDetail(null)}
          size="wide"
          footer={
            <>
              <button
                className="btn"
                onClick={() => {
                  const path = detail.path
                  setDetail(null)
                  setGraphFocus(path)
                }}
              >
                <Icon name="network" size={14} />
                在星图里看
              </button>
              <div className="spacer" />
              <button className="btn primary" onClick={() => setDetail(null)}>
                关闭
              </button>
            </>
          }
        >
          <div className="hint" style={{ marginBottom: 12 }}>
            {detail.id ? (
              <>
                id <code>{detail.id}</code>
                {detail.provides.length > 0 && (
                  <>
                    {' '}
                    · 另外还提供 <code>{detail.provides.slice(0, 6).join(', ')}</code>
                    {detail.provides.length > 6 ? ` 等 ${detail.provides.length} 个` : ''}
                  </>
                )}
              </>
            ) : (
              <code>{detail.file}</code>
            )}
            {detail.group && <> · 位置 {detail.group}/</>}
          </div>

          {/*
            两块：它要谁（前置）、谁要它（被依赖）。
            前者决定它能不能加载，后者决定能不能随手删掉。
          */}
          <div className="rel-block">
            <h4>
              前置 · 需要 {detail.requires.filter((e) => e.hard).length} 项
              {detail.requires.some((e) => !e.hard) &&
                ` · 可选 ${detail.requires.filter((e) => !e.hard).length} 项`}
            </h4>
            {detail.requires.length === 0 && <div className="hint">没有声明任何前置</div>}
            {[...detail.requires]
              .sort((a, b) => {
                const rank: Record<RelationEdge['state'], number> = {
                  missing: 0,
                  disabled: 1,
                  ok: 2,
                  platform: 3
                }
                return rank[a.state] - rank[b.state]
              })
              .map((e) => (
                <div
                  key={e.id}
                  className={`rel-item ${e.provider ? 'clickable' : ''}`}
                  onClick={() => e.provider && jumpTo(e.provider)}
                  title={e.provider ? '点击跳到这个扩展' : ''}
                >
                  <span className="rel-id">{e.id}</span>
                  {!e.hard && <span className="tag">可选</span>}
                  {e.range && <span className="tag">{e.range}</span>}
                  <span className={`rel-state ${e.state}`}>
                    {STATE_TEXT[e.state]}
                    {e.providerName && e.state !== 'missing' ? `：${e.providerName}` : ''}
                  </span>
                </div>
              ))}
          </div>

          <div className="rel-block">
            <h4>被依赖 · {detail.usedBy.length} 个</h4>
            {detail.usedBy.length === 0 && <div className="hint">没有其它扩展依赖它</div>}
            {/*
              像 Fabric API 这种被 70 多个模组依赖的，一次全列出来会把
              上面的信息挤出屏幕，先给一部分，需要再展开。
            */}
            {(showAllUsedBy ? detail.usedBy : detail.usedBy.slice(0, 12)).map((u) => (
              <div
                className="rel-item clickable"
                key={u.path}
                onClick={() => jumpTo(u.path)}
                title="跳到这个扩展"
              >
                <span>{u.name}</span>
                {u.soft && <span className="tag">可选</span>}
                <span className="rel-state platform">→</span>
              </div>
            ))}
            {!showAllUsedBy && detail.usedBy.length > 12 && (
              <button className="btn sm" onClick={() => setShowAllUsedBy(true)}>
                还有 {detail.usedBy.length - 12} 个，全部展开
              </button>
            )}
          </div>

          {detail.breaks.length > 0 && (
            <div className="rel-block">
              <h4>声明不兼容</h4>
              {detail.breaks.map((b) => (
                <div className="rel-item" key={b}>
                  <span className="rel-id">{b}</span>
                  <span className="rel-state disabled">装了会出问题</span>
                </div>
              ))}
            </div>
          )}

          {detail.requires.some((e) => e.state === 'missing') && (
            <div className="issue-bar error" style={{ margin: '4px 0 0' }}>
              <Icon name="alert" size={15} />
              <span className="issue-text">
                缺少前置时，服务端会在加载阶段直接跳过这个扩展（日志里通常是
                「requires xxx which is missing」）。可以在「下载扩展」里搜同名模组装上。
              </span>
            </div>
          )}
        </Modal>
      )}

      {graphFocus !== undefined && (
        <ModGraph
          items={items}
          focusPath={graphFocus}
          serverName={server.name}
          onClose={() => setGraphFocus(undefined)}
          onPick={(path) => {
            setGraphFocus(undefined)
            jumpTo(path)
          }}
        />
      )}

      {removing && (
        <Confirm
          title={`删除${KIND_META[removing.kind].label}`}
          danger
          confirmText="移到回收站"
          message={
            <>
              确定要删除 <b>{removing.name}</b> 吗？
              <br />
              <span className="hint">
                {removing.group}/{removing.file} · {formatBytes(removing.size)}
              </span>
              <br />
              <br />
              {/*
                删掉别人依赖的前置，等于把那几个扩展一起弄坏——
                这种连锁反应必须在按下去之前说清楚。
              */}
              {removing.usedBy.length > 0 && (
                <>
                  <span style={{ color: 'var(--warn)' }}>
                    有 {removing.usedBy.length} 个扩展依赖它：
                    {removing.usedBy
                      .slice(0, 5)
                      .map((u) => u.name)
                      .join('、')}
                    {removing.usedBy.length > 5 ? ' 等' : ''}。删掉之后它们会加载失败。
                  </span>
                  <br />
                  <br />
                </>
              )}
              文件会移到系统回收站。禁用还是删掉，建议先想清楚：
              <b>只是想让它不生效的话，用「禁用」就够了</b>
              ，文件留在原地，配置和存档引用都还在。
              {running && (
                <>
                  <br />
                  <br />
                  <span style={{ color: 'var(--warn)' }}>
                    服务器正在运行，这个文件正被占用，删除可能失败——先停服更稳妥。
                  </span>
                </>
              )}
            </>
          }
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove(removing)}
        />
      )}
    </>
  )
}
