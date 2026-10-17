import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  TomlField,
  TomlValueType,
  VelocityFile,
  VelocityServerEntry,
  VelocityUpdate
} from '../shared/types'

/**
 * velocity.toml 的读写。
 *
 * 这个文件里注释比配置本身还长——序列化重写会把用户看得懂的说明全冲掉。
 * 所以按行解析，只替换值，注释和空行原样保留。
 */

function detectType(raw: string): TomlValueType {
  const t = raw.trim()
  if (/^["']/.test(t)) return 'string'
  if (t === 'true' || t === 'false') return 'boolean'
  if (t.startsWith('[')) return 'array'
  return 'number'
}

function unquote(raw: string): string {
  const t = raw.trim()
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return t.slice(1, -1)
  return t
}

/** 把界面上的值还原成 TOML 字面量 */
function toRaw(value: string, type: TomlValueType): string {
  switch (type) {
    case 'string':
      // 里面已经带引号就不要再套一层
      return /^["'].*["']$/.test(value.trim()) ? value.trim() : `"${value}"`
    case 'boolean':
      return value === 'true' ? 'true' : 'false'
    case 'array':
      return value.trim().startsWith('[') ? value.trim() : `[${value}]`
    default: {
      const n = Number(value)
      return Number.isFinite(n) && value.trim() !== '' ? String(n) : value
    }
  }
}

interface ParseResult {
  fields: TomlField[]
  servers: VelocityServerEntry[]
  tryList: string[]
}

/** 按行解析，每段值都记住自己在文件里的行区间 */
export function parseVelocityToml(raw: string): ParseResult {
  const lines = raw.split(/\r?\n/)
  const fields: TomlField[] = []
  let section = ''
  let pendingComments: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()

    if (!trimmed) {
      pendingComments = []
      continue
    }
    if (trimmed.startsWith('#')) {
      pendingComments.push(trimmed.replace(/^#+\s?/, ''))
      continue
    }

    const sec = trimmed.match(/^\[([^\]]+)\]$/)
    if (sec) {
      section = sec[1]
      pendingComments = []
      continue
    }

    const kv = trimmed.match(/^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/)
    if (!kv) {
      pendingComments = []
      continue
    }

    const key = unquote(kv[1])
    const startLine = i
    let endLine = i
    let valueText = kv[2]

    // 多行数组：一直读到收尾的 ]
    if (valueText.trim().startsWith('[') && !valueText.includes(']')) {
      const parts = [valueText]
      let j = i + 1
      while (j < lines.length) {
        parts.push(lines[j])
        if (lines[j].includes(']')) break
        j++
      }
      valueText = parts.join('\n')
      endLine = j
      i = j // 跳掉已消费的行
    }

    const type = detectType(valueText)
    fields.push({
      section,
      key,
      value: type === 'array' ? valueText : unquote(valueText),
      rawValue: valueText,
      type,
      comment: pendingComments.join('\n'),
      startLine,
      endLine
    })
    pendingComments = []
  }

  const servers: VelocityServerEntry[] = []
  for (const f of fields) {
    if (f.section !== 'servers' || (f.key === 'try' && f.type === 'array')) continue
    if (f.type !== 'string') continue
    const m = f.value.match(/^(.*):(\d+)$/)
    servers.push({
      name: f.key,
      address: f.value,
      host: m ? m[1] : f.value,
      port: m ? Number(m[2]) : 0
    })
  }

  const tryField = fields.find((f) => f.section === 'servers' && f.key === 'try')
  const tryList = tryField
    ? [...tryField.value.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
    : []

  return { fields, servers, tryList }
}

/** 读 velocity.toml + forwarding.secret */
export async function readVelocityFile(dir: string): Promise<VelocityFile> {
  const path = join(dir, 'velocity.toml')
  let raw = ''
  let exists = false
  try {
    raw = await fs.readFile(path, 'utf-8')
    exists = true
  } catch {
    /* 文件不存在 */
  }

  const parsed = parseVelocityToml(raw)

  let secretFile = 'forwarding.secret'
  const secretField = parsed.fields.find(
    (f) => f.section === '' && f.key === 'forwarding-secret-file'
  )
  if (secretField?.value) secretFile = secretField.value

  // forwarding.secret 里就是裸密钥，可能有换行
  let secret: string | null = null
  try {
    secret = (await fs.readFile(join(dir, secretFile), 'utf-8')).trim() || null
  } catch {
    secret = null
  }

  return {
    path,
    exists,
    format: 'velocity',
    fields: parsed.fields,
    servers: parsed.servers,
    tryList: parsed.tryList,
    secret,
    secretFile,
    raw
  }
}

/**
 * 批量写回。先重新解析一次拿到最新的行号，
 * 避免界面上的行号和磁盘上的错位。
 */
export async function writeVelocityFile(dir: string, updates: VelocityUpdate[]): Promise<void> {
  const path = join(dir, 'velocity.toml')
  const raw = await fs.readFile(path, 'utf-8')
  const lines = raw.split(/\r?\n/)
  const parsed = parseVelocityToml(raw)

  // 从后往前改，前面的行号才不会被打乱
  const targets = updates
    .map((u) => ({
      update: u,
      field: parsed.fields.find((f) => f.section === u.section && f.key === u.key)
    }))
    .filter((t): t is { update: VelocityUpdate; field: TomlField } => Boolean(t.field))
    .sort((a, b) => b.field.startLine - a.field.startLine)

  for (const { update, field } of targets) {
    const rawValue = toRaw(update.value, update.type)
    const indent = lines[field.startLine].match(/^\s*/)?.[0] ?? ''
    // 多行数组压成一行，比保留原来的缩进写法更不容易出错
    lines.splice(field.startLine, field.endLine - field.startLine + 1, `${indent}${field.key} = ${rawValue}`)
  }

  await fs.writeFile(path, lines.join('\n'), 'utf-8')
}

/**
 * 重写 [servers] 段。这一段是机器管理的，整段替换，
 * 但段头上方那段给用户看的说明注释保留下来。
 */
export async function writeVelocityServers(
  dir: string,
  servers: { name: string; address: string }[],
  tryList: string[]
): Promise<void> {
  const path = join(dir, 'velocity.toml')
  const raw = await fs.readFile(path, 'utf-8')
  const lines = raw.split(/\r?\n/)

  const sectionStart = lines.findIndex((l) => l.trim() === '[servers]')
  if (sectionStart < 0) throw new Error('velocity.toml 里没有 [servers] 段')

  // 找到下一个段头或文件末尾
  let sectionEnd = lines.length
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      sectionEnd = i
      break
    }
  }

  // 保留段头之后、第一个键之前的那段说明注释
  const leadingComments: string[] = []
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const t = lines[i].trim()
    if (t.startsWith('#')) leadingComments.push(lines[i])
    else break
  }

  // 名称带特殊字符时要用引号包起来，否则 Velocity 解析会出错
  const writeName = (n: string): string => (/^[A-Za-z0-9_-]+$/.test(n) ? n : `"${n}"`)

  const body: string[] = ['']
  body.push(...leadingComments)
  body.push('')
  for (const s of servers) body.push(`${writeName(s.name)} = "${s.address}"`)
  body.push('')
  body.push('')
  body.push('# In what order we should try servers when a player logs in or is kicked from a server.')
  body.push('try = [')
  for (const t of tryList) body.push(`    "${t}"`)
  body.push(']')
  body.push('')

  lines.splice(sectionStart + 1, sectionEnd - sectionStart - 1, ...body)
  await fs.writeFile(path, lines.join('\n'), 'utf-8')
}
