/**
 * 危险操作的端到端验证：界面 → IPC → 磁盘。
 *
 * 删除和「生成启动脚本」是这套东西里最不能靠「看一眼觉得对」的部分，
 * 所以走真正的界面：用 CDP 点 DOM、真的打名字、真的确认，然后在 node 这边
 * 检查文件系统。全程跑在 tmp/uitest 里的假服务器和独立 profile 上，
 * 不碰用户自己的任何目录和正在用的那个实例。
 *
 * 自带 fixture 和实例的启动/清理，直接跑就行：
 *   node scripts/test-delete-ui.mjs
 */
import { promises as fs } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const PORT = 9223
const ROOT = process.cwd()
const BASE = join(ROOT, 'tmp', 'uitest')
const SERVER = join(BASE, 'server')
const PROFILE = join(BASE, 'profile')

let pass = 0
let fail = 0
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`)
}

async function exists(p) {
  return fs.access(p).then(() => true, () => false)
}

let nextId = 1
const pending = new Map()
let ws

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} 超时`))
    }, 30000)
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '执行出错')
  return r.result?.value
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 截图走 PowerShell 的 PrintWindow，不用 CDP 的 captureScreenshot——
 * 那个接口在这个 Electron 上会卡住不返回。-Match 认准测试实例，
 * 别把用户正在用的那个窗口截进来。
 */
async function shot(file) {
  await run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', join(ROOT, 'scripts', 'capture-window.ps1'),
    '-OutFile', file,
    '-Match', 'uitest'
  ])
  console.log(`  · 截图 ${file}`)
}

/** React 的输入框只认原生的 value setter，直接赋 value 它收不到 */
const SET_INPUT = `
function setInput(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
`

/** 造一个假服务器 + 独立 profile。这个测试是破坏性的，每次都得重来一遍 */
async function createFixture() {
  await fs.rm(BASE, { recursive: true, force: true })
  await fs.mkdir(join(SERVER, 'mods'), { recursive: true })
  await fs.mkdir(join(SERVER, 'plugins'), { recursive: true })
  await fs.mkdir(PROFILE, { recursive: true })

  const files = {
    'server.properties': 'motd=test\nserver-port=25999\n',
    'eula.txt': 'eula=true\n',
    // 假的 jar 就够用：扫扩展只认文件名，读不出元数据会退回用文件名显示
    'paper-26.2-129.jar': 'fake jar',
    'mods/sodium-fabric-0.6.0.jar': 'fake',
    'mods/lithium.jar.disabled': 'fake',
    'plugins/ViaVersion-5.2.1.jar': 'fake'
  }
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(join(SERVER, rel, '..'), { recursive: true })
    await fs.writeFile(join(SERVER, rel), content, 'utf-8')
  }

  await fs.writeFile(
    join(PROFILE, 'craftdesk.json'),
    JSON.stringify(
      {
        version: 1,
        servers: [
          {
            id: 'uitest-server',
            name: '测试服',
            dir: SERVER,
            jar: 'paper-26.2-129.jar',
            kind: 'paper',
            mcVersion: '26.2',
            coreDir: '',
            pluginsDir: 'plugins',
            modsDir: 'mods',
            order: 0
          }
        ],
        settings: { javaPath: '', javaList: [], curseforgeApiKey: '' }
      },
      null,
      2
    ),
    'utf-8'
  )
  console.log(`fixture 就绪：${SERVER}`)
}

/** 起一个自己的实例，用自己的 profile 和调试端口，跟用户在用的那个互不干扰 */
async function launchInstance() {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  // 沙箱环境会设这个变量，留着的话 electron 会当成 node 跑
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  const child = spawn(exe, ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
    detached: false
  })
  child.unref()
  console.log(`测试实例已启动（PID ${child.pid}，调试端口 ${PORT}）`)
  return child.pid
}

async function killInstance() {
  // 按命令行认人：只杀带 uitest 的这个实例
  await run('powershell', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*uitest*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ]).catch(() => undefined)
}

async function connect() {
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
    await wait(500)
  }
  throw new Error(`连不上 127.0.0.1:${PORT}`)
}

