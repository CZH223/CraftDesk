import { Icon } from './Icon'
import { useStore } from '../store'

export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.type}`}
          onClick={() => dismiss(t.id)}
          title="点击关闭"
        >
          <Icon
            name={t.type === 'error' ? 'alert' : t.type === 'success' ? 'check' : 'activity'}
            size={15}
            style={{
              marginTop: 1,
              color:
                t.type === 'error'
                  ? 'var(--danger)'
                  : t.type === 'success'
                    ? 'var(--accent)'
                    : 'var(--text-muted)'
            }}
          />
          <span style={{ flex: 1, lineHeight: 1.6 }}>{t.text}</span>
        </div>
      ))}
    </div>
  )
}
