/**
 * 验证各个下载源。
 * npx esbuild scripts/test-sources.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-sources.cjs && node tmp/test-sources.cjs
 */
import { searchHangar, hangarVersions, searchSpigot, spigotVersions, searchCurseforge } from '../src/main/sources'

async function main(): Promise<void> {
  console.log('══ Hangar（Paper 插件站）══')
  const h = await searchHangar(
    { query: 'viaversion', kind: 'plugin', gameVersion: '1.21.11', limit: 4 },
    'PAPER'
  )
  console.log(`  命中 ${h.total}`)
  for (const x of h.hits) {
    console.log(`  · ${x.name} — ${x.description.slice(0, 52)}`)
    console.log(`    ${x.pageUrl}`)
  }
  if (h.hits[0]) {
    const vs = await hangarVersions(h.hits[0].id, 'PAPER', '1.21.11')
    console.log(`  ${h.hits[0].name} 的可用版本 ${vs.length} 个：`)
    for (const v of vs.slice(0, 2)) {
      console.log(`    ${v.name} (${v.channel}) → ${v.fileName}  ${(v.fileSize / 1024 / 1024).toFixed(1)} MB`)
      console.log(`      ${v.fileUrl}`)
    }
  }

  console.log('\n══ SpigotMC（走 Spiget）══')
  const s = await searchSpigot({ query: 'worldedit', kind: 'plugin', limit: 4 })
  for (const x of s.hits) {
    console.log(`  · ${x.name} [${x.extra.join(',')}] installable=${x.installable}`)
    if (x.blockedReason) console.log(`    ⚠ ${x.blockedReason.slice(0, 50)}`)
  }
  const sv = await spigotVersions('9089')
  console.log(`  EssentialsX 最新版: ${sv[0]?.name} → ${sv[0]?.fileUrl}`)

  console.log('\n══ CurseForge（无 key）══')
  try {
    await searchCurseforge({ query: 'jei', kind: 'mod', limit: 2 })
    console.log('  意外成功了')
  } catch (e) {
    console.log(`  按预期被拒: ${String(e).slice(0, 60)}`)
  }
}
void main()