async function main() {
  await killInstance()
  await createFixture()
  await launchInstance()

  const page = await connect()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true })
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await wait(1500)

  // ---------------------------------------------------------- 扩展开关与删除

  console.log('══ 打开扩展面板 ══')
  await evaluate(`
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '扩展')?.click()
  `)
  await wait(1200)

  const rows = await evaluate(`
    JSON.stringify([...document.querySelectorAll('.panel-scroll .row')].map(r => ({
      name: r.querySelector('.row-title')?.textContent?.trim(),
      actions: [...r.querySelectorAll('.row-actions button')].map(b => b.textContent.trim() || b.title)
    })))
  `)
  const parsed = JSON.parse(rows)
  console.log('  面板里的行：', rows)
  check('列出 3 个扩展', parsed.length, 3)
  check(
    '每行都有 启用/禁用 和 删除',
    parsed.every((r) => r.actions.some((a) => a === '禁用' || a === '启用') && r.actions.some((a) => a.includes('删除'))),
    true
  )
  await shot(join(ROOT, 'tmp', 'uitest', 'ext-panel.png'))

  console.log('\n══ 禁用 sodium-fabric-0.6.0.jar ══')
  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.panel-scroll .row')]
        .find(r => r.textContent.includes('sodium'))
      row.querySelector('.row-actions button').click()
      return true
    })()
  `)
  await wait(1500)
  check('磁盘上出现 .disabled', await exists(join(SERVER, 'mods', 'sodium-fabric-0.6.0.jar.disabled')), true)
  check('原文件已不在', await exists(join(SERVER, 'mods', 'sodium-fabric-0.6.0.jar')), false)
  const afterDisable = await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.panel-scroll .row')]
        .find(r => r.textContent.includes('sodium'))
      return JSON.stringify({
        title: row.querySelector('.row-title').textContent.trim(),
        disabled: row.className.includes('disabled'),
        action: row.querySelector('.row-actions button').textContent.trim()
      })
    })()
  `)
  console.log('  禁用后的行：', afterDisable)
  check('行上出现「已禁用」标签', afterDisable.includes('已禁用'), true)
  check('按钮变成「启用」', afterDisable.includes('"action":"启用"'), true)

  console.log('\n══ 再启用回来 ══')
  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.panel-scroll .row')]
        .find(r => r.textContent.includes('sodium'))
      row.querySelector('.row-actions button').click()
      return true
    })()
  `)
  await wait(1500)
  check('文件名还原', await exists(join(SERVER, 'mods', 'sodium-fabric-0.6.0.jar')), true)

  console.log('\n══ 删除 ViaVersion-5.2.1.jar（二次确认）══')
  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.panel-scroll .row')]
        .find(r => r.textContent.includes('ViaVersion'))
      const del = [...row.querySelectorAll('.row-actions button')].find(b => b.title.includes('删除'))
      del.click()
      return true
    })()
  `)
  await wait(600)
  const dialog = await evaluate(`document.querySelector('.modal-head h2')?.textContent || ''`)
  console.log('  确认框标题：', dialog)
  check('弹出了确认框', dialog.includes('删除'), true)
  await shot(join(ROOT, 'tmp', 'uitest', 'ext-delete-confirm.png'))

  await evaluate(`
    [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('移到回收站')).click()
  `)
  await wait(2500)
  check('插件文件已删除', await exists(join(SERVER, 'plugins', 'ViaVersion-5.2.1.jar')), false)
  check('server.properties 毫发无伤', await exists(join(SERVER, 'server.properties')), true)

  // ---------------------------------------------------------- 启动脚本

  console.log('UI: 生成启动脚本')
  await evaluate(`
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '服务器属性')?.click()
  `)
  await wait(1500)

  const scriptBtn = await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => x.textContent.includes('生成启动脚本') || x.textContent.includes('重新生成脚本'))
      return b ? b.textContent.trim() : '(没找到按钮)'
    })()
  `)
  console.log('  按钮：', scriptBtn)
  check('启动配置里有生成按钮', scriptBtn.includes('生成'), true)

  check('生成之前没有 start.bat', await exists(join(SERVER, 'start.bat')), false)
  await evaluate(`
    [...document.querySelectorAll('button')]
      .find(x => x.textContent.includes('生成启动脚本') || x.textContent.includes('重新生成脚本')).click()
  `)
  await wait(1500)

  const bat = join(SERVER, 'start.bat')
  check('磁盘上出现了 start.bat', await exists(bat), true)
  if (await exists(bat)) {
    const text = await fs.readFile(bat, 'utf-8')
    console.log('  生成的内容：')
    console.log(text.split(/\r?\n/).map((l) => '    | ' + l).join('\n'))
    check('含 java 与内存参数', text.includes('-Xms') && text.includes('-jar'), true)
    check('含核心文件名', text.includes('paper-26.2-129.jar'), true)
    check('纯 ASCII（cmd 不会读成乱码）', Buffer.from(text, 'utf-8').every((b) => b < 128), true)
  }

  const relabel = await evaluate(`
    JSON.stringify([...document.querySelectorAll('button')]
      .map(b => b.textContent.trim()).filter(t => t.includes('启动脚本')))
  `)
  console.log('  相关按钮：', relabel)

  // ---------------------------------------------------------- 删除服务器

  console.log('\n══ 打开服务器删除对话框 ══')
  await evaluate(`
    (() => {
      // 顶部工具栏的服务器切换菜单 → 最下面那条危险操作
      document.querySelector('.toolbar .chip').click()
      return true
    })()
  `)
  await wait(500)
  const menu = await evaluate(`
    JSON.stringify([...document.querySelectorAll('.menu-item')].map(b => b.textContent.trim()))
  `)
  console.log('  菜单项：', menu)
  check('菜单里有删除入口', menu.includes('移除或删除这台服务器…'), true)
  await shot(join(ROOT, 'tmp', 'uitest', 'server-menu.png'))

  await evaluate(`
    [...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('移除或删除')).click()
  `)
  await wait(900)
  const cards = await evaluate(`
    JSON.stringify([...document.querySelectorAll('.pick-card')].map(c => c.querySelector('.pick-title').textContent.trim()))
  `)
  console.log('  两个选项：', cards)
  check('给出两个选项', JSON.parse(cards).length, 2)
  await shot(join(ROOT, 'tmp', 'uitest', 'server-delete-link.png'))

  console.log('\n══ 选「连目录一起删」：没打名字不能删 ══')
  await evaluate(`
    [...document.querySelectorAll('.pick-card')].find(c => c.textContent.includes('连服务器目录')).click()
  `)
  await wait(600)
  const gate = await evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('删除整个服务器'))
      return JSON.stringify({ label: btn.textContent.trim(), disabled: btn.disabled })
    })()
  `)
  console.log('  确认按钮：', gate)
  check('按钮禁用', JSON.parse(gate).disabled, true)
  await shot(join(ROOT, 'tmp', 'uitest', 'server-delete-files.png'))

  console.log('\n══ 打错名字：仍然不能删 ══')
  await evaluate(`
    ${SET_INPUT}
    (() => {
      const input = document.querySelector('.modal-body input.input')
      setInput(input, '随便打个错名字')
      return true
    })()
  `)
  await wait(500)
  const wrong = await evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('删除整个服务器'))
      return JSON.stringify({
        disabled: btn.disabled,
        hint: document.querySelector('.modal-body')?.textContent.includes('名称不一致') || false
      })
    })()
  `)
  console.log('  打错时：', wrong)
  check('按钮仍然禁用', JSON.parse(wrong).disabled, true)
  check('给出名称不一致提示', JSON.parse(wrong).hint, true)

  console.log('\n══ 打对名字：真正删除目录 ══')
  await evaluate(`
    ${SET_INPUT}
    (() => {
      const input = document.querySelector('.modal-body input.input')
      setInput(input, '测试服')
      return true
    })()
  `)
  await wait(500)
  const ready = await evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('删除整个服务器'))
      return JSON.stringify({ disabled: btn.disabled })
    })()
  `)
  check('按钮解锁', JSON.parse(ready).disabled, false)

  await evaluate(`
    [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('删除整个服务器')).click()
  `)
  await wait(4000)

  check('服务器目录已经不在', await exists(SERVER), false)
  const left = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.side-list .server-item, .side-empty')]
      return JSON.stringify({ rows: rows.length, text: document.querySelector('.side-list')?.textContent?.trim().slice(0, 40) })
    })()
  `)
  console.log('  删除后的列表：', left)
  check('列表里也不见了', left.includes('还没有任何服务器'), true)

  const saved = JSON.parse(await fs.readFile(join(PROFILE, 'craftdesk.json'), 'utf-8'))
  check('配置里也没了', saved.servers.length, 0)

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  ws.close()
  return fail
}

async function cleanup() {
  await killInstance()
  await fs.rm(BASE, { recursive: true, force: true }).catch(() => undefined)
}

void main()
  .then(async (failed) => {
    await cleanup()
    process.exit(failed ? 1 : 0)
  })
  .catch(async (err) => {
    console.error('失败：', err.message || err)
    await cleanup()
    process.exit(1)
  })
