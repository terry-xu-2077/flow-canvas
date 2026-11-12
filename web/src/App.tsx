import { useCallback, useEffect, useRef, useState } from 'react'
import { api, clearUser, getUser, setUser, type BoardMeta, type UserInfo } from './api'
import { Avatar } from './Avatar'
import { UserMenu } from './UserMenu'
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
  const [users, setUsers] = useState<UserInfo[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const ok = /^[\w一-鿿\- ]{1,32}$/.test(name.trim())
  useEffect(() => { api.users().then(setUsers).catch(() => setUsers([])) }, [])
  const enter = (id: string) => { setUser(id); onDone() }
  return (
    <div className="center-msg login">
      <h1><BrandMark size={30} /> Terry Flow</h1>
      <p>选择用户，画板会按用户分开保存</p>
      <div className="user-pick">
        {users?.map(u => (
          <button key={u.id} className="user-chip" onClick={() => enter(u.id)}>
            <Avatar name={u.name} avatar={u.avatar} size={22} />{u.name}<em>{u.boards}</em>
          </button>
        ))}
        <button className="user-chip add" onClick={() => { setName(''); setCreating(true) }}>＋ 创建用户</button>
      </div>
      {creating && (
        <div className="modal-back" onMouseDown={() => setCreating(false)}>
          <form className="modal" onMouseDown={e => e.stopPropagation()}
                onSubmit={async e => {
                  e.preventDefault()
                  if (!ok) return
                  try { enter((await api.createUser(name.trim())).id) } catch (err) { setError((err as Error).message) }
                }}>
            <strong>创建用户</strong>
            <input autoFocus value={name} onChange={e => { setName(e.target.value); setError('') }} placeholder="名字（1–32 个字符）" />
            {error && <div className="up-err">{error}</div>}
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
  const [importing, setImporting] = useState(false)
  const zipInput = useRef<HTMLInputElement>(null)
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
        <h1><BrandMark size={30} /> Terry Flow</h1>
        <span className="who"><UsageBadge /><UserMenu /><button onClick={onLogout}>切换用户</button></span>
      </header>
      {error && <div className="banner">{error}</div>}
      <div className="grid">
        <div className="tile new split">
          <button className="split-main" onClick={create}>＋ 新建画板</button>
          <span className="split-sep" aria-hidden>|</span>
          <button className="split-side" disabled={importing} title="导入画板 zip（也可以是一包图片），新建一个画板" onClick={() => zipInput.current?.click()}>
            {importing ? '导入中…' : '⤒ 导入 zip'}
          </button>
        </div>
        <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={async e => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          setImporting(true)
          try { const b = await api.importBoardZip(file); onOpen(b.id) } catch (err) { alert(`导入失败：${(err as Error).message}`) } finally { setImporting(false) }
        }} />
        {boards?.map(b => (
          <div key={b.id} className="tile" onClick={() => onOpen(b.id)}>
            <strong>{b.name}</strong>
            <small>{new Date(b.updated * 1000).toLocaleString()}</small>
            <button className="icon tile-dl" title="下载整个画板（zip：画布内容 + 全部图片）" onClick={async e => {
              e.stopPropagation()
              try { await api.downloadBoardZip(b.id, b.name) } catch (err) { alert(`下载失败：${(err as Error).message}`) }
            }}>
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v8M4.8 7.2L8 10.4l3.2-3.2M2.5 13.5h11" /></svg>
            </button>
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
  // a stored login that the server no longer knows (or an old name-based one) is resolved or dropped here
  useEffect(() => { if (user) api.me().then(u => setUser(u.id)).catch(e => { if ((e as { status?: number }).status === 401) { clearUser(); setUserState('') } }) }, [user])
  if (!user) return <Login onDone={() => setUserState(getUser())} />
  if (boardId) return <Board key={boardId} boardId={boardId} onBack={() => openBoard(null)} />
  return <BoardList onOpen={openBoard} onLogout={() => { clearUser(); setUserState('') }} />
}
