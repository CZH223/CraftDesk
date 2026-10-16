/** 主进程与渲染进程共享的类型定义 */

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

export type ServerKind =
  | 'vanilla'
  | 'paper'
  | 'purpur'
  | 'spigot'
  | 'fabric'
  | 'forge'
  | 'neoforge'
  | 'bukkit'
  // 代理端：本身不加载世界，只把玩家转发到后端的多个服务端
  | 'velocity'
  | 'bungeecord'
  | 'waterfall'
  | 'unknown'

/** 代理端没有世界、没有 EULA、没有 server.properties，很多假设都不成立 */
export const PROXY_KINDS: ServerKind[] = ['velocity', 'bungeecord', 'waterfall']

export function isProxyKind(kind: ServerKind | string): boolean {
  return PROXY_KINDS.includes(kind as ServerKind)
}

/** 一个受管理的服务器配置（持久化） */
export interface ServerConfig {
  id: string
  name: string
  dir: string
  /** 启动用的 jar 相对路径，例如 server.jar 或 server/fabric-server-launch.jar */
  jar: string
  /** 相对路径的启动脚本（.bat/.sh），优先级高于 jar */
  startScript: string
  /**
   * Forge / NeoForge（1.17+）不用 -jar 启动，而是展开一个参数文件：
   * `java @libraries/.../win_args.txt`。这里和 jar 一样是相对服务器根目录的路径。
   */
  launchArgs: string
  /** 由 MCDReforged 托管时，跑 MCDR 用的 python.exe */
  pythonPath: string
  javaPath: string
  memoryMin: number
  memoryMax: number
  jvmArgs: string
  serverArgs: string
  kind: ServerKind
  mcVersion: string
  /**
   * Minecraft 服务端核心所在的子目录（相对 dir），空表示就在根目录。
   * server.properties、ops.json、config/ 等都跟着它走——
   * MCDReforged 这类布局里根目录只有包装层，真正的服务端在 server/ 下面。
   */
  coreDir: string
  /** 是否由 MCDReforged 托管 */
  mcdr: boolean
  /** 该服务端是否支持插件（bukkit 系） */
  pluginsDir: string
  modsDir: string
  autoRestart: boolean
  createdAt: number
  lastStartedAt: number
  /** 累计运行秒数 */
  totalUptime: number
  /** 界面用色，空则按名称生成 */
  color: string
  icon: string
  note: string
  order: number
}

/** 进程运行时状态（不持久化） */
export interface ServerRuntime {
  id: string
  status: ServerStatus
  pid: number | null
  startedAt: number | null
  /** 已运行秒数 */
  uptime: number
  onlinePlayers: string[]
  /**
   * 在线人数。优先用 Server List Ping 问服务端要来的数字——
   * 客户端服务器列表里显示的就是它，两边必然一致。
   * 问不到（还没启动完、被防火墙挡住）才退回日志里数出来的人数。
   */
  onlineCount: number
  maxPlayers: number
  /**
   * CraftDesk 没启动它，但它的端口上有服务端在响应。
   * 手动开服、用启动脚本开服、MCDR 自己的进程都会是这样：
   * 进程不归我们管，但「有没有人在线」我们照样能问到。
   */
  externalRunning: boolean
  /** 实际监听的端口，优先取日志里 "Listening on" 报出来的值 */
  port: number | null
  /** 最近一次解析出的 TPS */
  tps: number | null
  /** 最近一次进程退出码 */
  exitCode: number | null
  /** 需要用户处理的问题，例如 EULA 未同意 */
  issue:
    | 'eula'
    | 'port-in-use'
    | 'java-missing'
    | 'crash'
    | 'backend-down'
    /** 这个目录里已经有一个 MCDReforged 在跑了（它占着日志文件） */
    | 'mcdr-running'
    | null
  issueDetail: string
}

export interface ServerView extends ServerConfig {
  runtime: ServerRuntime
}

export type LogLevel = 'info' | 'warn' | 'error' | 'chat' | 'system' | 'debug'

export interface LogLine {
  t: number
  level: LogLevel
  /** 已剥离时间戳/线程前缀的正文 */
  text: string
  /** 原始整行 */
  raw: string
  /** 若为玩家聊天，这里是玩家名 */
  player?: string
}

