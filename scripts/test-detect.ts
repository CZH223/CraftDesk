/**
 * 手动验证服务端目录识别逻辑。
 * 用法：npx esbuild scripts/test-detect.ts --bundle --platform=node --format=cjs \
 *        --outfile=tmp/test-detect.cjs && node tmp/test-detect.cjs <目录> [<目录> ...]
 */
import { detectServer } from '../src/main/importer'

async function main(): Promise<void> {
  const dirs = process.argv.slice(2)
  if (!dirs.length) {
    console.error('用法: node test-detect.cjs <服务端目录> [...]')
    process.exit(1)
  }

  for (const dir of dirs) {
    const t0 = Date.now()
    const d = await detectServer(dir)
    const ms = Date.now() - t0
    console.log('─'.repeat(72))
    console.log(`目录        ${d.dir}`)
    console.log(`名称        ${d.name}`)
    console.log(`类型        ${d.kind}`)
    console.log(`版本        ${d.mcVersion || '(未识别)'}`)
    console.log(`核心子目录  ${d.coreDir || '(就在根目录)'}`)
    console.log(`推荐核心    ${d.suggestedJar || '(无)'}`)
    console.log(`推荐脚本    ${d.suggestedScript || '(无)'}${d.preferScript ? '  ← 优先用脚本' : ''}`)
    console.log(`jar 列表    ${d.jars.join(', ') || '(无)'}`)
    console.log(`脚本列表    ${d.scripts.join(', ') || '(无)'}`)
    console.log(`EULA        ${d.eulaAccepted ? '已同意' : '未同意'}`)
    console.log(`已有世界    ${d.hasWorld ? '是' : '否'}`)
    console.log(`端口        ${d.port ?? '(未知)'}`)
    console.log(`MOTD        ${d.motd ?? '(未知)'}`)
    console.log(`体积        ${(d.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB`)
    console.log(`耗时        ${ms} ms`)
  }
}

void main()
