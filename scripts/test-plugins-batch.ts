/**
 * 扩展的批量启用 / 禁用。
 *
 * 多选、全选、一键禁用最终都走 setPluginsEnabled：改名 .disabled 是唯一
 * 生效方式，所以这里重点验证「已经是目标状态就跳过」「失败逐条返回」
 * 和「不允许跑到服务器目录外面」。
 *
 * npx esbuild scripts/test-plugins-batch.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-plugins-batch.cjs && node tmp/test-plugins-batch.cjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { setPluginsEnabled } from '../src/main/plugins'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(
    `  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`
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

async function main(): Promise<void> {
  const root = join(process.cwd(), 'tmp', 'plugins-batch')
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(join(root, 'mods'), { recursive: true })
  await fs.writeFile(join(root, 'mods', 'a.jar'), 'a')
  await fs.writeFile(join(root, 'mods', 'b.jar.disabled'), 'b')
  await fs.writeFile(join(root, 'mods', 'c.jar'), 'c')

  const off = await setPluginsEnabled(
    root,
    ['mods/a.jar', 'mods/b.jar.disabled'],
    false
  )
  check('只改需要改的（a 禁用，b 本来就是禁用）', off.changed, 1)
  check('a 变成 .disabled', await exists(join(root, 'mods', 'a.jar.disabled')), true)
  check('b 保持 .disabled', await exists(join(root, 'mods', 'b.jar.disabled')), true)

  const on = await setPluginsEnabled(
    root,
    ['mods/a.jar.disabled', 'mods/b.jar.disabled', 'mods/c.jar'],
    true
  )
  check('启用两个已禁用项', on.changed, 2)
  check('a 恢复 .jar', await exists(join(root, 'mods', 'a.jar')), true)
  check('b 恢复 .jar', await exists(join(root, 'mods', 'b.jar')), true)
  check('c 没被重复改名', await exists(join(root, 'mods', 'c.jar')), true)

  const bad = await setPluginsEnabled(root, ['../outside.jar'], false)
  check('目录外的路径被拒绝', bad.changed, 0)
  check('错误被逐条返回', bad.errors.length, 1)

  const missing = await setPluginsEnabled(root, ['mods/nope.jar'], false)
  check('不存在的文件计入失败', missing.errors.length, 1)

  await fs.rm(root, { recursive: true, force: true })
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
