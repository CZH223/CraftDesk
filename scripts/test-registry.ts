/**
 * 验证扩展下载源。
 * npx esbuild scripts/test-registry.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-registry.cjs && node tmp/test-registry.cjs
 */
import { searchModrinth, listMcdrPlugins } from '../src/main/registry'

async function main(): Promise<void> {
  console.log('══ Modrinth: fabric 1.21.11 服务端模组（按下载量）══')
  const r = await searchModrinth({
    query: 'optimization',
    projectType: 'mod',
    gameVersion: '1.21.11',
    loader: 'fabric',
    index: 'downloads',
    limit: 5
  })
  console.log(`  命中 ${r.total} 个`)
  for (const h of r.hits) {
    console.log(`  · ${h.title} [${h.categories.slice(0, 3).join(',')}] ${(h.downloads / 1000).toFixed(0)}k`)
    console.log(`    ${h.description.slice(0, 68)}`)
  }

  console.log('\n══ Modrinth: Paper 插件 ══')
  const p = await searchModrinth({
    query: '',
    projectType: 'plugin',
    gameVersion: '1.21.11',
    loader: 'paper',
    index: 'downloads',
    limit: 4
  })
  console.log(`  命中 ${p.total} 个`)
  for (const h of p.hits) console.log(`  · ${h.title} — ${h.description.slice(0, 58)}`)

  console.log('\n══ MCDReforged 插件目录 ══')
  const mcdr = await listMcdrPlugins('tmp/cache', true)
  console.log(`  解析出 ${mcdr.length} 个插件`)
  const stat = {
    有描述: mcdr.filter((x) => x.description).length,
    有仓库: mcdr.filter((x) => x.repository).length,
    有可下载版本: mcdr.filter((x) => x.releases.length).length,
    有依赖: mcdr.filter((x) => x.dependencies.length).length
  }
  console.log('  ' + Object.entries(stat).map(([k, v]) => `${k} ${v}`).join(' / '))

  const top = [...mcdr].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0)).slice(0, 6)
  console.log('  按下载量前 6 个：')
  for (const x of top) {
    console.log(`   · ${x.name} (${x.id}) v${x.version} — ${x.downloads ?? 0} 次`)
    console.log(`     [${x.labels.join('/')}] ${x.description.slice(0, 54)}`)
  }

  const mirror = mcdr.find((x) => x.id === 'mirror_server_reforged')
  if (mirror) {
    console.log(`\n  ${mirror.name} 的可下载版本（共 ${mirror.releases.length} 个）：`)
    for (const rel of mirror.releases.slice(0, 3)) {
      console.log(`     ${rel.fileName}  ${(rel.size / 1024).toFixed(0)} KB  ${rel.downloads} 次`)
      console.log(`       ${rel.url}`)
    }
    console.log(`  依赖: ${mirror.dependencies.map((d) => d.id).join(', ') || '(无)'}`)
  }
}

void main()
