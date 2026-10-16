import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { DeleteServerDialog } from './DeleteServerDialog'
import { ServerAvatar } from './ServerAvatar'
import { ServerIconDialog } from './ServerIconDialog'
import { useStore } from '../store'
import { kindColor, kindLabel, statusLabel } from '../utils'

/** 简易下拉菜单，点击外部或按 Esc 关闭 */
export function Menu({
  trigger,
  children,
  align = 'left'
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger(open, () => setOpen((v) => !v))}
      {open && (
        <div
          className="menu"
          style={align === 'right' ? { right: 0 } : { left: 0 }}
          onClick={() => setOpen(false)}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function Toolbar({ onAdd }: { onAdd: () => void }): JSX.Element {
  const active = useStore((s) => s.servers.find((x) => x.id === s.activeId) ?? null)
  const servers = useStore((s) => s.servers)
  const select = useStore((s) => s.select)
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)
  const toggleList = useStore((s) => s.toggleList)
  const togglePanel = useStore((s) => s.togglePanel)
  const panelOpen = useStore((s) => s.panelOpen)
  const setView = useStore((s) => s.setView)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [iconOpen, setIconOpen] = useState(false)

  const rt = active?.runtime
  const running = rt ? rt.status === 'running' || rt.status === 'starting' : false

  const doStart = async (): Promise<void> => {
    if (!active) return
    setBusy(true)
    const res = await window.api.server.start(active.id)
    setBusy(false)
    if (!res.ok) toast(res.error ?? '启动失败', 'error')
    else toast(`正在启动 ${active.name}`, 'success')
    void refresh()
  }

  const doStop = async (force = false): Promise<void> => {
    if (!active) return
    setBusy(true)
    const res = await window.api.server.stop(active.id, force)
    setBusy(false)
    if (!res.ok) toast(res.error ?? '停止失败', 'error')
    void refresh()
  }

  const doRestart = async (): Promise<void> => {
    if (!active) return
    setBusy(true)
    const res = await window.api.server.restart(active.id)
    setBusy(false)
    if (!res.ok) toast(res.error ?? '重启失败', 'error')
    else toast(`${active.name} 已重启`, 'success')
    void refresh()
  }

  if (!active) {
    return (
      <div className="toolbar">
        <button className="icon-btn" onClick={toggleList} title="折叠/展开服务器列表">
          <Icon name="panel" size={17} />
        </button>
        <div className="toolbar-spacer" />
        <button className="btn primary" onClick={onAdd}>
          <Icon name="plus" size={15} />
          添加服务器
        </button>
      </div>
    )
  }

  return (
    <div className="toolbar">
      <button className="icon-btn" onClick={toggleList} title="折叠/展开服务器列表">
        <Icon name="panel" size={17} />
      </button>

      {/* 服务器切换 */}
      <Menu
        trigger={(_open, toggle) => (
          <button className="chip chip-name" onClick={toggle} title={active.dir}>
            <ServerAvatar server={active} size={22} />
            <span className="chip-text">{active.name}</span>
            <Icon name="chevron-down" size={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-label">切换服务器</div>
            {servers.map((s) => (
              <button
                key={s.id}
                className={`menu-item ${s.id === active.id ? 'active' : ''}`}
                onClick={() => {
                  select(s.id)
                  close()
                }}
              >
                <ServerAvatar server={s} size={20} />
                <span className="menu-item-text">{s.name}</span>
                <span className={`dot ${s.runtime.status}`} />
              </button>
            ))}
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                onAdd()
                close()
              }}
            >
              <Icon name="plus" size={15} />
              <span className="menu-item-text">添加新的服务器</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setIconOpen(true)
                close()
              }}
            >
              <Icon name="image" size={15} />
              <span className="menu-item-text">换服务器图标…</span>
            </button>
            <button
              className="menu-item danger"
              onClick={() => {
                setDeleting(true)
                close()
              }}
            >
              <Icon name="trash" size={15} />
              <span className="menu-item-text">移除或删除这台服务器…</span>
            </button>
          </>
        )}
      </Menu>

      {/* 服务端类型 / 版本 */}
      <Menu
        trigger={(_open, toggle) => (
          <button className="chip chip-kind" onClick={toggle} title="服务端类型与版本">
            <Icon name="package" size={15} style={{ color: kindColor(active.kind) }} />
            <span className="chip-text">
              {kindLabel(active.kind)}
              {active.mcVersion ? ` ${active.mcVersion}` : ''}
            </span>
            <Icon name="chevron-down" size={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-label">服务端信息</div>
            <div className="menu-info">
              <div>
                <span>类型</span>
                <b>{kindLabel(active.kind)}</b>
              </div>
              <div>
                <span>版本</span>
                <b>{active.mcVersion || '未识别'}</b>
              </div>
              <div>
                <span>核心</span>
                <b>{active.jar || active.startScript || '未设置'}</b>
              </div>
              <div>
                <span>内存</span>
                <b>
                  {active.memoryMin} ~ {active.memoryMax} MB
                </b>
              </div>
            </div>
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                setView('properties')
                close()
              }}
            >
              <Icon name="sliders" size={15} />
              <span className="menu-item-text">编辑 server.properties</span>
            </button>
          </>
        )}
      </Menu>

      {/* 目录 */}
      <button
        className="chip chip-dir"
        title={`打开目录：${active.dir}`}
        onClick={() => void window.api.app.openFolder(active.dir)}
      >
        <Icon name="folder" size={15} />
        <span className="chip-text">
          {active.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || active.dir}
        </span>
      </button>

      <div className="toolbar-spacer" />

      {rt && rt.status !== 'stopped' && (
        <>
          <span className="stat-pill">
            <span className={`dot ${rt.status}`} />
            {statusLabel(rt.status)}
          </span>
          {rt.onlineCount > 0 && (
            <span className="stat-pill">
              <Icon name="users" size={13} />
              <b>{rt.onlineCount}</b>/{rt.maxPlayers}
            </span>
          )}
        </>
      )}

      <button
        className="icon-btn"
        onClick={togglePanel}
        title={panelOpen ? '收起右侧面板' : '展开右侧面板'}
        style={{ color: panelOpen ? 'var(--text)' : undefined }}
      >
        <Icon name="panel" size={17} />
      </button>

      {running ? (
        <>
          <button className="btn" disabled={busy} onClick={() => void doRestart()}>
            <Icon name="restart" size={14} />
            重启
          </button>
          <Menu
            align="right"
            trigger={(_open, toggle) => (
              <button className="btn danger" disabled={busy} onClick={toggle}>
                <Icon name="stop" size={12} />
                停止
                <Icon name="chevron-down" size={13} />
              </button>
            )}
          >
            {(close) => (
              <>
                <button
                  className="menu-item"
                  onClick={() => {
                    void doStop(false)
                    close()
                  }}
                >
                  <Icon name="stop" size={15} />
                  <span className="menu-item-text">优雅停止（保存世界）</span>
                </button>
                <button
                  className="menu-item danger"
                  onClick={() => {
                    void doStop(true)
                    close()
                  }}
                >
                  <Icon name="zap" size={15} />
                  <span className="menu-item-text">强制结束进程</span>
                </button>
              </>
            )}
          </Menu>
        </>
      ) : (
        <button className="btn primary" disabled={busy} onClick={() => void doStart()}>
          <Icon name="play" size={13} />
          启动
        </button>
      )}

      {iconOpen && <ServerIconDialog server={active} onClose={() => setIconOpen(false)} />}

      {deleting && (
        <DeleteServerDialog
          server={active}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false)
            void refresh()
          }}
        />
      )}
    </div>
  )
}
