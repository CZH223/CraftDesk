import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useStore } from '../store'
import type {
  MapPlayerPosition,
  PlayerItem,
  PlayerProfile,
  PlayerRecord,
  ServerView
} from '../../../shared/types'

/**
 * 地图右侧的在线玩家面板。
 *
 * 点头像 / 整行会选中玩家并让地图跟随；详情来自 playerdata 的最近一次保存：
 * 正版状态、UUID、全身皮肤、经验、背包、装备、末影箱，以及潜影盒 / 收纳袋预览。
 */

const DIMENSION_LABELS: Record<string, string> = {
  overworld: '主世界',
  nether: '下界',
  end: '末地'
}

/** usercache / 白名单里的离线玩家 + 当前在线位置合并后的一行 */
interface PanelPlayer {
  name: string
  uuid?: string
  online: boolean
  op: boolean
  whitelisted: boolean
  banned: boolean
  position?: MapPlayerPosition
}

function dimLabel(dim: string): string {
  return DIMENSION_LABELS[dim] ?? dim
}

function pretty(id: string): string {
  return id.replace(/^.*:/, '').replace(/_/g, ' ')
}

function itemHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

function collectItemIds(item: PlayerItem, out: Set<string>): void {
  out.add(item.id)
  for (const child of item.container ?? []) collectItemIds(child, out)
}

/** 只取顶层物品：潜影盒里的东西等展开预览时再加载 */
function collectTopIds(profile: PlayerProfile): string[] {
  const out = new Set<string>()
  for (const item of profile.inventory) out.add(item.id)
  for (const item of profile.armor) out.add(item.id)
  for (const item of profile.enderItems) out.add(item.id)
  if (profile.offhand) out.add(profile.offhand.id)
  return [...out]
}

function ItemCell({
  item,
  icon,
  onClick
}: {
  item: PlayerItem | null
  icon?: string | null
  onClick?: () => void
}): JSX.Element {
  if (!item) return <div className="mpp-slot empty" />
  return (
    <button
      className={`mpp-slot ${item.container?.length ? 'has-box' : ''}`}
      title={`${pretty(item.id)} ×${item.count}`}
      onClick={onClick}
      type="button"
    >
      {icon ? (
        <img src={icon} alt="" draggable={false} />
      ) : (
        <span
          className="mpp-slot-fallback"
          style={{ background: `hsl(${itemHue(item.id)} 38% 30%)` }}
        >
          {pretty(item.id).slice(0, 2)}
        </span>
      )}
      {item.count > 1 && <b className="mpp-slot-count">{item.count}</b>}
      {item.container?.length ? <i className="mpp-slot-box" /> : null}
    </button>
  )
}

function ItemGrid({
  items,
  slots,
  icons,
  onItem
}: {
  items: PlayerItem[]
  slots: number[]
  icons: Record<string, string | null>
  onItem: (item: PlayerItem) => void
}): JSX.Element {
  const map = useMemo(() => {
    const m = new Map<number, PlayerItem>()
    for (const item of items) m.set(item.slot, item)
    return m
  }, [items])

  return (
    <div className="mpp-grid">
      {slots.map((slot) => {
        const item = map.get(slot) ?? null
        return (
          <ItemCell
            key={slot}
            item={item}
            icon={item ? icons[item.id] : null}
            onClick={item ? () => onItem(item) : undefined}
          />
        )
      })}
    </div>
  )
}

function ContainerPreview({
  item,
  icons,
  onItem
}: {
  item: PlayerItem
  icons: Record<string, string | null>
  onItem: (item: PlayerItem) => void
}): JSX.Element {
  const children = item.container ?? []
  const maxSlot = children.reduce((n, child) => Math.max(n, child.slot), -1)
  const rows = Math.max(3, Math.ceil((maxSlot + 1) / 9))
  const slots = Array.from({ length: rows * 9 }, (_, i) => i)
  return (
    <div className="mpp-container">
      <div className="mpp-container-head">
        <span className="tag">潜影盒 / 收纳袋</span>
        <span className="mpp-container-name">{pretty(item.id)}</span>
        <span className="mpp-muted">{children.length} 格</span>
      </div>
      <ItemGrid items={children} slots={slots} icons={icons} onItem={onItem} />
    </div>
  )
}

