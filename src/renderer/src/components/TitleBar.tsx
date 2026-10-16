import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useStore } from '../store'

/**
 * 标题栏。
 *
 * 这里原来有一排服务器标签页，现在去掉了：这个软件本身是「左边选服务器、
 * 主区域看它」的单任务结构，标签页既和左树重复，又让人以为可以同时盯着
 * 好几台。现在只留图标、名字和窗口按钮，切换服务器统一走左树
 * （或顶栏的服务器下拉）。
 */
export function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const servers = useStore((s) => s.servers)
  const activeId = useStore((s) => s.activeId)
  const active = servers.find((s) => s.id === activeId) ?? null

  useEffect(() => {
    void window.api.window.isMaximized().then((r) => r.ok && setMaximized(Boolean(r.data)))
    return window.api.on.windowState(setMaximized)
  }, [])

  return (
    <div className="titlebar" onDoubleClick={() => void window.api.window.maximize()}>
      <div className="app-logo" title="CraftDesk">
        <img src="./logo.png" alt="CraftDesk" width={22} height={22} draggable={false} />
      </div>
      <span className="app-name">CraftDesk</span>
      {active && <span className="titlebar-sub">{active.name}</span>}

      <div className="titlebar-right">
        <button className="win-btn" onClick={() => void window.api.window.minimize()} title="最小化">
          <Icon name="minimize" size={15} />
        </button>
        <button
          className="win-btn"
          onClick={() => void window.api.window.maximize()}
          title={maximized ? '还原' : '最大化'}
        >
          <Icon name={maximized ? 'restore' : 'maximize'} size={13} />
        </button>
        <button className="win-btn close" onClick={() => void window.api.window.close()} title="关闭">
          <Icon name="x" size={15} />
        </button>
      </div>
    </div>
  )
}
