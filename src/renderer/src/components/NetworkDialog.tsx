import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { Field, Modal, Spinner } from './ui'
import { useStore } from '../store'
import { isProxyKind, type NetworkJoinResult, type ServerView } from '../../../shared/types'

/**
 * 「加入跨服网络」。
 *
 * 不只是选一个代理端：主进程会顺便把后端的转发方式配好。
 * 不同的核心要改的地方不一样，所以这里把将要发生的动作先列出来，
 * 用户点确认之前就知道会动哪些文件。
 */
export function NetworkDialog({
  server,
  onClose
}: {
  server: ServerView
  onClose: () => void
}): JSX.Element {
  const servers = useStore((s) => s.servers)
  const refresh = useStore((s) => s.refresh)
  const toast = useStore((s) => s.toast)

  const proxies = useMemo(
    () => servers.filter((s) => isProxyKind(s.kind) && s.id !== server.id),
    [servers, server.id]
  )
  const current = proxies.find((p) => p.id === server.networkId) ?? null
  // Fabric 接 Velocity 更稳：默认优先选 Velocity，用户仍可以手动换成 Bungee
  const preferredFabricProxy =
    server.kind === 'fabric' ? proxies.find((p) => p.kind === 'velocity') : undefined
  const [target, setTarget] = useState(
    server.networkId || preferredFabricProxy?.id || proxies[0]?.id || ''
  )
  const [joined, setJoined] = useState(Boolean(server.networkId))
  const [statusAlias, setStatusAlias] = useState(server.networkAlias)
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [result, setResult] = useState<NetworkJoinResult | null>(null)

  // 旧配置里可能没记 networkId：按端口扫一遍代理端，仍然能认出「已加入」
  useEffect(() => {
    let alive = true
    void window.api.network.status(server.id).then((res) => {
      if (!alive || !res.ok || !res.data) return
      setJoined(true)
      setTarget(res.data.proxyId)
      setStatusAlias(res.data.alias)
    })
    return () => {
      alive = false
    }
  }, [server.id])

  const proxy = proxies.find((p) => p.id === target) ?? null
  const velocities = proxies.filter((p) => p.kind === 'velocity')

  const doJoin = async (): Promise<void> => {
    if (!target) {
      toast('请选择一个代理端', 'error')
      return
    }
    setBusy(true)
    setResult(null)
    const res = await window.api.network.join(server.id, target)
    setBusy(false)
    if (!res.ok) {
      toast(res.error ?? '加入网络失败', 'error')
      return
    }
    setResult(res.data!)
    setJoined(true)
    await refresh()
    await useStore.getState().loadTopology()
    toast(`已加入 ${res.data!.proxyName}，重启服务器后生效`, 'success')
  }

  const doLeave = async (): Promise<void> => {
    setLeaving(true)
    const res = await window.api.network.leave(server.id)
    setLeaving(false)
    if (!res.ok) {
      toast(res.error ?? '移出网络失败', 'error')
      return
    }
    setJoined(false)
    await refresh()
    await useStore.getState().loadTopology()
    if (res.data?.removed && res.data.remaining === 0) {
      toast('已移出。代理端现在没有任何后端，启动前请先加一台服务器', 'info')
    } else {
      toast(res.data?.removed ? '已从代理端配置里移除' : '代理端配置里没有找到这一条', 'info')
    }
    onClose()
  }

  const planSteps = planFor(server.kind, proxy?.kind)

  return (
    <Modal
      title="跨服网络"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <div className="spacer" />
          {joined && (
            <button className="btn danger" disabled={busy || leaving} onClick={() => void doLeave()}>
              {leaving ? '移出中…' : '移出当前网络'}
            </button>
          )}
          <button
            className="btn primary"
            disabled={busy || leaving || !target}
            onClick={() => void doJoin()}
          >
            <Icon name="network" size={14} />
            {busy ? '正在配置…' : joined ? '重新应用配置' : '加入并自动配置'}
          </button>
        </>
      }
    >
      {busy && (
        <div style={{ marginBottom: 12 }}>
          <Spinner text="正在修改代理端与后端配置，模组服可能需要下载桥接模组…" />
        </div>
      )}

      <div className="detect-card" style={{ marginBottom: 14 }}>
        <span className="detect-icon" style={{ background: 'var(--accent)' }}>
          <Icon name="network" size={18} />
        </span>
        <div className="detect-main">
          <div className="detect-name">{server.name}</div>
          <div className="detect-path">{server.dir}</div>
          <div className="detect-tags">
            {joined ? (
              <span className="tag green">
                已加入 {proxy?.name ?? current?.name ?? '（代理端已删除）'}
                {result?.alias
                  ? ` · ${result.alias}`
                  : statusAlias
                    ? ` · ${statusAlias}`
                    : ''}
              </span>
            ) : (
              <span className="tag">当前独立运行</span>
            )}
          </div>
        </div>
      </div>

      {proxies.length === 0 ? (
        <div className="issue-bar" style={{ margin: '0 0 12px' }}>
          <Icon name="alert" size={16} />
          <span className="issue-text">
            还没有代理端。先在「添加服务器 → 下载跨服网络」里装一个 Velocity / Waterfall /
            BungeeCord，或者导入已有的代理端，再回来把服务器接进去。
          </span>
        </div>
      ) : (
        <Field
          label="加入哪个网络"
          hint="代理端把玩家转发到后端；一台服务器只属于一个网络"
        >
          <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            {proxies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.kind === 'velocity' ? 'Velocity' : p.kind === 'waterfall' ? 'Waterfall' : 'BungeeCord'}
              </option>
            ))}
          </select>
        </Field>
      )}

      {proxy && server.kind === 'fabric' && proxy.kind !== 'velocity' && (
        <div className="issue-bar" style={{ margin: '0 0 12px' }}>
          <Icon name="alert" size={16} />
          <span className="issue-text">
            Fabric 后端接 BungeeCord / Waterfall 时，代理端可能注入 FML 握手，导致 Fabric API
            注册表同步失败（客户端提示需要安装 Fabric API）。推荐改用 Velocity，modern 转发更稳。
          </span>
          {velocities[0] && (
            <button className="btn sm" onClick={() => setTarget(velocities[0].id)}>
              改用 {velocities[0].name}
            </button>
          )}
        </div>
      )}

      {proxy && (
        <div className="form-section">
          <h3>接入时会做什么</h3>
          <div className="hint" style={{ lineHeight: 1.9, marginBottom: 8 }}>
            后端：{server.kind === 'fabric' ? 'Fabric' : server.kind === 'forge' ? 'Forge' : server.kind === 'neoforge' ? 'NeoForge' : server.kind} ·
            代理端：{proxy.kind === 'velocity' ? 'Velocity（modern 转发）' : 'BungeeCord / Waterfall（legacy 转发）'}
          </div>
          <ul className="net-plan">
            {planSteps.map((s, i) => (
              <li key={i}>
                <Icon name="check" size={12} />
                {s}
              </li>
            ))}
          </ul>
          <div className="hint" style={{ lineHeight: 1.8 }}>
            代理端与后端的 <code>online-mode</code> 会被改成 <code>false</code>，
            并打开对应的转发开关。改动需要重启服务器与代理端后生效。
          </div>
        </div>
      )}

      {result && (
        <div className="form-section">
          <h3>完成</h3>
          <div className="net-report">
            {result.changes.map((c, i) => (
              <div key={`c${i}`} className="net-report-line ok">
                <Icon name="check" size={13} />
                <span>{c}</span>
              </div>
            ))}
            {result.warnings.map((w, i) => (
              <div key={`w${i}`} className="net-report-line warn">
                <Icon name="alert" size={13} />
                <span>{w}</span>
              </div>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8, lineHeight: 1.8 }}>
            后端名：<code>{result.alias}</code> · 地址：<code>{result.address}</code>
            {result.backendPort > 0 && ` · 端口 ${result.backendPort}`}
            {result.mcVersion && ` · Minecraft ${result.mcVersion}`}
            <br />
            重启后如果玩家还是进不去，到代理端的「跨服配置 → 后端服务器」里点一次「重新检查」，
            CraftDesk 会逐项核对转发模组、密钥与在线模式。
          </div>
        </div>
      )}
    </Modal>
  )
}

