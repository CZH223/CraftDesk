import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { RemoteIcon } from '../components/RemoteIcon'
import { Modal } from '../components/ui'
import { useStore } from '../store'
import { formatBytes } from '../utils'
import { isProxyKind } from '../../../shared/types'
import type {
  InstallTarget,
  McdrPlugin,
  McdrRelease,
  RegistryHit,
  RegistrySource,
  RegistryVersion,
  ServerLayoutInfo,
  ServerView
} from '../../../shared/types'

/** 服务器类型 → Modrinth / CurseForge 的加载器标识 */
function loaderForKind(kind: string): string {
  switch (kind) {
    case 'fabric':
      return 'fabric'
    case 'forge':
      return 'forge'
    case 'neoforge':
      return 'neoforge'
    case 'paper':
    case 'purpur':
    case 'spigot':
    case 'bukkit':
      return 'paper'
    case 'velocity':
      return 'velocity'
    case 'waterfall':
      return 'waterfall'
    case 'bungeecord':
      return 'bungeecord'
    default:
      return ''
  }
}

/** 每个源支持装什么、装到哪 */
interface SourceMeta {
  key: RegistrySource
  label: string
  hint: string
  kinds: ('mod' | 'plugin')[]
  note?: string
}

const SOURCES: SourceMeta[] = [
  { key: 'modrinth', label: 'Modrinth', hint: '模组与插件通吃，API 最完整', kinds: ['mod', 'plugin'] },
  { key: 'hangar', label: 'Hangar', hint: 'Paper 官方插件站', kinds: ['plugin'] },
  {
    key: 'spigot',
    label: 'SpigotMC',
    hint: '老牌插件站',
    kinds: ['plugin'],
    note: 'SpigotMC 的下载有 Cloudflare 保护。托管在 GitHub 等地方的资源能直接装，Spigot 自托管的只能点「主页」手动下载。'
  },
  {
    key: 'curseforge',
    label: 'CurseForge',
    hint: '模组为主',
    kinds: ['mod'],
    note: 'CurseForge 官方 API 必须带 Key。到 console.curseforge.com 免费申请后填进「设置」即可。'
  }
]

/** 这个服务器能不能装这种扩展 */
function targetFor(kind: string, source: RegistrySource, projectKind: 'mod' | 'plugin'): InstallTarget | null {
  if (source === 'mcdr') return 'mcdr'
  const isProxy = isProxyKind(kind)
  if (projectKind === 'plugin') return 'plugin'
  if (kind === 'vanilla' || kind === 'unknown') return null
  return isProxy ? null : 'mod'
}

