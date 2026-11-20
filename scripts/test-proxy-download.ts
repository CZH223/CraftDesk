/**
 * 代理端下载源（联网）。
 *
 * Waterfall / BungeeCord 暂时关闭下载与识别，只保留 Velocity：
 * - Velocity 仍然走 PaperMC 的 fill v3；
 * - 另外验证 Waterfall / BungeeCord 的版本表与下载入口确实被拒绝。
 *
 * npx esbuild scripts/test-proxy-download.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-proxy-download.cjs && node tmp/test-proxy-download.cjs
 */
import {
  flattenPaperVersions,
  listVersions,
  listVelocityVersions,
  resolveDownloadUrl
} from '../src/main/downloader'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

async function main(): Promise<void> {
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

  console.log('\nWaterfall / BungeeCord 已关闭：')
  check('Waterfall 版本表被拒绝', await rejects(() => listVersions('waterfall')))
  check('BungeeCord 版本表被拒绝', await rejects(() => listVersions('bungeecord')))
  check(
    'Waterfall 下载地址被拒绝',
    await rejects(() => resolveDownloadUrl('waterfall', '1.20'))
  )
  check(
    'BungeeCord 下载地址被拒绝',
    await rejects(() => resolveDownloadUrl('bungeecord', 'latest'))
  )

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
