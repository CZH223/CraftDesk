import { Icon, type IconName } from './Icon'
import { useStore, type ViewKey } from '../store'

/**
 * 左侧图标栏。
 *
 * 这里只放「主区域视图」——文件、玩家、扩展、配置、备份已经是右侧面板的
 * 标签页了，再在图标栏放一份就是同一个东西两个入口，看着乱。
 */
interface RailEntry {
  key: ViewKey
  icon: IconName
  label: string
}

const ENTRIES: RailEntry[] = [
  { key: 'dashboard', icon: 'dashboard', label: '总览' },
  { key: 'topology', icon: 'network', label: '网络拓扑' },
  { key: 'console', icon: 'terminal', label: '控制台' },
  { key: 'registry', icon: 'download', label: '下载扩展' }
]

export function IconRail({ onHelp }: { onHelp: () => void }): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const togglePanel = useStore((s) => s.togglePanel)
  const activeId = useStore((s) => s.activeId)
  const runningCount = useStore((s) => s.servers.filter((x) => x.runtime.status !== 'stopped').length)

  return (
    <div className="rail">
      {ENTRIES.map((e) => {
        // 控制台和下载都是针对「当前选中的服务器」，没选服务器时点不动
        const needsServer = e.key === 'console' || e.key === 'registry'
        const disabled = needsServer && !activeId
        return (
          <button
            key={e.key}
            className={`rail-btn ${view === e.key ? 'active' : ''}`}
            data-tip={e.label}
            title={disabled ? '先在左侧选一个服务器' : e.label}
            style={disabled ? { opacity: 0.35 } : undefined}
            onClick={() => {
              if (disabled) return
              setView(e.key)
            }}
          >
            <Icon name={e.icon} size={19} />
            {e.key === 'dashboard' && runningCount > 0 && (
              <span className="badge">{runningCount}</span>
            )}
          </button>
        )
      })}

      <div className="rail-spacer" />

      {/* 右侧面板可能被收起来了，这里留一个总开关 */}
      <button className="rail-btn" data-tip="右侧面板" title="展开/收起右侧面板" onClick={togglePanel}>
        <Icon name="panel" size={19} />
      </button>
      <button className="rail-btn" data-tip="帮助" title="帮助" onClick={onHelp}>
        <Icon name="help" size={19} />
      </button>
      <button
        className={`rail-btn ${view === 'settings' ? 'active' : ''}`}
        data-tip="设置"
        title="设置"
        onClick={() => setView('settings')}
      >
        <Icon name="settings" size={19} />
      </button>
    </div>
  )
}
