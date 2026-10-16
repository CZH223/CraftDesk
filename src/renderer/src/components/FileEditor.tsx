import { useState } from 'react'
import { Icon } from './Icon'
import { useStore } from '../store'
import type { ServerView } from '../../../shared/types'

/** 覆盖在主区域上的文本编辑器，文件和配置面板共用 */
export function FileEditor({
  server,
  path,
  initial,
  truncated,
  onClose,
  onSaved
}: {
  server: ServerView
  path: string
  initial: string
  truncated?: boolean
  onClose: () => void
  onSaved?: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [content, setContent] = useState(initial)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    const res = await window.api.fs.write(server.dir, path, content)
    setSaving(false)
    if (res.ok) {
      toast('已保存', 'success')
      setDirty(false)
      onSaved?.()
    } else {
      toast(res.error ?? '保存失败', 'error')
    }
  }

  return (
    <div className="editor">
      <div className="editor-head">
        <Icon name="sliders" size={16} style={{ color: '#60a5fa' }} />
        <span className="etitle" title={path}>
          {path}
        </span>
        {truncated && <span className="tag orange">文件过大，只显示前 4 MB</span>}
        {dirty && <span className="tag">未保存</span>}
        <div className="toolbar-spacer" />
        <button className="btn sm" onClick={onClose}>
          关闭
        </button>
        <button className="btn primary sm" disabled={!dirty || saving} onClick={() => void save()}>
          <Icon name="save" size={13} />
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
      <textarea
        value={content}
        spellCheck={false}
        onChange={(e) => {
          setContent(e.target.value)
          setDirty(true)
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault()
            void save()
          }
        }}
      />
    </div>
  )
}
