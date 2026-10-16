/**
 * 验证界面尺寸与背景的取值规则（uiPrefs.ts）。
 *
 * 这些东西全都是「看一眼截图也未必发现」的问题：
 * 宽度拖到负数会让右侧面板消失、背景图路径写成 data URL 会让配置文件
 * 涨到几 MB、窗口变窄时两侧不收会把中间工作区挤成一条缝。
 * 布局算错了肉眼要试半天，断言它只要一行。
 *
 * npx esbuild scripts/test-ui-prefs.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-ui-prefs.cjs && node tmp/test-ui-prefs.cjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_UI,
  MIN_MAIN_W,
  RAIL_W,
  WIDTH_LIMITS,
  clampOpacity,
  clampWidth,
  fitWidths,
  uiStyle
} from '../src/renderer/src/uiPrefs'
import type { AppSettings } from '../src/shared/types'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    javaPath: '',
    javaList: [],
    pythonPath: '',
    pythonList: [],
    defaultMemoryMin: 1024,
    defaultMemoryMax: 4096,
    defaultJvmArgs: '',
    closeToTray: true,
    stopOnExit: true,
    maxLogLines: 4000,
    curseforgeApiKey: '',
    theme: 'dark',
    ...DEFAULT_UI,
    ...patch
  }
}

// ---------------------------------------------------------------- 宽度夹取

console.log('宽度夹取：')
check('下限', clampWidth('side', 10) === WIDTH_LIMITS.side.min)
check('上限', clampWidth('panel', 99999) === WIDTH_LIMITS.panel.max)
check('正常值原样通过', clampWidth('side', 420) === 420)
check('四舍五入到整数像素', clampWidth('side', 420.6) === 421)
check('NaN 回落到默认值', clampWidth('side', NaN) === DEFAULT_UI.sideWidth)
check('Infinity 回落到默认值', clampWidth('panel', Infinity) === DEFAULT_UI.panelWidth)
check('负无穷也一样', clampWidth('side', -Infinity) === DEFAULT_UI.sideWidth)
check(
  '两侧互不影响（同一个数字，两种结果）',
  clampWidth('side', 700) === WIDTH_LIMITS.side.max &&
    clampWidth('panel', 700) === 700,
  `${clampWidth('side', 700)} / ${clampWidth('panel', 700)}`
)

// ---------------------------------------------------------------- 不透明度

console.log('\n不透明度：')
check('负值压到 0', clampOpacity(-1, 0.86) === 0)
check('大于 1 压到 1', clampOpacity(1.4, 0.86) === 1)
check('中间值原样', clampOpacity(0.5, 0.86) === 0.5)
check('NaN 用兜底值', clampOpacity(NaN, 0.42) === 0.42)
check('边界 0 和 1 合法', clampOpacity(0, 0.5) === 0 && clampOpacity(1, 0.5) === 1)

// ---------------------------------------------------------------- 样式换算

console.log('\n样式换算：')
const plain = uiStyle(settings(), null)
check('两个宽度变量都给了 px 值', plain.vars['--side-w'] === '300px' && plain.vars['--panel-w'] === '360px',
  `${plain.vars['--side-w']} / ${plain.vars['--panel-w']}`)
check('没背景图时不加 has-bg', plain.hasBackground === false && plain.background === null)
check('设置整个为 null 也不炸', uiStyle(null, null).vars['--side-w'] === '300px')

const withPath = uiStyle(settings({ backgroundImage: 'C:\\pics\\a.png' }), null)
check(
  '存了路径但图片还没读出来时不算有背景',
  withPath.hasBackground === false && withPath.background === null
)

const withImage = uiStyle(settings({ backgroundImage: 'C:\\pics\\a.png' }), 'data:image/png;base64,AAA')
check('路径 + data URL 才算有背景', withImage.hasBackground === true)
check(
  '背景图层用的是 data URL，不是文件路径',
  withImage.background?.image.startsWith('data:image/') === true
)
check(
  '背景不透明度传进图层',
  uiStyle(settings({ backgroundImage: 'a.png', backgroundOpacity: 0.4 }), 'data:image/png;base64,AAA')
    .background?.opacity === 0.4
)
check(
  '界面不透明度进 --surface-alpha',
  uiStyle(settings({ surfaceOpacity: 0.5 }), null).vars['--surface-alpha'] === '0.5'
)
check(
  '越界的不透明度会被夹住',
  uiStyle(settings({ surfaceOpacity: 9 }), null).vars['--surface-alpha'] === '1' &&
    uiStyle(settings({ backgroundImage: 'a.png', backgroundOpacity: -3 }), 'data:image/png;base64,AAA')
      .background?.opacity === 0
)
check(
  '存量配置里没有这些字段时用默认值',
  uiStyle({ ...settings(), sideWidth: undefined as unknown as number }, null).vars['--side-w'] ===
    `${DEFAULT_UI.sideWidth}px`
)

// ---------------------------------------------------------------- 窗口适配

console.log('\n窗口空间不够时自动收窄：')
const wide = fitWidths(300, 360, 1920)
check('宽窗口不动', wide.side === 300 && wide.panel === 360)
const nullViewport = fitWidths(300, 360, null)
check('拿不到窗口宽度时不动', nullViewport.side === 300 && nullViewport.panel === 360)

// 1280 窗口：62(图标栏) + 300 + 360 + 420 = 1142 < 1280，装得下
const fits = fitWidths(300, 360, 1280)
check('1280 窗口下原样', fits.side === 300 && fits.panel === 360, `${fits.side}/${fits.panel}`)

// 1500 窗口：可用 1500-62-420 = 1018，两侧共要 1200，差的 182 全让右侧面板出
const panelFirst = fitWidths(300, 900, 1500)
check(
  '空间不够时先收右侧面板，左侧列表不动',
  panelFirst.side === 300 && panelFirst.panel === 718,
  `${panelFirst.side}/${panelFirst.panel}`
)
check(
  '收完之后总占用正好卡进预算',
  panelFirst.side + panelFirst.panel <= 1500 - RAIL_W - MIN_MAIN_W,
  `${panelFirst.side + panelFirst.panel} <= ${1500 - RAIL_W - MIN_MAIN_W}`
)

// 1000 窗口：面板收到下限后还差，就该动左侧列表了
const tighter = fitWidths(620, 900, 1000)
check(
  '右侧到下限后开始收左侧',
  tighter.panel === WIDTH_LIMITS.panel.min && tighter.side < 620,
  `${tighter.side}/${tighter.panel}`
)

// 窗口小到两条最小值都放不下：不应该再往下压，否则会出现负数宽度
const extreme = fitWidths(620, 900, 700)
// 窗口最小 1080（BrowserWindow.minWidth）：两条最小值加中间工作区得塞得下
check(
  '窗口收到最小时，两侧的最小值仍然放得下',
  WIDTH_LIMITS.side.min + WIDTH_LIMITS.panel.min <= 1080 - RAIL_W - MIN_MAIN_W,
  `${WIDTH_LIMITS.side.min} + ${WIDTH_LIMITS.panel.min} <= ${1080 - RAIL_W - MIN_MAIN_W}`
)
check(
  '最小值是硬底线，不会压成负数或 0',
  extreme.side >= WIDTH_LIMITS.side.min && extreme.panel >= WIDTH_LIMITS.panel.min,
  `${extreme.side}/${extreme.panel}`
)

// 适配结果必须仍然是合法宽度，否则会被原样写进 CSS
const messy = fitWidths(NaN, Infinity, 1000)
check(
  '非法输入经过 fitWidths 之后仍然合法',
  Number.isFinite(messy.side) && Number.isFinite(messy.panel) && messy.side > 0 && messy.panel > 0,
  `${messy.side}/${messy.panel}`
)

check(
  'uiStyle 会把窗口宽度一路传到 CSS 变量上',
  uiStyle(settings({ sideWidth: 620, panelWidth: 900 }), null, 900).vars['--panel-w'] ===
    `${WIDTH_LIMITS.panel.min}px`,
  uiStyle(settings({ sideWidth: 620, panelWidth: 900 }), null, 900).vars['--panel-w']
)

// ---------------------------------------------------------------- 与主进程默认值一致
//
// 主进程的 DEFAULT_SETTINGS 和这里的 DEFAULT_UI 是两份字面量。
// 两边不一致的话，用户「恢复默认」得到的宽度和首次启动时的不一样，
// 而这种偏差很难在使用中发现。读文件比导入整个 store.ts 稳（那边依赖 electron）。
const storeSrc = readFileSync(resolve('src/main/store.ts'), 'utf-8')
check(
  'store.ts 里的 sideWidth 与 DEFAULT_UI 一致',
  new RegExp(`sideWidth:\\s*${DEFAULT_UI.sideWidth}\\b`).test(storeSrc),
  `期望 sideWidth: ${DEFAULT_UI.sideWidth}`
)
check(
  'store.ts 里的 panelWidth 与 DEFAULT_UI 一致',
  new RegExp(`panelWidth:\\s*${DEFAULT_UI.panelWidth}\\b`).test(storeSrc),
  `期望 panelWidth: ${DEFAULT_UI.panelWidth}`
)
check(
  'store.ts 里的 surfaceOpacity 与 DEFAULT_UI 一致',
  new RegExp(`surfaceOpacity:\\s*${DEFAULT_UI.surfaceOpacity}\\b`).test(storeSrc)
)

const css = readFileSync(resolve('src/renderer/src/styles/global.css'), 'utf-8')
check('样式里有背景图层 .app-bg', /\.app-bg\s*\{/.test(css))
// 这两条是兜底值，和 uiPrefs 对不上的话，启动画面会和正式界面差一截
check(
  'CSS 兜底的 --panel-w 与 DEFAULT_UI 一致',
  new RegExp(`--panel-w:\\s*${DEFAULT_UI.panelWidth}px`).test(css)
)
// 左侧分栏线的位置是 calc(var(--rail-w) + var(--side-w) - 3px)，
// 图标栏宽度两边对不上，那条线就会画偏
check(
  'CSS 的 --rail-w 与 RAIL_W 一致',
  new RegExp(`--rail-w:\\s*${RAIL_W}px`).test(css),
  `期望 ${RAIL_W}px`
)
check('分栏线有左右两个位置', /\.resizer-side\s*\{/.test(css) && /\.resizer-panel\s*\{/.test(css))
check(
  '背景图打开时面板转半透明，且不透明度由 --surface-alpha 控制',
  /\.app\.has-bg[\s\S]{0,400}--surface-alpha/.test(css)
)

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
