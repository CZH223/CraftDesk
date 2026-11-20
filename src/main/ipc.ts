import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { promises as fs } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { isProxyKind } from '../shared/types'
import { proxyJavaMajor, requiredJavaMajor } from '../shared/javaHint'
import type {
  AppSettings,
  BackupInfo,
  CreateServerRequest,
  DetectedServer,
  FileEntry,
  IpcResult,
  JavaInfo,
  LatestModRequest,
  LatestModResult,
  MapExportEstimate,
  McmodRelationRequest,
  ModCompat,
  ModCompatItem,
  MapExportProgress,
  MapExportResult,
  MapOverview,
  PlayerProfile,
  PlayerRecord,
  PluginInfo,
  PropertiesEntry,
  PythonInfo,
  ServerConfig,
  ServerView
} from '../shared/types'
import type { Store } from './store'
import { defaultServer } from './store'
import type { ServerManager } from './server-manager'
import { detectJava, probeJava } from './java'
import { detectServer, kindColor, kindLabel } from './importer'
import { scanNetworkImport } from './network'
import {
  createDir,
  deletePath,
  dirSize,
  listDir,
  pathExists,
  readTextFile,
  renamePath,
  safeJoin,
  writeTextFile
} from './files'
import { IMAGE_EXTS, fetchImageDataUrl, readImageDataUrl } from './images'
import { importIcon, readIcon, removeIcon, removeOtherIcons } from './icons'
import { parseIcon } from '../shared/serverIcon'
import { parsePropertiesFile, writeProperties } from './properties'
import { listPlayers, setBanned, setOp, setWhitelist } from './players'
import { getAvatars } from './avatars'
import {
  listPlugins,
  resolveExtensionFile,
  setPluginsEnabled,
  togglePlugin
} from './plugins'
import { createBackup, deleteBackup, listBackups, restoreBackup } from './backups'
import { downloadFile, installServer, listVersions } from './downloader'
import {
  latestVersion,
  listMcdrPlugins,
  modrinthCompatibility,
  mcdrReleasesFromGithub,
  modrinthLoaderForKind,
  modrinthVersions,
  resolveModrinthProject,
  searchModrinth
} from './registry'
import {
  curseforgeVersions,
  hangarPlatform,
  hangarVersions,
  modrinthHitToRegistry,
  searchCurseforge,
  searchHangar,
  searchSpigot,
  spigotVersions
} from './sources'
import { parseMemoryFromCommand, resolveLayout, toRootRel } from './layout'
import { writeStartScript } from './startscript'
import { detectPython, installMcdr, mcdrReady, probePython } from './python'
import {
  lookupMcmodClass,
  lookupMcmodDownloads,
  lookupMcmodPage,
  lookupMcmodRelations,
  mcmodEnglishName,
  searchMcmodClasses
} from './mcmod'
import {
  attachDownloadUrls,
  pickMcmodDownloadFile,
  resolveExternalDownload
} from './modSources'
import { initMcdrEnvironment, writeMcdrConfig, writeMcdrStartScript } from './mcdr'
import { trashDirectory, whyNotDeletable } from './removal'
import { listConfigs } from './configs'
import { readProxyFile, writeProxyFields, writeProxyServers } from './proxyConfig'
import { findJoinedNetwork, joinServerToNetwork, leaveNetwork } from './networkJoin'
import { checkBackends } from './backends'
import { buildTopology } from './topology'
import {
  clearMapCache,
  getMapHeight,
  getMapInfo,
  getMapOverview,
  getMapTile
} from './mapService'
import { getPlayerPositions, logOnlineNames } from './positions'
import { getItemIcons, getPlayerProfile } from './playerDetails'
import { estimateExport, makeExportTargets, writeTargetPng } from './mapExport'
import { decodePng } from './png'
import { withRconEnabled } from './rcon'
import type {
  BackendCheck,
  ConfigFile,
  DownloadProgress,
  InstallRequest,
  NetworkPlan,
  PluginKind,
  RegistrySource,
  RegistryHit,
  RegistryVersion,
  ServerDeleteMode,
  MapPlayerPosition,
  MapTileResult,
  Topology,
  VelocityFile,
  WorldMapInfo,
  VelocityUpdate
} from '../shared/types'

const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })

/** 主进程启动时间，用于判断界面上跑的是不是重新构建前的旧实例 */
const bootAt = Date.now()
const fail = (error: unknown): IpcResult<never> => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error)
})

interface Ctx {
  store: Store
  manager: ServerManager
  getWindow: () => BrowserWindow | null
  /** 数据目录是怎么选出来的（便携模式还是系统目录） */
  dataDir: { dir: string; portable: boolean; reason: string }
}

function broadcast(ctx: Ctx, channel: string, ...args: unknown[]): void {
  ctx.getWindow()?.webContents.send(channel, ...args)
}

/**
 * 按需要的 Java 大版本挑一个能用 java.exe。
 * 优先完全没有问题的那个：够用的里面挑版本最低的，别为了跑 1.20 去开 Java 24。
 */
export function pickJavaFor(
  settings: AppSettings,
  need: number
): { path: string; switched: boolean; found: JavaInfo | null } {
  const usable = settings.javaList
    .filter((j) => j.valid && j.major >= need)
    .sort((a, b) => a.major - b.major)

  const current = settings.javaList.find((j) => j.path === settings.javaPath)
  if (current && current.major >= need) {
    return { path: settings.javaPath, switched: false, found: current }
  }
  // 列表里没有够用的就别乱指：保持用户原来的选择，让日志里的提示去说明问题
  if (!usable.length) return { path: settings.javaPath, switched: false, found: null }
  return { path: usable[0].path, switched: true, found: usable[0] }
}

/** 星图兼容性检查缓存：中心切换回来时不用再打一遍 Modrinth */
const compatCache = new Map<string, { at: number; value: ModCompat }>()

