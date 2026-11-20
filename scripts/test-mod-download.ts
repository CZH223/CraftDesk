/**
 * 验证星图「下载 / 一键补齐」用到的选择逻辑。
 *
 * - 最新版本必须按发布时间挑，而不是依赖接口返回顺序；
 * - 没有下载地址的版本要跳过，否则会把空 URL 交给下载器；
 * - 服务器类型到 Modrinth 加载器的映射要和下载页一致，
 *   不然 Forge 服会拿到 Fabric 的 jar。
 *
 * npx esbuild scripts/test-mod-download.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-mod-download.cjs && node tmp/test-mod-download.cjs
 */
import { latestVersion, modrinthLoaderForKind } from '../src/main/registry'
import type { ModrinthVersion } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

function version(patch: Partial<ModrinthVersion>): ModrinthVersion {
  return {
    id: 'v',
    name: '1.0',
    versionNumber: '1.0',
    versionType: 'release',
    gameVersions: ['1.21.1'],
    loaders: ['fabric'],
    publishedAt: '2025-01-01T00:00:00Z',
    downloads: 0,
    fileName: 'mod.jar',
    fileUrl: 'https://example.invalid/mod.jar',
    fileSize: 1,
    requiredDependencies: [],
    ...patch
  }
}

console.log('最新适配版本')
const newest = latestVersion([
  version({ id: 'old', publishedAt: '2024-01-01T00:00:00Z' }),
  version({ id: 'new', publishedAt: '2025-06-01T00:00:00Z' }),
  version({ id: 'middle', publishedAt: '2024-09-01T00:00:00Z' })
])
check('按发布时间取最新', newest?.id === 'new', newest?.id ?? 'null')

const skipEmpty = latestVersion([
  version({ id: 'no-file', publishedAt: '2025-09-01T00:00:00Z', fileUrl: '' }),
  version({ id: 'no-name', publishedAt: '2025-08-01T00:00:00Z', fileName: '' }),
  version({ id: 'usable', publishedAt: '2024-01-01T00:00:00Z' })
])
check('跳过没有下载地址 / 文件名的版本', skipEmpty?.id === 'usable', skipEmpty?.id ?? 'null')
check('空列表返回 null', latestVersion([]) === null)
check('输入数组不被改动', (() => {
  const list = [
    version({ id: 'a', publishedAt: '2024-01-01T00:00:00Z' }),
    version({ id: 'b', publishedAt: '2025-01-01T00:00:00Z' })
  ]
  latestVersion(list)
  return list[0].id === 'a'
})())

console.log('\n加载器映射')
const cases: [string, string][] = [
  ['fabric', 'fabric'],
  ['forge', 'forge'],
  ['neoforge', 'neoforge'],
  ['paper', 'paper'],
  ['purpur', 'paper'],
  ['velocity', 'velocity'],
  ['bungeecord', 'bungeecord'],
  ['vanilla', ''],
  ['unknown', '']
]
for (const [kind, loader] of cases) {
  check(`${kind} → ${loader || '（不过滤）'}`, modrinthLoaderForKind(kind) === loader)
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
