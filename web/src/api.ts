export interface ModelInfo { key: string; name: string; ratios: string[]; sizes: string[] }
export interface UpscaleOption { size: string; target: number; engine: string }
export interface UpscaleInfo { enabled: boolean; options: UpscaleOption[] }
export interface BoardMeta { id: string; name: string; created: number; updated: number }
export interface JobInfo {
  id: string; node: string | null; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: string; error: string | null; result_asset: string | null; model: string
  result_w: number | null; result_h: number | null
}
export interface UserInfo { id: string; name: string; avatar: string; boards?: number }
export interface AssetInfo { id: string; w: number; h: number; mime: string }

const USER_KEY = 'fc_user'
export const getUser = () => localStorage.getItem(USER_KEY) || ''
export const setUser = (id: string) => {
  if (getUser() !== id) localStorage.removeItem('fc_me') // cached profile of the previous user
  localStorage.setItem(USER_KEY, id)
}
export const clearUser = () => { localStorage.removeItem(USER_KEY); localStorage.removeItem('fc_me') }

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('X-User', encodeURIComponent(getUser()))
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { msg = (await res.json()).error || msg } catch { /* ignore */ }
    throw Object.assign(new Error(String(msg)), { status: res.status })
  }
  return res.json() as Promise<T>
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

export const api = {
  models: () => call<{ models: ModelInfo[]; max_count: number; upscale?: UpscaleInfo }>('/api/models'),
  usage: () => call<{ credits: number | null; image_daily: { name: string; used: number; limit: number }[]; date?: string }>('/api/usage'),
  users: () => call<{ users: UserInfo[] }>('/api/users').then(r => r.users),
  createUser: (name: string) => call<UserInfo>('/api/users', json('POST', { name })),
  me: () => call<UserInfo>('/api/me'),
  updateMe: (patch: { name?: string; avatar?: string }) => call<UserInfo>('/api/me', json('PUT', patch)),
  boards: () => call<{ boards: BoardMeta[] }>('/api/boards').then(r => r.boards),
  createBoard: (name: string) => call<BoardMeta>('/api/boards', json('POST', { name })),
  getBoard: (id: string) => call<{ id: string; name: string; data: any }>(`/api/boards/${id}`),
  saveBoard: (id: string, data: unknown) => call<{ ok: boolean }>(`/api/boards/${id}`, json('PUT', { data })),
  renameBoard: (id: string, name: string) => call<{ ok: boolean }>(`/api/boards/${id}`, json('PUT', { name })),
  /** Download every image of a board as a zip (fetched with the user header, then saved through a temporary link). */
  downloadBoardZip: async (id: string, name: string) => {
    const res = await fetch(`/api/boards/${id}/zip`, { headers: { 'X-User': encodeURIComponent(getUser()) } })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { msg = (await res.json()).error || msg } catch { /* ignore */ }
      throw new Error(String(msg))
    }
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url; a.download = `${name || 'board'}.zip`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  },
  importBoardZip: (file: File) => call<BoardMeta & { images: number }>(
    `/api/boards/import?name=${encodeURIComponent(file.name.replace(/\.zip$/i, ''))}`,
    { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file }),
  deleteBoard: (id: string) => call<{ ok: boolean }>(`/api/boards/${id}`, { method: 'DELETE' }),
  uploadAsset: (file: Blob) => call<AssetInfo>('/api/assets', { method: 'POST', body: file }),
  createJobs: (req: {
    board: string; node: string; model: string; ratio: string; size: string
    prompt: string; refs: string[]; count: number
  }) => call<{ jobs: string[] }>('/api/jobs', json('POST', req)).then(r => r.jobs),
  upscale: (asset: string, board: string, size: string) => call<{ jobs: string[]; label: string }>('/api/upscale', json('POST', { asset, board, size })),
  jobs: (ids: string[]) => call<{ jobs: JobInfo[] }>(`/api/jobs?ids=${ids.join(',')}`).then(r => r.jobs),
  cancelJob: (id: string) => call<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
}

export const assetUrl = (id: string, w?: number) => `/api/assets/${id}${w ? `?w=${w}` : ''}`
export const downloadUrl = (id: string) => `/api/assets/${id}?download=1`
