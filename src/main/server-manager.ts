import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LogLevel,
  LogLine,
  ServerConfig,
  ServerRuntime,
  ServerStatus,
  ServerView
} from '../shared/types'
import { run } from './java'
import { UTF8_CONSOLE_FLAGS } from '../shared/jvmArgs'
import { resolveLayout, resolveServerPort } from './layout'
import { fileLockInfo } from './files'
import { readVelocityFile } from './velocity'
import { isProxyKind } from '../shared/types'
import { looksLikePlayerNames, pingServer, type PingResult } from './ping'
import type { Store } from './store'

export interface ManagerEvents {
  onLog(serverId: string, line: LogLine): void
  onStatus(serverId: string, runtime: ServerRuntime): void
  onStats(stats: Record<string, ProcStat>): void
  onServersChanged(): void
}

export interface ProcStat {
  mem: number
  cpu: number
}

/** 把命令行字符串切成参数数组，支持引号 */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) {
    out.push(m[1] ?? m[2] ?? m[3])
  }
  return out
}

/** stdout 可能是 UTF-8 也可能是 GBK（中文 Windows + 老版本 Java），逐行解码并做回退 */
class LineDecoder {
  private buf: Buffer = Buffer.alloc(0)

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    let idx = this.buf.indexOf(0x0a)
    while (idx >= 0) {
      const raw = this.buf.subarray(0, idx)
      this.buf = this.buf.subarray(idx + 1)
      this.onLine(decodeLine(raw))
      idx = this.buf.indexOf(0x0a)
    }
    // 防御没有换行的超长输出
    if (this.buf.length > 1 << 20) {
      this.onLine(decodeLine(this.buf))
      this.buf = Buffer.alloc(0)
    }
  }

  flush(): void {
    if (this.buf.length) {
      this.onLine(decodeLine(this.buf))
      this.buf = Buffer.alloc(0)
    }
  }
}

function decodeLine(rawIn: Buffer): string {
  let b = rawIn
  if (b.length && b[b.length - 1] === 0x0d) b = b.subarray(0, b.length - 1)
  if (!b.length) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    try {
      return new TextDecoder('gbk').decode(b)
    } catch {
      return b.toString('latin1')
    }
  }
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

/** 把一行原始日志拆成等级 + 正文 */
export function parseLine(raw: string): LogLine {
  const clean = raw.replace(ANSI, '')
  let level: LogLevel = 'info'
  let text = clean

  // 现代格式: [12:34:56] [Server thread/INFO]: xxx
  // 代理端多一层 logger: [08:06:23] [Netty NIO Worker #41/INFO] [com.velocitypowered...]: xxx
  // 第三段限定必须含点号，否则会把消息正文里的 [xxx]: 也吃掉
  const modern = clean.match(
    /^\[\d{2}:\d{2}:\d{2}\]\s*\[([^\]]+)\](?:\s*\[([^\]]*\.[^\]]*)\])?:\s?(.*)$/
  )
  if (modern) {
    const src = modern[1]
    text = modern[3]
    if (/\/FATAL|\/ERROR/i.test(src)) level = 'error'
    else if (/\/WARN/i.test(src)) level = 'warn'
    else if (/\/DEBUG|TRACE/i.test(src)) level = 'debug'
    else level = 'info'
  } else {
    // 旧格式: [12:34:56 INFO]: xxx
    const legacy = clean.match(/^\[\d{2}:\d{2}:\d{2}\s?(INFO|WARN|ERROR|FATAL|DEBUG)?\]:?\s?(.*)$/i)
    if (legacy) {
      const lv = (legacy[1] || 'INFO').toLowerCase()
      level = (['info', 'warn', 'error', 'debug'].includes(lv) ? lv : 'info') as LogLevel
      text = legacy[2]
    }
  }

  const line: LogLine = { t: Date.now(), level, text, raw: clean }

  const chat = text.match(/^<([A-Za-z0-9_]{1,16})>\s?(.*)$/)
  if (chat) {
    line.level = 'chat'
    line.player = chat[1]
    line.text = chat[2]
  }
  return line
}

interface ServerProcess {
  child: ChildProcessWithoutNullStreams | null
  status: ServerStatus
  startedAt: number | null
  online: Set<string>
  /** 最近一次 ping 到的在线人数；null 表示还没问出来 */
  pinged: number | null
  /** 最近一次 ping 到的上限；null 表示还没问出来 */
  pingMax: number | null
  /** ping 通了，说明端口上有服务端在跑（不管是不是我们启的） */
  portAlive: boolean
  /** 代理端的后端端口（从 velocity.toml 读一次缓存下来），用来盯后端在不在 */
  backendPorts: number[] | null
  maxPlayers: number
  /** 实际监听端口，优先用日志里报出来的真实值 */
  port: number | null
  tps: number | null
  exitCode: number | null
  issue: ServerRuntime['issue']
  issueDetail: string
  logs: LogLine[]
  stoppingTimer: NodeJS.Timeout | null
  /** 用户主动点的停止，用于区分崩溃 */
  intentionalStop: boolean
}

