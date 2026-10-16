import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { iconFileName, iconNamePrefix, isSafeIconName } from '../shared/serverIcon'
import { readImageDataUrl, validateImage } from './images'

/**
 * 服务器图标的存放。
 *
 * 用户选的图片会被**复制**进配置目录下的 `icons/`，配置里只记文件名。
 * 复制而不是记原路径，是因为原图随时可能被挪走、改名或者删掉 ——
 * 那时候图标就该还留在原地，而不是变成一个破图。
 *
 * 所有函数都显式收一个 `userData` 目录参数（而不是自己去问 electron），
 * 这样整条导入 / 清理流程可以在纯 node 下跑测试。
 */

export const ICONS_SUBDIR = 'icons'

export function iconsDir(userData: string): string {
  return join(userData, ICONS_SUBDIR)
}

/** 把配置里的文件名解析成绝对路径。名字不合法就直接拒绝 */
export function iconAbsPath(userData: string, name: string): string {
  if (!isSafeIconName(name)) throw new Error(`图标文件名不合法：${name}`)
  return join(iconsDir(userData), name)
}

export async function readIcon(
  userData: string,
  name: string
): Promise<{ dataUrl: string; bytes: number }> {
  return readImageDataUrl(iconAbsPath(userData, name))
}

/**
 * 把这台服务器的旧图标删掉（保留 `keep` 那一个）。
 *
 * 换图之后旧文件不会有人再引用，留着就是永远长不大的垃圾 ——
 * 一台服务器只该有一个图标文件，名字就是 `<serverId>.<ext>`。
 */
export async function removeOtherIcons(
  userData: string,
  serverId: string,
  keep = ''
): Promise<string[]> {
  const dir = iconsDir(userData)
  const prefix = iconNamePrefix(serverId)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (name === keep) continue
    if (!name.startsWith(prefix)) continue
    try {
      await fs.unlink(join(dir, name))
      removed.push(name)
    } catch {
      /* 删不掉就算了，不该因为一个图标让更新失败 */
    }
  }
  return removed
}

export async function removeIcon(userData: string, name: string): Promise<boolean> {
  if (!isSafeIconName(name)) return false
  try {
    await fs.unlink(iconAbsPath(userData, name))
    return true
  } catch {
    return false
  }
}

export interface ImportedIcon {
  name: string
  bytes: number
}

/** 把用户选的一张图片收进图标目录，返回存进配置用的文件名 */
export async function importIcon(
  userData: string,
  serverId: string,
  srcPath: string
): Promise<ImportedIcon> {
  const { ext, bytes } = await validateImage(srcPath)
  const dir = iconsDir(userData)
  await fs.mkdir(dir, { recursive: true })

  const name = iconFileName(serverId, ext)
  const dest = join(dir, name)

  // 已经就是这张图（用户重复选同一个文件）就没必要再复制一遍
  if (resolve(srcPath) !== resolve(dest)) {
    await fs.copyFile(srcPath, dest)
  }
  // 复制成功之后再清理旧的：反过来的话，复制失败就把原图标也弄丢了
  await removeOtherIcons(userData, serverId, name)

  return { name, bytes }
}
