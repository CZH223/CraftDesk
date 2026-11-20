import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { Icon } from '../components/Icon'
import { Confirm } from '../components/ui'
import { MapExportDialog } from '../components/MapExportDialog'
import { MapPlayerPanel } from '../components/MapPlayerPanel'
import { useStore } from '../store'
import type {
  MapDimensionInfo,
  MapOverview,
  MapPlayerPosition,
  MapRegionRef,
  ServerView,
  WorldMapInfo
} from '../../../shared/types'

/**
 * 世界地图。
 *
 * 渲染全部走 <canvas>：拖动和缩放只重画一帧，不创建 / 移动上百个 DOM 节点。
 * 主进程把每个 region 渲染成 1:1 的 PNG，一次解析同时产出 1/2/3/4 倍降采样；
 * 这里按当前缩放挑一张画上去，图片只解码一次、缓存在内存里。
 *
 * 平移 / 缩放期间不提交 React 状态：中心点与比例放在 ref 里，由
 * requestAnimationFrame 直接重画；每 90ms 才同步一次给状态，用来补加载新瓦片。
 * 玩家位置每 4 秒更新一次，跟随模式下用缓动动画把镜头移过去。
 */

const REGION = 512
const MIN_SCALE = 0.0015
const MAX_SCALE = 4
const MAX_LOAD = 72
const MAX_DRAW = 240
const TILE_CACHE = 96
/** 一个 region 在屏幕上小于这个像素数时，改画「一个 region 一个像素」的总览 */
const OVERVIEW_PX = 10
const MAX_DPR = 2
const PLAYER_HEAD = 34

type AvatarShape = 'circle' | 'square'

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
const keyOf = (dim: string, r: MapRegionRef, step: number): string =>
  `${dim}:${r.rx}:${r.rz}:${step}`

/**
 * 缩放级别 → 瓦片分辨率。
 * 放大时 1 像素 1 格；缩小时按 2×2 / 3×3 / 4×4 格合并。
 */
function stepForScale(scale: number): number {
  if (scale >= 1) return 1
  if (scale >= 1 / 2) return 2
  if (scale >= 1 / 3) return 3
  return 4
}