export class ServerManager {
  private procs = new Map<string, ServerProcess>()
  private statsTimer: NodeJS.Timeout | null = null
  private lastStats: Record<string, ProcStat> = {}
  private playersTimer: NodeJS.Timeout | null = null
  private playersTick = 0
  /** 配置里声明的端口，ping 用。走缓存是因为每个 tick 都去读 server.properties 太浪费 */
  private cfgPorts = new Map<string, number | null>()

  constructor(
    private readonly store: Store,
    private readonly events: ManagerEvents
  ) {
    this.startPlayerPolling()
  }

  // ---------- 查询 ----------

  private ensure(id: string): ServerProcess {
    let p = this.procs.get(id)
    if (!p) {
      p = {
        child: null,
        status: 'stopped',
        startedAt: null,
        online: new Set(),
        pinged: null,
        pingMax: null,
        portAlive: false,
        backendPorts: null,
        maxPlayers: 20,
        port: null,
        tps: null,
        exitCode: null,
        issue: null,
        issueDetail: '',
        logs: [],
        stoppingTimer: null,
        intentionalStop: false
      }
      this.procs.set(id, p)
    }
    return p
  }

  runtime(id: string): ServerRuntime {
    const p = this.ensure(id)
    return {
      id,
      status: p.status,
      pid: p.child?.pid ?? null,
      startedAt: p.startedAt,
      uptime: p.startedAt ? Math.floor((Date.now() - p.startedAt) / 1000) : 0,
      onlinePlayers: [...p.online],
      // 数字以服务端自己报的为准，日志里数的那个只在问不到时兜底
      onlineCount: p.pinged ?? p.online.size,
      maxPlayers: p.pingMax ?? p.maxPlayers,
      externalRunning: !p.child && p.portAlive,
      port: p.port,
      tps: p.tps,
      exitCode: p.exitCode,
      issue: p.issue,
      issueDetail: p.issueDetail
    }
  }

  list(): ServerView[] {
    return this.store.servers.map((s) => ({ ...s, runtime: this.runtime(s.id) }))
  }

  getServer(id: string): ServerView | undefined {
    const cfg = this.store.getServer(id)
    if (!cfg) return undefined
    return { ...cfg, runtime: this.runtime(id) }
  }

  logs(id: string): LogLine[] {
    return this.ensure(id).logs
  }

  clearLogs(id: string): void {
    this.ensure(id).logs = []
  }

  /**
   * 服务器被移除后丢掉它的运行时状态。
   * 不然日志和玩家集合会一直挂在内存里，id 也不会再被复用。
   */
  forget(id: string): void {
    const p = this.procs.get(id)
    if (p?.child) return // 还在跑就不能丢，调用方应该先确认已停止
    this.procs.delete(id)
  }

  private emitStatus(id: string): void {
    this.events.onStatus(id, this.runtime(id))
  }

  private pushLog(id: string, line: LogLine): void {
    const p = this.ensure(id)
    p.logs.push(line)
    const cap = this.store.settings.maxLogLines || 4000
    if (p.logs.length > cap) p.logs.splice(0, p.logs.length - cap)
    this.events.onLog(id, line)
  }

  private sysLog(id: string, text: string, level: LogLevel = 'system'): void {
    this.pushLog(id, { t: Date.now(), level, text, raw: text })
  }

  // ---------- 生命周期 ----------

  isRunning(id: string): boolean {
    const s = this.ensure(id).status
    return s === 'running' || s === 'starting' || s === 'stopping'
  }

  async start(id: string): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.store.getServer(id)
    if (!cfg) return { ok: false, error: '服务器不存在' }

    const p = this.ensure(id)
    if (p.child) return { ok: false, error: '服务器已在运行' }

    if (!cfg.dir || !existsSync(cfg.dir)) {
      return { ok: false, error: `服务器目录不存在：${cfg.dir || '(未设置)'}` }
    }

    const layout = await resolveLayout(cfg)
    const isProxy = layout.isProxy

    // 端口互斥：同一个端口上同时只能有一个进程在监听。
    // 与其让第二个等到启动失败才发现，不如现在就拦下来并说清楚是谁占了。
    const myPort = await resolveServerPort(cfg)
    if (myPort != null) {
      for (const other of this.store.servers) {
        if (other.id === id || !this.isRunning(other.id)) continue
        if ((await resolveServerPort(other)) === myPort) {
          const msg = `端口 ${myPort} 已被「${other.name}」占用，两个服务器不能同时启动`
          p.issue = 'port-in-use'
          p.issueDetail = msg
          this.emitStatus(id)
          return { ok: false, error: msg }
        }
      }

      /*
       * 还有一种占端口的情况：服务端不是 CraftDesk 启的
       * （手动双击了 start.bat、或者 MCDR 自己拉起来的）。
       * 我们的进程表里没有它，但端口确实被占着——不查这一次的话，
       * 用户会看到「启动成功」然后服务端在日志里报 FAILED TO BIND TO PORT。
       * 现场问一次，比信缓存的状态可靠。
       */
      const alive = await pingServer('127.0.0.1', myPort, 1200)
      if (alive) {
        const msg =
          `端口 ${myPort} 上已经有服务端在响应了（不是 CraftDesk 启动的）。` +
          `先把它关掉再启动，否则会撞端口。`
        p.issue = 'port-in-use'
        p.issueDetail = msg
        this.emitStatus(id)
        return { ok: false, error: msg }
      }
    }

