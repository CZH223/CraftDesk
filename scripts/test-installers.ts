/**
 * 验证 Forge / NeoForge 的版本表与安装器地址。
 *
 * 这两家没有「下个 jar 就能跑」的服务端，全靠官方安装器。装之前要能回答：
 * 这个 MC 版本有没有？要装哪个构建号？安装器在哪个地址、校验值对不对？
 * 拼错一个字符的后果是下载 404 或者装出一个跑不起来的目录。
 *
 * npx esbuild scripts/test-installers.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-installers.cjs && node tmp/test-installers.cjs
 */
import {
  fetchSha1,
  findArgsFile,
  findUniversalJar,
  forgeInstaller,
  listForgeVersions,
  listNeoForgeVersions,
  mcFromNeoPrefix,
  neoforgeInstaller
} from '../src/main/installers'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

async function head(url: string): Promise<{ ok: boolean; status: number; size: number }> {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'CraftDesk/1.0' } })
    return { ok: res.ok, status: res.status, size: Number(res.headers.get('content-length') || 0) }
  } catch (err) {
    return { ok: false, status: -1, size: 0 }
  }
}

/**
 * 拿不到校验值时，把原因问出来。
 * 「✗ 没有 sha1」不说明是站点抽风、被墙，还是我们的解析写错了——
 * 这三种情况的处理方式完全不同，所以失败时必须带上现场。
 */
async function whyNoSha1(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CraftDesk/1.0' },
      signal: AbortSignal.timeout(15000)
    })
    const text = (await res.text()).slice(0, 60).replace(/\s+/g, ' ')
    return `HTTP ${res.status}，内容开头：「${text}」`
  } catch (err) {
    return `请求失败：${err instanceof Error ? err.message : String(err)}`
  }
}

async function main(): Promise<void> {
  console.log('══ MC 版本号 ↔ NeoForge 前缀 ══')
  check('21.1 → 1.21.1', mcFromNeoPrefix('21.1') === '1.21.1')
  check('21.0 → 1.21', mcFromNeoPrefix('21.0') === '1.21')
  check('20.4 → 1.20.4', mcFromNeoPrefix('20.4') === '1.20.4')
  // 26.x 之后 MC 自己改成了 26.1 这种版本号，前缀要原样保留
  check('26.3 → 26.3', mcFromNeoPrefix('26.3') === '26.3')

  console.log('\n══ Forge 版本表（files.minecraftforge.net 的 promotions）══')
  const forge = await listForgeVersions()
  check('拉到版本表', forge.length > 20, `${forge.length} 个 MC 版本`)
  const f1201 = forge.find((v) => v.id === '1.20.1')
  check('有 1.20.1', Boolean(f1201), f1201 ? `推荐 ${f1201.latestBuild}` : '')
  check('构建号形如 47.2.0', /^\d+\.\d+\.\d+/.test(f1201?.latestBuild ?? ''), f1201?.latestBuild)
  const f121 = forge.find((v) => v.id === '1.21')
  check('有 1.21（新版本也在表里）', Boolean(f121), f121?.latestBuild)
  check('新版本排前面', (forge[0]?.id ?? '') >= '1.2')

  console.log('\n══ NeoForge 版本表（maven 全量列表 → 按 MC 版本分组）══')
  const neo = await listNeoForgeVersions()
  check('拉到版本表', neo.length > 5, `${neo.length} 个 MC 版本`)
  const n211 = neo.find((v) => v.id === '1.21.1')
  check('有 1.21.1', Boolean(n211), n211 ? `最新 ${n211.latestBuild}（${n211.note}）` : '')
  check(
    '构建号形如 21.1.x',
    /^21\.1\.\d+/.test(n211?.latestBuild ?? ''),
    n211?.latestBuild
  )
  check('默认给的是正式版', !(n211?.latestBuild ?? '').includes('-'))

  console.log('\n══ 安装器地址与校验值 ══')
  const forgeFile = forgeInstaller('1.20.1', f1201!.latestBuild!)
  check(
    'Forge 安装器文件名规范',
    forgeFile.name === `forge-1.20.1-${f1201!.latestBuild}-installer.jar`,
    forgeFile.name
  )
  const forgeHead = await head(forgeFile.url)
  check('Forge 安装器可下载', forgeHead.ok, `HTTP ${forgeHead.status} ${(forgeHead.size / 1048576).toFixed(1)} MB`)
  const forgeSha = await fetchSha1(forgeFile.checksumFile!)
  const forgeShaOk = /^[0-9a-f]{40}$/i.test(forgeSha ?? '')
  check(
    'Forge 安装器有 sha1',
    forgeShaOk,
    forgeShaOk ? forgeSha!.slice(0, 12) : await whyNoSha1(forgeFile.checksumFile!)
  )

  const neoFile = neoforgeInstaller(n211!.latestBuild!)
  check(
    'NeoForge 安装器文件名规范',
    neoFile.name === `neoforge-${n211!.latestBuild}-installer.jar`,
    neoFile.name
  )
  const neoHead = await head(neoFile.url)
  check('NeoForge 安装器可下载', neoHead.ok, `HTTP ${neoHead.status} ${(neoHead.size / 1048576).toFixed(1)} MB`)
  const neoSha = await fetchSha1(neoFile.checksumFile!)
  const neoShaOk = /^[0-9a-f]{40}$/i.test(neoSha ?? '')
  check(
    'NeoForge 安装器有 sha1',
    neoShaOk,
    neoShaOk ? neoSha!.slice(0, 12) : await whyNoSha1(neoFile.checksumFile!)
  )

  console.log('\n══ 装完之后的启动入口查找 ══')
  // 先在一个空目录上验证「找不到就老老实实返回 null」，而不是瞎猜一个路径
  const empty = await findArgsFile(process.cwd())
  check('空目录里不会硬凑一个参数文件出来', empty === null)
  const noJar = await findUniversalJar(process.cwd())
  check('空目录里也不会硬凑一个 jar', noJar === null)

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
