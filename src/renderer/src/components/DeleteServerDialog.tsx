import { useEffect, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { Modal } from './ui'
import { useStore } from '../store'
import { formatBytes } from '../utils'
import type { ServerDeleteMode, ServerView } from '../../../shared/types'

/**
 * 删除服务器的对话框。
 *
 * 两种程度的差别很大，所以不做成「删除 / 取消」那种一问一答，
 * 而是把两种结果各自的代价写清楚，让用户选：
 * - 只移除链接：CraftDesk 忘掉它，磁盘原封不动，随时能重新导入
 * - 连目录一起删：世界存档、插件、配置全没了
 *
 * 后者的确认按钮要先把服务器名字打对才解锁——这是最后一道闸，
 * 比再点一次「确定」有用得多，因为「再点一次」是肌肉记忆，
 * 而打出名字必须过脑子。主进程那边还会再核对一次这个名字。
 */
export function DeleteServerDialog({
  server,
  onClose,
  onDeleted
}: {
  server: ServerView
  onClose: () => void
  onDeleted: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [mode, setMode] = useState<ServerDeleteMode>('link')
  const [typed, setTyped] = useState('')
  const [size, setSize] = useState<{ bytes: number; partial: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const running = server.runtime.status !== 'stopped' && server.runtime.status !== 'crashed'
  const nameOk = typed.trim() === server.name
  const canSubmit = !busy && !running && (mode === 'link' || nameOk)

  useEffect(() => {
    void window.api.fs.dirSize(server.dir, '').then((res) => {
      if (res.ok) setSize({ bytes: res.data!.bytes, partial: res.data!.partial })
    })
  }, [server.dir])

  const submit = async (): Promise<void> => {
    setBusy(true)
    const res = await window.api.servers.delete(server.id, mode, typed.trim())
    setBusy(false)
    if (!res.ok) {
      toast(res.error ?? '删除失败', 'error')
      return
    }
    toast(
      mode === 'files' ? `${server.name} 的目录已移入回收站` : `已从列表移除 ${server.name}`,
      'success'
    )
    onDeleted()
  }

  return (
    <Modal
      title={mode === 'files' ? `删除 ${server.name}` : `移除 ${server.name}`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className={`btn ${mode === 'files' ? 'danger' : 'primary'}`}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? '处理中…' : mode === 'files' ? '删除整个服务器' : '从列表移除'}
          </button>
        </>
      }
    >
      {running && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          <Icon name="alert" size={15} />
          <span>
            服务器正在运行，先停下来再删。跑着的进程占着 jar 和世界文件，删到一半更麻烦。
          </span>
        </div>
      )}

      <div className="pick-list">
        <PickCard
          active={mode === 'link'}
          icon="panel"
          title="只从列表移除"
          sub="磁盘上一个字节都不动"
          onClick={() => setMode('link')}
        >
          {/* 文本和 <code> 写在同一行：JSX 里换行会塌成一个空格，
              中文句子中间多一个空格看着很别扭 */}
          CraftDesk 忘掉这台服务器，目录 <code>{server.dir}</code>
          {' '}原封不动。之后想管它，重新导入一次就行。
        </PickCard>

        <PickCard
          active={mode === 'files'}
          icon="trash"
          title="连服务器目录一起删除"
          sub="走回收站，能反悔"
          danger
          onClick={() => setMode('files')}
        >
          整台服务器的文件都会被移入系统回收站：世界存档、插件、模组、配置、
          <b>全部</b>。
          {size && (
            <>
              {' '}
              这个目录有 <b>{size.partial ? '≥ ' : ''}{formatBytes(size.bytes)}</b>。
            </>
          )}
        </PickCard>
      </div>

      {mode === 'files' && (
        <div className="notice danger" style={{ marginTop: 12, display: 'block' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Icon name="alert" size={15} />
            <div>
              <b>这一步没有撤销按钮。</b>
              回收站里的东西会被清空，清空之后就找不回来了。世界存档尤其没法重建。
              <div style={{ marginTop: 10 }}>
                确认就输入服务器名称 <code>{server.name}</code>：
              </div>
              <input
                className="input"
                style={{ marginTop: 8 }}
                autoFocus
                value={typed}
                placeholder={server.name}
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
              />
              {typed.length > 0 && !nameOk && (
                <div style={{ marginTop: 6, color: 'var(--danger)' }}>名称不一致，还删不了</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="hint" style={{ marginTop: 12, lineHeight: 1.8 }}>
        备份提示：删除之前可以先到右侧「备份」面板打一个整目录备份，比回收站可靠。
      </div>
    </Modal>
  )
}

function PickCard({
  active,
  icon,
  title,
  sub,
  danger,
  children,
  onClick
}: {
  active: boolean
  icon: IconName
  title: string
  sub: string
  danger?: boolean
  children: ReactNode
  onClick: () => void
}): JSX.Element {
  return (
    <button
      className={`pick-card ${active ? 'active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span
        className="pick-icon"
        style={{ background: danger ? 'var(--danger-soft)' : 'var(--bg-active)', color: danger ? 'var(--danger)' : 'var(--text-dim)' }}
      >
        <Icon name={icon} size={16} />
      </span>
      <span className="pick-main">
        <span className="pick-title">
          {title}
          <span className={`tag ${danger ? 'red' : ''}`}>{sub}</span>
        </span>
        <span className="pick-sub">{children}</span>
      </span>
      <span className={`pick-radio ${active ? 'on' : ''}`} />
    </button>
  )
}
