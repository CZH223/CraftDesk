import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { FileEditor } from '../components/FileEditor'
import { useStore } from '../store'
import { formatBytes, formatDateTime } from '../utils'
import type { ConfigFile, ServerView } from '../../../shared/types'

const SOURCE_META: Record<
  ConfigFile['source'],
  { label: string; icon: IconName; color: string; tip: string; root: string }
> = {
  mcdr: {
    label: 'MCDR 配置',
    icon: 'zap',
    color: '#a855f7',
    tip: 'MCDReforged 及其 Python 插件的配置，位于服务器根目录的 config/',
    root: 'config'
  },
  server: {
    label: '服务端配置',
    icon: 'sliders',
    color: '#3b82f6',
    tip: '模组与服务端本体的配置，位于服务端目录的 config/',
    root: ''
  }
}

function extIcon(ext: string): IconName {
  if (ext === '.json' || ext === '.json5') return 'file-text'
  if (ext === '.yml' || ext === '.yaml' || ext === '.toml') return 'sliders'
  return 'file'
}

export function ConfigsPanel({ server }: { server: ServerView }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [files, setFiles] = useState<ConfigFile[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | ConfigFile['source']>('all')
  const [editing, setEditing] = useState<{ path: string; content: string; truncated: boolean } | null>(
    null
  )

  const load = useCallback(async (): Promise<void> => {
    const res = await window.api.configs.list(server.id)
    setLoading(false)
    if (res.ok) setFiles(res.data!)
    else toast(res.error ?? '读取配置目录失败', 'error')
  }, [server.id, toast])

  useEffect(() => {
    setLoading(true)
    setSource('all')
    void load()
  }, [load])

  const counts = useMemo(
    () => ({
      mcdr: files.filter((f) => f.source === 'mcdr').length,
      server: files.filter((f) => f.source === 'server').length
    }),
    [files]
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return files.filter((f) => {
      if (source !== 'all' && f.source !== source) return false
      if (!q) return true
      return f.path.toLowerCase().includes(q) || f.group.toLowerCase().includes(q)
    })
  }, [files, source, query])

  /** 按「来源 + 分组」聚合，配置多的时候一眼能看出是哪个插件的 */
  const grouped = useMemo(() => {
    const out: { key: string; source: ConfigFile['source']; group: string; items: ConfigFile[] }[] =
      []
    const index = new Map<string, (typeof out)[number]>()
    for (const f of visible) {
      const key = `${f.source}::${f.group}`
      let bucket = index.get(key)
      if (!bucket) {
        bucket = { key, source: f.source, group: f.group, items: [] }
        index.set(key, bucket)
        out.push(bucket)
      }
      bucket.items.push(f)
    }
    return out
  }, [visible])

  const open = async (f: ConfigFile): Promise<void> => {
    const res = await window.api.fs.read(server.dir, f.path)
    if (!res.ok) {
      toast(res.error ?? '读取失败', 'error')
      return
    }
    if (res.data!.binary) {
      toast('这是二进制文件，已经用系统默认程序打开', 'info')
      void window.api.fs.open(server.dir, f.path)
      return
    }
    setEditing({ path: f.path, content: res.data!.content, truncated: res.data!.truncated })
  }

  if (loading) {
    return <div className="panel-empty">正在扫描配置目录…</div>
  }

  return (
    <>
      <div className="panel-search">
        <Icon name="search" size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索配置文件"
          spellCheck={false}
        />
      </div>

      {files.length > 0 && (
        <div className="chips" style={{ padding: '0 12px 8px' }}>
          <button
            className={`chip-btn ${source === 'all' ? 'active' : ''}`}
            onClick={() => setSource('all')}
          >
            全部 {files.length}
          </button>
          {(['mcdr', 'server'] as const)
            .filter((s) => counts[s] > 0)
            .map((s) => (
              <button
                key={s}
                className={`chip-btn ${source === s ? 'active' : ''}`}
                title={SOURCE_META[s].tip}
                onClick={() => setSource(s)}
              >
                <span className="chip-dot" style={{ background: SOURCE_META[s].color }} />
                {SOURCE_META[s].label} {counts[s]}
              </button>
            ))}
        </div>
      )}

      <div className="panel-scroll">
        {files.length === 0 && (
          <div className="panel-empty">
            没有找到配置文件。
            <br />
            <br />
            <span className="hint">
              MCDR 插件配置在根目录的 config/
              <br />
              模组配置在服务端目录的 config/
              <br />
              服务器启动生成配置后这里就会显示。
            </span>
          </div>
        )}

        {files.length > 0 && visible.length === 0 && (
          <div className="panel-empty">没有匹配的配置文件</div>
        )}

        {grouped.map((bucket) => {
          const meta = SOURCE_META[bucket.source]
          return (
            <div key={bucket.key} style={{ marginBottom: 6 }}>
              <div className="group-label">
                <Icon name={meta.icon} size={12} style={{ color: meta.color }} />
                {bucket.group === '.' ? `${meta.label} · 根目录` : bucket.group}
                <span style={{ color: 'var(--text-faint)' }}>({bucket.items.length})</span>
              </div>
              {bucket.items.map((f) => (
                <div
                  key={f.path}
                  className="file-row"
                  onDoubleClick={() => void open(f)}
                  title={`${f.path}\n${formatBytes(f.size)} · ${formatDateTime(f.mtime)}`}
                >
                  <Icon name={extIcon(f.name.slice(f.name.lastIndexOf('.')))} size={15} style={{ color: meta.color }} />
                  <span className="fname">{f.name}</span>
                  <span className="fsize">{formatBytes(f.size)}</span>
                  <span className="row-actions">
                    <button
                      className="icon-btn"
                      style={{ width: 22, height: 22 }}
                      title="编辑"
                      onClick={(e) => {
                        e.stopPropagation()
                        void open(f)
                      }}
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      className="icon-btn"
                      style={{ width: 22, height: 22 }}
                      title="在资源管理器中显示"
                      onClick={(e) => {
                        e.stopPropagation()
                        void window.api.fs.reveal(server.dir, f.path)
                      }}
                    >
                      <Icon name="external" size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {editing && (
        <FileEditor
          server={server}
          path={editing.path}
          initial={editing.content}
          truncated={editing.truncated}
          onClose={() => setEditing(null)}
          onSaved={() => void load()}
        />
      )}
    </>
  )
}