/** 界面上先说明一遍会发生什么，避免用户点完才发现改了自己的配置 */
function planFor(serverKind: string, proxyKind?: string): string[] {
  const velocity = proxyKind === 'velocity'
  const list: string[] = []
  list.push(
    `把后端地址写进代理端配置，并加入默认入口${velocity ? '（[servers]）' : '（servers: 与 priorities）'}`
  )
  list.push('检查端口冲突：后端和代理端用同一个端口时，自动改用空闲端口')
  list.push('后端 server.properties：online-mode=false')
  if (serverKind === 'paper' || serverKind === 'purpur' || serverKind === 'spigot' || serverKind === 'bukkit') {
    list.push(
      velocity
        ? 'Paper 原生转发：paper-global.yml 的 proxies.velocity.enabled=true'
        : 'spigot.yml：settings.bungeecord=true'
    )
  } else if (serverKind === 'fabric') {
    list.push(
      velocity
        ? '下载 FabricProxy-Lite 并写入 config/FabricProxy-Lite.toml（modern 转发）'
        : '1.21.11 / 26.x 自动安装 ProxyForward（旧桥接会崩）；更早版本用 Fabric-Bungeecord-Proxy'
    )
    list.push('Fabric Loader 低于 0.19 时，在服务端停止状态下自动用官方安装器升级')
    if (!velocity) list.push('纯 Fabric 网络会自动关闭代理端的 forge_support')
  } else if (serverKind === 'forge' || serverKind === 'neoforge') {
    list.push('下载 ProxyCompatibleForge，并写入 config/proxy-compatible-forge.toml')
    if (!velocity) list.push('代理端 config.yml：forge_support=true')
  } else if (serverKind === 'vanilla') {
    list.push('原版服务端无法转发玩家信息，只能关闭 online-mode（会给出警告）')
  } else {
    list.push('还不会自动配置这个核心的转发，只会关闭 online-mode')
  }
  if (velocity) list.push('代理端 velocity.toml：online-mode=false、转发模式 modern；缺密钥时自动生成')
  else list.push('代理端 config.yml：online_mode=false、ip_forward=true')
  return list
}
