import { assetUrl } from './api'

/** Round user avatar: an emoji, an uploaded picture, or (nothing set) the first character of the name. */
export function Avatar({ name, avatar, size = 24 }: { name: string; avatar?: string; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.5) }
  if (avatar?.startsWith('asset:')) {
    return <img className="avatar" style={style} src={assetUrl(avatar.slice(6), Math.max(96, size * 2))} alt="" draggable={false} />
  }
  if (avatar?.startsWith('emoji:')) {
    return <span className="avatar emoji" style={{ ...style, fontSize: Math.round(size * 0.58) }}>{avatar.slice(6)}</span>
  }
  const first = (Array.from(name.trim())[0] ?? '?').toUpperCase()
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return <span className="avatar initial" style={{ ...style, background: `hsl(${h} 32% 34%)` }}>{first}</span>
}
