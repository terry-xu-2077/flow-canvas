/** Which sizes cost nothing: zero = 0 credits (['*'] = every size), slow = free only in the queued unlimited-slow mode. */
export interface FreeInfo { zero?: string[]; quota?: string[]; slow?: { days: number; condition: string; res: string[]; extra?: string[] } }
export interface ModelInfo {
  free?: FreeInfo | null
  qualities?: string[]                    // quality tiers of this model (low / medium / high ...); [] = no such option
  combos?: [string, string][] | null      // users without credit-model access: the free [size, quality] pairs ('' = the default quality)
  key: string; name: string; ratios: string[]; sizes: string[]
  provider?: 'flow' | 'gpt' | 'chatgpt' | 'xyq' | 'libtv' | 'lovart'   // where the model runs; direct Flow models leave it out
  legacy?: string             // the key a card saved before the aggregation API used (so old boards keep their model)
  tag?: string                // small label in the model menu, e.g. "ChatGPT Plus"
  kind?: 'image' | 'video'    // aggregation-service models say what they make
  refs?: boolean              // false = cannot take reference pictures
  available?: boolean         // false = the backend is configured but not reachable right now
}
export interface GptWindow { limit: number; used: number; remaining: number | null; resets_in: number | null }
export interface GptQuota { hour: GptWindow; day: GptWindow }
export interface UpscaleOption { size: string; target: number; engine: string }
export interface UpscaleInfo { enabled: boolean; options: UpscaleOption[] }
export interface BoardMeta { id: string; name: string; created: number; updated: number; thumbs?: string[] }
/** What a video model accepts (from terry2api's model_info): empty lists mean the option is not offered. */
export interface VideoModelInfo {
  ratios: string[]; resolutions: string[]; sound: boolean
  durations: { options?: number[]; min?: number; max?: number; step?: number; default?: number | string | null } | null
  default_ratio?: string | null; default_resolution?: string | null
}
export interface VideoModel extends Pick<ModelInfo, 'key' | 'name' | 'provider' | 'tag'> { vip?: boolean; info?: VideoModelInfo | null; free?: FreeInfo | null }
export interface VideoJobRequest {
  board: string; node: string; model: string; prompt: string; ratio: string; resolution: string
  duration: number; sound: boolean; mode: 'auto' | 'reference'; refs: string[]; count: number
}
export interface VideoQuote {
  amount: number; unit?: string; balance?: number
  unlimited?: { name: string; days: number; condition: string; eligible: boolean } | null
  quota_free?: boolean            // 0 only while the account's free allowance lasts; after that the normal price is charged
  typical_paid?: number | null    // what the last real run of this model at this size cost (credits)
  typical_wait?: { seconds: number; samples: number; min: number; max: number } | null   // measured, not guessed: slow-mode jobs of this model
}
export interface CloudBalance {
  provider: string; name: string; ok: boolean; balance: number | string | null; expire: string; error: string
  unlimited: { name: string; days: number; condition: string }[]; detail: Record<string, number | string>
}
export interface JobInfo {
  kind?: 'image' | 'video'
  id: string; node: string | null; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: string; error: string | null; result_asset: string | null; model: string
  result_w: number | null; result_h: number | null
  label?: string   // "厂商 · 模型名" of the source that made it
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

export interface LibraryItem { asset: string; w: number; h: number; created: number; prompt?: string; model?: string }

export const api = {
  library: () => call<{ generated: LibraryItem[]; uploaded: LibraryItem[] }>('/api/library'),
  models: () => call<{ models: ModelInfo[]; max_count: number; upscale?: UpscaleInfo }>('/api/models'),
  usage: () => call<{ credits: number | null; image_daily: { name: string; used: number; limit: number }[]; date?: string; gpt?: GptQuota | null }>('/api/usage'),
  users: () => call<{ users: UserInfo[] }>('/api/users').then(r => r.users),
  createUser: (name: string) => call<UserInfo>('/api/users', json('POST', { name })),
  me: () => call<UserInfo>('/api/me'),
  updateMe: (patch: { name?: string; avatar?: string }) => call<UserInfo>('/api/me', json('PUT', patch)),
  boards: () => call<{ boards: BoardMeta[] }>('/api/boards').then(r => r.boards),
  createBoard: (name: string) => call<BoardMeta>('/api/boards', json('POST', { name })),
  getBoard: (id: string) => call<{ id: string; name: string; data: any; rev?: number }>(`/api/boards/${id}`),
  saveBoard: (id: string, data: unknown, baseRev?: number) => call<{ ok: boolean; rev?: number }>(`/api/boards/${id}`, json('PUT', { data, base_rev: baseRev })),
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
    prompt: string; refs: string[]; count: number; quality?: string
  }) => call<{ jobs: string[] }>('/api/jobs', json('POST', req)).then(r => r.jobs),
  videoModels: () => call<{ enabled: boolean; models: VideoModel[]; errors: Record<string, string>; locked?: boolean }>('/api/video/models'),
  videoModelInfo: (model: string) => call<VideoModelInfo>(`/api/video/model_info?model=${encodeURIComponent(model)}`),
  videoQuote: (q: { model: string; resolution: string; duration: number; sound: boolean; ratio: string; refer_image: boolean; kind?: 'image' | 'video'; quality?: string }) =>
    call<VideoQuote>(`/api/video/quote?${new URLSearchParams({ model: q.model, resolution: q.resolution, duration: String(q.duration),
      sound: String(q.sound), ratio: q.ratio, refer_image: String(q.refer_image), kind: q.kind ?? 'video', quality: q.quality ?? '' })}`),
  videoBalances: () => call<{ enabled: boolean; items: CloudBalance[]; extension?: boolean }>('/api/video/balances'),
  createVideoJobs: (req: VideoJobRequest) => call<{ jobs: string[] }>('/api/video/jobs', json('POST', req)).then(r => r.jobs),
  upscale: (asset: string, board: string, size: string) => call<{ jobs: string[]; label: string }>('/api/upscale', json('POST', { asset, board, size })),
  jobs: (ids: string[]) => call<{ jobs: JobInfo[] }>(`/api/jobs?ids=${ids.join(',')}`).then(r => r.jobs),
  cancelJob: (id: string) => call<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
}

export const assetUrl = (id: string, w?: number) => `/api/assets/${id}${w ? `?w=${w}` : ''}`
export const downloadUrl = (id: string) => `/api/assets/${id}?download=1`
