import { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { Field, Modal, Switch } from './ui'
import { useStore } from '../store'
import { formatBytes, kindColor, kindLabel, serverInitials } from '../utils'
import { javaHintText, proxyJavaHintText, proxyJavaMajor, requiredJavaMajor } from '../../../shared/javaHint'
import { isProxyKind } from '../../../shared/types'
import type { DetectedServer, NetworkPlan, ServerKind } from '../../../shared/types'

type Mode = 'choose' | 'import' | 'network' | 'create' | 'create-proxy'

const KINDS: { kind: ServerKind; icon: IconName; desc: string }[] = [
  { kind: 'paper', icon: 'zap', desc: '插件服首选' },
  { kind: 'vanilla', icon: 'box', desc: '官方原版' },
  { kind: 'purpur', icon: 'activity', desc: '性能更好' },
  { kind: 'fabric', icon: 'puzzle', desc: '轻量模组服' },
  { kind: 'forge', icon: 'wrench', desc: '模组服老牌' },
  { kind: 'neoforge', icon: 'wrench', desc: 'Forge 分支' }
]

/** 这两家官方只给安装器：装的过程要联网拉运行库，比下个 jar 慢得多 */
const INSTALLER_KINDS: ServerKind[] = ['forge', 'neoforge']

/**
 * 代理端。
 *
 * 和上面的服务端分开列：代理端不加载世界，它只是「玩家进来的入口」，
 * 玩家连上它、它再把人转发到后端服务器。把它和 Paper / Fabric 混在一格里，
 * 用户会以为这是「另一种服务端」，装完发现没有世界、指令也不一样。
 */
const PROXY_KINDS: { kind: ServerKind; icon: IconName; desc: string }[] = [
  { kind: 'velocity', icon: 'zap', desc: '现代代理，性能好' },
  { kind: 'waterfall', icon: 'globe', desc: 'Paper 维护的 BungeeCord' },
  { kind: 'bungeecord', icon: 'network', desc: '老牌代理，插件最多' }
]

export function AddServerDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [mode, setMode] = useState<Mode>('choose')

  const titles: Record<Mode, string> = {
    choose: '添加服务器',
    import: '导入已有服务端',
    network: '导入跨服网络',
    create: '新建服务器',
    'create-proxy': '下载跨服网络'
  }

  return (
    <Modal title={titles[mode]} onClose={onClose} size="wide">
      {mode === 'choose' && (
        <div className="choice-grid">
          <button className="choice" onClick={() => setMode('import')}>
            <div className="ct">
              <Icon name="folder-input" size={18} style={{ color: 'var(--accent)' }} />
              导入已有服务端
            </div>
            <div className="cd">
              选择已经装好服务端的文件夹，CraftDesk 会自动识别核心类型、Minecraft
              版本、端口和世界存档。适合以前手动开过服的情况。
            </div>
          </button>
          <button className="choice" onClick={() => setMode('create')}>
            <div className="ct">
              <Icon name="download" size={18} style={{ color: '#60a5fa' }} />
              下载并新建服务器
            </div>
            <div className="cd">
              选择 Minecraft 版本和服务端类型，自动下载核心、生成 eula.txt 与
              server.properties，开箱即可启动。
            </div>
          </button>
          {/*
            跨服网络单独一条路：代理端不是「一台服务器」，它是一组服务器的入口。
            按普通服务端导入只能得到一台没有世界、没有 EULA 的代理端，
            它配置里那十几个后端还得一个个找、一个个导。
          */}
          <button className="choice" onClick={() => setMode('network')}>
            <div className="ct">
              <Icon name="network" size={18} style={{ color: '#06b6d4' }} />
              导入跨服网络
            </div>
            <div className="cd">
              Velocity / BungeeCord 这类代理端：选中它的目录，CraftDesk 会读出配置里
              的全部后端，在附近找到对应的目录，让你一次勾选要导入哪些。
            </div>
          </button>

          {/*
            下载代理端和「下载并新建服务器」分开：
            代理端不是服务端（没有世界、没有 EULA、端口写在它自己的配置里），
            混在同一个表单里，用户会以为自己在装一台普通服务端。
          */}
          <button className="choice" onClick={() => setMode('create-proxy')}>
            <div className="ct">
              <Icon name="globe" size={18} style={{ color: '#a78bfa' }} />
              下载跨服网络
            </div>
            <div className="cd">
              下载 Velocity / Waterfall / BungeeCord，并生成它自己的配置
              （velocity.toml、config.yml）。玩家连它，它再把人转发到后端服务器。
            </div>
          </button>
        </div>
      )}

      {mode === 'import' && <ImportForm onBack={() => setMode('choose')} onClose={onClose} />}
      {mode === 'network' && <NetworkForm onBack={() => setMode('choose')} onClose={onClose} />}
      {mode === 'create' && (
        <CreateForm group="server" onBack={() => setMode('choose')} onClose={onClose} />
      )}
      {mode === 'create-proxy' && (
        <CreateForm group="proxy" onBack={() => setMode('choose')} onClose={onClose} />
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------ 导入

function ImportForm({ onBack, onClose }: { onBack: () => void; onClose: () => void }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)
  const select = useStore((s) => s.select)
  const javaList = useStore((s) => s.javaList)

  const settings = useStore((s) => s.settings)

  const [detected, setDetected] = useState<DetectedServer | null>(null)
  const [scanning, setScanning] = useState(false)
  const [name, setName] = useState('')
  const [jar, setJar] = useState('')
  const [script, setScript] = useState('')
  const [mode, setMode] = useState<'script' | 'jar'>('jar')
  const [javaPath, setJavaPath] = useState('')
  const [memory, setMemory] = useState({ min: 1024, max: 4096 })
  const [saving, setSaving] = useState(false)

  const pick = async (): Promise<void> => {
    const res = await window.api.app.pickDirectory('选择包含服务端核心的文件夹')
    if (!res.ok || !res.data) return
    setScanning(true)
    const det = await window.api.servers.detect(res.data)
    setScanning(false)
    if (!det.ok) {
      toast(det.error ?? '扫描失败', 'error')
      return
    }
    const d = det.data!
    setDetected(d)
    setName(d.name)
    setJar(d.suggestedJar)
    setScript(d.suggestedScript)
    setMode(d.suggestedScript && (!d.suggestedJar || d.preferScript) ? 'script' : 'jar')
    setMemory({
      min: settings?.defaultMemoryMin ?? 1024,
      max: settings?.defaultMemoryMax ?? 4096
    })
    if (!d.suggestedJar && !d.suggestedScript) {
      toast('这个目录里没有找到服务端核心，请确认选对了文件夹', 'error')
    }
  }

  const submit = async (): Promise<void> => {
    if (!detected) return
    setSaving(true)
    const res = await window.api.servers.add(detected.dir, {
      name: name.trim() || detected.name,
      jar: mode === 'jar' ? jar : '',
      startScript: mode === 'script' ? script : '',
      kind: detected.kind,
      mcVersion: detected.mcVersion,
      javaPath,
      memoryMin: memory.min,
      memoryMax: memory.max
    })
    setSaving(false)
    if (res.ok) {
      toast(`${res.data!.name} 已加入列表`, 'success')
      await refresh()
      select(res.data!.id)
      onClose()
    } else {
      toast(res.error ?? '添加失败', 'error')
    }
  }

  if (!detected) {
    return (
      <>
        <div className="center-state" style={{ minHeight: 220 }}>
          <Icon name="folder-input" size={34} style={{ color: 'var(--text-faint)' }} />
          <div>选择一个已经装好服务端的文件夹</div>
          <div className="hint" style={{ maxWidth: 460 }}>
            比如以前用启动器开过的服务器目录，里面应该有 server.jar 或者 start.bat。
            CraftDesk 只读取目录内容，不会修改任何文件。
          </div>
          <button className="btn primary" onClick={() => void pick()}>
            <Icon name="folder-open" size={15} />
            选择文件夹
          </button>
        </div>
        <div className="modal-foot" style={{ padding: 0, borderTop: 'none', marginTop: 8 }}>
          <button className="btn" onClick={onBack}>
            <Icon name="chevron-left" size={14} />
            返回
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="detect-card">
        <span className="detect-icon" style={{ background: kindColor(detected.kind) }}>
          {serverInitials(name || detected.name)}
        </span>
        <div className="detect-main">
          <div className="detect-name">{name || detected.name}</div>
          <div className="detect-path">{detected.dir}</div>
          <div className="detect-tags">
            <span className="tag">{kindLabel(detected.kind)}</span>
            {detected.mcVersion && <span className="tag blue">Minecraft {detected.mcVersion}</span>}
            {detected.port && <span className="tag">端口 {detected.port}</span>}
            {detected.coreDir && (
              <span className="tag purple">核心在 {detected.coreDir}/ 子目录</span>
            )}
            {detected.isMcdr && <span className="tag purple">MCDReforged 托管</span>}
            {detected.hasWorld && <span className="tag green">已有世界存档</span>}
            {detected.eulaAccepted ? (
              <span className="tag green">已同意 EULA</span>
            ) : (
              <span className="tag orange">EULA 未同意</span>
            )}
            <span className="tag">{formatBytes(detected.sizeBytes)}</span>
          </div>
        </div>
        <button className="btn sm" onClick={() => void pick()}>
          换一个
        </button>
      </div>

      <Field label="显示名称">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="启动方式" hint="脚本或直接启动 jar">
        <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'script' | 'jar')}>
          <option value="jar" disabled={!detected.jars.length}>
            直接用 Java 启动 jar
          </option>
          <option value="script" disabled={!detected.scripts.length}>
            运行启动脚本
          </option>
        </select>
      </Field>

      {mode === 'jar' ? (
        <Field label="服务端核心" hint="相对服务器目录的路径">
          <select className="select" value={jar} onChange={(e) => setJar(e.target.value)}>
            {detected.jars.map((j) => (
              <option key={j} value={j}>
                {j}
                {j === detected.suggestedJar ? '（推荐）' : ''}
              </option>
            ))}
            {!detected.jars.length && <option value="">没有找到 jar 文件</option>}
          </select>
        </Field>
      ) : (
        <Field label="启动脚本" hint="会把脚本交给 cmd 执行">
          <select className="select" value={script} onChange={(e) => setScript(e.target.value)}>
            {detected.scripts.map((s) => (
              <option key={s} value={s}>
                {s}
                {s === detected.suggestedScript ? '（推荐）' : ''}
              </option>
            ))}
            {!detected.scripts.length && <option value="">没有找到脚本</option>}
          </select>
        </Field>
      )}

      {detected.preferScript && mode === 'script' && (
        <div className="hint" style={{ marginBottom: 8 }}>
          检测到这是一个套在外层的启动器（例如 MCDReforged）。用脚本启动会保留它的插件与指令功能；
          直接启动 {detected.coreDir}/ 里的 jar 则会绕过它。
          {detected.isMcdr && (
            <>
              <br />
              注意：MCDR 模式下内存由它自己的 config.yml 决定，这里的设置不会生效。
            </>
          )}
        </div>
      )}

      <Field label="Java 运行环境">
        <select className="select" value={javaPath} onChange={(e) => setJavaPath(e.target.value)}>
          <option value="">使用全局默认（{settings?.javaPath || '未设置'}）</option>
          {javaList.map((j) => (
            <option key={j.path} value={j.path}>
              Java {j.major} · {j.path}
            </option>
          ))}
        </select>
      </Field>

      {detected.mcVersion && (
        <div className="hint" style={{ marginBottom: 8 }}>
          {javaHintText(detected.mcVersion)}
        </div>
      )}

      <Field label="最小内存 / 最大内存" hint="单位 MB">
        <input
          className="input"
          type="number"
          step={256}
          value={memory.min}
          onChange={(e) => setMemory((m) => ({ ...m, min: Number(e.target.value) }))}
        />
        <input
          className="input"
          type="number"
          step={256}
          value={memory.max}
          onChange={(e) => setMemory((m) => ({ ...m, max: Number(e.target.value) }))}
        />
      </Field>

      <div className="modal-foot" style={{ padding: 0, borderTop: 'none', marginTop: 16 }}>
        <button className="btn" onClick={onBack}>
          <Icon name="chevron-left" size={14} />
          返回
        </button>
        <button className="btn" onClick={() => setDetected(null)}>
          重新选择
        </button>
        <div className="spacer" />
        <button className="btn primary" disabled={saving} onClick={() => void submit()}>
          <Icon name="check" size={15} />
          {saving ? '添加中…' : '确认添加'}
        </button>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ 跨服网络

/**
 * 导入一整个跨服网络。
 *
 * 代理端（Velocity / BungeeCord）配置里的每个后端都是一台独立的服务端，
 * 导进来之后 CraftDesk 的拓扑视图会把它们连成一张网。这里让用户先看清楚
 * 「有哪些后端、在哪儿、能不能导」，再决定导哪些 —— 一次性把整台机器的
 * 服务器目录都塞进列表，反而更难收拾。
 */
function NetworkForm({ onBack, onClose }: { onBack: () => void; onClose: () => void }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)
  const select = useStore((s) => s.select)
  const settings = useStore((s) => s.settings)

  const [plan, setPlan] = useState<NetworkPlan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [name, setName] = useState('')
  const [memory, setMemory] = useState({ min: 1024, max: 4096 })
  /** 勾选的后端（按 alias） */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [includeProxy, setIncludeProxy] = useState(true)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState({ done: 0, total: 0 })

  useEffect(() => {
    setMemory({
      min: settings?.defaultMemoryMin ?? 1024,
      max: settings?.defaultMemoryMax ?? 4096
    })
  }, [settings])

  const pick = async (): Promise<void> => {
    const res = await window.api.app.pickDirectory('选择代理端目录（含 velocity.toml 或 config.yml）')
    if (!res.ok || !res.data) return

    setScanning(true)
    const scan = await window.api.servers.scanNetwork(res.data)
    setScanning(false)
    if (!scan.ok) {
      toast(scan.error ?? '扫描失败', 'error')
      return
    }
    const p = scan.data!
    setPlan(p)
    setName(p.proxy.name)
    // 默认可导入的全勾上：一次导一组是这条路的常态
    setPicked(new Set(p.backends.filter((b) => b.status === 'found').map((b) => b.alias)))
  }

  const importable = plan?.backends.filter((b) => b.status === 'found') ?? []
  const allPicked = importable.length > 0 && importable.every((b) => picked.has(b.alias))

  const toggleAll = (): void => {
    setPicked(allPicked ? new Set() : new Set(importable.map((b) => b.alias)))
  }

  const importNow = async (): Promise<void> => {
    if (!plan) return
    const targets = [
      ...(includeProxy ? [{ dir: plan.proxy.dir, name: plan.proxy.name }] : []),
      ...plan.backends
        .filter((b) => b.status === 'found' && b.dir && picked.has(b.alias))
        .map((b) => ({ dir: b.dir!, name: b.detected?.name || b.alias }))
    ]
    if (!targets.length) {
      toast('没有勾选任何要导入的东西', 'info')
      return
    }

    setProgress({ done: 0, total: targets.length })
    const added: string[] = []
    const failed: string[] = []

    for (const [i, t] of targets.entries()) {
      setBusy(`正在导入 ${t.name}（${i + 1}/${targets.length}）`)
      const res = await window.api.servers.add(t.dir, {
        memoryMin: memory.min,
        memoryMax: memory.max
      })
      if (res.ok) added.push(res.data!.name)
      else failed.push(`${t.name}：${res.error ?? '失败'}`)
      setProgress({ done: i + 1, total: targets.length })
    }

    setBusy('')
    await refresh()
    if (added.length) {
      // 导完直接选中网络入口（代理端），拓扑视图就在旁边
      const list = await window.api.servers.list()
      const proxy = list.ok ? list.data!.find((s) => s.dir === plan.proxy.dir) : undefined
      if (proxy) select(proxy.id)
      toast(`已导入 ${added.length} 个：${added.join('、')}`, 'success')
    }
    if (failed.length) toast(`有 ${failed.length} 个没导成 —— ${failed[0]}`, 'error')
    if (added.length && !failed.length) onClose()
  }

  if (!plan) {
    return (
      <>
        <div className="center-state" style={{ minHeight: 240 }}>
          <Icon name="network" size={34} style={{ color: 'var(--text-faint)' }} />
          <div>选择代理端所在的文件夹</div>
          <div className="hint" style={{ maxWidth: 520, textAlign: 'center' }}>
            里面应该有 <code>velocity.toml</code>（Velocity）或 <code>config.yml</code>
            （BungeeCord / Waterfall）以及代理端的 jar。
            <br />
            CraftDesk 会读出配置里列的后端，并在它旁边的目录里找出对应的服务端 ——
            只读，不动任何文件。
          </div>
          <button className="btn primary" disabled={scanning} onClick={() => void pick()}>
            <Icon name="folder-open" size={15} />
            {scanning ? '正在扫描…' : '选择代理端目录'}
          </button>
        </div>
        <div className="modal-foot" style={{ padding: 0, borderTop: 'none', marginTop: 8 }}>
          <button className="btn" onClick={onBack}>
            <Icon name="chevron-left" size={14} />
            返回
          </button>
        </div>
      </>
    )
  }

  const foundCount = importable.length
  const managedCount = plan.backends.filter((b) => b.status === 'managed').length

  return (
    <>
      <div className="detect-card">
        <span className="detect-icon" style={{ background: kindColor(plan.proxy.kind) }}>
          {serverInitials(name || plan.proxy.name)}
        </span>
        <div className="detect-main">
          <div className="detect-name">{plan.proxy.name}</div>
          <div className="detect-path">{plan.proxy.dir}</div>
          <div className="detect-tags">
            <span className="tag cyan">{kindLabel(plan.proxy.kind)}</span>
            {plan.proxy.mcVersion && <span className="tag">{plan.proxy.mcVersion}</span>}
            {plan.proxyPort && <span className="tag">监听 {plan.proxyPort}</span>}
            <span className="tag purple">配置里有 {plan.backends.length} 个后端</span>
          </div>
        </div>
        <button className="btn sm" onClick={() => void pick()}>
          换一个
        </button>
      </div>

      <div className="form-section">
        <h3>
          后端服务器
          <span className="hint" style={{ marginLeft: 8, fontWeight: 400 }}>
            可导入 {foundCount} · 已在列表 {managedCount} · 只有地址{' '}
            {plan.backends.length - foundCount - managedCount}
          </span>
        </h3>

        <div className="hint" style={{ marginBottom: 8 }}>
          在 <code>{plan.searchRoot}</code> 附近扫了 {plan.scanned} 个目录。
          打钩的会被加进 CraftDesk（代理端与后端的转发关系由拓扑视图自动连线）。
        </div>

        {plan.backends.length === 0 && (
          <div className="issue-bar" style={{ margin: '0 0 12px' }}>
            <Icon name="alert" size={15} />
            <span className="issue-text">
              这份配置里没有列出任何后端。先把后端加进 <code>velocity.toml</code> 的{' '}
              <code>[servers]</code> 或 <code>config.yml</code> 的 <code>servers:</code>，
              再回来导。
            </span>
          </div>
        )}

        {plan.backends.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
            <button className="btn sm" disabled={!foundCount} onClick={toggleAll}>
              {allPicked ? '全不选' : `全选可导入的 ${foundCount} 个`}
            </button>
          </div>
        )}

        {plan.backends.map((b) => {
          const canPick = b.status === 'found'
          const checked = canPick && picked.has(b.alias)
          return (
            <div className={`row ${canPick ? '' : 'disabled'}`} key={b.alias}>
              <input
                type="checkbox"
                className="net-check"
                checked={checked}
                disabled={!canPick}
                onChange={() =>
                  setPicked((prev) => {
                    const next = new Set(prev)
                    if (next.has(b.alias)) next.delete(b.alias)
                    else next.add(b.alias)
                    return next
                  })
                }
              />
              <div className="row-main">
                <div className="row-title">
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{b.alias}</span>
                  {b.detected && <span className="tag">{kindLabel(b.detected.kind)}</span>}
                  {b.detected?.mcVersion && <span className="tag blue">{b.detected.mcVersion}</span>}
                  {b.status === 'managed' && <span className="tag green">已在列表</span>}
                  {b.status === 'found' && b.foundBy === 'name' && (
                    <span className="tag orange">按名字猜的</span>
                  )}
                  {b.status === 'not-a-server' && <span className="tag red">不是服务端</span>}
                  {b.status === 'address-only' && <span className="tag">只有地址</span>}
                </div>
                <div className="row-sub" title={b.dir ?? b.address}>
                  {b.address}
                  {b.dir && ` · ${b.displayDir}`}
                </div>
                <div className="row-sub" style={{ color: 'var(--text-faint)' }}>
                  {b.note}
                  {b.status === 'managed' && b.managedName ? `：${b.managedName}` : ''}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="form-section">
        <h3>导入选项</h3>
        <Field label="把代理端也加进来" hint="关掉就只导勾选的后端">
          <Switch checked={includeProxy} onChange={setIncludeProxy} />
        </Field>
        <Field label="显示名称" hint="只影响代理端在列表里的名字">
          <input
            className="input"
            value={name}
            disabled={!includeProxy}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="后端内存" hint="后端是独立的服务端，各自跑在自己的内存里">
          <input
            className="input"
            type="number"
            step={256}
            value={memory.min}
            onChange={(e) => setMemory((m) => ({ ...m, min: Number(e.target.value) }))}
          />
          <input
            className="input"
            type="number"
            step={256}
            value={memory.max}
            onChange={(e) => setMemory((m) => ({ ...m, max: Number(e.target.value) }))}
          />
        </Field>
      </div>

      {busy && (
        <div style={{ marginBottom: 12 }}>
          <div className="progress">
            <div
              style={{
                width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`
              }}
            />
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {busy}
          </div>
        </div>
      )}

      <div className="modal-foot" style={{ padding: 0, borderTop: 'none' }}>
        <button className="btn" onClick={onBack} disabled={Boolean(busy)}>
          <Icon name="chevron-left" size={14} />
          返回
        </button>
        <div className="spacer" />
        <button
          className="btn primary"
          disabled={Boolean(busy) || (!includeProxy && picked.size === 0)}
          onClick={() => void importNow()}
        >
          <Icon name="download" size={15} />
          导入选中的 {picked.size + (includeProxy ? 1 : 0)} 个
        </button>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ 新建

/**
 * 新建表单。
 *
 * `group` 决定这一步是「装一台服务端」还是「装一个代理端」：
 * 两种卡片列表、默认选中项、提示文案都不同，但版本选择、安装位置、
 * 内存、MCDR 这些流程是一样的，所以共用同一个表单。
 */
function CreateForm({
  group,
  onBack,
  onClose
}: {
  group: 'server' | 'proxy'
  onBack: () => void
  onClose: () => void
}): JSX.Element {
  const javaList = useStore((s) => s.javaList)

  /**
   * 这个版本要的 Java 大版本，以及手上有没有够用的。
   * 26.1 之后的服务端要 Java 25，很多人机器上最高只有 24（启动器自带的那份
   * 不在 PATH 里），不提前说的话，就是下完 60 MB 再看到一句「已崩溃」。
   */
  const javaCheck = (mcVersion: string): { need: number; best: number; path: string } => {
    // 代理端的版本号不是 MC 版本号（Velocity 3.4.0 / BungeeCord 构建号），
    // 按 MC 那套规则算会得出「需要 Java 25」这种离谱结论
    const need = isProxyKind(kind) ? proxyJavaMajor(kind, mcVersion) : requiredJavaMajor(mcVersion)
    const usable = javaList.filter((j) => j.valid && j.major >= need).sort((a, b) => a.major - b.major)
    return { need, best: usable[0]?.major ?? 0, path: usable[0]?.path ?? '' }
  }
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)
  const select = useStore((s) => s.select)
  const settings = useStore((s) => s.settings)
  const downloads = useStore((s) => s.downloads)
  const pythonList = useStore((s) => s.pythonList)
  const refreshPython = useStore((s) => s.refreshPython)

  const proxyGroup = group === 'proxy'
  const kindList = proxyGroup ? PROXY_KINDS : KINDS
  const [kind, setKind] = useState<ServerKind>(proxyGroup ? 'velocity' : 'paper')
  const [versions, setVersions] = useState<{ id: string; latestBuild?: string }[]>([])
  const [version, setVersion] = useState('')
  const [build, setBuild] = useState('')
  const [loadingVersions, setLoadingVersions] = useState(false)

  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [port, setPort] = useState(25565)
  const [motd, setMotd] = useState('A Minecraft Server')
  const [memory, setMemory] = useState({ min: 1024, max: 4096 })
  const [eula, setEula] = useState(true)
  const [installing, setInstalling] = useState(false)

  // MCDReforged：装核心是一回事，套不套这层包装层是另一回事
  const [wantMcdr, setWantMcdr] = useState(false)
  const [pythonPath, setPythonPath] = useState('')
  const [installingMcdr, setInstallingMcdr] = useState(false)

  const task = Object.values(downloads)[0]
  const needsInstaller = INSTALLER_KINDS.includes(kind)
  const isProxy = isProxyKind(kind)

  useEffect(() => {
    setMemory({
      min: settings?.defaultMemoryMin ?? 1024,
      max: settings?.defaultMemoryMax ?? 4096
    })
  }, [settings])

  // 选中的解释器：没选就走列表里第一个能用的
  const python = pythonList.find((p) => p.path === pythonPath) ?? pythonList[0] ?? null
  const mcdrOk = Boolean(python?.suitable && python?.mcdr)

  useEffect(() => {
    if (!pythonPath && pythonList.length) setPythonPath(pythonList[0].path)
  }, [pythonList, pythonPath])

  useEffect(() => {
    let cancelled = false
    setLoadingVersions(true)
    setVersions([])
    void window.api.versions.list(kind).then((res) => {
      if (cancelled) return
      setLoadingVersions(false)
      if (res.ok) {
        const list = res.data!
        setVersions(list)
        setVersion(list[0]?.id ?? '')
        setBuild(list[0]?.latestBuild ?? '')
      } else {
        toast(res.error ?? '获取版本列表失败', 'error')
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  /** 换 MC 版本时，构建号跟着版本表走（Forge 只给 recommended / latest） */
  const pickVersion = (id: string): void => {
    setVersion(id)
    setBuild(versions.find((v) => v.id === id)?.latestBuild ?? '')
  }

  const installMcdrNow = async (): Promise<void> => {
    if (!python) return
    setInstallingMcdr(true)
    const res = await window.api.python.installMcdr(python.path)
    setInstallingMcdr(false)
    if (res.ok) {
      await refreshPython()
      toast(`MCDReforged ${res.data?.mcdr ?? ''} 已就绪`, 'success')
    } else {
      toast(res.error ?? '安装失败', 'error')
    }
  }

  const pickDir = async (): Promise<void> => {
    const res = await window.api.app.pickDirectory('选择安装位置（会在其中创建服务器文件夹）')
    if (res.ok && res.data) setParentDir(res.data)
  }

  const canSubmit =
    name.trim() &&
    parentDir &&
    version &&
    (!needsInstaller || build.trim()) &&
    (!wantMcdr || mcdrOk) &&
    !installing

  const submit = async (): Promise<void> => {
    setInstalling(true)
    const res = await window.api.servers.create({
      name: name.trim(),
      dir: parentDir,
      kind,
      mcVersion: version,
      build: needsInstaller ? build.trim() : undefined,
      memoryMin: memory.min,
      memoryMax: memory.max,
      port,
      motd,
      acceptEula: isProxy ? true : eula,
      mcdr: wantMcdr,
      pythonPath: wantMcdr ? python?.path : undefined
    })
    setInstalling(false)
    if (res.ok) {
      toast(`${res.data!.name} 创建完成`, 'success')
      await refresh()
      select(res.data!.id)
      onClose()
    } else {
      toast(res.error ?? '创建失败', 'error')
    }
  }

  const installPath = parentDir && name ? `${parentDir}\\${name.trim()}` : ''

  return (
    <>
      <div className="form-section">
        <h3>{proxyGroup ? '代理端类型' : '服务端类型'}</h3>
        <div className="kind-grid">
          {kindList.map((k) => (
            <button
              key={k.kind}
              className={`kind ${kind === k.kind ? 'active' : ''}`}
              onClick={() => setKind(k.kind)}
            >
              <Icon name={k.icon} size={17} />
              <div style={{ marginTop: 4 }}>{kindLabel(k.kind)}</div>
              <span className="kd">{k.desc}</span>
            </button>
          ))}
        </div>

        {needsInstaller && (
          <div className="hint" style={{ marginTop: 8 }}>
            {kindLabel(kind)} 官方只提供安装器：CraftDesk 会下载官方安装器并运行它，
            让它自己联网拉齐运行库（第一次要下一两百 MB，进度会在下面实时显示）。
            装完没有可 -jar 的核心，用的是安装器生成的参数文件。
          </div>
        )}

        {proxyGroup && (
          <div className="hint" style={{ marginTop: 8, lineHeight: 1.9 }}>
            <b style={{ color: 'var(--text-dim)' }}>代理端不是服务端</b>：它不加载世界、不给玩家算方块，
            只负责「玩家连这里 → 转发到后端服务器」，用来把好几台服拼成一个入口。
            <br />
            它没有 EULA，也不用 server.properties —— 端口和后端写在它自己的
            {kind === 'velocity' ? ' velocity.toml' : ' config.yml'} 里，装完 CraftDesk
            会按你下面填的端口先生成一份（Velocity 用的是核心里自带的官方模板）。
            <br />
            装好之后可以在「跨服配置」里加后端、在「网络拓扑」里看整张图；
            CraftDesk 会检查每个后端有没有真的接上代理端。
          </div>
        )}
      </div>

      <div className="form-section">
        <h3>基本信息</h3>
        <Field label={isProxy ? `${kindLabel(kind)} 版本` : 'Minecraft 版本'}>
          {loadingVersions ? (
            <span className="hint">正在获取版本列表…</span>
          ) : (
            <select className="select" value={version} onChange={(e) => pickVersion(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                  {v.latestBuild ? ` · ${kindLabel(kind)} ${v.latestBuild}` : ''}
                </option>
              ))}
              {versions.length === 0 && <option value="">没有可用版本</option>}
            </select>
          )}
        </Field>

        {needsInstaller && (
          <Field
            label={`${kindLabel(kind)} 构建号`}
            hint={kind === 'forge' ? '默认是官方推荐版' : '默认是最新稳定版'}
          >
            <input
              className="input"
              value={build}
              spellCheck={false}
              placeholder={kind === 'forge' ? '例如 47.2.0' : '例如 21.1.209'}
              onChange={(e) => setBuild(e.target.value)}
            />
          </Field>
        )}
        {version && (
          <div
            className="hint"
            style={{ marginBottom: 8, color: javaCheck(version).best ? undefined : 'var(--warn)' }}
          >
            {isProxy ? proxyJavaHintText(kind, version) : javaHintText(version)}
            {(() => {
              const c = javaCheck(version)
              if (c.best) return `　已找到 Java ${c.best}，会自动用它启动。`
              return `　注意：没有找到 Java ${c.need} 及以上，这个服务端装好后起不来。`
            })()}
          </div>
        )}

        <Field label="服务器名称" hint="同时作为文件夹名">
          <input
            className="input"
            value={name}
            placeholder="例如：生存服"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field label="安装位置">
          <input
            className="input"
            value={parentDir}
            readOnly
            placeholder="选择一个文件夹"
            style={{ color: parentDir ? 'var(--text)' : 'var(--text-faint)' }}
          />
          <button className="btn sm" onClick={() => void pickDir()}>
            浏览
          </button>
        </Field>

        {installPath && (
          <div className="hint" style={{ marginBottom: 8 }}>
            将安装到：<code>{installPath}</code>
          </div>
        )}
      </div>

      <div className="form-section">
        <h3>{isProxy ? '初始配置（写进代理端自己的配置）' : '初始配置'}</h3>
        <Field label={isProxy ? '监听端口' : '服务器端口'} hint={isProxy ? '玩家连这个端口' : undefined}>
          <input
            className="input"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </Field>
        <Field label="服务器描述（MOTD）">
          <input className="input" value={motd} onChange={(e) => setMotd(e.target.value)} />
        </Field>
        <Field label="最小内存 / 最大内存" hint="单位 MB">
          <input
            className="input"
            type="number"
            step={256}
            value={memory.min}
            onChange={(e) => setMemory((m) => ({ ...m, min: Number(e.target.value) }))}
          />
          <input
            className="input"
            type="number"
            step={256}
            value={memory.max}
            onChange={(e) => setMemory((m) => ({ ...m, max: Number(e.target.value) }))}
          />
        </Field>
        {isProxy ? (
          <div className="hint" style={{ lineHeight: 1.8 }}>
            代理端不需要同意 EULA（那是 Mojang 对「服务端」的要求），
            所以这里不会有那一步；它也不会生成 world、logs 之类的东西。
          </div>
        ) : (
          <Field label="自动同意 EULA" hint="不勾选的话首次启动需要手动同意">
            <Switch checked={eula} onChange={setEula} />
          </Field>
        )}
      </div>

      <div className="form-section">
        <h3>外置辅助端</h3>
        <Field
          label="用 MCDReforged 托管"
          hint="MCDR 是跑在服务端外面的一层，用 Python 插件扩展功能（玩家管理、指令、定时任务等）"
        >
          <Switch checked={wantMcdr} onChange={setWantMcdr} />
        </Field>

        {wantMcdr && (
          <>
            <Field label="Python 解释器" hint="MCDR 需要 Python 3.8 及以上">
              <select
                className="select"
                value={python?.path ?? ''}
                onChange={(e) => setPythonPath(e.target.value)}
              >
                {pythonList.map((p) => (
                  <option key={p.path} value={p.path}>
                    Python {p.version}
                    {p.mcdr ? ` · MCDR ${p.mcdr}` : ' · 未装 MCDR'}
                    {p.suitable ? '' : '（版本过低）'}
                  </option>
                ))}
                {!pythonList.length && <option value="">没有找到 Python</option>}
              </select>
              <button className="btn sm" onClick={() => void refreshPython()}>
                <Icon name="refresh" size={14} />
                重新检测
              </button>
            </Field>

            {!pythonList.length && (
              <div className="hint" style={{ marginBottom: 8, color: 'var(--warn)' }}>
                没找到 Python。MCDReforged 是个 Python 程序，先去 python.org 装一个
                3.8 以上的版本（安装时记得勾上 Add Python to PATH），再回来点「重新检测」。
              </div>
            )}

            {python && !python.suitable && (
              <div className="hint" style={{ marginBottom: 8, color: 'var(--warn)' }}>
                这个 Python 是 {python.version}，MCDReforged 要求 3.8 及以上，换一个再装。
              </div>
            )}

            {python && python.suitable && !python.mcdr && (
              <div className="hint" style={{ marginBottom: 8, color: 'var(--warn)' }}>
                这个 Python 里还没有 mcdreforged（pip 包）。
                <button
                  className="btn sm"
                  style={{ marginLeft: 8 }}
                  disabled={installingMcdr}
                  onClick={() => void installMcdrNow()}
                >
                  <Icon name="download" size={14} />
                  {installingMcdr ? '正在安装…' : '用 pip 装上'}
                </button>
              </div>
            )}

            {mcdrOk && (
              <div className="hint" style={{ marginBottom: 8 }}>
                核心会装进 <code>server/</code> 子目录，MCDR 的配置（config.yml）和插件目录留在服务器根目录，
                CraftDesk 会按类型自动选好 handler（{
                  isProxy
                    ? `${kind}_handler`
                    : kind === 'forge' || kind === 'neoforge'
                      ? 'forge_handler'
                      : kind === 'paper' || kind === 'purpur'
                        ? 'bukkit14_handler'
                        : 'vanilla_handler'
                }）。
                内存写在 MCDR 的 config.yml 里，改完记得重新生成。
              </div>
            )}
          </>
        )}
      </div>

      {task && (
        <div style={{ marginBottom: 16 }}>
          <div className="progress">
            <div style={{ width: `${task.percent}%` }} />
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {task.message}
            {task.total > 0 && ` · ${formatBytes(task.received)} / ${formatBytes(task.total)}`}
          </div>
        </div>
      )}

      <div className="modal-foot" style={{ padding: 0, borderTop: 'none' }}>
        <button className="btn" onClick={onBack} disabled={installing}>
          <Icon name="chevron-left" size={14} />
          返回
        </button>
        <div className="spacer" />
        <button className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
          <Icon name="download" size={15} />
          {installing
            ? needsInstaller
              ? '安装中（要等一会儿）…'
              : '正在下载安装…'
            : '下载并创建'}
        </button>
      </div>
    </>
  )
}
