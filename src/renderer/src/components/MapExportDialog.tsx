import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui'
import { useStore } from '../store'
import type {
  MapExportEstimate,
  MapExportProgress,
  MapExportResult
} from '../../../shared/types'

const MIN_PX = 256
const MAX_PX = 32768
const PRESETS = [2048, 4096, 8192, 16384, 32768]

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

/**
 * 地图导出。
 *
 * 全部导出：当前维度的所有 region 拼成一张 PNG。
 * 分块导出：8 邻接连通块各一张；只要 region 挨着就画在一起，完全独立的才拆开。
 * 虚空 / 没有地表的格子保持透明。
 */
export function MapExportDialog({
  serverId,
  dim,
  dimLabel,
  onClose
}: {
  serverId: string
  dim: string
  dimLabel: string
  onClose: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState<'all' | 'components' | null>(null)
  const [progress, setProgress] = useState<MapExportProgress | null>(null)
  const [result, setResult] = useState<MapExportResult | null>(null)
  const [maxPx, setMaxPx] = useState(4096)
  const [estimateAll, setEstimateAll] = useState<MapExportEstimate | null>(null)
  const [estimateParts, setEstimateParts] = useState<MapExportEstimate | null>(null)
  const effectivePx = Math.max(
    MIN_PX,
    Math.min(MAX_PX, Math.floor(Number(maxPx) || 4096))
  )

  useEffect(() => {
    return window.api.map.onExportProgress((p) => {
      if (p.serverId === serverId && p.dim === dim) setProgress(p)
    })
  }, [serverId, dim])

  // 尺寸改变后稍等一下再预估，避免拖滑杆时连续打 IPC
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      void Promise.all([
        window.api.map.exportEstimate(serverId, dim, 'all', effectivePx),
        window.api.map.exportEstimate(serverId, dim, 'components', effectivePx)
      ]).then(([all, parts]) => {
        if (!alive) return
        setEstimateAll(all.ok ? all.data! : null)
        setEstimateParts(parts.ok ? parts.data! : null)
      })
    }, 220)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [serverId, dim, effectivePx])

  const run = async (mode: 'all' | 'components'): Promise<void> => {
    setBusy(mode)
    setProgress(null)
    setResult(null)
    const res = await window.api.map.exportMap(serverId, dim, mode, effectivePx)
    setBusy(null)
    if (!res.ok) {
      toast(res.error ?? '导出地图失败', 'error')
      return
    }
    if (res.data!.canceled) return
    setResult(res.data!)
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0

  const openDir = (): void => {
    if (!result?.dir) return
    void window.api.fs.open(result.dir, '').then((res) => {
      if (!res.ok) toast(res.error ?? '打开目录失败', 'error')
    })
  }

  const warning = estimateAll?.warning || estimateParts?.warning || null

  return (
    <Modal
      title="导出地图"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={Boolean(busy)}>
            关闭
          </button>
          <div className="spacer" />
          {result && (
            <button className="btn" onClick={openDir}>
              打开文件夹
            </button>
          )}
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() => void run('components')}
          >
            分块导出
          </button>
          <button
            className="btn primary"
            disabled={Boolean(busy)}
            onClick={() => void run('all')}
          >
            <Icon name="download" size={14} />
            {busy === 'all' ? '正在导出…' : '全部导出'}
          </button>
        </>
      }
    >
      <div className="map-export-size">
        <div className="map-export-size-head">
          <span>输出长边</span>
          <input
            className="map-export-range"
            type="range"
            min={512}
            max={MAX_PX}
            step={256}
            value={Math.min(MAX_PX, Math.max(512, effectivePx))}
            disabled={Boolean(busy)}
            onChange={(e) => setMaxPx(Number(e.target.value))}
          />
          <input
            className="input map-export-number"
            type="number"
            min={MIN_PX}
            max={MAX_PX}
            step={256}
            value={Number.isFinite(maxPx) ? maxPx : ''}
            disabled={Boolean(busy)}
            onChange={(e) => setMaxPx(Number(e.target.value))}
            onBlur={() => setMaxPx(effectivePx)}
          />
          <span className="mpp-muted">px</span>
        </div>
        <div className="map-export-presets">
          {PRESETS.map((v) => (
            <button
              key={v}
              className={`chip-btn ${effectivePx === v ? 'active' : ''}`}
              disabled={Boolean(busy)}
              onClick={() => setMaxPx(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="hint">
          这是输出图的长边像素上限；地图本身更小时保持原生分辨率，不强行放大。
          区域网格取整可能让实际长边略小于所选值，下面会显示实际尺寸。
        </div>
      </div>

      <div className="map-export-estimate">
        {estimateAll && (
          <div>
            <b>全部导出</b>：{estimateAll.width}×{estimateAll.height} · 预计{' '}
            {fmtBytes(estimateAll.estimatedBytesLow)}–{fmtBytes(estimateAll.estimatedBytesHigh)}
          </div>
        )}
        {estimateParts && (
          <div>
            <b>分块导出</b>：{estimateParts.targets.length} 张，最大{' '}
            {estimateParts.width}×{estimateParts.height} · 预计{' '}
            {fmtBytes(estimateParts.estimatedBytesLow)}–
            {fmtBytes(estimateParts.estimatedBytesHigh)}
          </div>
        )}
        {warning && <div className="map-export-warning">⚠ {warning}</div>}
      </div>

      <div className="map-export-intro">
        <div>
          <b>全部导出</b>：把当前维度（{dimLabel}）的所有区域拼成一张 PNG。
        </div>
        <div>
          <b>分块导出</b>：把完全独立的区域分别输出；只要区域之间挨着（边或角），
          就算同一块，一起输出。
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          虚空和没有地表数据的格子会保持透明。导出采用流式拼接，大尺寸不会一次性
          占用整张图的 RGBA 内存；但 16384 / 32768 级别仍然会写很大的文件，请留意速度与磁盘空间。
        </div>
      </div>

      {busy && (
        <div className="map-export-progress">
          <div className="map-export-progress-head">
            <span className="spin small" />
            <span>{progress ? `${progress.label} · ${progress.done}/${progress.total}` : '准备中…'}</span>
            <span className="map-export-percent">{percent}%</span>
          </div>
          <div className="map-export-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="hint">导出期间可以继续看地图；区域较多时需要一点时间。</div>
        </div>
      )}

      {result && (
        <div className="map-export-result">
          <div className="detect-name">
            已导出 {result.files.length} 张图
            {result.failures > 0 ? `，${result.failures} 个区域读取失败` : ''}
          </div>
          {result.files.map((f) => (
            <div key={f.path} className="map-export-file">
              <Icon name="map" size={14} />
              <span className="map-export-path" title={f.path}>
                {f.path}
              </span>
              <span className="map-export-meta">
                {f.width}×{f.height} · {f.regions} 区域
              </span>
            </div>
          ))}
          <div className="hint" style={{ marginTop: 8 }}>
            共 {result.components} 个连通块，用时 {(result.ms / 1000).toFixed(1)} 秒。
          </div>
        </div>
      )}
    </Modal>
  )
}
