import { useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui'
import { ServerAvatar } from './ServerAvatar'
import { useStore } from '../store'
import { primeIcon } from '../iconCache'
import {
  ICON_COLORS,
  ICON_EMOJIS,
  ICON_TEXT_MAX,
  fileIcon,
  normalizeIconText,
  parseIcon,
  textIcon
} from '../../../shared/serverIcon'
import type { ServerConfig, ServerView } from '../../../shared/types'

/**
 * 换服务器图标。
 *
 * 四种形态放在一个弹窗里，点了就生效（和设置页一样是即时保存）：
 * 缩写 / 文字表情 / 颜色 / 自己的图片。
 * 预览放在最上面，改什么都能立刻看到 —— 图标本来就小，
 * 不预览的话「换个表情好不好看」只能靠猜。
 */
export function ServerIconDialog({
  server,
  onClose
}: {
  server: ServerView
  onClose: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)
  const spec = parseIcon(server.icon)
  const [text, setText] = useState(spec.kind === 'text' ? spec.text : '')
  const [busy, setBusy] = useState(false)

  const patch = async (p: Partial<ServerConfig>): Promise<void> => {
    const res = await window.api.servers.update(server.id, p)
    if (!res.ok) {
      toast(res.error ?? '保存失败', 'error')
      return
    }
    await refresh()
  }

  const chooseText = (value: string): void => {
    const clean = normalizeIconText(value)
    if (!clean) {
      toast('先打一个字或者选一个表情', 'info')
      return
    }
    setText(clean)
    void patch({ icon: textIcon(clean) })
  }

  const pickImage = async (): Promise<void> => {
    const picked = await window.api.app.pickFile('选择服务器图标', 'image')
    if (!picked.ok || !picked.data) return

    setBusy(true)
    const res = await window.api.app.importIcon(server.id, picked.data)
    if (!res.ok) {
      setBusy(false)
      toast(res.error ?? '这张图片用不了', 'error')
      return
    }
    // 导入时图片已经复制进 icons/ 了，顺手读一次填进缓存：
    // 不然弹窗里会先闪一下旧图标，等下个事件循环才变成新的
    const read = await window.api.app.readIcon(res.data!.name)
    if (read.ok) primeIcon(res.data!.name, read.data!.dataUrl)
    setBusy(false)

    await patch({ icon: fileIcon(res.data!.name) })
    toast('图标已更新', 'success')
  }

  // 预览用的 server：把当前正在编辑的内容合进去，点一下就变
  const preview = { ...server, icon: server.icon }

  return (
    <Modal title="服务器图标" onClose={onClose} size="slim">
      <div className="icon-picker">
        <div className="icon-preview">
          <ServerAvatar server={preview} size={64} />
          <div>
            <div className="icon-preview-name">{server.name}</div>
            <div className="hint">
              {spec.kind === 'image'
                ? '用的是你自己的图片'
                : spec.kind === 'text'
                  ? `用的是文字「${spec.text}」`
                  : '用的是名字缩写'}
            </div>
          </div>
        </div>

        <div className="icon-group">
          <div className="icon-group-title">文字 / 表情</div>
          <div className="emoji-grid">
            {ICON_EMOJIS.map((e) => (
              <button
                key={e}
                className={`emoji-btn ${spec.kind === 'text' && spec.text === e ? 'active' : ''}`}
                title={e}
                onClick={() => chooseText(e)}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="icon-row">
            <input
              className="input"
              style={{ maxWidth: 120 }}
              value={text}
              placeholder="自己打"
              maxLength={ICON_TEXT_MAX * 2}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') chooseText(text)
              }}
            />
            <button className="btn sm" onClick={() => chooseText(text)}>
              用这个
            </button>
            <span className="hint">最多 {ICON_TEXT_MAX} 个字符</span>
          </div>
        </div>

        <div className="icon-group">
          <div className="icon-group-title">底色</div>
          <div className="swatch-grid">
            <button
              className={`swatch kind ${server.color ? '' : 'active'}`}
              title="跟随服务端类型"
              onClick={() => void patch({ color: '' })}
            >
              <Icon name="refresh" size={13} />
            </button>
            {ICON_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${server.color === c ? 'active' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={() => void patch({ color: c })}
              />
            ))}
          </div>
          <div className="hint">
            选了图片之后底色就看不见了，图片本身铺满整个图标。
          </div>
        </div>

        <div className="icon-group">
          <div className="icon-group-title">图片</div>
          <div className="icon-row">
            <button className="btn sm" disabled={busy} onClick={() => void pickImage()}>
              <Icon name="image" size={14} />
              {busy ? '处理中…' : '选择图片…'}
            </button>
            {spec.kind === 'image' && (
              <button
                className="btn sm ghost"
                onClick={() => void patch({ icon: '' })}
                title="回到名字缩写"
              >
                移除
              </button>
            )}
          </div>
          <div className="hint">
            png / jpg / webp / gif / bmp，32 MB 以内。图片会复制到 CraftDesk
            的配置目录里，之后原图删掉、挪走都不影响。
          </div>
        </div>

        <div className="icon-group">
          <button
            className="btn sm"
            onClick={() => {
              setText('')
              void patch({ icon: '' })
            }}
          >
            <Icon name="refresh" size={14} />
            恢复成名字缩写
          </button>
        </div>
      </div>
    </Modal>
  )
}
