import { useEffect, useRef } from 'react'
import { api } from './api'
import { Avatar } from './Avatar'

export const NAME_RE = /^[\w一-鿿\- ]{1,32}$/

/** Every single-codepoint emoji the system can draw: faces and gestures first, then nature, food, objects, symbols.
 *  Built from Unicode properties so no list has to be maintained; very new ones are dropped when the font only draws a box. */
let emojiList: string[] | null = null
export function allEmojis(): string[] {
  if (emojiList) return emojiList
  const ranges: [number, number][] = [[0x1F600, 0x1F64F], [0x1F910, 0x1F9FF], [0x1F300, 0x1F5FF], [0x1F680, 0x1F6FF],
    [0x1FA70, 0x1FAFF], [0x2600, 0x27BF], [0x2B00, 0x2BFF], [0x231A, 0x23FF]]
  const probe = document.createElement('canvas'); probe.width = probe.height = 32
  const g = probe.getContext('2d', { willReadFrequently: true })!
  g.font = '24px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif'
  const drawn = (ch: string) => {
    g.clearRect(0, 0, 32, 32); g.fillText(ch, 2, 26)
    const d = g.getImageData(0, 0, 32, 32).data
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && (Math.abs(d[i] - d[i + 1]) > 24 || Math.abs(d[i + 1] - d[i + 2]) > 24)) return true
    return false
  }
  const out: string[] = []
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp++) {
      const ch = String.fromCodePoint(cp)
      if (!/^\p{Emoji_Presentation}$/u.test(ch) || (cp >= 0x1FA70 && !drawn(ch))) continue
      out.push(ch)
    }
  }
  return (emojiList = out)
}

/** What the user picked for the avatar; a picked file is only uploaded when the form is saved. */
export type AvatarChoice =
  | { kind: 'none' }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'asset'; id: string }
  | { kind: 'file'; file: File; url: string }

export function choiceFromAvatar(avatar: string): AvatarChoice {
  if (avatar.startsWith('emoji:')) return { kind: 'emoji', emoji: avatar.slice(6) }
  if (avatar.startsWith('asset:')) return { kind: 'asset', id: avatar.slice(6) }
  return { kind: 'none' }
}

/** The avatar string to store for a choice (uploads a picked picture first). */
export async function resolveAvatar(choice: AvatarChoice): Promise<string> {
  if (choice.kind === 'emoji') return `emoji:${choice.emoji}`
  if (choice.kind === 'asset') return `asset:${choice.id}`
  if (choice.kind === 'file') return `asset:${(await api.uploadAsset(choice.file)).id}`
  return ''
}

export const sameChoice = (a: AvatarChoice, b: AvatarChoice) =>
  a.kind === b.kind && (a.kind === 'none' || (a.kind === 'emoji' && b.kind === 'emoji' && a.emoji === b.emoji)
    || (a.kind === 'asset' && b.kind === 'asset' && a.id === b.id))

function ChoiceAvatar({ name, choice, size }: { name: string; choice: AvatarChoice; size: number }) {
  if (choice.kind === 'file') return <img className="avatar" style={{ width: size, height: size }} src={choice.url} alt="" draggable={false} />
  const avatar = choice.kind === 'emoji' ? `emoji:${choice.emoji}` : choice.kind === 'asset' ? `asset:${choice.id}` : ''
  return <Avatar name={name || '?'} avatar={avatar} size={size} />
}

/** Avatar (emoji grid, upload, or the first letter of the name) and name fields, shared by "create user" and "edit". */
export function ProfileEditor(props: {
  name: string; onName: (v: string) => void
  choice: AvatarChoice; onChoice: (c: AvatarChoice) => void
  busy?: boolean; autoFocusName?: boolean
}) {
  const { name, onName, choice, onChoice, busy } = props
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => () => { if (choice.kind === 'file') URL.revokeObjectURL(choice.url) }, [choice])

  return (
    <div className="pe-form">
      <div className="pf-top">
        <ChoiceAvatar name={name} choice={choice} size={64} />
        <div className="pf-actions">
          <button type="button" disabled={busy} onClick={() => file.current?.click()}>上传图片</button>
          <button type="button" disabled={busy || choice.kind === 'none'} onClick={() => onChoice({ kind: 'none' })}
                  title="不使用头像，显示名字的第一个字">使用首字</button>
          <input ref={file} type="file" accept="image/*" hidden onChange={e => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f && f.type.startsWith('image/')) onChoice({ kind: 'file', file: f, url: URL.createObjectURL(f) })
          }} />
        </div>
      </div>

      <div className="up-label">头像<small>（可滚动，共 {allEmojis().length} 个）</small></div>
      <div className="up-emojis nodrag nopan nowheel">
        {allEmojis().map(e => (
          <button key={e} type="button" className={choice.kind === 'emoji' && choice.emoji === e ? 'on' : ''}
                  disabled={busy} onClick={() => onChoice({ kind: 'emoji', emoji: e })}>{e}</button>
        ))}
      </div>

      <div className="up-label">名字</div>
      <input value={name} maxLength={32} autoFocus={props.autoFocusName} placeholder="名字（1–32 个字符）"
             onChange={e => onName(e.target.value)} />
    </div>
  )
}
