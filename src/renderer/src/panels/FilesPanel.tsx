import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { Confirm } from '../components/ui'
import { FileEditor } from '../components/FileEditor'
import { useStore } from '../store'
import { formatBytes, formatDateTime } from '../utils'
import type { FileEntry, ServerView } from '../../../shared/types'

/** 按扩展名给个图标和颜色，纯锦上添花 */
function fileVisual(entry: FileEntry): { icon: IconName; color: string } {
  if (entry.isDir) {
    if (['plugins', 'mods'].includes(entry.name)) return { icon: 'puzzle', color: '#f59e0b' }
    if (entry.name === 'world') return { icon: 'globe', color: '#22c55e' }
    if (['logs', 'crash-reports'].includes(entry.name)) return { icon: 'file-text', color: '#f87171' }
    if (entry.name === 'backups') return { icon: 'archive', color: '#a855f7' }
    if (entry.name === 'config') return { icon: 'sliders', color: '#60a5fa' }
    return { icon: 'folder', color: '#8a8a8a' }
  }
  if (entry.ext === '.jar') return { icon: 'package', color: '#f59e0b' }
  if (entry.ext === '.log' || entry.ext === '.txt') return { icon: 'file-text', color: '#9ca3af' }
  if (entry.ext === '.json' || entry.ext === '.yml' || entry.ext === '.yaml' || entry.ext === '.properties')
    return { icon: 'sliders', color: '#60a5fa' }
  if (entry.ext === '.bat' || entry.ext === '.sh' || entry.ext === '.cmd')
    return { icon: 'terminal', color: '#4ade80' }
  if (['.dat', '.mca', '.nbt'].includes(entry.ext)) return { icon: 'box', color: '#a78bfa' }
  return { icon: 'file', color: '#8a8a8a' }
}

