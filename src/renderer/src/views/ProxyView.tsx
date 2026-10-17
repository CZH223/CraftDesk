import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { FileEditor } from '../components/FileEditor'
import { Confirm, Field, Switch } from '../components/ui'
import { useStore } from '../store'
import { isProxyKind } from '../../../shared/types'
import type {
  BackendCheck,
  ServerView,
  TomlField,
  VelocityFile,
  VelocityUpdate
} from '../../../shared/types'

/** 顶层键的展示元数据：中文名、控件类型、说明 */
interface FieldMeta {
  label: string
  hint?: string
  kind?: 'text' | 'bool' | 'enum' | 'number'
  options?: { value: string; label: string }[]
}

const TOP_FIELDS: Record<string, FieldMeta> = {
  bind: { label: '监听地址与端口', hint: '形如 0.0.0.0:25566' },
  motd: { label: '服务器描述（MOTD）', hint: '支持 MiniMessage 格式' },
  'show-max-players': { label: '显示的最大人数', kind: 'number', hint: '仅用于列表显示' },
  'online-mode': { label: '正版验证', kind: 'bool' },
  'force-key-authentication': { label: '强制公钥验证', kind: 'bool' },
  'prevent-client-proxy-connections': { label: '阻止客户端代理连接', kind: 'bool' },
  'player-info-forwarding-mode': {
    label: '玩家信息转发模式',
    kind: 'enum',
    hint: '用 FabricProxy-Lite 必须选 modern',
    options: [
      { value: 'none', label: 'none · 不转发' },
      { value: 'legacy', label: 'legacy · 旧版（1.12 及以下）' },
      { value: 'bungeeguard', label: 'bungeeguard · BungeeGuard 插件' },
      { value: 'modern', label: 'modern · 原生转发（1.13+）' }
    ]
  },
  'forwarding-secret-file': { label: '转发密钥文件', hint: '默认 forwarding.secret' },
  'announce-forge': { label: '向客户端宣告 Forge', kind: 'bool' },
  'kick-existing-players': { label: '顶掉重复登录', kind: 'bool' },
  'ping-passthrough': {
    label: 'Ping 透传',
    kind: 'enum',
    options: [
      { value: 'disabled', label: 'disabled · 不透传' },
      { value: 'mods', label: 'mods · 只透传模组列表' },
      { value: 'description', label: 'description · 透传描述' },
      { value: 'all', label: 'all · 全部透传' }
    ]
  },
  'enable-player-address-logging': { label: '记录玩家 IP', kind: 'bool' },
  'sample-players-in-ping': { label: 'Ping 时显示在线玩家', kind: 'bool' },
  'enable-velocity-plugin-messaging': { label: '启用插件消息通道', kind: 'bool' },
  bungeecord: { label: '兼容 BungeeCord 插件消息', kind: 'bool' },
  'config-version': { label: '配置版本', hint: '不要改' }
}

/**
 * BungeeCord / Waterfall 的 config.yml 字段。
 *
 * 键名是下划线风格、而且监听器的键（host / motd / max_players）在
 * 解析后带着 section='listener'，这里只按 key 匹配就行。
 */
const BUNGEE_FIELDS: Record<string, FieldMeta> = {
  host: { label: '监听地址与端口', hint: '形如 0.0.0.0:25566' },
  motd: { label: '服务器描述（MOTD）' },
  max_players: { label: '显示的最大人数', kind: 'number', hint: '只影响列表显示' },
  tab_list: { label: 'Tab 列表模式' },
  online_mode: { label: '正版验证', kind: 'bool' },
  ip_forward: {
    label: '转发玩家信息（IP / UUID）',
    kind: 'bool',
    hint: '开启后后端要配 BungeeCord 系转发，否则玩家进不去'
  },
  proxy_protocol: { label: 'PROXY 协议', kind: 'bool' },
  ping_passthrough: { label: 'Ping 透传', kind: 'bool' },
  query_enabled: { label: '开启 Query', kind: 'bool' },
  query_port: { label: 'Query 端口', kind: 'number' },
  network_compression_threshold: { label: '网络压缩阈值', kind: 'number' },
  connection_throttle: { label: '连接限流（毫秒）', kind: 'number' },
  connection_throttle_limit: { label: '限流前的连接数', kind: 'number' },
  log_commands: { label: '记录指令', kind: 'bool' }
}

