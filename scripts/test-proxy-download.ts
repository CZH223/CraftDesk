/**
 * 代理端下载源（联网）。
 *
 * 三家的来源都不一样，而且都踩过坑：
 * - Paper 的 v2 接口已经 sunset（返回 `{"ok":false,"error":"sunset"}`），
 *   Velocity / Waterfall 只能走 fill v3，构建里还混着一堆 `module:*` 的碎片；
 * - BungeeCord 没有版本号，只有构建号，地址在官方 Jenkins 上；
 * - 「能列出列表」和「能下下来」是两件事，所以最后真的下一个回来验一验。
 *
 * npx esbuild scripts/test-proxy-download.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-proxy-download.cjs && node tmp/test-proxy-download.cjs
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  downloadFile,
  flattenPaperVersions,
  listBungeeVersions,
  listVelocityVersions,
  listWaterfallVersions,
  resolveDownloadUrl
} from '../src/main/downloader'
import { ZipReader } from '../src/main/zip'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

const TMP = join(resolve('.'), 'tmp', 'proxy-download')

async function main(): Promise<void> {
  await fs.rm(TMP, { recursive: true, force: true })
  await fs.mkdir(TMP, { recursive: true })

  console.log('版本表排序（纯函数）：')
  const flat = flattenPaperVersions({
    '4.0.0': ['4.2.1-SNAPSHOT', '4.2.0', '4.1.1-SNAPSHOT'],
    '3.0.0': ['3.5.1', '3.5.0-SNAPSHOT']
  })
  check('正式版排在快照前面', flat[0].id === '4.2.0' && flat[1].id === '3.5.1', flat.map((v) => v.id).join(','))
  check('快照一个不丢', flat.filter((v) => v.id.includes('SNAPSHOT')).length === 3)
  check('空对象不炸', flattenPaperVersions({}).length === 0)

  console.log('\nVelocity（PaperMC 的 fill v3）：')
  const vel = await listVelocityVersions()
  check('拿到了版本列表', vel.length > 0, `${vel.length} 个`)
  check('第一条是正式版', !/SNAPSHOT|pre|rc|beta/i.test(vel[0].id), vel[0].id)
  const velStable = vel.find((v) => v.id === '3.4.0') ?? vel.find((v) => !v.id.includes('SNAPSHOT'))!
  const velUrl = await resolveDownloadUrl('velocity', velStable.id)
  check('解析出下载地址', /^https:\/\/fill-data\.papermc\.io\/v1\/objects\//.test(velUrl.url), velUrl.url.slice(0, 60))
  check('文件名带版本号', velUrl.name.includes(velStable.id), velUrl.name)
  check('是 velocity- 开头的 jar', /^velocity-.*\.jar$/.test(velUrl.name))
  check('带了 sha256', velUrl.checksum?.algo === 'sha256' && (velUrl.checksum?.value.length ?? 0) === 64)
  check('给了文件大小', (velUrl.size ?? 0) > 5 * 1024 * 1024, `${Math.round((velUrl.size ?? 0) / 1024 / 1024)} MB`)

  console.log('\nWaterfall：')
  const wf = await listWaterfallVersions()
  check('拿到了版本列表', wf.length > 0, wf.map((v) => v.id).slice(0, 5).join(','))
  const wfUrl = await resolveDownloadUrl('waterfall', wf[0].id)
  check('解析出下载地址', wfUrl.url.includes('waterfall'), wfUrl.name)
  check(
    '拿的是 server:default 而不是某个 module（碎片只有几 KB）',
    (wfUrl.size ?? 0) > 5 * 1024 * 1024,
    `${Math.round((wfUrl.size ?? 0) / 1024 / 1024)} MB`
  )

  console.log('\nBungeeCord（官方 Jenkins）：')
  const bc = await listBungeeVersions()
  check('拿到了构建号', bc.length > 0 && /^\d+$/.test(bc[0].id), bc.slice(0, 3).map((v) => v.id).join(','))
  check(
    '按构建号从新到旧',
    bc.length < 2 || Number(bc[0].id) > Number(bc[bc.length - 1].id),
    `${bc[0].id} → ${bc[bc.length - 1].id}`
  )
  const bcUrl = await resolveDownloadUrl('bungeecord', bc[0].id)
  check('地址指向官方 Jenkins', bcUrl.url.startsWith('https://ci.md-5.net/'), bcUrl.url)
  check('产物名是 BungeeCord.jar', bcUrl.name === 'BungeeCord.jar')
  check('带了备选地址', (bcUrl.fallbacks?.length ?? 0) > 0, bcUrl.fallbacks?.[0] ?? '')
  const latest = await resolveDownloadUrl('bungeecord', 'latest')
  check('latest 也能解析', latest.url.includes('lastSuccessfulBuild'))

  console.log('\n真的下一遍 BungeeCord（约 25 MB）：')
  const dest = join(TMP, 'BungeeCord.jar')
  const started = Date.now()
  await downloadFile(bcUrl.url, dest, () => {})
  const st = await fs.stat(dest)
  check('文件下下来了', st.size > 20 * 1024 * 1024, `${Math.round(st.size / 1024 / 1024)} MB`)
  check('耗时正常', Date.now() - started < 5 * 60 * 1000, `${((Date.now() - started) / 1000).toFixed(1)}s`)

  const zip = await ZipReader.open(dest)
  check('是一个能打开的 jar', zip !== null)
  const names = zip?.list() ?? []
  check('里面有 BungeeCord 的主类', names.includes('net/md_5/bungee/BungeeCord.class'))
  check('里面有 bootstrap 的启动类', names.includes('net/md_5/bungee/Bootstrap.class'))
  await zip?.close()

  await fs.rm(TMP, { recursive: true, force: true })
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main().catch((err) => {
  console.error(`出错了：${String(err?.message ?? err)}`)
  if (/UND_ERR|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|HTTP 5/i.test(String(err))) {
    console.error('（看起来是网络不通，不是代码问题）')
  }
  process.exit(1)
})
