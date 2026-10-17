import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { ServerConfig } from '../shared/types'
import type { BackendCheck, BackendIssue, VelocityServerEntry } from '../shared/types'
import { resolveLayout, type ServerLayout } from './layout'
import { findProxyMod, probeProxyReady, yamlValueUnder } from './forwarding'
import { parsePropertiesFile } from './properties'

interface ManagedServer {
  cfg: ServerConfig
  layout: ServerLayout
  port: number | null
  onlineMode: boolean | null
}

/** 把 CraftDesk 里托管的服务器读一遍，拿到各自的端口与正版验证设置 */
async function loadManaged(servers: ServerConfig[]): Promise<ManagedServer[]> {
  const out: ManagedServer[] = []
  for (const cfg of servers) {
    try {
      const layout = await resolveLayout(cfg)
      const props = await parsePropertiesFile(layout.serverProperties)
      const get = (k: string): string | undefined => props.find((p) => p.key === k)?.value
      const portRaw = get('server-port')
      out.push({
        cfg,
        layout,
        port: portRaw ? Number(portRaw) : null,
        onlineMode: get('online-mode') === undefined ? null : get('online-mode') === 'true'
      })
    } catch {
      /* 单个服务器读不出来不影响其它 */
    }
  }
  return out
}


/** 从 FabricProxy / FabricProxy-Lite 的配置里抠出需要的字段 */
async function readProxyModConfig(
  path: string | null
): Promise<{ secret: string | null; hackOnlineMode: boolean | null }> {
  if (!path) return { secret: null, hackOnlineMode: null }
  let text = ''
  try {
    text = await fs.readFile(path, 'utf-8')
  } catch {
    return { secret: null, hackOnlineMode: null }
  }

  // 两种格式的键名一样，FabricProxy-Lite 是平铺的，FabricProxy 分在 [velocity] / [common] 段下，
  // 直接全文找键名对两者都成立
  const secret = text.match(/^\s*secret\s*=\s*["']([^"']*)["']/m)?.[1] ?? null
  const hackRaw = text.match(/^\s*hackOnlineMode\s*=\s*(true|false)/m)?.[1]

  return { secret, hackOnlineMode: hackRaw ? hackRaw === 'true' : null }
}

export interface BackendCheckOptions {
  /** 代理端 forwarding secret */
  proxySecret: string | null
  /** player-info-forwarding-mode */
  forwardingMode: string
  /** 代理端是否开启正版验证 */
  proxyOnlineMode: boolean
  /** 代理端格式：Velocity 是 modern 转发，Bungee / Waterfall 是 legacy */
  proxyFormat: 'velocity' | 'bungee'
  /** [servers] 里的后端列表 */
  entries: VelocityServerEntry[]
  /** CraftDesk 里托管的所有服务器 */
  managed: ServerConfig[]
  /** 当前正在运行的服务器 id，用于在界面上标出后端是否已启动 */
  runningIds: Set<string>
}

/**
 * 逐个检查 [servers] 里的后端，回答两个问题：
 * 1. 这个后端 CraftDesk 认识吗（按端口对上号），有没有装 FabricProxy / FabricProxy-Lite
 * 2. 装了的话密钥对不对、转发模式对不对、正版验证设置自相矛盾没有
 */
