/**
 * 重新下载某个服务器的服务端核心，并核对官方给的大小与校验和。
 *
 * 用途是修「下载中途断掉、留下一个打不开的 jar」这种情况：
 * 新建服务器时下载器已经会自己核对，这个是给已经坏在磁盘上的文件兜底。
 *
 * npx esbuild scripts/repair-jar.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/repair-jar.cjs && node tmp/repair-jar.cjs <服务器目录> <paper|vanilla|purpur|fabric> <MC版本>
 */
import { resolveDownloadUrl, downloadFile } from '../src/main/downloader'
import { ZipReader } from '../src/main/zip'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ServerKind } from '../src/shared/types'

async function main(): Promise<void> {
  const [dir, kindArg, mcVersion] = process.argv.slice(2)
  if (!dir || !kindArg || !mcVersion) {
    console.error('用法: node repair-jar.cjs <服务器目录> <paper|vanilla|purpur|fabric> <MC版本>')
    process.exit(1)
  }
  const kind = kindArg as ServerKind

  const info = await resolveDownloadUrl(kind, mcVersion)
  console.log(`服务器目录 ${dir}`)
  console.log(`重新下载   ${info.name}`)
  console.log(`官方数据   ${info.size ?? '?'} 字节  ${info.checksum ? `${info.checksum.algo} ${info.checksum.value}` : '(无校验和)'}`)

  const dest = join(dir, info.name)
  const before = await fs.stat(dest).then((s) => s.size, () => 0)
  if (before) console.log(`覆盖旧文件 ${before} 字节（${before === info.size ? '大小对得上，但内容未必对' : '大小就不对，确实坏了'}）`)

  let last = -20
  await downloadFile(
    info.url,
    dest,
    (received, total) => {
      const p = total ? Math.round((received / total) * 100) : 0
      if (p >= last + 20) {
        last = p
        console.log(`  ${p}%  ${(received / 1048576).toFixed(1)} MB`)
      }
    },
    { size: info.size, checksum: info.checksum }
  )

  const after = await fs.stat(dest)
  console.log(`完成       ${after.size} 字节，校验通过`)

  const zip = await ZipReader.open(dest)
  if (zip) {
    console.log(`打包结构   ${zip.list().length} 个条目，能正常打开`)
    const mf = await zip.read('META-INF/MANIFEST.MF')
    const main = (mf ?? '').match(/^Main-Class:\s*(.+)$/m)?.[1]?.trim()
    if (main) console.log(`Main-Class ${main}`)
    const vj = await zip.read('version.json')
    if (vj) {
      try {
        const j = JSON.parse(vj) as { id?: string; javaVersion?: { majorVersion?: number } }
        console.log(`版本信息   id=${j.id ?? '?'} 需要 Java ${j.javaVersion?.majorVersion ?? '?'}`)
      } catch {
        /* 解析不了就算了 */
      }
    }
    await zip.close()
  }
}

void main()
