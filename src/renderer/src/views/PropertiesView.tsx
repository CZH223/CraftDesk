import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { Field, Switch, Spinner } from '../components/ui'
import { DeleteServerDialog } from '../components/DeleteServerDialog'
import { ServerAvatar } from '../components/ServerAvatar'
import { ServerIconDialog } from '../components/ServerIconDialog'
import { ProxyView } from './ProxyView'
import { useStore } from '../store'
import { kindLabel } from '../utils'
import {
  PROPERTY_ENUMS,
  isBooleanKey,
  propertyLabel
} from '../../../shared/propertyMeta'
import type {
  FileEntry,
  PropertiesEntry,
  ServerLayoutInfo,
  ServerView
} from '../../../shared/types'

type Tab = 'launch' | 'props'

export function PropertiesView({ server }: { server: ServerView }): JSX.Element {
  const [tab, setTab] = useState<Tab>('launch')
  const [layout, setLayout] = useState<ServerLayoutInfo | null>(null)
  const [tabPicked, setTabPicked] = useState(false)

  // 布局解析的结果两个子页都要用，提到这一层取一次
  useEffect(() => {
    void window.api.layout.get(server.id).then((res) => {
      if (res.ok) setLayout(res.data!)
    })
  }, [server.id])

  // 代理端要先看 velocity.toml，jar 启动配置反而是次要的。
  // 只在布局第一次解析出来时切一次，之后尊重用户自己的选择。
  useEffect(() => {
    if (!layout || tabPicked) return
    setTabPicked(true)
    if (layout.isProxy) setTab('props')
  }, [layout, tabPicked])

  const isProxy = layout?.isProxy ?? false
  const proxyFile = layout?.proxyConfigFile || ''

  return (
    <div className="content">
      <div className="console-toolbar">
        <div className="seg" style={{ margin: 0, width: 380 }}>
          <button className={tab === 'launch' ? 'active' : ''} onClick={() => setTab('launch')}>
            <Icon name="sliders" size={13} />
            启动配置
          </button>
          <button className={tab === 'props' ? 'active' : ''} onClick={() => setTab('props')}>
            <Icon name="file-text" size={13} />
            {isProxy ? proxyFile || 'velocity.toml' : 'server.properties'}
          </button>
        </div>
      </div>

      <div className="dash" style={{ padding: 0 }}>
        {tab === 'launch' ? (
          <LaunchForm server={server} layout={layout} />
        ) : isProxy ? (
          <ProxyView server={server} />
        ) : (
          <PropsForm server={server} />
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 启动配置

function LaunchForm({
  server,
  layout
}: {
  server: ServerView
  layout: ServerLayoutInfo | null
}): JSX.Element {
  const javaList = useStore((s) => s.javaList)
  const pythonList = useStore((s) => s.pythonList)
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refresh)
  const setPanel = useStore((s) => s.setPanel)
  const settings = useStore((s) => s.settings)
  const isProxy = layout?.isProxy ?? false
  const [iconOpen, setIconOpen] = useState(false)

  const [form, setForm] = useState({
    name: server.name,
    jar: server.jar,
    launchArgs: server.launchArgs,
    pythonPath: server.pythonPath,
    startScript: server.startScript,
    javaPath: server.javaPath,
    memoryMin: server.memoryMin,
    memoryMax: server.memoryMax,
    jvmArgs: server.jvmArgs,
    serverArgs: server.serverArgs,
    autoRestart: server.autoRestart,
    pluginsDir: server.pluginsDir,
    modsDir: server.modsDir,
    note: server.note
  })
  const [jars, setJars] = useState<FileEntry[]>([])
  const [scripts, setScripts] = useState<FileEntry[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // 每次切换服务器都要重置表单
  useEffect(() => {
    setForm({
      name: server.name,
      jar: server.jar,
      launchArgs: server.launchArgs,
      pythonPath: server.pythonPath,
      startScript: server.startScript,
      javaPath: server.javaPath,
      memoryMin: server.memoryMin,
      memoryMax: server.memoryMax,
      jvmArgs: server.jvmArgs,
      serverArgs: server.serverArgs,
      autoRestart: server.autoRestart,
      pluginsDir: server.pluginsDir,
      modsDir: server.modsDir,
      note: server.note
    })
    setDirty(false)
  }, [server.id])

  // 核心可能在子目录里（MCDReforged、各类面板的默认布局），
  // 把当前配置指向的那个子目录也扫一遍，否则界面会显示「没有 jar 文件」。
  const scanFiles = useCallback(async (): Promise<void> => {
    const root = await window.api.fs.list(server.dir, '')
    if (!root.ok) return

    const pick = (list: FileEntry[], exts: string[]): FileEntry[] =>
      list.filter((f) => !f.isDir && exts.includes(f.ext))

    let all = root.data!
    const sep = server.jar.lastIndexOf('/')
    const sub = sep > 0 ? server.jar.slice(0, sep) : ''
    if (sub) {
      const nested = await window.api.fs.list(server.dir, sub)
      if (nested.ok) all = [...all, ...nested.data!]
    }

    setJars(pick(all, ['.jar']))
    setScripts(pick(all, ['.bat', '.sh', '.cmd']))
  }, [server.dir, server.jar])

  useEffect(() => {
    void scanFiles()
  }, [scanFiles])

  /** 生成 / 重新生成启动脚本，生成完重扫一遍好让下拉框里能选到它 */
  const [scriptBusy, setScriptBusy] = useState(false)
  const makeStartScript = async (): Promise<void> => {
    setScriptBusy(true)
    const res = await window.api.server.writeStartScript(server.id)
    setScriptBusy(false)
    if (!res.ok) {
      toast(res.error ?? '生成失败', 'error')
      return
    }
    toast(`已生成 ${res.data!.file}`, 'success')
    await scanFiles()
  }

  const patch = (p: Partial<typeof form>): void => {
    setForm((f) => ({ ...f, ...p }))
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    const res = await window.api.servers.update(server.id, {
      ...form,
      memoryMin: Number(form.memoryMin) || 0,
      memoryMax: Number(form.memoryMax) || 0
    })
    setSaving(false)
    if (res.ok) {
      toast('已保存', 'success')
      setDirty(false)
      void refresh()
    } else {
      toast(res.error ?? '保存失败', 'error')
    }
  }

  const pickJava = async (): Promise<void> => {
    const res = await window.api.app.pickFile('选择 java.exe')
    if (!res.ok || !res.data) return
    const probe = await window.api.java.probe(res.data)
    if (probe.ok) {
      useStore.setState((s) => ({
        javaList: [probe.data!, ...s.javaList.filter((j) => j.path !== probe.data!.path)]
      }))
      toast(`已选择 Java ${probe.data!.version || ''}`, 'success')
    }
    patch({ javaPath: res.data })
  }

  return (
    <div className="form">
      <div className="detect-card">
        {/* 图标本身就是「改图标」的入口：点它比在菜单里找一层直观 */}
        <button
          className="detect-icon-btn"
          title="点击更换服务器图标"
          onClick={() => setIconOpen(true)}
        >
          <ServerAvatar server={server} size={44} />
          <span className="detect-icon-hint">
            <Icon name="image" size={12} />
          </span>
        </button>
        <div className="detect-main">
          <div className="detect-name">
            {server.name}
            <button className="link-btn" onClick={() => setIconOpen(true)}>
              换图标
            </button>
          </div>
          <div className="detect-path">{server.dir}</div>
          <div className="detect-tags">
            <span className="tag">{kindLabel(server.kind)}</span>
            {server.mcVersion && <span className="tag blue">{server.mcVersion}</span>}
            <span className="tag">
              {server.runtime.status === 'stopped' ? '已停止' : '运行中'}
            </span>
            {layout?.isMcdr && <span className="tag purple">MCDReforged 托管</span>}
            {layout?.coreRel && (
              <span className="tag">核心在 {layout.coreRel}/ 子目录</span>
            )}
          </div>
        </div>
      </div>

      {/*
        MCDR 会自己拼启动命令，CraftDesk 这里的内存和 JVM 参数根本传不进去。
        不提醒的话用户改完以为生效了，实际跑的还是 config.yml 里那份。
      */}
      {/*
        只有「真的由 MCDR 启动」时下面的内存才不会生效：
        走启动脚本、或者配了 Python 由 MCDR 托管，都属于这种。
        用户手动选了「直接用 Java 启动 jar」的 MCDR 目录不算——那时
        CraftDesk 直接开核心，内存是生效的。
      */}
      {layout?.isMcdr && (form.startScript || form.pythonPath) && (
        <div className="issue-bar" style={{ margin: '0 0 16px' }}>
          <Icon name="alert" size={16} />
          <span className="issue-text">
            这个服务器由 <b>MCDReforged</b> 托管，实际启动命令写在 <code>config.yml</code> 的{' '}
            <code>start_command</code> 里，下面的内存与 JVM 参数不会生效。
            {layout.mcdrMemory.max != null && (
              <>
                {' '}
                当前实际内存为 <b>{layout.mcdrMemory.min ?? '?'} ~ {layout.mcdrMemory.max} MB</b>。
              </>
            )}
          </span>
          <button className="btn sm primary" onClick={() => setPanel('configs')}>
            去改 config.yml
          </button>
        </div>
      )}

      <div className="form-section">
        <h3>基本信息</h3>
        <Field label="显示名称">
          <input
            className="input"
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label="备注" hint="只用于自己辨认，不会写进服务端">
          <input
            className="input"
            value={form.note}
            placeholder="例如：和朋友一起玩的原版生存"
            onChange={(e) => patch({ note: e.target.value })}
          />
        </Field>
        <Field label="服务器目录">
          <input className="input" value={server.dir} readOnly style={{ color: 'var(--text-muted)' }} />
          <button className="btn sm" onClick={() => void window.api.app.openFolder(server.dir)}>
            <Icon name="folder-open" size={14} />
            打开
          </button>
        </Field>
      </div>

      <div className="form-section">
        <h3>启动方式</h3>
        <Field label="用启动脚本" hint="设置后优先执行脚本，忽略下面的 jar 与内存参数">
          <select
            className="select"
            value={form.startScript}
            onChange={(e) => patch({ startScript: e.target.value })}
          >
            <option value="">不使用，直接用 Java 启动 jar</option>
            {scripts.map((s) => (
              <option key={s.path} value={s.path}>
                {s.path}
              </option>
            ))}
          </select>
          <button
            className="btn sm"
            disabled={scriptBusy || Boolean(layout?.isMcdr)}
            title={
              layout?.isMcdr
                ? 'MCDReforged 托管的服务器，启动命令在它的 config.yml 里'
                : '按当前配置生成 start.bat'
            }
            onClick={() => void makeStartScript()}
          >
            <Icon name="save" size={14} />
            {scripts.some((s) => s.name === 'start.bat' || s.name === 'start.sh')
              ? '重新生成脚本'
              : '生成启动脚本'}
          </button>
        </Field>
        <div className="hint" style={{ paddingLeft: 224, lineHeight: 1.8 }}>
          生成的是 <code>start.bat</code>，双击就能在控制台窗口里跑起来，报错信息一眼能看到。
          <br />
          它只是「手里有份能直接跑的命令」，CraftDesk 仍然按上面的内存和参数启动 ——
          换句话说，改完设置要重新生成一次脚本，它记的是生成那一刻的值。
        </div>

        {/*
          Forge / NeoForge 1.17 以后没有能 -jar 的核心，启动入口是安装器
          生成的参数文件。不留一栏说明的话，用户会看到「服务端核心」是空的。
        */}
        {form.launchArgs && (
          <Field label="启动参数文件" hint="Forge / NeoForge 用它启动（java @文件）">
            <input
              className="input"
              value={form.launchArgs}
              readOnly
              style={{ color: 'var(--text-muted)' }}
            />
          </Field>
        )}

        {(server.mcdr || layout?.isMcdr) && (
          <Field
            label="MCDReforged 的 Python"
            hint="设置后由 MCDR 启动，内存与 JVM 参数以它的 config.yml 为准"
          >
            <select
              className="select"
              value={form.pythonPath}
              onChange={(e) => patch({ pythonPath: e.target.value })}
            >
              <option value="">不用 MCDR（直接启动核心）</option>
              {pythonList.map((p) => (
                <option key={p.path} value={p.path}>
                  Python {p.version}
                  {p.mcdr ? ` · MCDR ${p.mcdr}` : ' · 未装 MCDR'}
                  {p.suitable ? '' : '（版本过低）'}
                </option>
              ))}
              {form.pythonPath && !pythonList.some((p) => p.path === form.pythonPath) && (
                <option value={form.pythonPath}>{form.pythonPath}</option>
              )}
            </select>
          </Field>
        )}

        <Field label="服务端核心" hint="相对服务器目录，可位于子目录">
          <select
            className="select"
            value={form.jar}
            disabled={Boolean(form.startScript)}
            onChange={(e) => patch({ jar: e.target.value })}
          >
            {!jars.some((j) => j.path === form.jar) && form.jar && (
              <option value={form.jar}>{form.jar}（未找到）</option>
            )}
            {jars.map((j) => (
              <option key={j.path} value={j.path}>
                {j.path}
              </option>
            ))}
            {jars.length === 0 && <option value="">没有找到 jar 文件</option>}
          </select>
          <button className="btn sm" onClick={() => void window.api.app.openFolder(server.dir)}>
            <Icon name="refresh" size={14} />
          </button>
        </Field>

        <Field label="Java 运行环境" hint="留空则使用全局设置里的 Java">
          <select
            className="select"
            value={form.javaPath}
            onChange={(e) => patch({ javaPath: e.target.value })}
          >
            <option value="">使用全局默认（{settings?.javaPath || '未设置'}）</option>
            {javaList.map((j) => (
              <option key={j.path} value={j.path}>
                Java {j.major || '?'} · {j.version} · {j.path}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={() => void pickJava()}>
            浏览
          </button>
        </Field>
      </div>

      <div className="form-section">
        <h3>性能与参数</h3>
        <Field label="最小内存" hint="对应 -Xms，单位 MB">
          <input
            className="input"
            type="number"
            min={128}
            step={256}
            value={form.memoryMin}
            onChange={(e) => patch({ memoryMin: Number(e.target.value) })}
          />
          <span className="hint">MB</span>
        </Field>
        <Field label="最大内存" hint="对应 -Xmx，单位 MB">
          <input
            className="input"
            type="number"
            min={256}
            step={256}
            value={form.memoryMax}
            onChange={(e) => patch({ memoryMax: Number(e.target.value) })}
          />
          <span className="hint">MB</span>
        </Field>
        <Field label="JVM 参数" hint="垃圾回收等调优参数，空格分隔">
          <textarea
            className="textarea"
            value={form.jvmArgs}
            placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=200"
            onChange={(e) => patch({ jvmArgs: e.target.value })}
          />
        </Field>
        <Field label="程序参数" hint="传给服务端本身的参数">
          <input
            className="input"
            value={form.serverArgs}
            placeholder="nogui"
            onChange={(e) => patch({ serverArgs: e.target.value })}
          />
        </Field>
        <Field label="异常退出后自动重启">
          <Switch checked={form.autoRestart} onChange={(v) => patch({ autoRestart: v })} />
        </Field>
      </div>

      <div className="form-section">
        <h3>目录约定</h3>
        <Field label="插件目录" hint="留空表示不使用">
          <input
            className="input"
            value={form.pluginsDir}
            placeholder="plugins"
            onChange={(e) => patch({ pluginsDir: e.target.value })}
          />
        </Field>
        <Field label="模组目录" hint="Fabric / Forge 用">
          <input
            className="input"
            value={form.modsDir}
            placeholder="mods"
            onChange={(e) => patch({ modsDir: e.target.value })}
          />
        </Field>
      </div>

      <div className="form-section">
        <h3>危险操作</h3>
        <Field label="移除或删除" hint="选「只移除」不会动文件">
          <button className="btn danger sm" onClick={() => setConfirmRemove(true)}>
            <Icon name="trash" size={14} />
            移除 / 删除这个服务器
          </button>
        </Field>
        <div className="hint" style={{ lineHeight: 1.8 }}>
          两种程度：只从 CraftDesk 的列表里移除（磁盘文件全部保留），
          或者连服务器目录一起删掉。后者需要输入服务器名称才会执行。
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
        <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
          <Icon name="save" size={14} />
          {saving ? '保存中…' : '保存修改'}
        </button>
        {dirty && <span className="hint" style={{ alignSelf: 'center' }}>有未保存的修改</span>}
      </div>

      {confirmRemove && (
        <DeleteServerDialog
          server={server}
          onClose={() => setConfirmRemove(false)}
          onDeleted={() => {
            setConfirmRemove(false)
            void refresh()
          }}
        />
      )}

      {iconOpen && <ServerIconDialog server={server} onClose={() => setIconOpen(false)} />}
    </div>
  )
}

// ------------------------------------------------------------------ properties

function PropsForm({ server }: { server: ServerView }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [entries, setEntries] = useState<PropertiesEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setLoading(true)
    void window.api.props.read(server.id).then((res) => {
      setEntries(res.ok ? res.data! : [])
      setLoading(false)
      setDirty(false)
    })
  }, [server.id])

  const filtered = useMemo(() => {
    if (!entries) return []
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.key.toLowerCase().includes(q) ||
        e.value.toLowerCase().includes(q) ||
        propertyLabel(e.key).toLowerCase().includes(q)
    )
  }, [entries, query])

  const update = (key: string, value: string): void => {
    setEntries((list) => list?.map((e) => (e.key === key ? { ...e, value } : e)) ?? null)
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    if (!entries) return
    setSaving(true)
    const res = await window.api.props.write(server.id, entries)
    setSaving(false)
    if (res.ok) {
      toast(
        server.runtime.status === 'stopped'
          ? '已保存，下次启动生效'
          : '已保存。部分选项需要重启服务器才生效',
        'success'
      )
      setDirty(false)
    } else {
      toast(res.error ?? '保存失败', 'error')
    }
  }

  if (loading) return <Spinner text="正在读取 server.properties…" />

  if (!entries || entries.length === 0) {
    return (
      <div className="center-state">
        <Icon name="alert" size={26} />
        <div>服务器目录下还没有 server.properties</div>
        <div className="hint" style={{ maxWidth: 420 }}>
          该文件在服务器第一次启动后会自动生成。可以先启动一次，再回来编辑。
        </div>
      </div>
    )
  }

  return (
    <div className="content">
      <div className="console-toolbar">
        <div className="panel-search" style={{ margin: 0, width: 240, height: 30 }}>
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索配置项"
            spellCheck={false}
          />
        </div>
        <span className="hint">
          共 {entries.length} 项{dirty && ' ·  有未保存的修改'}
        </span>
        <div className="toolbar-spacer" />
        <button className="btn primary sm" disabled={!dirty || saving} onClick={() => void save()}>
          <Icon name="save" size={14} />
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      <div className="dash" style={{ padding: '8px 0 24px' }}>
        <div className="form">
          {filtered.map((e) => (
            <PropertyRow
              key={e.key}
              entry={e}
              onChange={(v) => update(e.key, v)}
            />
          ))}
          {filtered.length === 0 && <div className="panel-empty">没有匹配的配置项</div>}
        </div>
      </div>
    </div>
  )
}

function PropertyRow({
  entry,
  onChange
}: {
  entry: PropertiesEntry
  onChange: (v: string) => void
}): JSX.Element {
  const label = propertyLabel(entry.key)
  const enums = PROPERTY_ENUMS[entry.key]
  const bool = isBooleanKey(entry.value)

  return (
    <Field label={label} hint={entry.key}>
      {bool ? (
        <Switch checked={entry.value === 'true'} onChange={(v) => onChange(String(v))} />
      ) : enums ? (
        <select className="select" value={entry.value} onChange={(e) => onChange(e.target.value)}>
          {!enums.some((o) => o.value === entry.value) && (
            <option value={entry.value}>{entry.value}</option>
          )}
          {enums.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input"
          value={entry.value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      )}
    </Field>
  )
}
