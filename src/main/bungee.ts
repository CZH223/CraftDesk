import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { TomlField, TomlValueType, VelocityFile, VelocityServerEntry } from '../shared/types'

/**
 * BungeeCord / Waterfall 的 config.yml 读写。
 *
 * 和 velocity.toml 一样，这个文件里的注释是给用户看的（官方模板有几十行说明），
 * 整份序列化重写会把它们全冲掉。所以同样按行改：
 *   - 顶层标量（online_mode、ip_forward……）找列首的 `key:` 换值；
 *   - 监听器里的 host / motd / max_players 找第一个 listener 里的同名键；
 *   - 后端列表与 priorities 整段替换（这两段是机器维护的）。
 *
 * 只解析「一层」结构：YAML 的嵌套再深就不是配置文件该有的样子了，
 * 而且这里要保的是注释与顺序，不是做一个通用 YAML 库。
 *
 * 一个容易踩的坑：官方模板里 priorities 的列表项和 listener 的字段缩进相同
 *
 *     listeners:
 *     - query_port: 25577
 *       priorities:
 *       - lobby
 *       host: 0.0.0.0:25577
 *
 * 只按「以 - 开头」找 listener 的边界，会在 priorities 的第一项就截断，
 * 后面的 host / max_players 全都读不到。所以边界只认「和第一个 listener
 * 项同缩进的 - 」，缩进更深的都是 listener 内部的东西。
 */

/** 判断一个值是什么类型（只为了让界面知道该用开关还是输入框） */
function detectType(value: string): TomlValueType {
  const v = value.trim()
  if (v === 'true' || v === 'false') return 'boolean'
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number'
  return 'string'
}

/** 去掉 YAML 里两边的引号（解析给人看的值） */
function unquote(raw: string): string {
  const t = raw.trim()
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    const inner = t.slice(1, -1)
    return t.startsWith("'") ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"')
  }
  return t
}

/**
 * 写回 YAML 时用的字面量。
 *
 * 布尔与数字按界面上的字段类型裸写：BungeeCord 用 getBoolean / getInt 读，
 * 写成 `online_mode: 'true'` 会变成字符串，启动时直接报类型错误。
 * 其余值带特殊字符就加单引号。
 */
