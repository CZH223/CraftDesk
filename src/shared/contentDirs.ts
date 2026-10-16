/**
 * 「内容目录」——里面全是 jar，但和服务端核心本身没关系。
 *
 * 为什么需要这份名单：找核心目录的规则是「根目录没有 jar 就往子目录找一层，
 * 谁有 jar 谁是核心」。而 Forge / NeoForge 1.17 以后**根目录根本没有 jar**
 * （启动入口是 libraries/ 下的参数文件），于是一个装着 245 个模组的 mods/
 * 就会被当成核心目录。后果不是「找不到核心」这么轻：核心目录一错，
 * mods/ 就变成「核心目录下的 mods」（不存在），整个模组列表空空如也。
 *
 * 判定只看目录名，不做内容嗅探：这些名字是社区通行约定，
 * 一个叫 mods 的目录在任何服务端里都不会是核心。
 */
const CONTENT_DIRS = new Set([
  'mods',
  'plugins',
  'config',
  'configs',
  'defaultconfigs',
  'default-configs',
  'world',
  'world_nether',
  'world_the_end',
  'logs',
  'crash-reports',
  'backups',
  'backup',
  'saves',
  'resourcepacks',
  'datapacks',
  'shaderpacks',
  'screenshots',
  'cache',
  'libraries',
  'versions',
  'local',
  'data',
  'kubejs',
  'scripts',
  'assets',
  'bin',
  'tmp',
  'temp',
  'node_modules'
])

/** 这个目录名是不是「内容目录」（大小写不敏感） */
export function isContentDirName(name: string): boolean {
  return CONTENT_DIRS.has((name || '').trim().toLowerCase())
}

export function contentDirNames(): string[] {
  return [...CONTENT_DIRS]
}
