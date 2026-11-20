import { useEffect, useMemo, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { useStore, type PanelKey } from '../store'
import { FilesPanel } from './FilesPanel'
import { PlayersPanel } from './PlayersPanel'
import { PluginsPanel } from './PluginsPanel'
import { ConfigsPanel } from './ConfigsPanel'
import { BackupsPanel } from './BackupsPanel'
import { isProxyKind, type PluginCounts, type ServerView } from '../../../shared/types'
import { kindLabel } from '../utils'

interface Tab {
  key: PanelKey
  icon: IconName
  label: string
  title: string
}

const BASE_TABS: Tab[] = [
  { key: 'files', icon: 'folder', label: '文件', title: '服务器文件' },
  { key: 'players', icon: 'users', label: '玩家', title: '玩家管理' }
]
const TAIL_TABS: Tab[] = [
  { key: 'configs', icon: 'sliders', label: '配置', title: 'MCDR 配置与模组配置' },
  { key: 'backups', icon: 'archive', label: '备份', title: '备份与还原' }
]

/** 这个类型会不会读 mods/ */
function supportsMods(server: ServerView): boolean {
  return server.kind === 'fabric' || server.kind === 'forge' || server.kind === 'neoforge'
}

/** 这个类型会不会读 plugins/（MCDR 的 plugins 也算） */
function supportsPlugins(server: ServerView): boolean {
  return (
    isProxyKind(server.kind) ||
    server.mcdr ||
    ['paper', 'purpur', 'spigot', 'bukkit'].includes(server.kind)
  )
}

/**
 * 插件栏的名字。MCDR 包在 Paper / Fabric 外面时，两套插件都存在，
 * 所以不能只写「插件」两个字。
 */
function pluginLabel(server: ServerView): string {
  if (isProxyKind(server.kind)) return `${kindLabel(server.kind)}插件`
  if (server.mcdr) {
    if (['paper', 'purpur', 'spigot', 'bukkit'].includes(server.kind)) {
      return `MCDR/${kindLabel(server.kind)}插件`
    }
    return 'MCDR插件'
  }
  return `${kindLabel(server.kind)}插件`
}

export function RightPanel({ server }: { server: ServerView }): JSX.Element {
  const panel = useStore((s) => s.panel)
  const setPanel = useStore((s) => s.setPanel)
  const togglePanel = useStore((s) => s.togglePanel)
  const online = server.runtime.onlineCount
  const [counts, setCounts] = useState<PluginCounts | null>(null)

  // 只数目录里的文件，不解包；切服务器或切换分栏时刷新一次，
  // 安装完插件回来就能看到新分栏。
  useEffect(() => {
    let cancelled = false
    void window.api.servers.counts(server.id).then((res) => {
      if (!cancelled && res.ok) setCounts(res.data!)
    })
    return () => {
      cancelled = true
    }
  }, [server.id, panel])

  const tabs = useMemo(() => {
    const list = [...BASE_TABS]
    const pluginCount = counts?.plugins
    const modCount = counts?.mods
    if (supportsPlugins(server) && pluginCount !== 0) {
      list.push({
        key: 'plugins',
        icon: 'puzzle',
        label: pluginLabel(server),
        title: `${pluginLabel(server)}：MCDR 插件 / 服务端插件`
      })
    }
    if (supportsMods(server) && modCount !== 0) {
      list.push({ key: 'mods', icon: 'package', label: '模组', title: '服务器模组' })
    }
    list.push(...TAIL_TABS)
    return list
  }, [server, counts])

  // 切到别的类型的服务器后，原来的分栏可能已经不显示了
  useEffect(() => {
    if (!tabs.some((t) => t.key === panel)) setPanel('files')
  }, [tabs, panel, setPanel])

  const current = tabs.find((t) => t.key === panel) ?? tabs[0]

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
        {tabs.map((t) => (
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
      {panel === 'plugins' && <PluginsPanel server={server} scope="plugins" />}
      {panel === 'mods' && <PluginsPanel server={server} scope="mods" />}
      {panel === 'configs' && <ConfigsPanel server={server} />}
      {panel === 'backups' && <BackupsPanel server={server} />}
    </div>
  )
}