/** 基础设置里分几组显示；两种格式键名不同，分组也不同 */
const BASIC_GROUPS: Record<'velocity' | 'bungee', { title: string; keys: string[] }[]> = {
  velocity: [
    { title: '监听与展示', keys: ['bind', 'motd', 'show-max-players', 'config-version'] },
    {
      title: '玩家验证与转发',
      keys: [
        'online-mode',
        'force-key-authentication',
        'prevent-client-proxy-connections',
        'player-info-forwarding-mode',
        'forwarding-secret-file',
        'enable-player-address-logging'
      ]
    },
    {
      title: '其它',
      keys: [
        'announce-forge',
        'ping-passthrough',
        'kick-existing-players',
        'sample-players-in-ping',
        'enable-velocity-plugin-messaging',
        'bungeecord'
      ]
    }
  ],
  bungee: [
    { title: '监听与展示', keys: ['host', 'motd', 'max_players', 'tab_list'] },
    { title: '玩家验证与转发', keys: ['online_mode', 'ip_forward'] },
    {
      title: '网络与查询',
      keys: [
        'network_compression_threshold',
        'connection_throttle',
        'connection_throttle_limit',
        'proxy_protocol',
        'ping_passthrough',
        'query_enabled',
        'query_port'
      ]
    },
    { title: '其它', keys: ['log_commands'] }
  ]
}

const SECTION_LABELS: Record<string, string> = {
  'packet-limiter': '数据包限流',
  'forced-hosts': '强制主机名',
  'advanced': '高级网络选项',
  query: 'Query 协议'
}

type Tab = 'basic' | 'backends' | 'advanced'

