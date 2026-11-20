/**
 * 验证给 Java 安装器用的代理参数。
 *
 * Electron 的网络栈会自动走系统代理，但 Forge / NeoForge / Fabric 的安装器是
 * 独立 Java 进程；不显式传 -Dhttp.proxyHost 一类的参数时，它会直连 Maven，
 * 在需要代理的网络里只报一句 "There was an error during installation"。
 * 这里检查从环境变量解析代理、以及 http / socks / 无代理三种参数生成。
 *
 * npx esbuild scripts/test-net-proxy.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-net-proxy.cjs && node tmp/test-net-proxy.cjs
 */
import { proxyJvmArgs, resolveProxyFor } from '../src/main/netProxy'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

const saved = {
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
  http_proxy: process.env.http_proxy,
  ALL_PROXY: process.env.ALL_PROXY,
  all_proxy: process.env.all_proxy
}
function restore(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
function clearProxyEnv(): void {
  for (const k of Object.keys(saved)) delete process.env[k]
}

async function main(): Promise<void> {
  console.log('\n代理解析')

  clearProxyEnv()
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7897'
  const http = await resolveProxyFor('https://maven.neoforged.net')
  check('HTTPS_PROXY 被识别', http?.type === 'http' && http.host === '127.0.0.1' && http.port === 7897)

  clearProxyEnv()
  process.env.HTTP_PROXY = 'http://10.0.0.2:8080'
  const fallback = await resolveProxyFor('https://maven.neoforged.net')
  check('没有 HTTPS_PROXY 时退回 HTTP_PROXY', fallback?.host === '10.0.0.2' && fallback.port === 8080)

  clearProxyEnv()
  process.env.ALL_PROXY = 'socks5://user:p%40ss@127.0.0.1:1080'
  const socks = await resolveProxyFor('https://maven.neoforged.net')
  check(
    'socks 代理与凭据',
    socks?.type === 'socks' && socks.host === '127.0.0.1' && socks.port === 1080 &&
      socks.user === 'user' && socks.pass === 'p@ss',
    socks ? `${socks.type} ${socks.user}/${socks.pass}` : 'null'
  )

  clearProxyEnv()
  const none = await resolveProxyFor('https://maven.neoforged.net')
  check('没有代理时返回 null', none === null)

  console.log('\nJVM 参数')

  const httpArgs = proxyJvmArgs(http)
  check('http 代理写进 http/https 两组属性', httpArgs.includes('-Dhttp.proxyHost=127.0.0.1') &&
    httpArgs.includes('-Dhttps.proxyHost=127.0.0.1') &&
    httpArgs.includes('-Dhttp.proxyPort=7897') && httpArgs.includes('-Dhttps.proxyPort=7897'))
  check('启用系统代理并排除本机', httpArgs.includes('-Djava.net.useSystemProxies=true') &&
    httpArgs.some((a) => a.startsWith('-Dhttp.nonProxyHosts=')))

  const socksArgs = proxyJvmArgs(socks)
  check('socks 用 socksProxyHost/Port', socksArgs.includes('-DsocksProxyHost=127.0.0.1') &&
    socksArgs.includes('-DsocksProxyPort=1080'))
  check('socks 凭据', socksArgs.includes('-Djava.net.socks.username=user') &&
    socksArgs.includes('-Djava.net.socks.password=p@ss'))
  check('socks 不混入 http 代理属性', !socksArgs.some((a) => a.startsWith('-Dhttp.proxyHost=')))

  const noArgs = proxyJvmArgs(null)
  check('无代理时只交给 Java 自己判断', noArgs.length === 2 && noArgs[0] === '-Djava.net.useSystemProxies=true')

  restore()
  console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：通过 ${pass}，失败 ${fail}\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