export async function checkBackends(opts: BackendCheckOptions): Promise<BackendCheck[]> {
  const managed = await loadManaged(opts.managed)

  /*
   * 端口 → 候选服务器。同一个端口可能配了好几台（比如测试服和生存服都在 25565），
   * 这里不能简单「后来者覆盖」：那样核对的是谁全看遍历顺序。
   * 优先挑真的能接转发的那台——它就是这条 [servers] 真正的后端。
   */
  const byPort = new Map<number, ManagedServer[]>()
  for (const m of managed) {
    if (m.port == null) continue
    byPort.set(m.port, [...(byPort.get(m.port) ?? []), m])
  }

  const pickFor = async (port: number): Promise<ManagedServer | null> => {
    const list = byPort.get(port) ?? []
    if (!list.length) return null
    if (list.length === 1) return list[0]
    for (const m of list) {
      const judge = await probeProxyReady(m.layout, m.cfg.kind)
      if (judge.ready) return m
    }
    return list[0]
  }

  const results: BackendCheck[] = []

  for (const entry of opts.entries) {
    const issues: BackendIssue[] = []
    const match = entry.port ? await pickFor(entry.port) : null

    const check: BackendCheck = {
      name: entry.name,
      address: entry.address,
      host: entry.host,
      port: entry.port,
      managedId: match?.cfg.id ?? null,
      managedName: match?.cfg.name ?? null,
      managedRunning: match ? opts.runningIds.has(match.cfg.id) : false,
      proxyMod: null,
      proxyModFile: null,
      managedDir: match?.layout.root ?? null,
      proxyConfigPath: null,
      proxyConfigRel: null,
      backendSecret: null,
      secretOk: null,
      backendOnlineMode: match?.onlineMode ?? null,
      hackOnlineMode: null,
      issues
    }

    // 没对上号的不单独报，界面上会用汇总的形式提示，
    // 否则十个没导入的后端就会刷十条一模一样的说明
    if (!match) {
      results.push(check)
      continue
    }

    // ---- 1. 后端靠什么接转发 ----
    // 模组、Paper 原生、spigot.yml 里的 bungeecord 都算数：
    // 只认「有没有 FabricProxy」会把一堆本来配好的 Paper / Purpur 后端判成错误。
    const mod = await findProxyMod(match.layout)
    const ready = await probeProxyReady(match.layout, match.cfg.kind, opts.proxyFormat)

    if (ready.ready && ready.viaKind === 'mod') {
      if (mod) {
        check.proxyMod = mod.name
        check.proxyModFile = mod.file
        check.proxyConfigPath = mod.configPath
        check.proxyConfigRel = mod.configPath
          ? relative(match.layout.root, mod.configPath).split(sep).join('/')
          : null

        // ---- 2. 配置文件 ----
        if (!mod.configPath) {
          issues.push({
            level: 'warn',
            text: `装了 ${mod.name} 但找不到它的配置文件，多半是服务器还没启动过一次。`
          })
          results.push(check)
          continue
        }

        const cfg = await readProxyModConfig(mod.configPath)
        check.backendSecret = cfg.secret
        check.hackOnlineMode = cfg.hackOnlineMode

        // ---- 3. 密钥是否一致 ----
        // BungeeCord 的 legacy 转发没有密钥，别拿空值去比
        if (opts.proxyFormat !== 'bungee') {
          if (!cfg.secret) {
            issues.push({ level: 'warn', text: `${mod.name} 的配置里没有填 secret。` })
          } else if (!opts.proxySecret) {
            issues.push({
              level: 'warn',
              text: '代理端的 forwarding.secret 读不到，无法比对密钥。'
            })
          } else if (cfg.secret !== opts.proxySecret) {
            check.secretOk = false
            issues.push({
              level: 'error',
              text: `密钥不一致：后端是 "${cfg.secret}"，代理端是 "${opts.proxySecret}"。玩家会被拒绝登录。`
            })
          } else {
            check.secretOk = true
          }
        }

        // ---- 4. 转发模式（只有 Velocity 的 modern 模式要这个）----
        if (opts.proxyFormat !== 'bungee' && opts.forwardingMode !== 'modern') {
          issues.push({
            level: 'error',
            text:
              `玩家信息转发模式是 "${opts.forwardingMode}"，但 ${mod.name} 需要 modern 模式。` +
              '到「基础设置」里把 player-info-forwarding-mode 改成 modern。'
          })
        }
      }
    } else if (ready.ready && ready.viaKind === 'paper' && opts.proxyFormat !== 'bungee') {
      // Paper 原生 Velocity 转发：paper-global.yml 里也有一份 secret
      check.proxyMod = ready.via
      const path = join(match.layout.core, 'config', 'paper-global.yml')
      const text = await fs.readFile(path, 'utf-8').catch(() => '')
      const secret = text ? yamlValueUnder(text, ['proxies', 'velocity', 'secret']) : null
      check.proxyConfigPath = path
      check.proxyConfigRel = 'config/paper-global.yml'
      check.backendSecret = secret
      if (!secret) {
        issues.push({ level: 'warn', text: 'Paper 的 proxies.velocity.secret 是空的。' })
      } else if (!opts.proxySecret) {
        issues.push({ level: 'warn', text: '代理端的 forwarding.secret 读不到，无法比对密钥。' })
      } else if (secret !== opts.proxySecret) {
        check.secretOk = false
        issues.push({
          level: 'error',
          text: `密钥不一致：Paper 后端是 "${secret}"，代理端是 "${opts.proxySecret}"。玩家会被拒绝登录。`
        })
      } else {
        check.secretOk = true
      }
    } else if (ready.ready && ready.viaKind === 'bungee') {
      // spigot.yml 里开了 bungeecord：传统转发没有密钥可对
      check.proxyMod = ready.via
      check.proxyConfigRel = 'spigot.yml'
    } else if (opts.proxyFormat === 'bungee' && mod?.name === 'FabricProxy-Lite') {
      // 这是 Bungee 下最常见的坑：Lite 版只支持 Velocity，玩家会看到
      // FabricProxy-Lite.toml 里那句自定义 disconnectMessage，容易被当成网络问题。
      // 把这句话原样带出来，用户一对日志就知道踢人的是哪个模组。
      const text = mod.configPath ? await fs.readFile(mod.configPath, 'utf-8').catch(() => '') : ''
      const custom = text.match(/^\s*disconnectMessage\s*=\s*["']([^"']*)["']/m)?.[1] ?? ''
      issues.push({
        level: 'error',
        text:
          'FabricProxy-Lite 只支持 Velocity 的 modern 转发，BungeeCord / Waterfall 的玩家会被它踢掉' +
          (custom ? `，踢出文案就是它配置里的「${custom}」` : '') +
          '。建议直接用 Velocity 作为代理端；或者把后端换成 Paper / Purpur 并打开 spigot.yml 的 settings.bungeecord；' +
          '模组服也可以换用支持 BungeeCord 的 FabricProxy 分支（如 FabricProxy-Legacy）。'
      })
      results.push(check)
      continue
    } else {
      issues.push({
        level: 'error',
        text:
          opts.proxyFormat === 'bungee'
            ? '后端还没打开 BungeeCord 转发。Paper / Purpur 后端在 spigot.yml 里把 settings.bungeecord 改成 true；' +
              'Fabric 后端要装完整版 FabricProxy（FabricProxy-Lite 不支持 BungeeCord）。'
            : '后端还没打开 Velocity 转发。Paper / Purpur 后端在 config/paper-global.yml 里把 proxies.velocity.enabled 改成 true；' +
              'Fabric 后端要装 FabricProxy 或 FabricProxy-Lite。'
      })
      results.push(check)
      continue
    }

    // ---- 5. 正版验证自洽性 ----
    if (check.backendOnlineMode === true && check.hackOnlineMode === false) {
      issues.push({
        level: 'warn',
        text:
          '后端 server.properties 里 online-mode=true，而模组的 hackOnlineMode=false。' +
          '这种组合下代理端转发的玩家会因为验证失败被踢，' +
          '建议把后端改成 online-mode=false，或把 hackOnlineMode 打开。'
      })
    }
    if (check.backendOnlineMode === false && check.hackOnlineMode === true) {
      issues.push({
        level: 'warn',
        text:
          '后端 online-mode=false 但 hackOnlineMode=true，模组的在线模式伪装会覆盖服务端设置，' +
          '确认这是你想要的。'
      })
    }
    if (opts.proxyOnlineMode === true && check.backendOnlineMode === false) {
      issues.push({
        level: 'info',
        text: '代理端开了正版验证，后端关着——这是 Velocity modern 转发的常见搭配，正常。'
      })
    }

    results.push(check)
  }

  return results
}
