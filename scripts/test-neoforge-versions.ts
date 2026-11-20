/**
 * 验证 NeoForge 版本表的离线分组逻辑。
 *
 * 这里最容易错的三件事：
 * - 26.1.0 / 26.1.1 / 26.1.2 都被并成 26.1（用户看不到 26.1.2）；
 * - 1.20.1 的 47.1.x 在旧坐标 net.neoforged:forge 里，根本没被列出来；
 * - 把现代版本的 "-beta" 当成旧坐标，拼出 forge-... 的错误下载地址。
 *
 * npx esbuild scripts/test-neoforge-versions.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-neoforge-versions.cjs && node tmp/test-neoforge-versions.cjs
 */
import {
  mcFromNeoPrefix,
  neoforgeInstaller,
  parseNeoForgeVersions
} from '../src/main/installers'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

console.log('MC 版本 ↔ artifact 前缀')
check('21.1 → 1.21.1', mcFromNeoPrefix('21.1') === '1.21.1')
check('21.0 → 1.21', mcFromNeoPrefix('21.0') === '1.21')
check('20.4 → 1.20.4', mcFromNeoPrefix('20.4') === '1.20.4')
check('47.1 → 1.20.1（旧坐标）', mcFromNeoPrefix('47.1') === '1.20.1')
check('26.3.0 → 26.3', mcFromNeoPrefix('26.3.0') === '26.3')
check('26.1.2 → 26.1.2（保留补丁号）', mcFromNeoPrefix('26.1.2') === '26.1.2')

console.log('\n全量版本分组')
const options = parseNeoForgeVersions(
  [
    '20.2.93',
    '20.2.92',
    '20.4.253',
    '20.4.251',
    '21.1.265',
    '21.1.264',
    '26.1.0.16-beta',
    '26.1.1.15-beta',
    '26.1.2.125',
    '26.1.2.126',
    '26.2.0.93',
    '26.2.0.90',
    '26.3.0.101',
    '26.3.0.100'
  ],
  ['1.20.1-47.1.99', '1.20.1-47.1.106', '1.20.1-47.1.100', '47.1.82']
)
const ids = options.map((o) => o.id)
const byId = new Map(options.map((o) => [o.id, o]))

check('有 1.20.1', ids.includes('1.20.1'))
check(
  '1.20.1 取旧坐标里的最新构建',
  byId.get('1.20.1')?.latestBuild === '1.20.1-47.1.106',
  byId.get('1.20.1')?.latestBuild
)
check('有 26.1.2', ids.includes('26.1.2'), ids.join(','))
check(
  '26.1.2 没有被并进 26.1',
  ids.includes('26.1.2') && ids.includes('26.1')
)
check('26.1.2 取最新正式版', byId.get('26.1.2')?.latestBuild === '26.1.2.126', byId.get('26.1.2')?.latestBuild)
check('26.1.1 只有 beta 时退而用 beta', byId.get('26.1.1')?.latestBuild === '26.1.1.15-beta')
check('26.3.0 映射回 26.3', byId.get('26.3')?.latestBuild === '26.3.0.101')
check('没有重复 MC 版本', new Set(ids).size === ids.length)
check(
  '按 MC 版本从新到旧',
  options[0]?.id === '26.3' && options[options.length - 1]?.id === '1.20.1',
  ids.join(' > ')
)

console.log('\n安装器地址')
const modern = neoforgeInstaller('26.1.2.126')
check('现代版本用 neoforge-...', modern.name === 'neoforge-26.1.2.126-installer.jar', modern.name)
check(
  '现代版本在 neoforge 坐标',
  modern.url === 'https://maven.neoforged.net/releases/net/neoforged/neoforge/26.1.2.126/neoforge-26.1.2.126-installer.jar',
  modern.url
)
const beta = neoforgeInstaller('26.1.1.15-beta')
check('beta 后缀不会被当成旧坐标', beta.name.startsWith('neoforge-'), beta.name)
const legacy = neoforgeInstaller('1.20.1-47.1.106')
check('1.20.1 用 forge-... 文件名', legacy.name === 'forge-1.20.1-47.1.106-installer.jar', legacy.name)
check(
  '1.20.1 在旧坐标 net.neoforged:forge',
  legacy.url ===
    'https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar',
  legacy.url
)
check('旧坐标也带 sha1', legacy.checksumFile?.endsWith('.sha1') === true)

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