/** 目录扫描结果，用于导入已有服务端 */
export interface DetectedServer {
  dir: string
  name: string
  /** 相对于 dir 的 jar 路径，可能带子目录，例如 "server/server.jar" */
  jars: string[]
  /** 相对于 dir 的脚本路径 */
  scripts: string[]
  kind: ServerKind
  mcVersion: string
  suggestedJar: string
  suggestedScript: string
  /**
   * Forge / NeoForge 1.17+ 的启动参数文件（相对 dir）。
   * 这类服务端没有可 -jar 的核心，导入时得按 `java @文件` 启动。
   */
  suggestedArgs: string
  /**
   * 核心在子目录、而启动脚本在外层时（MCDReforged 等包装层），
   * 优先用脚本启动，否则会绕过包装层丢掉它的功能。
   */
  preferScript: boolean
  /** 服务端核心所在的子目录，空字符串表示就在根目录 */
  coreDir: string
  /** 是否由 MCDReforged 之类的包装层托管 */
  isMcdr: boolean
  eulaAccepted: boolean
  hasWorld: boolean
  port: number | null
  motd: string | null
  sizeBytes: number
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
  ext: string
  /** 受保护条目，界面上弱化显示（比如 . 开头的文件） */
  hidden: boolean
}

export interface PropertiesEntry {
  key: string
  value: string
  comment?: string
  /** 关键项会被界面重点展示 */
  important?: boolean
}

export interface PlayerRecord {
  name: string
  uuid?: string
  /** 在线 */
  online: boolean
  op: boolean
  whitelisted: boolean
  banned: boolean
  /** 白名单模式下的玩家 */
  lastSeen?: number
}

/**
 * 四类扩展是完全不同的东西，不能混为一谈：
 * - mcdr  ：MCDReforged 的 Python 插件（.mcdr / .pyz / .py / 目录），跑在 MCDR 里
 * - proxy ：代理端插件（Velocity 的 velocity-plugin.json / BungeeCord 的 bungee.yml）
 * - plugin：服务端本体加载的插件（Bukkit 系 jar，放 plugins/）
 * - mod   ：服务端本体加载的模组（Fabric / Forge jar，放 mods/）
 */
export type PluginKind = 'mcdr' | 'proxy' | 'plugin' | 'mod'

/**
 * 删除服务器的两种程度：
 * - link ：只从 CraftDesk 的列表里摘掉，磁盘原封不动
 * - files：连服务器目录一起删掉（走回收站）
 */
export type ServerDeleteMode = 'link' | 'files'

/** 删除文件用的方式，决定界面该怎么措辞 */
export type DeleteMethod = 'trash' | 'permanent'

export interface PluginInfo {
  /** 插件声明的 id，读不到则用文件名 */
  id: string
  name: string
  file: string
  /** 相对于服务器根目录的路径，用于定位与开关 */
  path: string
  size: number
  enabled: boolean
  kind: PluginKind
  /** 从 jar / mcdr 包内读出的版本、作者，读不到则为空 */
  version: string
  author: string
  description: string
  /** MCDR 插件声明的依赖，已剔除 mcdreforged 自身 */
  dependencies: string[]
  /** 所在目录（相对根目录），用于分组显示 */
  group: string

  // ---- 依赖关系 ----
  /** 硬前置：缺了它这个扩展根本不会加载 */
  depends: string[]
  /** 软前置：没装也能跑，装了功能更全 */
  softDepends: string[]
  /** 除自己之外还提供的 id（Fabric 的 provides、内嵌 jar 里的模组） */
  provides: string[]
  /** 声明不兼容的扩展 */
  breaks: string[]
  /** 依赖项的版本要求，只用于显示，不做判定 */
  ranges: Record<string, string>
  /** 文件读不动（zip 坏了 / 被截断），元数据什么都读不出来 */
  broken: boolean
  /**
   * 在服务端起不起作用。Fabric 模组自己声明（environment），
   * 服务端插件与 MCDR 插件天然是服务端侧；Forge 系没有这个字段，只能是 unknown。
   */
  side: ModSide
  /** 算好的前置列表：每一项带上「装没装 / 被禁用 / 平台自带」 */
  requires: RelationEdge[]
  /** 反过来的：谁依赖它 */
  usedBy: DependentRef[]
}

/**
 * 一条依赖关系。「前置」在界面上的所有颜色都由 state 决定：
 * 缺失是红的（服务器起不来就是这个原因），被禁用是橙的，平台自带是灰的。
 */
