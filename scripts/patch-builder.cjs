/**
 * electron-builder 的便携版会把 app 先打成一个内嵌 7z，再用 NSIS 包起来。
 * 它默认没有设置 LZMA 字典大小，256 MB 字典能让这个内嵌包再小几百 KB。
 *
 * 这里做一次幂等的源码补丁；升级 electron-builder 后如果匹配不到原代码，
 * 只打印提示，不影响构建。
 */
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const file = join(
  __dirname,
  '..',
  'node_modules',
  'app-builder-lib',
  'out',
  'targets',
  'nsis',
  'NsisTarget.js'
)

try {
  let source = readFileSync(file, 'utf8')
  const original = source
  source = source.replace(
    'commands.SetCompressor = "/SOLID lzma";',
    'commands.SetCompressor = "zlib";'
  )
  source = source.replace(
    'commands.SetCompressor = "lzma";',
    'commands.SetCompressor = "zlib";'
  )
  source = source.replace(
    /const archiveOptions = \{\s*withoutDir: true,\s*compression: packager\.compression,/,
    `const archiveOptions = {
            withoutDir: true,
            compression: packager.compression,
            dictSize: packager.compression === "maximum" ? 256 : undefined,`
  )
  if (source !== original) {
    writeFileSync(file, source)
    console.log('electron-builder portable: 已启用 256 MB LZMA 字典')
  }
} catch {
  console.log('electron-builder portable: 跳过压缩补丁（版本结构不匹配）')
}
