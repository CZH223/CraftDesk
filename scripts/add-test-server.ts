/**
 * 把指定目录按「导入已有服务端」的同样流程加进 CraftDesk 的配置。
 * 仅用于开发期验证界面。
 *
 * npx esbuild scripts/add-test-server.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/add-test-server.cjs && node tmp/add-test-server.cjs <目录> <名称>
 */
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { detectServer, kindColor, kindLabel } from '../src/main/importer'
import { resolveLayout, toRootRel } from '../src/main/layout'
import type { ServerConfig } from '../src/shared/types'

const STORE = join(
  process.env.APPDATA || '',
  'craftdesk',
  'craftdesk.json'
)

const BACKSLASH = String.fromCharCode(92)
const norm = (p: string): string => p.split(BACKSLASH).join('/')

/**
 * store.ts 依赖 electron 的 app.getPath，测试脚本跑在纯 node 下，
 * 所以这里内联一份默认值，字段和 store.defaultServer 保持一致。
 */
function makeDefault(partial: Partial<ServerConfig>): ServerConfig {
  return {
    id: randomUUID(),
    name: '新服务器',
    dir: '',
    jar: 'server.jar',
    startScript: '',
    javaPath: '',
    memoryMin: 1024,
    memoryMax: 4096,
    jvmArgs: '',
    serverArgs: 'nogui',
    kind: 'unknown',
    mcVersion: '',
    coreDir: '',
    mcdr: false,
    pluginsDir: '',
    modsDir: '',
    autoRestart: false,
    createdAt: Date.now(),
    lastStartedAt: 0,
    totalUptime: 0,
    color: '',
    icon: '',
    note: '',
    order: 0,
    ...partial
  }
}

async function main(): Promise<void> {
  const [dirArg, nameArg] = process.argv.slice(2)
  if (!dirArg) {
    console.error('用法: node add-test-server.cjs <目录> [名称]')
    process.exit(1)
  }

  const store = JSON.parse(await fs.readFile(STORE, 'utf-8')) as {
    version: number
    servers: ServerConfig[]
    settings: unknown
  }

  const dir = norm(dirArg)
  if (store.servers.some((s) => norm(s.dir) === dir)) {
    console.log('该目录已在列表中，跳过')
    return
  }

  const detected = await detectServer(dir)
  const cfg = makeDefault({
    id: randomUUID(),
    name: nameArg || detected.name,
    dir: dir.split('/').join(BACKSLASH),
    jar: detected.suggestedJar,
    kind: detected.kind,
    mcVersion: detected.mcVersion,
    serverArgs: detected.kind === 'velocity' ? '' : 'nogui',
    coreDir: detected.coreDir,
    mcdr: detected.isMcdr,
    icon: kindLabel(detected.kind),
    color: kindColor(detected.kind),
    order: store.servers.length
  })

  const layout = await resolveLayout(cfg)
  cfg.pluginsDir = layout.mcPluginsDir ? toRootRel(layout, layout.mcPluginsDir) : ''
  cfg.modsDir = layout.modsDir ? toRootRel(layout, layout.modsDir) : ''

  store.servers.push(cfg)
  await fs.writeFile(STORE, JSON.stringify(store, null, 2), 'utf-8')
  console.log(`已添加：${cfg.name} / ${cfg.kind} / ${cfg.mcVersion} / jar=${cfg.jar}`)
}

void main()
