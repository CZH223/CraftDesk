/**
 * 在指定目录上跑一遍识别 → 布局解析 → 扩展扫描 → 配置扫描，
 * 不开界面就能验证主进程逻辑。
 *
 * npx esbuild scripts/test-scan.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-scan.cjs && node tmp/test-scan.cjs <服务端目录>
 */
import { detectServer } from '../src/main/importer'
import { resolveLayout, parseMemoryFromCommand } from '../src/main/layout'
import { listPlugins } from '../src/main/plugins'
import { listConfigs } from '../src/main/configs'
import type { ServerConfig, PluginKind } from '../src/shared/types'

function asConfig(dir: string, coreDir: string, mcdr: boolean): ServerConfig {
  return {
    id: 'test',
    name: 'test',
    dir,
    jar: '',
    startScript: '',
    javaPath: '',
    memoryMin: 1024,
    memoryMax: 4096,
    jvmArgs: '',
    serverArgs: 'nogui',
    kind: 'fabric',
    mcVersion: '',
    coreDir,
    mcdr,
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

const KIND_LABEL: Record<PluginKind, string> = {
  mcdr: 'MCDR 插件',
  plugin: '服务端插件',
  mod: '模组'
}

async function main(): Promise<void> {
  const dir = process.argv[2]
  if (!dir) {
    console.error('用法: node test-scan.cjs <服务端目录>')
    process.exit(1)
  }

  const detected = await detectServer(dir)
  console.log('══ 识别 ══')
  console.log(`  类型        ${detected.kind}`)
  console.log(`  版本        ${detected.mcVersion || '(未识别)'}`)
  console.log(`  核心子目录  ${detected.coreDir || '(根目录)'}`)
  console.log(`  MCDR 托管   ${detected.isMcdr ? '是' : '否'}`)

  const cfg = asConfig(dir, detected.coreDir, detected.isMcdr)
  const layout = await resolveLayout(cfg)

  console.log('\n══ 布局解析 ══')
  console.log(`  root           ${layout.root}`)
  console.log(`  core           ${layout.coreRel || '.'}`)
  console.log(`  isMcdr         ${layout.isMcdr}`)
  console.log(`  MCDR 插件目录   ${layout.mcdrPluginsDir ?? '(无)'}`)
  console.log(`  MCDR 配置目录   ${layout.mcdrConfigDir ?? '(无)'}`)
  console.log(`  MCDR config.yml ${layout.mcdrConfigFile ?? '(无)'}`)
  console.log(`  服务端插件目录   ${layout.mcPluginsDir ?? '(无)'}`)
  console.log(`  模组目录        ${layout.modsDir ?? '(无)'}`)
  console.log(`  模组配置目录     ${layout.configDir ?? '(无)'}`)
  console.log(`  server.properties ${layout.serverProperties}`)
  console.log(`  server.properties 存在: ${await exists(layout.serverProperties)}`)

  if (layout.mcdrStartCommand) {
    const mem = parseMemoryFromCommand(layout.mcdrStartCommand)
    console.log(`\n  MCDR 实际启动命令: ${layout.mcdrStartCommand}`)
    console.log(`  解析出的内存: ${mem.min ?? '?'} ~ ${mem.max ?? '?'} MB`)
  }

  const plugins = await listPlugins(layout)
  const counts: Record<PluginKind, number> = { mcdr: 0, plugin: 0, mod: 0 }
  for (const p of plugins) counts[p.kind]++

  console.log('\n══ 扩展 ══')
  for (const k of ['mcdr', 'plugin', 'mod'] as PluginKind[]) {
    console.log(`\n  ── ${KIND_LABEL[k]} (${counts[k]}) ──`)
    const sample = plugins.filter((p) => p.kind === k)
    if (!sample.length) {
      console.log('     (无)')
      continue
    }
    for (const p of sample.slice(0, 6)) {
      const flags = [p.version, p.author, p.enabled ? null : '已禁用'].filter(Boolean).join(' · ')
      console.log(`     ${p.name}${flags ? ` — ${flags}` : ''}`)
      if (p.dependencies.length) console.log(`        依赖: ${p.dependencies.join(', ')}`)
    }
    if (sample.length > 6) console.log(`     … 另外 ${sample.length - 6} 个`)
  }

  const configs = await listConfigs(layout)
  const mcdrCfg = configs.filter((c) => c.source === 'mcdr')
  const srvCfg = configs.filter((c) => c.source === 'server')

  console.log('\n══ 配置 ══')
  console.log(`  MCDR 配置 ${mcdrCfg.length} 个:`)
  for (const c of mcdrCfg.slice(0, 8)) console.log(`     ${c.path}`)
  if (mcdrCfg.length > 8) console.log(`     … 另外 ${mcdrCfg.length - 8} 个`)
  console.log(`  服务端配置 ${srvCfg.length} 个:`)
  for (const c of srvCfg.slice(0, 8)) console.log(`     ${c.path}`)
  if (srvCfg.length > 8) console.log(`     … 另外 ${srvCfg.length - 8} 个`)
}

async function exists(p: string): Promise<boolean> {
  const { promises: fs } = await import('node:fs')
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

void main()
