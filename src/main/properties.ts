import { promises as fs } from 'node:fs'
import type { PropertiesEntry } from '../shared/types'
import { IMPORTANT_KEYS } from '../shared/propertyMeta'

export { PROPERTY_LABELS } from '../shared/propertyMeta'

/**
 * 解析 server.properties，保留注释与顺序。
 * 注释行会挂到紧随其后的那个键上，写回时原样还原。
 */
export async function parsePropertiesFile(path: string): Promise<PropertiesEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf-8')
  } catch {
    return []
  }
  return parseProperties(raw)
}

export function parseProperties(raw: string): PropertiesEntry[] {
  const entries: PropertiesEntry[] = []
  let pending: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      pending = []
      continue
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('!')) {
      pending.push(trimmed)
      continue
    }
    const eq = trimmed.indexOf('=')
    const key = eq < 0 ? trimmed : trimmed.slice(0, eq).trim()
    const value = eq < 0 ? '' : trimmed.slice(eq + 1)
    entries.push({
      key,
      value,
      comment: pending.length ? pending.join('\n') : undefined,
      important: IMPORTANT_KEYS.has(key)
    })
    pending = []
  }
  return entries
}

/** 序列化回文件内容 */
export function serializeProperties(entries: PropertiesEntry[]): string {
  const lines: string[] = []
  for (const e of entries) {
    if (e.comment) lines.push(...e.comment.split('\n'))
    lines.push(`${e.key}=${e.value}`)
  }
  return `${lines.join('\n')}\n`
}

export async function writeProperties(path: string, entries: PropertiesEntry[]): Promise<void> {
  await fs.writeFile(path, serializeProperties(entries), 'utf-8')
}

/** 读取单个键 */
export function getProperty(entries: PropertiesEntry[], key: string): string | undefined {
  return entries.find((e) => e.key === key)?.value
}