export interface RelationEdge {
  id: string
  hard: boolean
  range: string
  state: 'ok' | 'disabled' | 'missing' | 'platform'
  provider: string | null
  providerName: string | null
}

export interface DependentRef {
  path: string
  name: string
  soft: boolean
}

/** 整体问题汇总，给扩展面板顶部那条提示用 */
export interface RelationIssue {
  kind: 'missing' | 'disabled'
  id: string
  neededBy: string[]
  provider: string | null
}

/**
 * 扩展在哪一侧生效：
 * - both    两边都要（大多数模组）
 * - client  纯客户端：服务端加载了也不起任何作用
 * - server  只在服务端 / 代理端
 * - unknown 描述文件里没写，判断不了（Forge / NeoForge 系）
 */
export type ModSide = 'both' | 'client' | 'server' | 'unknown'

/** 一个可编辑的配置文件 */
export interface ConfigFile {
  name: string
  /** 相对于服务器根目录的路径 */
  path: string
  size: number
  mtime: number
  /** 配置属于哪一层 */
  source: 'mcdr' | 'server'
  /** 分组名，一般是插件的配置目录名 */
  group: string
}

/** 解析后的服务器目录布局，界面用它显示核心位置、MCDR 提示等 */
export interface ServerLayoutInfo {
  /** 服务端核心相对根目录的位置，空表示就在根目录 */
  coreRel: string
  isMcdr: boolean
  /** MCDR config.yml 里的实际启动命令 */
  mcdrStartCommand: string | null
  /** 从启动命令里解析出的内存，单位 MB */
  mcdrMemory: { min: number | null; max: number | null }
  mcdrPluginsDir: string
  mcdrConfigDir: string
  mcPluginsDir: string
  modsDir: string
  configDir: string
  /** 代理端（Velocity / BungeeCord / Waterfall） */
  isProxy: boolean
  /** 代理端配置文件相对根目录的路径，例如 velocity.toml */
  proxyConfigFile: string
  /** 配置里声明的监听端口 */
  configuredPort: number | null
}

export interface BackupInfo {
  name: string
  path: string
  size: number
  createdAt: number
}

/** 找得到的 Python 解释器，以及它里面 mcdreforged 的版本 */
export interface PythonInfo {
  path: string
  version: string
  major: number
  minor: number
  /** 里面装的 mcdreforged 版本，没装是 null */
  mcdr: string | null
  /** 版本够新（MCDR 要 3.8+），装了也不一定能用 */
  suitable: boolean
  valid: boolean
}

export interface JavaInfo {
  path: string
  version: string
  major: number
  vendor: string
  valid: boolean
}

export interface AppSettings {
  javaPath: string
  /** 自动检测到的 java 列表缓存 */
  javaList: JavaInfo[]
  /** 跑 MCDReforged 用的 python.exe */
  pythonPath: string
  /** 自动检测到的 Python 列表缓存 */
  pythonList: PythonInfo[]
  defaultMemoryMax: number
  defaultMemoryMin: number
  defaultJvmArgs: string
  closeToTray: boolean
  stopOnExit: boolean
  maxLogLines: number
  /** CurseForge 官方 API 必须要 key，用户自己去 console.curseforge.com 申请 */
  curseforgeApiKey: string
  theme: 'dark'

  // ---- 界面尺寸（拖动分栏线或在这里精确设置）----
  /** 左侧服务器列表宽度，px */
  sideWidth: number
  /** 右侧面板宽度，px */
  panelWidth: number

  // ---- 个性化：背景图 ----
  /** 背景图片的绝对路径，空表示不用 */
  backgroundImage: string
  /** 背景图的不透明度 0~1 */
  backgroundOpacity: number
  /**
   * 界面面板的不透明度 0~1。调低才能看见背景 —— 面板是不透明的，
   * 背景图再漂亮也透不出来，这两个要一起用。
   */
  surfaceOpacity: number
}

/** 下载进度 */
export interface DownloadProgress {
  taskId: string
  stage: 'meta' | 'download' | 'extract' | 'done' | 'error'
  message: string
  received: number
  total: number
  percent: number
}

export interface CreateServerRequest {
  name: string
  dir: string
  kind: ServerKind
  mcVersion: string
  /** Forge / NeoForge 要装的构建号 */
  build?: string
  memoryMin: number
  memoryMax: number
  port: number
  motd: string
  acceptEula: boolean
  /** 装完之后再用 MCDReforged 包一层 */
  mcdr?: boolean
  pythonPath?: string
}