export function registerIpc(ctx: Ctx): void {
  const { store, manager } = ctx
  const send = (channel: string, ...args: unknown[]): void => broadcast(ctx, channel, ...args)

  /**
   * 写启动脚本。脚本里的 java / 内存 / 参数都取自当前配置，
   * 所以调用方要保证 cfg 已经是最新的那一份。
   */
  const writeStartScriptHost = async (cfg: ServerConfig): Promise<{ file: string; relPath: string }> => {
    const layout = await resolveLayout(cfg)
    const res = await writeStartScript(cfg, layout)
    return { file: res.file, relPath: res.relPath }
  }

  // ---------------------------------------------------------- 服务器列表

  ipcMain.handle('servers:list', () => ok<ServerView[]>(manager.list()))
  ipcMain.handle('servers:stats', () => ok(manager.getStats()))

  ipcMain.handle('servers:detect', async (_e, dir: string) => {
    try {
      const detected = await detectServer(dir)
      return ok<DetectedServer>(detected)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('servers:add', async (_e, payload: { dir: string; config: Partial<ServerConfig> }) => {
    try {
      const dir = resolve(payload.dir)
      if (!(await pathExists(dir))) throw new Error('目录不存在')

      // 体积只用于导入前的预览，这里不必再数一遍（大服务器要好几秒）
      const detected = await detectServer(dir, { skipSize: true })
      const cfg = defaultServer({
        name: payload.config.name || detected.name,
        dir,
        jar: payload.config.jar ?? (detected.suggestedArgs ? '' : detected.suggestedJar),
        launchArgs: payload.config.launchArgs ?? detected.suggestedArgs,
        startScript: payload.config.startScript ?? '',
        kind: payload.config.kind ?? detected.kind,
        mcVersion: payload.config.mcVersion || detected.mcVersion,
        javaPath: payload.config.javaPath || store.settings.javaPath,
        memoryMin: payload.config.memoryMin ?? store.settings.defaultMemoryMin,
        memoryMax: payload.config.memoryMax ?? store.settings.defaultMemoryMax,
        jvmArgs: payload.config.jvmArgs ?? '',
        // 代理端不接受 nogui 参数
        serverArgs:
          payload.config.serverArgs ?? (isProxyKind(payload.config.kind ?? detected.kind) ? '' : 'nogui'),
        coreDir: detected.coreDir,
        mcdr: detected.isMcdr,
        // 目录里是 MCDR 的话，直接用它托管：默认的 python 已经能跑就填上，
        // 这样「启动」起的是 MCDR 而不是绕过它直接开核心（用户显式选了启动脚本时脚本优先）
        pythonPath: payload.config.pythonPath || (detected.isMcdr ? store.settings.pythonPath : ''),
        note: payload.config.note || '',
        icon: payload.config.icon || kindLabel(payload.config.kind ?? detected.kind),
        color: kindColor(payload.config.kind ?? detected.kind),
        networkId: payload.config.networkId || '',
        networkAlias: payload.config.networkAlias || ''
      })
      store.addServer(cfg)

      // 目录都交给布局解析，MCDR 这类布局里插件和模组不在同一层
      const layout = await resolveLayout(cfg)
      store.updateServer(cfg.id, {
        pluginsDir: layout.mcPluginsDir ? toRootRel(layout, layout.mcPluginsDir) : '',
        modsDir: layout.modsDir ? toRootRel(layout, layout.modsDir) : ''
      })

      send('servers:changed')
      return ok<ServerView>(manager.getServer(cfg.id)!)
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 扫一个代理端目录，列出它配置里的后端，并逐个在磁盘上找对应的目录。
   * 跨服网络是按「一台代理端 + 一堆后端」用的，一次只导一台代理端没什么意义，
   * 所以导入界面会先用这个把可导入的东西列出来给用户勾。
   */
  ipcMain.handle('servers:scanNetwork', async (_e, dir: string) => {
    try {
      const full = resolve(dir)
      if (!(await pathExists(full))) throw new Error('目录不存在')
      return ok<NetworkPlan>(await scanNetworkImport(full, store.servers))
    } catch (err) {
      return fail(err)
    }
  })

  /** 返回服务器目录布局，界面用它显示核心位置、MCDR 提示等 */
  ipcMain.handle('layout:get', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      const mem = layout.mcdrStartCommand
        ? parseMemoryFromCommand(layout.mcdrStartCommand)
        : { min: null, max: null }
      return ok({
        coreRel: layout.coreRel,
        isMcdr: layout.isMcdr,
        mcdrStartCommand: layout.mcdrStartCommand,
        mcdrMemory: mem,
        mcdrPluginsDir: layout.mcdrPluginsDir ? toRootRel(layout, layout.mcdrPluginsDir) : '',
        mcdrConfigDir: layout.mcdrConfigDir ? toRootRel(layout, layout.mcdrConfigDir) : '',
        mcPluginsDir: layout.mcPluginsDir ? toRootRel(layout, layout.mcPluginsDir) : '',
        modsDir: layout.modsDir ? toRootRel(layout, layout.modsDir) : '',
        configDir: layout.configDir ? toRootRel(layout, layout.configDir) : '',
        isProxy: layout.isProxy,
        proxyConfigFile: layout.proxyConfigFile
          ? toRootRel(layout, layout.proxyConfigFile)
          : '',
        configuredPort: layout.configuredPort
      })
    } catch (err) {
      return fail(err)
    }
  })

  /** 列出所有可编辑的配置文件 */
  ipcMain.handle('configs:list', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      return ok<ConfigFile[]>(await listConfigs(layout))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 网络拓扑：谁挂在谁的下面。
   * 代理端是入口，[servers] 里的后端是下游，两边不是平级关系。
   */
  ipcMain.handle('topology:get', async () => {
    try {
      return ok(await buildTopology(store.servers, (id) => manager.runtime(id)))
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- 世界地图

  /*
   * 地图是只读的：只解析 world/region 里的方块数据，不碰存档。
   * 渲染结果按 region 缓存在 userData/worldmap 下，存档更新后文件名会变。
   */
  ipcMain.handle('map:info', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      return ok<WorldMapInfo>(await getMapInfo(cfg, layout.core, layout.serverProperties))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    'map:tile',
    async (_e, id: string, dim: string, rx: number, rz: number, step?: number) => {
      try {
        const cfg = store.getServer(id)
        if (!cfg) throw new Error('服务器不存在')
        const layout = await resolveLayout(cfg)
        const info = await getMapInfo(cfg, layout.core, layout.serverProperties)
        return ok<MapTileResult>(await getMapTile(cfg, dim, rx, rz, info, step ?? 1))
      } catch (err) {
        return fail(err)
      }
    }
  )

  /** 一像素一 region 的世界总览 */
  ipcMain.handle('map:overview', async (_e, id: string, dim: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      const info = await getMapInfo(cfg, layout.core, layout.serverProperties)
      return ok<MapOverview>(await getMapOverview(cfg, dim, info))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 导出地图 PNG：
   *   all         —— 整个维度的所有 region 拼成一张（透明背景，虚空保持透明）
   *   components  —— 按 8 邻接连通块拆开，每个完全独立的块单独一张
   *
   * 导出只读缓存瓦片；没有缓存的 region 会走同一套 worker 渲染。
   * 单张图最大 4096 px，区域太多时先降 step，再整体缩小。
   */
  ipcMain.handle(
    'map:export',
    async (
      _e,
      id: string,
      dim: string,
      mode: 'all' | 'components',
      maxPx?: number
    ) => {
      const started = Date.now()
      try {
        if (mode !== 'all' && mode !== 'components') throw new Error('导出方式不正确')
        const cfg = store.getServer(id)
        if (!cfg) throw new Error('服务器不存在')
        const layout = await resolveLayout(cfg)
        const info = await getMapInfo(cfg, layout.core, layout.serverProperties)
        const dimension = info.dimensions.find((d) => d.id === dim)
        if (!dimension || !dimension.regions.length) throw new Error('这个维度还没有可导出的区域')
        const px = Math.max(256, Math.min(32768, Math.floor(Number(maxPx) || 4096)))

        const picked = await dialog.showOpenDialog({
          title: '选择地图导出目录',
          properties: ['openDirectory', 'createDirectory']
        })
        if (picked.canceled || !picked.filePaths.length) {
          return ok<MapExportResult>({
            canceled: true,
            files: [],
            components: 0,
            failures: 0,
            ms: 0
          })
        }

        const outDir = picked.filePaths[0]
        const targets = makeExportTargets(dimension.regions, mode, px)
        const total = targets.reduce((n, t) => n + t.regions.length, 0)
        let done = 0
        let failures = 0
        const files: MapExportResult['files'] = []
        const now = new Date()
        const pad = (n: number): string => String(n).padStart(2, '0')
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
        const safeName = (cfg.name || 'server').replace(/[\\/:*?"<>|]/g, '_').slice(0, 48)

        for (const target of targets) {
          let file = join(
            outDir,
            `${safeName}-${dimension.label}-${target.label}-${stamp}.png`
          )
          for (let i = 2; ; i++) {
            try {
              await fs.access(file)
              file = join(
                outDir,
                `${safeName}-${dimension.label}-${target.label}-${stamp}-${i}.png`
              )
            } catch {
              break
            }
          }
          const tmp = `${file}.${process.pid}.tmp`
          try {
            await writeTargetPng(
              target,
              tmp,
              async (r) => {
                const tile = await getMapTile(cfg, dim, r.rx, r.rz, info, target.step)
                const comma = tile.png.indexOf(',')
                const decoded = decodePng(
                  Buffer.from(comma >= 0 ? tile.png.slice(comma + 1) : tile.png, 'base64')
                )
                return { size: decoded.width, rgba: decoded.rgba }
              },
              (_r, ok) => {
                done++
                if (!ok) failures++
                send('map:export-progress', {
                  serverId: id,
                  dim,
                  done,
                  total,
                  label: target.label
                } satisfies MapExportProgress)
              }
            )
            await fs.rename(tmp, file)
          } catch (err) {
            await fs.rm(tmp, { force: true }).catch(() => {})
            throw err
          }
          files.push({
            path: file,
            width: target.width,
            height: target.height,
            regions: target.regions.length
          })
        }

        return ok<MapExportResult>({
          canceled: false,
          dir: outDir,
          files,
          components: mode === 'components' ? targets.length : 1,
          failures,
          ms: Date.now() - started
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  /** 导出前预估：实际输出尺寸、总像素、文件大小范围和大图提醒 */
  ipcMain.handle(
    'map:exportEstimate',
    async (
      _e,
      id: string,
      dim: string,
      mode: 'all' | 'components',
      maxPx?: number
    ) => {
      try {
        if (mode !== 'all' && mode !== 'components') throw new Error('导出方式不正确')
        const cfg = store.getServer(id)
        if (!cfg) throw new Error('服务器不存在')
        const layout = await resolveLayout(cfg)
        const info = await getMapInfo(cfg, layout.core, layout.serverProperties)
        const dimension = info.dimensions.find((d) => d.id === dim)
        if (!dimension || !dimension.regions.length) throw new Error('这个维度还没有可导出的区域')
        const px = Math.max(256, Math.min(32768, Math.floor(Number(maxPx) || 4096)))
        const targets = makeExportTargets(dimension.regions, mode, px)
        return ok<MapExportEstimate>(estimateExport(targets, px))
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle('map:height', async (_e, id: string, dim: string, x: number, z: number) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      const info = await getMapInfo(cfg, layout.core, layout.serverProperties)
      return ok<number | null>(await getMapHeight(cfg, dim, x, z, info))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 在线玩家坐标。走控制台的 `data get entity`，只在地图打开时轮询。
   * 返回的名单按当前服务端的在线列表来；外部启动的服务端拿不到 stdin。
   */
  ipcMain.handle('map:players', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      return ok<MapPlayerPosition[]>(
        await getPlayerPositions(
          manager,
          cfg,
          layout.playersDir,
          layout.serverProperties,
          layout.core
        )
      )
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 给一台 MCDR / 外部启动的服务端打开 RCON。
   * 只改 server.properties，不重启服务器；玩家位置要等服务端下次启动后才读得到。
   */
  ipcMain.handle('map:enableRcon', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      const entries = await parsePropertiesFile(layout.serverProperties)
      if (!entries.length) throw new Error('读不到 server.properties')
      const res = withRconEnabled(entries)
      await writeProperties(layout.serverProperties, res.entries)
      return ok({ port: res.port, generatedPassword: res.generatedPassword })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('map:clear', async (_e, id: string) => {
    try {
      await clearMapCache(id)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- 扩展下载源

  /** 统一的搜索入口，source 决定去哪个站查 */
  ipcMain.handle('registry:search', async (_e, source: RegistrySource, opts) => {
    try {
      const apiKey = store.settings.curseforgeApiKey
      switch (source) {
        case 'modrinth': {
          const r = await searchModrinth({
            query: opts.query,
            projectType: opts.kind === 'mod' ? 'mod' : 'plugin',
            gameVersion: opts.gameVersion,
            loader: opts.loader,
            limit: opts.limit,
            offset: opts.offset,
            index: opts.query?.trim() ? 'relevance' : 'downloads'
          })
          return ok({ total: r.total, hits: r.hits.map(modrinthHitToRegistry) })
        }
        case 'hangar':
          return ok(await searchHangar(opts, hangarPlatform(opts.serverKind)))
        case 'spigot':
          return ok(await searchSpigot(opts))
        case 'curseforge':
          return ok(await searchCurseforge({ ...opts, apiKey }))
        default:
          throw new Error(`未知的下载源：${source}`)
      }
    } catch (err) {
      return fail(err)
    }
  })

  /** 统一取可安装版本 */
  ipcMain.handle('registry:versions', async (_e, source: RegistrySource, id: string, filter) => {
    try {
      const apiKey = store.settings.curseforgeApiKey
      switch (source) {
        case 'modrinth': {
          const list = await modrinthVersions(id, filter ?? {})
          return ok<RegistryVersion[]>(
            list.map((v) => ({
              id: v.id,
              name: v.versionNumber,
              channel: v.versionType,
              fileName: v.fileName,
              fileUrl: v.fileUrl,
              fileSize: v.fileSize,
              downloads: v.downloads,
              publishedAt: v.publishedAt,
              gameVersions: v.gameVersions,
              loaders: v.loaders
            }))
          )
        }
        case 'hangar':
          return ok(await hangarVersions(id, hangarPlatform(filter?.serverKind), filter?.gameVersion))
        case 'spigot':
          return ok(await spigotVersions(id))
        case 'curseforge':
          return ok(await curseforgeVersions(id, { ...filter, apiKey }))
        default:
          throw new Error(`未知的下载源：${source}`)
      }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('registry:mcdrList', async (_e, force?: boolean) => {
    try {
      return ok(await listMcdrPlugins(join(app.getPath('userData'), 'cache'), force))
    } catch (err) {
      return fail(err)
    }
  })

  /** 目录里没列发布信息的插件，安装时才去查它的 GitHub Releases */
  ipcMain.handle('registry:mcdrReleases', async (_e, repository: string) => {
    try {
      return ok(await mcdrReleasesFromGithub(repository))
    } catch (err) {
      return fail(err)
    }
  })

  /** MC百科搜索：下载页的 MC百科栏目用 */
  ipcMain.handle('mcmod:search', async (_e, query: string) => {
    try {
      return ok(await searchMcmodClasses(query))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * MC百科「Mod下载」文件表。MC百科自己的下载按钮要验证码，不能自动点；
   * 这里把文件列表取回来，再按同名文件去 CurseForge / GitHub / Modrinth
   * 找到直链，安装仍然走 registry:install（落到 mods/ 或 plugins/）。
   */
  ipcMain.handle('mcmod:downloads', async (_e, classId: string) => {
    try {
      const list = await lookupMcmodDownloads(classId)
      if (!list) return ok(null)
      const page = await lookupMcmodPage(classId)
      const files = await attachDownloadUrls(list.files, page?.links ?? [])
      return ok({ ...list, files })
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * MC百科关系：按本地模组的 id/名字找到百科条目，再取它的星图数据。
   * 只取中心直接相连的一圈；找不到或站点打不开时返回 null，星图照常显示本地关系。
   */
  ipcMain.handle('mcmod:relations', async (_e, req: McmodRelationRequest) => {
    try {
      if (!req?.id && !req?.name) return ok(null)
      return ok(await lookupMcmodRelations(req))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 星图补齐/下载：按依赖 id 去 Modrinth 找项目，再挑当前服务端
   * 游戏版本 + 加载器下最新的那个版本。找不到就返回 null，让界面说清楚，
   * 不要随便装一个不兼容的版本。
   */
  ipcMain.handle('registry:latest', async (_e, serverId: string, req: LatestModRequest) => {
    try {
      const cfg = store.getServer(serverId)
      if (!cfg) throw new Error('服务器不存在')
      if (!req?.id && !req?.name) throw new Error('没有可查询的模组 id')

      const projectType = req.kind === 'plugin' ? 'plugin' : 'mod'
      let project = await resolveModrinthProject({
        id: req.id,
        name: req.name,
        kind: projectType
      })

      const filter = {
        gameVersion: cfg.mcVersion || undefined,
        loader: modrinthLoaderForKind(cfg.kind) || undefined
      }
      const modrinthVersion = async (): Promise<LatestModResult | null> => {
        if (!project) return null
        const list = await modrinthVersions(project.projectId, filter)
        const v = latestVersion(list)
        if (!v) return null
        return {
          projectId: project.projectId,
          slug: project.slug,
          title: project.title,
          source: 'modrinth',
          version: {
            id: v.id,
            name: v.versionNumber,
            channel: v.versionType,
            fileName: v.fileName,
            fileUrl: v.fileUrl,
            fileSize: v.fileSize,
            downloads: v.downloads,
            publishedAt: v.publishedAt,
            gameVersions: v.gameVersions,
            loaders: v.loaders
          }
        }
      }

      const direct = await modrinthVersion()
      if (direct) return ok<LatestModResult>(direct)

      /*
       * Modrinth 找不到/没有适配版本时再问 MC百科：
       * 1. 用百科标题把依赖 id 翻成正常名字，再试一次 Modrinth；
       * 2. 仍然不行就顺着百科的 CurseForge / GitHub 外链找文件。
       */
      let mcmodHit =
        (await lookupMcmodClass(req.name)) ?? (await lookupMcmodClass(req.id))
      let title = project?.title ?? ''
      let sourceUrl: string | undefined
      if (!project && mcmodHit) {
        const english = mcmodEnglishName(mcmodHit.title)
        project = await resolveModrinthProject({
          id: english || mcmodHit.title,
          name: english || mcmodHit.title,
          kind: projectType
        })
        const retried = await modrinthVersion()
        if (retried) return ok<LatestModResult>(retried)
        title = project?.title ?? title
      }
      if (mcmodHit) {
        const page = await lookupMcmodPage(mcmodHit.classId)
        if (page) {
          if (!title) title = page.title
          const external = await resolveExternalDownload(
            page.links,
            cfg.kind,
            cfg.mcVersion || ''
          )
          if (external) {
            return ok<LatestModResult>({
              projectId: project?.projectId ?? `mcmod-${page.classId}`,
              slug: project?.slug ?? '',
              title: title || page.title,
              source: external.source,
              sourceUrl: external.pageUrl,
              version: external.version
            })
          }

          // 最后再按 MC百科「Mod下载」文件表逐条匹配同名文件
          const downloads = await lookupMcmodDownloads(page.classId)
          if (downloads) {
            const files = await attachDownloadUrls(downloads.files, page.links)
            const file = pickMcmodDownloadFile(files, cfg.kind, cfg.mcVersion || '')
            if (file?.url && file.source) {
              return ok<LatestModResult>({
                projectId: project?.projectId ?? `mcmod-${page.classId}`,
                slug: project?.slug ?? '',
                title: title || page.title,
                source: file.source,
                sourceUrl: file.pageUrl,
                version: {
                  id: `mcmod-${file.id}`,
                  name: file.fileName,
                  channel: 'release',
                  fileName: file.fileName,
                  fileUrl: file.url,
                  fileSize: file.size,
                  downloads: 0,
                  publishedAt: file.uploadedAt,
                  gameVersions: file.mcVersions,
                  loaders: file.loaders
                }
              })
            }
          }
          sourceUrl = page.links[0]?.url ?? page.pageUrl
        }
      }

      if (!project && !title) return ok<LatestModResult | null>(null)
      return ok<LatestModResult>({
        projectId: project?.projectId ?? '',
        slug: project?.slug ?? '',
        title,
        sourceUrl,
        version: null
      })
    } catch (err) {
      return fail(err)
    }
  })

  /** 右侧栏分栏用：插件和模组各有多少个（只看文件，不解析 jar，很快） */
  ipcMain.handle('plugins:counts', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      const count = async (dir: string | null, exts: string[]): Promise<number> => {
        if (!dir) return 0
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true })
          return entries.filter((entry) => {
            if (entry.name.startsWith('.')) return false
            if (entry.isDirectory()) return true
            if (!entry.isFile()) return false
            const lower = entry.name.toLowerCase().replace(/\.disabled$/, '')
            return exts.some((ext) => lower.endsWith(ext))
          }).length
        } catch {
          return 0
        }
      }
      const plugins =
        (await count(layout.mcdrPluginsDir, ['.mcdr', '.pyz', '.py'])) +
        (await count(layout.mcPluginsDir, ['.jar']))
      const mods = await count(layout.modsDir, ['.jar'])
      return ok({ plugins, mods })
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 星图兼容性：批量检查百科条目在当前服务器版本 / 加载器下有没有可用版本。
   * 这样「联动模组」里那些只支持旧版本的条目就不会再画出来。
   */
  ipcMain.handle(
    'registry:compat',
    async (_e, serverId: string, items: ModCompatItem[]) => {
      try {
        const cfg = store.getServer(serverId)
        if (!cfg) throw new Error('服务器不存在')
        const filter = {
          gameVersion: cfg.mcVersion || undefined,
          loader: modrinthLoaderForKind(cfg.kind) || undefined
        }
        const now = Date.now()
        const out: Record<string, ModCompat> = {}
        const byQuery = new Map<string, Promise<ModCompat>>()

        const check = (item: ModCompatItem): Promise<ModCompat> => {
          const cacheKey = `${filter.gameVersion ?? ''}|${filter.loader ?? ''}|${item.kind}|${item.id}|${item.name}`
          const cached = compatCache.get(cacheKey)
          if (cached && now - cached.at < 10 * 60 * 1000) {
            return Promise.resolve(cached.value)
          }
          const pending = byQuery.get(cacheKey)
          if (pending) return pending
          const p = modrinthCompatibility(
            { id: item.id, name: item.name, kind: item.kind },
            filter
          ).then((value) => {
            compatCache.set(cacheKey, { at: Date.now(), value })
            return value
          })
          byQuery.set(cacheKey, p)
          return p
        }

        let cursor = 0
        const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
          while (cursor < items.length) {
            const item = items[cursor++]
            out[item.key] = await check(item)
          }
        })
        await Promise.all(workers)
        return ok(out)
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * 把扩展装进服务器目录。
   * 装到哪儿由服务器布局决定：模组进 mods/，服务端插件进 plugins/，
   * MCDR 插件进 MCDR 的插件目录——这三者在 MCDR 布局下是三个不同的目录。
   */
  ipcMain.handle('registry:install', async (_e, req: InstallRequest) => {
    try {
      const cfg = store.getServer(req.serverId)
      if (!cfg) throw new Error('服务器不存在')
      if (!req.url) throw new Error('这个版本没有可用的下载地址')
      if (!req.fileName) throw new Error('下载文件名缺失')

      const layout = await resolveLayout(cfg)
      const dir =
        req.target === 'mod'
          ? layout.modsDir ?? join(layout.core, 'mods')
          : req.target === 'plugin'
            ? layout.mcPluginsDir ?? join(layout.core, 'plugins')
            : layout.mcdrPluginsDir ?? join(layout.root, 'plugins')

      await fs.mkdir(dir, { recursive: true })
      const dest = join(dir, req.fileName)
      const taskId = `install-${Date.now()}`

      await downloadFile(
        req.url,
        dest,
        (received, total) => {
          send('download:progress', {
            taskId,
            stage: 'download',
            message: `正在下载 ${req.fileName}`,
            received,
            total,
            percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
          } satisfies DownloadProgress)
        },
        // 下载源给了大小就核对，少一个字节都当失败——装上一半的模组
        // 比装不上更难查
        { size: req.fileSize }
      )

      send('download:progress', {
        taskId,
        stage: 'done',
        message: `${req.label} 安装完成`,
        received: 0,
        total: 0,
        percent: 100
      } satisfies DownloadProgress)

      const st = await fs.stat(dest)
      return ok({
        path: dest,
        relPath: toRootRel(layout, dest),
        bytes: st.size,
        dir: toRootRel(layout, dir)
      })
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- 代理端（Velocity / BungeeCord / Waterfall）

  ipcMain.handle('proxy:read', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      if (!isProxyKind(cfg.kind)) throw new Error('这台服务器不是代理端')
      return ok<VelocityFile>(await readProxyFile(cfg))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:write', async (_e, id: string, updates: VelocityUpdate[]) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      if (!isProxyKind(cfg.kind)) throw new Error('这台服务器不是代理端')
      await writeProxyFields(cfg, updates)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 把一台服务端接入代理端：写 servers、开代理端转发、配置后端。
   * 换网络时先把旧的条目摘掉，避免同一台服务器挂在两个代理端下面。
   */
  ipcMain.handle('network:join', async (_e, id: string, proxyId: string) => {
    try {
      const cfg = store.getServer(id)
      const proxy = store.getServer(proxyId)
      if (!cfg) throw new Error('服务器不存在')
      if (!proxy) throw new Error('代理端不存在')
      if (cfg.id === proxy.id) throw new Error('服务器不能加入自己')

      if (cfg.networkId && cfg.networkId !== proxy.id) {
        const old = store.getServer(cfg.networkId)
        if (old) {
          try {
            await leaveNetwork(cfg, old)
          } catch {
            /* 旧代理端已经删掉或配置读不出来时，继续接入新网络 */
          }
        }
      }

      const taskId = `network-${Date.now()}`
      const result = await joinServerToNetwork(
        cfg,
        proxy,
        (message, received, total) => {
          send('download:progress', {
            taskId,
            stage: 'download',
            message,
            received,
            total,
            percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
          })
        },
        store.servers,
        {
          javaPath: cfg.javaPath || store.settings.javaPath,
          running: manager.isRunning(cfg.id)
        }
      )
      send('download:progress', {
        taskId,
        stage: 'done',
        message: '跨服接入完成',
        received: 0,
        total: 0,
        percent: 100
      })

      store.updateServer(cfg.id, {
        networkId: proxy.id,
        networkAlias: result.alias,
        // 导入时按 mod 文件名猜的版本可能不准，用实际检测到的覆盖掉
        ...(result.mcVersion ? { mcVersion: result.mcVersion } : {})
      })
      send('servers:changed')
      return ok(result)
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 查询这台服务器现在挂在哪个代理端下面。
   * 旧版本导入的网络没记 networkId，按端口扫配置也能认出来。
   */
  ipcMain.handle('network:status', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const found = await findJoinedNetwork(cfg, store.servers)
      if (found) {
        store.updateServer(cfg.id, {
          networkId: found.proxy.id,
          networkAlias: found.alias
        })
        // 让左侧列表立刻出现「网络」标记
        send('servers:changed')
        return ok({ proxyId: found.proxy.id, alias: found.alias })
      }
      if (cfg.networkId) {
        store.updateServer(cfg.id, { networkId: '', networkAlias: '' })
        send('servers:changed')
      }
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('network:leave', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')

      let proxy = cfg.networkId ? store.getServer(cfg.networkId) : undefined
      if (!proxy) {
        const found = await findJoinedNetwork(cfg, store.servers)
        proxy = found?.proxy
      }
      if (!proxy) throw new Error('这台服务器没有写在任何代理端的服务器列表里')

      const result = await leaveNetwork(cfg, proxy)
      store.updateServer(cfg.id, { networkId: '', networkAlias: '' })
      send('servers:changed')
      return ok(result)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    'proxy:writeServers',
    async (
      _e,
      id: string,
      servers: { name: string; address: string }[],
      tryList: string[]
    ) => {
      try {
        const cfg = store.getServer(id)
        if (!cfg) throw new Error('服务器不存在')
        if (!isProxyKind(cfg.kind)) throw new Error('这台服务器不是代理端')
        await writeProxyServers(cfg, servers, tryList)
        return ok(true)
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * 检查 [servers] 里的每个后端：
   * 能不能在 CraftDesk 里对上号、有没有装 FabricProxy/FabricProxy-Lite、密钥与转发模式对不对。
   */
  ipcMain.handle('proxy:checkBackends', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      if (!isProxyKind(cfg.kind)) throw new Error('这台服务器不是代理端')

      const file = await readProxyFile(cfg)
      const field = (key: string): string =>
        file.fields.find((f) => f.section === '' && f.key === key)?.value ?? ''
      const runningIds = new Set(
        store.servers.filter((s) => manager.isRunning(s.id)).map((s) => s.id)
      )

      // BungeeCord 没有 forwarding secret：它靠 ip_forward 在握手里带玩家信息，
      // 也就是 Velocity 所说的 legacy 模式。关掉就等于不转发。
      const forwardingMode =
        file.format === 'bungee'
          ? field('ip_forward') === 'true'
            ? 'legacy'
            : 'none'
          : field('player-info-forwarding-mode') || 'none'
      const proxyOnlineMode =
        (file.format === 'bungee' ? field('online_mode') : field('online-mode')) === 'true'

      const checks = await checkBackends({
        proxySecret: file.secret,
        forwardingMode,
        proxyOnlineMode,
        proxyFormat: file.format === 'bungee' ? 'bungee' : 'velocity',
        entries: file.servers,
        managed: store.servers,
        runningIds
      })
      return ok<BackendCheck[]>(checks)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('servers:update', (_e, id: string, patch: Partial<ServerConfig>) => {
    const before = store.getServer(id)
    const updated = store.updateServer(id, patch)
    if (!updated) return fail('服务器不存在')

    /*
     * 图标换成别的之后，旧那张图就没有任何地方引用它了。
     * 顺手删掉，否则 icons/ 会随着用户反复换图一直长大。
     */
    if (before && patch.icon !== undefined && patch.icon !== before.icon) {
      const old = parseIcon(before.icon)
      const next = parseIcon(updated.icon)
      if (old.kind === 'image' && !(next.kind === 'image' && next.name === old.name)) {
        void removeIcon(app.getPath('userData'), old.name)
      }
    }

    send('servers:changed')
    send('status', id, manager.runtime(id))
    return ok<ServerView>(manager.getServer(id)!)
  })

  /**
   * 移除 / 删除服务器。
   *
   * - `link`  只从 CraftDesk 的列表里摘掉，磁盘上一个字节都不动
   * - `files` 连目录一起删，**必须**把服务器名字原样打进来才执行
   *
   * 两个模式都要先停服：跑着的进程占着 jar 和世界文件，删到一半更麻烦。
   */
  ipcMain.handle(
    'servers:delete',
    async (_e, id: string, mode: ServerDeleteMode, confirmName?: string) => {
      try {
        const cfg = store.getServer(id)
        if (!cfg) throw new Error('服务器不存在')
        if (manager.isRunning(id)) throw new Error('请先停止服务器再删除')

        if (mode === 'files') {
          // 二次确认：名字对不上就当没点过。界面已经拦了一层，
          // 这里是真正的执行点，不能只信界面。
          if ((confirmName ?? '').trim() !== cfg.name) {
            throw new Error('输入的服务器名称不一致，已取消删除')
          }
          const why = whyNotDeletable(cfg.dir, [app.getPath('userData'), app.getPath('home')])
          if (why) throw new Error(`出于安全考虑没有删除：${why}`)
          await trashDirectory(cfg.dir, (p) => shell.trashItem(p))
        }

        store.removeServer(id)
        manager.forget(id)
        // 服务器没了，图标文件也不会再被引用。（这只动 CraftDesk 自己在
        // userData/icons 下的缓存，和「不碰服务器目录」的承诺不冲突）
        void removeOtherIcons(app.getPath('userData'), id)
        send('servers:changed')
        return ok({ mode, removed: true })
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * 每台服务器监听哪个端口。
   *
   * 「把一台已导入的服务器接到代理端」需要它的端口：服务端在 server.properties 里，
   * 代理端在自己的配置里。这里一次读完，界面上的「添加后端」就不用让用户去翻文件。
   */
  ipcMain.handle('servers:ports', async () => {
    const out: Record<string, number | null> = {}
    for (const cfg of store.servers) {
      try {
        if (isProxyKind(cfg.kind)) {
          const file = await readProxyFile(cfg)
          const listen = file.format === 'bungee'
            ? file.fields.find((f) => f.section === 'listener' && f.key === 'host')?.value ?? ''
            : file.fields.find((f) => f.section === '' && f.key === 'bind')?.value ?? ''
          const port = Number(listen.split(':').pop())
          out[cfg.id] = Number.isFinite(port) && port > 0 ? port : null
          continue
        }
        const layout = await resolveLayout(cfg)
        const props = await parsePropertiesFile(layout.serverProperties)
        const port = Number(props.find((p) => p.key === 'server-port')?.value)
        out[cfg.id] = Number.isFinite(port) && port > 0 ? port : null
      } catch {
        out[cfg.id] = null
      }
    }
    return ok(out)
  })

  ipcMain.handle('servers:reorder', (_e, ids: string[]) => {
    store.reorder(ids)
    send('servers:changed')
    return ok(true)
  })

  // ---------------------------------------------------------- 进程控制

  ipcMain.handle('server:start', async (_e, id: string) => {
    const r = await manager.start(id)
    return r.ok ? ok(true) : fail(r.error || '启动失败')
  })
  ipcMain.handle('server:stop', async (_e, id: string, force?: boolean) => {
    try {
      await manager.stop(id, force)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })
  ipcMain.handle('server:restart', async (_e, id: string) => {
    try {
      await manager.restart(id)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })
  ipcMain.handle('server:command', (_e, id: string, cmd: string) => {
    return manager.sendCommand(id, cmd) ? ok(true) : fail('服务器未运行')
  })
  ipcMain.handle('server:logs', (_e, id: string) => ok(manager.logs(id)))
  ipcMain.handle('server:clearLogs', (_e, id: string) => {
    manager.clearLogs(id)
    return ok(true)
  })
  ipcMain.handle('server:acceptEula', async (_e, id: string) => {
    const done = await manager.acceptEula(id)
    return done ? ok(true) : fail('写入 eula.txt 失败')
  })

  // ---------------------------------------------------------- 设置 / Java

  ipcMain.handle('settings:get', () => ok(store.settings))
  ipcMain.handle('settings:patch', async (_e, patch) => {
    const next = store.patchSettings(patch)
    send('servers:changed')
    return ok(next)
  })

  ipcMain.handle('java:detect', async () => {
    try {
      const list = await detectJava()
      store.patchSettings({ javaList: list })
      if (!store.settings.javaPath && list.length) {
        store.patchSettings({ javaPath: list[0].path })
      }
      return ok<JavaInfo[]>(list)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('java:probe', async (_e, path: string) => {
    try {
      return ok<JavaInfo>(await probeJava(path))
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- Python / MCDReforged

  /** 扫描机器上的 Python，顺便报出每个里面 mcdreforged 的版本 */
  ipcMain.handle('python:detect', async (_e, path?: string) => {
    try {
      if (path?.trim()) {
        const one = await probePython(path.trim())
        if (!one) throw new Error('这个路径不是能用的 python.exe')
        return ok<PythonInfo[]>([one])
      }
      const list = await detectPython()
      store.patchSettings({ pythonList: list })
      // 一个都没找到和「找到了但没装 MCDR」是两回事，界面要能分开说
      if (!store.settings.pythonPath && list.length) {
        store.patchSettings({ pythonPath: list[0].path })
      }
      return ok<PythonInfo[]>(list)
    } catch (err) {
      return fail(err)
    }
  })

  /** 用 pip 装 / 升级 mcdreforged */
  ipcMain.handle('python:installMcdr', async (_e, path: string) => {
    try {
      if (!path?.trim()) throw new Error('请先选择一个 Python')
      const before = await probePython(path.trim())
      if (!before) throw new Error('这个路径不是能用的 python.exe')

      await installMcdr(path.trim(), (line) => {
        // pip 的输出很碎，只把有信息量的行转给界面当进度
        const text = line
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !/^\s*$/.test(l))
          .pop()
        if (text) {
          send('download:progress', {
            taskId: 'mcdr-install',
            stage: 'extract',
            message: text.slice(0, 160),
            received: 0,
            total: 0,
            percent: 0
          } satisfies DownloadProgress)
        }
      })

      const after = await probePython(path.trim())
      store.patchSettings({ pythonPath: path.trim() })
      if (after) store.patchSettings({ pythonList: [after, ...store.settings.pythonList.filter((p) => p.path !== after.path)] })
      send('download:progress', {
        taskId: 'mcdr-install',
        stage: 'done',
        message: `MCDReforged ${after?.mcdr ?? ''} 安装完成`,
        received: 0,
        total: 0,
        percent: 100
      } satisfies DownloadProgress)
      return ok<PythonInfo | null>(after)
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- 文件

  ipcMain.handle('fs:list', async (_e, root: string, rel: string) => {
    try {
      return ok<FileEntry[]>(await listDir(root, rel))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('fs:read', async (_e, root: string, rel: string) => {
    try {
      return ok(await readTextFile(root, rel))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('fs:write', async (_e, root: string, rel: string, content: string) => {
    try {
      await writeTextFile(root, rel, content)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('fs:mkdir', async (_e, root: string, rel: string) => {
    try {
      await createDir(root, rel)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('fs:rename', async (_e, root: string, rel: string, newName: string) => {
    try {
      await renamePath(root, rel, newName)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('fs:delete', async (_e, root: string, rel: string) => {
    try {
      // how 决定界面怎么措辞：回收站里的能找回来，直接删的找不回来
      const how = await deletePath(root, rel, (p) => shell.trashItem(p))
      return ok({ how })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('fs:reveal', async (_e, root: string, rel: string) => {
    const full = safeJoin(root, rel)
    if (!full) return fail('路径越界')
    shell.showItemInFolder(full)
    return ok(true)
  })

  /** 目录体积，文件面板用来显示 world / mods 这些文件夹有多大 */
  ipcMain.handle('fs:dirSize', async (_e, root: string, rel: string) => {
    try {
      const full = safeJoin(root, rel)
      if (!full) return fail('路径越界')
      return ok(await dirSize(full))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('fs:openPath', async (_e, root: string, rel: string) => {
    const full = safeJoin(root, rel)
    if (!full) return fail('路径越界')
    const err = await shell.openPath(full)
    return err ? fail(err) : ok(true)
  })

  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return fail('只允许打开 http/https 链接')
    await shell.openExternal(url)
    return ok(true)
  })

  ipcMain.handle('app:pickDirectory', async (_e, title?: string) => {
    const win = ctx.getWindow()
    const res = win
      ? await dialog.showOpenDialog(win, {
          title: title || '选择文件夹',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return ok(res.canceled ? '' : res.filePaths[0] || '')
  })

  /**
   * 读一张本地图片，转成 data URL 交给界面当背景。
   *
   * 校验与读取都在 images.ts 里（图标也用同一份），这里只管收发。
   */
  ipcMain.handle('app:readImage', async (_e, file: string) => {
    try {
      return ok(await readImageDataUrl(file))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 下载源给的图标（Modrinth 等）。
   *
   * 页面 CSP 不允许 https 图片，所以由主进程抓下来转成 data URL；
   * 主进程里顺带做了缓存和体积限制，同一张图翻来覆去只下一次。
   */
  ipcMain.handle('app:fetchImage', async (_e, url: string) => {
    try {
      const res = await fetchImageDataUrl(url)
      return ok({ dataUrl: res.dataUrl, bytes: res.bytes, cached: res.cached })
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 服务器图标：读一张已收进 icons/ 的图。
   *
   * 传的是文件名而不是路径，主进程自己拼目录并检查名字 ——
   * 配置文件是能被手改的，不能让它变成任意文件读取的入口。
   */
  ipcMain.handle('app:readIcon', async (_e, name: string) => {
    try {
      return ok(await readIcon(app.getPath('userData'), name))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 收下一张图标：复制进 icons/，返回文件名（配置里存 `file:<名字>`）。
   *
   * 复制而不是记原路径，用户之后把原图挪走、删掉都不影响；
   * 同时会清掉这台服务器上一版的图标文件。
   */
  ipcMain.handle('app:importIcon', async (_e, serverId: string, srcPath: string) => {
    try {
      if (!store.getServer(serverId)) throw new Error('服务器不存在')
      const imported = await importIcon(app.getPath('userData'), serverId, srcPath)
      return ok(imported)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('app:pickFile', async (_e, title?: string, kind?: 'image') => {
    const win = ctx.getWindow()
    const opts: Electron.OpenDialogOptions = {
      title: title || '选择文件',
      properties: ['openFile']
    }
    // 选背景图时先把非图片挡掉，省得选完了才被告知「这不是图片」
    if (kind === 'image') opts.filters = [{ name: '图片', extensions: IMAGE_EXTS }]
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return ok(res.canceled ? '' : res.filePaths[0] || '')
  })

  // ---------------------------------------------------------- server.properties

  ipcMain.handle('props:read', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      // server.properties 在服务端核心目录里，不一定就是 cfg.dir
      const layout = await resolveLayout(cfg)
      if (!(await pathExists(layout.serverProperties))) return ok<PropertiesEntry[] | null>(null)
      return ok<PropertiesEntry[]>(await parsePropertiesFile(layout.serverProperties))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('props:write', async (_e, id: string, entries: PropertiesEntry[]) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      await writeProperties(layout.serverProperties, entries)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- 玩家

  ipcMain.handle('players:list', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      // ops.json / whitelist.json 都在服务端核心目录里
      const layout = await resolveLayout(cfg)
      const online = new Set(manager.runtime(id).onlinePlayers)
      // 外部启动的服务端 manager 不知道在线名单；从 latest.log 的登录/退出补上
      for (const name of await logOnlineNames(layout.core)) online.add(name)
      return ok<PlayerRecord[]>(await listPlayers(layout.playersDir, [...online]))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 头像按「名字 + UUID」缓存在 userData/avatars，7 天才重新拉。
   * 界面把当前玩家列表传上来，主进程只做校验、下载与缓存。
   */
  ipcMain.handle(
    'players:avatars',
    async (_e, id: string, players: { name: string; uuid?: string }[]) => {
      try {
        if (!store.getServer(id)) throw new Error('服务器不存在')
        if (!Array.isArray(players)) throw new Error('玩家列表格式不正确')
        return ok<Record<string, string | null>>(await getAvatars(players))
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * 地图右侧的玩家档案：Mojang 正版信息 + playerdata 里的经验 / 背包 /
   * 末影箱 / 装备。网络失败只影响对应字段，不会让整个请求失败。
   */
  ipcMain.handle(
    'players:detail',
    async (_e, id: string, name: string, uuid?: string) => {
      try {
        const cfg = store.getServer(id)
        if (!cfg) throw new Error('服务器不存在')
        const layout = await resolveLayout(cfg)
        return ok<PlayerProfile>(
          await getPlayerProfile(cfg, layout, name, typeof uuid === 'string' ? uuid : undefined)
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  /** 批量取物品图标（按当前服务器的 Minecraft 资源版本），带磁盘缓存 */
  ipcMain.handle('players:itemIcons', async (_e, id: string, ids: string[]) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      if (!Array.isArray(ids)) throw new Error('物品列表格式不正确')
      return ok<Record<string, string | null>>(
        await getItemIcons(
          cfg.mcVersion,
          ids.filter((v): v is string => typeof v === 'string').slice(0, 200)
        )
      )
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('players:setOp', async (_e, id: string, name: string, value: boolean) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      await setOp(layout.playersDir, name, value)
      if (manager.isRunning(id)) {
        manager.sendCommand(id, `${value ? 'op' : 'deop'} ${name}`)
      }
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('players:setWhitelist', async (_e, id: string, name: string, value: boolean) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      await setWhitelist(layout.playersDir, name, value)
      if (manager.isRunning(id)) {
        manager.sendCommand(id, value ? `whitelist add ${name}` : `whitelist remove ${name}`)
      }
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('players:setBanned', async (_e, id: string, name: string, value: boolean) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      await setBanned(layout.playersDir, name, value)
      if (manager.isRunning(id)) {
        manager.sendCommand(id, value ? `ban ${name} 手动封禁` : `pardon ${name}`)
      }
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- 插件 / 模组

  ipcMain.handle('plugins:list', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      return ok<PluginInfo[]>(await listPlugins(layout, cfg.kind))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('plugins:toggle', async (_e, id: string, relPath: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      // relPath 是相对服务器根目录的路径，不用再套核心目录
      const next = await togglePlugin(cfg.dir, relPath)
      return ok(next)
    } catch (err) {
      return fail(err)
    }
  })

  /** 批量启用 / 禁用（多选、全选、一键切换都走这里） */
  ipcMain.handle(
    'plugins:setEnabled',
    async (_e, id: string, relPaths: string[], enabled: boolean) => {
      try {
        const cfg = store.getServer(id)
        if (!cfg) throw new Error('服务器不存在')
        return ok(await setPluginsEnabled(cfg.dir, relPaths, enabled))
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * 删除一个模组 / 插件文件。
   *
   * 只允许删布局解析出来的那几个扩展目录里的东西——这个通道名正言顺地
   * 拿到「相对服务器根目录的路径」，如果不管住，界面里一个路径错误就可能
   * 顺着它删到 server.properties 或者世界存档。
   */
  ipcMain.handle('plugins:delete', async (_e, id: string, relPath: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const layout = await resolveLayout(cfg)
      resolveExtensionFile(layout, relPath)

      const how = await deletePath(cfg.dir, relPath, (p) => shell.trashItem(p))
      return ok({ how })
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- 备份

  ipcMain.handle('backups:list', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      return ok<BackupInfo[]>(await listBackups(cfg.dir))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('backups:create', async (_e, id: string, label: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      const taskId = `backup-${id}`
      const info = await createBackup(cfg.dir, label, (message) =>
        send('download:progress', {
          taskId,
          stage: 'extract',
          message,
          received: 0,
          total: 0,
          percent: 0
        } satisfies DownloadProgress)
      )
      send('download:progress', {
        taskId,
        stage: 'done',
        message: '备份完成',
        received: 0,
        total: 0,
        percent: 100
      } satisfies DownloadProgress)
      return ok<BackupInfo>(info)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('backups:delete', async (_e, id: string, relPath: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      await deleteBackup(cfg.dir, relPath)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('backups:restore', async (_e, id: string, relPath: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      if (manager.isRunning(id)) throw new Error('请先停止服务器再还原备份')
      const rescue = await restoreBackup(cfg.dir, relPath)
      return ok(rescue)
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- 新建服务器

  ipcMain.handle('versions:list', async (_e, kind) => {
    try {
      return ok(await listVersions(kind))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 新建服务器。
   *
   * 三种形态：
   * - 直接下核心（原版 / Paper / Purpur / Fabric）：jar 落在目录里，-jar 启动
   * - Forge / NeoForge：官方只给安装器，跑完拿到参数文件，`java @文件` 启动
   * - 再勾一层 MCDReforged：核心装进 server/ 子目录，根目录留给 MCDR 自己
   */
  ipcMain.handle('server:create', async (_e, req: CreateServerRequest) => {
    try {
      if (!req.name?.trim()) throw new Error('请填写服务器名称')
      if (!req.dir) throw new Error('请选择安装目录')

      const targetDir = join(req.dir, req.name.trim())
      if (await pathExists(targetDir)) {
        const entries = await fs.readdir(targetDir)
        if (entries.length) throw new Error(`目录已存在且不为空：${targetDir}`)
      }

      // MCDR 是套在外面的包装层，核心得让开位置
      const wrap = !!req.mcdr
      const coreDir = wrap ? 'server' : ''
      const installDir = wrap ? join(targetDir, coreDir) : targetDir

      // 勾了 MCDR 就得先确认这台机器真的跑得起来它：
      // 没有 Python、或者 Python 里没有 mcdreforged，装完也启动不了
      let python: PythonInfo | null = null
      if (wrap) {
        python = req.pythonPath?.trim()
          ? await probePython(req.pythonPath.trim())
          : (await detectPython())[0] ?? null
        const ready = mcdrReady(python)
        if (!ready.ok) {
          throw new Error(
            `${ready.reason}。可以在设置里检测并安装 MCDReforged，或者先不勾选它，装完再加。`
          )
        }
      }

      const taskId = `create-${Date.now()}`
      const result = await installServer(
        installDir,
        req.kind,
        req.mcVersion,
        {
          motd: req.motd,
          port: req.port,
          maxPlayers: 20,
          acceptEula: req.acceptEula,
          onlineMode: req.onlineMode ?? true,
          build: req.build,
          // Forge / NeoForge 的安装器本身也是个 Java 程序，得用能跑它的那个
          javaPath: store.settings.javaPath
        },
        taskId,
        (p) => send('download:progress', p)
      )

      // 这个版本要哪个 Java：先按版本表估一个，再从探测到的列表里挑够用的。
      // 不挑的话就会出现「用 Java 24 跑要求 Java 25 的服务端」，
      // 结果是一句「已崩溃」，用户根本看不出为什么。
      // 代理端的版本号不是 MC 版本号，Java 要求得单独算（见 javaHint.ts）
      const need = isProxyKind(req.kind)
        ? proxyJavaMajor(req.kind, req.mcVersion)
        : requiredJavaMajor(req.mcVersion)
      const picked = pickJavaFor(store.settings, need)

      // 配置里的 jar / 参数文件统一按「相对服务器根目录」记
      const inRoot = (rel: string): string => (coreDir ? `${coreDir}/${rel}` : rel)

      const cfg = defaultServer({
        name: req.name.trim(),
        dir: targetDir,
        jar: result.jar ? inRoot(result.jar) : '',
        launchArgs: result.launchArgs ? inRoot(result.launchArgs) : '',
        // MCDR 托管时由它的 config.yml 决定怎么起核心，这里不放脚本
        startScript: '',
        kind: req.kind,
        mcVersion: req.mcVersion,
        javaPath: picked.path,
        memoryMin: req.memoryMin,
        memoryMax: req.memoryMax,
        jvmArgs: store.settings.defaultJvmArgs,
        serverArgs: isProxyKind(req.kind) ? '' : 'nogui',
        coreDir,
        mcdr: wrap,
        pythonPath: wrap ? (python?.path ?? '') : '',
        icon: kindLabel(req.kind),
        color: kindColor(req.kind)
      })

      if (wrap && python) {
        const setup = {
          root: targetDir,
          coreDir,
          // MCDR 会切进 coreDir 再执行启动命令，所以这两个都是相对 coreDir
          jar: result.jar,
          launchArgs: result.launchArgs,
          kind: req.kind,
          mcVersion: req.mcVersion,
          memoryMin: req.memoryMin,
          memoryMax: req.memoryMax,
          pythonPath: python.path,
          isProxy: isProxyKind(req.kind)
        }
        // 先让 MCDR 自己把环境铺好（permission.yml 缺了它直接拒绝启动），
        // 再把 config.yml 里的启动命令与 handler 改成这一台该有的样子
        await initMcdrEnvironment(targetDir, python.path)
        await writeMcdrConfig(setup)
        // 顺带放一个 start.bat：不通过 CraftDesk 也能手动把它跑起来
        await writeMcdrStartScript(setup)
      }

      store.addServer(cfg)

      // 目录都交给布局解析：MCDR 布局下 MCDR 插件、服务端插件、模组是三处
      const layout = await resolveLayout(cfg)
      store.updateServer(cfg.id, {
        pluginsDir: layout.mcPluginsDir ? toRootRel(layout, layout.mcPluginsDir) : '',
        modsDir: layout.modsDir ? toRootRel(layout, layout.modsDir) : ''
      })

      // 没用 MCDR 时顺手放一个 start.bat：服务器起不来的时候，
      // 双击它就能看到 Java 的原话，比在界面里猜快
      if (!wrap) await writeStartScriptHost(store.getServer(cfg.id)!)

      send('servers:changed')
      return ok<ServerView>(manager.getServer(cfg.id)!)
    } catch (err) {
      return fail(err)
    }
  })

  /** 生成（或重新生成）启动脚本 */
  ipcMain.handle('server:writeStartScript', async (_e, id: string) => {
    try {
      const cfg = store.getServer(id)
      if (!cfg) throw new Error('服务器不存在')
      if (cfg.mcdr) {
        throw new Error('这台服务器由 MCDReforged 托管，启动命令在它的 config.yml 里，不需要另外的脚本')
      }
      const res = await writeStartScriptHost(cfg)
      return ok(res)
    } catch (err) {
      return fail(err)
    }
  })

  // ---------------------------------------------------------- 窗口控制

  ipcMain.handle('window:minimize', () => {
    ctx.getWindow()?.minimize()
    return ok(true)
  })
  ipcMain.handle('window:maximize', () => {
    const win = ctx.getWindow()
    if (!win) return ok(false)
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return ok(win.isMaximized())
  })
  ipcMain.handle('window:close', () => {
    ctx.getWindow()?.close()
    return ok(true)
  })
  ipcMain.handle('window:isMaximized', () => ok(ctx.getWindow()?.isMaximized() ?? false))

  ipcMain.handle('shell:openFolder', async (_e, dir: string) => {
    const err = await shell.openPath(dir)
    return err ? fail(err) : ok(true)
  })

  ipcMain.handle('app:revealUserData', async () => {
    shell.openPath(app.getPath('userData'))
    return ok(app.getPath('userData'))
  })

  ipcMain.handle('app:info', () =>
    ok({
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: `${process.platform} ${process.arch}`,
      userData: app.getPath('userData'),
      // 便携版把配置放在 exe 旁边，界面上要说清楚，不然用户找不到自己的配置
      portable: ctx.dataDir.portable,
      dataNote: ctx.dataDir.reason,
      home: app.getPath('home'),
      cpus: cpus().length,
      totalMem: totalmem(),
      // 单实例锁会让新进程直接退出，界面上显示启动时间才能看出跑的是不是旧实例
      startedAt: bootAt
    })
  )
}
