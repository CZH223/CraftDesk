import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { FileEditor } from '../components/FileEditor'
import { Confirm, Field, Switch } from '../components/ui'
import { useStore } from '../store'
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

const SECTION_LABELS: Record<string, string> = {
  'packet-limiter': '数据包限流',
  'forced-hosts': '强制主机名',
  'advanced': '高级网络选项',
  query: 'Query 协议'
}

type Tab = 'basic' | 'backends' | 'advanced'

export function VelocityView({ server }: { server: ServerView }): JSX.Element {
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
    const res = await window.api.velocity.read(server.id)
    setLoading(false)
    if (!res.ok) {
      toast(res.error ?? '读取 velocity.toml 失败', 'error')
      return
    }
    setFile(res.data!)
    setDraft({})
  }, [server.id, toast])

  const check = useCallback(async (): Promise<void> => {
    setChecking(true)
    const res = await window.api.velocity.checkBackends(server.id)
    setChecking(false)
    if (res.ok) setChecks(res.data!)
    else toast(res.error ?? '后端检查失败', 'error')
  }, [server.id, toast])

  useEffect(() => {
    setLoading(true)
    void reload()
    void check()
  }, [reload, check])

  const fields = useMemo(() => file?.fields ?? [], [file])
  const topFields = useMemo(() => fields.filter((f) => f.section === ''), [fields])

  const valueOf = (key: string): string =>
    draft[key] ?? topFields.find((f) => f.key === key)?.value ?? ''

  const patch = (key: string, value: string): void =>
    setDraft((d) => ({ ...d, [key]: value }))

  const saveTop = async (): Promise<void> => {
    const updates: VelocityUpdate[] = Object.entries(draft)
      .map(([key, value]) => {
        const field = topFields.find((f) => f.key === key)
        return field ? { section: '', key, value, type: field.type } : null
      })
      .filter((u): u is VelocityUpdate => Boolean(u))

    if (!updates.length) return
    setSaving(true)
    const res = await window.api.velocity.write(server.id, updates)
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

  if (loading) return <div className="center-state">正在读取 velocity.toml…</div>

  if (!file?.exists) {
    return (
      <div className="center-state">
        <Icon name="alert" size={28} />
        <div>没有找到 velocity.toml</div>
        <div className="hint" style={{ maxWidth: 420 }}>
          这个文件在代理端第一次启动后生成。确认服务器目录选对了、并且至少启动过一次。
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
          <button className={tab === 'advanced' ? 'active' : ''} onClick={() => setTab('advanced')}>
            <Icon name="settings" size={13} />
            高级
          </button>
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
          topFields={topFields}
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

      {tab === 'advanced' && <AdvancedTab fields={fields} onSaved={() => void reload()} server={server} />}

      {rawOpen && (
        <FileEditor
          server={server}
          path="velocity.toml"
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
  topFields,
  secret,
  valueOf,
  patch,
  dirty
}: {
  topFields: TomlField[]
  secret: string | null
  valueOf: (k: string) => string
  patch: (k: string, v: string) => void
  dirty: boolean
}): JSX.Element {
  const toast = useStore((s) => s.toast)

  // 未知的顶层键也照常显示，免得以后 Velocity 加了新选项就被藏起来
  const known = topFields.filter((f) => TOP_FIELDS[f.key])
  const unknown = topFields.filter((f) => !TOP_FIELDS[f.key])

  const renderField = (f: TomlField): JSX.Element => {
    const meta = TOP_FIELDS[f.key] ?? { label: f.key }
    const value = valueOf(f.key)
    const kind = meta.kind ?? (f.type === 'boolean' ? 'bool' : f.type === 'number' ? 'number' : 'text')

    return (
      <Field key={f.key} label={meta.label} hint={f.key}>
        {kind === 'bool' ? (
          <Switch checked={value === 'true'} onChange={(v) => patch(f.key, String(v))} />
        ) : kind === 'enum' && meta.options ? (
          <select className="select" value={value} onChange={(e) => patch(f.key, e.target.value)}>
            {!meta.options.some((o) => o.value === value) && <option value={value}>{value}</option>}
            {meta.options.map((o) => (
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
            onChange={(e) => patch(f.key, e.target.value)}
          />
        )}
      </Field>
    )
  }

  return (
    <div className="dash" style={{ padding: 0 }}>
      <div className="form">
        <div className="form-section">
          <h3>监听与展示</h3>
          {known
            .filter((f) => ['bind', 'motd', 'show-max-players', 'config-version'].includes(f.key))
            .map(renderField)}
        </div>

        <div className="form-section">
          <h3>玩家验证与转发</h3>
          {known
            .filter((f) =>
              [
                'online-mode',
                'force-key-authentication',
                'prevent-client-proxy-connections',
                'player-info-forwarding-mode',
                'forwarding-secret-file',
                'enable-player-address-logging'
              ].includes(f.key)
            )
            .map(renderField)}

          <Field label="当前转发密钥" hint={secret ? '内容来自 forwarding.secret' : '读取不到'}>
            <input
              className="input"
              value={secret ?? '（未读取到）'}
              readOnly
              style={{ fontFamily: 'var(--mono)', color: secret ? 'var(--text)' : 'var(--text-faint)' }}
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

        <div className="form-section">
          <h3>其它</h3>
          {known
            .filter((f) =>
              [
                'announce-forge',
                'ping-passthrough',
                'kick-existing-players',
                'sample-players-in-ping',
                'enable-velocity-plugin-messaging',
                'bungeecord'
              ].includes(f.key)
            )
            .map(renderField)}
        </div>

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
  checks,
  summary,
  onSaved,
  onOpenBackend
}: {
  server: ServerView
  file: VelocityFile
  checks: BackendCheck[]
  summary: { error: number; warn: number; ok: number; unknown: number; total: number }
  onSaved: () => void
  onOpenBackend: (id: string) => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [rows, setRows] = useState(() => file.servers.map((s) => ({ ...s })))
  const [tryList, setTryList] = useState<string[]>(file.tryList)
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAddr, setNewAddr] = useState('127.0.0.1:25565')
  const [removing, setRemoving] = useState<string | null>(null)

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
    // 名称会写进 TOML 当键名，特殊字符会让 Velocity 解析出错
    for (const r of rows) {
      if (!r.name.trim()) {
        toast('服务器名称不能为空', 'error')
        return
      }
      if (/[[\]]/.test(r.name)) {
        toast(`名称 "${r.name}" 含有方括号，Velocity 会解析出错，请换一个`, 'error')
        return
      }
      if (!/:\d+$/.test(r.address.trim())) {
        toast(`"${r.name}" 的地址要写成 ip:端口 的形式`, 'error')
        return
      }
    }
    setSaving(true)
    const res = await window.api.velocity.writeServers(
      server.id,
      rows.map((r) => ({ name: r.name.trim(), address: r.address.trim() })),
      tryList.filter((t) => rows.some((r) => r.name === t))
    )
    setSaving(false)
    if (res.ok) {
      toast('已保存，重启代理端后生效', 'success')
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
        <b> ①</b> 它有没有写在下面这份 <code>[servers]</code> 列表里；
        <b> ②</b> 它有没有装 <code>FabricProxy</code> 或 <code>FabricProxy-Lite</code>，
        以及那个模组的 <code>secret</code> 是否和代理端的转发密钥一致、转发模式是否为 <code>modern</code>。
        只做第 ① 步的话，玩家进服会拿不到真实 IP，UUID 也会错乱。
      </div>

      {summary.unknown > 0 && (
        <div className="issue-bar" style={{ margin: '0 0 14px' }}>
          <Icon name="alert" size={16} />
          <span className="issue-text">
            有 {summary.unknown} 个后端没有导入 CraftDesk，无法检查它们有没有装转发模组。
            把这些服务端也添加进来就能自动核对。
          </span>
        </div>
      )}

      <div className="card-actions" style={{ marginBottom: 12 }}>
        <button className="btn sm" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} />
          添加后端
        </button>
        <button className="btn primary sm" disabled={!dirty || saving} onClick={() => void save()}>
          <Icon name="save" size={13} />
          {saving ? '保存中…' : '保存 [servers]'}
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
            [servers] 里还没有任何后端，点「添加后端」加一个。
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
              <Field label="名称" hint="写进 [servers] 的键名，不能用方括号">
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
              把 <b>{removing}</b> 从 [servers] 里删掉？
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

  const keyOf = (f: TomlField): string => `${f.section} ${f.key}`

  const save = async (): Promise<void> => {
    const updates: VelocityUpdate[] = Object.entries(draft)
      .map(([k, value]) => {
        const [section, key] = k.split(' ')
        const field = fields.find((f) => f.section === section && f.key === key)
        return field ? { section, key, value, type: field.type } : null
      })
      .filter((u): u is VelocityUpdate => Boolean(u))
    if (!updates.length) return

    setSaving(true)
    const res = await window.api.velocity.write(server.id, updates)
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
