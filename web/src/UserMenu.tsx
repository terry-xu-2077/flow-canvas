import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, setUser, type UserInfo } from './api'
import { Avatar } from './Avatar'
import { NAME_RE, ProfileEditor, choiceFromAvatar, resolveAvatar, sameChoice, type AvatarChoice } from './ProfileEditor'

const CACHE = 'fc_me'

const cached = (): UserInfo | null => {
  try { return JSON.parse(localStorage.getItem(CACHE) || 'null') } catch { return null }
}

/** The user pill with a small dropdown; the edit button opens a dialog for the name and the avatar. */
export function UserMenu() {
  const [me, setMe] = useState<UserInfo | null>(cached)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [choice, setChoice] = useState<AvatarChoice>({ kind: 'none' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const apply = (u: UserInfo) => {
    setMe(u)
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

  if (!me) return <span className="user-pill">…</span>

  const startEdit = () => {
    setName(me.name); setChoice(choiceFromAvatar(me.avatar)); setError(''); setOpen(false); setEditing(true)
  }
  const trimmed = name.trim()
  const changed = trimmed !== me.name || !sameChoice(choice, choiceFromAvatar(me.avatar))
  const save = async () => {
    setBusy(true); setError('')
    try {
      const patch: { name?: string; avatar?: string } = {}
      if (trimmed !== me.name) patch.name = trimmed
      if (!sameChoice(choice, choiceFromAvatar(me.avatar))) patch.avatar = await resolveAvatar(choice)
      apply(await api.updateMe(patch))
      setEditing(false)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="user-menu" ref={root}>
      <button className={`user-pill user-btn${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)} title="账户">
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
            <button className="icon up-edit" title="编辑名字和头像" onClick={startEdit}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.2 2.3l2.5 2.5-8.4 8.4-3.2.7.7-3.2 8.4-8.4z" /><path d="M9.7 3.8l2.5 2.5" />
              </svg>
            </button>
          </div>
        </div>
      )}
      {editing && createPortal(
        <div className="modal-back" onMouseDown={() => !busy && setEditing(false)}>
          <form className="modal wide" onMouseDown={e => e.stopPropagation()}
                onSubmit={e => { e.preventDefault(); if (NAME_RE.test(trimmed) && changed) void save() }}>
            <strong>编辑资料</strong>
            <ProfileEditor name={name} onName={v => { setName(v); setError('') }} choice={choice} onChoice={c => { setChoice(c); setError('') }} busy={busy} />
            {error && <div className="up-err">{error}</div>}
            <div className="modal-actions">
              <button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button>
              <button className="primary" disabled={busy || !changed || !NAME_RE.test(trimmed)}>保存</button>
            </div>
          </form>
        </div>,
        document.body,
      )}
    </div>
  )
}
