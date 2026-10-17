import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { useStore } from '../store'
import type { PlayerRecord, ServerView } from '../../../shared/types'

/**
 * 头像只在第一次打开面板时下载，之后在同一次运行里直接复用；
 * 磁盘缓存由主进程负责（7 天）。
 */
const AVATAR_MEMO = new Map<string, string | null>()

function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 34% 34%)`
}

export function PlayersPanel({ server }: { server: ServerView }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [players, setPlayers] = useState<PlayerRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [newName, setNewName] = useState('')
  const [avatars, setAvatars] = useState<Record<string, string | null>>({})

  const onlineCount = server.runtime.onlineCount

  const load = useCallback(async (): Promise<void> => {
    const res = await window.api.players.list(server.id)
    setLoading(false)
    if (res.ok) setPlayers(res.data!)
    else toast(res.error ?? '读取玩家数据失败', 'error')
  }, [server.id, toast])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load, onlineCount])

  // 玩家列表出来后异步补头像；取不到就保持首字母占位
  useEffect(() => {
    let alive = true
    if (!players.length) {
      setAvatars({})
      return
    }
    const list = players.slice(0, 200)
    const known: Record<string, string | null> = {}
    let need = false
    for (const p of list) {
      if (AVATAR_MEMO.has(p.name)) known[p.name] = AVATAR_MEMO.get(p.name) ?? null
      else need = true
    }
    setAvatars((prev) => ({ ...prev, ...known }))
    if (!need) return

    void window.api.players
      .avatars(
        server.id,
        list.map((p) => ({ name: p.name, uuid: p.uuid }))
      )
      .then((res) => {
        if (!alive || !res.ok) return
        for (const [name, url] of Object.entries(res.data!)) AVATAR_MEMO.set(name, url)
        setAvatars(
          Object.fromEntries(list.map((p) => [p.name, AVATAR_MEMO.get(p.name) ?? null]))
        )
      })
    return () => {
      alive = false
    }
  }, [players, server.id])

  const act = async (
    kind: 'op' | 'whitelist' | 'ban',
    name: string,
    value: boolean
  ): Promise<void> => {
    const api = window.api.players
    const res =
      kind === 'op'
        ? await api.setOp(server.id, name, value)
        : kind === 'whitelist'
          ? await api.setWhitelist(server.id, name, value)
          : await api.setBanned(server.id, name, value)
    if (!res.ok) toast(res.error ?? '操作失败', 'error')
    else void load()
  }

  const filtered = players.filter(
    (p) => !query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase())
  )

  return (
    <>
      <div className="panel-search">
        <Icon name="search" size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索玩家"
          spellCheck={false}
        />
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px' }}>
        <input
          className="input"
          style={{ height: 30, fontSize: 12.5 }}
          value={newName}
          placeholder="输入玩家名添加"
          spellCheck={false}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key !== 'Enter' || !newName.trim()) return
            await act('whitelist', newName.trim(), true)
            setNewName('')
          }}
        />
        <button
          className="btn sm"
          disabled={!newName.trim()}
          title="加入白名单"
          onClick={async () => {
            await act('whitelist', newName.trim(), true)
            setNewName('')
          }}
        >
          <Icon name="user-plus" size={14} />
          加白名单
        </button>
      </div>

      <div className="panel-scroll">
        {loading && <div className="panel-empty">正在读取…</div>}
        {!loading && filtered.length === 0 && (
          <div className="panel-empty">
            {query ? '没有匹配的玩家' : '还没有玩家记录。\n玩家进入服务器后会出现在这里。'}
          </div>
        )}

        {filtered.map((p) => (
          <div className="row" key={p.name}>
            {avatars[p.name] ? (
              <img
                className="player-avatar"
                src={avatars[p.name]!}
                alt=""
                draggable={false}
                title={`${p.name} 的头像`}
              />
            ) : (
              <span
                className="player-avatar player-avatar-fallback"
                style={{ background: avatarColor(p.name) }}
                title={p.name}
              >
                {p.name.slice(0, 2).toUpperCase()}
              </span>
            )}
            <div className="row-main">
              <div className="row-title">
                {p.name}
                {p.online && <span className="tag green">在线</span>}
                {p.op && <span className="tag orange">OP</span>}
                {p.whitelisted && <span className="tag blue">白名单</span>}
                {p.banned && <span className="tag red">已封禁</span>}
              </div>
              {p.uuid && <div className="row-sub">{p.uuid}</div>}
            </div>
            <div className="row-actions">
              <button
                className={`btn sm ghost ${p.op ? 'primary' : ''}`}
                title={p.op ? '取消 OP' : '设为 OP'}
                onClick={() => void act('op', p.name, !p.op)}
              >
                <Icon name="shield" size={14} />
              </button>
              <button
                className="btn sm ghost"
                title={p.whitelisted ? '移出白名单' : '加入白名单'}
                style={p.whitelisted ? { color: 'var(--accent)' } : undefined}
                onClick={() => void act('whitelist', p.name, !p.whitelisted)}
              >
                <Icon name="check" size={14} />
              </button>
              <button
                className="btn sm ghost"
                title={p.banned ? '解除封禁' : '封禁'}
                style={p.banned ? { color: 'var(--danger)' } : undefined}
                onClick={() => void act('ban', p.name, !p.banned)}
              >
                <Icon name="ban" size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
