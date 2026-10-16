import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { run } from './java'
import type { PythonInfo } from '../shared/types'

/**
 * Python 环境与 MCDReforged。
 *
 * MCDReforged 是个 Python 程序，不是 jar：装它 = 装 Python + 用 pip 装 mcdreforged，
 * 启动它 = `python -X utf8 -m mcdreforged`。所以 CraftDesk 这边要做三件事：
 * 找到 Python、问出 mcdreforged 装了没、需要的时候用 pip 装上。
 *
 * 版本要求：MCDR 2.x 要 Python 3.8+（3.6/3.7 只能跑 1.x，早就不维护了）。
 */

const MCDR_MIN_MINOR = 8 // Python 3.8+

/** 一条 python 命令能跑通并报出自己的版本与 mcdreforged 状态 */
const PROBE = [
  'import json,sys',
  'info={"version":"%d.%d.%d"%sys.version_info[:3],"major":sys.version_info[0],"minor":sys.version_info[1]}',
  'try:',
  '    from importlib.metadata import version',
  '    info["mcdr"]=version("mcdreforged")',
  'except Exception:',
  '    info["mcdr"]=None',
  'print(json.dumps(info))'
].join('\n')

async function probeWith(cmd: string, args: string[]): Promise<PythonInfo | null> {
  const res = await run(cmd, [...args, '-c', PROBE], { timeout: 15000 })
  if (res.code !== 0) return null
  const line = res.stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'))
  if (!line) return null
  try {
    const info = JSON.parse(line) as { version: string; major: number; minor: number; mcdr: string | null }
    const ok = info.major === 3 && info.minor >= MCDR_MIN_MINOR
    return {
      path: cmd,
      version: info.version,
      major: info.major,
      minor: info.minor,
      mcdr: info.mcdr,
      // 太老的 Python 能跑，但 MCDR 装不上去，界面要能区分这两件事
      suitable: ok,
      valid: true
    }
  } catch {
    return null
  }
}

/**
 * 找机器上的 Python。
 *
 * 顺序有讲究：先问 py 启动器（它知道所有装在标准位置的 Python），
 * 再看 PATH，最后扫安装目录。同一个解释器可能被多条路径指到，
 * 所以按真实路径去重（python.exe 和它的软链接会给出不同写法，
 * 这里就宽松一点，按字符串去重即可）。
 */
export async function detectPython(): Promise<PythonInfo[]> {
  const candidates: { cmd: string; args: string[] }[] = []

  // 1) Windows 的 py 启动器：`py -0p` 会列出所有版本和路径
  const list = await run('py', ['-0p'], { timeout: 10000 })
  if (list.code === 0) {
    for (const line of list.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*-V:(\S+)\s+\*?\s*(.+?)\s*$/)
      if (m) candidates.push({ cmd: m[2].trim(), args: [] })
    }
  }

  // 2) PATH 里的 python / python3
  for (const name of ['python', 'python3']) {
    const which = await run('where', [name], { timeout: 8000 })
    if (which.code !== 0) continue
    for (const p of which.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      candidates.push({ cmd: p, args: [] })
    }
  }

  // 3) 常见安装目录
  const roots = [
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'Python'),
    'C:\\Python313',
    'C:\\Python312',
    'C:\\Python311',
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Python313'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Python312')
  ]
  for (const root of roots) {
    let entries: string[]
    try {
      entries = await fs.readdir(root)
    } catch {
      continue
    }
    for (const e of entries) {
      const exe = join(root, e, 'python.exe')
      if (existsSync(exe)) candidates.push({ cmd: exe, args: [] })
    }
    const direct = join(root, 'python.exe')
    if (existsSync(direct)) candidates.push({ cmd: direct, args: [] })
  }

  const seen = new Set<string>()
  const out: PythonInfo[] = []
  for (const c of candidates) {
    const key = c.cmd.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const info = await probeWith(c.cmd, c.args)
    if (info) out.push(info)
  }

  // 能装 MCDR 的排前面，同档按版本号从高到低
  out.sort((a, b) => {
    if (a.suitable !== b.suitable) return a.suitable ? -1 : 1
    return b.minor - a.minor || b.major - a.major
  })
  return out
}

/** 单独问一个解释器（用户在设置里手动指定时用） */
export async function probePython(path: string): Promise<PythonInfo | null> {
  return probeWith(path, [])
}

/** 装 / 升级 mcdreforged，输出边走边回调（pip 拉包挺慢的） */
export async function installMcdr(
  pythonPath: string,
  onLine?: (line: string) => void
): Promise<void> {
  const res = await run(
    pythonPath,
    ['-m', 'pip', 'install', '--upgrade', 'mcdreforged'],
    { timeout: 10 * 60 * 1000, onChunk: onLine }
  )
  if (res.code !== 0) {
    const tail = `${res.stderr}\n${res.stdout}`.trim().split(/\r?\n/).slice(-3).join(' ')
    throw new Error(
      res.stderr.includes('No module named pip')
        ? '这个 Python 没有带 pip。用官方安装包装一次（勾上 pip），或者执行 python -m ensurepip 之后再试。'
        : `pip 退出码 ${res.code}：${tail}`
    )
  }
}

/** MCDR 能不能用：Python 够新 + mcdreforged 装了 */
export function mcdrReady(info: PythonInfo | null): { ok: boolean; reason?: string } {
  if (!info) return { ok: false, reason: '没有找到 Python' }
  if (!info.suitable) {
    return { ok: false, reason: `MCDReforged 需要 Python 3.${MCDR_MIN_MINOR} 及以上，这个是 ${info.version}` }
  }
  if (!info.mcdr) return { ok: false, reason: '这个 Python 里没有装 mcdreforged' }
  return { ok: true }
}
