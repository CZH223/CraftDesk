/**
 * 各 Minecraft 版本要求的 Java 大版本。
 * 用于给用户提示该装哪个 JDK。
 *
 * 这只是「事先猜一下」用的：真正权威的是服务端自己启动时印在日志里的那句话
 * （`Minecraft 26.1 and newer requires running the server with Java 25 or above`），
 * 界面会把那句原文直接摆出来。所以这里猜错不影响排查，但别猜得太离谱——
 * 之前对 26.2 返回 17 就是错的，会在新建界面写着「建议使用 Java 17+」。
 */
export function requiredJavaMajor(mcVersion: string): number {
  const legacy = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?/)
  if (legacy) {
    const minor = Number(legacy[1])
    const patch = legacy[2] ? Number(legacy[2]) : 0
    if (minor >= 21) return 21
    if (minor === 20) return patch >= 5 ? 21 : 17
    if (minor >= 18) return 17
    if (minor === 17) return 16
    return 8
  }

  // 26 起换成了新的版本号写法（26.1、26.2…），官方说明是 26.1 及以上要 Java 25
  const modern = mcVersion.match(/^(\d+)(?:\.(\d+))?/)
  if (modern) {
    const major = Number(modern[1])
    if (major >= 26) return 25
    if (major >= 21) return 21
    if (major >= 18) return 17
    if (major >= 17) return 16
  }
  return 17
}

/**
 * 代理端要的 Java。
 *
 * Waterfall 跟着它对应的 MC 版本走（1.21 的 Waterfall 就是 Java 21）；
 * Velocity 和 BungeeCord 是各自独立的版本号（3.4.0 / 2100 这种），
 * 不能拿去套 Minecraft 版本的规则 —— 构建号 2100 会被当成「26 之后的版本」
 * 而要求 Java 25。这两个按 17 算：新版的 Velocity 3 与 BungeeCord 都是 17 起。
 */
export function proxyJavaMajor(kind: string, version: string): number {
  if (kind === 'waterfall') return requiredJavaMajor(version)
  return 17
}

/** 新建代理端时那句提示 */
export function proxyJavaHintText(kind: string, version: string): string {
  const major = proxyJavaMajor(kind, version)
  if (kind === 'waterfall') return `Waterfall ${version} 建议使用 Java ${major}+`
  return `代理端只需要 Java ${major}+（不吃版本号那一套）`
}

export function javaHintText(mcVersion: string): string {
  const major = requiredJavaMajor(mcVersion)
  return `Minecraft ${mcVersion} 建议使用 Java ${major}${major === 8 ? '（或更高）' : '+'}`
}
