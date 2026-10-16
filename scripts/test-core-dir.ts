/**
 * 验证「核心目录」的识别。
 *
 * 这条规则错一次，整台服务器的模组/插件列表就是空的 —— 而且看不出错在哪：
 * 界面只是「什么都没显示」，用户会以为 CraftDesk 不支持整合包。
 * 真实案例：Forge 1.20.1 的整合包服务端（245 个模组）根目录没有 jar，
 * 于是 mods/ 被认成了核心目录，模组列表空空如也。
 *
 * 每个用例都在 tmp 下现造目录，不碰任何真实服务器。
 *
 * npx esbuild scripts/test-core-dir.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-core-dir.cjs && node tmp/test-core-dir.cjs
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { detectServer } from '../src/main/importer'
import { resolveLayout } from '../src/main/layout'
import { listPlugins } from '../src/main/plugins'
import { isContentDirName } from '../src/shared/contentDirs'
import type { ServerConfig } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

const TMP = resolve('tmp', 'core-dir-test')

/** 造文件（顺带建好父目录） */
async function put(rel: string, content = 'x'): Promise<void> {
  const full = join(TMP, rel)
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}

function cfg(patch: Partial<ServerConfig>): ServerConfig {
  return {
    id: 'test',
    name: '测试',
    dir: TMP,
    jar: '',
    startScript: '',
    launchArgs: '',
    pythonPath: '',
    javaPath: '',
    memoryMin: 1024,
    memoryMax: 4096,
    jvmArgs: '',
    serverArgs: 'nogui',
    kind: 'unknown',
    mcVersion: '',
    coreDir: '',
    mcdr: false,
    pluginsDir: '',
    modsDir: '',
    autoRestart: false,
    createdAt: 0,
    lastStartedAt: 0,
    totalUptime: 0,
    color: '',
    icon: '',
    note: '',
    order: 0,
    ...patch
  }
}