interface Hover {
  x: number
  z: number
  y: number | null
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function initialsColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 42% 34%)`
}

/** 头像标记：底部是地图上的实际坐标，头 / 名字 / 指针向上叠 */
function drawPlayer(
  ctx: CanvasRenderingContext2D,
  player: MapPlayerPosition,
  left: number,
  top: number,
  scale: number,
  shape: AvatarShape,
  avatar: HTMLImageElement | undefined
): void {
  const px = (player.x - left) * scale
  const pz = (player.z - top) * scale
  if (px < -80 || pz < -110 || px > ctx.canvas.width + 80 || pz > ctx.canvas.height + 80) {
    return
  }

  const half = PLAYER_HEAD / 2
  const pinTop = pz - 7
  const nameBottom = pinTop - 2
  const nameHeight = 16
  const nameTop = nameBottom - nameHeight
  const headBottom = nameTop - 2
  const headCy = headBottom - half

  ctx.save()
  ctx.imageSmoothingEnabled = true
  ctx.font =
    '600 10.5px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // 名字底色
  const nameWidth = Math.ceil(ctx.measureText(player.name).width) + 10
  roundRectPath(ctx, px - nameWidth / 2, nameTop, nameWidth, nameHeight, 6)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.68)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.fillText(player.name, px, nameTop + nameHeight / 2 + 0.5)

  // 指针
  ctx.beginPath()
  ctx.moveTo(px, pz)
  ctx.lineTo(px - 5, pinTop)
  ctx.lineTo(px + 5, pinTop)
  ctx.closePath()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.94)'
  ctx.fill()

  const headLeft = px - half
  const headTop = headCy - half

  // 外描边与投影
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
  ctx.shadowBlur = 10
  ctx.shadowOffsetY = 3
  if (shape === 'circle') {
    ctx.beginPath()
    ctx.arc(px, headCy, half, 0, Math.PI * 2)
  } else {
    roundRectPath(ctx, headLeft, headTop, PLAYER_HEAD, PLAYER_HEAD, 5)
  }
  ctx.fillStyle = '#1a1a1e'
  ctx.fill()
  ctx.restore()

  // 头像本体（圆形或圆角方形裁剪）
  ctx.save()
  if (shape === 'circle') {
    ctx.beginPath()
    ctx.arc(px, headCy, half, 0, Math.PI * 2)
  } else {
    roundRectPath(ctx, headLeft, headTop, PLAYER_HEAD, PLAYER_HEAD, 5)
  }
  ctx.clip()
  if (avatar?.complete && avatar.naturalWidth) {
    ctx.drawImage(avatar, headLeft, headTop, PLAYER_HEAD, PLAYER_HEAD)
  } else {
    ctx.fillStyle = initialsColor(player.name)
    ctx.fillRect(headLeft, headTop, PLAYER_HEAD, PLAYER_HEAD)
    ctx.fillStyle = '#fff'
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif'
    ctx.fillText(player.name.slice(0, 2).toUpperCase(), px, headCy + 0.5)
  }
  ctx.restore()

  // 白色外圈
  ctx.beginPath()
  if (shape === 'circle') ctx.arc(px, headCy, half, 0, Math.PI * 2)
  else roundRectPath(ctx, headLeft, headTop, PLAYER_HEAD, PLAYER_HEAD, 5)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.94)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.restore()
}

export function MapView({ server }: { server: ServerView }): JSX.Element {
  const viewRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [info, setInfo] = useState<WorldMapInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dimId, setDimId] = useState<MapDimensionInfo['id']>('overworld')
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [scale, setScale] = useState(1)
  const [center, setCenter] = useState({ x: 0, z: 0 })
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [pending, setPending] = useState(0)
  const [hover, setHover] = useState<Hover | null>(null)
  const [dragging, setDragging] = useState(false)
  const [allPlayers, setAllPlayers] = useState<MapPlayerPosition[]>([])
  const [playerAvatars, setPlayerAvatars] = useState<Record<string, string | null>>({})
  const [rconAsk, setRconAsk] = useState(false)
  const [overviews, setOverviews] = useState<Record<string, MapOverview>>({})
  const [overviewBusy, setOverviewBusy] = useState(false)
  const [jumpX, setJumpX] = useState('')
  const [jumpZ, setJumpZ] = useState('')
  const [follow, setFollow] = useState('off')
  const [playersOpen, setPlayersOpen] = useState(true)
  const [exportOpen, setExportOpen] = useState(false)
  const [avatarShape, setAvatarShape] = useState<AvatarShape>(() => {
    try {
      return localStorage.getItem('craftdesk.map.avatarShape') === 'square' ? 'square' : 'circle'
    } catch {
      return 'circle'
    }
  })
  const toast = useStore((s) => s.toast)

  const overviewTried = useRef(new Set<string>())
  const loadingRef = useRef(new Set<string>())
  const failedRef = useRef(new Set<string>())
  const visibleKeysRef = useRef(new Set<string>())
  const activeRef = useRef(0)
  const aliveRef = useRef(true)
  const dragRef = useRef<{ sx: number; sy: number; cx: number; cz: number; scale: number } | null>(
    null
  )
  const hoverAt = useRef(0)
  const lastHover = useRef(0)
  const lastCommit = useRef(0)
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 平移 / 缩放的真实来源；React 状态只是低频同步，用于触发瓦片加载
  const centerRef = useRef(center)
  const scaleRef = useRef(scale)
  const layoutRef = useRef({ left: 0, top: 0 })

  /** 已经解码 / 正在解码的瓦片；key 与后端缓存命名一致 */
  const tileImages = useRef(new Map<string, HTMLImageElement>())
  const loadedRef = useRef(new Set<string>())
  const avatarImages = useRef(new Map<string, HTMLImageElement>())
  const overviewImages = useRef(new Map<string, HTMLImageElement>())

  const drawRef = useRef<() => void>(() => {})
  const rafRef = useRef(0)
  const animRef = useRef<{
    fromX: number
    fromZ: number
    toX: number
    toZ: number
    start: number
    dur: number
  } | null>(null)

  const scheduleDraw = useCallback((): void => {
    if (!aliveRef.current || rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      drawRef.current()
    })
  }, [])

  const dim = useMemo(
    () => info?.dimensions.find((d) => d.id === dimId) ?? null,
    [info, dimId]
  )
  const mapPlayers = useMemo(
    () => allPlayers.filter((p) => p.dimension === dimId),
    [allPlayers, dimId]
  )

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (wheelTimer.current) clearTimeout(wheelTimer.current)
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('craftdesk.map.avatarShape', avatarShape)
    } catch {
      /* 隐私模式忽略 */
    }
    scheduleDraw()
  }, [avatarShape, scheduleDraw])

  const applyView = useCallback(
    (x: number, z: number, nextScale = scaleRef.current): void => {
      centerRef.current = { x, z }
      scaleRef.current = nextScale
      setCenter({ x, z })
      setScale(nextScale)
      scheduleDraw()
    },
    [scheduleDraw]
  )

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
      tileImages.current.clear()
      loadedRef.current.clear()
      failedRef.current.clear()
      loadingRef.current.clear()
      overviewImages.current.clear()
      animRef.current = null
      setFailed(new Set())
      setOverviews({})
      setPending(0)
      setAllPlayers([])
      setPlayerAvatars({})
      overviewTried.current.clear()
      if (data.exists) {
        const first = data.dimensions.find((d) => d.id === 'overworld') ?? data.dimensions[0]
        setDimId(first.id)
        const spawn = data.spawn ?? { x: 0, z: 0 }
        applyView(spawn.x, spawn.z, 1)
        setHover(null)
        setFollow('off')
      }
    },
    [server.id, applyView]
  )

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

  // 换到只有下界 / 末地的存档时，把选中的维度纠正到存在的那个
  useEffect(() => {
    if (info?.exists && !info.dimensions.some((d) => d.id === dimId)) {
      setDimId(info.dimensions[0].id)
    }
  }, [info, dimId])

  const step = stepForScale(scale)
  const overviewMode = Boolean(dim) && REGION * scale < OVERVIEW_PX

  // 视口里能看到的方块范围（用于按需加载；绘制时用 ref 再算一次）
  const left = center.x - size.w / 2 / scale
  const top = center.z - size.h / 2 / scale
  const right = center.x + size.w / 2 / scale
  const bottom = center.z + size.h / 2 / scale

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

  // ---------------------------------------------------------------- 绘制
  const draw = useCallback((): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !dim) return

    // 跟随玩家时做缓动；每帧更新 ref，不触发 React 渲染
    const anim = animRef.current
    if (anim) {
      const t = Math.min(1, (performance.now() - anim.start) / anim.dur)
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      centerRef.current = {
        x: anim.fromX + (anim.toX - anim.fromX) * e,
        z: anim.fromZ + (anim.toZ - anim.fromZ) * e
      }
      if (t >= 1) {
        animRef.current = null
        setCenter(centerRef.current)
      } else {
        scheduleDraw()
      }
    }

    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    const w = Math.max(1, size.w)
    const h = Math.max(1, size.h)
    const bw = Math.round(w * dpr)
    const bh = Math.round(h * dpr)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const c = centerRef.current
    const s = scaleRef.current
    const viewLeft = c.x - w / 2 / s
    const viewTop = c.z - h / 2 / s
    layoutRef.current = { left: viewLeft, top: viewTop }

    const overview = REGION * s < OVERVIEW_PX
    if (overview) {
      const ov = overviews[dim.id]
      const img = overviewImages.current.get(dim.id)
      if (ov && img?.complete && img.naturalWidth) {
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(
          img,
          (ov.minX - viewLeft) * s,
          (ov.minZ - viewTop) * s,
          (ov.maxX - ov.minX + 1) * s,
          (ov.maxZ - ov.minZ + 1) * s
        )
      }
    } else {
      const drawStep = stepForScale(s)
      const px = REGION * s
      // 瓦片本身已经降采样过，放大时不要再平滑；缩小时平滑一点更自然
      ctx.imageSmoothingEnabled = s < 1
      let drawn = 0
      for (const r of dim.regions) {
        const x = (r.rx * REGION - viewLeft) * s
        const z = (r.rz * REGION - viewTop) * s
        if (x + px < 0 || z + px < 0 || x > w || z > h) continue
        if (drawn++ >= MAX_DRAW) break
        const img = tileImages.current.get(keyOf(dim.id, r, drawStep))
        if (img?.complete && img.naturalWidth) {
          // 瓦片里 alpha = 0 的格子就是虚空 / 没有地表，保持透明，
          // 不要用总览色或占位色盖住它
          ctx.drawImage(img, x, z, px, px)
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.028)'
          ctx.fillRect(x + 0.5, z + 0.5, px - 1, px - 1)
        }
      }
    }

    // 玩家标记：始终在当前维度、头像大小不随缩放变化
    for (const player of allPlayers) {
      if (player.dimension !== dim.id) continue
      const url = playerAvatars[player.name]
      drawPlayer(
        ctx,
        player,
        viewLeft,
        viewTop,
        s,
        avatarShape,
        url ? avatarImages.current.get(url) : undefined
      )
    }
  }, [
    dim,
    size,
    overviews,
    allPlayers,
    playerAvatars,
    avatarShape,
    scheduleDraw
  ])

  useEffect(() => {
    drawRef.current = draw
    scheduleDraw()
  }, [draw, scheduleDraw])

  // ---------------------------------------------------------------- 跟随在线玩家
  const animateTo = useCallback(
    (x: number, z: number): void => {
      const from = centerRef.current
      if (Math.abs(from.x - x) < 0.5 && Math.abs(from.z - z) < 0.5) return
      animRef.current = {
        fromX: from.x,
        fromZ: from.z,
        toX: x,
        toZ: z,
        start: performance.now(),
        dur: 650
      }
      scheduleDraw()
    },
    [scheduleDraw]
  )

  useEffect(() => {
    if (follow === 'off' || !allPlayers.length) return
    const target =
      follow === 'auto'
        ? allPlayers.find((p) => p.dimension === dimId) ?? allPlayers[0]
        : allPlayers.find((p) => p.name === follow)
    if (!target) {
      if (follow !== 'auto') setFollow('off')
      return
    }
    if (target.dimension !== dimId) {
      const targetDim = info?.dimensions.find((d) => d.id === target.dimension)
      if (!targetDim) return
      setDimId(targetDim.id)
      return
    }
    if (scaleRef.current < 0.5) {
      scaleRef.current = 1
      setScale(1)
    }
    animateTo(target.x, target.z)
  }, [follow, allPlayers, dimId, info, animateTo])

  // ---------------------------------------------------------------- 瓦片加载
  useEffect(() => {
    if (!dim || overviewMode || !visible.length) return
    visibleKeysRef.current = new Set(visible.map((r) => keyOf(dim.id, r, step)))

    const needed = visible
      .slice(0, MAX_LOAD)
      .filter((r) => {
        const k = keyOf(dim.id, r, step)
        return !loadedRef.current.has(k) && !loadingRef.current.has(k) && !failedRef.current.has(k)
      })
    if (!needed.length) return

    const evict = (): void => {
      while (tileImages.current.size > TILE_CACHE) {
        let victim = ''
        for (const key of tileImages.current.keys()) {
          if (!visibleKeysRef.current.has(key)) {
            victim = key
            break
          }
        }
        if (!victim) break
        tileImages.current.delete(victim)
        loadedRef.current.delete(victim)
      }
    }

    const install = (key: string, url: string): void => {
      loadedRef.current.add(key)
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => scheduleDraw()
      img.onerror = () => {
        loadedRef.current.delete(key)
        tileImages.current.delete(key)
        failedRef.current.add(key)
        setFailed(new Set(failedRef.current))
        scheduleDraw()
      }
      img.src = url
      tileImages.current.set(key, img)
      evict()
    }

    let index = 0
    const worker = async (): Promise<void> => {
      while (index < needed.length) {
        if (!aliveRef.current) return
        // 与主进程的 4 个 worker 对齐；多出来的 worker 退出，等下一轮状态更新再继续
        if (activeRef.current >= 4) return
        const r = needed[index++]
        const k = keyOf(dim.id, r, step)
        loadingRef.current.add(k)
        activeRef.current++
        setPending((p) => p + 1)
        const res = await window.api.map.tile(server.id, dim.id, r.rx, r.rz, step)
        loadingRef.current.delete(k)
        activeRef.current--
        if (!aliveRef.current) return
        setPending((p) => Math.max(0, p - 1))
        if (res.ok && res.data) {
          install(k, res.data.png)
        } else {
          failedRef.current.add(k)
          setFailed(new Set(failedRef.current))
        }
      }
    }
    void Promise.all([worker(), worker(), worker(), worker()])
  }, [dim, visible, server.id, step, overviewMode, scheduleDraw])

  // ---------------------------------------------------------------- 缩到最小时的总览
  useEffect(() => {
    if (!dim || !overviewMode) return
    if (overviews[dim.id] || overviewTried.current.has(dim.id)) return
    overviewTried.current.add(dim.id)
    setOverviewBusy(true)
    void window.api.map.overview(server.id, dim.id).then((res) => {
      setOverviewBusy(false)
      if (!res.ok) {
        toast(res.error ?? '生成区域总览失败', 'error')
        return
      }
      setOverviews((prev) => ({ ...prev, [dim.id]: res.data! }))
    })
  }, [dim, overviewMode, overviews, server.id, toast])

  useEffect(() => {
    for (const [id, ov] of Object.entries(overviews)) {
      if (overviewImages.current.has(id)) continue
      const img = new Image()
      img.onload = () => scheduleDraw()
      img.src = ov.png
      overviewImages.current.set(id, img)
    }
    scheduleDraw()
  }, [overviews, scheduleDraw])

  // 头像图片只在第一次出现时解码
  useEffect(() => {
    for (const url of Object.values(playerAvatars)) {
      if (!url || avatarImages.current.has(url)) continue
      const img = new Image()
      img.onload = () => scheduleDraw()
      img.src = url
      avatarImages.current.set(url, img)
    }
    scheduleDraw()
  }, [playerAvatars, scheduleDraw])

  // ---------------------------------------------------------------- 在线玩家
  const serverLive =
    server.runtime.externalRunning ||
    (server.runtime.status !== 'stopped' && server.runtime.status !== 'crashed')
  useEffect(() => {
    if (!dim) {
      setAllPlayers([])
      return
    }
    // 即使界面认为服务器没在跑也问一次：外部启动的服务端可能刚开、或者状态还没刷新；
    // RCON 开着时，即使 CraftDesk 没托管进程也能读到位置
    const shouldPoll = serverLive || server.runtime.onlineCount > 0
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null

    const tick = async (): Promise<void> => {
      const res = await window.api.map.players(server.id)
      if (!alive || !res.ok) return
      const all = res.data ?? []
      setAllPlayers(all)
      if (!all.length) return
      const av = await window.api.players.avatars(
        server.id,
        all.map((p) => ({ name: p.name, uuid: p.uuid }))
      )
      if (alive && av.ok) setPlayerAvatars((prev) => ({ ...prev, ...av.data! }))
    }

    void tick()
    if (shouldPoll) timer = setInterval(() => void tick(), 4000)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [server.id, dim?.id, serverLive, server.runtime.onlineCount])

  // ---------------------------------------------------------------- 交互
  const probeHeight = useCallback(
    (x: number, z: number): void => {
      if (!dim) return
      const now = Date.now()
      if (now - hoverAt.current < 120) return
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
    if (!rect) return { x: Math.round(centerRef.current.x), z: Math.round(centerRef.current.z) }
    const c = centerRef.current
    const s = scaleRef.current
    return {
      x: Math.floor(c.x + (clientX - rect.left - rect.width / 2) / s),
      z: Math.floor(c.z + (clientY - rect.top - rect.height / 2) / s)
    }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    if (follow !== 'off') setFollow('off')
    animRef.current = null
    dragRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      cx: centerRef.current.x,
      cz: centerRef.current.z,
      scale: scaleRef.current
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    setHover(null)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (d) {
      const c = {
        x: d.cx - (e.clientX - d.sx) / d.scale,
        z: d.cz - (e.clientY - d.sy) / d.scale
      }
      centerRef.current = c
      scheduleDraw()
      const now = performance.now()
      // 状态只用来补加载瓦片，90ms 同步一次足够；画面本身每帧都在动
      if (now - lastCommit.current > 90) {
        lastCommit.current = now
        setCenter(c)
      }
      return
    }

    const now = performance.now()
    if (now - lastHover.current < 90) return
    lastHover.current = now
    const p = pointToBlock(e.clientX, e.clientY)
    setHover((h) => (h && h.x === p.x && h.z === p.z ? h : { ...p, y: null }))
    probeHeight(p.x, p.z)
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    setCenter(centerRef.current)
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
      const s0 = scaleRef.current
      const c0 = centerRef.current
      const bx = c0.x + (mx - rect.width / 2) / s0
      const bz = c0.z + (my - rect.height / 2) / s0
      const next = clamp(s0 * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE)
      if (Math.abs(next - s0) / s0 < 0.0005) return
      const c = {
        x: bx - (mx - rect.width / 2) / next,
        z: bz - (my - rect.height / 2) / next
      }
      scaleRef.current = next
      centerRef.current = c
      scheduleDraw()
      // 缩放停下来后再同步状态，切 step / 补瓦片；期间画面已经即时缩放了
      if (wheelTimer.current) clearTimeout(wheelTimer.current)
      wheelTimer.current = setTimeout(() => {
        setScale(scaleRef.current)
        setCenter(centerRef.current)
      }, 90)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [scheduleDraw])

  const zoomAtCenter = (factor: number): void => {
    const next = clamp(scaleRef.current * factor, MIN_SCALE, MAX_SCALE)
    scaleRef.current = next
    setScale(next)
    scheduleDraw()
  }

  /** 坐标跳转：把视口中心移到指定方块坐标 */
  const jumpTo = (): void => {
    const x = Number(jumpX.trim())
    const z = Number(jumpZ.trim())
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      toast('请输入有效的 X / Z 坐标', 'error')
      return
    }
    setFollow('off')
    applyView(x, z, scaleRef.current < 0.5 ? 1 : scaleRef.current)
    setHover(null)
  }

  const fit = (): void => {
    if (!dim) return
    const b = dim.coreBounds
    const w = Math.max(1, b.maxX - b.minX)
    const h = Math.max(1, b.maxZ - b.minZ)
    const next = clamp(Math.min((size.w - 48) / w, (size.h - 48) / h), MIN_SCALE, 1)
    applyView((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, next)
  }

  const zoomLabel = overviewMode
    ? '1 px = 1 区域'
    : step === 1
      ? `${scale.toFixed(1)}× · 1 px = 1 格`
      : `1 px ≈ ${step}×${step} 格`

  return (
    <div className="map-page">
      <div className="map-bar">
        <div className="map-dims">
          {info?.dimensions.map((d) => (
            <button
              key={d.id}
              className={`chip-btn ${d.id === dimId ? 'active' : ''}`}
              onClick={() => {
                setFollow('off')
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

        <div className="map-jump" title="输入方块坐标并跳转">
          <input
            className="input"
            placeholder="X"
            value={jumpX}
            onChange={(e) => setJumpX(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && jumpTo()}
          />
          <input
            className="input"
            placeholder="Z"
            value={jumpZ}
            onChange={(e) => setJumpZ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && jumpTo()}
          />
          <button className="btn sm" onClick={jumpTo}>
            前往
          </button>
        </div>

        {(serverLive || allPlayers.length > 0) && (
          <span
            className="map-live"
            title={
              server.runtime.externalRunning
                ? '外部启动：坐标来自 latest.log 的登录位置；开启 enable-rcon=true 后可读取实时坐标'
                : '每 4 秒通过服务端指令读取一次位置'
            }
          >
            <span className={`dot ${allPlayers.length ? 'running' : 'stopped'}`} />
            {server.runtime.externalRunning
              ? allPlayers.length
                ? `在线位置 ${mapPlayers.length}`
                : '外部启动 · 开启 RCON 可读位置'
              : `在线位置 ${mapPlayers.length}${
                  allPlayers.length > mapPlayers.length ? ` / 共 ${allPlayers.length}` : ''
                }`}
          </span>
        )}

        {allPlayers.length > 0 && (
          <>
            <select
              className="select map-follow"
              value={follow}
              onChange={(e) => setFollow(e.target.value)}
              title="自动把镜头移到在线玩家身上"
            >
              <option value="off">不跟随玩家</option>
              <option value="auto">自动定位在线玩家</option>
              {allPlayers.map((p) => (
                <option key={p.name} value={p.name}>
                  跟随 {p.name}
                </option>
              ))}
            </select>
            {follow === 'off' && (
              <button className="btn sm" onClick={() => setFollow('auto')} title="定位在线玩家">
                定位玩家
              </button>
            )}
          </>
        )}

        <div className="map-shape" title="玩家头像形状">
          <button
            className={`chip-btn ${avatarShape === 'circle' ? 'active' : ''}`}
            onClick={() => setAvatarShape('circle')}
            title="圆形头像"
          >
            ●
          </button>
          <button
            className={`chip-btn ${avatarShape === 'square' ? 'active' : ''}`}
            onClick={() => setAvatarShape('square')}
            title="方形头像"
          >
            ■
          </button>
        </div>

        {serverLive &&
          allPlayers.length === 0 &&
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
              setFollow('off')
              applyView(info?.spawn?.x ?? 0, info?.spawn?.z ?? 0, 1)
            }}
          >
            出生点
          </button>
          <button className="btn sm" onClick={fit}>
            适应
          </button>
          <button
            className="btn sm"
            title="导出当前维度：全图或按独立区域分块"
            onClick={() => setExportOpen(true)}
            disabled={!dim}
          >
            导出地图
          </button>
          <button
            className={`btn sm ${playersOpen ? 'primary' : ''}`}
            title="显示 / 隐藏右侧玩家列表"
            onClick={() => setPlayersOpen((v) => !v)}
          >
            玩家列表
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

      <div className="map-body">
        <div
          className={`map-view ${dragging ? 'dragging' : ''}`}
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
            <canvas ref={canvasRef} className="map-canvas" aria-label="世界地图" />

            {overviewMode && !overviews[dim.id] && (
              <div className="map-overview-state">
                {overviewBusy ? (
                  <>
                    <span className="spin small" />
                    正在生成区域总览…
                  </>
                ) : (
                  '这个缩放下没有可显示的区域'
                )}
              </div>
            )}

            {!overviewMode && visible.length > MAX_DRAW && (
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

        {playersOpen && (
          <MapPlayerPanel
            server={server}
            players={allPlayers}
            avatars={playerAvatars}
            following={follow}
            avatarShape={avatarShape}
            onFollow={(name) => setFollow(name)}
            onStop={() => setFollow('off')}
            onClose={() => setPlayersOpen(false)}
          />
        )}
      </div>

      {exportOpen && dim && (
        <MapExportDialog
          serverId={server.id}
          dim={dim.id}
          dimLabel={dim.label}
          onClose={() => setExportOpen(false)}
        />
      )}

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
