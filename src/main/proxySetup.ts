/**
 * 代理端的初始配置。
 *
 * 代理端（Velocity / Waterfall / BungeeCord）和普通服务端不一样：
 * 没有世界、没有 EULA、没有 server.properties，端口写在它自己的配置里。
 * 所以「下载完就能用」这件事得由这里补上 —— 否则用户下完一个 Velocity，
 * 启动后看到的是 25577 端口，而不是他新建时填的那个。
 *
 * 两家的做法不同：
 *
 *   Velocity         官方 jar 里自带 `default-velocity.toml`，我们把它取出来，
 *                    只改 bind / motd / online-mode。用官方模板的好处是
 *                    `config-version` 一定对得上那个版本 —— 手写一个版本号
 *                    写新了它会拒绝启动，写旧了要跑一遍迁移。
 *   BungeeCord 系    jar 里没有任何 yml（默认配置写在代码里），
 *                    所以用一份内置的最小模板：写进去的键会被采用，
 *                    没写的键 BungeeCord 自己按默认值补全。
 */

export type ProxyKind = 'velocity' | 'bungeecord' | 'waterfall'

export interface ProxySetupInput {
  kind: ProxyKind
  port: number
  motd: string
  /** 正版验证。后端是离线服的话，代理这边也要关掉，否则进不去 */
  onlineMode: boolean
}

/** TOML 基础字符串：引号和反斜杠要转义，否则用户填个引号就把配置写坏了 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** YAML 单引号字符串：里面的单引号写两遍 */
function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function proxyConfigName(kind: ProxyKind): string {
  return kind === 'velocity' ? 'velocity.toml' : 'config.yml'
}

/**
 * 改 Velocity 的配置。
 *
 * 只动三行，其余原样保留（官方模板里那几百行注释是给用户看的，
 * 整份重写会把它们全弄丢）。找不到键时插到第一个 `[section]` 之前 ——
 * 顶层键写到段后面就变成那个段的键了，Velocity 会解析成完全不同的意思。
 */
export function patchVelocityToml(template: string, input: ProxySetupInput): string {
  const eol = template.includes('\r\n') ? '\r\n' : '\n'
  const lines = template.split(/\r?\n/)

  const setKey = (key: string, value: string): void => {
    const re = new RegExp(`^\\s*${key}\\s*=`)
    const hit = lines.findIndex((l) => re.test(l) && !l.trimStart().startsWith('#'))
    if (hit >= 0) {
      lines[hit] = `${key} = ${value}`
      return
    }
    const firstSection = lines.findIndex((l) => /^\s*\[/.test(l))
    const at = firstSection < 0 ? lines.length : firstSection
    lines.splice(at, 0, `${key} = ${value}`, '')
  }

  setKey('bind', tomlString(`0.0.0.0:${input.port}`))
  setKey('motd', tomlString(input.motd || 'A Minecraft Server'))
  setKey('online-mode', String(input.onlineMode))

  return lines.join(eol)
}

/**
 * BungeeCord / Waterfall 的 config.yml。
 *
 * 这是照官方默认配置写的：一个监听端口、一个占位的 lobby 后端、
 * 几条常用权限。`lobby` 只是个占位地址，装完要改成真正的后端 ——
 * 界面上的提示里会写清楚，拓扑扫描也能直接读到它。
 */
export function bungeeConfigYaml(input: ProxySetupInput): string {
  return `# ${input.kind === 'waterfall' ? 'Waterfall' : 'BungeeCord'} 配置（由 CraftDesk 生成）
# 后端服务器写在 servers: 下面，名字要和 listeners.priorities 里的一致。
# 改完之后重启代理端生效。

listeners:
- query_port: ${input.port}
  motd: ${yamlString(input.motd || 'A Minecraft Server')}
  tab_list: GLOBAL_PING
  query_enabled: false
  proxy_protocol: false
  ping_passthrough: false
  priorities:
  - lobby
  bind_local_address: true
  host: 0.0.0.0:${input.port}
  max_players: 1
  tab_size: 60
  force_default_server: false
online_mode: ${input.onlineMode}
servers:
  lobby:
    address: 127.0.0.1:25566
    motd: '默认入口，请在 CraftDesk 里改成真实的后端地址'
    restricted: false
permissions:
  default:
  - bungeecord.command.list
  - bungeecord.command.server
  admin:
  - bungeecord.command.alert
  - bungeecord.command.end
  - bungeecord.command.ip
  - bungeecord.command.reload
  - bungeecord.command.kick
ip_forward: false
network_compression_threshold: 256
connection_throttle: 4000
connection_throttle_limit: 3
log_commands: false
`
}

/**
 * 兜底用的最小 Velocity 配置。
 *
 * 正常路径是从官方 jar 里取 `default-velocity.toml`，取不到（jar 结构变了、
 * 或者被人换过核心）才用这份。config-version 取一个偏旧的版本：
 * Velocity 的迁移是单向的，旧版本号只会让它补全新键，不会拒绝启动。
 */
export function fallbackVelocityToml(input: ProxySetupInput): string {
  return `# Velocity 配置（CraftDesk 生成的兜底版本）
# 没取到核心里的官方模板，这里只写了必须的几项，其余项 Velocity 会自己补全。

config-version = "1.0.0"
bind = ${tomlString(`0.0.0.0:${input.port}`)}
motd = ${tomlString(input.motd || 'A Minecraft Server')}
show-max-players = 500
online-mode = ${input.onlineMode}
prevent-client-proxy-connections = false
player-info-forwarding-mode = "NONE"
announce-forge = false
kick-existing-players = false
ping-passthrough = "DISABLED"

[servers]
# 后端服务器写在这里，例如： lobby = "127.0.0.1:25566"
try = []
`
}

/** 把配置写到磁盘时用的内容（Velocity 会从 jar 里取官方模板，这里只做兜底） */
export function proxyConfigText(input: ProxySetupInput, officialTemplate?: string | null): string {
  if (input.kind === 'velocity') {
    return officialTemplate
      ? patchVelocityToml(officialTemplate, input)
      : fallbackVelocityToml(input)
  }
  return bungeeConfigYaml(input)
}
