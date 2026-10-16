/**
 * 验证便携版的数据目录选择。
 *
 * 这段逻辑错一次，用户的配置就会跑到意料之外的地方（或者干脆起不来），
 * 而且很难在自己机器上发现 —— 开发机上 exe 旁边永远是可写的。
 * 所以「能不能写」这个判断要单独测：包括「候选目录是个文件中间的路径」
 * 这种在别人机器上才出现的怪情况。
 *
 * npx esbuild scripts/test-portable.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-portable.cjs && node tmp/test-portable.cjs
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { canWrite, dataDirNextTo, pickDataDir } from '../src/main/portable'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

const ROOT = resolve('.')
const TMP = join(ROOT, 'tmp', 'portable-test')
const FALLBACK = join(TMP, 'appdata', 'CraftDesk')

async function main(): Promise<void> {
  await fs.rm(TMP, { recursive: true, force: true })
  await fs.mkdir(TMP, { recursive: true })

  console.log('能不能写：')
  check('不存在的目录会被建出来', canWrite(join(TMP, 'fresh')))
  check('建完真的能写进去', await fs.stat(join(TMP, 'fresh')).then((s) => s.isDirectory()))
  check(
    '探针文件不会留下',
    (await fs.readdir(join(TMP, 'fresh'))).length === 0,
    (await fs.readdir(join(TMP, 'fresh'))).join(',') || '干净'
  )
  // 路径中间是个文件：mkdir 会失败，必须判断成「不能写」而不是抛出去
  await fs.writeFile(join(TMP, 'afile'), 'x')
  check('路径被文件挡住时返回 false', canWrite(join(TMP, 'afile', 'data')) === false)
  check('空路径返回 false', canWrite('') === false)

  console.log('\n挑目录（注入判断，不碰真实权限）：')
  const always = (): boolean => true
  const never = (): boolean => false

  const first = pickDataDir([join(TMP, 'a'), join(TMP, 'b')], FALLBACK, always)
  check('第一个能写就用第一个', first.dir === join(TMP, 'a') && first.portable)
  check('便携模式给了一句说明', first.reason.length > 0)

  const skipped = pickDataDir([null, undefined, '', join(TMP, 'b')], FALLBACK, always)
  check('空候选会被跳过', skipped.dir === join(TMP, 'b'))

  const onlyB = pickDataDir([join(TMP, 'a'), join(TMP, 'b')], FALLBACK, (d) =>
    d.startsWith(join(TMP, 'b'))
  )
  check('第一个不能写就用后面的', onlyB.dir === join(TMP, 'b'))

  const none = pickDataDir([join(TMP, 'a'), join(TMP, 'b')], FALLBACK, never)
  check('都不能写就退回系统目录', none.dir === FALLBACK && none.portable === false)
  check('退回时也说明了原因', none.reason.includes('不可写'), none.reason)

  const same = pickDataDir([FALLBACK, join(TMP, 'a')], FALLBACK, always)
  check('候选和系统目录相同时不重复添加', same.dir === join(TMP, 'a'))

  const dup = pickDataDir([join(TMP, 'a'), join(TMP, 'a')], FALLBACK, always)
  check('重复候选不会出问题', dup.dir === join(TMP, 'a'))

  const empty = pickDataDir([], FALLBACK, always)
  check('一个候选都没有时用系统目录', empty.dir === FALLBACK)

  console.log('\nexe 旁边的 data 目录：')
  check(
    '按 exe 所在目录算',
    dataDirNextTo('C:\\games\\CraftDesk\\CraftDesk.exe') === 'C:\\games\\CraftDesk\\data'
  )
  check(
    '深一层目录也对',
    dataDirNextTo('D:\\a\\b\\c\\CraftDesk.exe') === 'D:\\a\\b\\c\\data'
  )
  // 相对路径（理论上不会出现，但不能在这里崩）
  check('相对路径不抛错', dataDirNextTo('CraftDesk.exe') === 'data', dataDirNextTo('CraftDesk.exe'))

  console.log('\n真实写盘一遍：')
  const real = pickDataDir([join(TMP, 'portable', 'data')], FALLBACK)
  check('真实环境下会选 exe 旁边的 data', real.dir === join(TMP, 'portable', 'data'), real.dir)
  check('目录真的建出来了', await fs.stat(real.dir).then((s) => s.isDirectory()))
  check('里面没有留下探针文件', (await fs.readdir(real.dir)).length === 0)

  await fs.rm(TMP, { recursive: true, force: true })

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