async function main(): Promise<void> {
  await fs.rm(TMP, { recursive: true, force: true })
  await fs.mkdir(TMP, { recursive: true })

  console.log('内容目录名单：')
  check('mods / plugins / config / world 都算内容目录', ['mods', 'plugins', 'config', 'world', 'logs'].every(isContentDirName))
  check('大小写不敏感', isContentDirName('MoDs'))
  check('server / 服务端 不算', !isContentDirName('server') && !isContentDirName('服务端'))

  // ---------------------------------------------------------------- 整合包服
  //
  // 真实复刻：Forge 1.20.1 整合包服务端。根目录没有 jar，
  // 245 个模组躺在 mods/ 里，启动入口是 libraries/ 下的参数文件。
  console.log('\nForge 1.17+ 整合包（根目录没有 jar）：')
  await put('server.properties', 'server-port=25565\n')
  await put('eula.txt', 'eula=true\n')
  await put('run.bat', 'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.4.16/win_args.txt\n')
  await put('libraries/net/minecraftforge/forge/1.20.1-47.4.16/win_args.txt', '-p libraries\n')
  await put('mods/ApothicAttributes-1.20.1-1.3.7.jar')
  await put('mods/Bookshelf-Forge-1.20.1-20.2.13.jar')
  await put('mods/CodeChickenLib-1.20.1-4.4.0.516-universal.jar')
  await put('config/some-mod.toml')
  await put('logs/latest.log')

  const pack = await detectServer(TMP)
  check('识别成 forge', pack.kind === 'forge', pack.kind)
  check('版本读出来了', pack.mcVersion === '1.20.1', pack.mcVersion)
  check('核心目录是根目录，不是 mods', pack.coreDir === '', `coreDir=${pack.coreDir || '(根目录)'}`)
  check('找到了启动用的参数文件', pack.suggestedArgs.includes('win_args.txt'), pack.suggestedArgs)

  const packLayout = await resolveLayout(cfg({ kind: 'forge', mcVersion: '1.20.1' }))
  check('布局：core 就是根目录', packLayout.coreRel === '', packLayout.coreRel)
  check(
    '布局：模组目录指向 mods/',
    packLayout.modsDir === join(TMP, 'mods'),
    packLayout.modsDir ?? '(无)'
  )
  check(
    '布局：server.properties 在根目录',
    packLayout.serverProperties === join(TMP, 'server.properties'),
    packLayout.serverProperties
  )
  check('布局：配置目录指向 config/', packLayout.configDir === join(TMP, 'config'))

  // 注意 listPlugins 收的是「布局」，不是配置 —— 两者都叫 server 但不是一个东西
  const mods = await listPlugins(packLayout)
  check('模组列表读到了 3 个（不是 0 个）', mods.length === 3, `${mods.length} 个`)
  check('每个模组都带上了相对路径', mods.every((m) => m.path.startsWith('mods/')), mods[0]?.path ?? '')

  // ---------------------------------------------------------------- 历史遗留配置
  //
  // 以前识别错的服务器，配置里存着 coreDir: 'mods'。这种值一定不对，
  // 布局解析要忽略它 —— 用户不该为了修一个 bug 重新导入一遍服务器。
  console.log('\n配置里存着错的 coreDir（存量数据）：')
  const healed = await resolveLayout(cfg({ kind: 'forge', coreDir: 'mods' }))
  check('错的 coreDir 被忽略，回到根目录', healed.coreRel === '', healed.coreRel)
  check('模组目录仍然正确', healed.modsDir === join(TMP, 'mods'))
  const healedMods = await listPlugins(healed)
  check('模组仍然能列出来', healedMods.length === 3, `${healedMods.length} 个`)

  console.log('\n存着对的 coreDir 时不能乱改：')
  await fs.mkdir(join(TMP, 'server'), { recursive: true })
  await put('server/server.jar')
  await put('server/server.properties', 'server-port=25566\n')
  await put('server/mods/example-1.0.jar')
  const mcdrCfg = cfg({ mcdr: true, coreDir: 'server', kind: 'fabric' })
  const mcdrLayout = await resolveLayout(mcdrCfg)
  check('MCDR 布局：core 仍然是 server/', mcdrLayout.coreRel === 'server', mcdrLayout.coreRel)
  check('MCDR 布局：模组在 server/mods/', mcdrLayout.modsDir === join(TMP, 'server', 'mods'), mcdrLayout.modsDir ?? '(无)')

  // ---------------------------------------------------------------- 只有 mods 的目录
  console.log('\n只有一个塞满 jar 的 mods/（不是服务端）：')
  const onlyMods = join(TMP, 'only-mods')
  await fs.mkdir(join(onlyMods, 'mods'), { recursive: true })
  await fs.writeFile(join(onlyMods, 'mods', 'a-mod-1.0.jar'), 'x')
  await fs.writeFile(join(onlyMods, 'mods', 'another-mod-2.0.jar'), 'x')
  const detected = await detectServer(onlyMods)
  check('不会把 mods 当成核心目录', detected.coreDir === '', `coreDir=${detected.coreDir}`)
  check('也不认成插件目录', detected.coreDir !== 'plugins')

  console.log('\n嵌套一层但确实是核心（要认得出来）：')
  const nested = join(TMP, 'nested')
  await fs.mkdir(join(nested, '服务端'), { recursive: true })
  await fs.writeFile(join(nested, '服务端', 'server.jar'), 'x')
  await fs.writeFile(join(nested, '服务端', 'eula.txt'), 'eula=true')
  const nestedDetected = await detectServer(nested)
  check('中文名子目录照样认', nestedDetected.coreDir === '服务端', nestedDetected.coreDir)
  check('根目录的 jar 优先，不受影响', (await detectServer(join(TMP))).coreDir === '')

  await fs.rm(TMP, { recursive: true, force: true })
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
