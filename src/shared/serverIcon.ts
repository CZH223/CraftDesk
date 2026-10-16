/**
 * 服务器图标。
 *
 * 图标存成一个短字符串（`ServerConfig.icon`），三种形态：
 *
 *   ''              用服务器名字的缩写（默认，和以前一样）
 *   'text:⛏'        一个文字或表情
 *   'file:abc.png'  用户选的图片，文件放在配置目录的 icons/ 下
 *
 * 为什么图片存文件名而不是完整路径：配置里塞绝对路径的话，
 * 把配置拷贝到别处（或者换台机器）图标就全丢了；存 `file:xxx.png` +
 * 固定目录，既能跟着配置走，又不会让配置里出现指向磁盘任意位置的路径。
 *
 * 解析一律「宽进严出」：看不懂的内容当成默认缩写，绝不让一个坏字符串
 * 把整个列表渲染搞崩。
 */

export const ICON_TEXT_SCHEME = 'text:'
export const ICON_FILE_SCHEME = 'file:'

/**
 * 头像上放得下几个字符。
 *
 * 按码点算而不是 UTF-16 长度：一个 emoji 占两个码元，
 * 用 `.length` 的话 `🌲` 会被当成超长而截掉。
 */
export const ICON_TEXT_MAX = 2

/** 文件名总长上限，防着有人在配置里塞个几千字符的名字 */
const ICON_NAME_MAX = 120

export type IconSpec =
  | { kind: 'initials' }
  | { kind: 'text'; text: string }
  | { kind: 'image'; name: string }

/** 头像上能认出来的文字长度，多余的截掉 */
export function normalizeIconText(raw: string): string {
  return Array.from(raw.trim()).slice(0, ICON_TEXT_MAX).join('')
}

/**
 * 图标文件名是否安全。
 *
 * 这个名字会被拼进 `join(userData, 'icons', name)`，
 * 所以不允许任何分隔符和 `..` —— 否则一个配置文件就能让人读到
 * 图标目录以外的文件（`file:../../craftdesk.json` 这种）。
 */
export function isSafeIconName(name: string): boolean {
  if (!name || name.length > ICON_NAME_MAX) return false
  if (name.includes('..')) return false
  if (/[\\/:*?"<>|]/.test(name)) return false
  return /^[A-Za-z0-9._-]+$/.test(name)
}

export function parseIcon(icon: string | null | undefined): IconSpec {
  const raw = (icon ?? '').trim()
  if (!raw) return { kind: 'initials' }

  if (raw.startsWith(ICON_TEXT_SCHEME)) {
    const text = normalizeIconText(raw.slice(ICON_TEXT_SCHEME.length))
    return text ? { kind: 'text', text } : { kind: 'initials' }
  }
  if (raw.startsWith(ICON_FILE_SCHEME)) {
    const name = raw.slice(ICON_FILE_SCHEME.length).trim()
    return isSafeIconName(name) ? { kind: 'image', name } : { kind: 'initials' }
  }
  return { kind: 'initials' }
}

/** 存回配置用的字符串；空串表示回到默认缩写 */
export function textIcon(text: string): string {
  const t = normalizeIconText(text)
  return t ? `${ICON_TEXT_SCHEME}${t}` : ''
}

export function fileIcon(name: string): string {
  return isSafeIconName(name) ? `${ICON_FILE_SCHEME}${name}` : ''
}

/** 图标文件的命名：一台服务器一个，换图直接覆盖同一名字 */
export function iconFileName(serverId: string, ext: string): string {
  const safe = (serverId || '').replace(/[^A-Za-z0-9-]/g, '')
  const suffix = ext.startsWith('.') ? ext : `.${ext}`
  return `${safe || 'server'}${suffix}`.toLowerCase()
}

/** 这台服务器的图标文件都该用什么前缀（换图片格式时要清掉旧的） */
export function iconNamePrefix(serverId: string): string {
  const safe = (serverId || '').replace(/[^A-Za-z0-9-]/g, '')
  return `${safe || 'server'}.`
}

// ---------------------------------------------------------------- 备选列表

/**
 * 表情候选。都是小尺寸下还看得清的，顺序按「服主常用」排。
 *
 * 有些表情后面跟了一个不可见的「变体选择符」(U+FE0F)，不能省：
 * 像 ⛏ ⚔ ❄ ⚙ 这些字符默认是文字形态，不带选择符时会被画成一根根细线
 * （Windows 上尤其明显），放在彩色头像里像是没渲染出来。
 */
export const ICON_EMOJIS: string[] = [
  '⛏️',
  '🪓',
  '⚔️',
  '🏹',
  '🛡️',
  '🔥',
  '❄️',
  '⚡',
  '💧',
  '🌲',
  '🍄',
  '🌵',
  '💎',
  '🪨',
  '🧱',
  '🏰',
  '🌋',
  '🗺️',
  '🧪',
  '⚙️',
  '🐷',
  '🐺',
  '🐔',
  '👑'
]

/** 颜色候选。都是深色背景上不刺眼、白字也压得住的 */
export const ICON_COLORS: string[] = [
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#64748b'
]
