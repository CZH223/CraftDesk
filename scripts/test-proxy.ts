/**
 * 验证代理端（Velocity / BungeeCord）的识别与日志解析。
 *
 * npx esbuild scripts/test-proxy.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-proxy.cjs && node tmp/test-proxy.cjs <代理端目录>
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { detectServer } from '../src/main/importer'
import { resolveLayout } from '../src/main/layout'
import { listPlugins } from '../src/main/plugins'
import { parseLine } from '../src/main/server-manager'
import type { ServerConfig } from '../src/shared/types'

function asConfig(dir: string, kind: ServerConfig['kind']): ServerConfig {
  return {
    id: 'test',
    name: 'test',
    dir,
    jar: '',
    startScript: '',
    javaPath: '',
    memoryMin: 512,
    memoryMax: 2048,
    jvmArgs: '',
    serverArgs: '',
    kind,
    mcVersion: '',
    coreDir: '',
    mcdr: false,
    pluginsDir: '',
    modsDir: '',
    autoRestart: false,
    createdAt: 0,
    lastStartedAt: 0,
    totalUptime: 0,
    color: '',
    icon: '',
    note: '',
    order: 0
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2]
  if (!dir) {
    console.error('用法: node test-proxy.cjs <代理端目录>')
    process.exit(1)
  }

  const d = await detectServer(dir)
  console.log('══ 识别 ══')
  console.log(`  类型        ${d.kind}`)
  console.log(`  版本        ${d.mcVersion || '(未识别)'}`)
  console.log(`  推荐核心    ${d.suggestedJar || '(无)'}`)
  console.log(`  监听端口    ${d.port ?? '(未知)'}`)
  console.log(`  MOTD        ${d.motd ?? '(未知)'}`)
  console.log(`  EULA        ${d.eulaAccepted ? '不需要/已同意' : '未同意'}`)
  console.log(`  世界存档    ${d.hasWorld ? '有' : '无（代理端正常）'}`)

  const cfg = asConfig(dir, d.kind)
  const layout = await resolveLayout(cfg)
  console.log('\n══ 布局 ══')
  console.log(`  isProxy        ${layout.isProxy}`)
  console.log(`  代理配置文件    ${layout.proxyConfigFile ?? '(无)'}`)
  console.log(`  配置端口        ${layout.configuredPort ?? '(无)'}`)
  console.log(`  server.properties 存在: ${await exists(layout.serverProperties)}`)

  const plugins = await listPlugins(layout)
  console.log(`\n══ 扩展 ══ 共 ${plugins.length} 个`)
  for (const p of plugins.slice(0, 8)) {
    console.log(`  [${p.kind}] ${p.name} ${p.version}${p.enabled ? '' : ' (已禁用)'}`)
  }

  // ---- 日志解析：用真实日志验证格式与玩家事件 ----
  const logPath = join(dir, 'logs', 'latest.log')
  let text = ''
  try {
    text = await fs.readFile(logPath, 'utf-8')
  } catch {
    console.log('\n(没有 logs/latest.log，跳过日志解析验证)')
    return
  }

  const lines = text.split(/\r?\n/).filter(Boolean)
  console.log(`\n══ 日志解析（${lines.length} 行）══`)

  const RE_JOIN = /^\[connected player\]\s+([A-Za-z0-9_]{1,16})\s+\([^)]*\)\s+has connected/
  const RE_LEAVE = /^\[connected player\]\s+([A-Za-z0-9_]{1,16})\s+\([^)]*\)\s+has disconnected/
  const RE_PORT =
    /Starting Minecraft server on \S*?:(\d+)/

  const online = new Set<string>()
  const levels: Record<string, number> = {}
  let backendSwitches = 0
  let unparsed = 0
  let port: number | null = null
  let ready = false

  for (const raw of lines) {
    const line = parseLine(raw)
    levels[line.level] = (levels[line.level] ?? 0) + 1

    // 解析成功的话正文里不该再带时间戳和线程前缀
    if (/^\[\d{2}:\d{2}:\d{2}\]/.test(line.text)) unparsed++

    if (RE_JOIN.test(line.text)) online.add(RE_JOIN.exec(line.text)![1])
    else if (RE_LEAVE.test(line.text)) online.delete(RE_LEAVE.exec(line.text)![1])
    else if (/^\[server connection\]/.test(line.text)) backendSwitches++

    const m = line.text.match(RE_PORT) || line.text.match(/Listening on \/[\d.]+:(\d+)/)
    if (m) port = Number(m[1])
    if (/Done \(\d[\d.,]*s\)!/.test(line.text)) ready = true
  }

  console.log(`  日志等级分布    ${JSON.stringify(levels)}`)
  console.log(`  正文仍带前缀    ${unparsed} 行 ${unparsed === 0 ? '✓' : '✗ 解析未命中'}`)
  console.log(`  后端切换事件    ${backendSwitches} 次（不计为进出服）`)
  console.log(`  当前在线        ${online.size} 人: ${[...online].join(', ') || '(无)'}`)
  console.log(`  解析出的端口    ${port ?? '(日志里没有)'}`)
  console.log(`  启动完成标志    ${ready ? '有' : '(这段日志里没有)'}`)

  console.log('\n  样例：')
  for (const raw of lines.slice(0, 3)) {
    const l = parseLine(raw)
    console.log(`    原始  ${raw.slice(0, 100)}`)
    console.log(`    解析  [${l.level}] ${l.text.slice(0, 100)}`)
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

void main()
