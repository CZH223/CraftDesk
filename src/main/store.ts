import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppSettings, ServerConfig, ServerKind } from '../shared/types'

interface StoreShape {
  version: number
  servers: ServerConfig[]
  settings: AppSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  javaPath: '',
  javaList: [],
  pythonPath: '',
  pythonList: [],
  defaultMemoryMin: 1024,
  defaultMemoryMax: 4096,
  defaultJvmArgs: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200',
  closeToTray: true,
  stopOnExit: true,
  maxLogLines: 4000,
  curseforgeApiKey: '',
  theme: 'dark',
  sideWidth: 300,
  panelWidth: 360,
  backgroundImage: '',
  backgroundOpacity: 1,
  surfaceOpacity: 0.86
}

export function defaultServer(partial: Partial<ServerConfig>): ServerConfig {
  const now = Date.now()
  return {
    id: randomUUID(),
    name: '新服务器',
    dir: '',
    jar: 'server.jar',
    startScript: '',
    launchArgs: '',
    pythonPath: '',
    javaPath: '',
    memoryMin: 1024,
    memoryMax: 4096,
    jvmArgs: '',
    serverArgs: 'nogui',
    kind: 'unknown' as ServerKind,
    mcVersion: '',
    coreDir: '',
    mcdr: false,
    pluginsDir: '',
    modsDir: '',
    autoRestart: false,
    createdAt: now,
    lastStartedAt: 0,
    totalUptime: 0,
    color: '',
    icon: '',
    note: '',
    order: 0,
    ...partial
  }
}

/**
 * 极简 JSON 持久化。写入做 300ms 去抖，避免频繁落盘。
 */
export class Store {
  private data: StoreShape
  private file: string
  private timer: NodeJS.Timeout | null = null
  /** 磁盘上有没有这份配置（首次运行时要补一份出来） */
  private persisted = false

  constructor() {
    this.file = join(app.getPath('userData'), 'craftdesk.json')
    this.data = { version: 1, servers: [], settings: { ...DEFAULT_SETTINGS } }
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<StoreShape>
      this.data = {
        version: 1,
        servers: Array.isArray(parsed.servers) ? parsed.servers.map((s) => defaultServer(s)) : [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
      }
      this.persisted = true
    } catch {
      // 首次运行（或者文件被改坏了），用默认值；下面 ensureFile() 会补出文件
      this.persisted = false
    }
  }

  /**
   * 首次运行时把默认配置写出来。
   *
   * 不写的话，用户要等到「改点什么」才会看到配置文件出现在目录里 ——
   * 「打开就有一份配置可以看、可以手改」是更符合直觉的。
   * 已经有配置文件的话什么都不做：里面的服务器列表不能被默认值盖掉。
   */
  async ensureFile(): Promise<boolean> {
    if (this.persisted) return false
    await this.writeNow()
    this.persisted = true
    return true
  }

  get settings(): AppSettings {
    return this.data.settings
  }

  patchSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...patch }
    this.flush()
    return this.data.settings
  }

  get servers(): ServerConfig[] {
    return [...this.data.servers].sort((a, b) => a.order - b.order)
  }

  getServer(id: string): ServerConfig | undefined {
    return this.data.servers.find((s) => s.id === id)
  }

  addServer(cfg: ServerConfig): ServerConfig {
    cfg.order = this.data.servers.length
    this.data.servers.push(cfg)
    this.flush()
    return cfg
  }

  updateServer(id: string, patch: Partial<ServerConfig>): ServerConfig | undefined {
    const idx = this.data.servers.findIndex((s) => s.id === id)
    if (idx < 0) return undefined
    this.data.servers[idx] = { ...this.data.servers[idx], ...patch, id }
    this.flush()
    return this.data.servers[idx]
  }

  removeServer(id: string): void {
    this.data.servers = this.data.servers.filter((s) => s.id !== id)
    this.data.servers.forEach((s, i) => (s.order = i))
    this.flush()
  }

  reorder(ids: string[]): void {
    ids.forEach((id, i) => {
      const s = this.data.servers.find((x) => x.id === id)
      if (s) s.order = i
    })
    this.flush()
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.writeNow(), 300)
  }

  async writeNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      await fs.mkdir(dirname(this.file), { recursive: true })
      // 先写临时文件再改名。直接覆盖写的话，进程在写到一半时被杀
      // （任务管理器结束进程、断电）会把配置文件截断成 0 字节，
      // 用户辛苦配置的服务器列表就全没了。
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      await fs.rename(tmp, this.file)
    } catch (err) {
      console.error('[store] 写入失败', err)
    }
  }
}
