import type { CSSProperties, ReactNode } from 'react'

export type IconName =
  | 'dashboard'
  | 'terminal'
  | 'folder'
  | 'folder-open'
  | 'users'
  | 'puzzle'
  | 'archive'
  | 'help'
  | 'settings'
  | 'plus'
  | 'x'
  | 'search'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-up'
  | 'play'
  | 'stop'
  | 'restart'
  | 'trash'
  | 'edit'
  | 'save'
  | 'refresh'
  | 'download'
  | 'folder-input'
  | 'external'
  | 'panel'
  | 'alert'
  | 'check'
  | 'activity'
  | 'cpu'
  | 'clock'
  | 'send'
  | 'file'
  | 'file-text'
  | 'package'
  | 'shield'
  | 'user-plus'
  | 'ban'
  | 'more'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'globe'
  | 'sliders'
  | 'list'
  | 'monitor'
  | 'zap'
  | 'server'
  | 'box'
  | 'pickaxe'
  | 'network'
  | 'wrench'
  | 'image'
  | 'map'

const PATHS: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="8.5" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="5" rx="1.6" />
      <rect x="3" y="14.5" width="7.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="11" width="7.5" height="10" rx="1.6" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2.4" />
      <path d="M7 9.5l2.8 2.5L7 14.5" />
      <path d="M12.5 15h4.5" />
    </>
  ),
  folder: <path d="M3 7.2a2 2 0 012-2h3.6l2 2.3H19a2 2 0 012 2v7.3a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
      <circle cx="8.4" cy="10" r="1.7" />
      <path d="M3.4 17.2l4.3-4a1.7 1.7 0 012.4 0l3.2 3.1" />
      <path d="M12.2 15.6l1.9-1.8a1.7 1.7 0 012.4 0l3.9 3.7" />
    </>
  ),
  map: (
    <>
      <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </>
  ),
  'folder-open': (
    <>
      <path d="M3 7.2a2 2 0 012-2h3.6l2 2.3H19a2 2 0 012 2v1.2" />
      <path d="M3 8.5v9.3a2 2 0 002 2h12.6a2 2 0 001.9-1.4l2-6a1.4 1.4 0 00-1.3-1.9H6.2a2 2 0 00-1.9 1.4z" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.8 20a6.3 6.3 0 0112.4 0" />
      <path d="M16.2 5.2a3.2 3.2 0 010 5.9" />
      <path d="M17.6 14.3A6 6 0 0121.4 20" />
    </>
  ),
  puzzle: (
    <path d="M10.2 3.5a1.8 1.8 0 013.6 0v1.1h3.1a1.6 1.6 0 011.6 1.6v3h1.1a1.8 1.8 0 010 3.6h-1.1v3a1.6 1.6 0 01-1.6 1.6h-3.1v1.1a1.8 1.8 0 01-3.6 0v-1.1h-3a1.6 1.6 0 01-1.6-1.6v-3.1H4.5a1.8 1.8 0 010-3.6h1.1v-3a1.6 1.6 0 011.6-1.6h3z" />
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4.2" rx="1.4" />
      <path d="M4.6 8.2V19a1.6 1.6 0 001.6 1.6h11.6A1.6 1.6 0 0019.4 19V8.2" />
      <path d="M10 12.4h4" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 014.9.6c0 1.7-2.4 2-2.4 3.6" />
      <path d="M12 17h.01" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 14.5a1.6 1.6 0 00.3 1.8l.1.1a1.9 1.9 0 11-2.7 2.7l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5v.2a1.9 1.9 0 11-3.8 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a1.9 1.9 0 11-2.7-2.7l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2.4a1.9 1.9 0 110-3.8h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a1.9 1.9 0 112.7-2.7l.1.1a1.6 1.6 0 001.8.3h.1a1.6 1.6 0 001-1.5V2.4a1.9 1.9 0 113.8 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a1.9 1.9 0 112.7 2.7l-.1.1a1.6 1.6 0 00-.3 1.8v.1a1.6 1.6 0 001.5 1h.2a1.9 1.9 0 110 3.8h-.1a1.6 1.6 0 00-1.5 1z" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  x: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.2 16.2L21 21" />
    </>
  ),
  'chevron-down': <path d="M6 9.5l6 6 6-6" />,
  'chevron-up': <path d="M6 14.5l6-6 6 6" />,
  'chevron-right': <path d="M9.5 6l6 6-6 6" />,
  'chevron-left': <path d="M14.5 6l-6 6 6 6" />,
  play: <path d="M7 4.8v14.4a.9.9 0 001.37.77l11.4-7.2a.9.9 0 000-1.54l-11.4-7.2A.9.9 0 007 4.8z" />,
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="2" />,
  restart: (
    <>
      <path d="M20.5 12a8.5 8.5 0 11-2.6-6.1" />
      <path d="M20.8 4.4v5h-5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 6.5h16" />
      <path d="M9.5 6.5V4.8a1.3 1.3 0 011.3-1.3h2.4a1.3 1.3 0 011.3 1.3v1.7" />
      <path d="M6.3 6.5l.9 12.2a1.8 1.8 0 001.8 1.7h6a1.8 1.8 0 001.8-1.7l.9-12.2" />
      <path d="M10.4 10.6v6M13.6 10.6v6" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4.2l10.6-10.6a2.1 2.1 0 10-3-3L5.2 17z" />
      <path d="M14.5 5.9l3.6 3.6" />
    </>
  ),
  save: (
    <>
      <path d="M5 4h11.2L20 7.8V19a1.6 1.6 0 01-1.6 1.6H5A1.6 1.6 0 013.4 19V5.6A1.6 1.6 0 015 4z" />
      <path d="M7.6 4v5.4h7.8V4" />
      <rect x="7.6" y="13" width="8.8" height="7.6" rx="1" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 11-2.6-6.1" />
      <path d="M20.8 4.4v5h-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.5v11" />
      <path d="M7.5 10.2l4.5 4.5 4.5-4.5" />
      <path d="M4 19h16" />
    </>
  ),
  'folder-input': (
    <>
      <path d="M3 7.2a2 2 0 012-2h3.6l2 2.3H19a2 2 0 012 2v1" />
      <path d="M3 8.5v9.3a2 2 0 002 2h6" />
      <path d="M17 14v6" />
      <path d="M14.2 17.2L17 20l2.8-2.8" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18.5 14.2V18a2 2 0 01-2 2H6a2 2 0 01-2-2V7.5a2 2 0 012-2h3.8" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.4" />
      <path d="M15 4v16" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9L2.5 17.4A2 2 0 004.2 20.4h15.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
      <path d="M12 9.5v4.2" />
      <path d="M12 17h.01" />
    </>
  ),
  check: <path d="M4.5 12.8l5 5L19.5 7" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  cpu: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <rect x="10" y="10" width="4" height="4" rx="0.8" />
      <path d="M10 3v3.5M14 3v3.5M10 17.5V21M14 17.5V21" />
      <path d="M3 10h3.5M3 14h3.5M17.5 10H21M17.5 14H21" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7v5.3l3.4 2" />
    </>
  ),
  send: (
    <>
      <path d="M12 19.5V5" />
      <path d="M6 11l6-6 6 6" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h7.5L19 8.4V19a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" />
      <path d="M13.2 3v5.6H19" />
    </>
  ),
  'file-text': (
    <>
      <path d="M6 3h7.5L19 8.4V19a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" />
      <path d="M13.2 3v5.6H19" />
      <path d="M8 13h7M8 16.6h5" />
    </>
  ),
  package: (
    <>
      <path d="M20.5 7.9v8.2a1.6 1.6 0 01-.85 1.42l-6.9 3.7a1.7 1.7 0 01-1.5 0l-6.9-3.7A1.6 1.6 0 013.5 16V8a1.6 1.6 0 01.85-1.42l6.9-3.7a1.7 1.7 0 011.5 0l6.9 3.7A1.6 1.6 0 0120.5 7.9z" />
      <path d="M3.9 7l8.1 4.4L20.1 7" />
      <path d="M12 20.5v-9.1" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6z" />
      <path d="M9.2 12l2 2 3.6-4" />
    </>
  ),
  'user-plus': (
    <>
      <circle cx="9.5" cy="8" r="3.4" />
      <path d="M3.3 20a6.3 6.3 0 0112.4 0" />
      <path d="M18.5 8.5v5M16 11h5" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M5.9 18.1L18.1 5.9" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18.5" cy="12" r="1.4" />
    </>
  ),
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1.6" />,
  restore: (
    <>
      <rect x="4" y="8" width="12" height="12" rx="1.6" />
      <path d="M8 8V5.6A1.6 1.6 0 019.6 4H18a2 2 0 012 2v8.4A1.6 1.6 0 0118.4 16H16" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.4c2.2 2.4 3.3 5.4 3.3 8.6s-1.1 6.2-3.3 8.6c-2.2-2.4-3.3-5.4-3.3-8.6S9.8 5.8 12 3.4z" />
    </>
  ),
  sliders: (
    <>
      <path d="M5 20v-6M5 10V4M12 20v-9M12 7V4M19 20v-3M19 13V4" />
      <circle cx="5" cy="12" r="1.9" />
      <circle cx="12" cy="9" r="1.9" />
      <circle cx="19" cy="15" r="1.9" />
    </>
  ),
  list: (
    <>
      <path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" />
      <circle cx="4" cy="6.5" r="1.1" />
      <circle cx="4" cy="12" r="1.1" />
      <circle cx="4" cy="17.5" r="1.1" />
    </>
  ),
  monitor: (
    <>
      <rect x="2.8" y="4" width="18.4" height="12.6" rx="2" />
      <path d="M9 20.5h6M12 16.6v3.9" />
    </>
  ),
  zap: <path d="M13.5 2.8L4.8 13.4h6.3l-.6 7.8 8.7-10.6h-6.3z" />,
  server: (
    <>
      <rect x="3" y="3.8" width="18" height="7" rx="2" />
      <rect x="3" y="13.2" width="18" height="7" rx="2" />
      <path d="M7 7.3h.01M7 16.7h.01" />
    </>
  ),
  box: (
    <>
      <path d="M12 2.8l8.5 4.6v9.2L12 21.2 3.5 16.6V7.4z" />
      <path d="M3.9 7.1L12 11.7l8.1-4.6M12 21.2v-9.5" />
    </>
  ),
  network: (
    <>
      <rect x="9" y="2.6" width="6" height="5" rx="1.4" />
      <rect x="2.6" y="16.4" width="6" height="5" rx="1.4" />
      <rect x="15.4" y="16.4" width="6" height="5" rx="1.4" />
      <path d="M12 7.6v4.2M5.6 16.4v-2.2a1.6 1.6 0 011.6-1.6h9.6a1.6 1.6 0 011.6 1.6v2.2" />
    </>
  ),
  pickaxe: (
    <>
      <path d="M6.2 5.4C9.6 3.6 14.4 3.6 17.8 5.4" />
      <path d="M4.6 7.6c1.6-1.6 3.9-2.6 6.3-2.9" />
      <path d="M9 9.5l9.8 9.8a1.6 1.6 0 01-2.3 2.3L6.7 11.8" />
    </>
  ),
  // 扳手：给 Forge / NeoForge 这类「装上去再拼出来」的服务端用
  wrench: (
    <>
      <path d="M15.4 3.2a5.2 5.2 0 00-6.6 6.6l-5.3 5.3a2.2 2.2 0 003.1 3.1l5.3-5.3a5.2 5.2 0 006.6-6.6l-2.9 2.9-2.6-.7-.7-2.6z" />
    </>
  )
}

interface IconProps {
  name: IconName
  size?: number
  className?: string
  style?: CSSProperties
  strokeWidth?: number
  fill?: string
}

export function Icon({
  name,
  size = 18,
  className,
  style,
  strokeWidth = 1.7,
  fill
}: IconProps): JSX.Element {
  const solid = name === 'play' || name === 'send' || name === 'check' || !!fill
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={solid ? (fill ?? 'currentColor') : 'none'}
      stroke={solid ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
