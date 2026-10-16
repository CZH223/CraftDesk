/** server.properties 的界面元数据，主进程与渲染进程共用 */

/** 界面上会重点展示、且一眼能看懂的键 */
export const IMPORTANT_KEYS = new Set([
  'motd',
  'server-port',
  'server-ip',
  'max-players',
  'online-mode',
  'difficulty',
  'gamemode',
  'force-gamemode',
  'level-name',
  'level-seed',
  'level-type',
  'pvp',
  'white-list',
  'enforce-whitelist',
  'spawn-protection',
  'view-distance',
  'simulation-distance',
  'player-idle-timeout',
  'allow-flight',
  'allow-nether',
  'hardcore',
  'enable-command-block',
  'enable-rcon',
  'rcon.port',
  'rcon.password',
  'query.port',
  'resource-pack',
  'require-resource-pack',
  'max-world-size',
  'op-permission-level',
  'network-compression-threshold'
])

export const PROPERTY_LABELS: Record<string, string> = {
  motd: '服务器描述（MOTD）',
  'server-port': '服务器端口',
  'server-ip': '绑定 IP',
  'max-players': '最大玩家数',
  'online-mode': '正版验证',
  difficulty: '游戏难度',
  gamemode: '默认游戏模式',
  'force-gamemode': '强制游戏模式',
  'level-name': '世界名称',
  'level-seed': '世界种子',
  'level-type': '世界类型',
  'generator-settings': '自定义生成器设置',
  pvp: '允许玩家互相伤害',
  'white-list': '开启白名单',
  'enforce-whitelist': '强制白名单',
  'spawn-protection': '出生点保护半径',
  'view-distance': '视距（区块）',
  'simulation-distance': '模拟距离（区块）',
  'player-idle-timeout': '挂机踢出（分钟）',
  'allow-flight': '允许飞行',
  'allow-nether': '允许进入下界',
  hardcore: '极限模式',
  'enable-command-block': '启用命令方块',
  'enable-rcon': '启用 RCON',
  'rcon.port': 'RCON 端口',
  'rcon.password': 'RCON 密码',
  'query.port': 'Query 端口',
  'enable-query': '启用 Query',
  'enable-status': '在列表显示在线状态',
  'generate-structures': '生成结构',
  'spawn-monsters': '生成怪物',
  'spawn-animals': '生成动物',
  'spawn-npcs': '生成村民',
  'spawn-protection.legacy': '出生点保护',
  'network-compression-threshold': '网络压缩阈值',
  'resource-pack': '资源包地址',
  'resource-pack-prompt': '资源包提示文字',
  'resource-pack-sha1': '资源包 SHA1',
  'require-resource-pack': '强制使用资源包',
  'max-world-size': '世界最大边界',
  'op-permission-level': 'OP 权限等级',
  'function-permission-level': '函数权限等级',
  'max-tick-time': '单刻最大耗时（毫秒）',
  'sync-chunk-writes': '同步写入区块',
  'entity-broadcast-range-percentage': '实体广播范围百分比',
  'max-entity-collisions': '实体碰撞上限',
  'hide-online-players': '隐藏在线玩家列表',
  'broadcast-console-to-ops': '把控制台输出发给 OP',
  'broadcast-rcon-to-ops': '把 RCON 输出发给 OP',
  'log-ips': '记录玩家 IP',
  'prevent-proxy-connections': '阻止代理连接',
  'rate-limit': '数据包速率上限',
  'text-filtering-config': '文本过滤配置',
  'use-native-transport': '使用 Linux 原生传输',
  'debug': '调试模式',
  'bug-report-link': '问题反馈链接',
  'pause-when-empty-seconds': '空服时暂停秒数',
  'accepts-transfers': '接受跨服转移',
  'enforce-secure-profile': '强制安全聊天签名',
  'initial-enabled-packs': '初始启用数据包',
  'initial-disabled-packs': '初始禁用数据包'
}

/** 有固定取值的选项 */
export const PROPERTY_ENUMS: Record<string, { value: string; label: string }[]> = {
  difficulty: [
    { value: 'peaceful', label: '和平' },
    { value: 'easy', label: '简单' },
    { value: 'normal', label: '普通' },
    { value: 'hard', label: '困难' }
  ],
  gamemode: [
    { value: 'survival', label: '生存' },
    { value: 'creative', label: '创造' },
    { value: 'adventure', label: '冒险' },
    { value: 'spectator', label: '旁观' }
  ],
  'level-type': [
    { value: 'minecraft:normal', label: '默认' },
    { value: 'minecraft:flat', label: '超平坦' },
    { value: 'minecraft:large_biomes', label: '巨型生物群系' },
    { value: 'minecraft:amplified', label: '放大化' },
    { value: 'minecraft:single_biome_surface', label: '单一生物群系' }
  ],
  'op-permission-level': [
    { value: '1', label: '1 · 可绕过出生点保护' },
    { value: '2', label: '2 · 可用大部分指令' },
    { value: '3', label: '3 · 可封禁玩家' },
    { value: '4', label: '4 · 完全权限' }
  ],
  'function-permission-level': [
    { value: '1', label: '1' },
    { value: '2', label: '2' },
    { value: '3', label: '3' },
    { value: '4', label: '4' }
  ]
}

/** 这些键是布尔开关 */
export function isBooleanKey(value: string): boolean {
  return value === 'true' || value === 'false'
}

export function propertyLabel(key: string): string {
  return PROPERTY_LABELS[key] ?? key
}
