/**
 * 验证服务器图标：解析、文件名安全、导入 / 清理。
 *
 * 这里有几件「不测就一定会出事」的事：
 * - 图标字符串是存在配置文件里的，用户能手改，所以 `file:../../x` 这种
 *   必须被挡住，不能变成读任意文件的入口；
 * - 图片是复制进配置目录的，换图之后旧文件要清掉，否则 icons/ 会越用越大；
 * - 表情的码点长度（🌲 是 2 个）算错了会把表情截成一个方框。
 *
 * npx esbuild scripts/test-server-icon.ts --bundle --platform=node --format=cjs \
 *   --outfile=tmp/test-server-icon.cjs && node tmp/test-server-icon.cjs
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ICON_EMOJIS,
  ICON_TEXT_MAX,
  iconFileName,
  iconNamePrefix,
  isSafeIconName,
  normalizeIconText,
  parseIcon,
  textIcon,
  fileIcon
} from '../src/shared/serverIcon'
import {
  iconAbsPath,
  iconsDir,
  importIcon,
  readIcon,
  removeIcon,
  removeOtherIcons
} from '../src/main/icons'
import { MAX_IMAGE_BYTES, readImageDataUrl, validateImage } from '../src/main/images'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = ''): void {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (err) {
    return (err as Error).message
  }
}

const ROOT = resolve('.')
const USER_DATA = join(ROOT, 'tmp', 'icon-test-userdata')
const SRC_DIR = join(ROOT, 'tmp', 'icon-test-src')

/** 1×1 的透明 PNG，够用来跑真实的复制 / 读取流程 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

async function setup(): Promise<void> {
  await fs.rm(USER_DATA, { recursive: true, force: true })
  await fs.rm(SRC_DIR, { recursive: true, force: true })
  await fs.mkdir(USER_DATA, { recursive: true })
  await fs.mkdir(SRC_DIR, { recursive: true })
  await fs.writeFile(join(SRC_DIR, 'a.png'), PNG_1X1)
  await fs.writeFile(join(SRC_DIR, 'b.jpg'), PNG_1X1)
  await fs.writeFile(join(SRC_DIR, 'empty.png'), Buffer.alloc(0))
  await fs.writeFile(join(SRC_DIR, 'note.txt'), 'not an image')
  await fs.writeFile(join(SRC_DIR, 'huge.png'), '')
  await fs.truncate(join(SRC_DIR, 'huge.png'), MAX_IMAGE_BYTES + 1)
  // 名字看着像图片、其实是目录：扩展名那一关过得去，得靠 isFile() 拦住
  await fs.mkdir(join(SRC_DIR, 'folder.png'), { recursive: true })
}

// ---------------------------------------------------------------- 解析

console.log('图标字符串解析：')
check('空串 = 默认缩写', parseIcon('').kind === 'initials')
check('undefined / null 也不炸', parseIcon(undefined).kind === 'initials' && parseIcon(null).kind === 'initials')
check('只有空白 = 默认缩写', parseIcon('   ').kind === 'initials')
check(
  'text: 解析成文字',
  (() => {
    const s = parseIcon('text:⛏')
    return s.kind === 'text' && s.text === '⛏'
  })()
)
check(
  '文字前后的空格会去掉',
  (() => {
    const s = parseIcon('text:  🌲  ')
    return s.kind === 'text' && s.text === '🌲'
  })()
)
check('text: 后面是空的 → 回到缩写', parseIcon('text:').kind === 'initials')
check(
  '超长文字截断到上限',
  (() => {
    const s = parseIcon('text:ABCDEF')
    return s.kind === 'text' && s.text === 'AB'
  })()
)
check(
  'surrogate pair 的表情不会被截坏',
  Array.from(normalizeIconText('🌲🔥🐷')).length === ICON_TEXT_MAX
)
check(
  'file: 解析成图片',
  (() => {
    const s = parseIcon('file:abc-123.png')
    return s.kind === 'image' && s.name === 'abc-123.png'
  })()
)
check('认不出的一律当缩写', parseIcon('emoji:🔥').kind === 'initials')
check('随便一个字符串当缩写', parseIcon('https://example.com/a.png').kind === 'initials')
check('file: 后面是空的 → 缩写', parseIcon('file:').kind === 'initials')

console.log('\n文件名安全（会被拼进目录，必须挡住穿越）：')
check('普通文件名放行', isSafeIconName('abc-123.png'))
check('空名字不放行', !isSafeIconName(''))
check('.. 不放行', !isSafeIconName('..') && !isSafeIconName('a..b.png'))
check('正斜杠不放行', !isSafeIconName('a/b.png'))
check('反斜杠不放行', !isSafeIconName('a\\b.png'))
check('向上跳不放行', !isSafeIconName('../craftdesk.json'))
check('盘符 / 冒号不放行', !isSafeIconName('C:evil.png'))
check('通配符不放行', !isSafeIconName('a*.png'))
check('超长名字不放行', !isSafeIconName('x'.repeat(200)))
check(
  '穿越型 file: 会被解析成缩写而不是路径',
  parseIcon('file:../../craftdesk.json').kind === 'initials'
)
check(
  'iconAbsPath 对非法名字直接抛错',
  throws(() => iconAbsPath(USER_DATA, '../craftdesk.json'))
)

console.log('\n存取用的字符串：')
check('textIcon 有内容才带前缀', textIcon('⛏') === 'text:⛏' && textIcon('   ') === '')
check('fileIcon 收非法名字时给空串', fileIcon('..') === '' && fileIcon('a.png') === 'file:a.png')
check('存进去再读出来还是原来那个', parseIcon(textIcon('⚙')).kind === 'text')
check(
  '图标文件名固定成 <服务器id>.<扩展名>',
  iconFileName('abc-123', '.png') === 'abc-123.png' &&
    iconFileName('ABC', 'PNG') === 'abc.png' &&
    iconFileName('', '.png') === 'server.png'
)
check('id 里的怪字符会被清掉', iconFileName('a/b:c', '.png') === 'abc.png')
check('前缀就是清理后的 id + 点', iconNamePrefix('a/b:c') === 'abc.')

console.log('\n表情备选：')
check('备选表非空且没有重复', ICON_EMOJIS.length >= 20 && new Set(ICON_EMOJIS).size === ICON_EMOJIS.length)
check(
  '每个表情都在长度上限之内（否则头像上会显示成半个）',
  ICON_EMOJIS.every((e) => Array.from(e).length <= ICON_TEXT_MAX),
  ICON_EMOJIS.filter((e) => Array.from(e).length > ICON_TEXT_MAX).join(',') || '全部合格'
)
check(
  '每个表情存成图标串之后还能原样读回来',
  ICON_EMOJIS.every((e) => {
    const spec = parseIcon(textIcon(e))
    return spec.kind === 'text' && spec.text === e
  })
)

// ---------------------------------------------------------------- 导入与清理

/** 需要读写文件的部分包在 async 里：esbuild 打包成 cjs 时不支持顶层 await */
async function main(): Promise<void> {
  await setup()

  console.log('\n导入图片：')
  const first = await importIcon(USER_DATA, 'srv-1', join(SRC_DIR, 'a.png'))
  check('返回的文件名是 <服务器id>.png', first.name === 'srv-1.png', first.name)
  check('字节数和源文件一致', first.bytes === PNG_1X1.byteLength, String(first.bytes))
  check('文件真的落在 icons/ 下了', await fs.stat(join(iconsDir(USER_DATA), 'srv-1.png')).then(() => true))
  check(
    '内容与源文件逐字节相同',
    (await fs.readFile(join(iconsDir(USER_DATA), 'srv-1.png'))).equals(PNG_1X1)
  )
  check('存进配置的字符串能被解析回来', parseIcon(fileIcon(first.name)).kind === 'image')

  const second = await importIcon(USER_DATA, 'srv-1', join(SRC_DIR, 'b.jpg'))
  check('换一种格式：文件名跟着扩展名变', second.name === 'srv-1.jpg', second.name)
  check(
    '换图之后旧文件被清掉，一台服务器只留一个图标',
    (await fs.readdir(iconsDir(USER_DATA))).filter((n) => n.startsWith('srv-1.')).length === 1,
    (await fs.readdir(iconsDir(USER_DATA))).join(',')
  )

  const other = await importIcon(USER_DATA, 'srv-2', join(SRC_DIR, 'a.png'))
  check('另一台服务器的图标不会互相覆盖', other.name === 'srv-2.png')
  check(
    '两台服务器各自有一份',
    (await fs.readdir(iconsDir(USER_DATA))).length === 2,
    (await fs.readdir(iconsDir(USER_DATA))).join(',')
  )
  check('删掉其中一个不影响另一个', (await removeIcon(USER_DATA, 'srv-2.png')) === true)
  check(
    '删过之后目录里只剩另一台服务器的',
    (await fs.readdir(iconsDir(USER_DATA))).join(',') === 'srv-1.jpg'
  )

  console.log('\n读回来：')
  const read = await readIcon(USER_DATA, 'srv-1.jpg')
  check('读成 data URL', read.dataUrl.startsWith('data:image/jpeg;base64,') && read.bytes === PNG_1X1.byteLength)
  check('名字非法时读不了（不会跳出 icons/）', typeof (await rejects(() => readIcon(USER_DATA, '../craftdesk.json'))) === 'string')
  check('文件不存在时给的是「找不到」', (await rejects(() => readIcon(USER_DATA, 'nope.png'))) === '找不到这个文件')

  console.log('\n坏输入：')
  check(
    '不支持的格式当场拒绝',
    ((await rejects(() => importIcon(USER_DATA, 'srv-3', join(SRC_DIR, 'note.txt')))) ?? '').includes(
      '不支持的图片格式'
    )
  )
  check(
    '空文件拒绝',
    ((await rejects(() => importIcon(USER_DATA, 'srv-3', join(SRC_DIR, 'empty.png')))) ?? '').includes('空的')
  )
  check(
    `超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 拒绝`,
    ((await rejects(() => importIcon(USER_DATA, 'srv-3', join(SRC_DIR, 'huge.png')))) ?? '').includes('太大')
  )
  check(
    '源文件不存在时给的是「找不到」',
    ((await rejects(() => importIcon(USER_DATA, 'srv-3', join(SRC_DIR, 'nope.png')))) ?? '').includes(
      '找不到'
    )
  )
  check(
    '名字像图片但是目录时拒绝',
    ((await rejects(() => importIcon(USER_DATA, 'srv-3', join(SRC_DIR, 'folder.png')))) ?? '').includes(
      '不是文件'
    )
  )
  check(
    '没有扩展名的目录拒绝（先卡在格式这一关）',
    ((await rejects(() => importIcon(USER_DATA, 'srv-3', SRC_DIR))) ?? '').includes('不支持的图片格式')
  )
  check(
    '被拒绝的导入没有留下任何文件',
    (await fs.readdir(iconsDir(USER_DATA))).every((n) => n.startsWith('srv-1.')),
    (await fs.readdir(iconsDir(USER_DATA))).join(',')
  )

  console.log('\n校验本身：')
  const meta = await validateImage(join(SRC_DIR, 'a.png'))
  check('给出 mime 与扩展名', meta.type === 'image/png' && meta.ext === '.png')
  check('背景图读的是同一份校验', (await readImageDataUrl(join(SRC_DIR, 'a.png'))).dataUrl.startsWith('data:image/png;base64,'))

  console.log('\n清理：')
  const leftovers = await removeOtherIcons(USER_DATA, 'srv-1')
  check('清掉这台服务器的全部图标', leftovers.length === 1 && leftovers[0] === 'srv-1.jpg')
  check('不碰别的服务器的文件', (await fs.readdir(iconsDir(USER_DATA))).length === 0)
  check('目录不存在时也不报错', (await removeOtherIcons(join(USER_DATA, 'nope'), 'srv-1')).length === 0)

  await fs.rm(USER_DATA, { recursive: true, force: true })
  await fs.rm(SRC_DIR, { recursive: true, force: true })

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

void main()