export function MapPlayerPanel({
  server,
  players,
  avatars,
  following,
  avatarShape,
  onFollow,
  onStop,
  onClose
}: {
  server: ServerView
  players: MapPlayerPosition[]
  avatars: Record<string, string | null>
  following: string
  avatarShape: 'circle' | 'square'
  onFollow: (name: string) => void
  onStop: () => void
  onClose: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [selected, setSelected] = useState('')
  const [profile, setProfile] = useState<PlayerProfile | null>(null)
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<PlayerItem | null>(null)
  const [roster, setRoster] = useState<PlayerRecord[]>([])
  const [rosterAvatars, setRosterAvatars] = useState<Record<string, string | null>>({})
  const requestSeq = useRef(0)
  const requestedIcons = useRef(new Set<string>())
  const uuidHints = useRef(new Map<string, string>())
  const avatarRequested = useRef(new Set<string>())

  useEffect(() => {
    requestedIcons.current.clear()
    uuidHints.current.clear()
    avatarRequested.current.clear()
    setRosterAvatars({})
    setRoster([])
  }, [server.id])

  // 玩家档案列表（usercache / 白名单 / OP / 封禁）包含未上线玩家；
  // 在线位置单独由 MapView 轮询，这里合并两者。
  useEffect(() => {
    let alive = true
    const loadRoster = async (): Promise<void> => {
      const res = await window.api.players.list(server.id)
      if (alive && res.ok) setRoster(res.data!)
    }
    void loadRoster()
    const timer = setInterval(() => void loadRoster(), 30000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [server.id])

  const merged = useMemo(() => {
    const map = new Map<string, PanelPlayer>()
    const put = (p: PanelPlayer): void => {
      const key = p.name.toLowerCase()
      const prev = map.get(key)
      map.set(key, { ...prev, ...p, name: p.name })
    }
    for (const p of roster) {
      put({
        name: p.name,
        uuid: p.uuid,
        online: p.online,
        op: p.op,
        whitelisted: p.whitelisted,
        banned: p.banned
      })
    }
    for (const p of players) {
      const prev = map.get(p.name.toLowerCase())
      put({
        name: p.name,
        uuid: p.uuid ?? prev?.uuid,
        online: true,
        op: prev?.op ?? false,
        whitelisted: prev?.whitelisted ?? false,
        banned: prev?.banned ?? false,
        position: p
      })
    }
    return [...map.values()].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1
      if (a.op !== b.op) return a.op ? -1 : 1
      if (a.whitelisted !== b.whitelisted) return a.whitelisted ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [roster, players])

  const onlineCount = merged.filter((p) => p.online).length

  useEffect(() => {
    for (const p of merged) {
      if (p.uuid) uuidHints.current.set(p.name.toLowerCase(), p.uuid)
    }
    const need = merged.filter(
      (p) =>
        !avatars[p.name] &&
        !rosterAvatars[p.name] &&
        !avatarRequested.current.has(p.name.toLowerCase())
    )
    if (!need.length) return
    for (const p of need) avatarRequested.current.add(p.name.toLowerCase())
    void window.api.players.avatars(
      server.id,
      need.map((p) => ({ name: p.name, uuid: p.uuid }))
    ).then((res) => {
      if (res.ok) setRosterAvatars((prev) => ({ ...prev, ...res.data! }))
    })
  }, [merged, avatars, rosterAvatars, server.id])

  const avatarFor = (name: string): string | null =>
    avatars[name] ?? rosterAvatars[name] ?? null

  useEffect(() => {
    if (following !== 'off' && following !== 'auto') setSelected(following)
  }, [following])

  const load = useCallback(
    async (name: string): Promise<void> => {
      const seq = ++requestSeq.current
      setLoading(true)
      setError('')
      try {
        const hint = uuidHints.current.get(name.toLowerCase())
        const res = await window.api.players.detail(server.id, name, hint)
        if (seq !== requestSeq.current) return
        if (!res.ok) {
          setError(res.error ?? '读取玩家数据失败')
          return
        }
        const data = res.data!
        setProfile(data)
        // 档案（皮肤 / 正版 / 背包）先显示，图标在后台补，不阻塞面板
        setLoading(false)
        const ids = collectTopIds(data).filter((id) => !requestedIcons.current.has(id))
        if (ids.length) {
          for (const id of ids) requestedIcons.current.add(id)
          const iconRes = await window.api.players.itemIcons(server.id, ids)
          // 图标与具体是哪次档案请求无关，即使 15 秒自动刷新换了 seq 也要应用；
          // 否则第一次慢请求的结果会被下一次刷新丢掉，永远显示占位色块
          if (iconRes.ok) setIcons((prev) => ({ ...prev, ...iconRes.data! }))
        }
      } catch (err) {
        if (seq === requestSeq.current) setError((err as Error).message)
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [server.id]
  )

  useEffect(() => {
    setProfile(null)
    setExpanded(null)
    if (!selected) return
    void load(selected)
    const timer = setInterval(() => void load(selected), 15000)
    return () => clearInterval(timer)
  }, [selected, load])

  // 展开潜影盒 / 收纳袋时，按需补它里面物品的图标
  useEffect(() => {
    if (!expanded?.container?.length) return
    const ids = new Set<string>()
    for (const child of expanded.container) collectItemIds(child, ids)
    const need = [...ids].filter((id) => !requestedIcons.current.has(id))
    if (!need.length) return
    for (const id of need) requestedIcons.current.add(id)
    void window.api.players.itemIcons(server.id, need).then((res) => {
      if (res.ok) setIcons((prev) => ({ ...prev, ...res.data! }))
    })
  }, [expanded, server.id])

  const select = (p: PanelPlayer): void => {
    setSelected(p.name)
    // 离线玩家只展示档案，不去追一个不存在的位置
    if (p.online) onFollow(p.name)
    else onStop()
  }

  const copyUuid = (): void => {
    if (!profile) return
    void navigator.clipboard
      .writeText(profile.uuid)
      .then(() => toast('UUID 已复制', 'success'))
      .catch(() => toast('复制失败', 'error'))
  }

  const mainSlots = useMemo(
    () => [...Array.from({ length: 27 }, (_, i) => i + 9), ...Array.from({ length: 9 }, (_, i) => i)],
    []
  )
  const enderSlots = useMemo(() => Array.from({ length: 27 }, (_, i) => i), [])
  const avatar = selected ? avatarFor(selected) : null
  const online = merged.find((p) => p.name === selected)?.online ?? false
  const savedText = profile?.savedAt
    ? new Date(profile.savedAt).toLocaleString('zh-CN', { hour12: false })
    : '没有找到 playerdata'

  return (
    <aside className="map-player-panel">
      <div className="mpp-head">
        <div className="mpp-title">
          <Icon name="users" size={14} />
          玩家 <span>{merged.length}</span>
          <span className="mpp-online-count">在线 {onlineCount}</span>
        </div>
        <div className="mpp-head-actions">
          {following !== 'off' && (
            <button className="btn sm" onClick={onStop}>
              停止追踪
            </button>
          )}
          <button className="icon-btn" onClick={onClose} title="收起玩家列表">
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>

      <div className="mpp-list">
        {merged.length === 0 ? (
          <div className="mpp-empty">
            还没有玩家记录。服务端生成 usercache / 白名单后，离线玩家也会出现在这里。
          </div>
        ) : (
          merged.map((p) => {
            const active = selected === p.name
            const tracking = following === p.name
            const av = avatarFor(p.name)
            const pos = p.position
            const sub =
              p.online && pos
                ? `${dimLabel(pos.dimension)} · X ${Math.round(pos.x)} Y ${Math.round(pos.y)} Z ${Math.round(pos.z)}`
                : '离线'
            return (
              <button
                key={p.name}
                className={`mpp-row ${active ? 'active' : ''} ${tracking ? 'tracking' : ''}`}
                onClick={() => select(p)}
                title={p.online ? '点击头像追踪这名玩家' : '查看这名离线玩家的信息'}
                type="button"
              >
                <span className={`mpp-avatar ${avatarShape === 'square' ? 'square' : ''}`}>
                  {av ? (
                    <img src={av} alt="" draggable={false} />
                  ) : (
                    p.name.slice(0, 2).toUpperCase()
                  )}
                </span>
                <span className="mpp-row-main">
                  <span className="mpp-row-name">
                    {p.name}
                    {p.op && <em className="mpp-mini-tag">OP</em>}
                  </span>
                  <span className="mpp-row-sub">{sub}</span>
                </span>
                {p.online ? <span className="mpp-online-dot" title="在线" /> : null}
                {tracking && <span className="mpp-track-dot" title="正在追踪" />}
              </button>
            )
          })
        )}
      </div>

      <div className="mpp-detail">
        {!selected ? (
          <div className="mpp-placeholder">
            <Icon name="users" size={28} />
            <div>点击左侧玩家</div>
            <div className="hint">
              查看正版状态、皮肤、经验和背包；在线玩家还会让地图跟随。
            </div>
          </div>
        ) : loading && !profile ? (
          <div className="mpp-placeholder">
            <span className="spin small" />
            <div>正在读取 {selected} 的数据…</div>
          </div>
        ) : error ? (
          <div className="mpp-placeholder">
            <div>{error}</div>
            <button className="btn sm" onClick={() => void load(selected)}>
              重试
            </button>
          </div>
        ) : profile ? (
          <>
            <div className="mpp-profile">
              <div className="mpp-skin-wrap">
                {profile.skin ? (
                  <img className="mpp-skin" src={profile.skin} alt="" draggable={false} />
                ) : avatar ? (
                  <img className="mpp-skin-head" src={avatar} alt="" draggable={false} />
                ) : (
                  <div className="mpp-skin-empty">?</div>
                )}
              </div>
              <div className="mpp-profile-main">
                <div className="mpp-player-name">
                  {profile.name}
                  {!online && <span className="tag">已离线</span>}
                </div>
                <div className="mpp-badges">
                  {profile.premium === true ? (
                    <span className="tag green">正版</span>
                  ) : profile.premium === false ? (
                    <span className="tag">离线 / 非正版</span>
                  ) : (
                    <span className="tag">正版状态未知</span>
                  )}
                  <span className="tag">Lv.{profile.xpLevel}</span>
                  <span className="tag">{dimLabel(profile.dimension)}</span>
                </div>
                <button className="mpp-uuid" onClick={copyUuid} title="点击复制 UUID">
                  <code>{profile.uuid}</code>
                  <span>复制</span>
                </button>
                {profile.premiumUuid && profile.premiumUuid !== profile.uuid && (
                  <div className="mpp-premium-uuid">
                    正版 UUID：<code>{profile.premiumUuid}</code>
                  </div>
                )}
                <div className="mpp-stats">
                  <span>经验 {profile.xpLevel} 级 · {profile.xpTotal} 点</span>
                  <span>生命 {profile.health}/20 · 饥饿 {profile.food}/20</span>
                </div>
                <button
                  className="btn sm"
                  onClick={() => void load(profile.name)}
                  disabled={loading}
                >
                  <Icon name="refresh" size={12} />
                  {loading ? '刷新中…' : '刷新'}
                </button>
              </div>
            </div>

            <div className="mpp-section">
              <div className="mpp-section-head">
                <span>物品栏</span>
                <span className="mpp-muted">存档：{savedText}</span>
              </div>
              <ItemGrid
                items={profile.inventory}
                slots={mainSlots}
                icons={icons}
                onItem={(item) => setExpanded(item.container ? item : null)}
              />
              <div className="mpp-subhead">装备与副手</div>
              <div className="mpp-equipment">
                {[0, 1, 2, 3].map((i) => {
                  const item = profile.armor[i] ?? null
                  return (
                    <ItemCell
                      key={`armor-${i}`}
                      item={item}
                      icon={item ? icons[item.id] : null}
                      onClick={
                        item?.container ? () => setExpanded(item) : undefined
                      }
                    />
                  )
                })}
                <span className="mpp-equipment-gap" />
                <ItemCell
                  item={profile.offhand}
                  icon={profile.offhand ? icons[profile.offhand.id] : null}
                  onClick={
                    profile.offhand?.container
                      ? () => setExpanded(profile.offhand!)
                      : undefined
                  }
                />
              </div>
            </div>

            <div className="mpp-section">
              <div className="mpp-section-head">
                <span>末影箱</span>
                <span className="mpp-muted">{profile.enderItems.length} 格物品</span>
              </div>
              <ItemGrid
                items={profile.enderItems}
                slots={enderSlots}
                icons={icons}
                onItem={(item) => setExpanded(item.container ? item : null)}
              />
            </div>

            {expanded?.container && (
              <div className="mpp-section">
                <div className="mpp-section-head">
                  <span>容器预览</span>
                  <button className="btn sm" onClick={() => setExpanded(null)}>
                    收起
                  </button>
                </div>
                <ContainerPreview
                  item={expanded}
                  icons={icons}
                  onItem={(item) => {
                    if (item.container) setExpanded(item)
                  }}
                />
              </div>
            )}

            <div className="mpp-note">
              物品数据来自服务器最近一次自动保存；刚拾取 / 移动的物品可能要等下一次保存后才会更新。
            </div>
          </>
        ) : null}
      </div>
    </aside>
  )
}
