import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui'
import {
  DEFAULT_LIMIT,
  allMissingDependencies,
  buildStarGraph,
  graphBounds,
  mergeMcmodRelations,
  missingGraphNodes,
  type GraphNode,
  type MissingDependency
} from '../graph'
import { useStore } from '../store'
import type {
  McmodRelations,
  ModCompat,
  ModCompatItem,
  PluginInfo,
  ServerView
} from '../../../shared/types'

/**
 * 模组关系星图。
 *
 * 中心是当前关注的模组，左半边是它的前置（红），右半边是依赖它的（蓝），
 * 外面一圈是这些模组各自的其它关系（灰）。双击任意节点换中心（也就是看
 * 它的关系）；单击是选中；缺的前置用虚线画出来。图内下载暂时关闭，
 * 需要安装时右键「前往下载界面」。
 *
 * 自己画 SVG 而不引第三方图库：整个项目零运行时依赖，而且这里的布局是
 * 确定性的（见 graph.ts），不需要每帧迭代，几百个节点直接渲染就很流畅。
 */

const ROLE_COLOR: Record<GraphNode['role'], string> = {
  center: '#f43f5e',
  dep: '#ef4444',
  dependent: '#3b82f6',
  related: '#71717a',
  linked: '#a855f7',
  other: '#a1a1aa'
}

const ROLE_LABEL: Record<GraphNode['role'], string> = {
  center: '当前模组',
  dep: '前置模组',
  dependent: '拓展模组',
  related: '联动模组',
  linked: '百科联动',
  other: '无依赖关系'
}

/** 等这么久没有第二次点击，才算「单击选中」；双击时会把这次选中取消 */
const SELECT_DELAY = 220

/**
 * 星图下载功能暂时关闭。
 *
 * 关系图、选择和 MC百科联动仍然显示，只是不再从这里直接下载模组；
 * 需要安装时走「前往下载界面」。保留这段代码，之后把开关改回 true 即可恢复。
 */
const GRAPH_DOWNLOAD_ENABLED = false

type DownloadState = {
  state: 'resolving' | 'downloading' | 'done' | 'error'
  message?: string
}

