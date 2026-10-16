import type { CSSProperties } from 'react'
import { parseIcon } from '../../../shared/serverIcon'
import { kindColor, serverInitials } from '../utils'
import { useIcon } from '../iconCache'

/**
 * 服务器头像。
 *
 * 三种样子共用一个组件，左树、工具栏、总览、属性页都用它 ——
 * 以前各处各写一遍「缩写 + 底色」，加了自定义图标之后就必须统一，
 * 否则同一个服务器会在不同地方显示成不同的样子。
 */
export function ServerAvatar({
  server,
  size = 26,
  className = ''
}: {
  server: { name: string; kind: string; icon: string; color: string }
  size?: number
  className?: string
}): JSX.Element {
  const spec = parseIcon(server.icon)
  const imageUrl = useIcon(spec.kind === 'image' ? spec.name : null)

  const base: CSSProperties = { width: size, height: size }

  // 图片没读出来（文件被删、格式坏了）时退回缩写，而不是显示一个空白方块
  if (spec.kind === 'image' && imageUrl) {
    return (
      <span
        className={`server-icon ${className}`}
        style={{
          ...base,
          backgroundColor: '#111',
          backgroundImage: `url("${imageUrl}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        }}
      />
    )
  }

  const isText = spec.kind === 'text'
  return (
    <span
      className={`server-icon ${className}`}
      style={{
        ...base,
        background: server.color || kindColor(server.kind),
        // 表情比字母占的视觉空间小，得给大一档才不显得空
        fontSize: Math.round(size * (isText ? 0.56 : 0.42)),
        // 表情自带颜色，加粗和白色反而会把它压扁
        fontWeight: isText ? 400 : 700
      }}
    >
      {isText ? spec.text : serverInitials(server.name)}
    </span>
  )
}