export function RegistryView({ server }: { server: ServerView }): JSX.Element {
  const [source, setSource] = useState<RegistrySource>('modrinth')
  const [layout, setLayout] = useState<ServerLayoutInfo | null>(null)
  const settings = useStore((s) => s.settings)

  useEffect(() => {
    void window.api.layout.get(server.id).then((r) => r.ok && setLayout(r.data!))
  }, [server.id])

  const meta = SOURCES.find((s) => s.key === source)
  const cfMissing = source === 'curseforge' && !settings?.curseforgeApiKey

  return (
    <div className="content">
      <div className="console-toolbar" style={{ gap: 6 }}>
        <div className="seg" style={{ margin: 0, width: 460 }}>
          {SOURCES.map((s) => (
            <button
              key={s.key}
              className={source === s.key ? 'active' : ''}
              title={s.hint}
              onClick={() => setSource(s.key)}
            >
              {s.label}
            </button>
          ))}
          <button
            className={source === 'mcdr' ? 'active' : ''}
            title="MCDReforged 的 Python 插件"
            onClick={() => setSource('mcdr')}
          >
            MCDR
          </button>
        </div>
        <div className="toolbar-spacer" />
        <span className="hint">
          装到 <b>{server.name}</b>
        </span>
      </div>

      {source === 'mcdr' ? (
        <McdrTab server={server} layout={layout} />
      ) : cfMissing ? (
        <div className="center-state">
          <Icon name="shield" size={28} />
          <div>CurseForge 需要 API Key</div>
          <div className="hint" style={{ maxWidth: 460, lineHeight: 1.9 }}>
            到 <code>console.curseforge.com</code> 免费申请一个 Key，填进「设置 → 下载源」，
            回来就能搜了。CurseForge 官方 API 不接受匿名请求。
          </div>
          <button className="btn primary" onClick={() => useStore.getState().setView('settings')}>
            去设置
          </button>
        </div>
      ) : (
        <BrowserTab server={server} layout={layout} source={source} meta={meta!} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ 通用浏览

function BrowserTab({
  server,
  layout,
  source,
  meta
}: {
  server: ServerView
  layout: ServerLayoutInfo | null
  source: RegistrySource
  meta: SourceMeta
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  // 代理端：版本号是代理自己的（Velocity 3.4.0 / BungeeCord 构建号），
  // 拿去当游戏版本过滤只会一个插件都搜不到
  const isProxy = isProxyKind(server.kind)
  const [projectKind, setProjectKind] = useState<'mod' | 'plugin'>(meta.kinds[0])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<RegistryHit[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [useServerVersion, setUseServerVersion] = useState(true)
  const [loader, setLoader] = useState(() => loaderForKind(server.kind))
  const [picker, setPicker] = useState<RegistryHit | null>(null)

  const PAGE = 20

  // 换源或换类型时重置
  useEffect(() => {
    setProjectKind(meta.kinds[0])
    setHits([])
    setError('')
  }, [source, meta])

  const search = useCallback(
    async (offset: number, append: boolean): Promise<void> => {
      setLoading(true)
      setError('')
      const res = await window.api.registry.search(source, {
        query,
        kind: projectKind,
        // 代理端的 mcVersion 是它自己的版本号（3.4.0 / 构建号 2100），
        // 拿去当 game_version 过滤只会一个插件都搜不到
        gameVersion: useServerVersion && !isProxy ? server.mcVersion || undefined : undefined,
        loader: loader || undefined,
        serverKind: server.kind,
        limit: PAGE,
        offset
      })
      setLoading(false)
      if (!res.ok) {
        setError(res.error ?? '搜索失败')
        if (!append) setHits([])
        return
      }
      setTotal(res.data!.total)
      setHits((prev) => (append ? [...prev, ...res.data!.hits] : res.data!.hits))
      setPage(offset / PAGE)
    },
    [source, query, projectKind, useServerVersion, isProxy, server.mcVersion, server.kind, loader]
  )

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void search(0, false), 350)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [search])

  const target = targetFor(server.kind, source, projectKind)
  const destDir = source === 'hangar' || source === 'spigot' ? layout?.mcPluginsDir : target === 'mod' ? layout?.modsDir : layout?.mcPluginsDir
  const multipleKinds = meta.kinds.length > 1

  return (
    <>
      <div className="console-toolbar" style={{ borderBottom: 'none', flexWrap: 'wrap', gap: 8 }}>
        {multipleKinds && (
          <div className="seg" style={{ margin: 0, width: 150 }}>
            <button
              className={projectKind === 'mod' ? 'active' : ''}
              onClick={() => setProjectKind('mod')}
            >
              模组
            </button>
            <button
              className={projectKind === 'plugin' ? 'active' : ''}
              onClick={() => setProjectKind('plugin')}
            >
              插件
            </button>
          </div>
        )}

        <div className="panel-search" style={{ margin: 0, width: 240, height: 30 }}>
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`搜索 ${meta.label}…`}
            spellCheck={false}
          />
        </div>

        <label className="check-line" title="只显示支持该 MC 版本的扩展">
          <input
            type="checkbox"
            checked={useServerVersion}
            onChange={(e) => setUseServerVersion(e.target.checked)}
          />
          只看 {server.mcVersion || '当前版本'}
        </label>

        <select
          className="select"
          style={{ width: 130, height: 30 }}
          value={loader}
          onChange={(e) => setLoader(e.target.value)}
        >
          <option value="">全部加载器</option>
          {['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'spigot', 'velocity', 'waterfall'].map(
            (l) => (
              <option key={l} value={l}>
                {l}
              </option>
            )
          )}
        </select>

        <div className="toolbar-spacer" />
        <span className="hint">{total > 0 ? `共 ${total.toLocaleString()} 个` : ''}</span>
      </div>

      {meta.note && (
        <div className="issue-bar" style={{ margin: '0 14px 10px' }}>
          <Icon name="alert" size={16} />
          <span className="issue-text">{meta.note}</span>
        </div>
      )}

      {!target && (
        <div className="issue-bar" style={{ margin: '0 14px 10px' }}>
          <Icon name="alert" size={16} />
          <span className="issue-text">
            {server.kind === 'vanilla'
              ? '原版服务端不支持模组或插件。想装模组请换成 Fabric / Forge，想装插件请换成 Paper / Purpur。'
              : '代理端只能装代理插件，这个源里对应类型的内容很少。'}
          </span>
        </div>
      )}

      {destDir && target && (
        <div className="hint" style={{ padding: '0 16px 8px' }}>
          将安装到 <code>{destDir}/</code>
          {server.runtime.status !== 'stopped' && ' · 服务器正在运行，装完需要重启才生效'}
        </div>
      )}

      <div className="dash" style={{ paddingTop: 0 }}>
        {loading && hits.length === 0 && <div className="panel-empty">正在搜索…</div>}
        {!loading && error && (
          <div className="center-state" style={{ minHeight: 160 }}>
            <Icon name="alert" size={24} />
            <div>{error}</div>
          </div>
        )}
        {!loading && !error && hits.length === 0 && (
          <div className="panel-empty">没有找到匹配的内容</div>
        )}

        <div className="dash-grid">
          {hits.map((h) => (
            <div className="card" key={`${h.source}-${h.id}`}>
              <div className="card-head">
                {/*
                  图标走主进程转 data URL：页面 CSP 不允许 https 图片，
                  直接 <img src="https://…"> 只会得到一排破图。
                */}
                <RemoteIcon
                  url={h.iconUrl}
                  fallback={source === 'hangar' ? 'puzzle' : 'package'}
                />
                <span className="card-title" title={h.name}>
                  {h.name}
                </span>
              </div>
              <div className="card-meta">
                {h.downloads > 0 && <span className="tag">{(h.downloads / 1000).toFixed(0)}k 下载</span>}
                {h.authors.slice(0, 1).map((a) => (
                  <span className="tag" key={a}>
                    {a}
                  </span>
                ))}
                {h.extra.map((x) => (
                  <span className="tag orange" key={x}>
                    {x}
                  </span>
                ))}
                {h.categories.slice(0, 2).map((c) => (
                  <span className="tag blue" key={c}>
                    {c}
                  </span>
                ))}
              </div>
              <div className="mod-desc">{h.description || '（没有简介）'}</div>
              <div className="card-actions" style={{ marginTop: 10 }}>
                <button
                  className="btn sm primary"
                  disabled={!target || !h.installable}
                  title={h.blockedReason ?? (target ? '选择版本后安装' : '这个服务器不支持该类型')}
                  onClick={() => setPicker(h)}
                >
                  <Icon name="download" size={13} />
                  安装
                </button>
                <button
                  className="btn sm ghost"
                  title={h.pageUrl}
                  onClick={() => void window.api.app.openExternal(h.pageUrl)}
                >
                  <Icon name="external" size={13} />
                  主页
                </button>
              </div>
              {h.blockedReason && (
                <div className="hint" style={{ marginTop: 8 }}>
                  {h.blockedReason}
                </div>
              )}
            </div>
          ))}
        </div>

        {hits.length > 0 && hits.length < total && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 24 }}>
            <button className="btn" disabled={loading} onClick={() => void search((page + 1) * PAGE, true)}>
              {loading ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </div>

      {picker && target && (
        <VersionPicker
          server={server}
          source={source}
          hit={picker}
          target={target}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  )
}

// ------------------------------------------------------------------ 版本选择

function VersionPicker({
  server,
  source,
  hit,
  target,
  onClose
}: {
  server: ServerView
  source: RegistrySource
  hit: RegistryHit
  target: InstallTarget
  onClose: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const isProxy = isProxyKind(server.kind)
  const [versions, setVersions] = useState<RegistryVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    void (async () => {
      const res = await window.api.registry.versions(source, hit.id, {
        gameVersion: isProxy ? undefined : server.mcVersion || undefined,
        loader: loaderForKind(server.kind) || undefined,
        serverKind: server.kind
      })
      setLoading(false)
      if (!res.ok) {
        setError(res.error ?? '获取版本失败')
        return
      }
      setVersions(res.data!)
      setSelected(res.data![0]?.id ?? '')
    })()
  }, [source, hit.id, isProxy, server.mcVersion, server.kind])

  const v = versions.find((x) => x.id === selected)

  const install = async (): Promise<void> => {
    if (!v) return
    setInstalling(true)
    const res = await window.api.registry.install({
      serverId: server.id,
      target,
      url: v.fileUrl,
      fileName: v.fileName,
      label: hit.name,
      fileSize: v.fileSize
    })
    setInstalling(false)
    if (res.ok) {
      toast(`${hit.name} 已装到 ${res.data!.dir}/`, 'success')
      onClose()
    } else {
      toast(res.error ?? '安装失败', 'error')
    }
  }

  const CHANNEL_LABEL: Record<string, string> = {
    release: '正式版',
    beta: 'Beta',
    alpha: 'Alpha'
  }

  return (
    <Modal
      title={`安装 ${hit.name}`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!v || installing}
            onClick={() => void install()}
          >
            <Icon name="download" size={14} />
            {installing ? '下载中…' : '确认安装'}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="center-state" style={{ minHeight: 140 }}>
          <div className="spin" />
          <div>正在查可用版本…</div>
        </div>
      ) : error ? (
        <div className="center-state" style={{ minHeight: 140 }}>
          <Icon name="alert" size={24} />
          <div>{error}</div>
        </div>
      ) : versions.length === 0 ? (
        <div className="center-state" style={{ minHeight: 140 }}>
          <Icon name="alert" size={24} />
          <div>没有适配的版本</div>
          <div className="hint" style={{ maxWidth: 420 }}>
            这个项目没有支持 {server.mcVersion || '该版本'}
            {loaderForKind(server.kind) ? ` / ${loaderForKind(server.kind)}` : ''} 的发布。
            可以在上方关掉「只看当前版本」再找找。
          </div>
        </div>
      ) : (
        <>
          <div className="hint" style={{ marginBottom: 10 }}>
            {server.name} · {server.mcVersion || '版本未知'}
            {loaderForKind(server.kind) ? ` · ${loaderForKind(server.kind)}` : ''} · 共 {versions.length} 个可用版本
          </div>
          <div style={{ display: 'grid', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {versions.map((x) => (
              <button
                key={x.id}
                className={`version-row ${x.id === selected ? 'active' : ''}`}
                onClick={() => setSelected(x.id)}
              >
                <span className={`dot ${x.channel === 'release' ? 'running' : 'stopped'}`} />
                <span className="vr-main">
                  <span className="vr-title">
                    {x.name}
                    {x.channel !== 'release' && (
                      <span className="tag orange">{CHANNEL_LABEL[x.channel] ?? x.channel}</span>
                    )}
                  </span>
                  <span className="vr-sub">
                    {x.fileName}
                    {x.fileSize > 0 && ` · ${formatBytes(x.fileSize)}`}
                    {x.downloads > 0 && ` · ${x.downloads.toLocaleString()} 次下载`}
                    {x.publishedAt && ` · ${x.publishedAt.slice(0, 10)}`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------ MCDR

function McdrTab({ server, layout }: { server: ServerView; layout: ServerLayoutInfo | null }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [plugins, setPlugins] = useState<McdrPlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [label, setLabel] = useState('')
  const [picker, setPicker] = useState<McdrPlugin | null>(null)

  const load = useCallback(
    async (force = false): Promise<void> => {
      setLoading(true)
      const res = await window.api.registry.mcdrList(force)
      setLoading(false)
      if (res.ok) setPlugins(res.data!)
      else toast(res.error ?? '读取 MCDReforged 插件目录失败', 'error')
    },
    [toast]
  )

  useEffect(() => {
    void load()
  }, [load])

  const labels = useMemo(() => {
    const set = new Set<string>()
    for (const p of plugins) p.labels.forEach((l) => set.add(l))
    return [...set].sort()
  }, [plugins])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return plugins
      .filter((p) => {
        if (label && !p.labels.includes(label)) return false
        if (!q) return true
        return (
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.authors.some((a) => a.toLowerCase().includes(q))
        )
      })
      .sort((a, b) => (b.downloads ?? -1) - (a.downloads ?? -1))
  }, [plugins, query, label])

  const destDir = layout?.mcdrPluginsDir
  const canInstall = Boolean(destDir)

  return (
    <>
      <div className="console-toolbar" style={{ borderBottom: 'none', flexWrap: 'wrap', gap: 8 }}>
        <div className="panel-search" style={{ margin: 0, width: 240, height: 30 }}>
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索插件名、作者或功能"
            spellCheck={false}
          />
        </div>
        <select
          className="select"
          style={{ width: 130, height: 30 }}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        >
          <option value="">全部标签</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="重新拉取目录" onClick={() => void load(true)}>
          <Icon name="refresh" size={15} />
        </button>
        <div className="toolbar-spacer" />
        <span className="hint">共 {plugins.length} 个插件</span>
      </div>

      {!canInstall && (
        <div className="issue-bar" style={{ margin: '0 14px 10px' }}>
          <Icon name="alert" size={16} />
          <span className="issue-text">
            这个服务器不是 MCDReforged 托管的，装了 MCDR 插件也不会被加载。
          </span>
        </div>
      )}
      {canInstall && (
        <div className="hint" style={{ padding: '0 16px 8px' }}>
          将安装到 <code>{destDir}/</code> · 装完执行 <code>!!MCDR reload plugin</code> 或重启生效
        </div>
      )}

      <div className="dash" style={{ paddingTop: 0 }}>
        {loading && plugins.length === 0 && <div className="panel-empty">正在拉取插件目录（约 1 MB）…</div>}
        {!loading && visible.length === 0 && <div className="panel-empty">没有找到匹配的插件</div>}

        <div className="dash-grid">
          {visible.slice(0, 60).map((p) => (
            <div className="card" key={p.id}>
              <div className="card-head">
                <span className="mod-icon placeholder purple">
                  <Icon name="zap" size={16} />
                </span>
                <span className="card-title" title={p.name}>
                  {p.name}
                </span>
              </div>
              <div className="card-meta">
                {p.version && <span className="tag">v{p.version}</span>}
                <span className="tag">{p.authors.slice(0, 2).join(', ') || '未知作者'}</span>
                {p.downloads != null && <span className="tag">{p.downloads.toLocaleString()} 次</span>}
                {p.labels.slice(0, 2).map((l) => (
                  <span className="tag purple" key={l}>
                    {l}
                  </span>
                ))}
              </div>
              <div className="mod-desc">{p.description || '（目录里没有提供简介）'}</div>
              <div className="card-actions" style={{ marginTop: 10 }}>
                <button className="btn sm primary" disabled={!canInstall} onClick={() => setPicker(p)}>
                  <Icon name="download" size={13} />
                  安装
                </button>
                {p.repository && (
                  <button
                    className="btn sm ghost"
                    title={p.repository}
                    onClick={() => void window.api.app.openExternal(p.repository)}
                  >
                    <Icon name="external" size={13} />
                    仓库
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {visible.length > 60 && (
          <div className="panel-empty" style={{ padding: '10px 0 24px' }}>
            结果较多，只显示下载量前 60 个，用搜索或标签缩小范围
          </div>
        )}
      </div>

      {picker && <McdrPicker server={server} plugin={picker} onClose={() => setPicker(null)} />}
    </>
  )
}

function McdrPicker({
  server,
  plugin,
  onClose
}: {
  server: ServerView
  plugin: McdrPlugin
  onClose: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [releases, setReleases] = useState<McdrRelease[]>(plugin.releases)
  const [loading, setLoading] = useState(plugin.releases.length === 0)
  const [selected, setSelected] = useState(plugin.releases[0]?.url ?? '')
  const [installing, setInstalling] = useState(false)
  const [fallbackError, setFallbackError] = useState('')

  useEffect(() => {
    if (plugin.releases.length) return
    void (async () => {
      const res = await window.api.registry.mcdrReleases(plugin.repository)
      setLoading(false)
      if (!res.ok) {
        setFallbackError(res.error ?? '查询失败')
        return
      }
      setReleases(res.data!)
      setSelected(res.data![0]?.url ?? '')
    })()
  }, [plugin])

  const rel = releases.find((r) => r.url === selected)

  const install = async (): Promise<void> => {
    if (!rel) return
    setInstalling(true)
    const res = await window.api.registry.install({
      serverId: server.id,
      target: 'mcdr',
      url: rel.url,
      fileName: rel.fileName,
      label: plugin.name
    })
    setInstalling(false)
    if (res.ok) {
      toast(`${plugin.name} 已装到 ${res.data!.dir}/`, 'success')
      onClose()
    } else {
      toast(res.error ?? '安装失败', 'error')
    }
  }

  return (
    <Modal
      title={`安装 ${plugin.name}`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!rel || installing} onClick={() => void install()}>
            <Icon name="download" size={14} />
            {installing ? '下载中…' : '确认安装'}
          </button>
        </>
      }
    >
      <div className="hint" style={{ marginBottom: 10 }}>
        {plugin.authors.join(', ')}
        {plugin.labels.length ? ` · ${plugin.labels.join(' / ')}` : ''}
      </div>
      {plugin.description && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.8, marginBottom: 12 }}>
          {plugin.description}
        </div>
      )}

      {plugin.dependencies.length > 0 && (
        <div className="issue-bar" style={{ margin: '0 0 12px' }}>
          <Icon name="alert" size={15} />
          <span className="issue-text">
            这个插件依赖 {plugin.dependencies.map((d) => d.id).join('、')}。
            没装的话插件不会正常工作。
          </span>
        </div>
      )}

      {loading ? (
        <div className="center-state" style={{ minHeight: 120 }}>
          <div className="spin" />
          <div>目录里没有版本信息，正在查询 GitHub Releases…</div>
        </div>
      ) : fallbackError ? (
        <div className="center-state" style={{ minHeight: 120 }}>
          <Icon name="alert" size={24} />
          <div>拿不到可下载的版本</div>
          <div className="hint" style={{ maxWidth: 400 }}>
            {fallbackError}。可以到仓库的 Releases 页面手动下载 .mcdr 放进 plugins/。
          </div>
        </div>
      ) : releases.length === 0 ? (
        <div className="center-state" style={{ minHeight: 120 }}>
          <div>这个插件没有提供 .mcdr / .pyz 发布包</div>
          <div className="hint">需要到仓库自行构建或下载，再手动放进 plugins/。</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
          {releases.map((r) => (
            <button
              key={r.url}
              className={`version-row ${r.url === selected ? 'active' : ''}`}
              onClick={() => setSelected(r.url)}
            >
              <Icon name="package" size={14} style={{ color: '#a855f7' }} />
              <span className="vr-main">
                <span className="vr-title">{r.fileName || r.version}</span>
                <span className="vr-sub">
                  {formatBytes(r.size)}
                  {r.downloads ? ` · ${r.downloads} 次下载` : ''}
                  {r.uploadedAt ? ` · ${r.uploadedAt.slice(0, 10)}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