function yamlValue(value: string, type?: TomlValueType): string {
  const v = String(value)
  if (type === 'boolean') return v === 'true' ? 'true' : 'false'
  if (type === 'number' && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim()
  if (!v) return "''"
  // YAML 的 plain scalar 不能以特殊字符开头、不能含「冒号+空格」或「空格+井号」；
  // 地址里的冒号后面直接跟数字，不用加引号（官方模板也是裸写 0.0.0.0:25577）。
  if (
    /^[\s]|[\s]$/.test(v) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(v) ||
    /:\s|\s#/.test(v) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(v) ||
    /^-?\d+(\.\d+)?$/.test(v)
  ) {
    return `'${v.replace(/'/g, "''")}'`
  }
  return v
}

/** 键名同样可能要加引号 */
function yamlKey(name: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

interface Line {
  text: string
  indent: number
  /** 去掉缩进后的内容 */
  body: string
}

function makeLine(text: string): Line {
  const indent = text.length - text.trimStart().length
  return { text, indent, body: text.slice(indent) }
}

function splitLines(raw: string): { lines: Line[]; eol: string } {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  return { eol, lines: raw.split(/\r?\n/).map(makeLine) }
}

/** 行是不是一个顶层键（顶格、形如 key:） */
function isTopLevelKey(l: Line): boolean {
  return l.indent === 0 && /^[^\s#][^:]*:/.test(l.text)
}

/** 从一行里拆出 key 与值（不处理列表项） */
function splitKey(l: Line): { key: string; value: string } | null {
  if (l.body.startsWith('- ') || l.body === '-') return null
  const m = l.body.match(/^([^:]+):\s*(.*)$/)
  if (!m) return null
  return { key: unquote(m[1].trim()), value: m[2].trim() }
}

interface ListenerRange {
  start: number
  end: number
  /** 第一个 listener 项（`- `）的缩进；同缩进的 `- ` 才是另一个 listener */
  indent: number
}

/** 找第一个 listeners 项的行范围；没有 listeners 段时返回 null */
function findFirstListener(lines: Line[]): ListenerRange | null {
  const idx = lines.findIndex((l) => l.indent === 0 && /^listeners:\s*$/.test(l.body))
  if (idx < 0) return null

  let start = -1
  let indent = 0
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.text.trim()) continue
    const isItem = l.body === '-' || l.body.startsWith('- ')
    if (start < 0) {
      if (isItem) {
        start = i
        indent = l.indent
        continue
      }
      // listeners: 下面不是列表项，说明这份配置不是我们认识的形状
      return null
    }
    // 缩进比 listener 浅 → 段结束
    if (l.indent < indent) return { start, end: i, indent }
    // 同缩进：`- ` 是第二个 listener，别的键说明已经出了 listeners 段
    if (l.indent === indent) return { start, end: i, indent }
  }
  return start < 0 ? null : { start, end: lines.length, indent }
}

export interface BungeeParsed {
  fields: TomlField[]
  servers: VelocityServerEntry[]
  tryList: string[]
}

/**
 * 解析 config.yml。
 *
 * fields 里 section 为 '' 的是顶层键，section 为 'listener' 的是第一个监听器的键。
 * 只收标量：`disabled_commands`、`forced_hosts` 这类列表 / 映射不暴露成可编辑字段
 * （界面直接编辑原文件更合适）。
 */
export function parseBungeeConfig(raw: string): BungeeParsed {
  const { lines } = splitLines(raw)
  const fields: TomlField[] = []
  const servers: VelocityServerEntry[] = []
  const tryList: string[] = []

  const push = (section: string, key: string, value: string, line: number): void => {
    if (!value) return
    fields.push({
      section,
      key,
      value: unquote(value),
      rawValue: value,
      type: detectType(value),
      comment: '',
      startLine: line,
      endLine: line
    })
  }

  // ---- 第一个 listeners 项
  const range = findFirstListener(lines)
  if (range) {
    let inPriorities = false
    // 当前跳过的子段（forced_hosts 之类）的键缩进
    let sectionIndent = -1

    for (let i = range.start; i < range.end && i < lines.length; i++) {
      const l = lines[i]
      const isItem = l.body === '-' || l.body.startsWith('- ')
      const body = i === range.start ? l.body.replace(/^-\s*/, '') : l.body
      const indent = i === range.start ? range.indent : l.indent

      if (sectionIndent >= 0) {
        if (indent > sectionIndent) continue
        if (indent === sectionIndent && isItem) continue
        sectionIndent = -1
      }

      // priorities 是个列表：`priorities:` 之后跟若干 `- 名字`
      if (/^priorities:\s*$/.test(body)) {
        inPriorities = true
        continue
      }
      if (inPriorities) {
        if (body.startsWith('- ')) {
          const name = unquote(body.slice(2))
          if (name) tryList.push(name)
          continue
        }
        inPriorities = false
      }

      const kv = splitKey({ text: body, indent, body })
      if (!kv) continue
      // 值为空的是子段 / 列表，跳过它下面的内容
      if (!kv.value) {
        sectionIndent = indent
        continue
      }
      push('listener', kv.key, kv.value, i)
    }
  }

  // ---- 顶层标量
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!isTopLevelKey(l)) continue
    const kv = splitKey(l)
    if (!kv) continue
    // servers / listeners 由各自的解析器处理；其余空值键是段
    if (!kv.value) continue
    if (kv.key === 'servers') continue
    push('', kv.key, kv.value, i)
  }

  // ---- servers 段（沿用导入时那套解析，它在真实配置上验过）
  let inServers = false
  let entryIndent = -1
  let current: { name: string; address: string } | null = null
  const flush = (): void => {
    if (current && current.name) {
      const [host, portText] = current.address.split(':')
      const port = Number(portText)
      servers.push({
        name: current.name,
        address: current.address,
        host: host || '',
        port: Number.isFinite(port) ? port : 0
      })
    }
    current = null
  }
  for (const l of lines) {
    if (l.indent === 0 && isTopLevelKey(l)) {
      const kv = splitKey(l)
      inServers = kv?.key === 'servers'
      entryIndent = -1
      if (!inServers) flush()
      continue
    }
    if (!inServers || !l.text.trim() || l.body.startsWith('#')) continue
    // `  lobby:` —— 一个后端。缩进由第一项决定，2 格 4 格都行
    const entry = l.body.match(/^([^:]+):\s*(#.*)?$/)
    if (entry && !l.body.startsWith('-')) {
      if (entryIndent < 0) entryIndent = l.indent
      if (l.indent === entryIndent) {
        flush()
        current = { name: unquote(entry[1].trim()), address: '' }
        continue
      }
    }
    const kv = splitKey(l)
    if (current && kv && kv.key === 'address') current.address = unquote(kv.value)
  }
  flush()

  // 去重：同一个名字只留最后一条（YAML 里后者覆盖前者）
  const seen = new Map<string, VelocityServerEntry>()
  for (const s of servers) seen.set(s.name, s)

  return { fields, servers: [...seen.values()], tryList }
}

/** 读取并解析配置；文件不存在时 exists=false */
export async function readBungeeFile(dir: string): Promise<VelocityFile> {
  const path = join(dir, 'config.yml')
  let raw = ''
  try {
    raw = await fs.readFile(path, 'utf-8')
  } catch {
    return {
      path,
      exists: false,
      fields: [],
      servers: [],
      tryList: [],
      secret: null,
      secretFile: '',
      raw: '',
      format: 'bungee'
    }
  }
  const parsed = parseBungeeConfig(raw)
  return {
    path,
    exists: true,
    fields: parsed.fields,
    servers: parsed.servers,
    tryList: parsed.tryList,
    secret: null,
    secretFile: '',
    raw,
    format: 'bungee'
  }
}

export interface BungeeUpdate {
  section: '' | 'listener'
  key: string
  value: string
  type?: TomlValueType
}

/**
 * 按行改几个标量值。
 *
 * 找不到的键不追加：BungeeCord 的配置项极多，乱加一个不存在的键会被当成未知项；
 * 而且真正缺的项第一次启动时它自己会补全。
 */
export function patchBungeeConfig(raw: string, updates: BungeeUpdate[]): string {
  const { lines, eol } = splitLines(raw)
  const range = findFirstListener(lines)

  for (const u of updates) {
    if (u.section === 'listener') {
      if (!range) continue
      for (let i = range.start; i < range.end && i < lines.length; i++) {
        const l = lines[i]
        const body = i === range.start ? l.body.replace(/^-\s*/, '') : l.body
        // 只改 listener 自己的字段，别钻进 nested 的 forced_hosts
        if (i !== range.start && l.indent !== range.indent + 2) continue
        const kv = splitKey({ text: body, indent: 0, body })
        if (!kv || kv.key !== u.key) continue
        const prefix = l.text.slice(0, l.text.length - l.body.length)
        const leading = i === range.start ? '- ' : ''
        lines[i] = makeLine(`${prefix}${leading}${u.key}: ${yamlValue(u.value, u.type)}`)
        break
      }
      continue
    }

    const idx = lines.findIndex((l) => {
      if (!isTopLevelKey(l)) return false
      const kv = splitKey(l)
      return kv?.key === u.key && Boolean(kv.value)
    })
    if (idx >= 0) {
      lines[idx] = makeLine(`${u.key}: ${yamlValue(u.value, u.type)}`)
    }
  }

  return lines.map((l) => l.text).join(eol)
}

/**
 * servers: 段的行。
 *
 * 新加的后端写全 address / motd / restricted；已经有同名条目的，保留它原来的
 * 写法（用户自己加的 motd、restricted 之类不该因为我们加一台后端就被冲掉）。
 */
function serversBlockLines(servers: { name: string; address: string }[], indent: string): Line[] {
  const out: Line[] = []
  out.push(makeLine('servers:'))
  for (const s of servers) {
    out.push(makeLine(`${indent}${yamlKey(s.name)}:`))
    out.push(makeLine(`${indent}  address: ${yamlValue(s.address)}`))
    out.push(makeLine(`${indent}  motd: ${yamlValue(s.name)}`))
    out.push(makeLine(`${indent}  restricted: false`))
  }
  return out
}

/** 把现有 servers 段按名字切成条目（含条目里的注释与空行） */
function parseServerEntries(lines: Line[], start: number, end: number): Map<string, Line[]> {
  const entries = new Map<string, Line[]>()
  // 条目名的缩进由块里第一层决定；嵌套的 motd / address 缩进更深，不能当成条目
  const meaningful = lines.slice(start, end).filter((l) => l.text.trim() && !l.body.startsWith('#'))
  const entryIndent = meaningful.length ? Math.min(...meaningful.map((l) => l.indent)) : 2
  let name = ''
  let body: Line[] = []
  const save = (): void => {
    if (name) entries.set(name, body)
    name = ''
    body = []
  }
  for (let i = start; i < end; i++) {
    const l = lines[i]
    const m =
      l.indent === entryIndent && !l.body.startsWith('#')
        ? l.body.match(/^([^:]+):\s*(#.*)?$/)
        : null
    if (m) {
      save()
      name = unquote(m[1].trim())
      body = [l]
      continue
    }
    if (name) body.push(l)
  }
  save()
  return entries
}

/** 把条目里的 address 换成新值；没有 address 行就插在名字下面 */
function withAddress(lines: Line[], address: string): Line[] {
  const idx = lines.findIndex((l) => !l.body.startsWith('#') && /^address:\s/.test(l.body))
  if (idx < 0) return lines
  if (unquote(lines[idx].body.replace(/^address:\s*/, '')) === address) return lines
  const old = lines[idx]
  const indent = old.text.slice(0, old.text.length - old.body.length)
  return lines.map((l, i) => (i === idx ? makeLine(`${indent}address: ${yamlValue(address)}`) : l))
}

/**
 * 整段重写 servers: 与第一个监听器的 priorities。
 *
 * priorities 引用不存在的后端时 BungeeCord 会直接拒绝启动，所以两边必须一起改：
 * 原来排在前面、这次还在的保留顺序，新加的接在后面，删掉的从列表里去掉。
 */
export function writeBungeeServersIntoText(
  raw: string,
  servers: { name: string; address: string }[],
  tryList: string[]
): string {
  const { lines, eol } = splitLines(raw)
  const names = new Set(servers.map((s) => s.name))
  const keptTry = tryList.filter((n) => names.has(n))
  const finalTry = keptTry.length ? keptTry : servers.slice(0, 1).map((s) => s.name)

  // ---- 替换 servers: 段
  const serversIdx = lines.findIndex((l) => l.indent === 0 && /^servers:\s*$/.test(l.body))
  if (serversIdx < 0) {
    // 没有这一段：顶格追加在末尾（顶格即新的顶层键）
    if (lines.length && lines[lines.length - 1].text.trim()) lines.push(makeLine(''))
    lines.push(...serversBlockLines(servers, '  '))
  } else {
    let end = lines.length
    for (let i = serversIdx + 1; i < lines.length; i++) {
      if (lines[i].indent === 0 && lines[i].text.trim() && !lines[i].body.startsWith('#')) {
        end = i
        break
      }
    }

    // 现有条目的缩进（官方模板是两格）
    const first = lines.slice(serversIdx + 1, end).find((l) => l.text.trim() && !l.body.startsWith('#'))
    const indent = first ? ' '.repeat(first.indent) : '  '
    const oldEntries = parseServerEntries(lines, serversIdx + 1, end)

    const block: Line[] = [makeLine('servers:')]
    for (const s of servers) {
      const old = oldEntries.get(s.name)
      block.push(...(old ? withAddress(old, s.address) : serversBlockLines([s], indent).slice(1)))
    }
    lines.splice(serversIdx, end - serversIdx, ...block)
  }

  // ---- 第一个监听器里的 priorities（必须在 servers 改完之后重新定位）
  const range = findFirstListener(lines)
  if (range) {
    let pIdx = -1
    for (let i = range.start; i < range.end; i++) {
      if (/^priorities:\s*$/.test(lines[i].body)) {
        pIdx = i
        break
      }
    }
    if (pIdx >= 0) {
      const keyIndent = lines[pIdx].indent
      // 列表项通常和键同缩进（官方模板就是这样），也可能多两格，两种都吃掉
      const itemIndent = /^\s*- /.test(lines[pIdx + 1]?.text ?? '')
        ? lines[pIdx + 1].indent
        : keyIndent
      let pEnd = pIdx + 1
      while (pEnd < range.end && (/^\s*-\s?/.test(lines[pEnd].text) || !lines[pEnd].text.trim())) {
        if (!lines[pEnd].text.trim()) break
        pEnd++
      }
      const replacement: Line[] = [makeLine(`${' '.repeat(keyIndent)}priorities:`)]
      for (const name of finalTry) {
        replacement.push(makeLine(`${' '.repeat(itemIndent)}- ${yamlValue(name)}`))
      }
      lines.splice(pIdx, pEnd - pIdx, ...replacement)
    }
  }

  return lines.map((l) => l.text).join(eol)
}

export async function writeBungeeFields(dir: string, updates: BungeeUpdate[]): Promise<void> {
  const path = join(dir, 'config.yml')
  const raw = await fs.readFile(path, 'utf-8')
  await fs.writeFile(path, patchBungeeConfig(raw, updates), 'utf-8')
}

export async function writeBungeeServers(
  dir: string,
  servers: { name: string; address: string }[],
  tryList: string[]
): Promise<void> {
  const path = join(dir, 'config.yml')
  const raw = await fs.readFile(path, 'utf-8')
  await fs.writeFile(path, writeBungeeServersIntoText(raw, servers, tryList), 'utf-8')
}