export function FilesPanel({ server }: { server: ServerView }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null)
  const [renaming, setRenaming] = useState<FileEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [editing, setEditing] = useState<{ path: string; content: string; truncated: boolean } | null>(
    null
  )

  // 目录体积要递归遍历，world 动辄几个 GB，不能挡着列表先渲染出来。
  // 先出列表，再后台逐个补算，结果缓存在 ref 里避免来回切换目录时重复算。
  const sizeCache = useRef(new Map<string, { bytes: number; partial: boolean }>())
  const [, bumpSizes] = useState(0)

  const load = async (rel: string): Promise<void> => {
    setLoading(true)
    const res = await window.api.fs.list(server.dir, rel)
    setLoading(false)
    if (!res.ok) {
      toast(res.error ?? '读取目录失败', 'error')
      return
    }
    setEntries(res.data!)
    setCwd(rel)
    setSelected(null)
  }

  useEffect(() => {
    setCwd('')
    sizeCache.current.clear()
    void load('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id])

  useEffect(() => {
    const pending = entries.filter((e) => e.isDir && !sizeCache.current.has(e.path))
    if (!pending.length) return

    let cancelled = false
    let cursor = 0
    const CONCURRENCY = 2

    const worker = async (): Promise<void> => {
      while (!cancelled && cursor < pending.length) {
        const entry = pending[cursor++]
        const res = await window.api.fs.dirSize(server.dir, entry.path)
        if (cancelled) return
        sizeCache.current.set(
          entry.path,
          res.ok ? { bytes: res.data!.bytes, partial: res.data!.partial } : { bytes: 0, partial: false }
        )
        bumpSizes((v) => v + 1)
      }
    }

    void Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker())
    )
    return () => {
      cancelled = true
    }
  }, [entries, server.dir])

  /** 当前目录合计：已知文件大小 + 已算出的子目录体积 */
  const total = useMemo(() => {
    let bytes = 0
    let incomplete = false
    for (const e of entries) {
      if (e.isDir) {
        const s = sizeCache.current.get(e.path)
        if (s) bytes += s.bytes
        else incomplete = true
      } else {
        bytes += e.size
      }
    }
    return { bytes, incomplete }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, sizeCache.current.size])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.name.toLowerCase().includes(q))
  }, [entries, query])

  const open = async (e: FileEntry): Promise<void> => {
    if (e.isDir) {
      await load(e.path)
      return
    }
    if (['.jar', '.zip', '.gz', '.png', '.jpg', '.jpeg', '.ico', '.dat', '.mca'].includes(e.ext)) {
      void window.api.fs.open(server.dir, e.path)
      return
    }
    const res = await window.api.fs.read(server.dir, e.path)
    if (!res.ok) {
      toast(res.error ?? '读取失败', 'error')
      return
    }
    if (res.data!.binary) {
      toast('这是二进制文件，已经用系统默认程序打开', 'info')
      void window.api.fs.open(server.dir, e.path)
      return
    }
    setEditing({ path: e.path, content: res.data!.content, truncated: res.data!.truncated })
  }

  const segments = cwd ? cwd.split('/') : []

  return (
    <>
      <div className="panel-search">
        <Icon name="search" size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件"
          spellCheck={false}
        />
      </div>

      <div className="crumb">
        <button onClick={() => void load('')} title={server.dir}>
          <Icon name="server" size={13} />
        </button>
        {segments.map((seg, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon name="chevron-right" size={11} />
            <button onClick={() => void load(segments.slice(0, i + 1).join('/'))}>{seg}</button>
          </span>
        ))}
        <div className="toolbar-spacer" />
        <button
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          title="在资源管理器中打开"
          onClick={() => void window.api.fs.reveal(server.dir, cwd)}
        >
          <Icon name="external" size={13} />
        </button>
        <button
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          title="新建文件夹"
          onClick={async () => {
            const name = `新建文件夹`
            let target = cwd ? `${cwd}/${name}` : name
            let i = 1
            while (entries.some((e) => e.name === target.split('/').pop())) {
              target = cwd ? `${cwd}/${name}${i}` : `${name}${i}`
              i++
            }
            const res = await window.api.fs.mkdir(server.dir, target)
            if (res.ok) void load(cwd)
            else toast(res.error ?? '创建失败', 'error')
          }}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          title="重算目录大小"
          onClick={() => {
            sizeCache.current.clear()
            bumpSizes((v) => v + 1)
          }}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {entries.length > 0 && (
        <div className="hint" style={{ padding: '0 12px 6px' }}>
          合计 {total.incomplete ? '≥ ' : ''}
          {formatBytes(total.bytes)}
          {total.incomplete && '（正在统计子目录…）'}
        </div>
      )}

      <div className="panel-scroll">
        {loading && entries.length === 0 && <div className="panel-empty">正在读取…</div>}
        {!loading && filtered.length === 0 && (
          <div className="panel-empty">{query ? '没有匹配的文件' : '这个目录是空的'}</div>
        )}

        {cwd && (
          <button
            className="file-row"
            onClick={() => void load(segments.slice(0, -1).join('/'))}
          >
            <Icon name="chevron-left" size={15} />
            <span className="fname">返回上一级</span>
          </button>
        )}

        {filtered.map((e) => {
          const v = fileVisual(e)
          return (
            <div
              key={e.path}
              className={`file-row ${selected === e.path ? 'selected' : ''} ${e.hidden ? 'hidden-file' : ''}`}
              onClick={() => setSelected(e.path)}
              onDoubleClick={() => void open(e)}
              title={`${e.name}\n${e.isDir ? '文件夹' : formatBytes(e.size)} · ${formatDateTime(e.mtime)}`}
            >
              <Icon name={v.icon} size={16} style={{ color: v.color }} />
              <span className="fname">{e.name}</span>
              {/* 目录体积是后台补算的，没算完就显示省略号 */}
              <span className="fsize">
                {e.isDir
                  ? (() => {
                      const s = sizeCache.current.get(e.path)
                      if (!s) return '…'
                      return `${s.partial ? '≥ ' : ''}${formatBytes(s.bytes)}`
                    })()
                  : formatBytes(e.size)}
              </span>
              {selected === e.path && (
                <span className="row-actions">
                  {!e.isDir && (
                    <button
                      className="icon-btn"
                      style={{ width: 22, height: 22 }}
                      title="编辑"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void open(e)
                      }}
                    >
                      <Icon name="edit" size={13} />
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    title="重命名"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setRenaming(e)
                      setRenameValue(e.name)
                    }}
                  >
                    <Icon name="file-text" size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    title="删除（移到回收站）"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setConfirmDelete(e)
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              )}
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
          onSaved={() => void load(cwd)}
        />
      )}

      {confirmDelete && (
        <Confirm
          title="删除文件"
          danger
          confirmText="移到回收站"
          message={
            <>
              确定要删除 <b>{confirmDelete.name}</b> 吗？
              <br />
              {confirmDelete.isDir && '整个文件夹连同里面的东西一起删。'}
              <br />
              默认移到系统回收站，可以恢复；回收站不可用时才会直接删除。
            </>
          }
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            const target = confirmDelete
            setConfirmDelete(null)
            const res = await window.api.fs.remove(server.dir, target.path)
            if (res.ok) {
              toast(
                res.data!.how === 'trash'
                  ? '已移到回收站'
                  : '已删除（回收站不可用，是永久删除）',
                res.data!.how === 'trash' ? 'success' : 'info'
              )
              void load(cwd)
            } else {
              toast(res.error ?? '删除失败', 'error')
            }
          }}
        />
      )}

      {renaming && (
        <Confirm
          title="重命名"
          confirmText="确定"
          message={
            <input
              className="input"
              autoFocus
              value={renameValue}
              onChange={(ev) => setRenameValue(ev.target.value)}
              onKeyDown={(ev) => ev.key === 'Enter' && ev.currentTarget.blur()}
            />
          }
          onCancel={() => setRenaming(null)}
          onConfirm={async () => {
            const target = renaming
            setRenaming(null)
            if (!renameValue.trim() || renameValue === target.name) return
            const res = await window.api.fs.rename(server.dir, target.path, renameValue.trim())
            if (res.ok) void load(cwd)
            else toast(res.error ?? '重命名失败', 'error')
          }}
        />
      )}
    </>
  )
}
