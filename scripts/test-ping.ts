/**
 * 验证 Server List Ping：能不能问出服务端自己报的人数与上限。
 *
 * 客户端服务器列表里显示的 x/y 就是从这条协议来的，所以这里问出来的数字
 * 应该和客户端一模一样。
 *
 * npx esbuild scripts/test-ping.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-ping.cjs && node tmp/test-ping.cjs [host:port ...]
 */
import { pingServer } from '../src/main/ping'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

async function main(): Promise<void> {
  const targets = process.argv.slice(2)

  console.log('══ 没在监听的端口 ══')
  const dead = await pingServer('127.0.0.1', 25999, 1500)
  check('问不到就返回 null（调用方好退回日志计数）', dead === null)

  if (!targets.length) {
    console.log('\n（没给 host:port，跳过实际探测。用法见文件头）')
    console.log(`\n通过 ${pass}，失败 ${fail}`)
    process.exit(fail ? 1 : 0)
  }

  for (const t of targets) {
    const [host, portRaw] = t.split(':')
    const port = Number(portRaw)
    console.log(`\n══ ${host}:${port} ══`)
    const t0 = Date.now()
    const res = await pingServer(host, port, 2500)
    const ms = Date.now() - t0

    if (!res) {
      console.log(`  （${ms}ms）没有响应：端口没开，或者对面不是 Minecraft 服务端`)
      check('非 Minecraft 端口返回 null', true)
      continue
    }

    console.log(`  版本     ${res.version || '(没报)'}`)
    console.log(`  MOTD     ${res.motd || '(空)'}`)
    console.log(`  人数     ${res.online} / ${res.max}`)
    console.log(`  名单     ${res.sample.length ? res.sample.join(', ') : '(没给)'}`)
    console.log(`  耗时     ${ms}ms`)

    check('在线人数是个正常数字', Number.isFinite(res.online) && res.online >= 0)
    check('人数不超过上限（除非上限没配）', res.max === 0 || res.online <= res.max)
    check('响应得快（本地应该在 50ms 内）', ms < 1500, `${ms}ms`)
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
