/**
 * 验证启动脚本生成器。
 *
 * 重点不是「能不能拼出一行命令」，而是两个容易翻车的地方：
 * - 内容必须是纯 ASCII。Windows 的 cmd 按当前代码页解析 .bat，
 *   中文注释在 GBK / UTF-8 之间倒腾一下就会变成乱码把命令吃掉。
 * - 带空格的路径必须加引号，否则 java 会把 `C:\Program` 当成可执行文件。
 *
 * npx esbuild scripts/test-startscript.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-startscript.cjs && node tmp/test-startscript.cjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { buildStartScript, writeStartScript } from '../src/main/startscript'
import type { ServerConfig } from '../src/shared/types'
import type { ServerLayout } from '../src/main/layout'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`)
}

function cfgOf(partial: Partial<ServerConfig>): ServerConfig {
  return {
    id: 't',
    name: '测试服',
    dir: 'M:\\Minecraft\\Server\\测试',
    jar: 'paper-26.2-129.jar',
    startScript: '',
    javaPath: 'C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe',
    memoryMin: 1024,
    memoryMax: 4096,
    jvmArgs: '-XX:+UseG1GC',
    serverArgs: 'nogui',
    kind: 'paper',
    mcVersion: '26.2',
    coreDir: '',
    mcdr: false,
    autoGenerateStartScript: undefined,
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
    ...partial
  } as ServerConfig
}

function layoutOf(partial: Partial<ServerLayout>): ServerLayout {
  return {
    root: 'M:\\Minecraft\\Server\\测试',
    core: 'M:\\Minecraft\\Server\\测试',
    coreRel: '',
    isMcdr: false,
    mcdrStartCommand: null,
    mcdrPluginsDir: null,
    mcdrConfigDir: null,
    mcdrConfigFile: null,
    mcPluginsDir: null,
    modsDir: null,
    configDir: null,
    serverProperties: 'M:\\Minecraft\\Server\\测试\\server.properties',
    playersDir: 'M:\\Minecraft\\Server\\测试',
    isProxy: false,
    proxyConfigFile: null,
    configuredPort: 25565,
    ...partial
  } as ServerLayout
}

async function main(): Promise<void> {
  const win = process.platform === 'win32'

  console.log('══ 普通服务端 ══')
  const a = buildStartScript(cfgOf({}), layoutOf({}))
  console.log(a.content.split('\n').map((l) => '  │ ' + l).join('\n'))
  check('文件名', a.file, win ? 'start.bat' : 'start.sh')
  check('内存参数', a.content.includes('-Xms1024M') && a.content.includes('-Xmx4096M'), true)
  check('JVM 参数', a.content.includes('-XX:+UseG1GC'), true)
  // 编码参数：Java 默认按系统编码（中文 Windows 上是 GBK）输出，
  // 目录名或日志里有中文就会乱码，MCDR 那边甚至直接抛 UnicodeDecodeError
  check('带上 UTF-8 输出参数', a.content.includes('-Dstdout.encoding=UTF-8'), true)
  check('老版本 Java 也照顾到', a.content.includes('-Dsun.stdout.encoding=UTF-8'), true)
  check('带引号的 java 路径', a.content.includes('"C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe"'), true)
  check('jar 与 nogui', a.content.includes('-jar paper-26.2-129.jar nogui'), true)
  if (win) {
    check('先切到脚本所在目录', a.content.includes('cd /d "%~dp0"'), true)
    check('结束后暂停，双击能看到报错', a.content.includes('pause'), true)
    check('用 CRLF 分行', a.content.includes('\r\n'), true)
  }

  console.log('\n══ 内容必须是纯 ASCII ══')
  // 这条是硬要求：cmd 按代码页解析 .bat，非 ASCII 会变成乱码吃掉命令
  const nonAscii = [...a.content].filter((c) => c.charCodeAt(0) > 127)
  check('没有非 ASCII 字符', nonAscii.length, 0)

  /*
   * 核心在子目录时，脚本里的路径必须按「相对核心目录」写。
   * 脚本先 cd 进 server/，再照着配置里的 server/xxx.jar 去找，
   * 拼出来就是 server/server/xxx.jar —— 看起来像配置写错了，
   * 其实是脚本把前缀带重了。
   */
  console.log('\n══ 核心在子目录（MCDReforged 那类布局）══')
  const b = buildStartScript(
    cfgOf({ jar: 'server/fabric-server-launch.jar' }),
    layoutOf({ coreRel: 'server', core: 'M:\\Minecraft\\Server\\测试\\server' })
  )
  check('先进入核心目录', b.content.includes('cd server'), true)
  check('jar 去掉重复的子目录前缀', b.content.includes('-jar fabric-server-launch.jar'), true)
  check('没有拼成 server/server/…', b.content.includes('server/server/'), false)

  // 核心目录之外的路径（比如 jar 在外层）就得用绝对路径，否则 cd 之后找不到
  const outside = buildStartScript(
    cfgOf({ jar: 'launcher/start.jar' }),
    layoutOf({ coreRel: 'server', core: 'M:\\Minecraft\\Server\\测试\\server' })
  )
  check(
    '核心目录外的 jar 用绝对路径',
    outside.content.includes('M:\\Minecraft\\Server\\测试\\launcher\\start.jar') ||
      outside.content.includes('"M:\\Minecraft\\Server\\测试\\launcher\\start.jar"'),
    true
  )

  // Forge / NeoForge 没有可 -jar 的核心，脚本得跟着换写法
  const forgeScript = buildStartScript(
    cfgOf({
      kind: 'neoforge',
      jar: '',
      launchArgs: 'libraries/net/neoforged/neoforge/21.1.252/win_args.txt'
    }),
    layoutOf()
  )
  check(
    'Forge 用 @参数文件 启动',
    forgeScript.content.includes('@libraries/net/neoforged/neoforge/21.1.252/win_args.txt'),
    true
  )
  check('Forge 不写 -jar', forgeScript.content.includes('-jar'), false)

  // MCDR 托管的服务器要起的是 MCDR 自己，不是服务端核心
  const mcdrScript = buildStartScript(
    cfgOf({ mcdr: true, pythonPath: 'C:\\Python313\\python.exe', jar: 'server/server.jar' }),
    layoutOf({ coreRel: 'server', core: 'M:\\Minecraft\\Server\\测试\\server', isMcdr: true })
  )
  check('MCDR 用 python -m mcdreforged 启动', mcdrScript.content.includes('-m mcdreforged'), true)
  check('MCDR 脚本不再 cd 进核心目录（它自己会切）', mcdrScript.content.includes('cd server'), false)
  check('MCDR 脚本不用 -jar（启动命令在 config.yml 里）', mcdrScript.content.includes('-jar'), false)

  console.log('\n══ 代理端不要 nogui ══')
  const c = buildStartScript(cfgOf({ kind: 'velocity', serverArgs: '', jar: 'velocity.jar' }), layoutOf({ isProxy: true }))
  check('没有 nogui', c.content.includes('nogui'), false)

  console.log('\n══ 真的写到磁盘上 ══')
  const dir = join(process.cwd(), 'tmp', 'script-test')
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  const res = await writeStartScript(cfgOf({ dir }), layoutOf({ root: dir, serverProperties: join(dir, 'server.properties') }))
  check('写到了服务器目录里', res.absPath, join(dir, res.file))
  const onDisk = await fs.readFile(res.absPath)
  check('磁盘上的内容与返回值一致', onDisk.length, Buffer.byteLength(res.content, 'utf-8'))
  check('磁盘上也是纯 ASCII', [...onDisk].every((b) => b < 128), true)
  console.log(`  文件大小 ${onDisk.length} 字节`)

  console.log('\n══ 重新生成会覆盖旧的 ══')
  await fs.writeFile(res.absPath, 'rem 旧内容\n', 'utf-8')
  await writeStartScript(cfgOf({ dir, memoryMax: 8192 }), layoutOf({ root: dir, serverProperties: join(dir, 'server.properties') }))
  const again = await fs.readFile(res.absPath, 'utf-8')
  check('用的是新内存值', again.includes('-Xmx8192M'), true)
  check('旧内容没了', again.includes('旧内容'), false)

  await fs.rm(dir, { recursive: true, force: true })
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
