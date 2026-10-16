import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Confirm } from '../components/ui'
import { useStore } from '../store'
import { formatBytes, formatDateTime } from '../utils'
import type { BackupInfo, ServerView } from '../../../shared/types'

export function BackupsPanel({ server }: { server: ServerView }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const downloads = useStore((s) => s.downloads)
  const [items, setItems] = useState<BackupInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')
  const [confirmRestore, setConfirmRestore] = useState<BackupInfo | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BackupInfo | null>(null)

  const task = Object.values(downloads).find((d) => d.taskId === `backup-${server.id}`)
  const running = server.runtime.status !== 'stopped' && server.runtime.status !== 'crashed'

  const load = useCallback(async (): Promise<void> => {
    const res = await window.api.backups.list(server.id)
    setLoading(false)
    if (res.ok) setItems(res.data!)
    else toast(res.error ?? '读取备份失败', 'error')
  }, [server.id, toast])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const create = async (): Promise<void> => {
    setCreating(true)
    const res = await window.api.backups.create(server.id, label)
    setCreating(false)
    if (res.ok) {
      toast('备份完成', 'success')
      setLabel('')
      void load()
    } else {
      toast(res.error ?? '备份失败', 'error')
    }
  }

  const totalSize = items.reduce((n, b) => n + b.size, 0)

  return (
    <>
      <div style={{ padding: '10px 12px 6px' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input"
            style={{ height: 30, fontSize: 12.5 }}
            value={label}
            placeholder="备注（可留空）"
            spellCheck={false}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button className="btn sm primary" disabled={creating} onClick={() => void create()}>
            <Icon name="archive" size={14} />
            {creating ? '备份中…' : '立即备份'}
          </button>
        </div>

        {running && (
          <div className="hint" style={{ marginTop: 8, color: '#fcd34d' }}>
            服务器正在运行。运行中备份可能不一致，建议先停止或用 save-all 后再备份。
          </div>
        )}

        {task && (
          <div style={{ marginTop: 10 }}>
            <div className="progress">
              <div style={{ width: `${task.percent}%` }} />
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              {task.message}
            </div>
          </div>
        )}

        {items.length > 0 && (
          <div className="hint" style={{ marginTop: 8 }}>
            共 {items.length} 个备份，合计 {formatBytes(totalSize)}
          </div>
        )}
      </div>

      <div className="panel-scroll">
        {loading && <div className="panel-empty">正在读取…</div>}

        {!loading && items.length === 0 && (
          <div className="panel-empty">
            还没有备份。
            <br />
            备份会把整个服务端目录复制一份到 backups 文件夹，用于出问题时快速回滚。
          </div>
        )}

        {items.map((b) => (
          <div className="row" key={b.path}>
            <span className="server-icon" style={{ background: '#a855f7', width: 30, height: 30 }}>
              <Icon name="archive" size={15} strokeWidth={2} />
            </span>
            <div className="row-main">
              <div className="row-title" title={b.name}>
                {b.name}
              </div>
              <div className="row-sub">
                {formatDateTime(b.createdAt)} · {formatBytes(b.size)}
              </div>
            </div>
            <div className="row-actions">
              <button
                className="btn sm ghost"
                title="还原这个备份"
                onClick={() => setConfirmRestore(b)}
              >
                <Icon name="restart" size={14} />
              </button>
              <button
                className="btn sm ghost"
                title="删除备份"
                onClick={() => setConfirmDelete(b)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {confirmDelete && (
        <Confirm
          title="删除备份"
          danger
          confirmText="删除"
          message={
            <>
              确定删除备份 <b>{confirmDelete.name}</b>（{formatBytes(confirmDelete.size)}）吗？
              <br />
              该操作不可恢复。
            </>
          }
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            const t = confirmDelete
            setConfirmDelete(null)
            const res = await window.api.backups.remove(server.id, t.path)
            if (res.ok) {
              toast('已删除', 'success')
              void load()
            } else {
              toast(res.error ?? '删除失败', 'error')
            }
          }}
        />
      )}

      {confirmRestore && (
        <Confirm
          title="还原备份"
          danger
          confirmText="确认还原"
          message={
            <>
              将要还原 <b>{confirmRestore.name}</b>。
              <br />
              <br />
              当前服务器目录里的内容会先被移动到{' '}
              <code>.before-restore-*</code> 目录作为兜底，然后备份内容会被复制回来。
              {running && (
                <>
                  <br />
                  <br />
                  <b style={{ color: 'var(--danger)' }}>服务器正在运行，请先停止再还原。</b>
                </>
              )}
            </>
          }
          onCancel={() => setConfirmRestore(null)}
          onConfirm={async () => {
            const t = confirmRestore
            setConfirmRestore(null)
            const res = await window.api.backups.restore(server.id, t.path)
            if (res.ok) {
              toast(`还原完成，原内容已保存到 ${res.data}`, 'success')
              void load()
            } else {
              toast(res.error ?? '还原失败', 'error')
            }
          }}
        />
      )}
    </>
  )
}