export interface RemoteVersion {
  id: string
  kind: ServerKind
  /** 可用构建号 / 加载器版本 */
  builds?: string[]
}

export interface IpcResult<T> {
  ok: boolean
  data?: T
  error?: string
}

export type TomlValueType = 'string' | 'number' | 'boolean' | 'array'

export interface TomlField {
  /** 所在的段，空字符串表示顶层 */
  section: string
  key: string
  /** 去掉引号后的值，用于界面展示与编辑 */
  value: string
  /** 文件里的原始写法，例如 "0.0.0.0:25566" / true / -1 */
  rawValue: string
  type: TomlValueType
  /** 紧挨在这个键上方的注释 */
  comment: string
  /** 在文件里占用的行区间，多行数组会跨行 */
  startLine: number
  endLine: number
}

export interface VelocityUpdate {
  section: string
  key: string
  value: string
  type: TomlValueType
}

export interface VelocityServerEntry {
  name: string
  address: string
  host: string
  port: number
}

export interface VelocityFile {
  path: string
  exists: boolean
  fields: TomlField[]
  servers: VelocityServerEntry[]
  tryList: string[]
  /** forwarding.secret 的内容 */
  secret: string | null
  secretFile: string
  raw: string
}

/** 后端转发配置的检查结果 */
export interface BackendIssue {
  level: 'error' | 'warn' | 'info'
  text: string
}

export interface BackendCheck {
  name: string
  address: string
  host: string
  port: number
  /** CraftDesk 里托管的对应服务器，按端口匹配 */
  managedId: string | null
  managedName: string | null
  managedRunning: boolean
  /** 后端装的转发支持模组 */
  proxyMod: string | null
  proxyModFile: string | null
  /** 后端服务器根目录，配合 proxyConfigRel 才能在界面上正确定位文件 */
  managedDir: string | null
  proxyConfigPath: string | null
  proxyConfigRel: string | null
  backendSecret: string | null
  /** 密钥是否与代理端一致，null 表示无法判断 */
  secretOk: boolean | null
  backendOnlineMode: boolean | null
  hackOnlineMode: boolean | null
  issues: BackendIssue[]
}

// ---------------------------------------------------------------- 跨服网络的导入

/**
 * 导入代理端时，它配置里的一个后端对应的「可导入情况」。
 * 代理端不是一台普通服务器，而是一组服务器的入口，所以要按网络来导入。
 */
export interface NetworkBackendPlan {
  /** 代理端配置里的键名，例如 survival / mirror */
  alias: string
  /** 配置里的地址，例如 127.0.0.1:25565 */
  address: string
  host: string
  port: number
  /** 已经在 CraftDesk 列表里的那一台 */
  managedId: string | null
  managedName: string | null
  /** 磁盘上找到的目录（绝对路径） */
  dir: string | null
  /** 相对搜索起点的路径，界面显示用 */
  displayDir: string
  /** 找到的目录能不能当服务器导入 */
  detected: DetectedServer | null
  /**
   * managed      已经在列表里，不用再导
   * found        找到了目录，可以导入
   * address-only 只有地址，磁盘上没有对应的目录
   * not-a-server 目录在，但里面不像服务端
   */
  status: 'managed' | 'found' | 'address-only' | 'not-a-server'
  /** 怎么找到的：port（端口对上，可靠）/ name（按名字猜的） */
  foundBy: 'port' | 'name' | ''
  /** 界面上一句话说明 */
  note: string
}

export interface NetworkPlan {
  /** 代理端目录本身的识别结果 */
  proxy: DetectedServer
  proxyPort: number | null
  backends: NetworkBackendPlan[]
  /** 扫了多少个候选目录，界面用来解释「为什么没找到」 */
  scanned: number
  /** 搜索起点，界面上用来说明「在哪儿找的」 */
  searchRoot: string
}

// ---------------------------------------------------------------- 扩展下载源

/** 装到服务器上的哪个目录 */
export type InstallTarget = 'mod' | 'plugin' | 'mcdr'

export interface ModrinthHit {
  source: 'modrinth'
  projectId: string
  slug: string
  title: string
  description: string
  author: string
  downloads: number
  follows: number
  categories: string[]
  gameVersions: string[]
  iconUrl: string | null
  projectType: string
  license: string
  updatedAt: string
  /** required / optional / unsupported / unknown，用于提示这个模组能不能装在服务端 */
  serverSide: string
  clientSide: string
}

