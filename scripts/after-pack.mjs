/**
 * 打包后清理用不到的文件。
 *
 * CraftDesk 是纯 2D 界面，不用 WebGL / Vulkan，SwiftShader 和 Vulkan
 * 运行时只会在极端环境下被 Chromium 当兜底；去掉它们能少几 MB。
 * elevate.exe 是 NSIS 安装器提权用的，便携版按当前用户运行不需要。
 * 如果哪天真要 WebGL，删掉这里的对应项即可。
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const dir = context.appOutDir
  for (const name of ['vk_swiftshader.dll', 'vulkan-1.dll', 'vk_swiftshader_icd.json']) {
    await rm(join(dir, name), { force: true })
  }
  await rm(join(dir, 'resources', 'elevate.exe'), { force: true })
}
