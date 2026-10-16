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
