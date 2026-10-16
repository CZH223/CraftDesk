import type { AppSettings } from '../../shared/types'

/**
 * 界面尺寸与背景的取值规则。
 *
 * 抽成纯函数是因为这些边界条件（拖到负数、拖出屏幕、存量配置里没有这些字段）
 * 全都不好手动验证，但算错了会直接让界面坏掉 —— 右侧面板拖没了、
 * 背景图把整个界面盖住，都是「看一眼截图也未必发现」的问题。
 */

/**
 * 两条分栏线各自的取值范围（px）。
 *
 * 下限不是「再小一点也能看」，是「再小就坏了」：右侧面板收到 300 出头时，
 * 文件 / 玩家 / 扩展 那一排标签就开始竖着折行；左侧列表再窄，
 * 服务器名字和版本号会挤成一团。上限则受窗口宽度约束（见 fitWidths）。
 */
export const WIDTH_LIMITS = {
  side: { min: 240, max: 620 },
  panel: { min: 320, max: 900 }
} as const

export const DEFAULT_UI = {
  sideWidth: 300,
  panelWidth: 360,
  backgroundImage: '',
  backgroundOpacity: 1,
  surfaceOpacity: 0.86
} as const

export type WidthKind = keyof typeof WIDTH_LIMITS

/** 把宽度夹到合理区间。拖拽、手输、旧配置都从这里过一道 */
export function clampWidth(kind: WidthKind, px: number): number {
  const { min, max } = WIDTH_LIMITS[kind]
  if (!Number.isFinite(px)) return kind === 'side' ? DEFAULT_UI.sideWidth : DEFAULT_UI.panelWidth
  return Math.round(Math.min(max, Math.max(min, px)))
}

/** 左侧图标栏是固定宽度，算可用空间时要先扣掉 */
export const RAIL_W = 62

/**
 * 中间工作区至少留这么宽。比这更窄的话，控制台一行日志都显示不下几个字，
 * 与其让用户拖出这样的布局，不如让两侧自动收一点。
 */
export const MIN_MAIN_W = 420

/**
 * 窗口不够宽时按比例收两侧。
 *
 * 先动右侧面板、再动左侧列表 —— 列表是「去哪台服务器」的入口，
 * 挤到看不清反而更碍事；右侧面板的内容（文件树、玩家）本来就是可以滚动的。
 * 收到各自的最小值还不够就随它去（窗口已经小于 762px 了，怎么排都不好看）。
 */
export function fitWidths(
  side: number,
  panel: number,
  viewport: number | null
): { side: number; panel: number } {
  // 先各自夹一道：这个函数的返回值会被直接写进 CSS，NaN 混进去会让整栏消失
  let nextSide = clampWidth('side', side)
  let nextPanel = clampWidth('panel', panel)
  if (!viewport || !Number.isFinite(viewport) || viewport <= 0) {
    return { side: nextSide, panel: nextPanel }
  }
  const budget = viewport - RAIL_W - MIN_MAIN_W
  let over = nextSide + nextPanel - budget
  if (over > 0) {
    const take = Math.min(over, nextPanel - WIDTH_LIMITS.panel.min)
    nextPanel -= take
    over -= take
  }
  if (over > 0) {
    const take = Math.min(over, nextSide - WIDTH_LIMITS.side.min)
    nextSide -= take
    over -= take
  }
  return { side: nextSide, panel: nextPanel }
}

/** 不透明度统一按 0~1 处理，界面上的 0~100 到这儿再除 */
export function clampOpacity(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.min(1, Math.max(0, v))
}

export interface UiStyle {
  /** 直接塞进 style 的 CSS 变量 */
  vars: Record<string, string>
  /** 是否启用自定义背景（启用时面板会变半透明） */
  hasBackground: boolean
  /** 背景图层的样式；没有背景时为 null */
  background: { image: string; opacity: number } | null
}

/**
 * 把设置换算成可以直接用的样式。
 *
 * 注意 `backgroundImage` 存的是**文件路径**，不是 data URL ——
 * 图片内容由主进程读成 data URL 单独传过来（见 App.tsx），
 * 这样配置文件里不会塞进几 MB 的 base64。
 */
export function uiStyle(
  settings: AppSettings | null,
  backgroundUrl: string | null,
  viewportWidth: number | null = null
): UiStyle {
  const fitted = fitWidths(
    clampWidth('side', settings?.sideWidth ?? DEFAULT_UI.sideWidth),
    clampWidth('panel', settings?.panelWidth ?? DEFAULT_UI.panelWidth),
    viewportWidth
  )
  const sideWidth = fitted.side
  const panelWidth = fitted.panel

  const path = settings?.backgroundImage?.trim() ?? ''
  const hasBackground = Boolean(path && backgroundUrl)
  const backgroundOpacity = clampOpacity(
    settings?.backgroundOpacity ?? DEFAULT_UI.backgroundOpacity,
    DEFAULT_UI.backgroundOpacity
  )
  const surfaceOpacity = clampOpacity(
    settings?.surfaceOpacity ?? DEFAULT_UI.surfaceOpacity,
    DEFAULT_UI.surfaceOpacity
  )

  return {
    vars: {
      '--side-w': `${sideWidth}px`,
      '--panel-w': `${panelWidth}px`,
      '--surface-alpha': String(surfaceOpacity)
    },
    hasBackground,
    background: hasBackground && backgroundUrl ? { image: backgroundUrl, opacity: backgroundOpacity } : null
  }
}
