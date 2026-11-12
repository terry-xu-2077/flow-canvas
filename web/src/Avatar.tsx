import { assetUrl } from './api'

const emojiCache = new Map<string, string>()
/** Draw the emoji on a canvas, find where its pixels really are and re-draw it centered and scaled to fill the circle
 *  (font metrics differ between systems, so centering a text glyph with CSS is never exact). */
function emojiImage(emoji: string): string {
  const hit = emojiCache.get(emoji)
  if (hit) return hit
  const N = 192
  const src = document.createElement('canvas'); src.width = src.height = N
  const g = src.getContext('2d', { willReadFrequently: true })!
  g.font = `${N * 0.62}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`
  g.textBaseline = 'alphabetic'
  g.fillText(emoji, N * 0.12, N * 0.72)
  const px = g.getImageData(0, 0, N, N).data
  let x1 = N, y1 = N, x2 = -1, y2 = -1
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (px[(y * N + x) * 4 + 3] > 24) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y }
  }
  if (x2 < 0) return ''
  const w = x2 - x1 + 1, h = y2 - y1 + 1
  const out = document.createElement('canvas'); out.width = out.height = N
  const o = out.getContext('2d')!
  const k = (N * 0.78) / Math.max(w, h)
  o.drawImage(src, x1, y1, w, h, (N - w * k) / 2, (N - h * k) / 2, w * k, h * k)
  const url = out.toDataURL('image/png')
  emojiCache.set(emoji, url)
  return url
}

/** Round user avatar: an emoji, an uploaded picture, or (nothing set) the first character of the name. */
export function Avatar({ name, avatar, size = 24 }: { name: string; avatar?: string; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.5) }
  if (avatar?.startsWith('asset:')) {
    return <img className="avatar" style={style} src={assetUrl(avatar.slice(6), Math.max(96, size * 2))} alt="" draggable={false} />
  }
  if (avatar?.startsWith('emoji:')) {
    const url = emojiImage(avatar.slice(6))
    return url
      ? <img className="avatar emoji" style={style} src={url} alt={avatar.slice(6)} draggable={false} />
      : <span className="avatar emoji" style={style}>{avatar.slice(6)}</span>
  }
  const first = (Array.from(name.trim())[0] ?? '?').toUpperCase()
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return <span className="avatar initial" style={{ ...style, background: `hsl(${h} 32% 34%)` }}>{first}</span>
}
