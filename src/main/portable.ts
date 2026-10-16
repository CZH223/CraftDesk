import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 数据目录放哪。
 *
 * 便携版（`CraftDesk.exe` 单文件）的期望是「拷到哪都能跑」：
 * 配置、服务器图标这些跟着 exe 走，插到 U 盘上换台机器打开还是同一份列表。
 * 所以优先用 exe 旁边的 `data\`。
 *
 * 但放在 `C:\Program Files` 这类目录里是写不进去的，
 * 那时候必须安静地退回系统的 `%APPDATA%\CraftDesk` —— 不能因为一个路径选择
 * 就让整个程序起不来。判断方式是实际写一个探针文件，而不是猜权限。
 */

export interface DataDirChoice {
  dir: string
  /** 是否在用「exe 旁边的 data」这种便携布局 */
  portable: boolean
  /** 一句话说明为什么选了这个目录，界面上直接显示 */
  reason: string
}

/** 往目录里写一个探针文件，确认真的能写 */
export function canWrite(dir: string): boolean {
  if (!dir) return false
  const probe = join(dir, '.craftdesk-write-test')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 按顺序挑第一个能写的候选目录，都不行就用系统目录。
 *
 * 候选由调用方给（见 index.ts）：便携版的解压目录、exe 所在目录……
 * 这里只做「挑一个」的判断，不碰 electron，方便单独测。
 */
export function pickDataDir(
  candidates: (string | null | undefined)[],
  fallback: string,
  writable: (dir: string) => boolean = canWrite
): DataDirChoice {
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate) continue
    const dir = join(candidate)
    if (seen.has(dir) || dir === fallback) continue
    seen.add(dir)
    if (writable(dir)) {
      return {
        dir,
        portable: true,
        reason: '便携模式：配置与图标就放在 exe 旁边，拷走整个文件夹即可'
      }
    }
  }
  return {
    dir: fallback,
    portable: false,
    reason: '配置放在系统的用户目录（exe 所在位置不可写）'
  }
}

/** exe 同级的 data 目录 */
export function dataDirNextTo(exePath: string): string {
  return join(dirname(exePath), 'data')
}
