export interface ModelInfo { key: string; name: string; ratios: string[]; sizes: string[] }
export interface BoardMeta { id: string; name: string; created: number; updated: number }
export interface JobInfo {
  id: string; node: string | null; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: string; error: string | null; result_asset: string | null; model: string
  result_w: number | null; result_h: number | null
}
export interface AssetInfo { id: string; w: number; h: number; mime: string }

const USER_KEY = 'fc_user'
export const getUser = () => localStorage.getItem(USER_KEY) || ''
export const setUser = (name: string) => localStorage.setItem(USER_KEY, name)
export const clearUser = () => localStorage.removeItem(USER_KEY)

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('X-User', encodeURIComponent(getUser()))
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { msg = (await res.json()).error || msg } catch { /* ignore */ }
    throw new Error(String(msg))
  }
  return res.json() as Promise<T>
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

export const api = {
  models: () => call<{ models: ModelInfo[]; max_count: number }>('/api/models'),
  usage: () => call<{ credits: number | null; image_daily: { name: string; used: number; limit: number }[]; date?: string }>('/api/usage'),
  boards: () => call<{ boards: BoardMeta[] }>('/api/boards').then(r => r.boards),
  createBoard: (name: string) => call<BoardMeta>('/api/boards', json('POST', { name })),
  getBoard: (id: string) => call<{ id: string; name: string; data: any }>(`/api/boards/${id}`),
  saveBoard: (id: string, data: unknown) => call<{ ok: boolean }>(`/api/boards/${id}`, json('PUT', { data })),
  renameBoard: (id: string, name: string) => call<{ ok: boolean }>(`/api/boards/${id}`, json('PUT', { name })),
  deleteBoard: (id: string) => call<{ ok: boolean }>(`/api/boards/${id}`, { method: 'DELETE' }),
  uploadAsset: (file: Blob) => call<AssetInfo>('/api/assets', { method: 'POST', body: file }),
  createJobs: (req: {
    board: string; node: string; model: string; ratio: string; size: string
    prompt: string; refs: string[]; count: number
  }) => call<{ jobs: string[] }>('/api/jobs', json('POST', req)).then(r => r.jobs),
  jobs: (ids: string[]) => call<{ jobs: JobInfo[] }>(`/api/jobs?ids=${ids.join(',')}`).then(r => r.jobs),
  cancelJob: (id: string) => call<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
}

export const assetUrl = (id: string, w?: number) => `/api/assets/${id}${w ? `?w=${w}` : ''}`
export const downloadUrl = (id: string) => `/api/assets/${id}?download=1`
