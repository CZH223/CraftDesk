/**
 * 验证「下载源图标」的抓取。
 *
 * 背景：页面 CSP 是 `img-src 'self' data:`，渲染进程直接 `<img src="https://…">`
 * 会被拦掉，界面上表现成一排破图 —— 用户看到的是「图标加载不出来」，
 * 而浏览器其实连请求都没发。所以图标统一由主进程抓成 data URL。
 *
 * 这里既验地址白名单（离线可跑的那几条），也真去 Modrinth 的 CDN 抓一张回来。
 *
 * npx esbuild scripts/test-remote-icon.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-remote-icon.cjs && node tmp/test-remote-icon.cjs
 */
import { assertRemoteImageUrl, fetchImageDataUrl } from '../src/main/images'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

function throws(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/** 一张真实存在的模组图标（Modrinth 的 CDN） */
const ICON = 'https://cdn.modrinth.com/data/9s6osm5g/ed8a2316cbb6f4fc5f510e8e13a59a85cbbbff4d_96.webp'

async function main(): Promise<void> {
  console.log('地址白名单（不联网就能判）：')
  check('https 放行', assertRemoteImageUrl(ICON).host === 'cdn.modrinth.com')
  check('http 拒绝', (throws(() => assertRemoteImageUrl('http://x.com/a.png')) ?? '').includes('只允许 https'))
  check(
    'file:// 拒绝（配置文件里能写任何东西）',
    (throws(() => assertRemoteImageUrl('file:///C:/Windows/System32/config/SAM')) ?? '').includes('https')
  )
  check('data: 拒绝', (throws(() => assertRemoteImageUrl('data:image/png;base64,AAA')) ?? '').includes('https'))
  check('javascript: 拒绝', throws(() => assertRemoteImageUrl('javascript:alert(1)')) !== null)
  check('不是地址的字符串拒绝', (throws(() => assertRemoteImageUrl('随便写的')) ?? '').includes('不合法'))
  check('空串拒绝', throws(() => assertRemoteImageUrl('')) !== null)

  console.log('\n抓一张真图标：')
  const first = await fetchImageDataUrl(ICON)
  check('拿到了 data URL', first.dataUrl.startsWith('data:image/'), first.dataUrl.slice(0, 24))
  check('是 webp', first.dataUrl.startsWith('data:image/webp;base64,'))
  check('大小合理', first.bytes > 1000 && first.bytes < 512 * 1024, `${first.bytes} 字节`)
  check('第一次是现抓的', first.cached === false)

  const second = await fetchImageDataUrl(ICON)
  check('第二次走缓存', second.cached === true)
  check('缓存内容一致', second.dataUrl === first.dataUrl && second.bytes === first.bytes)

  const started = Date.now()
  await fetchImageDataUrl(ICON)
  check('缓存命中很快（不重新下载）', Date.now() - started < 50, `${Date.now() - started}ms`)

  console.log('\n抓不下来的情况：')
  const notImage = await fetchImageDataUrl('https://api.modrinth.com/v2/search?limit=1').catch(
    (err: Error) => err.message
  )
  check('返回 JSON 的地址被拒（不是图片）', String(notImage).includes('不是图片'), String(notImage).slice(0, 60))

  const missing = await fetchImageDataUrl('https://cdn.modrinth.com/data/aaaaaaaa/does-not-exist.png').catch(
    (err: Error) => err.message
  )
  check('404 给的是 HTTP 状态', String(missing).includes('HTTP 4'), String(missing).slice(0, 60))

  const dead = await fetchImageDataUrl('https://this-host-does-not-exist-12345.invalid/a.png').catch(
    (err: Error) => err.message
  )
  check('域名不存在时不会挂住', String(dead).includes('图片下载失败'), String(dead).slice(0, 60))

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main().catch((err) => {
  console.error(`出错了：${String(err?.message ?? err)}`)
  if (/UND_ERR|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(String(err))) {
    console.error('（看起来是网络不通，不是代码问题）')
  }
  process.exit(1)
})
