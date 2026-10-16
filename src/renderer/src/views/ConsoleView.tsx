import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { useStore } from '../store'
import { formatBytes, formatDuration, formatClock, statusLabel } from '../utils'
import type { LogLine, ServerView } from '../../../shared/types'

const QUICK_COMMANDS = [
  { cmd: 'list', label: 'list', tip: '查看在线玩家' },
  { cmd: 'tps', label: 'tps', tip: '查看服务器 TPS' },
  { cmd: 'save-all', label: 'save-all', tip: '立即保存世界' },
  { cmd: 'time set day', label: '白天', tip: '把时间设为白天' },
  { cmd: 'weather clear', label: '晴天', tip: '清除天气' },
  { cmd: 'reload', label: 'reload', tip: '重载插件配置' }
]

export function ConsoleView({ server }: { server: ServerView }): JSX.Element {
  const logs = useStore((s) => s.logs[server.id])
  const stats = useStore((s) => s.stats[server.id])
  const toast = useStore((s) => s.toast)
  const pushLogs = useStore((s) => s.pushLogs)
  const topology = useStore((s) => s.topology)

  const [input, setInput] = useState('')
  const [filter, setFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [tick, setTick] = useState(0)
  const [showErrorsOnly, setShowErrorsOnly] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const rt = server.runtime
  const running = rt.status !== 'stopped' && rt.status !== 'crashed'

  // 运行时长每秒刷新
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setTick((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  const uptime = useMemo(() => {
    void tick
    if (!rt.startedAt) return 0
    return Math.floor((Date.now() - rt.startedAt) / 1000)
  }, [rt.startedAt, tick])

  const visible = useMemo(() => {
    const list = logs ?? []
    const q = filter.trim().toLowerCase()
    return list.filter((l) => {
      if (showErrorsOnly && l.level !== 'error' && l.level !== 'warn') return false
      if (!q) return true
      return l.text.toLowerCase().includes(q) || l.raw.toLowerCase().includes(q)
    })
  }, [logs, filter, showErrorsOnly])

  // 贴底时才自动滚动，用户往上翻的时候不打断
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !autoScroll) return
    el.scrollTop = el.scrollHeight
  }, [visible.length, autoScroll, server.id])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }

  const send = async (cmd?: string): Promise<void> => {
    const text = (cmd ?? input).trim()
    if (!text) return
    if (!running) {
      toast('服务器未运行，无法发送指令', 'error')
      return
    }
    const res = await window.api.server.command(server.id, text)
    if (!res.ok) toast(res.error ?? '发送失败', 'error')
    if (!cmd) setInput('')
  }

  /** 把这台代理端下面、当前没在跑的后端都启动起来 */
  const startBackends = async (): Promise<void> => {
    const proxy = topology?.proxies.find((p) => p.node.id === server.id)
    const stopped = (proxy?.backends ?? []).filter((b) => b.managed && !b.running).map((b) => b.id)
    if (!stopped.length) {
      toast('没有找到可启动的后端', 'info')
      return
    }
    for (const bid of stopped) {
      const res = await window.api.server.start(bid)
      if (!res.ok) toast(res.error ?? '启动失败', 'error')
    }
    void useStore.getState().refresh()
  }

  const acceptEula = async (): Promise<void> => {
    const res = await window.api.server.acceptEula(server.id)
    if (res.ok) {
      toast('已同意 EULA，现在可以启动了', 'success')
      pushLogs(server.id, [
        {
          t: Date.now(),
          level: 'system',
          text: '已写入 eula=true，可以重新启动服务器',
          raw: 'eula accepted'
        }
      ])
    } else {
      toast(res.error ?? '写入失败', 'error')
    }
  }

  return (
    <div className="console">
      <div className="console-toolbar">
        {running ? (
          <>
            <span className="stat-pill">
              <span className={`dot ${rt.status}`} />
              {statusLabel(rt.status)}
            </span>
            <span className="stat-pill">
              <Icon name="clock" size={13} />
              运行 <b>{formatDuration(uptime)}</b>
            </span>
            {stats && stats.mem > 0 && (
              <span className="stat-pill">
                <Icon name="cpu" size={13} />
                内存 <b>{formatBytes(stats.mem)}</b>
              </span>
            )}
            <span className="stat-pill">
              <Icon name="users" size={13} />
              在线 <b>{rt.onlineCount}</b>/{rt.maxPlayers}
            </span>
            {rt.tps != null && (
              <span className="stat-pill">
                <Icon name="activity" size={13} />
                TPS <b>{rt.tps.toFixed(1)}</b>
              </span>
            )}
            {rt.port != null && (
              <span
                className="stat-pill"
                title="点击复制端口号"
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  void navigator.clipboard.writeText(String(rt.port))
                  toast(`已复制端口 ${rt.port}`, 'success')
                }}
              >
                <Icon name="globe" size={13} />
                端口 <b>{rt.port}</b>
              </span>
            )}
            {rt.pid != null && (
              <span
                className="stat-pill"
                title="点击复制进程号"
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  void navigator.clipboard.writeText(String(rt.pid))
                  toast(`已复制 PID ${rt.pid}`, 'success')
                }}
              >
                PID <b>{rt.pid}</b>
              </span>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--text-faint)' }}>
            {rt.status === 'crashed'
              ? `上次异常退出（退出码 ${rt.exitCode ?? '未知'}）`
              : '服务器未运行'}
          </span>
        )}

        <div className="toolbar-spacer" />

        <button
          className={`icon-btn ${showErrorsOnly ? 'active' : ''}`}
          title="只看警告与错误"
          onClick={() => setShowErrorsOnly((v) => !v)}
        >
          <Icon name="alert" size={15} />
        </button>
        <div className="panel-search" style={{ margin: 0, height: 28, width: 180 }}>
          <Icon name="search" size={13} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选日志"
            spellCheck={false}
            style={{ fontSize: 12.5 }}
          />
        </div>
        <button
          className="icon-btn"
          title="滚动到底部"
          style={{ color: autoScroll ? 'var(--accent)' : undefined }}
          onClick={() => {
            setAutoScroll(true)
            const el = scrollRef.current
            if (el) el.scrollTop = el.scrollHeight
          }}
        >
          <Icon name="chevron-down" size={16} />
        </button>
        <button
          className="icon-btn"
          title="清空当前显示"
          onClick={() => {
            void window.api.server.clearLogs(server.id)
            useStore.setState((s) => ({ logs: { ...s.logs, [server.id]: [] } }))
          }}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>

      {rt.issue === 'eula' && (
        <div className="issue-bar">
          <Icon name="alert" size={16} />
          <span className="issue-text">
            服务器需要你同意 Minecraft EULA 才能启动。同意后会在服务端目录写入 eula.txt。
          </span>
          <button className="btn sm primary" onClick={() => void acceptEula()}>
            同意并写入
          </button>
          <button
            className="btn sm ghost"
            onClick={() => void window.api.app.openExternal('https://aka.ms/MinecraftEULA')}
          >
            查看条款
          </button>
        </div>
      )}

      {rt.issue === 'port-in-use' && (
        <div className="issue-bar error">
          <Icon name="alert" size={16} />
          <span className="issue-text">端口被占用，请到「服务器属性」里换一个 server-port。</span>
          <button
            className="btn sm"
            onClick={() => useStore.getState().setView('properties')}
          >
            去修改
          </button>
        </div>
      )}

      {rt.issue === 'java-missing' && (
        <div className="issue-bar error">
          <Icon name="alert" size={16} />
          <span className="issue-text">{rt.issueDetail || '没有可用的 Java 运行环境。'}</span>
          <button className="btn sm" onClick={() => useStore.getState().setView('settings')}>
            去设置
          </button>
        </div>
      )}

      {rt.issue === 'mcdr-running' && (
        <div className="issue-bar error">
          <Icon name="alert" size={16} />
          <span className="issue-text">{rt.issueDetail}</span>
          <button className="btn sm" onClick={() => void window.api.fs.reveal(server.dir, 'logs')}>
            打开日志目录
          </button>
        </div>
      )}

      {/*
        后端没起来是最容易吓人的一种：代理端日志里是一屏 Netty 堆栈，
        看着像代理端自己炸了，其实只是后端没开。
      */}
      {rt.issue === 'backend-down' && (
        <div className="issue-bar error">
          <Icon name="alert" size={16} />
          <span className="issue-text">{rt.issueDetail || '后端没有在运行。'}</span>
          <button className="btn sm primary" onClick={() => void startBackends()}>
            启动后端
          </button>
          <button className="btn sm" onClick={() => useStore.getState().setView('topology')}>
            看拓扑
          </button>
        </div>
      )}

      {/* 崩溃原因。日志里认出来的（jar 坏了、jar 找不到）在这里说清楚，
          没认出来的就只有退出码，至少把码给出来 */}
      {(rt.issue === 'crash' || (rt.status === 'crashed' && !rt.issue)) && (
        <div className="issue-bar error">
          <Icon name="alert" size={16} />
          <span className="issue-text">
            {rt.issueDetail ||
              (rt.exitCode != null ? `服务器异常退出，退出码 ${rt.exitCode}` : '服务器异常退出')}
          </span>
          <button className="btn sm" onClick={() => void window.api.fs.reveal(server.dir, '')}>
            打开目录
          </button>
        </div>
      )}

      <div className="console-scroll" ref={scrollRef} onScroll={onScroll}>
        {visible.length === 0 && (
          <div className="console-empty">
            {running ? '等待服务器输出…' : '还没有日志。启动服务器后这里会显示实时输出。'}
          </div>
        )}
        {visible.map((line, i) => (
          <LogRow key={`${line.t}-${i}`} line={line} highlight={filter.trim()} />
        ))}
      </div>

      <div className="quick-cmds">
        {QUICK_COMMANDS.map((q) => (
          <button
            key={q.cmd}
            className="quick-cmd"
            title={q.tip}
            disabled={!running}
            style={!running ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
            onClick={() => void send(q.cmd)}
          >
            {q.label}
          </button>
        ))}
      </div>

      <div className="composer">
        <div className={`composer-box ${!running ? 'disabled' : ''}`}>
          <textarea
            ref={inputRef}
            className="composer-input"
            placeholder={running ? '输入服务器指令，回车发送…' : '服务器未运行时无法发送指令'}
            value={input}
            disabled={!running}
            rows={1}
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="composer-row">
            <span className="composer-hint">
              {running
                ? '提示：list 看在线玩家，tps 看性能，save-all 立即存档'
                : '先点右上角的「启动」按钮把服务器开起来'}
            </span>
            <button
              className="send-btn"
              disabled={!running || !input.trim()}
              onClick={() => void send()}
              title="发送指令（回车）"
            >
              <Icon name="send" size={15} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function LogRow({ line, highlight }: { line: LogLine; highlight: string }): JSX.Element {
  const text = line.player ? (
    <>
      <span className="log-player">&lt;{line.player}&gt;</span> {line.text}
    </>
  ) : (
    line.text
  )

  return (
    <div className={`log-line log-${line.level}`}>
      <span className="log-time">{formatClock(line.t)}</span>
      <span className="log-text">
        {highlight ? <Highlighted text={line.text} needle={highlight} /> : text}
      </span>
    </div>
  )
}

/** 简单的关键词高亮，不做正则以免用户输入特殊字符出错 */
function Highlighted({ text, needle }: { text: string; needle: string }): JSX.Element {
  const lower = text.toLowerCase()
  const n = needle.toLowerCase()
  const parts: JSX.Element[] = []
  let i = 0
  let key = 0
  while (i < text.length) {
    const at = lower.indexOf(n, i)
    if (at < 0 || !n) {
      parts.push(<span key={key++}>{text.slice(i)}</span>)
      break
    }
    if (at > i) parts.push(<span key={key++}>{text.slice(i, at)}</span>)
    parts.push(
      <span className="log-hl" key={key++}>
        {text.slice(at, at + n.length)}
      </span>
    )
    i = at + n.length
  }
  return <>{parts}</>
}