    /*
     * MCDReforged 的日志文件只能有一个进程写。
     *
     * 已经在跑的 MCDR（手动启动的、或者上次没关干净的）会一直占着
     * logs/MCDR.log，这时再起一个：它启动时要轮转日志，unlink 会抛
     * PermissionError [Win32 32]，整个 MCDR 直接躺下——界面上只看到一段
     * Python 堆栈，完全看不出是「已经有一个在跑了」。
     *
     * 用改名探针查一次，比事后解释堆栈便宜得多。
     */
    if (layout.isMcdr) {
      const logFile = join(cfg.dir, 'logs', 'MCDR.log')
      const lock = await fileLockInfo(logFile)
      if (lock?.locked) {
        const size =
          lock.size > 1 << 30
            ? `（它现在已经 ${(lock.size / 1024 ** 3).toFixed(1)} GB，MCDR 每天轮转日志就卡在这种大文件上，关掉它之后建议把旧日志清掉）`
            : ''
        const msg =
          `这个目录里已经有一个 MCDReforged 在跑了，它占着 logs/MCDR.log${size}。` +
          `先把它关掉再启动，否则两个 MCDR 会抢同一个日志文件，新的那个会在轮转日志时直接崩掉。`
        p.issue = 'mcdr-running'
        p.issueDetail = msg
        this.emitStatus(id)
        return { ok: false, error: msg }
      }
    }

    const javaPath = cfg.javaPath || this.store.settings.javaPath
    if (!cfg.startScript && !javaPath) {
      p.issue = 'java-missing'
      p.issueDetail = '没有配置 Java 路径，请在设置里选择 java.exe'
      this.emitStatus(id)
      return { ok: false, error: p.issueDetail }
    }

    const jarPath = cfg.jar ? join(cfg.dir, cfg.jar) : ''
    if (!cfg.startScript && jarPath && !existsSync(jarPath)) {
      return { ok: false, error: `找不到服务端核心：${cfg.jar}` }
    }
    // Forge / NeoForge 靠参数文件启动，它不在就等于没核心
    if (!cfg.startScript && cfg.launchArgs && !existsSync(join(cfg.dir, cfg.launchArgs))) {
      return { ok: false, error: `找不到启动参数文件：${cfg.launchArgs}` }
    }

    p.online.clear()
    // 代理端没有 max-players 这个概念，玩家看到的上限是 velocity.toml 的 show-max-players
    if (isProxy) {
      try {
        const vf = await readVelocityFile(cfg.dir)
        const raw = vf.fields.find(
          (f) => f.section === '' && f.key === 'show-max-players'
        )?.value
        const n = raw ? Number(raw) : NaN
        if (Number.isFinite(n) && n > 0) p.maxPlayers = n
      } catch {
        /* 读不到就保持原值 */
      }
    }
    p.tps = null
    p.exitCode = null
    // 先用配置里的端口占位，等日志报出真实监听端口再覆盖
    p.port = layout.configuredPort
    p.issue = null
    p.issueDetail = ''
    p.intentionalStop = false
    p.status = 'starting'
    p.startedAt = Date.now()
    this.store.updateServer(id, { lastStartedAt: p.startedAt })
    this.events.onServersChanged()
    this.emitStatus(id)
    this.sysLog(id, `正在启动 ${cfg.name} …`, 'system')

    const decoder = new LineDecoder((line) => this.handleLine(id, line))