export function ProxyView({ server }: { server: ServerView }): JSX.Element {
  // Velocity 用 TOML，BungeeCord / Waterfall 用 YAML —— 界面上只是文件名与字段名不同
  const fileHint = server.kind === 'velocity' ? 'velocity.toml' : 'config.yml'
  const toast = useStore((s) => s.toast)
  const select = useStore((s) => s.select)
  const setView = useStore((s) => s.setView)

  const [file, setFile] = useState<VelocityFile | null>(null)
  const [checks, setChecks] = useState<BackendCheck[]>([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [tab, setTab] = useState<Tab>('backends')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    const res = await window.api.proxy.read(server.id)
    setLoading(false)
    if (!res.ok) {
      toast(res.error ?? `读取 ${fileHint} 失败`, 'error')
      return
    }
    setFile(res.data!)
    setDraft({})
  }, [server.id, toast])

  const check = useCallback(async (): Promise<void> => {
    setChecking(true)
    const res = await window.api.proxy.checkBackends(server.id)
    setChecking(false)
    if (res.ok) setChecks(res.data!)
    else toast(res.error ?? '后端检查失败', 'error')
  }, [server.id, toast])

  useEffect(() => {
    setLoading(true)
    void reload()
    void check()
  }, [reload, check])

  const format: 'velocity' | 'bungee' = file?.format ?? (server.kind === 'velocity' ? 'velocity' : 'bungee')
  const configName = format === 'velocity' ? 'velocity.toml' : 'config.yml'

  const fields = useMemo(() => file?.fields ?? [], [file])

  // 草稿按「段 + 键」存：BungeeCord 的 host / motd 属于监听器那一段，
  // 光按 key 会和顶层键撞车
  const fieldId = (f: TomlField): string => `${f.section}|${f.key}`
  const valueOf = (f: TomlField): string => draft[fieldId(f)] ?? f.value
  const patch = (f: TomlField, value: string): void =>
    setDraft((d) => ({ ...d, [fieldId(f)]: value }))

  const saveTop = async (): Promise<void> => {
    const updates: VelocityUpdate[] = fields
      .filter((f) => draft[fieldId(f)] !== undefined)
      .map((f) => ({
        section: f.section,
        key: f.key,
        value: draft[fieldId(f)],
        type: f.type
      }))

    if (!updates.length) return
    setSaving(true)
    const res = await window.api.proxy.write(server.id, updates)
    setSaving(false)
    if (res.ok) {
      toast('已保存，重启代理端后生效', 'success')
      await reload()
    } else {
      toast(res.error ?? '保存失败', 'error')
    }
  }

  const dirty = Object.keys(draft).length > 0

  // ---- 后端汇总 ----
  const summary = useMemo(() => {
    let error = 0
    let warn = 0
    let ok = 0
    let unknown = 0
    for (const c of checks) {
      if (c.issues.some((i) => i.level === 'error')) error++
      else if (c.issues.some((i) => i.level === 'warn')) warn++
      else if (c.managedId) ok++
      else unknown++
    }
    return { error, warn, ok, unknown, total: checks.length }
  }, [checks])

  if (loading) return <div className="center-state">正在读取 {configName}…</div>

  if (!file?.exists) {
    return (
      <div className="center-state">
        <Icon name="alert" size={28} />
        <div>没有找到 {configName}</div>
        <div className="hint" style={{ maxWidth: 440 }}>
          {format === 'velocity'
            ? 'velocity.toml 在 Velocity 第一次启动后生成。'
            : 'config.yml 在 BungeeCord / Waterfall 第一次启动后生成。'}
          确认服务器目录选对了、并且至少启动过一次。
        </div>
      </div>
    )
  }

  return (
    <div className="content">
      <div className="console-toolbar">
        <div className="seg" style={{ margin: 0, width: 330 }}>
          <button className={tab === 'backends' ? 'active' : ''} onClick={() => setTab('backends')}>
            <Icon name="server" size={13} />
            后端服务器
            {summary.error > 0 && <span className="seg-badge bad">{summary.error}</span>}
          </button>
          <button className={tab === 'basic' ? 'active' : ''} onClick={() => setTab('basic')}>
            <Icon name="sliders" size={13} />
            基础设置
          </button>
          {format === 'velocity' && (
            <button className={tab === 'advanced' ? 'active' : ''} onClick={() => setTab('advanced')}>
              <Icon name="settings" size={13} />
              高级
            </button>
          )}
        </div>

        <div className="toolbar-spacer" />

        <button className="icon-btn" title="用文本编辑器打开原始文件" onClick={() => setRawOpen(true)}>
          <Icon name="edit" size={15} />
        </button>
        <button className="icon-btn" title="重新读取" onClick={() => void reload()}>
          <Icon name="refresh" size={15} />
        </button>
        {tab === 'basic' && (
          <button className="btn primary sm" disabled={!dirty || saving} onClick={() => void saveTop()}>
            <Icon name="save" size={13} />
            {saving ? '保存中…' : '保存'}
          </button>
        )}
        {tab === 'backends' && (
          <button className="btn sm" disabled={checking} onClick={() => void check()}>
            <Icon name="activity" size={13} />
            {checking ? '检查中…' : '重新检查'}
          </button>
        )}
      </div>

      {tab === 'basic' && (
        <BasicTab
          fields={fields}
          format={format}
          secret={file.secret}
          valueOf={valueOf}
          patch={patch}
          dirty={dirty}
        />
      )}

      {tab === 'backends' && (
        <BackendsTab
          server={server}
          file={file}
          format={format}
          checks={checks}
          summary={summary}
          onSaved={() => {
            void reload()
            void check()
          }}
          onOpenBackend={(id) => {
            select(id)
            setView('console')
          }}
        />
      )}

      {tab === 'advanced' && format === 'velocity' && (
        <AdvancedTab fields={fields} onSaved={() => void reload()} server={server} />
      )}

      {rawOpen && (
        <FileEditor
          server={server}
          path={configName}
          initial={file.raw}
          onClose={() => setRawOpen(false)}
          onSaved={() => {
            void reload()
            void check()
          }}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ 基础设置

function BasicTab({
  fields,
  format,
  secret,
  valueOf,
  patch,
  dirty
}: {
  fields: TomlField[]
  format: 'velocity' | 'bungee'
  secret: string | null
  valueOf: (f: TomlField) => string
  patch: (f: TomlField, v: string) => void
  dirty: boolean
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const meta = format === 'velocity' ? TOP_FIELDS : BUNGEE_FIELDS
  const groups = BASIC_GROUPS[format]
  const grouped = new Set(groups.flatMap((g) => g.keys))

  // 没被分组、也不是监听器字段的顶层键原样列出来，免得服务端加了新选项就被藏起来
  const unknown = fields.filter((f) => f.section === '' && !grouped.has(f.key) && !meta[f.key])

  const renderField = (f: TomlField): JSX.Element => {
    const m = meta[f.key] ?? { label: f.key }
    const value = valueOf(f)
    const kind = m.kind ?? (f.type === 'boolean' ? 'bool' : f.type === 'number' ? 'number' : 'text')

    return (
      <Field key={`${f.section}|${f.key}`} label={m.label} hint={m.hint ?? f.key}>
        {kind === 'bool' ? (
          <Switch checked={value === 'true'} onChange={(v) => patch(f, String(v))} />
        ) : kind === 'enum' && m.options ? (
          <select className="select" value={value} onChange={(e) => patch(f, e.target.value)}>
            {!m.options.some((o) => o.value === value) && <option value={value}>{value}</option>}
            {m.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            type={kind === 'number' ? 'number' : 'text'}
            value={value}
            spellCheck={false}
            onChange={(e) => patch(f, e.target.value)}
          />
        )}
      </Field>
    )
  }

  const pick = (keys: string[]): TomlField[] =>
    keys
      .map((k) => fields.find((f) => f.key === k))
      .filter((f): f is TomlField => Boolean(f))

  return (
    <div className="dash" style={{ padding: 0 }}>
      <div className="form">
        {groups.map((g) => {
          const list = pick(g.keys)
          if (!list.length) return null
          return (
            <div className="form-section" key={g.title}>
              <h3>{g.title}</h3>
              {list.map(renderField)}
            </div>
          )
        })}

        {format === 'velocity' && (
          <div className="form-section">
            <h3>转发密钥</h3>
            <Field label="当前转发密钥" hint={secret ? '内容来自 forwarding.secret' : '读取不到'}>
              <input
                className="input"
                value={secret ?? '（未读取到）'}
                readOnly
                style={{
                  fontFamily: 'var(--mono)',
                  color: secret ? 'var(--text)' : 'var(--text-faint)'
                }}
              />
              {secret && (
                <button
                  className="btn sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(secret)
                    toast('密钥已复制', 'success')
                  }}
                >
                  复制
                </button>
              )}
            </Field>
            <div className="hint" style={{ paddingLeft: 224 }}>
              这个密钥必须和后端 FabricProxy-Lite 配置里的 secret 完全一致，否则玩家会被拒绝登录。
            </div>
          </div>
        )}

        {format === 'bungee' && (
          <div className="form-section">
            <h3>关于 BungeeCord 的转发</h3>
            <div className="hint" style={{ lineHeight: 1.9 }}>
              BungeeCord 没有独立的转发密钥：打开 <code>ip_forward</code> 之后，它会在握手时
              把玩家的 IP 与 UUID 一并带给后端。后端要装 BungeeCord 系的转发支持
              （Fabric 服可以用 FabricProxy-Lite 的 BungeeCord 模式），否则玩家会以离线身份进入。
            </div>
          </div>
        )}

        {unknown.length > 0 && (
          <div className="form-section">
            <h3>其它选项</h3>
            {unknown.map(renderField)}
          </div>
        )}

        {dirty && (
          <div className="hint" style={{ paddingBottom: 20 }}>
            有未保存的修改。改完需要重启代理端才生效。
          </div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 后端服务器

function BackendsTab({
  server,
  file,
  format,
  checks,
  summary,
  onSaved,
  onOpenBackend
}: {
  server: ServerView
  file: VelocityFile
  format: 'velocity' | 'bungee'
  checks: BackendCheck[]
  summary: { error: number; warn: number; ok: number; unknown: number; total: number }
  onSaved: () => void
  onOpenBackend: (id: string) => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const servers = useStore((s) => s.servers)
  const [ports, setPorts] = useState<Record<string, number | null>>({})
  const [rows, setRows] = useState(() => file.servers.map((s) => ({ ...s })))
  const [tryList, setTryList] = useState<string[]>(file.tryList)
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAddr, setNewAddr] = useState('127.0.0.1:25565')
  const [removing, setRemoving] = useState<string | null>(null)

  /** 打开添加弹窗时顺手读一遍各服务器的端口：只读配置，几毫秒 */
  const openAdd = (): void => {
    setAdding(true)
    void window.api.servers.ports().then((res) => {
      if (res.ok) setPorts(res.data!)
    })
  }

  const portOf = (address: string): number => {
    const n = Number(address.split(':').pop())
    return Number.isFinite(n) ? n : 0
  }

  /**
   * 可以直接接进来的服务器：不是代理端、端口已知、还没在这份列表里。
   * 平时要接一台服得自己去 server.properties 里翻端口，这里点一下就好。
   */
  const candidates = servers
    .filter((s) => s.id !== server.id && !isProxyKind(s.kind))
    .map((s) => ({ ...s, port: ports[s.id] ?? null }))
    .filter((s) => s.port != null)
    .filter((s) => !rows.some((r) => portOf(r.address) === s.port))

  /** 名称会写进配置当键名：转成 ASCII 短横线形式，重名时加序号 */
  const suggestName = (name: string, port: number): string => {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
    let candidate = base || `server-${port}`
    let i = 2
    while (rows.some((r) => r.name === candidate)) candidate = `${base || `server-${port}`}-${i++}`
    return candidate
  }

  const pickCandidate = (s: { name: string; port: number | null }): void => {
    if (s.port == null) return
    setNewName(suggestName(s.name, s.port))
    setNewAddr(`127.0.0.1:${s.port}`)
  }

  // 外部重新读取后同步一次本地编辑状态
  useEffect(() => {
    setRows(file.servers.map((s) => ({ ...s })))
    setTryList(file.tryList)
  }, [file])

  const checkByName = useMemo(() => {
    const m = new Map<string, BackendCheck>()
    for (const c of checks) m.set(c.name, c)
    return m
  }, [checks])

  const dirty = useMemo(() => {
    const a = JSON.stringify(rows.map((r) => [r.name, r.address]))
    const b = JSON.stringify(file.servers.map((r) => [r.name, r.address]))
    return a !== b || JSON.stringify(tryList) !== JSON.stringify(file.tryList)
  }, [rows, file, tryList])

  const save = async (): Promise<void> => {
    // 名称会写进配置当键名，方括号在 TOML / YAML 里都不合适
    for (const r of rows) {
      if (!r.name.trim()) {
        toast('服务器名称不能为空', 'error')
        return
      }
      if (/[[\]]/.test(r.name)) {
        toast(`名称 "${r.name}" 含有方括号，配置会解析出错，请换一个`, 'error')
        return
      }
      if (!/:\d+$/.test(r.address.trim())) {
        toast(`"${r.name}" 的地址要写成 ip:端口 的形式`, 'error')
        return
      }
    }
    setSaving(true)
    const res = await window.api.proxy.writeServers(
      server.id,
      rows.map((r) => ({ name: r.name.trim(), address: r.address.trim() })),
      tryList.filter((t) => rows.some((r) => r.name === t))
    )
    setSaving(false)
    if (res.ok) {
      toast('已保存，重启代理端后生效', 'success')
      void useStore.getState().loadTopology()
      onSaved()
    } else {
      toast(res.error ?? '保存失败', 'error')
    }
  }

  return (
    <div className="dash" style={{ padding: '14px 18px 24px' }}>
      <div className="stat-cards" style={{ marginBottom: 14 }}>
        <StatCard value={String(summary.total)} label="后端服务器" />
        <StatCard value={String(summary.ok)} label="转发配置正常" tone={summary.ok > 0 ? 'ok' : undefined} />
        <StatCard value={String(summary.error)} label="有错误" tone={summary.error > 0 ? 'bad' : undefined} />
        <StatCard value={String(summary.warn)} label="有警告" tone={summary.warn > 0 ? 'warn' : undefined} />
      </div>

      <div className="hint" style={{ marginBottom: 14, lineHeight: 1.9 }}>
        检查一个后端是否真的接上了代理端，要看两件事：
        <b> ①</b> 它有没有写在下面这份 <code>{format === 'velocity' ? '[servers]' : 'servers:'}</code> 列表里；
        <b> ②</b> 它有没有装 {format === 'velocity' ? 'FabricProxy / FabricProxy-Lite' : 'BungeeCord 系的转发支持'}；
        {format === 'velocity'
          ? '以及那个模组的 secret 是否和代理端的转发密钥一致、转发模式是否为 modern。'
          : '以及代理端的 ip_forward 是否打开。'}
        只做第 ① 步的话，玩家进服会拿不到真实 IP，UUID 也会错乱。
      </div>

      {summary.unknown > 0 && (
        <div className="issue-bar" style={{ margin: '0 0 14px' }}>
          <Icon name="alert" size={16} />
          <span className="issue-text">
            有 {summary.unknown} 个后端没有导入 CraftDesk，无法检查它们的转发配置。
            把这些服务端也添加进来就能自动核对。
          </span>
        </div>
      )}

      <div className="card-actions" style={{ marginBottom: 12 }}>
        <button className="btn sm" onClick={openAdd}>
          <Icon name="plus" size={14} />
          添加后端
        </button>
        <button className="btn primary sm" disabled={!dirty || saving} onClick={() => void save()}>
          <Icon name="save" size={13} />
          {saving ? '保存中…' : `保存 ${format === 'velocity' ? '[servers]' : 'servers:'}`}
        </button>
        {dirty && <span className="hint" style={{ alignSelf: 'center' }}>有未保存的修改</span>}
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((row, idx) => {
          const c = checkByName.get(row.name)
          const level = c?.issues.some((i) => i.level === 'error')
            ? 'error'
            : c?.issues.some((i) => i.level === 'warn')
              ? 'warn'
              : c?.managedId
                ? 'ok'
                : 'unknown'

          return (
            <div className={`backend-card ${level}`} key={`${row.name}-${idx}`}>
              <div className="backend-head">
                <span className={`dot ${level === 'ok' ? 'running' : level === 'error' ? 'crashed' : 'stopped'}`} />
                <input
                  className="input backend-name"
                  value={row.name}
                  spellCheck={false}
                  onChange={(e) =>
                    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r)))
                  }
                />
                <input
                  className="input backend-addr"
                  value={row.address}
                  spellCheck={false}
                  onChange={(e) =>
                    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, address: e.target.value } : r)))
                  }
                />
                {tryList.includes(row.name) ? (
                  <span className="tag green" title="玩家登录时优先尝试这个后端">
                    try #{tryList.indexOf(row.name) + 1}
                  </span>
                ) : (
                  <button
                    className="btn sm ghost"
                    title="加入 try 列表"
                    onClick={() => setTryList((t) => [...t, row.name])}
                  >
                    加入 try
                  </button>
                )}
                <button
                  className="icon-btn"
                  style={{ width: 26, height: 26 }}
                  title="移除"
                  onClick={() => setRemoving(row.name)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>

              <div className="backend-body">
                {c?.managedName ? (
                  <span className="tag blue" title="按端口在 CraftDesk 里匹配到的服务器">
                    <Icon name="server" size={11} />
                    {c.managedName}
                    {c.managedRunning ? ' · 运行中' : ' · 已停止'}
                  </span>
                ) : (
                  <span className="tag">CraftDesk 未托管此端口</span>
                )}

                {c?.proxyMod ? (
                  <span className={`tag ${c.secretOk === false ? 'red' : 'green'}`}>
                    <Icon name="shield" size={11} />
                    {c.proxyMod}
                    {c.secretOk === true ? ' · 密钥一致' : c.secretOk === false ? ' · 密钥不符' : ''}
                  </span>
                ) : c?.managedId ? (
                  <span className="tag red">
                    <Icon name="alert" size={11} />
                    没有装转发模组
                  </span>
                ) : null}

                {c?.backendOnlineMode != null && (
                  <span className="tag">
                    后端 online-mode = {String(c.backendOnlineMode)}
                  </span>
                )}
                {c?.hackOnlineMode != null && (
                  <span className="tag">hackOnlineMode = {String(c.hackOnlineMode)}</span>
                )}

                {c?.managedId && (
                  <button
                    className="btn sm ghost"
                    onClick={() => onOpenBackend(c.managedId!)}
                    title="切换到该服务器的控制台"
                  >
                    <Icon name="terminal" size={13} />
                    打开
                  </button>
                )}
                {c?.managedDir && c.proxyConfigRel && (
                  <button
                    className="btn sm ghost"
                    title={c.proxyConfigPath ?? ''}
                    onClick={() =>
                      void window.api.fs.reveal(c.managedDir!, c.proxyConfigRel!)
                    }
                  >
                    <Icon name="external" size={13} />
                  </button>
                )}
              </div>

              {c?.issues.map((issue, i) => (
                <div key={i} className={`backend-issue ${issue.level}`}>
                  <Icon name={issue.level === 'error' ? 'alert' : 'activity'} size={13} />
                  <span>{issue.text}</span>
                </div>
              ))}
            </div>
          )
        })}

        {rows.length === 0 && (
          <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
            {format === 'velocity' ? '[servers]' : 'servers:'} 里还没有任何后端，点「添加后端」加一个。
          </div>
        )}
      </div>

      {tryList.length > 0 && (
        <div className="form-section" style={{ marginTop: 22, maxWidth: 640 }}>
          <h3>尝试顺序（try）</h3>
          <div className="hint" style={{ marginBottom: 10 }}>
            玩家登录或从某个后端被踢出时，代理端按这个顺序找可用的后端。
          </div>
          {tryList.map((t, i) => (
            <div key={t} className="row" style={{ padding: '6px 10px' }}>
              <span className="tag">{i + 1}</span>
              <div className="row-main">
                <div className="row-title">{t}</div>
              </div>
              <div className="row-actions">
                <button
                  className="btn sm ghost icon-only"
                  disabled={i === 0}
                  title="上移"
                  onClick={() =>
                    setTryList((list) => {
                      const next = [...list]
                      ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                      return next
                    })
                  }
                >
                  <Icon name="chevron-up" size={13} />
                </button>
                <button
                  className="btn sm ghost icon-only"
                  disabled={i === tryList.length - 1}
                  title="下移"
                  onClick={() =>
                    setTryList((list) => {
                      const next = [...list]
                      ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
                      return next
                    })
                  }
                >
                  <Icon name="chevron-down" size={13} />
                </button>
                <button
                  className="btn sm ghost icon-only"
                  title="移出顺序"
                  onClick={() => setTryList((list) => list.filter((x) => x !== t))}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <Confirm
          title="添加后端服务器"
          confirmText="添加"
          message={
            <div style={{ display: 'grid', gap: 10 }}>
              {candidates.length > 0 && (
                <div>
                  <div className="hint" style={{ marginBottom: 6 }}>
                    从已导入的服务器里选一台，名称与地址会自动填好：
                  </div>
                  <div className="chips">
                    {candidates.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`chip-btn ${newAddr.endsWith(`:${c.port}`) ? 'active' : ''}`}
                        title={`${c.name} · 端口 ${c.port}`}
                        onClick={() => pickCandidate(c)}
                      >
                        {c.name} · :{c.port}
                        <span
                          className="chip-dot"
                          style={{
                            background:
                              c.runtime.status === 'running'
                                ? 'var(--ok, #22c55e)'
                                : c.runtime.status === 'stopped'
                                  ? 'var(--border-strong, #555)'
                                  : 'var(--warn, #eab308)'
                          }}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <Field label="名称" hint={`写进 ${format === 'velocity' ? '[servers]' : 'servers:'} 的键名`}>
                <input
                  className="input"
                  autoFocus
                  value={newName}
                  placeholder="survival"
                  onChange={(e) => setNewName(e.target.value)}
                />
              </Field>
              <Field label="地址" hint="ip:端口">
                <input
                  className="input"
                  value={newAddr}
                  onChange={(e) => setNewAddr(e.target.value)}
                />
              </Field>
            </div>
          }
          onCancel={() => setAdding(false)}
          onConfirm={() => {
            const name = newName.trim()
            if (!name) {
              toast('请填写名称', 'error')
              return
            }
            if (rows.some((r) => r.name === name)) {
              toast(`名称 "${name}" 已存在`, 'error')
              return
            }
            setRows((rs) => [...rs, { name, address: newAddr.trim(), host: '', port: 0 }])
            setAdding(false)
            setNewName('')
          }}
        />
      )}

      {removing && (
        <Confirm
          title="移除后端"
          danger
          confirmText="移除"
          message={
            <>
              把 <b>{removing}</b> 从 {format === 'velocity' ? '[servers]' : 'servers:'} 里删掉？
              <br />
              这不会动到那台服务器本身，只是代理端不再能转到它。
            </>
          }
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setRows((rs) => rs.filter((r) => r.name !== removing))
            setTryList((t) => t.filter((x) => x !== removing))
            setRemoving(null)
          }}
        />
      )}
    </div>
  )
}

function StatCard({
  value,
  label,
  tone
}: {
  value: string
  label: string
  tone?: 'ok' | 'warn' | 'bad'
}): JSX.Element {
  const color =
    tone === 'ok' ? 'var(--accent)' : tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--danger)' : undefined
  return (
    <div className="stat-card" style={{ padding: '10px 14px' }}>
      <div className="sv" style={{ fontSize: 19, color }}>
        {value}
      </div>
      <div className="sl">{label}</div>
    </div>
  )
}

// ------------------------------------------------------------------ 高级

function AdvancedTab({
  fields,
  server,
  onSaved
}: {
  fields: TomlField[]
  server: ServerView
  onSaved: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const sections = useMemo(() => {
    const map = new Map<string, TomlField[]>()
    for (const f of fields) {
      if (!f.section) continue
      const list = map.get(f.section) ?? []
      list.push(f)
      map.set(f.section, list)
    }
    return [...map.entries()]
  }, [fields])

  const keyOf = (f: TomlField): string => `${f.section}\0${f.key}`

  const save = async (): Promise<void> => {
    const updates: VelocityUpdate[] = Object.entries(draft)
      .map(([k, value]) => {
        const [section, key] = k.split('\0')
        const field = fields.find((f) => f.section === section && f.key === key)
        return field ? { section, key, value, type: field.type } : null
      })
      .filter((u): u is VelocityUpdate => Boolean(u))
    if (!updates.length) return

    setSaving(true)
    const res = await window.api.proxy.write(server.id, updates)
    setSaving(false)
    if (res.ok) {
      toast('已保存，重启代理端后生效', 'success')
      setDraft({})
      onSaved()
    } else {
      toast(res.error ?? '保存失败', 'error')
    }
  }

  return (
    <div className="dash" style={{ padding: 0 }}>
      <div className="form">
        {sections.map(([section, list]) => (
          <div className="form-section" key={section}>
            <h3>{SECTION_LABELS[section] ?? section}</h3>
            {list.map((f) => {
              const key = keyOf(f)
              const value = draft[key] ?? f.value
              const isBool = f.type === 'boolean'
              return (
                <Field
                  key={key}
                  label={f.key}
                  hint={f.comment ? f.comment.split('\n')[0].slice(0, 42) : undefined}
                >
                  {isBool ? (
                    <Switch
                      checked={value === 'true'}
                      onChange={(v) => setDraft((d) => ({ ...d, [key]: String(v) }))}
                    />
                  ) : (
                    <input
                      className="input"
                      value={value}
                      spellCheck={false}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  )}
                </Field>
              )
            })}
          </div>
        ))}

        <div style={{ display: 'flex', gap: 8, paddingBottom: 24 }}>
          <button
            className="btn primary"
            disabled={!Object.keys(draft).length || saving}
            onClick={() => void save()}
          >
            <Icon name="save" size={14} />
            {saving ? '保存中…' : '保存高级设置'}
          </button>
        </div>
      </div>
    </div>
  )
}
