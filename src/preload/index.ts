import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  BackendCheck,
  BackupInfo,
  ConfigFile,
  CreateServerRequest,
  DeleteMethod,
  DetectedServer,
  DownloadProgress,
  FileEntry,
  IpcResult,
  InstallRequest,
  JavaInfo,
  LatestModRequest,
  LatestModResult,
  LogLine,
  McmodDownloadList,
  McmodRelationRequest,
  McmodRelations,
  McmodSearchHit,
  ModCompat,
  ModCompatItem,
  McdrPlugin,
  McdrRelease,
  NetworkPlan,
  RegistryHit,
  RegistrySource,
  RegistryVersion,
  PlayerRecord,
  PluginCounts,
  PluginInfo,
  PythonInfo,
  PropertiesEntry,
  ServerConfig,
  ServerDeleteMode,
  ServerLayoutInfo,
  ServerRuntime,
  ServerStatus,
  ServerView,
  MapExportEstimate,
  MapExportProgress,
  MapExportResult,
  MapOverview,
  MapPlayerPosition,
  MapTileResult,
  PlayerProfile,
  NetworkJoinResult,
  Topology,
  VelocityFile,
  WorldMapInfo,
  VelocityUpdate
} from '../shared/types'

type Sender = (...args: unknown[]) => void

function on(channel: string, cb: Sender): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** 与主进程 sources.ts 里的 SOURCES 保持一致 */
const SOURCE_LIST: { key: RegistrySource; label: string; hint: string }[] = [
  { key: 'modrinth', label: 'Modrinth', hint: '模组与插件，API 最完整' },
  { key: 'hangar', label: 'Hangar', hint: 'Paper 官方插件站' },
  { key: 'spigot', label: 'SpigotMC', hint: '老牌插件站，Spigot 自托管的资源无法自动下载' },
  { key: 'curseforge', label: 'CurseForge', hint: '模组为主，需要自备 API Key' },
  { key: 'mcdr', label: 'MCDR 插件', hint: 'MCDReforged 的 Python 插件' }
]

export interface AppInfo {
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
  userData: string
  /** 便携模式下配置在 exe 旁边 */
  portable: boolean
  /** 为什么选了这个数据目录 */
  dataNote: string
  home: string
  cpus: number
  totalMem: number
  startedAt: number
}

export interface ReadTextResult {
  content: string
  size: number
  truncated: boolean
  binary: boolean
}

export interface DirSizeResult {
  bytes: number
  files: number
  /** 超出时间预算，是估算值而非精确值 */
  partial: boolean
}