    let child: ChildProcessWithoutNullStreams
    try {
      if (cfg.startScript) {
        const script = join(cfg.dir, cfg.startScript)
        this.sysLog(id, `> cmd /c ${cfg.startScript}`, 'system')
        child = spawn('cmd.exe', ['/c', script], {
          cwd: cfg.dir,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }) as ChildProcessWithoutNullStreams
      } else if (cfg.mcdr && cfg.pythonPath) {
        /*
         * 由 MCDReforged 托管的服务器：真正要起的是 MCDR 这个 Python 程序，
         * 它再按自己的 config.yml 去拉服务端。所以这里跑的是 python -m mcdreforged，
         * 内存那些参数在 config.yml 里（界面会提示这一点）。
         */
        const args = ['-X', 'utf8', '-m', 'mcdreforged']
        this.sysLog(id, `> ${cfg.pythonPath} ${args.join(' ')}`, 'system')
        child = spawn(cfg.pythonPath, args, {
          cwd: cfg.dir,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }) as ChildProcessWithoutNullStreams
      } else if (cfg.launchArgs) {
        /*
         * Forge / NeoForge（1.17+）：没有可 -jar 的核心，启动参数在一个
         * 参数文件里，用 java 的 @文件 语法展开。内存和 JVM 参数照样由我们传，
         * 所以界面上改内存是生效的。
         */
        const args: string[] = []
        if (cfg.memoryMin > 0) args.push(`-Xms${cfg.memoryMin}M`)
        if (cfg.memoryMax > 0) args.push(`-Xmx${cfg.memoryMax}M`)
        args.push(...splitArgs(cfg.jvmArgs || ''))
        args.push(...UTF8_CONSOLE_FLAGS)
        // 参数文件相对服务器根目录（和 jar 一个约定），给绝对路径最稳
        args.push(`@${join(cfg.dir, cfg.launchArgs)}`)
        // nogui 照样要传：Forge 的服务端认这个参数，省掉它的启动器窗口
        args.push(...splitArgs(cfg.serverArgs || ''))

        this.sysLog(id, `> ${javaPath} ${args.join(' ')}`, 'system')
        child = spawn(javaPath, args, {
          cwd: cfg.dir,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }) as ChildProcessWithoutNullStreams
      } else {
        const args: string[] = []
        if (cfg.memoryMin > 0) args.push(`-Xms${cfg.memoryMin}M`)
        if (cfg.memoryMax > 0) args.push(`-Xmx${cfg.memoryMax}M`)
        args.push(...splitArgs(cfg.jvmArgs || ''))
        // 让 Java 19+ 以 UTF-8 输出，避免中文乱码；老版本会忽略这两个属性
        args.push(...UTF8_CONSOLE_FLAGS)
        args.push('-jar', cfg.jar)
        // 代理端不认识 nogui，传过去会被当成未知参数
        const extra = splitArgs(cfg.serverArgs || '').filter(
          (a) => !(isProxy && a.toLowerCase() === 'nogui')
        )
        args.push(...extra)

        this.sysLog(id, `> ${javaPath} ${args.join(' ')}`, 'system')
        child = spawn(javaPath, args, {
          cwd: cfg.dir,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }) as ChildProcessWithoutNullStreams
      }
    } catch (err) {
      p.status = 'crashed'
      p.startedAt = null
      this.sysLog(id, `启动失败：${String(err)}`, 'error')
      this.emitStatus(id)
      return { ok: false, error: String(err) }
    }

    p.child = child

    child.stdout.on('data', (d: Buffer) => decoder.push(d))
    child.stderr.on('data', (d: Buffer) => decoder.push(d))

    child.on('error', (err) => {
      decoder.flush()
      p.status = 'crashed'
      p.child = null
      p.startedAt = null
      p.issue = 'java-missing'
      p.issueDetail = `无法启动进程：${err.message}`
      this.sysLog(id, `进程错误：${err.message}`, 'error')
      this.emitStatus(id)
      this.stopStatsPollingIfIdle()
    })

    child.on('close', (code) => {
      decoder.flush()
      if (p.stoppingTimer) {
        clearTimeout(p.stoppingTimer)
        p.stoppingTimer = null
      }
      const wasUptime = p.startedAt ? Math.floor((Date.now() - p.startedAt) / 1000) : 0
      p.exitCode = code
      p.child = null
      p.startedAt = null
      p.online.clear()

      const cfgNow = this.store.getServer(id)
      if (cfgNow && wasUptime > 0) {
        this.store.updateServer(id, { totalUptime: (cfgNow.totalUptime || 0) + wasUptime })
        this.events.onServersChanged()
      }

      if (p.intentionalStop || code === 0) {
        p.status = 'stopped'
        this.sysLog(id, `服务器已停止（退出码 ${code}）`, 'system')
      } else {
        p.status = 'crashed'
        if (!p.issue) {
          p.issue = 'crash'
          p.issueDetail = `服务器异常退出，退出码 ${code}`
        }
        this.sysLog(id, `服务器异常退出，退出码 ${code}`, 'error')
      }

      // 自动重启
      if (cfgNow?.autoRestart && !p.intentionalStop) {
        this.sysLog(id, '检测到异常退出，5 秒后自动重启…', 'system')
        setTimeout(() => {
          if (!this.isRunning(id)) void this.start(id)
        }, 5000)
      }

      this.emitStatus(id)
      this.stopStatsPollingIfIdle()
    })

