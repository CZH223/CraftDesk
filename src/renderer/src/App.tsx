import { useEffect, useRef, useState } from 'react'
import { Icon } from './components/Icon'
import { TitleBar } from './components/TitleBar'
import { IconRail } from './components/IconRail'
import { ServerList } from './components/ServerList'
import { Toolbar } from './components/Toolbar'
import { Toasts } from './components/Toasts'
import { AddServerDialog } from './components/AddServerDialog'
import { Modal } from './components/ui'
import { ConsoleView } from './views/ConsoleView'
import { DashboardView } from './views/DashboardView'
import { PropertiesView } from './views/PropertiesView'
import { RegistryView } from './views/RegistryView'
import { MapView } from './views/MapView'
import { TopologyView } from './views/TopologyView'
import { SettingsView } from './views/SettingsView'
import { RightPanel } from './panels/RightPanel'
import { useStore, type ViewKey } from './store'
import { DEFAULT_UI, clampWidth, fitWidths, uiStyle, type WidthKind } from './uiPrefs'
import type { LogLine } from '../../shared/types'

export function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const servers = useStore((s) => s.servers)
  const activeId = useStore((s) => s.activeId)
  const view = useStore((s) => s.view)
  const panelOpen = useStore((s) => s.panelOpen)
  const listCollapsed = useStore((s) => s.listCollapsed)

  const [addOpen, setAddOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const booted = useRef(false)

  /*
   * 界面尺寸与背景。
   *
   * 宽度拖拽时先写在本地状态里（跟手），松手才落盘 —— 拖动过程中每帧都写
   * 配置会触发一次 IPC + 一次去抖落盘，手感发涩。
   */
  const settings = useStore((s) => s.settings)
  const [dragWidth, setDragWidth] = useState<Partial<Record<WidthKind, number>>>({})
  const [dragKind, setDragKind] = useState<WidthKind | null>(null)
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null)

  // 窗口变窄时两侧要跟着收，否则中间工作区会被挤成一条缝
  const [viewport, setViewport] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setViewport(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const effectiveSettings = settings
    ? {
        ...settings,
        sideWidth: dragWidth.side ?? settings.sideWidth,
        panelWidth: dragWidth.panel ?? settings.panelWidth
      }
    : null
  const ui = uiStyle(effectiveSettings, backgroundUrl, viewport)

  /** 当前实际显示的宽度（窗口不够宽时它会小于设置里的值） */
  const shownWidth = (kind: WidthKind): number => {
    const v = Number.parseInt(ui.vars[kind === 'side' ? '--side-w' : '--panel-w'], 10)
    if (Number.isFinite(v)) return v
    return kind === 'side' ? DEFAULT_UI.sideWidth : DEFAULT_UI.panelWidth
  }

  /** 背景图路径变了就把图片读进来（存路径、不存 base64，否则配置里会塞进几 MB） */
  useEffect(() => {
    const path = settings?.backgroundImage?.trim()
    if (!path) {
      setBackgroundUrl(null)
      useStore.setState({ backgroundError: '' })
      return
    }
    let cancelled = false
    void window.api.app.readImage(path).then((res) => {
      if (cancelled) return
      setBackgroundUrl(res.ok ? res.data!.dataUrl : null)
      /*
       * 读不出来不能只是「没背景」：设置里那行文件名还在，
       * 用户会以为是透明度调坏了。把原因记下来，设置页里说清楚。
       */
      useStore.setState({ backgroundError: res.ok ? '' : (res.error ?? '读取失败') })
    })
    return () => {
      cancelled = true
    }
  }, [settings?.backgroundImage])

  /**
   * 拖动分栏线。
   *
   * 右侧面板在窗口右边，往左拖才是变宽，所以两边的增量方向相反。
   * 目标宽度要过两道关：单侧区间（clampWidth）和窗口总空间（fitWidths）——
   * 少了第二道，用户能拖出一个把中间工作区挤没的布局。
   */
  const startResize = (kind: WidthKind, e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const from = shownWidth(kind)
    const otherKind: WidthKind = kind === 'side' ? 'panel' : 'side'
    const sign = kind === 'side' ? 1 : -1

    const targetWidth = (clientX: number): number => {
      const want = clampWidth(kind, from + (clientX - startX) * sign)
      const other = shownWidth(otherKind)
      const fitted = fitWidths(
        kind === 'side' ? want : other,
        kind === 'side' ? other : want,
        viewport
      )
      return kind === 'side' ? fitted.side : fitted.panel
    }

    document.body.classList.add('resizing')
    setDragKind(kind)
    const onMove = (ev: MouseEvent): void => {
      const next = targetWidth(ev.clientX)
      setDragWidth((w) => ({ ...w, [kind]: next }))
    }
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing')
      setDragKind(null)
      const next = targetWidth(ev.clientX)
      setDragWidth((w) => {
        const rest = { ...w }
        delete rest[kind]
        return rest
      })
      void window.api.settings
        .patch(kind === 'side' ? { sideWidth: next } : { panelWidth: next })
        .then((res) => {
          if (res.ok) useStore.setState({ settings: res.data! })
        })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 双击分栏线回到默认宽度 */
  const resetWidth = (kind: WidthKind): void => {
    void window.api.settings
      .patch(kind === 'side' ? { sideWidth: DEFAULT_UI.sideWidth } : { panelWidth: DEFAULT_UI.panelWidth })
      .then((res) => {
        if (res.ok) useStore.setState({ settings: res.data! })
      })
  }

  const active = servers.find((s) => s.id === activeId) ?? null

  // ---------------------------------------------------------- 初始化
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void useStore.getState().init()
  }, [])

  // ---------------------------------------------------------- 主进程事件
  useEffect(() => {
    // 日志合并到每帧一次，避免高刷日志把 React 拖垮
    const buffer: Record<string, LogLine[]> = {}
    let raf = 0
    const flush = (): void => {
      raf = 0
      const push = useStore.getState().pushLogs
      for (const id of Object.keys(buffer)) {
        const lines = buffer[id]
        if (lines?.length) push(id, lines)
        delete buffer[id]
      }
    }

    const offLog = window.api.on.log((id, line) => {
      ;(buffer[id] ||= []).push(line)
      if (!raf) raf = requestAnimationFrame(flush)
    })

    const offStatus = window.api.on.status((id, runtime) =>
      useStore.getState().applyRuntime(id, runtime)
    )

    const offStats = window.api.on.stats((stats) => useStore.setState({ stats }))

    const offChanged = window.api.on.serversChanged(() => void useStore.getState().refresh())

    const offDownload = window.api.on.download((p) => useStore.getState().setDownload(p))

    return () => {
      offLog()
      offStatus()
      offStats()
      offChanged()
      offDownload()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // ---------------------------------------------------------- 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key === 'n') {
        e.preventDefault()
        setAddOpen(true)
      } else if (e.key === '1') {
        e.preventDefault()
        useStore.getState().setView('dashboard')
      } else if (e.key === '2') {
        e.preventDefault()
        useStore.getState().setView('console')
      } else if (e.key === 'b' || e.key === '\\') {
        e.preventDefault()
        useStore.getState().toggleList()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) {
    return (
      <div className="app">
        <div className="center-state" style={{ height: '100vh' }}>
          <div className="spin" />
          <div>CraftDesk 正在启动…</div>
        </div>
      </div>
    )
  }

  return (
    <div className={`app ${ui.hasBackground ? 'has-bg' : ''}`} style={ui.vars as React.CSSProperties}>
      {/* 背景图层：在内容下面，不参与布局，也不吃鼠标事件 */}
      {ui.background && (
        <div
          className="app-bg"
          style={{ backgroundImage: `url("${ui.background.image}")`, opacity: ui.background.opacity }}
        />
      )}

      <TitleBar />

      <div className="body">
        <IconRail onHelp={() => setHelpOpen(true)} />

        {!listCollapsed && (
          <>
            <ServerList onAdd={() => setAddOpen(true)} />
            <div
              className={`resizer resizer-side ${dragKind === 'side' ? 'active' : ''}`}
              title="拖动调整左侧宽度，双击恢复默认（也可以在设置 → 个性化 里精确设置）"
              onMouseDown={(e) => startResize('side', e)}
              onDoubleClick={() => resetWidth('side')}
            />
          </>
        )}

        <div className="main">
          <Toolbar onAdd={() => setAddOpen(true)} />

          {view === 'dashboard' ? (
            <DashboardView
              onAdd={() => setAddOpen(true)}
              onOpenServer={(id, v) => {
                useStore.getState().select(id)
                if (v) useStore.getState().setView(v as ViewKey)
              }}
            />
          ) : view === 'topology' ? (
            <TopologyView
              onOpenServer={(id, v) => {
                useStore.getState().select(id)
                useStore.getState().setView(v)
              }}
            />
          ) : view === 'settings' ? (
            <SettingsView />
          ) : !active ? (
            <EmptyState onAdd={() => setAddOpen(true)} />
          ) : view === 'properties' ? (
            <PropertiesView server={active} />
          ) : view === 'registry' ? (
            <RegistryView server={active} />
          ) : view === 'map' ? (
            <MapView server={active} />
          ) : (
            <ConsoleView server={active} />
          )}
        </div>

        {active &&
          panelOpen &&
          view !== 'dashboard' &&
          view !== 'topology' &&
          view !== 'map' && (
          <>
            <div
              className={`resizer resizer-panel ${dragKind === 'panel' ? 'active' : ''}`}
              title="拖动调整右侧面板宽度，双击恢复默认（也可以在设置 → 个性化 里精确设置）"
              onMouseDown={(e) => startResize('panel', e)}
              onDoubleClick={() => resetWidth('panel')}
            />
            <RightPanel server={active} />
          </>
        )}
      </div>

      <Toasts />

      {addOpen && <AddServerDialog onClose={() => setAddOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-logo">
        <Icon name="pickaxe" size={34} style={{ color: 'var(--accent)' }} strokeWidth={1.5} />
      </div>
      <h1>今天想做点什么？</h1>
      <p>
        从左边选一个服务器开始管理，或者添加一个新的。
        CraftDesk 会帮你启动进程、盯着控制台输出、管理玩家和存档。
      </p>
      <div className="empty-actions">
        <button className="btn primary" onClick={onAdd}>
          <Icon name="plus" size={15} />
          添加服务器
        </button>
      </div>
      <div className="quick-grid">
        <div className="quick-card">
          <div className="qc-title">导入已有服务端</div>
          <div className="qc-desc">选中之前的服务器文件夹，自动识别核心与配置</div>
        </div>
        <div className="quick-card">
          <div className="qc-title">下载新建</div>
          <div className="qc-desc">
            Paper / 原版 / Purpur / Fabric / Forge / NeoForge，选版本即可开服
          </div>
        </div>
        <div className="quick-card">
          <div className="qc-title">实时控制台</div>
          <div className="qc-desc">看日志、发指令、盯 TPS 和在线人数</div>
        </div>
      </div>
    </div>
  )
}

function HelpDialog({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Modal title="使用说明" onClose={onClose}>
      <div style={{ lineHeight: 2, fontSize: 13.5, color: 'var(--text-dim)' }}>
        <h3 style={{ fontSize: 14, color: 'var(--text)', marginBottom: 8 }}>快速上手</h3>
        <ol style={{ paddingLeft: 20 }}>
          <li>点左上角的「添加服务器」，导入已有服务端目录，或者下载一个新的。</li>
          <li>确认 Java 路径和内存。没有 Java 的话去「设置」里扫描或手动指定 java.exe。</li>
          <li>点右上角「启动」。首次启动如果提示 EULA，在提示条上点一下同意即可。</li>
          <li>启动完成后，底部输入框可以直接发送服务器指令，比如 list、tps、whitelist add。</li>
        </ol>

        <h3 style={{ fontSize: 14, color: 'var(--text)', margin: '16px 0 8px' }}>快捷键</h3>
        <div style={{ display: 'grid', gap: 6 }}>
          <div>
            <span className="kbd">Ctrl</span> + <span className="kbd">N</span> 添加服务器
          </div>
          <div>
            <span className="kbd">Ctrl</span> + <span className="kbd">1</span> 总览
          </div>
          <div>
            <span className="kbd">Ctrl</span> + <span className="kbd">2</span> 控制台
          </div>
          <div>
            <span className="kbd">Ctrl</span> + <span className="kbd">B</span> 折叠服务器列表
          </div>
          <div>
            编辑文件时 <span className="kbd">Ctrl</span> + <span className="kbd">S</span> 保存
          </div>
        </div>

        <h3 style={{ fontSize: 14, color: 'var(--text)', margin: '16px 0 8px' }}>常见问题</h3>
        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <b style={{ color: 'var(--text)' }}>启动后立刻退出？</b>
            <br />
            多半是老版本 Java 跑新版本服务端，或者反过来。控制台会打出
            UnsupportedClassVersionError，按提示换 Java 版本即可。
          </div>
          <div>
            <b style={{ color: 'var(--text)' }}>提示端口被占用？</b>
            <br />
            到「服务器属性」里把 server-port 换成别的值，或者把占用端口的程序关掉。
          </div>
          <div>
            <b style={{ color: 'var(--text)' }}>控制台中文乱码？</b>
            <br />
            CraftDesk 会自动尝试 UTF-8 和 GBK 两种解码。如果仍然乱码，可以在 JVM 参数里加
            -Dfile.encoding=UTF-8。
          </div>
        </div>

        <h3 style={{ fontSize: 14, color: 'var(--text)', margin: '16px 0 8px' }}>关于</h3>
        <div>
          界面参考了现代桌面应用的深色三栏布局，左侧服务器列表、中间工作区、右侧文件与玩家面板，
          所有面板都可以按需收起。
        </div>
      </div>
    </Modal>
  )
}
