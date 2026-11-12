import { useEffect, useRef, useState } from 'react'
import { api, setUser, type UserInfo } from './api'
import { Avatar } from './Avatar'

/** Every single-codepoint emoji the system can draw: faces and gestures first, then nature, food, objects, symbols.
 *  Built from Unicode properties so no list has to be maintained; very new ones are dropped when the font only draws a box. */
let emojiList: string[] | null = null
function allEmojis(): string[] {
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
const NAME_RE = /^[\w一-鿿\- ]{1,32}$/
const CACHE = 'fc_me'

const cached = (): UserInfo | null => {
  try { return JSON.parse(localStorage.getItem(CACHE) || 'null') } catch { return null }
}

/** The user pill with a dropdown: change the name, pick an emoji or upload a picture as the avatar. */
export function UserMenu() {
  const [me, setMe] = useState<UserInfo | null>(cached)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(me?.name ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)

  const apply = (u: UserInfo) => {
    setMe(u); setName(u.name)
    localStorage.setItem(CACHE, JSON.stringify(u))
    setUser(u.id) // a client that still held the old name-based login now switches to the user id
  }
  useEffect(() => { api.me().then(apply).catch(() => {}) }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  const save = async (patch: { name?: string; avatar?: string }) => {
    setBusy(true); setError('')
    try { apply(await api.updateMe(patch)) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const upload = async (f: File | undefined) => {
    if (!f || !f.type.startsWith('image/')) return
    setBusy(true); setError('')
    try {
      const info = await api.uploadAsset(f)
      apply(await api.updateMe({ avatar: `asset:${info.id}` }))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  if (!me) return <span className="user-pill">…</span>
  const trimmed = name.trim()
  const canRename = trimmed !== me.name && NAME_RE.test(trimmed)
  return (
    <div className="user-menu" ref={root}>
      <button className={`user-pill user-btn${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)} title="账户设置">
        <Avatar name={me.name} avatar={me.avatar} size={24} />
        <span className="user-name">{me.name}</span>
        <svg className="chev" viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 1.5L6.5 5 3 8.5" /></svg>
      </button>
      {open && (
        <div className="user-pop nodrag nopan nowheel">
          <div className="up-head">
            <Avatar name={me.name} avatar={me.avatar} size={52} />
            <div className="up-who">
              <strong>{me.name}</strong>
              <small title="用户 ID，改名后也不变">ID {me.id.slice(0, 8)}</small>
            </div>
          </div>

          <div className="up-label">头像<small>（可滚动，共 {allEmojis().length} 个）</small></div>
          <div className="up-emojis">
            {allEmojis().map(e => (
              <button key={e} className={me.avatar === `emoji:${e}` ? 'on' : ''} disabled={busy} onClick={() => void save({ avatar: `emoji:${e}` })}>{e}</button>
            ))}
          </div>
          <div className="up-row">
            <button disabled={busy} onClick={() => file.current?.click()}>上传图片</button>
            <button disabled={busy || !me.avatar} onClick={() => void save({ avatar: '' })} title="不使用头像，显示名字的第一个字">使用首字</button>
            <input ref={file} type="file" accept="image/*" hidden onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} />
          </div>

          <div className="up-label">名字</div>
          <form className="up-row" onSubmit={e => { e.preventDefault(); if (canRename) void save({ name: trimmed }) }}>
            <input value={name} maxLength={32} onChange={e => { setName(e.target.value); setError('') }} />
            <button className="primary" disabled={busy || !canRename}>保存</button>
          </form>
          {error && <div className="up-err">{error}</div>}
        </div>
      )}
    </div>
  )
}
