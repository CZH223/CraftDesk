import { create } from 'zustand'
import type {
  AppSettings,
  Topology,
  DownloadProgress,
  JavaInfo,
  LogLine,
  PythonInfo,
  ServerRuntime,
  ServerView
} from '../../shared/types'

export type ViewKey =
  | 'dashboard'
  | 'topology'
  | 'console'
  | 'properties'
  | 'registry'
  | 'settings'
export type PanelKey = 'files' | 'players' | 'plugins' | 'configs' | 'backups'

export interface Toast {
  id: number
  text: string
  type: 'info' | 'error' | 'success'
}

export interface ReadTextResult {
  content: string
  size: number
  truncated: boolean
  binary: boolean
}

interface State {
  ready: boolean
  servers: ServerView[]
  settings: AppSettings | null
  javaList: JavaInfo[]
  /** 机器上的 Python，以及每个里面 mcdreforged 的版本（MCDR 靠它跑） */
  pythonList: PythonInfo[]
  stats: Record<string, { mem: number; cpu: number }>

  activeId: string | null
  view: ViewKey
  panel: PanelKey
  panelOpen: boolean
  listCollapsed: boolean

  /** 代理端与后端的从属关系，左侧列表和拓扑视图都用它 */
  topology: Topology | null
  loadTopology: () => Promise<void>

  logs: Record<string, LogLine[]>
  toasts: Toast[]
  downloads: Record<string, DownloadProgress>

  /** 每个服务器的动画时钟，用于刷新运行时长 */
  now: number

  /** 背景图读不出来时的原因（路径被删、格式变了），空串表示没问题 */
  backgroundError: string

  init: () => Promise<void>
  refresh: () => Promise<void>
  /** 重新扫描 Python（设置里点「重新检测」、装完 MCDR 之后都要来一次） */
  refreshPython: (path?: string) => Promise<PythonInfo[]>
  applyRuntime: (id: string, runtime: ServerRuntime) => void
  pushLogs: (id: string, lines: LogLine[]) => void
  loadLogs: (id: string) => Promise<void>

  select: (id: string | null) => void
  setView: (v: ViewKey) => void
  setPanel: (p: PanelKey) => void
  togglePanel: () => void
  toggleList: () => void

  toast: (text: string, type?: Toast['type']) => void
  dismissToast: (id: number) => void
  setDownload: (p: DownloadProgress | null) => void
}

let toastSeq = 0

export const useStore = create<State>((set, get) => ({
  ready: false,
  servers: [],
  settings: null,
  javaList: [],
  pythonList: [],
  stats: {},
  activeId: null,
  view: 'console',
  panel: 'files',
  panelOpen: true,
  listCollapsed: false,
  topology: null,
  logs: {},
  toasts: [],
  downloads: {},
  now: Date.now(),
  backgroundError: '',

  init: async () => {
    const [serversRes, settingsRes] = await Promise.all([
      window.api.servers.list(),
      window.api.settings.get()
    ])

    const servers = serversRes.ok ? serversRes.data! : []
    const settings = settingsRes.ok ? settingsRes.data! : null

    set({
      servers,
      settings,
      javaList: settings?.javaList ?? [],
      pythonList: settings?.pythonList ?? [],
      ready: true,
      activeId: servers.length ? servers[0].id : null
    })

    if (servers.length) void get().loadLogs(servers[0].id)
    void get().loadTopology()

    // 后台探测 Java，不阻塞界面
    void window.api.java.detect().then((res) => {
      if (res.ok) set({ javaList: res.data!, settings: { ...get().settings!, javaList: res.data! } })
    })
    // Python 只在用到 MCDR 时才要紧，安静地扫一遍就行（扫一次要跑几个进程）
    void get().refreshPython()
  },

  refreshPython: async (path) => {
    const res = await window.api.python.detect(path)
    if (!res.ok) return []
    set((s) => ({
      pythonList: res.data!,
      settings: s.settings
        ? {
            ...s.settings,
            pythonList: res.data!,
            // 主进程在没有默认值时会把第一个填上，界面跟着显示，免得
            // 设置页写着「未设置」而实际用的是列表里那个
            pythonPath: s.settings.pythonPath || res.data![0]?.path || ''
          }
        : s.settings
    }))
    return res.data!
  },

  refresh: async () => {
    const res = await window.api.servers.list()
    if (!res.ok) return
    const servers = res.data!
    set((s) => ({
      servers,
      // 当前选中的那台可能刚被删掉：换一台，别让主区域停在已经不存在的服务器上
      activeId:
        s.activeId && servers.some((x) => x.id === s.activeId)
          ? s.activeId
          : (servers[0]?.id ?? null)
    }))
    void get().loadTopology()
  },

  loadTopology: async () => {
    const res = await window.api.topology.get()
    if (res.ok) set({ topology: res.data! })
  },

  applyRuntime: (id, runtime) => {
    set((s) => ({
      servers: s.servers.map((sv) => (sv.id === id ? { ...sv, runtime } : sv))
    }))
  },

  pushLogs: (id, lines) => {
    set((s) => {
      const cur = s.logs[id] ?? []
      const next = cur.length ? [...cur, ...lines] : lines
      // 渲染层只保留最近 2000 行，主进程那边另有更长的缓冲
      const capped = next.length > 2000 ? next.slice(next.length - 2000) : next
      return { logs: { ...s.logs, [id]: capped } }
    })
  },

  loadLogs: async (id) => {
    if (get().logs[id]?.length) return
    const res = await window.api.server.logs(id)
    if (res.ok) set((s) => ({ logs: { ...s.logs, [id]: res.data! } }))
  },

  select: (id) => {
    if (!id) {
      set({ activeId: null })
      return
    }
    set({ activeId: id, panelOpen: true })
    void get().loadLogs(id)
  },

  setView: (view) => set({ view }),
  setPanel: (panel) => set({ panel, panelOpen: true }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  toggleList: () => set((s) => ({ listCollapsed: !s.listCollapsed })),

  toast: (text, type = 'info') => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, text, type }] }))
    setTimeout(() => get().dismissToast(id), type === 'error' ? 6000 : 3500)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setDownload: (p) => {
    if (!p) return
    set((s) => {
      const downloads = { ...s.downloads }
      if (p.stage === 'done' || p.stage === 'error') {
        delete downloads[p.taskId]
      } else {
        downloads[p.taskId] = p
      }
      return { downloads }
    })
  }
}))

/** 便捷选择器：当前选中的服务器 */
export function useActiveServer(): ServerView | null {
  return useStore((s) => s.servers.find((x) => x.id === s.activeId) ?? null)
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'starting':
      return '启动中'
    case 'stopping':
      return '停止中'
    case 'crashed':
      return '已崩溃'
    default:
      return '已停止'
  }
}
