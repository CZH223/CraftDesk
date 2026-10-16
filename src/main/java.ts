import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { JavaInfo } from '../shared/types'

/** 执行一个命令并收集输出（不弹窗） */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; onChunk?: (text: string) => void } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, opts.timeout ?? 15000)

    // 安装器 / pip 要跑好几分钟，光等结束用户会以为卡死了
    child.stdout?.on('data', (d) => {
      const text = d.toString('utf-8')
      stdout += text
      opts.onChunk?.(text)
    })
    child.stderr?.on('data', (d) => {
      const text = d.toString('utf-8')
      stderr += text
      opts.onChunk?.(text)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** 读取 java -version 的输出来判断版本 */
export async function probeJava(path: string): Promise<JavaInfo> {
  const info: JavaInfo = { path, version: '', major: 0, vendor: '', valid: false }
  if (!path || !existsSync(path)) return info

  const res = await run(path, ['-XshowSettings:properties', '-version'], { timeout: 12000 })
  const out = `${res.stderr}\n${res.stdout}`

  const versionMatch = out.match(/java\.version\s*=\s*(\S+)/) || out.match(/version "([^"]+)"/)
  if (versionMatch) info.version = versionMatch[1]

  const vendorMatch = out.match(/java\.vendor\s*=\s*(.+)/)
  if (vendorMatch) info.vendor = vendorMatch[1].trim()

  const majorMatch = info.version.match(/^(\d+)(?:\.(\d+))?/)
  if (majorMatch) {
    const first = Number(majorMatch[1])
    // 1.8.0_xxx 这种老式版本号
    info.major = first === 1 && majorMatch[2] ? Number(majorMatch[2]) : first
  }
  info.valid = res.code === 0 || !!info.version
  return info
}

/** 在常见位置搜索 java.exe */
export async function detectJava(): Promise<JavaInfo[]> {
  const candidates = new Set<string>()

  // 1) PATH 里的 java
  const which = await run('where', ['java'])
  if (which.code === 0) {
    which.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((p) => candidates.add(p))
  }

  // 2) JAVA_HOME
  if (process.env.JAVA_HOME) {
    candidates.add(join(process.env.JAVA_HOME, 'bin', 'java.exe'))
  }

  // 3) 常见安装目录
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft\\jdk',
    'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files (x86)\\Java',
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'Eclipse Adoptium')
  ]

  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const exe = join(root, e.name, 'bin', 'java.exe')
        if (existsSync(exe)) candidates.add(exe)
      }
    } catch {
      // 目录不存在，跳过
    }
  }

  /*
   * 4) 启动器自带的运行时。
   *
   * 「我明明装了 Java 25，怎么还说没有」的答案通常在这里：Minecraft 启动器
   * 按需下载的运行时放在 .minecraft/runtime/<名字>/ 下面，名字看不出大版本
   * （java-runtime-epsilon 是 25），也没进 PATH。新版服务端（26.1+）要的
   * 就是 Java 25，不扫这里就等于没有。
   */
  const launcherRoots = [
    join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), '.minecraft', 'runtime'),
    // 第三方启动器惯用的位置
    join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'PCL'),
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'HMCL', 'java')
  ]

  for (const root of launcherRoots) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      for (const exe of [
        join(root, e.name, 'bin', 'java.exe'),
        join(root, e.name, 'java.exe')
      ]) {
        if (existsSync(exe)) candidates.add(exe)
      }
    }
  }

  const results: JavaInfo[] = []
  for (const path of candidates) {
    const info = await probeJava(path)
    if (info.valid) results.push(info)
  }

  // 高版本排前面
  results.sort((a, b) => b.major - a.major)
  return results
}

export { requiredJavaMajor, javaHintText } from '../shared/javaHint'
