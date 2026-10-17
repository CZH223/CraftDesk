import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { Icon } from '../components/Icon'
import { Confirm } from '../components/ui'
import { useStore } from '../store'
import type {
  MapDimensionInfo,
  MapPlayerPosition,
  MapRegionRef,
  ServerView,
  WorldMapInfo
} from '../../../shared/types'

/**
 * 世界地图。
 *
 * 主进程把每个 region 渲染成 512×512 的 PNG（1 像素 = 1 方块），
 * 这里只做摆放、平移与缩放：位置按「方块坐标 → 屏幕像素」算，
 * 瓦片本身不做 transform，放大时用 image-rendering: pixelated 保持方块边缘。
 *
 * 世界可能很大（这个存档有几百个 region），所以只加载视口附近的瓦片，
 * 远处的先留占位方块。拖动、缩放时瓦片会按需补上。
 */

const REGION = 512
const MIN_SCALE = 0.03
const MAX_SCALE = 4
const MAX_LOAD = 64
const MAX_DRAW = 220
const TILE_CACHE = 120

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
const keyOf = (dim: string, r: MapRegionRef): string => `${dim}:${r.rx}:${r.rz}`

interface Hover {
  x: number
  z: number
  y: number | null
}

export function MapView({ server }: { server: ServerView }): JSX.Element {
  const viewRef = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState<WorldMapInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dimId, setDimId] = useState<MapDimensionInfo['id']>('overworld')
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [scale, setScale] = useState(1)
  const [center, setCenter] = useState({ x: 0, z: 0 })
  const [tiles, setTiles] = useState<Map<string, string>>(() => new Map())
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [pending, setPending] = useState(0)
  const [hover, setHover] = useState<Hover | null>(null)
  const [dragging, setDragging] = useState(false)
  const [mapPlayers, setMapPlayers] = useState<MapPlayerPosition[]>([])
  const [playerAvatars, setPlayerAvatars] = useState<Record<string, string | null>>({})
  const [liveCount, setLiveCount] = useState(0)
  const [rconAsk, setRconAsk] = useState(false)
  const toast = useStore((s) => s.toast)

  const loadingRef = useRef(new Set<string>())
  const failedRef = useRef(new Set<string>())
  const visibleKeysRef = useRef(new Set<string>())
  const activeRef = useRef(0)
  const aliveRef = useRef(true)
  const dragRef = useRef<{ sx: number; sy: number; cx: number; cz: number } | null>(null)
  const hoverAt = useRef(0)

  const loadInfo = useCallback(
    async (refresh = false): Promise<void> => {
      setLoading(true)
      setError('')
      if (refresh) await window.api.map.clear(server.id)
      const res = await window.api.map.info(server.id)
      setLoading(false)
      if (!res.ok) {
        setError(res.error ?? '读取世界存档失败')
        return
      }
      const data = res.data!
      setInfo(data)
      setTiles(new Map())
      setFailed(new Set())
      loadingRef.current.clear()
      failedRef.current.clear()
      if (data.exists) {
        const first =
          data.dimensions.find((d) => d.id === 'overworld') ?? data.dimensions[0]
        setDimId(first.id)
        const spawn = data.spawn ?? { x: 0, z: 0 }
        setCenter(spawn)
        setScale(1)
        setHover(null)
      }
    },
    [server.id]
  )

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    void loadInfo()
  }, [loadInfo])

  useEffect(() => {
    const el = viewRef.current
    if (!el) return
    const sync = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    sync()
    return () => ro.disconnect()
  }, [])

  const dim = useMemo(
    () => info?.dimensions.find((d) => d.id === dimId) ?? null,
    [info, dimId]
  )

  // 换到只有下界/末地的存档时，把选中的维度纠正到存在的那个
  useEffect(() => {
    if (info?.exists && !info.dimensions.some((d) => d.id === dimId)) {
      setDimId(info.dimensions[0].id)
    }
  }, [info, dimId])

  // 视口里能看到的方块范围
  const left = center.x - size.w / 2 / scale
  const top = center.z - size.h / 2 / scale
  const right = center.x + size.w / 2 / scale
  const bottom = center.z + size.h / 2 / scale

  /** 视口内的区域，按离视口中心的距离排序 */
  const visible = useMemo(() => {
    if (!dim) return [] as (MapRegionRef & { w: number })[]
    const out: (MapRegionRef & { w: number })[] = []
    for (const r of dim.regions) {
      const x0 = r.rx * REGION
      const z0 = r.rz * REGION
      if (x0 + REGION < left || x0 > right || z0 + REGION < top || z0 > bottom) continue
      const dx = x0 + REGION / 2 - center.x
      const dz = z0 + REGION / 2 - center.z
      out.push({ ...r, w: dx * dx + dz * dz })
    }
    out.sort((a, b) => a.w - b.w)
    return out
  }, [dim, left, right, top, bottom, center.x, center.z])

  // ---- 按需拉取视口里的瓦片；同一块最多同时请求一次
  useEffect(() => {
    if (!dim || !visible.length) return
    visibleKeysRef.current = new Set(visible.map((r) => keyOf(dim.id, r)))

    const needed = visible
      .slice(0, MAX_LOAD)
      .filter((r) => {
        const k = keyOf(dim.id, r)
        return !tiles.has(k) && !loadingRef.current.has(k) && !failedRef.current.has(k)
      })
    if (!needed.length) return

    let index = 0
    const worker = async (): Promise<void> => {
      while (index < needed.length) {
        // 全局最多 3 个请求在飞；多出来的 worker 直接退出，瓦片回来后
        // 状态更新会再触发一次这个 effect
        if (!aliveRef.current) return
        if (activeRef.current >= 3) return
        const r = needed[index++]
        const k = keyOf(dim.id, r)
        loadingRef.current.add(k)
        activeRef.current++
        setPending((p) => p + 1)
        const res = await window.api.map.tile(server.id, dim.id, r.rx, r.rz)
        loadingRef.current.delete(k)
        activeRef.current--
        if (!aliveRef.current) return
        setPending((p) => Math.max(0, p - 1))
        if (res.ok && res.data) {
          const png = res.data.png
          setTiles((prev) => {
            const next = new Map(prev)
            next.set(k, png)
            // 给内存设个上限：优先丢掉当前视口外的、最早加载的瓦片
            while (next.size > TILE_CACHE) {
              let victim = ''
              for (const key of next.keys()) {
                if (!visibleKeysRef.current.has(key)) {
                  victim = key
                  break
                }
              }
              if (!victim) break
              next.delete(victim)
            }
            return next
          })
        } else {
          failedRef.current.add(k)
          setFailed(new Set(failedRef.current))
        }
      }
    }
    void Promise.all([worker(), worker(), worker()])
  }, [dim, visible, tiles, server.id])

  // ---- 在线玩家位置：地图开着时才向服务端轮询，关掉就停
  const serverLive =
    server.runtime.externalRunning ||
    (server.runtime.status !== 'stopped' && server.runtime.status !== 'crashed')
  useEffect(() => {
    // 即使界面认为服务器没在跑也问一次：外部启动的服务端可能刚开、或者状态还没刷新，
    // 主进程那边会在拿不到 stdin/RCON 时快速返回空列表。
    const shouldPoll = serverLive || server.runtime.onlineCount > 0
    if (!dim || !shouldPoll) {
      setMapPlayers([])
      setLiveCount(0)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null

    const tick = async (): Promise<void> => {
      const res = await window.api.map.players(server.id)
      if (!alive || !res.ok) return
      const all = res.data ?? []
      setLiveCount(all.length)
      const list = all.filter((p) => p.dimension === dim.id)
      setMapPlayers(list)
      if (!list.length) return
      const av = await window.api.players.avatars(
        server.id,
        list.map((p) => ({ name: p.name, uuid: p.uuid }))
      )
      if (alive && av.ok) setPlayerAvatars((prev) => ({ ...prev, ...av.data! }))
    }

    void tick()
    timer = setInterval(() => void tick(), 4000)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [server.id, dim?.id, serverLive, server.runtime.onlineCount])

  // ---- 从高度缓存里读鼠标所在方块的地表 Y
  const probeHeight = useCallback(
    (x: number, z: number): void => {
      if (!dim) return
      const now = Date.now()
      if (now - hoverAt.current < 90) return
      hoverAt.current = now
      void window.api.map.height(server.id, dim.id, x, z).then((res) => {
        if (!res.ok) return
        setHover((h) => (h && h.x === x && h.z === z ? { ...h, y: res.data ?? null } : h))
      })
    },
    [dim, server.id]
  )

  const pointToBlock = (clientX: number, clientY: number): { x: number; z: number } => {
    const rect = viewRef.current?.getBoundingClientRect()
    if (!rect) return { x: Math.round(center.x), z: Math.round(center.z) }
    return {
      x: Math.floor(left + (clientX - rect.left) / scale),
      z: Math.floor(top + (clientY - rect.top) / scale)
    }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, cx: center.x, cz: center.z }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const p = pointToBlock(e.clientX, e.clientY)
    setHover((h) => (h && h.x === p.x && h.z === p.z ? h : { ...p, y: null }))
    probeHeight(p.x, p.z)
    const d = dragRef.current
    if (d) {
      setCenter({
        x: d.cx - (e.clientX - d.sx) / scale,
        z: d.cz - (e.clientY - d.sy) / scale
      })
    }
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // React 的 onWheel 在某些环境里是 passive 的，preventDefault 会失效，用原生监听
  useEffect(() => {
    const el = viewRef.current
    if (!el) return
    const handler = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const bx = center.x + (mx - rect.width / 2) / scale
      const bz = center.z + (my - rect.height / 2) / scale
      const next = clamp(scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE)
      if (Math.abs(next - scale) / scale < 0.0005) return
      setScale(next)
      setCenter({
        x: bx - (mx - rect.width / 2) / next,
        z: bz - (my - rect.height / 2) / next
      })
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [center, scale])

  const zoomAtCenter = (factor: number): void => {
    setScale((s) => clamp(s * factor, MIN_SCALE, MAX_SCALE))
  }

  const fit = (): void => {
    if (!dim) return
    const b = dim.coreBounds
    const w = Math.max(1, b.maxX - b.minX)
    const h = Math.max(1, b.maxZ - b.minZ)
    const next = clamp(Math.min((size.w - 48) / w, (size.h - 48) / h), MIN_SCALE, 1)
    setScale(next)
    setCenter({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 })
  }

  const zoomLabel =
    scale >= 1 ? `${scale.toFixed(1)}×` : `${(1 / scale).toFixed(1)} 格/px`

  return (
    <div className="map-page">
      <div className="map-bar">
        <div className="map-dims">
          {info?.dimensions.map((d) => (
            <button
              key={d.id}
              className={`chip-btn ${d.id === dimId ? 'active' : ''}`}
              onClick={() => {
                setDimId(d.id)
                setHover(null)
              }}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="map-readout">
          <span>X {hover?.x ?? Math.round(center.x)}</span>
          <span>Z {hover?.z ?? Math.round(center.z)}</span>
          <span>Y {hover?.y ?? '—'}</span>
        </div>

        {(serverLive || mapPlayers.length > 0) && (
          <span
            className="map-live"
            title={
              server.runtime.externalRunning
                ? '外部启动的服务端需要在 server.properties 里开启 enable-rcon=true 才能读取坐标；或者改用 CraftDesk 启动服务器'
                : '每 4 秒通过服务端指令读取一次位置'
            }
          >
            <span className={`dot ${mapPlayers.length ? 'running' : 'stopped'}`} />
            {server.runtime.externalRunning
              ? mapPlayers.length
                ? `在线位置 ${mapPlayers.length}`
                : '外部启动 · 开启 RCON 可读位置'
              : `在线位置 ${mapPlayers.length}${liveCount > mapPlayers.length ? ` / 共 ${liveCount}` : ''}`}
          </span>
        )}

        {serverLive &&
          liveCount === 0 &&
          (server.mcdr || server.runtime.externalRunning || server.runtime.onlineCount > 0) && (
            <button
              className="btn sm"
              title="写入 enable-rcon=true，重启服务器后即可读取玩家坐标"
              onClick={() => setRconAsk(true)}
            >
              开启 RCON
            </button>
          )}

        <div className="map-tools">
          {pending > 0 && (
            <span className="map-pending">
              <span className="spin small" />
              正在渲染 {pending} 块
            </span>
          )}
          {failed.size > 0 && (
            <span className="map-failed" title="可能是区域文件损坏，或用了不支持的压缩方式">
              {failed.size} 块读取失败
            </span>
          )}
          <button className="btn sm" title="缩小" onClick={() => zoomAtCenter(1 / 1.5)}>
            −
          </button>
          <span className="map-scale">{zoomLabel}</span>
          <button className="btn sm" title="放大" onClick={() => zoomAtCenter(1.5)}>
            ＋
          </button>
          <button
            className="btn sm"
            title="回到世界出生点，1 像素 = 1 方块"
            onClick={() => {
              setCenter(info?.spawn ?? { x: 0, z: 0 })
              setScale(1)
            }}
          >
            出生点
          </button>
          <button className="btn sm" onClick={fit}>
            适应
          </button>
          <button
            className="btn sm"
            title="清除缓存并重新扫描世界"
            onClick={() => void loadInfo(true)}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </div>

      <div
        className={`map-view ${dragging ? 'dragging' : ''} ${scale >= 1 ? 'sharp' : ''}`}
        ref={viewRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
      >
        {loading ? (
          <div className="center-state" style={{ minHeight: 260 }}>
            <div className="spin" />
            <div>正在扫描世界存档…</div>
          </div>
        ) : error ? (
          <div className="center-state" style={{ minHeight: 260 }}>
            <div>{error}</div>
          </div>
        ) : !info?.exists || !dim ? (
          <div className="center-state" style={{ minHeight: 260 }}>
            <div>没有找到世界存档</div>
            <div className="hint" style={{ maxWidth: 520, textAlign: 'center' }}>
              地图读取的是服务端目录下的 <code>world/region/*.mca</code>。
              这台服务器还没有生成世界，或者世界目录不在默认位置。
            </div>
          </div>
        ) : (
          <>
            {visible.slice(0, MAX_DRAW).map((r) => {
              const k = keyOf(dim.id, r)
              const src = tiles.get(k)
              const px = REGION * scale
              const style: CSSProperties = {
                left: Math.floor((r.rx * REGION - left) * scale),
                top: Math.floor((r.rz * REGION - top) * scale),
                width: Math.ceil(px) + 1,
                height: Math.ceil(px) + 1
              }
              return src ? (
                <img
                  key={k}
                  className="map-tile"
                  src={src}
                  alt=""
                  draggable={false}
                  style={style}
                />
              ) : (
                <div key={k} className="map-tile map-tile-pending" style={style} />
              )
            })}
            {mapPlayers.map((p) => {
              const px = (p.x - left) * scale
              const pz = (p.z - top) * scale
              if (px < -60 || pz < -60 || px > size.w + 60 || pz > size.h + 60) return null
              const av = playerAvatars[p.name]
              return (
                <div
                  key={`player:${p.name}`}
                  className="map-player"
                  style={{ left: px, top: pz }}
                  title={`${p.name} · X ${Math.round(p.x)} Y ${Math.round(p.y)} Z ${Math.round(p.z)}`}
                >
                  <span className="map-player-head">
                    {av ? (
                      <img src={av} alt="" draggable={false} />
                    ) : (
                      p.name.slice(0, 2).toUpperCase()
                    )}
                  </span>
                  <span className="map-player-name">{p.name}</span>
                  <span className="map-player-pin" />
                </div>
              )
            })}
            {visible.length > MAX_DRAW && (
              <div className="map-note">
                这个缩放级别下能看到 {visible.length} 个区域，只绘制最近的 {MAX_DRAW} 个；
                放大后会显示更多细节。
              </div>
            )}
            <div className="map-compass" title="上方为北">
              <span>北</span>
              <span className="map-arrow">↑</span>
            </div>
          </>
        )}
      </div>

      {rconAsk && (
        <Confirm
          title="开启 RCON 读取玩家位置？"
          message={
            <div style={{ lineHeight: 1.85 }}>
              会修改这台服务器的 <code>server.properties</code>：
              <code>enable-rcon=true</code>，密码为空时生成一个随机密码。
              RCON 只供本机使用。
              <br />
              <b>需要重启服务器后生效。</b>
            </div>
          }
          confirmText="写入配置"
          onCancel={() => setRconAsk(false)}
          onConfirm={() => {
            setRconAsk(false)
            void (async () => {
              const res = await window.api.map.enableRcon(server.id)
              if (res.ok) {
                toast(
                  `已写入 RCON 配置（端口 ${res.data!.port}），重启服务器后生效`,
                  'success'
                )
              } else {
                toast(res.error ?? '写入配置失败', 'error')
              }
            })()
          }}
        />
      )}
    </div>
  )
}
