/**
 * 验证代理端后端检查：读 CraftDesk 的配置，跑一遍 checkBackends。
 *
 * npx esbuild scripts/test-backends.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-backends.cjs && node tmp/test-backends.cjs <CraftDesk配置.json> <代理端目录>
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { readVelocityFile } from '../src/main/velocity'
import { readBungeeFile } from '../src/main/bungee'
import { checkBackends } from '../src/main/backends'
import type { ServerConfig } from '../src/shared/types'

async function main(): Promise<void> {
  const [storePath, proxyDir] = process.argv.slice(2)
  if (!storePath || !proxyDir) {
    console.error('用法: node test-backends.cjs <配置.json> <代理端目录>')
    process.exit(1)
  }

  const store = JSON.parse(await fs.readFile(storePath, 'utf-8')) as { servers: ServerConfig[] }
  const isBungee = await exists(join(proxyDir, 'config.yml')) && !(await exists(join(proxyDir, 'velocity.toml')))
  const file = isBungee ? await readBungeeFile(proxyDir) : await readVelocityFile(proxyDir)
  const field = (k: string): string =>
    file.fields.find((f) => f.section === '' && f.key === k)?.value ?? ''
  const forwardingMode = isBungee
    ? field('ip_forward') === 'true'
      ? 'legacy'
      : 'none'
    : field('player-info-forwarding-mode') || 'none'
  const onlineMode = (isBungee ? field('online_mode') : field('online-mode')) === 'true'

  console.log('══ 代理端配置 ══')
  console.log(`  格式          ${isBungee ? 'config.yml (Bungee/Waterfall)' : 'velocity.toml'}`)
  console.log(`  转发模式      ${forwardingMode}`)
  console.log(`  正版验证      ${onlineMode}`)
  console.log(`  密钥文件      ${file.secretFile || '(Bungee 没有密钥)'}`)
  console.log(`  密钥          ${file.secret ?? '(读不到)'}`)
  console.log(`  后端数量      ${file.servers.length}`)
  console.log(`  try 顺序      ${file.tryList.join(' → ') || '(空)'}`)
  console.log(`  CraftDesk 托管 ${store.servers.length} 个服务器`)

  const checks = await checkBackends({
    proxySecret: file.secret,
    forwardingMode,
    proxyOnlineMode: onlineMode,
    proxyFormat: isBungee ? 'bungee' : 'velocity',
    entries: file.servers,
    managed: store.servers,
    runningIds: new Set<string>()
  })

  const LEVEL_TAG = { error: '错误', warn: '警告', info: '提示' }

  console.log('\n══ 后端检查 ══')
  let errors = 0
  let warns = 0
  let matched = 0

  for (const c of checks) {
    const level = c.issues.some((i) => i.level === 'error')
      ? 'error'
      : c.issues.some((i) => i.level === 'warn')
        ? 'warn'
        : c.managedId
          ? 'ok'
          : 'unknown'
    if (level === 'error') errors++
    if (level === 'warn') warns++
    if (c.managedId) matched++

    const mark = level === 'ok' ? '✓' : level === 'warn' ? '!' : level === 'error' ? '✗' : '·'
    const tail = c.managedName
      ? ` → ${c.managedName}${c.proxyMod ? ` [${c.proxyMod}]` : ''}${
          c.secretOk === true ? ' 密钥一致' : c.secretOk === false ? ' 密钥不符' : ''
        }`
      : ''
    console.log(`  ${mark} ${c.name.padEnd(12)} ${c.address.padEnd(18)}${tail}`)
    for (const i of c.issues) {
      console.log(`      [${LEVEL_TAG[i.level]}] ${i.text}`)
    }
  }

  console.log(
    `\n  合计：${matched}/${checks.length} 个后端能在 CraftDesk 里对上号，${errors} 个错误，${warns} 个警告`
  )
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
