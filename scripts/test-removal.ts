/**
 * 验证「删除服务器」的守门逻辑与真实落盘行为。
 * npx esbuild scripts/test-removal.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-removal.cjs && node tmp/test-removal.cjs
 *
 * 这一组用例是故意的：删错的代价是别人的世界存档，
 * 所以宁可多写几条「看起来不该拒绝」的用例来确认闸门没有过宽。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isInside, trashDirectory, whyNotDeletable } from '../src/main/removal'
import { resolveLayout } from '../src/main/layout'
import { listPlugins, resolveExtensionFile } from '../src/main/plugins'
import { deletePath } from '../src/main/files'
import type { ServerConfig } from '../src/shared/types'

let pass = 0
let fail = 0

function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  const root = process.cwd()
  const data = join(root, 'tmp', 'protected-data')

  console.log('══ 该拒绝的路径 ══')
  check('盘符根', whyNotDeletable('D:\\', [data]) !== null, true)
  check('空路径', whyNotDeletable('', [data]) !== null, true)
  check('盘根下一层（可能是所有服务器的父目录）', whyNotDeletable('D:\\servers', [data]) !== null, true)
  check('应用数据目录本身', whyNotDeletable(data, [data]) !== null, true)
  check('数据目录的父目录', whyNotDeletable(join(root, 'tmp'), [data]) !== null, true)

  console.log('\n══ 该放行的路径 ══')
  check('正常服务器目录', whyNotDeletable('D:\\servers\\survival', [data]), null)
  check('盘根下两层', whyNotDeletable('D:\\servers\\host', [data]), null)
  check('深层目录', whyNotDeletable(join(root, 'tmp', 'some-server'), [data]), null)

  console.log('\n══ isInside ══')
  check('子目录', isInside('D:\\a\\b', 'D:\\a\\b\\mods\\x.jar'), true)
  check('自己不算在里面', isInside('D:\\a\\b', 'D:\\a\\b'), false)
  check('同前缀但不是子目录', isInside('D:\\a\\b', 'D:\\a\\bc\\x.jar'), false)
  check('大小写不敏感', isInside('D:\\A\\B', 'd:\\a\\b\\x'), true)

  console.log('\n══ 真实的回收站动作（失败必须抛错，不能静默永久删除）══')
  const victim = join(root, 'tmp', 'removal-victim')
  await fs.mkdir(join(victim, 'world'), { recursive: true })
  await fs.writeFile(join(victim, 'world', 'level.dat'), 'test')

  const usedTrash: string[] = []
  await trashDirectory(victim, async (p) => {
    usedTrash.push(p)
    await fs.rm(p, { recursive: true, force: true }) // 假装这就是回收站
  })
  check('调用方拿到了要删的绝对路径', usedTrash.length, 1)
  check('目录确实没了', await fs.access(victim).then(() => true, () => false), false)

  const victim2 = join(root, 'tmp', 'removal-victim2')
  await fs.mkdir(victim2, { recursive: true })
  let threw = ''
  try {
    await trashDirectory(victim2, async () => {
      throw new Error('回收站不可用')
    })
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  check('回收站失败时报错', threw.includes('无法移入回收站'), true)
  check('报错时目录原封不动', await fs.access(victim2).then(() => true, () => false), true)
  await fs.rm(victim2, { recursive: true, force: true })

  await extensions()

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

/**
 * 扩展（模组 / 插件）删除：只有布局认出来的那几个目录里的文件才允许删，
 * 别的路径一律拒绝——界面传过来的是字符串，删除必须自己认路。
 */
async function extensions(): Promise<void> {
  const root = join(process.cwd(), 'tmp', 'ext-server')
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(join(root, 'mods'), { recursive: true })
  await fs.mkdir(join(root, 'plugins'), { recursive: true })
  await fs.writeFile(join(root, 'mods', 'sodium.jar'), 'fake')
  await fs.writeFile(join(root, 'mods', 'lithium.jar.disabled'), 'fake')
  await fs.writeFile(join(root, 'plugins', 'viaversion.jar'), 'fake')
  await fs.writeFile(join(root, 'server.properties'), 'motd=test\n')
  await fs.writeFile(join(root, 'eula.txt'), 'eula=true\n')

  const cfg = { id: 't', name: 't', dir: root, kind: 'paper', coreDir: '', mcdr: false } as ServerConfig
  const layout = await resolveLayout(cfg)

  console.log('\n══ 扩展扫描 ══')
  const found = await listPlugins(layout)
  console.log(`  扫到 ${found.length} 项：${found.map((p) => `${p.file}(${p.kind}${p.enabled ? '' : ',禁用'})`).join(' ')}`)
  check('扫到 3 个扩展', found.length, 3)

  console.log('\n══ 允许删除的路径 ══')
  check('mods 里的 jar', resolveExtensionFile(layout, 'mods/sodium.jar').endsWith('sodium.jar'), true)
  check(
    '禁用状态的 mod',
    resolveExtensionFile(layout, 'mods/lithium.jar.disabled').endsWith('.disabled'),
    true
  )
  check('plugins 里的 jar', resolveExtensionFile(layout, 'plugins/viaversion.jar').length > 0, true)

  console.log('\n══ 必须拒绝的路径 ══')
  const rejected: [string, string][] = [
    ['server.properties', '配置文件'],
    ['eula.txt', '根目录文件'],
    ['', '空路径'],
    ['../outside.jar', '越界'],
    ['mods/../../server.properties', '绕回去']
  ]
  for (const [rel, why] of rejected) {
    let threw = false
    try {
      resolveExtensionFile(layout, rel)
    } catch {
      threw = true
    }
    check(`拒绝 ${why}：${rel || '(空)'}`, threw, true)
  }

  console.log('\n══ 真的删掉一个模组 ══')
  let how = ''
  try {
    // 回收站不可用 → 退回直接删除，返回值如实反映用的是哪种
    how = await deletePath(root, 'mods/sodium.jar', async () => {
      throw new Error('回收站不可用')
    })
  } catch (err) {
    how = `抛错：${String(err)}`
  }
  check('返回的删除方式是 permanent', how, 'permanent')
  check('文件没了', await fs.access(join(root, 'mods', 'sodium.jar')).then(() => true, () => false), false)
  check('server.properties 还在', await fs.access(join(root, 'server.properties')).then(() => true, () => false), true)

  const after = await listPlugins(layout)
  check('重新扫描只剩 2 个', after.length, 2)

  await fs.rm(root, { recursive: true, force: true })

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
