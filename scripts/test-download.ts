/**
 * 验证下载器：字节数、校验和，以及「坏文件必须被拦下」。
 *
 * 这个测试是冲着一个真实的 bug 写的：进度监听原来挂在源流上，抢在 pipeline
 * 接上写入端之前就把几 KB 数据流掉了 —— 文件少一点点，进度却显示 100%。
 * Paper 的 jar 少 4 KB 就是「Invalid or corrupt jarfile」，
 * 表现是新建的服务器怎么都起不来。
 *
 * npx esbuild scripts/test-download.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-download.cjs && node tmp/test-download.cjs
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { downloadFile, resolveDownloadUrl } from '../src/main/downloader'
import { ZipReader } from '../src/main/zip'

/** 负例拿个小文件试，省得为了报错再拖一遍 60 MB */
const SMALL = 'https://meta.fabricmc.net/v2/versions/game'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  const out = join(process.cwd(), 'tmp', 'dl-test')
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(out, { recursive: true })

  console.log('══ 解析 Paper 下载地址（v2 已 sunset，应落到 v3）══')
  const info = await resolveDownloadUrl('paper', '26.2')
  console.log(`  ${info.name}`)
  console.log(`  ${info.url}`)
  console.log(`  期望 ${info.size} 字节，${info.checksum?.algo} ${info.checksum?.value}`)
  check('拿到了文件大小', typeof info.size, 'number')
  check('拿到了 sha256', info.checksum?.algo, 'sha256')

  console.log('\n══ 下载并核对 ══')
  const dest = join(out, info.name)
  let lastPercent = -1
  let calls = 0
  const t0 = Date.now()
  await downloadFile(
    info.url,
    dest,
    (received, total) => {
      calls++
      lastPercent = total ? Math.round((received / total) * 100) : 0
    },
    { size: info.size, checksum: info.checksum }
  )

  const st = await fs.stat(dest)
  const hash = createHash('sha256')
  hash.update(await fs.readFile(dest))
  const got = hash.digest('hex')

  console.log(
    `  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，进度回调 ${calls} 次，最后一次 ${lastPercent}%`
  )
  check('大小与接口一致', st.size, info.size)
  check('sha256 与接口一致', got, info.checksum!.value)

  console.log('\n══ 校验失败：删文件 + 报错 ══')
  const bad = join(out, 'bad.txt')
  const threw = await capture(() =>
    downloadFile(SMALL, bad, undefined, { checksum: { algo: 'sha256', value: 'deadbeef'.repeat(8) } })
  )
  check('报的是校验失败', threw.includes('校验失败'), true)
  check('坏文件没有留在磁盘上', await exists(bad), false)

  console.log('\n══ 大小不符：同样拦下 ══')
  const short = join(out, 'short.txt')
  const threw2 = await capture(() => downloadFile(SMALL, short, undefined, { size: 999999 }))
  check('报的是下载不完整', threw2.includes('下载不完整'), true)
  check('文件被删掉', await exists(short), false)

  console.log('\n══ 下下来的 jar 是不是真的能用 ══')
  // 用主进程自己那个 zip 读取器（读模组元数据用的是同一个），
  // 顺便证明它对这种 60 MB 的包也没问题
  const zip = await ZipReader.open(dest)
  check('能打开这个 jar', Boolean(zip), true)
  if (zip) {
    const entries = zip.list()
    console.log(`  jar 里有 ${entries.length} 个条目`)
    check('条目数正常', entries.length > 100, true)

    const mf = (await zip.read('META-INF/MANIFEST.MF')) ?? ''
    const main = mf.match(/^Main-Class:\s*(.+)$/m)?.[1]?.trim() ?? ''
    console.log(`  Main-Class: ${main || '(没有)'}`)
    check('有 Main-Class（java -jar 才跑得起来）', main.length > 0, true)

    const bad2 = await capture(() =>
      downloadFile(SMALL, join(out, 'x.txt'), undefined, { checksum: { algo: 'md5', value: '0'.repeat(32) } })
    )
    check('md5 分支也接得上', bad2.includes('校验失败'), true)
    await zip.close()
  }

  await fs.rm(out, { recursive: true, force: true })
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false)
}

async function capture(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '(没有报错)'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

void main()
