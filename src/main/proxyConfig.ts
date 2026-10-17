import type { ServerConfig, VelocityFile, VelocityUpdate } from '../shared/types'
import { readVelocityFile, writeVelocityFile, writeVelocityServers } from './velocity'
import { readBungeeFile, writeBungeeFields, writeBungeeServers, type BungeeUpdate } from './bungee'

/**
 * 代理端配置的统一入口。
 *
 * 三种代理端有两种格式：Velocity 用 TOML（velocity.toml），
 * BungeeCord 与 Waterfall 用 YAML（config.yml）。界面和「网络拓扑」都只关心
 * 「有哪些字段、有哪些后端」，不关心文件格式，所以在这里按类型分流一次。
 */

export function proxyConfigName(cfg: Pick<ServerConfig, 'kind'>): string {
  return cfg.kind === 'velocity' ? 'velocity.toml' : 'config.yml'
}

export async function readProxyFile(cfg: ServerConfig): Promise<VelocityFile> {
  return cfg.kind === 'velocity' ? readVelocityFile(cfg.dir) : readBungeeFile(cfg.dir)
}

/**
 * 写回字段。
 *
 * 界面传上来的 key 一律当作顶层键或监听器键；Velocity 的字段还带段名（section），
 * 所以这里按格式分开处理，而不是硬塞进同一个形状。
 */
export async function writeProxyFields(cfg: ServerConfig, updates: VelocityUpdate[]): Promise<void> {
  if (cfg.kind === 'velocity') {
    await writeVelocityFile(cfg.dir, updates)
    return
  }
  // YAML 里的值都按字符串写，类型只影响界面用哪种控件
  const bungeeUpdates: BungeeUpdate[] = updates
    .filter((u) => u.section === '' || u.section === 'listener')
    .map((u) => ({ section: u.section as '' | 'listener', key: u.key, value: u.value, type: u.type }))
  await writeBungeeFields(cfg.dir, bungeeUpdates)
}

export async function writeProxyServers(
  cfg: ServerConfig,
  servers: { name: string; address: string }[],
  tryList: string[]
): Promise<void> {
  if (cfg.kind === 'velocity') {
    await writeVelocityServers(cfg.dir, servers, tryList)
    return
  }
  await writeBungeeServers(cfg.dir, servers, tryList)
}