export interface ModrinthVersion {
  id: string
  name: string
  versionNumber: string
  versionType: string
  gameVersions: string[]
  loaders: string[]
  publishedAt: string
  downloads: number
  fileName: string
  fileUrl: string
  fileSize: number
  requiredDependencies: string[]
}

export interface McdrRelease {
  version: string
  fileName: string
  size: number
  downloads: number
  uploadedAt: string
  /** .mcdr / .pyz 的直链 */
  url: string
}

export interface McdrPlugin {
  source: 'mcdr'
  id: string
  /** 目录里给的是中文名，没有的话回退到 id */
  name: string
  version: string
  authors: string[]
  description: string
  /** 已翻译成中文的标签，例如「管理」「工具」 */
  labels: string[]
  downloads?: number
  repository: string
  dependencies: { id: string; requirement: string }[]
  /** 可直接安装的版本，已按目录给出的顺序排列 */
  releases: McdrRelease[]
}

export interface InstallRequest {
  serverId: string
  target: InstallTarget
  url: string
  fileName: string
  /** 只用于提示文案 */
  label: string
  /** 下载源给出的文件大小，用来核对下载有没有少字节 */
  fileSize?: number
}

// ---------------------------------------------------------------- 网络拓扑

/** 拓扑图上的一个节点：托管服务器，或只在 [servers] 里出现的外部地址 */
export interface TopoNode {
  /** 托管服务器用真实 id；未托管的用 external:host:port */
  id: string
  name: string
  kind: ServerKind | ''
  managed: boolean
  running: boolean
  /** external = 端口上有服务端在响应，但不是 CraftDesk 启动的 */
  status: ServerStatus | 'unknown' | 'external'
  port: number | null
  address: string
  /** 当前在线人数（后端只算自己这台上的） */
  onlinePlayers: number
  maxPlayers: number
  /**
   * 有别的服务器配了同一个端口。它们互斥——同时启动只有一个能绑上端口，
   * 所以界面上要并列显示并标出来。
   */
  sharedPort: boolean
}

/** 代理端 → 后端的一条转发关系 */
export interface TopoEdge {
  proxyId: string
  backendId: string
  /** velocity.toml 里 [servers] 的键名 */
  alias: string
  address: string
  /** 在 try 列表里，也就是玩家登录时的默认入口 */
  isTry: boolean
  /** 后端装的转发模组 */
  proxyMod: string | null
  secretOk: boolean | null
}

export interface TopoProxy {
  node: TopoNode
  backends: TopoNode[]
  edges: TopoEdge[]
  forwardingMode: string
  secret: string | null
}

export interface Topology {
  proxies: TopoProxy[]
  /** 没有被任何代理端引用的服务器 */
  standalone: TopoNode[]
  /**
   * 整个网络真实的在线人数。
   *
   * 玩家是从代理端进来的，后端只是被转发到的下游——把两边的在线人数
   * 直接相加会把同一个人算两次，所以有代理端时以后者为准。
   */
  networkOnline: number
  /** 玩家看到的人数上限，取代理端的 show-max-players */
  networkMax: number
}

// ---------------------------------------------------------------- 统一的扩展源结果

export type RegistrySource = 'modrinth' | 'hangar' | 'spigot' | 'curseforge' | 'mcdr'

/**
 * 各个下载源的搜索结果统一成这个形状。
 * 不同站点的字段差别很大，界面只认这一份，新增源时不用再改界面。
 */
export interface RegistryHit {
  source: RegistrySource
  /** 源内唯一标识：Modrinth 是 projectId，Hangar 是 owner/slug，Spigot 是资源 id，CurseForge 是 modId */
  id: string
  name: string
  description: string
  authors: string[]
  downloads: number
  iconUrl: string | null
  categories: string[]
  /** 站内页面，供「打开主页」用 */
  pageUrl: string
  /** 卡片上额外展示的小标签 */
  extra: string[]
  /** 能不能直接下载安装 */
  installable: boolean
  /** 不能装的原因，会显示在按钮的提示里 */
  blockedReason?: string
}

/** 统一的可安装版本 */
export interface RegistryVersion {
  id: string
  /** 版本号 */
  name: string
  /** release / beta / alpha */
  channel: string
  fileName: string
  fileUrl: string
  fileSize: number
  downloads: number
  publishedAt: string
  gameVersions: string[]
  loaders: string[]
}
