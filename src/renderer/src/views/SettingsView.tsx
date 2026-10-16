import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { Field, Switch } from '../components/ui'
import { useStore } from '../store'
import { DEFAULT_UI, WIDTH_LIMITS, clampWidth } from '../uiPrefs'
import { requiredJavaMajor } from '../../../shared/javaHint'

export function SettingsView(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const javaList = useStore((s) => s.javaList)
  const toast = useStore((s) => s.toast)
  const servers = useStore((s) => s.servers)
  const refresh = useStore((s) => s.refresh)
  const pythonList = useStore((s) => s.pythonList)
  const backgroundError = useStore((s) => s.backgroundError)
  const refreshPython = useStore((s) => s.refreshPython)
  const [scanning, setScanning] = useState(false)
  const [scanningPython, setScanningPython] = useState(false)
  const [installingMcdr, setInstallingMcdr] = useState(false)
  const [info, setInfo] = useState<{
    version: string
    electron: string
    node: string
    chrome: string
    platform: string
    userData: string
    portable: boolean
    dataNote: string
    home: string
    cpus: number
    totalMem: number
    startedAt: number
  } | null>(null)

  useEffect(() => {
    void window.api.app.info().then((r) => r.ok && setInfo(r.data!))
  }, [])

  useEffect(() => {
    if (!javaList.length) void scanJava()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scanJava = async (): Promise<void> => {
    setScanning(true)
    const res = await window.api.java.detect()
    setScanning(false)
    if (res.ok) {
      toast(`找到 ${res.data!.length} 个 Java 运行环境`, 'success')
    } else {
      toast(res.error ?? '扫描失败', 'error')
    }
  }

  const scanPython = async (): Promise<void> => {
    setScanningPython(true)
    const list = await refreshPython()
    setScanningPython(false)
    if (!list.length) {
      toast('没有找到 Python，MCDReforged 需要它才能跑', 'error')
      return
    }
    const ready = list.filter((p) => p.suitable && p.mcdr).length
    toast(
      ready
        ? `找到 ${list.length} 个 Python，其中 ${ready} 个可以直接跑 MCDReforged`
        : `找到 ${list.length} 个 Python，但都还没装 mcdreforged`,
      ready ? 'success' : 'info'
    )
  }

  const pickPython = async (): Promise<void> => {
    const res = await window.api.app.pickFile('选择 python.exe')
    if (!res.ok || !res.data) return
    const list = await refreshPython(res.data)
    if (!list.length) {
      toast('这个文件不是能用的 python.exe', 'error')
      return
    }
    void patch({ pythonPath: res.data })
  }

  const installMcdrFor = async (path: string): Promise<void> => {
    setInstallingMcdr(true)
    toast('正在用 pip 安装 mcdreforged…', 'info')
    const res = await window.api.python.installMcdr(path)
    setInstallingMcdr(false)
    if (res.ok) {
      await refreshPython()
      void patch({ pythonPath: path })
      toast(`MCDReforged ${res.data?.mcdr ?? ''} 已就绪`, 'success')
    } else {
      toast(res.error ?? '安装失败', 'error')
    }
  }

  /** 选一张背景图。图片本身由主进程读成 data URL，这里只存路径 */
  const pickBackground = async (): Promise<void> => {
    const res = await window.api.app.pickFile('选择背景图片', 'image')
    if (!res.ok || !res.data) return
    // 先让主进程读一次：格式不对、文件太大都在这一步拦住，
    // 免得配置里存了一个永远显示不出来的路径
    const probe = await window.api.app.readImage(res.data)
    if (!probe.ok) {
      toast(probe.error ?? '这张图片用不了', 'error')
      return
    }
    void patch({ backgroundImage: res.data })
    toast(`背景已换成 ${res.data.split(/[\/]/).pop()}`, 'success')
  }

  const resetAppearance = (): void => {
    void patch({
      sideWidth: DEFAULT_UI.sideWidth,
      panelWidth: DEFAULT_UI.panelWidth,
      backgroundImage: '',
      backgroundOpacity: DEFAULT_UI.backgroundOpacity,
      surfaceOpacity: DEFAULT_UI.surfaceOpacity
    })
    toast('外观已恢复默认', 'success')
  }

  const patch = async (p: Record<string, unknown>): Promise<void> => {
    const res = await window.api.settings.patch(p)
    if (res.ok) useStore.setState({ settings: res.data! })
    else toast(res.error ?? '保存失败', 'error')
  }

  if (!settings) return <div className="center-state">正在读取设置…</div>

  const pickJava = async (): Promise<void> => {
    const res = await window.api.app.pickFile('选择 java.exe')
    if (!res.ok || !res.data) return
    const probe = await window.api.java.probe(res.data)
    if (probe.ok) {
      useStore.setState((s) => ({
        javaList: [probe.data!, ...s.javaList.filter((j) => j.path !== probe.data!.path)]
      }))
    }
    void patch({ javaPath: res.data })
  }

  return (
    <div className="dash">
      <div className="form">
        {/*
          个性化放在最前面：改完立刻能看见效果，不用往下翻。
          所有改动都是即时生效的（patch 之后整棵树的 CSS 变量就变了），
          这里的控件只负责写值。
        */}
        <div className="form-section">
          <h3>个性化</h3>

          <Field label="左侧列表宽度" hint={`${WIDTH_LIMITS.side.min} ~ ${WIDTH_LIMITS.side.max} px`}>
            <input
              className="range"
              type="range"
              min={WIDTH_LIMITS.side.min}
              max={WIDTH_LIMITS.side.max}
              step={2}
              value={clampWidth('side', settings.sideWidth)}
              onChange={(e) => void patch({ sideWidth: clampWidth('side', Number(e.target.value)) })}
            />
            <input
              className="input narrow"
              type="number"
              min={WIDTH_LIMITS.side.min}
              max={WIDTH_LIMITS.side.max}
              value={clampWidth('side', settings.sideWidth)}
              onChange={(e) => void patch({ sideWidth: clampWidth('side', Number(e.target.value)) })}
            />
            <span className="hint">px</span>
          </Field>

          <Field
            label="右侧面板宽度"
            hint={`${WIDTH_LIMITS.panel.min} ~ ${WIDTH_LIMITS.panel.max} px`}
          >
            <input
              className="range"
              type="range"
              min={WIDTH_LIMITS.panel.min}
              max={WIDTH_LIMITS.panel.max}
              step={2}
              value={clampWidth('panel', settings.panelWidth)}
              onChange={(e) => void patch({ panelWidth: clampWidth('panel', Number(e.target.value)) })}
            />
            <input
              className="input narrow"
              type="number"
              min={WIDTH_LIMITS.panel.min}
              max={WIDTH_LIMITS.panel.max}
              value={clampWidth('panel', settings.panelWidth)}
              onChange={(e) => void patch({ panelWidth: clampWidth('panel', Number(e.target.value)) })}
            />
            <span className="hint">px</span>
          </Field>

          <Field label="背景图片" hint="铺满窗口">
            <button className="btn sm" onClick={() => void pickBackground()}>
              <Icon name="image" size={14} />
              选择图片
            </button>
            {settings.backgroundImage && (
              <>
                <span className="hint ellipsis" title={settings.backgroundImage}>
                  {settings.backgroundImage.split(/[\/]/).pop()}
                </span>
                <button
                  className="btn sm ghost"
                  onClick={() => void patch({ backgroundImage: '' })}
                >
                  清除
                </button>
              </>
            )}
          </Field>

          <Field label="背景不透明度" hint="图的可见程度">
            <input
              className="range"
              type="range"
              min={0}
              max={100}
              step={1}
              disabled={!settings.backgroundImage}
              value={Math.round(settings.backgroundOpacity * 100)}
              onChange={(e) =>
                void patch({ backgroundOpacity: Number(e.target.value) / 100 })
              }
            />
            <span className="hint num-hint">{Math.round(settings.backgroundOpacity * 100)}%</span>
          </Field>

          <Field label="界面不透明度" hint="越低越透">
            <input
              className="range"
              type="range"
              min={20}
              max={100}
              step={1}
              value={Math.round(settings.surfaceOpacity * 100)}
              onChange={(e) => void patch({ surfaceOpacity: Number(e.target.value) / 100 })}
            />
            <span className="hint num-hint">{Math.round(settings.surfaceOpacity * 100)}%</span>
          </Field>

          {backgroundError && settings.backgroundImage && (
            <div className="hint form-note" style={{ color: 'var(--warn)', marginBottom: 4 }}>
              这张背景图现在读不出来，已经按「没有背景」显示：{backgroundError}
            </div>
          )}

          <div className="hint form-note" style={{ marginBottom: 10 }}>
            两侧宽度也可以直接把鼠标移到分界线上拖动，双击分界线恢复默认。
            <br />
            背景图支持 png / jpg / webp / gif / bmp，32 MB 以内，会按窗口比例铺满（居中裁切）。
            {settings.backgroundImage ? '' : ' 没选背景图时，「界面不透明度」不会有变化。'}
          </div>

          <Field label="恢复默认">
            <button className="btn sm" onClick={resetAppearance}>
              <Icon name="refresh" size={14} />
              恢复默认外观
            </button>
          </Field>
        </div>

        <div className="form-section">
          <h3>Java 运行环境</h3>
          <Field label="默认 Java" hint="新建服务器时默认使用这个">
            <select
              className="select"
              value={settings.javaPath}
              onChange={(e) => void patch({ javaPath: e.target.value })}
            >
              <option value="">未设置</option>
              {javaList.map((j) => (
                <option key={j.path} value={j.path}>
                  Java {j.major || '?'} · {j.version} · {j.vendor}
                </option>
              ))}
            </select>
            <button className="btn sm" onClick={() => void pickJava()}>
              浏览
            </button>
            <button className="btn sm" disabled={scanning} onClick={() => void scanJava()}>
              <Icon name="refresh" size={14} />
              {scanning ? '扫描中…' : '重新扫描'}
            </button>
          </Field>

          {javaList.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {javaList.map((j) => (
                <div key={j.path} className="row">
                  <span
                    className="server-icon"
                    style={{
                      background: j.major >= 17 ? '#22c55e' : '#f59e0b',
                      width: 30,
                      height: 30,
                      fontSize: 11
                    }}
                  >
                    {j.major || '?'}
                  </span>
                  <div className="row-main">
                    <div className="row-title">
                      Java {j.major} · {j.version}
                      {j.major >= 21 && <span className="tag green">支持 1.21</span>}
                    </div>
                    <div className="row-sub" title={j.path}>
                      {j.path}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      className="btn sm ghost"
                      onClick={() =>
                        toast(
                          `1.20.5 及以上需要 Java ${requiredJavaMajor('1.21')}，1.17~1.20.4 需要 Java 17`,
                          'info'
                        )
                      }
                    >
                      版本要求
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!javaList.length && !scanning && (
            <div className="hint" style={{ marginTop: 8 }}>
              没有找到 Java。请安装 JDK / JRE，或者手动指定 java.exe 的路径。
            </div>
          )}
        </div>

        {/*
          MCDReforged 是 Python 程序，不是 jar：能不能用取决于
          有没有 Python、够不够新、里面装了 mcdreforged 没。三件事分开说。
        */}
        <div className="form-section">
          <h3>Python / MCDReforged</h3>
          <Field label="默认 Python" hint="用 MCDReforged 托管服务器时默认使用这个">
            <select
              className="select"
              value={settings.pythonPath}
              onChange={(e) => void patch({ pythonPath: e.target.value })}
            >
              <option value="">未设置</option>
              {pythonList.map((p) => (
                <option key={p.path} value={p.path}>
                  Python {p.version}
                  {p.mcdr ? ` · MCDR ${p.mcdr}` : ''}
                </option>
              ))}
            </select>
            <button className="btn sm" onClick={() => void pickPython()}>
              浏览
            </button>
            <button className="btn sm" disabled={scanningPython} onClick={() => void scanPython()}>
              <Icon name="refresh" size={14} />
              {scanningPython ? '检测中…' : '重新检测'}
            </button>
          </Field>

          {pythonList.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {pythonList.map((p) => {
                const canRun = p.suitable && Boolean(p.mcdr)
                return (
                  <div key={p.path} className="row">
                    <span
                      className="server-icon"
                      style={{
                        background: canRun ? '#22c55e' : p.suitable ? '#f59e0b' : '#6b7280',
                        width: 30,
                        height: 30,
                        fontSize: 11
                      }}
                    >
                      {p.major}.{p.minor}
                    </span>
                    <div className="row-main">
                      <div className="row-title">
                        Python {p.version}
                        {p.mcdr ? (
                          <span className="tag green">MCDReforged {p.mcdr}</span>
                        ) : p.suitable ? (
                          <span className="tag orange">未装 mcdreforged</span>
                        ) : (
                          <span className="tag">版本过低</span>
                        )}
                      </div>
                      <div className="row-sub" title={p.path}>
                        {p.path}
                      </div>
                    </div>
                    <div className="row-actions">
                      <button
                        className="btn sm ghost"
                        disabled={!p.suitable || installingMcdr}
                        title={
                          p.suitable
                            ? 'pip install --upgrade mcdreforged'
                            : 'MCDReforged 需要 Python 3.8 及以上'
                        }
                        onClick={() => void installMcdrFor(p.path)}
                      >
                        <Icon name="download" size={14} />
                        {p.mcdr ? '更新 MCDR' : '安装 MCDR'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {!pythonList.length && !scanningPython && (
            <div className="hint" style={{ marginTop: 8 }}>
              没有找到 Python。MCDReforged 是个 Python 程序，要装它得先有
              <code> python.exe</code>：去 python.org 装 3.8 以上的版本（勾上 Add to PATH），
              或者用 Microsoft Store 装，然后点「重新检测」。
              <br />
              只用原版 / Paper / Forge 这些服务端的话，不需要 Python。
            </div>
          )}
        </div>

        <div className="form-section">
          <h3>新建服务器的默认值</h3>
          <Field label="默认最小内存" hint="单位 MB">
            <input
              className="input"
              type="number"
              min={128}
              step={256}
              value={settings.defaultMemoryMin}
              onChange={(e) => void patch({ defaultMemoryMin: Number(e.target.value) })}
            />
          </Field>
          <Field label="默认最大内存" hint="单位 MB">
            <input
              className="input"
              type="number"
              min={256}
              step={256}
              value={settings.defaultMemoryMax}
              onChange={(e) => void patch({ defaultMemoryMax: Number(e.target.value) })}
            />
          </Field>
          <Field label="默认 JVM 参数">
            <textarea
              className="textarea"
              value={settings.defaultJvmArgs}
              onChange={(e) => void patch({ defaultJvmArgs: e.target.value })}
            />
          </Field>
        </div>

        <div className="form-section">
          <h3>下载源</h3>
          <Field label="CurseForge API Key" hint="留空则 CurseForge 源不可用">
            <input
              className="input"
              type="password"
              value={settings.curseforgeApiKey}
              placeholder="粘贴 CurseForge 的 API Key"
              spellCheck={false}
              onChange={(e) => void patch({ curseforgeApiKey: e.target.value })}
            />
            <button
              className="btn sm"
              onClick={() =>
                void window.api.app.openExternal('https://console.curseforge.com/?#/api-keys')
              }
            >
              <Icon name="external" size={14} />
              去申请
            </button>
          </Field>
          <div className="hint form-note">
            CurseForge 官方 API 不接受匿名请求，必须带 Key。免费申请，填进来即可在「下载扩展」里搜索。
            <br />
            Modrinth 和 Hangar 不需要 Key，SpigotMC 用第三方 Spiget 接口。
          </div>
        </div>

        <div className="form-section">
          <h3>行为</h3>
          <Field label="退出时自动停止所有服务器" hint="避免留下后台 Java 进程">
            <Switch
              checked={settings.stopOnExit}
              onChange={(v) => void patch({ stopOnExit: v })}
            />
          </Field>
          <Field label="日志保留行数" hint="主进程内存中保留的日志上限">
            <input
              className="input"
              type="number"
              min={500}
              max={50000}
              step={500}
              value={settings.maxLogLines}
              onChange={(e) => void patch({ maxLogLines: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div className="form-section">
          <h3>数据</h3>
          <Field label="服务器总数">
            <span className="hint">{servers.length} 个</span>
          </Field>
          <Field label="配置文件">
            <button className="btn sm" onClick={() => void window.api.app.revealUserData()}>
              <Icon name="folder-open" size={14} />
              打开配置目录
            </button>
          </Field>
          <Field label="刷新列表">
            <button
              className="btn sm"
              onClick={() => {
                void refresh()
                void useStore.getState().init()
                toast('已重新载入', 'success')
              }}
            >
              <Icon name="refresh" size={14} />
              重新载入
            </button>
          </Field>
        </div>

        <div className="form-section">
          <h3>内存参考</h3>
          <div className="hint" style={{ lineHeight: 2 }}>
            原版服务端 2~4 GB 通常够用；装了 50 个插件建议 6 GB 以上；
            <br />
            模组服按模组数量给，一般每个大型模组预留 100~200 MB。
            <br />
            建议最大内存不要超过物理内存的 70%，把余量留给系统和存档缓存。
          </div>
        </div>
        <div className="form-section">
          <h3>运行环境</h3>
          {info && (
            <div className="card" style={{ padding: '12px 14px' }}>
              <EnvRow k="CraftDesk 版本" v={info.version} />
              <EnvRow k="Electron / Chromium" v={`${info.electron} / ${info.chrome}`} />
              <EnvRow k="Node.js" v={info.node} />
              <EnvRow k="平台" v={info.platform} />
              <EnvRow
                k="本次启动"
                v={new Date(info.startedAt).toLocaleString('zh-CN', { hour12: false })}
              />
              <EnvRow
                k="配置存放位置"
                v={
                  <>
                    {info.portable && <span className="tag green">便携模式</span>}
                    <span style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                      {info.userData}
                    </span>
                    <div className="hint" style={{ marginTop: 2 }}>{info.dataNote}</div>
                  </>
                }
                mono
              />
            </div>
          )}
          <div className="hint" style={{ marginTop: 8 }}>
            「本次启动」早于你最后一次改动的话，说明跑的还是旧实例——
            关掉窗口重开即可。
          </div>
        </div>
      </div>
    </div>
  )
}

function EnvRow({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }): JSX.Element {
  const row: CSSProperties = {
    display: 'flex',
    gap: 16,
    padding: '5px 0',
    fontSize: 12.5,
    borderBottom: '1px solid var(--border-soft)'
  }
  return (
    <div style={row}>
      <span style={{ color: 'var(--text-muted)', width: 170, flexShrink: 0 }}>{k}</span>
      <span
        style={{
          color: 'var(--text-dim)',
          fontFamily: mono ? 'var(--mono)' : undefined,
          wordBreak: 'break-all',
          flex: 1
        }}
      >
        {v}
      </span>
    </div>
  )
}
