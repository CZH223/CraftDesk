/**
 * 用 Chrome DevTools Protocol 驱动界面。
 *
 * 为什么要这个：模拟鼠标那套在这台机器上要跟窗口缩放、客户区偏移较劲，
 * 点偏一点就得靠截图猜。走 CDP 直接点 DOM 元素、直接读状态，不猜。
 *
 * 用法（应用要带 --remote-debugging-port=9222 启动）：
 *   node scripts/ui-drive.mjs "eval:<js 表达式>" "shot:tmp/a.png" ...
 * 参数按顺序执行：eval 打印结果，shot 存一张图。
 */
import { writeFile } from 'node:fs/promises'

const PORT = Number(process.env.CDP_PORT || 9222)
const steps = process.argv.slice(2)

if (!steps.length) {
  console.error('用法: node scripts/ui-drive.mjs "eval:<js>" "shot:<file.png>" ...')
  process.exit(1)
}

let nextId = 1
const pending = new Map()

function send(ws, method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} 超时`))
    }, 30000)
  })
}

async function pickPage() {
  // 等窗口就绪：启动后 target 列表要过一会儿才有内容
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page =
        list.find((t) => t.type === 'page' && /index\.html/.test(t.url || '')) ||
        list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`连不上 127.0.0.1:${PORT}，应用是不是没带 --remote-debugging-port 启动？`)
}

async function main() {
  const page = await pickPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true })
  })

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })

  // 表达式按原样交给 Runtime.evaluate，它会返回表达式的值。
  // 多语句就自己写成 (() => { ...; return x })()
  const evaluate = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '执行出错')
    return r.result?.value
  }

  await send(ws, 'Page.enable')
  await send(ws, 'Runtime.enable')

  for (const step of steps) {
    const [kind, ...rest] = step.split(':')
    const arg = rest.join(':')

    if (kind === 'eval') {
      const value = await evaluate(arg)
      console.log(`eval → ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    } else if (kind === 'shot') {
      const r = await send(ws, 'Page.captureScreenshot', { format: 'png' })
      await writeFile(arg, Buffer.from(r.data, 'base64'))
      console.log(`shot → ${arg}`)
    } else if (kind === 'wait') {
      await new Promise((r) => setTimeout(r, Number(arg) || 500))
      console.log(`wait ${arg}ms`)
    } else {
      throw new Error(`不认识的步骤：${step}`)
    }
  }

  ws.close()
}

void main().catch((err) => {
  console.error(String(err.message || err))
  process.exit(1)
})
