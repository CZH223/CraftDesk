import type { ServerKind } from '../../shared/types'

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 运行时长，形如 1天 2小时 3分 */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (d > 0) return `${d}天 ${h}小时`
  if (h > 0) return `${h}小时 ${m}分`
  if (m > 0) return `${m}分 ${s}秒`
  return `${s}秒`
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function formatDateTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function relativeTime(ts: number): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 30 * 86400000) return `${Math.floor(diff / 86400000)} 天前`
  return formatDateTime(ts).slice(0, 10)
}

export const KIND_LABELS: Record<ServerKind, string> = {
  vanilla: '原版',
  paper: 'Paper',
  purpur: 'Purpur',
  spigot: 'Spigot',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  bukkit: 'Bukkit',
  velocity: 'Velocity',
  bungeecord: 'BungeeCord',
  waterfall: 'Waterfall',
  unknown: '未知'
}

export const KIND_COLORS: Record<ServerKind, string> = {
  vanilla: '#6b7280',
  paper: '#f59e0b',
  purpur: '#a855f7',
  spigot: '#eab308',
  fabric: '#dbb69b',
  forge: '#60a5fa',
  neoforge: '#f97316',
  bukkit: '#84cc16',
  velocity: '#06b6d4',
  bungeecord: '#0891b2',
  waterfall: '#22d3ee',
  unknown: '#64748b'
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as ServerKind] ?? '未知'
}

export function kindColor(kind: string): string {
  return KIND_COLORS[kind as ServerKind] ?? '#64748b'
}

/** 服务端图标上显示的 1~2 个字 */
export function serverInitials(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N}]/gu, '')
  if (!clean) return 'MC'
  // 中文取前两个字，英文取首字母缩写
  if (/[一-龥]/.test(clean)) return clean.slice(0, 2)
  const words = name.split(/[\s_-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return clean.slice(0, 2).toUpperCase()
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'external':
      return '外部启动'
    case 'running':
      return '运行中'
    case 'starting':
      return '启动中'
    case 'stopping':
      return '停止中'
    case 'crashed':
      return '已崩溃'
    default:
      return '已停止'
  }
}

/** 可读的 jar 大小 / 端口等小工具 */
export function clampPort(v: number): number {
  if (!Number.isFinite(v)) return 25565
  return Math.min(65535, Math.max(1, Math.round(v)))
}
