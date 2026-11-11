import { useCallback, useEffect, useState } from 'react'
import { api, clearUser, getUser, setUser, type BoardMeta } from './api'
import Board from './Board'
import { BrandMark } from './icons'
import UsageBadge from './UsageBadge'

function useHashBoard(): [string | null, (id: string | null) => void] {
  const read = () => (location.hash.match(/^#\/b\/([\w-]+)/) || [])[1] ?? null
  const [id, setId] = useState<string | null>(read)
  useEffect(() => {
    const on = () => setId(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [id, (next) => { location.hash = next ? `#/b/${next}` : '#/' }]
}

function Login({ onDone }: { onDone: () => void }) {
  const [users, setUsers] = useState<{ user: string; boards: number }[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const ok = /^[\w一-鿿\- ]{1,32}$/.test(name.trim())
  useEffect(() => { api.users().then(setUsers).catch(() => setUsers([])) }, [])
  const enter = (u: string) => { setUser(u); onDone() }
  return (
    <div className="center-msg login">
      <h1><BrandMark size={30} /> Flow 画布</h1>
      <p>选择用户，画板会按用户分开保存</p>
      <div className="user-pick">
        {users?.map(u => (
          <button key={u.user} className="user-chip" onClick={() => enter(u.user)}>{u.user}<em>{u.boards}</em></button>
        ))}
        <button className="user-chip add" onClick={() => { setName(''); setCreating(true) }}>＋ 创建用户</button>
      </div>
      {creating && (
        <div className="modal-back" onMouseDown={() => setCreating(false)}>
          <form className="modal" onMouseDown={e => e.stopPropagation()}
                onSubmit={e => { e.preventDefault(); if (ok) enter(name.trim()) }}>
            <strong>创建用户</strong>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="名字（1–32 个字符）" />
            <div className="modal-actions">
              <button type="button" onClick={() => setCreating(false)}>取消</button>
              <button className="primary" disabled={!ok}>创建并进入</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function BoardList({ onOpen, onLogout }: { onOpen: (id: string) => void; onLogout: () => void }) {
  const [boards, setBoards] = useState<BoardMeta[] | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(() => {
    api.boards().then(setBoards).catch(e => setError(String(e.message || e)))
  }, [])
  useEffect(refresh, [refresh])

  const create = async () => {
    const name = prompt('画板名称', '未命名画板')
    if (name === null) return
    const b = await api.createBoard(name.trim() || '未命名画板')
    onOpen(b.id)
  }
  return (
    <div className="list">
      <header>
        <h1><BrandMark size={30} /> Flow 画布</h1>
        <span className="who"><UsageBadge /><span className="user-pill">{getUser()}</span><button onClick={onLogout}>切换用户</button></span>
      </header>
      {error && <div className="banner">{error}</div>}
      <div className="grid">
        <button className="tile new" onClick={create}>＋ 新建画板</button>
        {boards?.map(b => (
          <div key={b.id} className="tile" onClick={() => onOpen(b.id)}>
            <strong>{b.name}</strong>
            <small>{new Date(b.updated * 1000).toLocaleString()}</small>
            <button className="icon" title="删除画板" onClick={async e => {
              e.stopPropagation()
              if (confirm(`删除画板「${b.name}」？此操作无法恢复。`)) { await api.deleteBoard(b.id); refresh() }
            }}>✕</button>
          </div>
        ))}
      </div>
      {boards && boards.length === 0 && <p className="hint">还没有画板，点「新建画板」开始。</p>}
    </div>
  )
}

export default function App() {
  const [user, setUserState] = useState(getUser())
  const [boardId, openBoard] = useHashBoard()
  if (!user) return <Login onDone={() => setUserState(getUser())} />
  if (boardId) return <Board key={boardId} boardId={boardId} onBack={() => openBoard(null)} />
  return <BoardList onOpen={openBoard} onLogout={() => { clearUser(); setUserState('') }} />
}
