import { Icon, type IconName } from '../components/Icon'
import { useStore, type PanelKey } from '../store'
import { FilesPanel } from './FilesPanel'
import { PlayersPanel } from './PlayersPanel'
import { PluginsPanel } from './PluginsPanel'
import { ConfigsPanel } from './ConfigsPanel'
import { BackupsPanel } from './BackupsPanel'
import type { ServerView } from '../../../shared/types'

const TABS: { key: PanelKey; icon: IconName; label: string; title: string }[] = [
  { key: 'files', icon: 'folder', label: '文件', title: '服务器文件' },
  { key: 'players', icon: 'users', label: '玩家', title: '玩家管理' },
  { key: 'plugins', icon: 'puzzle', label: '扩展', title: 'MCDR 插件 / 服务端插件 / 模组' },
  { key: 'configs', icon: 'sliders', label: '配置', title: 'MCDR 配置与模组配置' },
  { key: 'backups', icon: 'archive', label: '备份', title: '备份与还原' }
]

export function RightPanel({ server }: { server: ServerView }): JSX.Element {
  const panel = useStore((s) => s.panel)
  const setPanel = useStore((s) => s.setPanel)
  const togglePanel = useStore((s) => s.togglePanel)
  const online = server.runtime.onlineCount

  const current = TABS.find((t) => t.key === panel) ?? TABS[0]

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{current.title}</span>
        <button
          className="icon-btn"
          title="在资源管理器中打开服务端目录"
          onClick={() => void window.api.fs.reveal(server.dir, server.coreDir)}
        >
          <Icon name="folder-open" size={16} />
        </button>
        <button className="icon-btn" title="收起面板" onClick={togglePanel}>
          <Icon name="panel" size={16} />
        </button>
      </div>

      <div className="seg">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={panel === t.key ? 'active' : ''}
            title={t.title}
            onClick={() => setPanel(t.key)}
          >
            <Icon name={t.icon} size={14} />
            {t.key === 'players' && online > 0 ? `${online}` : t.label}
          </button>
        ))}
      </div>

      {panel === 'files' && <FilesPanel server={server} />}
      {panel === 'players' && <PlayersPanel server={server} />}
      {panel === 'plugins' && <PluginsPanel server={server} />}
      {panel === 'configs' && <ConfigsPanel server={server} />}
      {panel === 'backups' && <BackupsPanel server={server} />}
    </div>
  )
}
