import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { Store } from './store'
import { dataDirNextTo, pickDataDir } from './portable'
import { ServerManager } from './server-manager'
import { registerIpc } from './ipc'

let win: BrowserWindow | null = null
let store: Store | null = null
let manager: ServerManager | null = null

const isDev = !app.isPackaged

/*
 * 数据目录（配置、服务器图标、日志缓存）放哪。
 *
 * 顺序：
 *   1. 环境变量 CRAFTDESK_USER_DATA —— 显式指定，测试实例走这条
 *      （scripts/run-app.mjs --isolated 就是这么干的）
 *   2. 便携版：exe 旁边的 data\ —— 拷到哪都能带走
 *   3. 系统用户目录 %APPDATA%\CraftDesk —— 上面那条写不进去时的兜底
 *
 * 必须在 requestSingleInstanceLock 之前设置：单实例锁是按这个路径算的，
 * 路径不同才能和平时那个实例并存。
 */
const dataChoice = (() => {
  const override = process.env.CRAFTDESK_USER_DATA
  if (override) {
    return { dir: override, portable: false, reason: '由 CRAFTDESK_USER_DATA 指定（测试实例）' }
  }
  const choice = pickDataDir(
    [
      // electron-builder 的便携版会把「exe 真正所在的目录」放在这个变量里
      // （运行时程序是从临时目录解压出来的，直接问 exe 路径会问到临时目录去）
      process.env.PORTABLE_EXECUTABLE_DIR && join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'),
      // 免安装的绿色目录：exe 旁边就是 data
      app.isPackaged ? dataDirNextTo(app.getPath('exe')) : null
    ],
    app.getPath('userData')
  )
  return choice
})()

if (dataChoice.dir !== app.getPath('userData')) {
  app.setPath('userData', dataChoice.dir)
}

/** 界面上的「运行环境」要显示这两条 */
export function dataDirInfo(): typeof dataChoice {
  return dataChoice
}

/** 只允许单实例，避免同一个服务端被两个窗口启动 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    // 任务栏 / Alt-Tab 里的图标。打包后走 electron-builder 的 win.icon，这里是开发期
    icon: join(__dirname, '../../build/icon.png'),
    minWidth: 1080,
    minHeight: 660,
    show: false,
    frame: false,
    // 标题栏自己做，配合深色主题
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win?.show())

  win.on('maximize', () => win?.webContents.send('window:state', true))
  win.on('unmaximize', () => win?.webContents.send('window:state', false))

  win.on('close', async (e) => {
    const running = manager?.list().filter((s) => s.runtime.status !== 'stopped') ?? []
    if (running.length && store?.settings.stopOnExit && !isQuitting) {
      e.preventDefault()
      isQuitting = true
      await manager?.stopAll()
      win?.destroy()
    }
  })

  // 外部链接一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

let isQuitting = false

void app.whenReady().then(async () => {
  store = new Store()
  await store.load()
  // 首次运行：把默认配置落盘，用户打开配置目录就能看到、也方便直接改
  await store.ensureFile()

  manager = new ServerManager(store, {
    onLog: (id, line) => win?.webContents.send('log', id, line),
    onStatus: (id, runtime) => win?.webContents.send('status', id, runtime),
    onStats: (stats) => win?.webContents.send('stats', stats),
    onServersChanged: () => win?.webContents.send('servers:changed')
  })

  registerIpc({ store, manager, getWindow: () => win, dataDir: dataChoice })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  isQuitting = true
  await manager?.dispose()
  await store?.writeNow()
})