export function ModGraph({
  items,
  focusPath,
  server,
  onClose,
  onRefresh,
  onOpenDownload
}: {
  items: PluginInfo[]
  /** 打开时聚焦的模组（面板里点「星图」时传当前那个） */
  focusPath?: string | null
  server: ServerView
  onClose: () => void
  /** 下载或补齐之后重新扫描扩展列表 */
  onRefresh: () => Promise<void>
  /** 右键「前往下载界面」：带着模组 id 跳到下载页 */
  onOpenDownload: (node: GraphNode) => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [focus, setFocus] = useState<string | null>(focusPath ?? null)
  const [limit, setLimit] = useState(String(DEFAULT_LIMIT))
  const [hover, setHover] = useState<string | null>(null)
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  /** 默认把服务器里和中心没有依赖关系的模组也画到外圈，避免“明明 7 个只画 2 个” */
  const [showUnrelated, setShowUnrelated] = useState(true)
  /** MC百科的关系数据；key 记录它属于哪个中心，切中心时不会串数据 */
  const [mcmod, setMcmod] = useState<{ key: string; data: McmodRelations } | null>(null)
  const [mcmodLoading, setMcmodLoading] = useState(false)
  const [mcmodError, setMcmodError] = useState('')
  const [showMcmod, setShowMcmod] = useState(true)
  /** 百科条目在当前服务器版本 / 加载器下有没有可用版本 */
  const [compat, setCompat] = useState<Record<string, ModCompat>>({})
  const [compatLoading, setCompatLoading] = useState(false)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  /** 最近一次批量下载的结果，失败原因留在界面上，不用去猜 */
  const [lastResult, setLastResult] = useState<{
    ok: number
    failed: number
    reasons: string[]
  } | null>(null)
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  /**
   * 延迟执行的单击。双击时同一节点会连点两次，第二次要把这个取消；
   * 但如果是两个不同节点，那一定是在多选，得先把前一个点击落下去。
   */
  const pendingClick = useRef<{ key: string; timer: number } | null>(null)

  const limitNum = Math.max(5, Math.min(2000, Number(limit) || DEFAULT_LIMIT))

  const graph = useMemo(() => {
    const list = onlyEnabled ? items.filter((i) => i.enabled) : items
    const local = buildStarGraph(list, focus, limitNum, showUnrelated)
    if (!showMcmod || !mcmod || mcmod.key !== local.center?.key) return local
    return mergeMcmodRelations(local, list, mcmod.data, limitNum, compat)
  }, [items, focus, limitNum, onlyEnabled, showUnrelated, showMcmod, mcmod, compat])

  // 自动查当前中心的 MC百科关系。切中心时旧请求直接丢弃，
  // 站点打不开也只影响这一块，本地星图照常显示。
  useEffect(() => {
    const center = graph.center
    if (!showMcmod || !center) {
      setMcmod(null)
      setMcmodError('')
      setMcmodLoading(false)
      return
    }
    let cancelled = false
    const key = center.key
    setMcmod(null)
    setMcmodLoading(true)
    setMcmodError('')
    void window.api.mcmod
      .relations({ id: center.modId, name: center.name })
      .then((res) => {
        if (cancelled) return
        setMcmodLoading(false)
        if (!res.ok) {
          setMcmodError(res.error ?? '查询失败')
          return
        }
        if (!res.data) {
          setMcmodError('暂未收录')
          return
        }
        setMcmod({ key, data: res.data })
      })
      .catch((err) => {
        if (cancelled) return
        setMcmodLoading(false)
        setMcmodError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMcmod, graph.center?.key, graph.center?.modId, graph.center?.name])

  // 百科条目也要过一遍版本筛选：只支持旧版本的联动/拓展不画出来。
  // 本地已安装的节点不受影响（它就在服务器里，当然兼容）。
  const compatSignature =
    showMcmod && mcmod?.data
      ? mcmod.data.nodes
          .filter((n) => n.category !== 'center')
          .map((n) => `${n.classId ?? ''}:${n.englishName}`)
          .join('|')
      : ''

  useEffect(() => {
    const data = mcmod?.data
    if (!showMcmod || !data) {
      setCompat({})
      setCompatLoading(false)
      return
    }
    const nodes = data.nodes.filter((n) => n.category !== 'center')
    if (!nodes.length) {
      setCompat({})
      setCompatLoading(false)
      return
    }
    const kind = graph.center?.kind === 'mod' ? 'mod' : 'plugin'
    const items: ModCompatItem[] = nodes.map((n) => {
      const query = n.englishName || n.name
      return {
        key: `mcmod:${n.classId ?? n.englishName}`,
        id: query,
        name: query,
        kind
      }
    })
    let cancelled = false
    setCompat({})
    setCompatLoading(true)
    void window.api.registry
      .compat(server.id, items)
      .then((res) => {
        if (cancelled) return
        setCompatLoading(false)
        if (res.ok) setCompat(res.data ?? {})
      })
      .catch(() => {
        if (cancelled) return
        setCompatLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMcmod, server.id, server.mcVersion, graph.center?.kind, compatSignature])

  const byKey = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph.nodes])
  const ignoredByCompat = Object.values(compat).filter((v) => v === 'bad').length
  const mcmodExternal = useMemo(() => graph.nodes.filter((n) => n.external), [graph.nodes])
  const mcmodRequired = mcmodExternal.filter(
    (n) => n.externalCategory === 'required' && n.missing
  )
  const mcmodLinked = mcmodExternal.filter((n) => n.externalCategory === 'linked')
  /** 图上的缺失项：供「全选未下载」用（有坐标，才能高亮） */
  const missingVisible = useMemo(() => missingGraphNodes(graph), [graph])
  /** 整个服务器的缺失项：图外的也要能补齐 */
  const missingAll = useMemo(
    () => allMissingDependencies(items, onlyEnabled),
    [items, onlyEnabled]
  )
  const selectedNodes = useMemo(
    () => graph.nodes.filter((n) => selected.has(n.key)),
    [graph.nodes, selected]
  )
  const missingSelected = selectedNodes.filter((n) => n.missing)

  // 换中心 / 改数量上限后，把已经不在图上的选择去掉
  useEffect(() => {
    const keys = new Set(graph.nodes.map((n) => n.key))
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => keys.has(k)))
      return next.size === prev.size ? prev : next
    })
  }, [graph.nodes])

  // 关掉弹窗时别让延迟的单击把状态写到已卸载的组件上
  useEffect(() => {
    return () => {
      if (pendingClick.current !== null) window.clearTimeout(pendingClick.current.timer)
    }
  }, [])

  const hovered = hover ? byKey.get(hover) ?? null : null
  const menuNode = menu ? byKey.get(menu.key) ?? null : null
  const linkedKeys = useMemo(() => {
    if (!hovered) return null
    const set = new Set<string>([hovered.key])
    for (const l of graph.links) {
      if (l.from === hovered.key) set.add(l.to)
      if (l.to === hovered.key) set.add(l.from)
    }
    return set
  }, [hovered, graph.links])

  const bounds = graphBounds(graph)
  const padding = 90
  const width = Math.max(320, bounds.maxX - bounds.minX + padding * 2)
  const height = Math.max(320, bounds.maxY - bounds.minY + padding * 2)

  /** 拖动画布 */
  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>): void => {
    setMenu(null)
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

  const toggleSelected = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 单击选中 / 取消；等一小会儿，确认不是双击再执行 */
  const onNodeClick = (n: GraphNode, e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()

    const pending = pendingClick.current
    if (pending) {
      window.clearTimeout(pending.timer)
      pendingClick.current = null
      // 点在同一个节点上：这是双击的前半段，交给 dblclick 处理
      if (pending.key === n.key) return
      // 点在另一个节点上：不是双击，把上一个节点的选中先落下去
      toggleSelected(pending.key)
    }

    pendingClick.current = {
      key: n.key,
      timer: window.setTimeout(() => {
        pendingClick.current = null
        toggleSelected(n.key)
      }, SELECT_DELAY)
    }
  }

  /** 双击看这个模组的关系：把它换成中心 */
  const onNodeDoubleClick = (n: GraphNode): void => {
    if (pendingClick.current !== null) {
      window.clearTimeout(pendingClick.current.timer)
      pendingClick.current = null
    }
    if (!n.focusable) {
      toast('这是还没下载的模组，本地没有它的关系数据；下载后就能以它为中心查看。', 'info')
      return
    }
    setFocus(n.key)
    setView({ x: 0, y: 0, k: 1 })
  }

  const setDl = (key: string, state: DownloadState): void => {
    setDownloads((prev) => ({ ...prev, [key]: state }))
  }

  /**
   * 批量下载。每个模组先按依赖 id 去 Modrinth 找项目，再挑当前服务端
   * 游戏版本 / 加载器下最新的版本。串行下载，免得十几个大 jar 同时抢带宽
   * 把进度写得乱七八糟。
   */
  const downloadNodes = async (targets: MissingDependency[]): Promise<void> => {
    if (!targets.length) {
      toast('选中的模组都已经安装过了', 'info')
      return
    }
    if (busy) return

    setBusy(true)
    setLastResult(null)
    let ok = 0
    let failed = 0
    const reasons: string[] = []
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    try {
      for (const n of targets) {
        setDl(n.key, { state: 'resolving', message: '正在查找最新适配版本…' })
        const query = n.modId || n.name
        const kind = n.kind === 'plugin' ? 'plugin' : 'mod'
        let res = await window.api.registry.latest(server.id, {
          id: query,
          name: query,
          kind
        })
        // 网络抖动很常见；查询失败时再试一次，别让用户看着「能搜到但下载失败」
        if (!res.ok) {
          await sleep(700)
          res = await window.api.registry.latest(server.id, { id: query, name: query, kind })
        }
        if (!res.ok) {
          failed++
          const msg = res.error ?? '查询失败'
          reasons.push(`${n.name}：${msg}`)
          setDl(n.key, { state: 'error', message: msg })
          continue
        }
        if (!res.data) {
          failed++
          const msg = 'Modrinth 上没找到这个模组'
          reasons.push(`${n.name}：${msg}`)
          setDl(n.key, { state: 'error', message: msg })
          continue
        }
        if (!res.data.version) {
          failed++
          let host = ''
          try {
            if (res.data.sourceUrl) host = new URL(res.data.sourceUrl).hostname
          } catch {
            /* ignore */
          }
          const msg = `没有适配 ${server.mcVersion || '当前版本'} 的发布${host ? `；可在 ${host} 手动下载` : ''}`
          reasons.push(`${n.name}：${msg}`)
          setDl(n.key, { state: 'error', message: msg })
          continue
        }

        const v = res.data.version
        const sourceLabel =
          res.data.source === 'curseforge'
            ? 'CurseForge'
            : res.data.source === 'github'
              ? 'GitHub'
              : res.data.source === 'modrinth'
                ? 'Modrinth'
                : ''
        setDl(n.key, {
          state: 'downloading',
          message: `${sourceLabel ? `${sourceLabel} · ` : ''}${res.data.title} ${v.name}`
        })
        const installReq = {
          serverId: server.id,
          target: n.kind === 'plugin' ? ('plugin' as const) : ('mod' as const),
          url: v.fileUrl,
          fileName: v.fileName,
          label: n.name,
          fileSize: v.fileSize
        }
        let installed = await window.api.registry.install(installReq)
        if (!installed.ok) {
          await sleep(700)
          installed = await window.api.registry.install(installReq)
        }
        if (installed.ok) {
          ok++
          setDl(n.key, { state: 'done' })
        } else {
          failed++
          const msg = installed.error ?? '安装失败'
          reasons.push(`${n.name}：${msg}`)
          setDl(n.key, { state: 'error', message: msg })
        }
      }
    } finally {
      await onRefresh()
      setBusy(false)
      setSelected(new Set())
    }

    setLastResult({ ok, failed, reasons })
    if (ok > 0) {
      const reason = failed > 0 && reasons.length ? `：${reasons.slice(0, 2).join('；')}` : ''
      toast(
        failed > 0 ? `已安装 ${ok} 个模组，${failed} 个失败${reason}` : `已安装 ${ok} 个模组`,
        failed > 0 ? 'error' : 'success'
      )
    } else if (failed > 0) {
      toast(`下载失败：${reasons.slice(0, 3).join('；') || `${failed} 个模组没能安装`}`, 'error')
    }
  }

  const reset = (): void => {
    setFocus(focusPath ?? null)
    setView({ x: 0, y: 0, k: 1 })
  }

  const centerName = graph.center?.name ?? '（没有可显示的模组）'
  const activeDownload = graph.nodes.find((n) => {
    const s = downloads[n.key]?.state
    return s === 'resolving' || s === 'downloading'
  })

  const localShown = graph.nodes.filter((n) => !n.external).length
  const externalShown = graph.nodes.length - localShown
  const countHint =
    `共 ${graph.total} 个服务器模组（图上 关系 ${localShown} 个` +
    (externalShown > 0 ? ` + 百科 ${externalShown} 个` : '') +
    (graph.hidden > 0
      ? `；${showUnrelated ? '达到上限省去' : '未显示'} ${graph.hidden} 个`
      : '') +
    '）'

  // 右键菜单贴着鼠标，别跑出窗口
  const menuStyle = menu
    ? {
        left: Math.max(8, Math.min(menu.x, window.innerWidth - 220)),
        top: Math.max(8, Math.min(menu.y, window.innerHeight - 190))
      }
    : undefined

  return (
    <Modal
      title={`模组关系星图 · ${centerName}`}
      onClose={onClose}
      size="full"
      footer={
        <>
          <span className="hint">
            单击选中 · 双击看关系 · 右键更多 · 拖拽平移 · 滚轮缩放
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
          {countHint}
          {missingAll.length > 0 && ` · 缺 ${missingAll.length} 个`}
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
        <label className="graph-field">
          <input
            type="checkbox"
            className="net-check"
            checked={showUnrelated}
            onChange={(e) => setShowUnrelated(e.target.checked)}
          />
          显示无关系模组
        </label>
        <label className="graph-field" title="从 MC百科读取前置、拓展和联动关系">
          <input
            type="checkbox"
            className="net-check"
            checked={showMcmod}
            onChange={(e) => setShowMcmod(e.target.checked)}
          />
          MC百科关系
        </label>
        {showMcmod && mcmodLoading && <span className="hint">正在查询 MC百科…</span>}
        {showMcmod && !mcmodLoading && mcmodError && (
          <span className="hint" title={mcmodError}>
            百科：{mcmodError}
          </span>
        )}
        {showMcmod && compatLoading && (
          <span className="hint">正在检查百科条目兼容性…</span>
        )}
        {showMcmod && !compatLoading && ignoredByCompat > 0 && (
          <span className="hint" title="这些百科条目没有适配当前服务器版本的发布，已从图上隐藏">
            已忽略 {ignoredByCompat} 个不兼容条目
          </span>
        )}
        {showMcmod && !mcmodLoading && !mcmodError && mcmodExternal.length > 0 && (
          <span className="hint">
            MC百科 +{mcmodExternal.length}
            {mcmodLinked.length > 0 && ` · 联动 ${mcmodLinked.length}`}
          </span>
        )}

        <div className="spacer" />

        <button
          className="btn sm"
          disabled={busy || !missingVisible.length}
          onClick={() => setSelected(new Set(missingVisible.map((n) => n.key)))}
        >
          全选未下载
        </button>
        {selected.size > 0 && (
          <button className="btn sm ghost" disabled={busy} onClick={() => setSelected(new Set())}>
            清空选择
          </button>
        )}
        {GRAPH_DOWNLOAD_ENABLED ? (
          <>
            <button
              className="btn sm"
              disabled={busy || !missingSelected.length}
              title={
                missingSelected.length
                  ? '下载选中的未安装模组'
                  : '选中的模组里没有未安装的；已安装的不会重复下载'
              }
              onClick={() => void downloadNodes(missingSelected)}
            >
              <Icon name="download" size={14} />
              下载选中{missingSelected.length > 0 ? ` (${missingSelected.length})` : ''}
            </button>
            <button
              className="btn sm primary"
              disabled={busy || !missingAll.length}
              title="下载图上所有缺失的模组（优先硬前置）"
              onClick={() => void downloadNodes(missingAll)}
            >
              <Icon name="download" size={14} />
              一键补齐{missingAll.length > 0 ? ` (${missingAll.length})` : ''}
            </button>
            {mcmodRequired.length > 0 && (
              <button
                className="btn sm"
                disabled={busy}
                title="下载 MC百科列出的前置模组（按当前服务端版本找 Modrinth 最新版）"
                onClick={() => void downloadNodes(mcmodRequired)}
              >
                <Icon name="download" size={14} />
                百科前置 ({mcmodRequired.length})
              </button>
            )}
            {mcmodLinked.length > 0 && (
              <button
                className="btn sm"
                disabled={busy}
                title="下载 MC百科列出的联动模组（可选，不装也能运行）"
                onClick={() => void downloadNodes(mcmodLinked)}
              >
                <Icon name="download" size={14} />
                百科联动 ({mcmodLinked.length})
              </button>
            )}
          </>
        ) : (
          <span className="hint" title="暂时关闭星图内下载，请右键选择「前往下载界面」手动安装">
            星图下载已暂时关闭
          </span>
        )}
      </div>

      {GRAPH_DOWNLOAD_ENABLED && activeDownload && (
        <div className="graph-active">
          <span className="spin" style={{ width: 12, height: 12 }} />
          正在处理 <b>{activeDownload.name}</b>
          {downloads[activeDownload.key]?.message && ` · ${downloads[activeDownload.key].message}`}
        </div>
      )}

      {GRAPH_DOWNLOAD_ENABLED && lastResult && lastResult.ok + lastResult.failed > 0 && (
        <div className={`graph-result ${lastResult.failed > 0 ? 'error' : 'ok'}`}>
          <span>
            下载结果：成功 {lastResult.ok} 个
            {lastResult.failed > 0 && `，失败 ${lastResult.failed} 个`}
          </span>
          {lastResult.reasons.length > 0 && (
            <span className="graph-result-detail" title={lastResult.reasons.join('\n')}>
              {lastResult.reasons.slice(0, 4).join('；')}
              {lastResult.reasons.length > 4 ? ' …' : ''}
            </span>
          )}
          <button
            className="graph-result-close"
            title="关闭"
            onClick={() => setLastResult(null)}
          >
            ×
          </button>
        </div>
      )}

      <div className="graph-legend graph-legend-row">
        {(['dep', 'dependent', 'related', 'linked', 'other'] as GraphNode['role'][]).map((role) => (
          <span key={role} className="graph-legend-item">
            <span className="graph-dot" style={{ background: ROLE_COLOR[role] }} />
            {ROLE_LABEL[role]}
          </span>
        ))}
        <span className="graph-legend-item">
          <span className="graph-dot graph-dot-missing" />
          未下载
        </span>
        <span className="graph-legend-item">
          <span className="graph-dot graph-dot-selected" />
          已选中
        </span>
      </div>

      {graph.nodes.length === 0 ? (
        <div className="panel-empty">
          {server.name} 里没有可显示的扩展。装几个模组再来看看。
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
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
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
                    stroke={
                      active ? '#e4e4e7' : l.external ? '#7c3aed' : l.hard ? '#52525b' : '#3f3f46'
                    }
                    strokeWidth={active ? 1.6 : 1}
                    strokeDasharray={l.external ? '4 3' : l.hard ? undefined : '3 3'}
                    opacity={dim ? 0.18 : 1}
                  />
                )
              })}

              {graph.nodes.map((n) => {
                const dim = linkedKeys && !linkedKeys.has(n.key)
                const isHover = hovered?.key === n.key
                const isSelected = selected.has(n.key)
                const dl = downloads[n.key]
                const running = dl?.state === 'resolving' || dl?.state === 'downloading'
                return (
                  <g
                    key={n.key}
                    transform={`translate(${n.x} ${n.y})`}
                    opacity={dim ? 0.25 : 1}
                    style={{ cursor: n.focusable ? 'pointer' : 'default' }}
                    onMouseEnter={() => setHover(n.key)}
                    onClick={(e) => onNodeClick(n, e)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      onNodeDoubleClick(n)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setMenu({ key: n.key, x: e.clientX, y: e.clientY })
                    }}
                  >
                    <circle
                      r={n.radius}
                      fill={n.missing ? '#18181b' : ROLE_COLOR[n.role]}
                      fillOpacity={
                        n.missing ? 0.92 : n.role === 'related' || n.role === 'other' ? 0.8 : 1
                      }
                      stroke={
                        isSelected
                          ? '#22d3ee'
                          : isHover
                            ? '#fafafa'
                            : n.missing
                              ? '#f87171'
                              : 'transparent'
                      }
                      strokeWidth={isSelected ? 2.5 : isHover ? 2 : 1.5}
                      strokeDasharray={n.missing ? '4 3' : undefined}
                    />
                    {/* 被禁用的打个空心环：和「已启用」区分开 */}
                    {!n.enabled && !n.missing && (
                      <circle r={n.radius + 3} fill="none" stroke="#f59e0b" strokeWidth={1.4} />
                    )}
                    {/* 选中的外面再套一圈青色，和角色颜色互不干扰 */}
                    {isSelected && (
                      <circle
                        r={n.radius + 6}
                        fill="none"
                        stroke="#22d3ee"
                        strokeWidth={1.6}
                        strokeOpacity={0.7}
                      />
                    )}
                    {running && (
                      <circle
                        r={n.radius + 6}
                        fill="none"
                        stroke="#fbbf24"
                        strokeWidth={2}
                        strokeDasharray="2 3"
                        className="graph-pulse"
                      />
                    )}
                    {dl?.state === 'error' && (
                      <circle r={n.radius + 6} fill="none" stroke="#ef4444" strokeWidth={2} />
                    )}
                    {dl?.state === 'done' && (
                      <circle r={n.radius + 6} fill="none" stroke="#22c55e" strokeWidth={2} />
                    )}
                    {n.role === 'center' ? (
                      // 中心名字放下面：右半边通常挤满「被依赖」的节点，
                      // 写右边会和它们的名字叠在一起
                      <text
                        x={0}
                        y={n.radius + 18}
                        textAnchor="middle"
                        fontSize={15}
                        fill={isHover || isSelected ? '#fafafa' : 'var(--text-dim)'}
                        style={{ pointerEvents: 'none' }}
                      >
                        {n.name}
                        {n.modId ? `（${n.modId}）` : ''}
                      </text>
                    ) : (
                      <text
                        x={n.x >= 0 ? n.radius + 6 : -(n.radius + 6)}
                        y={4}
                        textAnchor={n.x >= 0 ? 'start' : 'end'}
                        fontSize={12}
                        fill={
                          n.missing
                            ? '#fca5a5'
                            : isHover || isSelected
                              ? '#fafafa'
                              : 'var(--text-dim)'
                        }
                        style={{ pointerEvents: 'none' }}
                      >
                        {n.name}
                        {n.external && (
                          <tspan fill="#c084fc" fontSize={10}>
                            {' '}
                            百科
                          </tspan>
                        )}
                        {n.missing && (
                          <tspan fill="#f87171" fontSize={10}>
                            {' '}
                            未下载
                          </tspan>
                        )}
                      </text>
                    )}
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
                {hovered.onMcmod && ' · MC百科'}
                {hovered.missing
                  ? ` · 未下载${hovered.external ? '（百科条目）' : hovered.hardMissing ? '（硬前置）' : '（软前置）'}`
                  : ''}
                {!hovered.enabled && !hovered.missing && ' · 被禁用'}
                {hovered.degree > 0 && ` · 关系 ${hovered.degree}`}
                {downloads[hovered.key]?.message && ` · ${downloads[hovered.key].message}`}
              </span>
            </div>
          )}
        </div>
      )}

      {menuNode && (
        <>
          <div
            className="graph-menu-mask"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div className="graph-menu" style={menuStyle}>
            <div className="graph-menu-title">{menuNode.name}</div>
            <button
              className="graph-menu-item"
              onClick={() => {
                setMenu(null)
                onOpenDownload(menuNode)
              }}
            >
              <Icon name="external" size={14} />
              前往下载界面
            </button>
            {menuNode.focusable && (
              <button
                className="graph-menu-item"
                onClick={() => {
                  setMenu(null)
                  onNodeDoubleClick(menuNode)
                }}
              >
                <Icon name="network" size={14} />
                以它为中心看关系
              </button>
            )}
            {GRAPH_DOWNLOAD_ENABLED && menuNode.missing && (
              <button
                className="graph-menu-item"
                disabled={busy}
                onClick={() => {
                  setMenu(null)
                  void downloadNodes([menuNode])
                }}
              >
                <Icon name="download" size={14} />
                下载最新适配版本
              </button>
            )}
            {menuNode.classId && (
              <button
                className="graph-menu-item"
                onClick={() => {
                  setMenu(null)
                  void window.api.app.openExternal(
                    `https://www.mcmod.cn/class/${menuNode.classId}.html`
                  )
                }}
              >
                <Icon name="external" size={14} />
                打开 MC百科页面
              </button>
            )}
            <button
              className="graph-menu-item"
              onClick={() => {
                setMenu(null)
                void navigator.clipboard?.writeText(menuNode.modId || menuNode.name)
                toast('模组 ID 已复制', 'success')
              }}
            >
              <Icon name="file-text" size={14} />
              复制模组 ID
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