    this.startStatsPolling()
    // 代理端起来之后盯一眼后端：玩家连不上才发现的代价太大
    if (isProxy) void this.watchProxyBackends(id)
    return { ok: true }
  }

  /**
   * 代理端的后端在不在。
   *
   * 代理端本身起来了不代表玩家能玩：后端没开的话，玩家一路连到代理端、
   * 被转发的瞬间才被踢回来，日志里只留一屏 Netty 堆栈。
   * 这里读一次 velocity.toml 把后端端口记下来，之后每个轮询周期探一次，
   * 有后端活了就把提示撤掉。
   */
  private async watchProxyBackends(id: string): Promise<void> {
    const cfg = this.store.getServer(id)
    const p = this.ensure(id)
    if (!cfg || p.backendPorts) return
    try {
      const vf = await readVelocityFile(cfg.dir)
      p.backendPorts = vf.servers
        .map((x) => x.port)
        .filter((n): n is number => Number.isFinite(n) && n > 0)
    } catch {
      return // 读不到配置就不盯了，别拿猜测去报警
    }
    // 给用户一点时间自己点后端，别一启动就红一片
    setTimeout(() => void this.probeProxyBackends(id), 6000)
  }

  /** 探一次后端端口，状态变了才推给界面 */
  private async probeProxyBackends(id: string): Promise<void> {
    const p = this.ensure(id)
    if (!p.child || !p.backendPorts?.length) return

    const before = `${p.issue}|${p.issueDetail}`
    const alive = await Promise.all(p.backendPorts.map((port) => pingServer('127.0.0.1', port, 1200)))

    if (alive.some(Boolean)) {
      // 有后端活了，之前那条「后端没开」的提示就不该再挂着
      if (p.issue === 'backend-down') {
        p.issue = null
        p.issueDetail = ''
      }
    } else {
      p.issue = 'backend-down'
      p.issueDetail =
        `后端一个都没在跑（${p.backendPorts.join('、')} 都没有响应）。` +
        `玩家现在连上会被直接踢回，先把后端启动起来。`
    }

    if (`${p.issue}|${p.issueDetail}` !== before) this.emitStatus(id)
  }

  async stop(id: string, force = false): Promise<void> {
    const p = this.ensure(id)
    if (!p.child) return

    p.intentionalStop = true

    if (force) {
      this.sysLog(id, '强制结束进程', 'warn')
      await this.killTree(p.child.pid)
      return
    }

    p.status = 'stopping'
    this.emitStatus(id)
    this.sysLog(id, '正在发送 stop 指令，等待服务器保存世界…', 'system')

    try {
      p.child.stdin.write('stop\n')
    } catch {
      await this.killTree(p.child.pid)
      return
    }

    // 30 秒还没退出就强杀
    p.stoppingTimer = setTimeout(() => {
      const cur = this.ensure(id)
      if (cur.child) {
        this.sysLog(id, '服务器 30 秒未响应，强制结束', 'warn')
        void this.killTree(cur.child.pid)
      }
    }, 30000)
  }

  async restart(id: string): Promise<void> {
    await this.stop(id)
    const p = this.ensure(id)
    // 等进程真正退出后再启动
    const deadline = Date.now() + 35000
    while (p.child && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
    }
    await this.start(id)
  }

  async killTree(pid: number | undefined): Promise<void> {
    if (!pid) return
    if (process.platform === 'win32') {
      await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000 })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
  }

  sendCommand(id: string, cmd: string): boolean {
    const p = this.ensure(id)
    if (!p.child || p.status === 'stopped' || p.status === 'crashed') return false
    try {
      p.child.stdin.write(cmd.endsWith('\n') ? cmd : `${cmd}\n`)
      this.pushLog(id, {
        t: Date.now(),
        level: 'system',
        text: `> ${cmd}`,
        raw: `> ${cmd}`
      })
      return true
    } catch {
      return false
    }
  }

  async stopAll(): Promise<void> {
    const running = this.store.servers.filter((s) => this.isRunning(s.id))
    await Promise.all(running.map((s) => this.stop(s.id)))
  }

  // ---------- 日志解析 ----------

  private handleLine(id: string, raw: string): void {
    if (!raw.trim()) return
    const line = parseLine(raw)
    const p = this.ensure(id)
    const text = line.text

    // --- 玩家进出 ---
    // 原版 / 插件服：Steve joined the game
    const joined = text.match(/^([A-Za-z0-9_]{1,16})(?:\[[^\]]*\])? joined the game/)
    // 代理端：[connected player] Steve (/127.0.0.1:53915) has connected
    // 注意别把 [server connection] Steve -> survival has connected（后端切换）当成进出服
    const proxyJoin = text.match(
      /^\[connected player\]\s+([A-Za-z0-9_]{1,16})\s+\([^)]*\)\s+has connected/
    )
    const proxyLeave = text.match(
      /^\[connected player\]\s+([A-Za-z0-9_]{1,16})\s+\([^)]*\)\s+has disconnected/
    )

    if (joined) {
      p.online.add(joined[1])
      this.emitStatus(id)
    } else if (proxyJoin) {
      p.online.add(proxyJoin[1])
      this.emitStatus(id)
    } else if (proxyLeave) {
      p.online.delete(proxyLeave[1])
      this.emitStatus(id)
    } else {
      const left = text.match(/^([A-Za-z0-9_]{1,16}) left the game/)
      if (left) {
        p.online.delete(left[1])
        this.emitStatus(id)
      } else if (line.level === 'chat' && line.player) {
        p.online.add(line.player)
      }
    }

    // --- 服务器就绪 ---
    // 原版是 Done (12.3s)! For help, type "help"，代理端只有 Done (0.83s)!
    if (/Done \(\d[\d.,]*s\)!/.test(text) && p.status !== 'running') {
      p.status = 'running'
      p.startedAt = p.startedAt ?? Date.now()
      this.emitStatus(id)
    }

    // --- 真实监听端口 ---
    // 原版：Starting Minecraft server on *:25565
    // 代理端：Listening on /0.0.0.0:25566
    const portHit =
      text.match(/Starting Minecraft server on \S*?:(\d+)/) ||
      text.match(/Listening on \/[\d.]+:(\d+)/)
    if (portHit) {
      const port = Number(portHit[1])
      if (port !== p.port) {
        p.port = port
        this.emitStatus(id)
      }
    }

    // --- 在线人数（list 指令输出） ---
    const count = text.match(/There are (\d+) of a max of (\d+) players online/)
    if (count) {
      p.maxPlayers = Number(count[2])
      this.emitStatus(id)
    }

    // --- TPS ---
    const tps = text.match(/TPS from last 1m, 5m, 15m:\s*([\d.]+)/)
    if (tps) {
      p.tps = Number(tps[1])
      this.emitStatus(id)
    }

    // --- 各种问题识别 ---
    if (/You need to agree to the EULA|Go to https:\/\/aka\.ms\/minecrafteula/i.test(text)) {
      p.issue = 'eula'
      p.issueDetail = '需要先同意 Minecraft EULA 才能启动服务器'
    } else if (/FAILED TO BIND TO PORT|Address already in use|Perhaps a server is already running/i.test(text)) {
      p.issue = 'port-in-use'
      p.issueDetail = '端口被占用，请修改 server.properties 中的 server-port'
    } else if (/UnsupportedClassVersionError|class file version/i.test(text)) {
      p.issue = 'java-missing'
      p.issueDetail = 'Java 版本过低，请换用更高版本的 Java'
    } else if (/requires running the server with Java (\d+)/i.test(text)) {
      // Paper 这类引导包会把要求直接印出来，照抄它的话就够清楚了：
      // Minecraft 26.1 and newer requires running the server with Java 25 or above.
      const need = Number(text.match(/requires running the server with Java (\d+)/i)![1])
      const cfg = this.store.getServer(id)
      const cur = cfg ? this.store.settings.javaList.find((j) => j.path === cfg.javaPath) : undefined
      p.issue = 'java-missing'
      p.issueDetail =
        `这个服务端要求 Java ${need} 或更高` +
        (cur?.major ? `，当前用的是 Java ${cur.major}` : '') +
        `。到「启动配置 → Java 运行环境」里换成 Java ${need} 的 java.exe。`
    } else if (/Invalid or corrupt jarfile|zip END header not found|invalid LOC header|Error opening zip file/i.test(text)) {
      // 下载中途断掉、或者磁盘写了一半，都会留下一个打不开的 jar。
      // 光看「退出码 1」猜不出来，这里把话说清楚。
      p.issue = 'crash'
      p.issueDetail =
        '服务端 jar 打不开：文件损坏或不完整。删掉它重新下载一次（下载完成时会自动核对大小和校验和）。'
    } else if (/Unable to access jarfile/i.test(text)) {
      p.issue = 'crash'
      p.issueDetail = '找不到服务端 jar。检查「服务端核心」指向的文件是否还在。'
    } else if (
      /unable to connect to server ([A-Za-z0-9_-]+)/i.test(text) ||
      (/Connection refused/i.test(text) && this.isProxyById(id))
    ) {
      /*
       * 代理端日志里这行后面跟着一屏 Netty 堆栈，看着像代理端自己炸了，
       * 其实只是后端没开。说清楚是谁没开，比让用户读 18 行 at io.netty... 强。
       */
      const who = text.match(/unable to connect to server ([A-Za-z0-9_-]+)/i)?.[1]
      p.issue = 'backend-down'
      p.issueDetail = who
        ? `有玩家连不上后端「${who}」：那个地址上没有服务端在跑（或者还没启动完）。先把后端开起来。`
        : '有玩家连不上后端：后端地址上没有服务端在跑。先把后端开起来。'
    }

    this.pushLog(id, line)
  }

  // ---------- 在线人数（Server List Ping） ----------

  /**
   * 每几秒问一次服务端「几个人在线」。
   *
   * 为什么值得单独开一个轮询：日志数人头是「从我接管之后」的变化量，
   * 中途接管、外部启动、崩溃前的离开行都会让它偏掉；而 ping 拿到的是
   * 服务端现在的真实数字，跟客户端服务器列表里显示的完全同源。
   *
   * 顺带还解决另一件事：我们没启动、但端口上有服务端在响应（手动开服、
   * MCDR 自己拉起来的），也能被认出来。
   */
  private startPlayerPolling(): void {
    if (this.playersTimer) return
    this.playersTimer = setInterval(() => void this.pollPlayers(), 6000)
  }

  private async refreshCfgPorts(): Promise<void> {
    const ids = new Set(this.store.servers.map((s) => s.id))
    // 名单变了（增删服务器）就整体重算一次
    const stale = ids.size !== this.cfgPorts.size || [...ids].some((id) => !this.cfgPorts.has(id))
    if (!stale) return
    this.cfgPorts.clear()
    for (const cfg of this.store.servers) {
      let port: number | null = null
      try {
        port = await resolveServerPort(cfg)
      } catch {
        /* 读不到就当作不知道端口 */
      }
      this.cfgPorts.set(cfg.id, port)
    }
  }

  private async pollPlayers(): Promise<void> {
    await this.refreshCfgPorts()
    const tick = ++this.playersTick
    const anyRunning = [...this.procs.values()].some((p) => p.child)

    // 没有任何服务器在跑的时候没必要每 6 秒扫一遍全部端口，
    // 但也不能完全不看——手动开服的情况得能发现
    // 第一轮就扫一遍：应用刚打开的时候，用户最想立刻看到「其实有台服务器在跑」
    const sweepStopped = anyRunning || tick === 1 || tick % 4 === 0

    // 按端口归组：一个端口只问一次，问回来的结果再分给该负责的服务器
    const groups = new Map<number, string[]>()
    const add = (port: number, id: string): void => {
      groups.set(port, [...(groups.get(port) ?? []), id])
    }

    for (const cfg of this.store.servers) {
      const proc = this.ensure(cfg.id)
      if (proc.child) {
        // 我们启的：端口以日志里报出来的真实值优先
        const port = proc.port ?? this.cfgPorts.get(cfg.id) ?? null
        if (port != null) add(port, cfg.id)
      } else if (sweepStopped) {
        const port = this.cfgPorts.get(cfg.id) ?? null
        if (port != null) add(port, cfg.id)
      }
    }

    await Promise.all(
      [...groups.entries()].map(([port, ids]) => this.pingPortInto(port, ids))
    )

    // 在跑的代理端：顺带确认它的后端还在（不在就把提示挂上）
    for (const cfg of this.store.servers) {
      const proc = this.ensure(cfg.id)
      if (!proc.child || !isProxyKind(cfg.kind)) continue
      if (proc.backendPorts === null) void this.watchProxyBackends(cfg.id)
      else void this.probeProxyBackends(cfg.id)
    }
  }

  /**
   * 问一个端口，把结果写进对应的服务器。
   *
   * 一个端口可能被多台服务器声明（同端口的那几台），这时响应的是谁得判断一下：
   * 服务端会在 ping 里报自己的版本串和 MOTD。用核心名 / 游戏版本 / 名字去对，
   * 只能对上唯一一台才认领——对不上就谁也不认，宁可不说，也不要认错。
   */
  private async pingPortInto(port: number, ids: string[]): Promise<void> {
    const res = await pingServer('127.0.0.1', port, 1500)

    let owners: string[] = []
    if (res) {
      if (ids.length === 1) {
        owners = ids
      } else {
        const matched = ids.filter((id) => this.pingLooksLike(id, res))
        owners = matched.length === 1 ? matched : []
      }
    }

    for (const id of ids) {
      const proc = this.ensure(id)
      const before = `${proc.pinged}|${proc.pingMax}|${proc.portAlive}`
      const mine = owners.includes(id)

      if (res && mine) {
        proc.portAlive = true
        proc.pinged = res.online
        // 服务端报 0 说明它没配上限（或者插件抹掉了），别拿 0 去覆盖
        proc.pingMax = res.max > 0 ? res.max : null
        // 名单完整且看着像用户名才采信：插件常往 sample 里塞广告词，
        // 而且多数服务端只给前 12 个，人多了就不完整
        if (res.sample.length === res.online && looksLikePlayerNames(res.sample)) {
          proc.online = new Set(res.sample)
        }
      } else {
        proc.portAlive = false
        // 问不到（或者认不出是我们这台）就退回日志数出来的那份，
        // 不清零：日志里的数字至少比「0」更接近实情
        proc.pinged = null
        proc.pingMax = null
      }

      if (`${proc.pinged}|${proc.pingMax}|${proc.portAlive}` !== before) this.emitStatus(id)
    }
  }

  /** 这台是不是代理端（日志识别的措辞要分开） */
  private isProxyById(id: string): boolean {
    const cfg = this.store.getServer(id)
    return Boolean(cfg && isProxyKind(cfg.kind))
  }

  /** ping 回来的信息像不像这台服务器 */
  private pingLooksLike(id: string, res: PingResult): boolean {
    const cfg = this.store.getServer(id)
    if (!cfg) return false
    const version = res.version.toLowerCase()
    // 服务端大多会在版本串里带上核心名：Paper 1.21.11 / Velocity 3.5.0 / Purpur 1.21.11
    if (cfg.kind !== 'unknown' && version.includes(cfg.kind.toLowerCase())) return true
    // 版本串里带游戏版本：同一端口上的两台通常版本不同，这一条最有用
    if (cfg.mcVersion && version.includes(cfg.mcVersion.toLowerCase())) return true
    // MOTD 里写了服务器名字的话也能对（记得先把颜色代码去掉）
    const motd = res.motd.replace(/[§&]./g, '').toLowerCase()
    return Boolean(cfg.name) && motd.includes(cfg.name.toLowerCase())
  }

  // ---------- 进程资源占用 ----------

  private startStatsPolling(): void {
    if (this.statsTimer) return
    this.statsTimer = setInterval(() => void this.pollStats(), 5000)
  }

  private stopStatsPollingIfIdle(): void {
    if (this.statsTimer && this.procs.size && [...this.procs.values()].every((p) => !p.child)) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
      this.lastStats = {}
    }
  }

  private async pollStats(): Promise<void> {
    const pids: number[] = []
    for (const p of this.procs.values()) {
      if (p.child?.pid) pids.push(p.child.pid)
    }
    if (!pids.length) {
      this.stopStatsPollingIfIdle()
      return
    }

    const stats: Record<string, ProcStat> = {}
    if (process.platform === 'win32') {
      /*
       * 内存和 CPU 按「整棵进程树」算，不是只看我们 spawn 的那个进程。
       *
       * MCDReforged 托管的服务器就是典型：CraftDesk 起的是 python（MCDR），
       * 真正的服务端是它的子进程。只看 MCDR 那一个进程，界面会显示
       * 「内存 67 MB」而实际上 Java 正吃着 700 MB —— 和玩家人数那种
       * 「界面跟客户端对不上」是一个毛病。
       * 用启动脚本（cmd /c start.bat）起的服务器同理。
       */
      const script = [
        `$targets = @(${pids.join(',')})`,
        '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime',
        '$map = @{}',
        'foreach ($p in $all) { $map[[int]$p.ProcessId] = $p }',
        'foreach ($t in $targets) {',
        '  $mem = 0; $cpu = 0',
        '  $queue = New-Object System.Collections.Queue',
        '  $queue.Enqueue([int]$t)',
        '  while ($queue.Count -gt 0) {',
        '    $cur = $queue.Dequeue()',
        '    $p = $map[$cur]',
        '    if ($p -eq $null) { continue }',
        '    $mem += $p.WorkingSetSize',
        '    $cpu += ($p.KernelModeTime + $p.UserModeTime)',
        '    foreach ($c in $all) { if ([int]$c.ParentProcessId -eq $cur) { $queue.Enqueue([int]$c.ProcessId) } }',
        '  }',
        '  "$t|$mem|$($cpu / 10000000)"',
        '}'
      ].join('; ')
      const res = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 12000
      })
      const byPid = new Map<number, ProcStat>()
      for (const row of res.stdout.split(/\r?\n/)) {
        const parts = row.trim().split('|')
        if (parts.length < 3) continue
        const pid = Number(parts[0])
        const mem = Number(parts[1])
        const cpuSec = Number(parts[2])
        if (!Number.isFinite(pid) || !Number.isFinite(mem)) continue
        byPid.set(pid, { mem, cpu: Number.isFinite(cpuSec) ? cpuSec : 0 })
      }
      for (const [id, p] of this.procs) {
        const pid = p.child?.pid
        if (pid && byPid.has(pid)) stats[id] = byPid.get(pid)!
      }
    } else {
      for (const [id, p] of this.procs) {
        const pid = p.child?.pid
        if (!pid) continue
        try {
          const st = await fs.readFile(`/proc/${pid}/stat`, 'utf-8')
          stats[id] = { mem: 0, cpu: Number(st.split(' ')[13]) / 100 }
        } catch {
          /* ignore */
        }
      }
    }

    this.lastStats = stats
    this.events.onStats(stats)
  }

  getStats(): Record<string, ProcStat> {
    return this.lastStats
  }

  // ---------- EULA ----------

  async acceptEula(id: string): Promise<boolean> {
    const cfg = this.store.getServer(id)
    if (!cfg?.dir) return false
    try {
      await fs.writeFile(
        join(cfg.dir, 'eula.txt'),
        `# 由 CraftDesk 生成，同意后即表示你接受 Minecraft EULA (https://aka.ms/MinecraftEULA)\neula=true\n`,
        'utf-8'
      )
      const p = this.ensure(id)
      p.issue = null
      p.issueDetail = ''
      this.emitStatus(id)
      return true
    } catch {
      return false
    }
  }

  /** 应用退出时确保所有子进程被回收 */
  async dispose(): Promise<void> {
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    const pids: number[] = []
    for (const p of this.procs.values()) {
      if (p.child?.pid) {
        p.intentionalStop = true
        pids.push(p.child.pid)
      }
    }
    for (const pid of pids) await this.killTree(pid)
  }
}