const api = {
  servers: {
    list: (): Promise<IpcResult<ServerView[]>> => ipcRenderer.invoke('servers:list'),
    stats: (): Promise<IpcResult<Record<string, { mem: number; cpu: number }>>> =>
      ipcRenderer.invoke('servers:stats'),
    detect: (dir: string): Promise<IpcResult<DetectedServer>> =>
      ipcRenderer.invoke('servers:detect', dir),
    /**
     * 扫一个代理端目录：它配置里的后端有哪些、各自能不能在磁盘上找到。
     * 跨服网络要一次导一组，界面靠它列出可勾选的清单。
     */
    scanNetwork: (dir: string): Promise<IpcResult<NetworkPlan>> =>
      ipcRenderer.invoke('servers:scanNetwork', dir),
    add: (dir: string, config: Partial<ServerConfig>): Promise<IpcResult<ServerView>> =>
      ipcRenderer.invoke('servers:add', { dir, config }),
    update: (id: string, patch: Partial<ServerConfig>): Promise<IpcResult<ServerView>> =>
      ipcRenderer.invoke('servers:update', id, patch),
    /**
     * 删除服务器。mode='files' 时必须把服务器名字原样传进来，
     * 主进程会再核对一次，对不上就不删。
     */
    delete: (
      id: string,
      mode: ServerDeleteMode,
      confirmName?: string
    ): Promise<IpcResult<{ mode: ServerDeleteMode; removed: boolean }>> =>
      ipcRenderer.invoke('servers:delete', id, mode, confirmName),
    reorder: (ids: string[]): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('servers:reorder', ids),
    /** 每台服务器监听的端口（服务端读 server.properties，代理端读它自己的配置） */
    ports: (): Promise<IpcResult<Record<string, number | null>>> =>
      ipcRenderer.invoke('servers:ports'),
    /** 插件 / 模组数量：决定右侧栏显示哪几个分栏 */
    counts: (id: string): Promise<IpcResult<PluginCounts>> =>
      ipcRenderer.invoke('plugins:counts', id),
    create: (req: CreateServerRequest): Promise<IpcResult<ServerView>> =>
      ipcRenderer.invoke('server:create', req)
  },

  server: {
    start: (id: string): Promise<IpcResult<boolean>> => ipcRenderer.invoke('server:start', id),
    stop: (id: string, force?: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('server:stop', id, force),
    restart: (id: string): Promise<IpcResult<boolean>> => ipcRenderer.invoke('server:restart', id),
    command: (id: string, cmd: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('server:command', id, cmd),
    logs: (id: string): Promise<IpcResult<LogLine[]>> => ipcRenderer.invoke('server:logs', id),
    clearLogs: (id: string): Promise<IpcResult<boolean>> => ipcRenderer.invoke('server:clearLogs', id),
    acceptEula: (id: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('server:acceptEula', id),
    /** 生成 / 重新生成 start.bat，内容取自当前配置 */
    writeStartScript: (id: string): Promise<IpcResult<{ file: string; relPath: string }>> =>
      ipcRenderer.invoke('server:writeStartScript', id)
  },

  settings: {
    get: (): Promise<IpcResult<AppSettings>> => ipcRenderer.invoke('settings:get'),
    patch: (patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>> =>
      ipcRenderer.invoke('settings:patch', patch)
  },

  java: {
    detect: (): Promise<IpcResult<JavaInfo[]>> => ipcRenderer.invoke('java:detect'),
    probe: (path: string): Promise<IpcResult<JavaInfo>> => ipcRenderer.invoke('java:probe', path)
  },

  /**
   * Python 与 MCDReforged。MCDR 不是 jar，它是 Python 程序，
   * 所以「能不能用 MCDR」要问的是 Python：解释器在不在、够不够新、里面装了 mcdreforged 没。
   */
  python: {
    detect: (path?: string): Promise<IpcResult<PythonInfo[]>> =>
      ipcRenderer.invoke('python:detect', path),
    installMcdr: (path: string): Promise<IpcResult<PythonInfo | null>> =>
      ipcRenderer.invoke('python:installMcdr', path)
  },

  fs: {
    list: (root: string, rel: string): Promise<IpcResult<FileEntry[]>> =>
      ipcRenderer.invoke('fs:list', root, rel),
    read: (root: string, rel: string): Promise<IpcResult<ReadTextResult>> =>
      ipcRenderer.invoke('fs:read', root, rel),
    write: (root: string, rel: string, content: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('fs:write', root, rel, content),
    mkdir: (root: string, rel: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('fs:mkdir', root, rel),
    rename: (root: string, rel: string, newName: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('fs:rename', root, rel, newName),
    remove: (root: string, rel: string): Promise<IpcResult<{ how: DeleteMethod }>> =>
      ipcRenderer.invoke('fs:delete', root, rel),
    reveal: (root: string, rel: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('fs:reveal', root, rel),
    dirSize: (root: string, rel: string): Promise<IpcResult<DirSizeResult>> =>
      ipcRenderer.invoke('fs:dirSize', root, rel),
    open: (root: string, rel: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('fs:openPath', root, rel)
  },

  props: {
    read: (id: string): Promise<IpcResult<PropertiesEntry[] | null>> =>
      ipcRenderer.invoke('props:read', id),
    write: (id: string, entries: PropertiesEntry[]): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('props:write', id, entries)
  },

  players: {
    list: (id: string): Promise<IpcResult<PlayerRecord[]>> => ipcRenderer.invoke('players:list', id),
    /** 玩家头像（data URL），取不到时为 null，界面用首字母占位 */
    avatars: (
      id: string,
      players: { name: string; uuid?: string }[]
    ): Promise<IpcResult<Record<string, string | null>>> =>
      ipcRenderer.invoke('players:avatars', id, players),
    /** 正版状态、全身皮肤、经验、背包 / 末影箱 / 潜影盒 */
    detail: (
      id: string,
      name: string,
      uuid?: string
    ): Promise<IpcResult<PlayerProfile>> =>
      ipcRenderer.invoke('players:detail', id, name, uuid),
    /** 批量取物品图标（data URL），取不到为 null */
    itemIcons: (
      id: string,
      ids: string[]
    ): Promise<IpcResult<Record<string, string | null>>> =>
      ipcRenderer.invoke('players:itemIcons', id, ids),
    setOp: (id: string, name: string, value: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('players:setOp', id, name, value),
    setWhitelist: (id: string, name: string, value: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('players:setWhitelist', id, name, value),
    setBanned: (id: string, name: string, value: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('players:setBanned', id, name, value)
  },

  plugins: {
    list: (id: string): Promise<IpcResult<PluginInfo[]>> => ipcRenderer.invoke('plugins:list', id),
    toggle: (id: string, path: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:toggle', id, path),
    /** 批量启用 / 禁用；失败的条目单独返回，不影响其它条目 */
    setEnabled: (
      id: string,
      paths: string[],
      enabled: boolean
    ): Promise<IpcResult<{ changed: number; errors: { path: string; error: string }[] }>> =>
      ipcRenderer.invoke('plugins:setEnabled', id, paths, enabled),
    /** 删除一个模组 / 插件文件，how 说明是进了回收站还是被永久删除 */
    remove: (id: string, path: string): Promise<IpcResult<{ how: DeleteMethod }>> =>
      ipcRenderer.invoke('plugins:delete', id, path)
  },

  /** 服务器目录布局：核心位置、是否 MCDR 托管、各处目录 */
  layout: {
    get: (id: string): Promise<IpcResult<ServerLayoutInfo>> =>
      ipcRenderer.invoke('layout:get', id)
  },

  configs: {
    list: (id: string): Promise<IpcResult<ConfigFile[]>> => ipcRenderer.invoke('configs:list', id)
  },

  /** 网络拓扑：代理端与后端的从属关系 */
  topology: {
    get: (): Promise<IpcResult<Topology>> => ipcRenderer.invoke('topology:get')
  },

  /**
   * 把一台服务器接入 / 移出某个代理端网络。
   * 接入会同时改代理端配置、后端 server.properties，必要时下载桥接模组。
   */
  network: {
    /** 当前挂在哪个代理端下面（旧配置也能按端口认出来） */
    status: (id: string): Promise<IpcResult<{ proxyId: string; alias: string } | null>> =>
      ipcRenderer.invoke('network:status', id),
    join: (id: string, proxyId: string): Promise<IpcResult<NetworkJoinResult>> =>
      ipcRenderer.invoke('network:join', id, proxyId),
    leave: (
      id: string
    ): Promise<IpcResult<{ removed: boolean; alias: string; remaining: number }>> =>
      ipcRenderer.invoke('network:leave', id)
  },

  /** 世界地图：区块地表的俯视图，按 region 分块渲染 */
  map: {
    info: (id: string): Promise<IpcResult<WorldMapInfo>> => ipcRenderer.invoke('map:info', id),
    /** step：每个像素代表多少方块（1–4），缩小时降低渲染分辨率 */
    tile: (
      id: string,
      dim: string,
      rx: number,
      rz: number,
      step?: number
    ): Promise<IpcResult<MapTileResult>> =>
      ipcRenderer.invoke('map:tile', id, dim, rx, rz, step),
    /** 缩到最小时的一像素一 region 总览 */
    overview: (id: string, dim: string): Promise<IpcResult<MapOverview>> =>
      ipcRenderer.invoke('map:overview', id, dim),
    height: (id: string, dim: string, x: number, z: number): Promise<IpcResult<number | null>> =>
      ipcRenderer.invoke('map:height', id, dim, x, z),
    /** 在线玩家位置（仅 CraftDesk 启动的服务端可读） */
    players: (id: string): Promise<IpcResult<MapPlayerPosition[]>> =>
      ipcRenderer.invoke('map:players', id),
    /** 写入 enable-rcon=true（需要重启服务端才生效） */
    enableRcon: (
      id: string
    ): Promise<IpcResult<{ port: number; generatedPassword: boolean }>> =>
      ipcRenderer.invoke('map:enableRcon', id),
    clear: (id: string): Promise<IpcResult<boolean>> => ipcRenderer.invoke('map:clear', id),
    /** 导出地图：all = 一张全图，components = 按连通块分别导出；maxPx = 长边像素 */
    exportMap: (
      id: string,
      dim: string,
      mode: 'all' | 'components',
      maxPx?: number
    ): Promise<IpcResult<MapExportResult>> =>
      ipcRenderer.invoke('map:export', id, dim, mode, maxPx),
    /** 导出前的输出尺寸 / 文件大小预估 */
    exportEstimate: (
      id: string,
      dim: string,
      mode: 'all' | 'components',
      maxPx?: number
    ): Promise<IpcResult<MapExportEstimate>> =>
      ipcRenderer.invoke('map:exportEstimate', id, dim, mode, maxPx),
    /** 导出进度（地图弹窗订阅） */
    onExportProgress: (cb: (p: MapExportProgress) => void): (() => void) =>
      on('map:export-progress', (...a) => cb(a[0] as MapExportProgress))
  },

  /** MC百科的模组关系（前置 / 拓展 / 联动） */
  mcmod: {
    relations: (req: McmodRelationRequest): Promise<IpcResult<McmodRelations | null>> =>
      ipcRenderer.invoke('mcmod:relations', req),
    search: (query: string): Promise<IpcResult<McmodSearchHit[]>> =>
      ipcRenderer.invoke('mcmod:search', query),
    downloads: (classId: string): Promise<IpcResult<McmodDownloadList | null>> =>
      ipcRenderer.invoke('mcmod:downloads', classId)
  },

  /** 扩展下载源：Modrinth / Hangar / SpigotMC / CurseForge / MCDReforged */
  registry: {
    sources: (): { key: RegistrySource; label: string; hint: string }[] => SOURCE_LIST,
    search: (
      source: RegistrySource,
      opts: {
        query: string
        kind: 'mod' | 'plugin'
        gameVersion?: string
        loader?: string
        serverKind?: string
        limit?: number
        offset?: number
      }
    ): Promise<IpcResult<{ hits: RegistryHit[]; total: number }>> =>
      ipcRenderer.invoke('registry:search', source, opts),
    versions: (
      source: RegistrySource,
      id: string,
      filter: { gameVersion?: string; loader?: string; serverKind?: string }
    ): Promise<IpcResult<RegistryVersion[]>> =>
      ipcRenderer.invoke('registry:versions', source, id, filter),
    mcdrList: (force?: boolean): Promise<IpcResult<McdrPlugin[]>> =>
      ipcRenderer.invoke('registry:mcdrList', force),
    mcdrReleases: (repository: string): Promise<IpcResult<McdrRelease[]>> =>
      ipcRenderer.invoke('registry:mcdrReleases', repository),
    /** 星图里补齐缺失：按 id 找 Modrinth 项目，并返回最新适配版本 */
    latest: (
      serverId: string,
      req: LatestModRequest
    ): Promise<IpcResult<LatestModResult | null>> =>
      ipcRenderer.invoke('registry:latest', serverId, req),
    /** 批量检查百科条目在服务器版本 / 加载器下是否还有可用版本 */
    compat: (
      serverId: string,
      items: ModCompatItem[]
    ): Promise<IpcResult<Record<string, ModCompat>>> =>
      ipcRenderer.invoke('registry:compat', serverId, items),
    install: (
      req: InstallRequest
    ): Promise<IpcResult<{ path: string; relPath: string; bytes: number; dir: string }>> =>
      ipcRenderer.invoke('registry:install', req)
  },

  /**
   * 代理端配置的读写与后端校验。
   *
   * 三种代理端两种格式：Velocity 是 velocity.toml，BungeeCord / Waterfall 是 config.yml。
   * 主进程按服务器类型自动分流，界面不用关心格式。
   */
  proxy: {
    read: (id: string): Promise<IpcResult<VelocityFile>> =>
      ipcRenderer.invoke('proxy:read', id),
    write: (id: string, updates: VelocityUpdate[]): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('proxy:write', id, updates),
    writeServers: (
      id: string,
      servers: { name: string; address: string }[],
      tryList: string[]
    ): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('proxy:writeServers', id, servers, tryList),
    checkBackends: (id: string): Promise<IpcResult<BackendCheck[]>> =>
      ipcRenderer.invoke('proxy:checkBackends', id)
  },

  backups: {
    list: (id: string): Promise<IpcResult<BackupInfo[]>> => ipcRenderer.invoke('backups:list', id),
    create: (id: string, label: string): Promise<IpcResult<BackupInfo>> =>
      ipcRenderer.invoke('backups:create', id, label),
    remove: (id: string, path: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('backups:delete', id, path),
    restore: (id: string, path: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('backups:restore', id, path)
  },

  versions: {
    list: (kind: string): Promise<IpcResult<{ id: string; latestBuild?: string }[]>> =>
      ipcRenderer.invoke('versions:list', kind)
  },

  app: {
    info: (): Promise<IpcResult<AppInfo>> => ipcRenderer.invoke('app:info'),
    pickDirectory: (title?: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('app:pickDirectory', title),
    /** 读一张本地图片当背景，返回 data URL（页面 CSP 不允许 file:） */
    readImage: (path: string): Promise<IpcResult<{ dataUrl: string; bytes: number }>> =>
      ipcRenderer.invoke('app:readImage', path),
    /**
     * 抓一张网络图片（下载源给的模组图标）。
     * 页面 CSP 不允许 https 图片，统一走主进程转成 data URL。
     */
    fetchImage: (
      url: string
    ): Promise<IpcResult<{ dataUrl: string; bytes: number; cached: boolean }>> =>
      ipcRenderer.invoke('app:fetchImage', url),
    /**
     * 服务器图标。图片会被复制进配置目录的 icons/，
     * 这里传的/拿到的都是文件名（不是路径）。
     */
    readIcon: (name: string): Promise<IpcResult<{ dataUrl: string; bytes: number }>> =>
      ipcRenderer.invoke('app:readIcon', name),
    importIcon: (
      serverId: string,
      srcPath: string
    ): Promise<IpcResult<{ name: string; bytes: number }>> =>
      ipcRenderer.invoke('app:importIcon', serverId, srcPath),
    pickFile: (title?: string, kind?: 'image'): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('app:pickFile', title, kind),
    openExternal: (url: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('app:openExternal', url),
    openFolder: (dir: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('shell:openFolder', dir),
    revealUserData: (): Promise<IpcResult<string>> => ipcRenderer.invoke('app:revealUserData')
  },

  window: {
    minimize: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:minimize'),
    maximize: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:maximize'),
    close: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:isMaximized')
  },

  // ---------------------------------------------------------- 事件订阅
  on: {
    log: (cb: (id: string, line: LogLine) => void): (() => void) =>
      on('log', (...a) => cb(a[0] as string, a[1] as LogLine)),
    status: (cb: (id: string, runtime: ServerRuntime) => void): (() => void) =>
      on('status', (...a) => cb(a[0] as string, a[1] as ServerRuntime)),
    stats: (cb: (stats: Record<string, { mem: number; cpu: number }>) => void): (() => void) =>
      on('stats', (...a) => cb(a[0] as Record<string, { mem: number; cpu: number }>)),
    serversChanged: (cb: () => void): (() => void) => on('servers:changed', () => cb()),
    download: (cb: (p: DownloadProgress) => void): (() => void) =>
      on('download:progress', (...a) => cb(a[0] as DownloadProgress)),
    windowState: (cb: (maximized: boolean) => void): (() => void) =>
      on('window:state', (...a) => cb(Boolean(a[0])))
  }
}

export type CraftDeskApi = typeof api

contextBridge.exposeInMainWorld('api', api)

export type { ServerStatus }
