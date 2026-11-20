import { useEffect, type ReactNode } from 'react'
import { Icon } from './Icon'

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'default'
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'default' | 'wide' | 'slim' | 'full'
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      aria-pressed={checked}
    />
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div className="field">
      <div className="field-label">
        {label}
        {hint && <span className="field-key">{hint}</span>}
      </div>
      <div className="field-body">{children}</div>
    </div>
  )
}

/**
 * 内存分配：滑条 + 数字输入。
 *
 * 纯数字输入在 1024 / 4096 / 8192 之间来回改很费劲，尤其是不确定该给多少时；
 * 滑条能直观看到「现在占了多少」。数字输入保留，方便精确填 6144 这种值。
 * 最小内存始终被压在最大内存下面，反过来也一样，避免出现 -Xms > -Xmx。
 */
export function MemoryRange({
  min,
  max,
  onChange,
  maxLimit = 16384
}: {
  min: number
  max: number
  onChange: (value: { min: number; max: number }) => void
  /** 滑条上限；填得比它大时滑条会自动跟着放大 */
  maxLimit?: number
}): JSX.Element {
  const sliderMax = Math.max(4096, maxLimit, Math.ceil(Math.max(max, 0) / 1024) * 1024)
  // 最小内存的滑条只铺到当前最大内存，不然 1 GB 永远挤在最左边
  const minSliderMax = Math.max(256, Math.min(max, sliderMax))
  const setMin = (value: number): void => {
    const n = Number.isFinite(value) ? value : 0
    onChange({ min: Math.max(128, Math.min(n, Math.max(128, max - 128))), max })
  }
  const setMax = (value: number): void => {
    const n = Number.isFinite(value) ? value : 0
    onChange({ min, max: Math.max(min + 128, Math.min(n, sliderMax)) })
  }

  return (
    <div className="memory-range">
      <div className="memory-row">
        <span className="memory-tag">最小</span>
        <input
          type="range"
          className="memory-slider"
          min={128}
          max={minSliderMax}
          step={128}
          value={Math.min(min, minSliderMax)}
          onChange={(e) => setMin(Number(e.target.value))}
          aria-label="最小内存"
        />
        <input
          className="input memory-num"
          type="number"
          min={128}
          max={Math.max(128, max - 128)}
          step={256}
          value={min}
          onChange={(e) => setMin(Number(e.target.value))}
        />
        <span className="hint">MB</span>
      </div>
      <div className="memory-row">
        <span className="memory-tag">最大</span>
        <input
          type="range"
          className="memory-slider"
          min={256}
          max={sliderMax}
          step={256}
          value={Math.min(max, sliderMax)}
          onChange={(e) => setMax(Number(e.target.value))}
          aria-label="最大内存"
        />
        <input
          className="input memory-num"
          type="number"
          min={Math.max(256, min + 128)}
          max={sliderMax}
          step={256}
          value={max}
          onChange={(e) => setMax(Number(e.target.value))}
        />
        <span className="hint">MB</span>
      </div>
      <div className="hint memory-summary">
        实际分配 <b>{min}</b> MB ~ <b>{max}</b> MB（-Xms / -Xmx）
      </div>
    </div>
  )
}

export function Confirm({
  title,
  message,
  confirmText = '确定',
  danger,
  onConfirm,
  onCancel
}: {
  title: string
  message: ReactNode
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <Modal
      title={title}
      size="slim"
      onClose={onCancel}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.8, color: 'var(--text-dim)' }}>{message}</div>
    </Modal>
  )
}

export function EmptyPanel({ text }: { text: ReactNode }): JSX.Element {
  return <div className="panel-empty">{text}</div>
}

export function Spinner({ text }: { text?: string }): JSX.Element {
  return (
    <div className="center-state">
      <div className="spin" />
      {text && <div>{text}</div>}
    </div>
  )
}
