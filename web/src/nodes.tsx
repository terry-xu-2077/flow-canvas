import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { qualityOptions, pickQuality, QUALITY_ZH } from './quality'
import { api, assetUrl, downloadUrl, type FreeInfo, type ModelInfo, type VideoModel, type VideoModelInfo, type VideoQuote } from './api'
import { useCanvas } from './CanvasContext'
import { BananaIcon, BoltIcon, ImageIcon, RosetteIcon, SparkleIcon, VideoIcon } from './icons'
import PromptEditor from './PromptEditor'
import { RefsetNode } from './RefsetNode'
import { type GenNodeType, type ImageNodeType, type VGenNodeType, type VideoNodeType } from './types'

const FINAL = new Set(['done', 'failed', 'cancelled'])

/** Credits one generation will cost, shown inside the generate button: a bolt and the number (∞ when the slow unlimited mode
 *  covers it); nothing while it is being asked, and a dash when the price could not be read. */
function CostChip({ quote, count }: { quote: VideoQuote | null | 'err'; count: number }) {
  if (quote === null) return <span className="cost dim">…</span>
  if (quote === 'err') return <span className="cost dim" title="读不到积分（需要聚合API和浏览器扩展在线）"><BoltIcon />—</span>
  const u = quote.unlimited
  const w = quote.typical_wait
  const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`)
  const wait = u?.eligible ? (w ? `无限低速要排队：最近 ${w.samples} 次实际等了 ${fmt(w.min)} ~ ${fmt(w.max)}（中位 ${fmt(w.seconds)}）` : '无限低速要排队，等待时间不固定（还没有这个模型的实测记录）') : ''
  const quotaTip = quote.quota_free ? `免费额度有限，用完后按正常价格收费${quote.typical_paid ? `（上次实际扣了 ${quote.typical_paid} 积分）` : ''}` : ''
  const tip = [quote.unit, u ? (u.eligible ? `无限低速可免费（剩 ${u.days} 天）：生成时选慢速（∞）` : `无限低速仅限 ${u.condition || '部分档位'}`) : '', wait, quotaTip].filter(Boolean).join('\n')
  return (
    <span className={`cost${u?.eligible ? ' free' : ''}`} title={tip || undefined}>
      <BoltIcon />{(quote.amount * count).toLocaleString('zh-CN')}{u?.eligible && <i>∞</i>}{quote.quota_free && <i>限量</i>}
    </span>
  )
}

/** Tiny aspect-ratio glyph for the ratio grid. */
function RatioGlyph({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(':').map(Number)
  const max = 16
  const k = max / Math.max(w, h)
  return <span className="glyph" style={{ width: Math.round(w * k), height: Math.round(h * k) }} />
}

/** Is this size free? 'free' = 0 credits, 'slow' = free only in the queued unlimited-slow mode. */
function freeKind(free: FreeInfo | null | undefined, size: string, quality = ''): 'free' | 'slow' | 'quota' | '' {
  const s = size.toLowerCase(), q = quality.toLowerCase()
  if (q === '' && free?.quota?.some(z => z.toLowerCase() === s)) return 'quota'
  if (q === '' && free?.zero?.some(z => z === '*' || z.toLowerCase() === s)) return 'free'
  if (free?.slow?.res.some(z => z === '*' || z.toLowerCase() === s)) {
    const extra = (free.slow.extra ?? []).map(x => x.toLowerCase())
    // a condition beyond the size (e.g. low quality) only counts when the chosen quality matches it
    if (extra.length ? extra.every(x => x === q) : q === '') return 'slow'
  }
  return ''
}
const FREE_TIP = {
  free: '0 积分',
  slow: '无限低速：免费，但要排队等',
  quota: '有免费额度时 0 积分，额度用完后按正常价格收费',
}
const FREE_TEXT = { free: '免费', slow: '∞ 免费', quota: '限量免费' }
function FreeMark({ kind }: { kind: 'free' | 'slow' | 'quota' | '' }) {
  return kind ? <i className={`free-mark ${kind}`} title={FREE_TIP[kind]}>{FREE_TEXT[kind]}</i> : null
}

function Segmented<T extends string | number>(props: {
  options: T[]; value: T; onChange: (v: T) => void; label?: (v: T) => string; mark?: (v: T) => 'free' | 'slow' | 'quota' | ''
}) {
  return (
    <div className="seg">
      {props.options.map(o => (
        <button key={String(o)} className={o === props.value ? 'on' : ''} onClick={() => props.onChange(o)}>
          {props.label ? props.label(o) : String(o)}{props.mark && <FreeMark kind={props.mark(o)} />}
        </button>
      ))}
    </div>
  )
}

type MenuModel = Pick<ModelInfo, 'key' | 'name' | 'provider' | 'tag' | 'kind'> & Partial<Pick<ModelInfo, 'refs' | 'available' | 'free'>>

function ModelIcon({ model }: { model?: MenuModel }) {
  if (model?.provider === 'gpt' || model?.provider === 'chatgpt') return <RosetteIcon className="ico-model" />
  if (model?.provider === 'xyq' || model?.provider === 'libtv' || model?.provider === 'lovart') {
    return model.kind === 'image' ? <ImageIcon className="ico-model" /> : <VideoIcon className="ico-model" />
  }
  return <BananaIcon className="ico-model" />
}

/** Badge in the model list: 免费 (0 credits at every size), 部分免费 (some sizes) or ∞ 限免 (free in the queued unlimited-slow mode). */
function ModelFree({ free }: { free?: FreeInfo | null }) {
  if (!free) return null
  if (free.zero?.includes('*')) return <span className="model-tag free" title={FREE_TIP.free}>免费</span>
  if (!free.zero?.length && !free.slow && free.quota?.length) return <span className="model-tag free" title={`${free.quota.join('、')} 档位：${FREE_TIP.quota}`}>限量免费</span>
  if (free.zero?.length) return <span className="model-tag free" title={`${free.zero.join('、')} 档位 0 积分`}>部分免费</span>
  if (free.slow) {
    if (free.slow.extra?.length) {
      return <span className="model-tag free" title={`仅 ${free.slow.condition} 时无限低速免费；画板里还不能选画质，所以这里按正常价格收费。还剩 ${free.slow.days} 天`}>限免·有条件</span>
    }
    const c = free.slow.condition ? `（仅 ${free.slow.condition}）` : ''
    return <span className="model-tag free" title={`无限低速免费${c}，要排队等；还剩 ${free.slow.days} 天`}>∞ 限免</span>
  }
  return null
}

/** Model picker in the card's bottom bar: a button showing the current model, and a list that opens upwards with an icon, name, tag and check mark per model. */
function ModelMenu({ models, value, active, onPick, onOpen }: {
  models: MenuModel[]; value?: MenuModel; active: boolean; onPick: (key: string) => void; onOpen: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  useEffect(() => { if (!active) setOpen(false) }, [active])
  return (
    <div className="model-dd nodrag" ref={ref}>
      <button className={`model-btn${open ? ' open' : ''}`} title="选择模型" aria-haspopup="listbox" aria-expanded={open}
              onClick={() => { if (!open) onOpen(); setOpen(o => !o) }}>
        <ModelIcon model={value} />
        <span className="model-name">{value?.name ?? '…'}</span>
        <span className="caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="model-menu nowheel nopan nodrag" role="listbox">
          {models.map(m => (
            <button key={m.key} role="option" aria-selected={m.key === value?.key}
                    className={`model-item${m.key === value?.key ? ' on' : ''}`}
                    onClick={() => { onPick(m.key); setOpen(false) }}>
              <ModelIcon model={m} />
              <span className="model-name">{m.name}</span>
              <ModelFree free={m.free} />
              {m.available === false
                ? <span className="model-tag warn" title="这个来源现在不可用（聚合API里检查它的状态）">未连接</span>
                : m.tag && <span className="model-tag" title={m.refs === false ? '这个模型不能使用参考图' : undefined}>{m.tag}</span>}
              <span className="model-check">{m.key === value?.key ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function GenNode({ id, data, selected }: NodeProps<GenNodeType>) {
  const canvas = useCanvas()
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)
  const [popUp, setPopUp] = useState<number | null>(null) // bottom offset (px, canvas units) when the settings pop opens upwards
  const model = canvas.models.find(m => m.key === data.model) ?? canvas.models.find(m => m.legacy === data.model || (data.model === 'gpt-image' && m.provider === 'chatgpt')) ?? canvas.models[0]
  const running = data.jobs.some(j => !FINAL.has(j.status))
  const size = model?.sizes.includes(data.size) ? data.size : (model?.sizes[0] ?? data.size)   // what is shown is what is sent
  const quality = pickQuality(model, size, data.quality)
  const qOptions = qualityOptions(model, size)
  const refs = canvas.refCount(id)
  const sentCount = new Set(Array.from(data.prompt.matchAll(/<Picture\s+(\d+)>/gi), m => m[1])).size
  const patch = (p: Record<string, unknown>) => canvas.patchNode(id, p)
  // progress lives under each result placeholder; only a submit that failed before any job existed is shown here
  const visibleJobs = data.jobs.filter(j => j.id.startsWith('x') && j.status === 'failed')
  const noRefs = model?.refs === false && refs > 0   // the picked model cannot take the connected reference pictures
  const cloudModel = model?.provider === 'xyq' || model?.provider === 'libtv' || model?.provider === 'lovart'
  const [imgQuote, setImgQuote] = useState<VideoQuote | null | 'err'>(null)
  useEffect(() => {
    if (!cloudModel || !model) return
    let dead = false
    setImgQuote(null)
    const t = setTimeout(() => {
      api.videoQuote({ model: model.key, kind: 'image', resolution: size, duration: 0, sound: false, ratio: data.ratio, refer_image: false, quality })
        .then(q => { if (!dead) setImgQuote(q) }).catch(() => { if (!dead) setImgQuote('err') })
    }, 500)
    return () => { dead = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.key, size, quality, data.ratio])
  const canRun = !!data.prompt.trim() && !!model && !noRefs

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!popRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  useEffect(() => { if (!selected) setOpen(false) }, [selected])
  // Open downwards by default; when the bottom of the window (dock included) is too close, open upwards from the summary bar.
  useLayoutEffect(() => {
    setPopUp(null)
    if (!open) return
    const pop = popRef.current
    const card = pop?.parentElement
    const sum = card?.querySelector('.summary')
    if (!pop || !card || !sum) return
    pop.style.bottom = ''
    const pr = pop.getBoundingClientRect(), cr = card.getBoundingClientRect(), sr = sum.getBoundingClientRect()
    const scale = cr.height / Math.max(1, (card as HTMLElement).offsetHeight) || 1
    const reserve = 90 // the floating dock
    const below = innerHeight - reserve - pr.top
    const above = sr.top - 8
    if (pr.height > below && above > below) setPopUp((cr.bottom - sr.top) / scale + 8)
  }, [open])

  const pickModel = (key: string) => {
    const next = canvas.models.find(m => m.key === key)
    if (!next) return
    patch({
      model: next.key,
      ratio: next.ratios.includes(data.ratio) ? data.ratio : next.ratios[0],
      size: next.sizes.includes(data.size) ? data.size : next.sizes[0],
      quality: pickQuality(next, next.sizes.includes(data.size) ? data.size : next.sizes[0], data.quality),
    })
  }

  return (
    <>
    <NodeResizer minWidth={300} minHeight={220} isVisible={selected} lineClassName="rz-line" handleClassName="rz-handle" />
    <div className={`card gen${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="card-head">
        <span className="node-title"><BananaIcon className="ico-banana" />图片生成{refs > 0 ? ` · 参考图 ${refs}${data.onlyRefs ? ` · 发送 ${sentCount}` : ''}` : ''}</span>
        <button className="icon nodrag copy-btn" title="复制卡片（Ctrl+D；按住 Alt 拖动卡片也可复制），保留参考引用线" onClick={() => canvas.duplicate(id)}>⧉</button>
      </div>
      <PromptEditor
        value={data.prompt} refs={canvas.refsOf(id)} onChange={v => patch({ prompt: v })}
        onSubmit={() => { if (canRun) canvas.generate(id) }}
      />
      <div className="foot nodrag">
        <button className={`summary${open ? " open" : ""}`} onClick={() => setOpen(o => !o)} title="图像设置">
          {data.ratio} · {size}{quality ? ` · ${QUALITY_ZH[quality] ?? quality}` : ''} · {data.count} 张 <span className="caret">▾</span>
        </button>
        <ModelMenu models={canvas.models} value={model} active={!!selected} onPick={pickModel} onOpen={() => setOpen(false)} />
        {running && <button onClick={() => canvas.cancelJobs(id)}>取消</button>}
        <button className="primary has-cost" disabled={!canRun || canvas.submitting.has(id)} onClick={() => canvas.generate(id)}>
          <span className="lbl"><SparkleIcon className="ico-spark" />{canvas.submitting.has(id) ? '提交中…' : '生成'}</span>
          {cloudModel && <CostChip quote={imgQuote} count={data.count} />}
        </button>
      </div>
      {open && (
        <div className={`pop nodrag nowheel nopan${popUp !== null ? " up" : ""}`} ref={popRef}
             style={popUp !== null ? { top: "auto", bottom: popUp } : undefined}>
          <div className="pop-title">图像设置</div>
          <div className="pop-label">宽高比</div>
          <div className="ratios">
            {(model?.ratios ?? []).map(r => (
              <button key={r} className={r === data.ratio ? 'on' : ''} onClick={() => patch({ ratio: r })}>
                <RatioGlyph ratio={r} /><span>{r}</span>
              </button>
            ))}
          </div>
          <div className="pop-label">分辨率</div>
          <Segmented options={model?.sizes ?? []} value={size} onChange={v => patch({ size: v, quality: pickQuality(model, String(v), data.quality) })}
                     mark={v => freeKind(model?.free, String(v), quality)} />
          {qOptions.length > 0 && (<>
            <div className="pop-label">画质</div>
            <Segmented options={qOptions} value={quality} onChange={v => patch({ quality: v })} label={v => QUALITY_ZH[v] ?? v}
                       mark={v => freeKind(model?.free, size, v)} />
          </>)}
          {refs > 0 && (<>
            <div className="pop-label">参考图</div>
            <button className={`pop-toggle${data.onlyRefs ? ' on' : ''}`} onClick={() => patch({ onlyRefs: !data.onlyRefs })}
                    title="打开后，只把提示词里 @ 引用的图发给生成服务；没引用的图不发送">
              <span className="box">{data.onlyRefs ? '✓' : ''}</span>仅发送引用的图
            </button>
          </>)}
          {canvas.maxCount > 1 && (<>
            <div className="pop-label">一次生成</div>
            <Segmented options={Array.from({ length: canvas.maxCount }, (_, i) => i + 1)} value={data.count}
                       onChange={v => patch({ count: v })} label={n => `${n} 张`} />
          </>)}
        </div>
      )}
      {(data.notice || noRefs || visibleJobs.length > 0) && (
        <div className="status-out nodrag nowheel">
          {data.notice && <div className="hint warn">{data.notice}</div>}
          {noRefs && <div className="hint warn">{model?.name} 暂不支持参考图：请断开参考图连线，或换一个模型</div>}
          {visibleJobs.length > 0 && (
            <ul className="jobs">
              {visibleJobs.map(j => (
                <li key={j.id} className={j.status}>{j.error || '失败'}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
    </>
  )
}

export function ImageNode({ data, selected }: NodeProps<ImageNodeType>) {
  const canvas = useCanvas()
  if (data.pending) {
    const failed = data.status === 'failed'
    return (
      <>
        <div className={`card image pending${failed ? ' failed' : ''}${selected ? ' selected' : ''}`}>
          <Handle type="target" position={Position.Left} />
          <div className="shimmer" />
          <Handle type="source" position={Position.Right} />
        </div>
        <div className={`status-out nodrag${failed ? ' err' : ''}`}>
          {failed ? (data.error || '失败') : (data.progress || (data.status === 'queued' ? '排队中' : '生成中'))}
        </div>
      </>
    )
  }
  return (
    <>
    <NodeResizer minWidth={120} keepAspectRatio isVisible={selected} lineClassName="rz-line" handleClassName="rz-handle" />
    <div className={`card image${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <img
        className="nodrag-img" draggable={false} src={assetUrl(data.assetId, 1280)}
        alt="" onDoubleClick={() => canvas.preview(data.assetId)}
      />
      <div className="img-meta"><ImageIcon className="ico-image" /> {data.w} × {data.h}</div>
      {data.label && <div className="img-label" title={`由 ${data.label} 生成`}>{data.label}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
    </>
  )
}

// ---------------------------------------------------------------- video generation (terry2api: 小云雀 / LibTV / Lovart)
type VideoList = { enabled: boolean; models: VideoModel[]; errors: Record<string, string>; locked?: boolean }
let videoModelsCache: Promise<VideoList> | null = null
const loadVideoModels = (force = false) => {
  if (!videoModelsCache || force) {
    videoModelsCache = api.videoModels()
    videoModelsCache.catch(() => { videoModelsCache = null })
  }
  return videoModelsCache
}
const videoInfoCache = new Map<string, Promise<VideoModelInfo>>()
const loadVideoInfo = (model: VideoModel) => {
  if (model.info) return Promise.resolve(model.info)   // 小云雀 sends its options along with the list
  let p = videoInfoCache.get(model.key)
  if (!p) {
    p = api.videoModelInfo(model.key)
    videoInfoCache.set(model.key, p)
    p.catch(() => videoInfoCache.delete(model.key))
  }
  return p
}

/** Seconds the model offers: a fixed list, or a range; null when the model does not say (the card then sends 0 = default). */
function durationChoices(info?: VideoModelInfo | null): number[] | null {
  const d = info?.durations
  if (!d) return null
  if (d.options?.length) return d.options
  if (d.min != null && d.max != null) {
    const step = Math.max(1, d.step || 1)
    const out: number[] = []
    for (let v = d.min; v <= d.max && out.length < 40; v += step) out.push(v)
    return out
  }
  return null
}

const DEFAULT_VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

export function VideoGenNode({ id, data, selected }: NodeProps<VGenNodeType>) {
  const canvas = useCanvas()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<VideoList | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [info, setInfo] = useState<VideoModelInfo | null>(null)
  const [quote, setQuote] = useState<VideoQuote | null | 'err'>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [popUp, setPopUp] = useState<number | null>(null)
  const models = list?.models ?? []
  const model = models.find(m => m.key === data.model) ?? models[0]
  const running = data.jobs.some(j => !FINAL.has(j.status))
  const refs = canvas.refCount(id)
  const sentCount = new Set(Array.from(data.prompt.matchAll(/<Picture\s+(\d+)>/gi), m => m[1])).size
  const patch = (p: Record<string, unknown>) => canvas.patchNode(id, p)
  const visibleJobs = data.jobs.filter(j => j.id.startsWith('x') && j.status === 'failed')
  const canRun = (!!data.prompt.trim() || refs > 0) && !!model

  const refresh = (force = false) => {
    setLoadErr('')
    loadVideoModels(force).then(setList).catch(e => setLoadErr(String(e.message || e)))
  }
  useEffect(() => { refresh() }, [])
  // pick the first model when the card has none (or its model vanished), and read what the model offers
  useEffect(() => {
    if (!model) return
    if (model.key !== data.model) patch({ model: model.key })
    let dead = false
    setInfo(null)
    loadVideoInfo(model).then(i => { if (!dead) setInfo(i) }).catch(() => { if (!dead) setInfo({ ratios: [], resolutions: [], sound: false, durations: null }) })
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.key])
  // keep the settings inside what the model offers
  useEffect(() => {
    if (!info) return
    const fix: Record<string, unknown> = {}
    const ratios = info.ratios.length ? info.ratios : DEFAULT_VIDEO_RATIOS
    if (!ratios.includes(data.ratio)) fix.ratio = (info.default_ratio && ratios.includes(info.default_ratio)) ? info.default_ratio : ratios[0]
    if (info.resolutions.length && !info.resolutions.includes(data.resolution)) {
      fix.resolution = info.default_resolution && info.resolutions.includes(info.default_resolution) ? info.default_resolution : info.resolutions[0]
    }
    if (!info.resolutions.length && data.resolution) fix.resolution = ''
    const du = durationChoices(info)
    if (du && data.duration && !du.includes(data.duration)) fix.duration = 0
    if (Object.keys(fix).length) patch(fix)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info])

  // credits one video will cost with these settings (asked from the platform through terry2api; read-only)
  useEffect(() => {
    if (!model || !info) return
    let dead = false
    setQuote(null)
    const t = setTimeout(() => {
      api.videoQuote({ model: model.key, resolution: data.resolution, duration: data.duration || 0, sound: data.sound, ratio: data.ratio, refer_image: refs > 0 })
        .then(q => { if (!dead) setQuote(q) }).catch(() => { if (!dead) setQuote('err') })
    }, 500)
    return () => { dead = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.key, info, data.resolution, data.duration, data.sound, data.ratio, refs > 0])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!popRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  useEffect(() => { if (!selected) setOpen(false) }, [selected])

  // open downwards by default; when the bottom of the window (dock included) is too close, open upwards from the summary bar
  useLayoutEffect(() => {
    setPopUp(null)
    if (!open) return
    const pop = popRef.current
    const card = pop?.parentElement
    const sum = card?.querySelector('.summary')
    if (!pop || !card || !sum) return
    pop.style.bottom = ''
    const pr = pop.getBoundingClientRect(), cr = card.getBoundingClientRect(), sr = sum.getBoundingClientRect()
    const scale = cr.height / Math.max(1, (card as HTMLElement).offsetHeight) || 1
    const below = innerHeight - 90 - pr.top
    const above = sr.top - 8
    if (pr.height > below && above > below) setPopUp((cr.bottom - sr.top) / scale + 8)
  }, [open])

  const ratios = info?.ratios.length ? info.ratios : DEFAULT_VIDEO_RATIOS
  const durations = durationChoices(info)
  const defaultDur = (() => {
    const d = info?.durations?.default
    const n = typeof d === 'string' ? Number(d) : d
    return n && durations?.includes(n) ? n : durations?.[0] ?? 0
  })()
  const shownDur = data.duration || defaultDur
  const durIndex = Math.max(0, durations ? durations.indexOf(shownDur) : 0)
  const modeHint = refs === 0 ? '文生视频' : data.mode === 'reference' ? `参考图 ${refs}` : refs === 1 ? '首帧' : refs === 2 ? '首尾帧' : `参考图 ${refs}`
  const summary = [data.ratio, data.resolution, data.duration ? `${data.duration}秒` : '', data.count > 1 ? `${data.count} 条` : ''].filter(Boolean).join(' · ')

  return (
    <>
    <NodeResizer minWidth={300} minHeight={220} isVisible={selected} lineClassName="rz-line" handleClassName="rz-handle" />
    <div className={`card gen vgen${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="card-head">
        <span className="node-title"><VideoIcon className="ico-banana" />视频生成 · {modeHint}{refs > 0 && data.onlyRefs ? ` · 发送 ${sentCount}` : ''}</span>
      </div>
      <PromptEditor
        value={data.prompt} refs={canvas.refsOf(id)} onChange={v => patch({ prompt: v })}
        onSubmit={() => { if (canRun) canvas.generateVideo(id) }}
      />
      <div className="foot nodrag">
        <button className={`summary${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)} title="视频设置">
          {summary || '设置'} <span className="caret">▾</span>
        </button>
        <ModelMenu models={models} value={model} active={!!selected} onPick={key => patch({ model: key })} onOpen={() => { setOpen(false); refresh(true) }} />
        {running && <button onClick={() => canvas.cancelJobs(id)}>取消</button>}
        <button className="primary has-cost" disabled={!canRun || canvas.submitting.has(id)} onClick={() => canvas.generateVideo(id)}>
          <span className="lbl"><SparkleIcon className="ico-spark" />{canvas.submitting.has(id) ? '提交中…' : '生成'}</span>
          <CostChip quote={quote} count={data.count} />
        </button>
      </div>
      {open && (
        <div className={`pop vpop nodrag nowheel nopan${popUp !== null ? ' up' : ''}`} ref={popRef}
             style={popUp !== null ? { top: 'auto', bottom: popUp } : undefined}>
          <div className="pop-title">视频设置</div>
          <div className="pop-label">宽高比</div>
          <div className="ratios">
            {ratios.map(r => {
              const auto = /^(adaptive|auto)$/i.test(r)
              return (
                <button key={r} className={r === data.ratio ? 'on' : ''} onClick={() => patch({ ratio: r })}>
                  {!auto && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(r) ? <RatioGlyph ratio={r} /> : <span className="glyph-none" />}<span>{auto ? 'Auto' : r}</span>
                </button>
              )
            })}
          </div>
          {durations && durations.length > 1 && (<>
            <div className="pop-row"><span className="pop-label">时长</span><b>{shownDur}s</b></div>
            <input className="slider" type="range" min={0} max={durations.length - 1} step={1} value={durIndex}
                   onChange={e => patch({ duration: durations[Number(e.target.value)] })} />
          </>)}
          {!!info?.resolutions.length && (<>
            <div className="pop-label">分辨率</div>
            <div className="pills">
              {info.resolutions.map(r => (
                <button key={r} className={r === data.resolution ? 'on' : ''} onClick={() => patch({ resolution: r })}>{r}<FreeMark kind={freeKind(model?.free, r)} /></button>
              ))}
            </div>
          </>)}
          {info?.sound && (
            <div className="pop-row">
              <span className="pop-label">音频</span>
              <button className={`switch${data.sound ? ' on' : ''}`} role="switch" aria-checked={data.sound} onClick={() => patch({ sound: !data.sound })}><i /></button>
            </div>
          )}
          {refs > 0 && (<>
            <div className="pop-label">参考图用法</div>
            <Segmented options={['auto', 'reference'] as const} value={data.mode} onChange={v => patch({ mode: v })}
                       label={v => (v === 'auto' ? '自动（首帧/首尾帧）' : '全部作参考图')} />
            <div className="hint">自动：1 张 = 首帧，2 张 = 首尾帧，3 张以上 = 参考图</div>
            <div className="pop-row">
              <span className="pop-label" title="打开后，只把提示词里 @ 引用的图发给生成服务；没引用的图不发送">仅发送引用的图</span>
              <button className={`switch${data.onlyRefs ? ' on' : ''}`} role="switch" aria-checked={!!data.onlyRefs} onClick={() => patch({ onlyRefs: !data.onlyRefs })}><i /></button>
            </div>
          </>)}
          <div className="pop-label">一次生成</div>
          <Segmented options={[1, 2, 3, 4]} value={data.count} onChange={v => patch({ count: v })} label={n => `${n} 条`} />
        </div>
      )}
      {(data.notice || loadErr || (list && !list.enabled) || (list?.enabled && !models.length) || visibleJobs.length > 0) && (
        <div className="status-out nodrag nowheel">
          {data.notice && <div className="hint warn">{data.notice}</div>}
          {loadErr && <div className="hint warn">无法读取视频模型：{loadErr}</div>}
          {list && !list.enabled && <div className="hint warn">服务器没有配置云端生成服务（config.json 的 cloud_base_url）</div>}
          {list?.enabled && !models.length && list.locked && (
            <div className="hint warn">视频生成会消耗积分：需要管理员在控制台给你开通「积分模型」</div>
          )}
          {list?.enabled && !models.length && !list.locked && (
            <div className="hint warn">云端服务里没有可用的视频模型{Object.keys(list.errors).length ? `：${Object.values(list.errors).join('；')}` : '，请先在 terry2api 里配置平台'}</div>
          )}
          {visibleJobs.length > 0 && (
            <ul className="jobs">{visibleJobs.map(j => <li key={j.id} className={j.status}>{j.error || '失败'}</li>)}</ul>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
    </>
  )
}

export function VideoNode({ data, selected }: NodeProps<VideoNodeType>) {
  if (data.pending) {
    const failed = data.status === 'failed'
    return (
      <>
        <div className={`card image video pending${failed ? ' failed' : ''}${selected ? ' selected' : ''}`}>
          <Handle type="target" position={Position.Left} />
          <div className="shimmer" />
          <Handle type="source" position={Position.Right} />
        </div>
        <div className={`status-out nodrag${failed ? ' err' : ''}`}>
          {failed ? (data.error || '失败') : (data.progress || (data.status === 'queued' ? '排队中' : '生成中'))}
        </div>
      </>
    )
  }
  return (
    <>
    <NodeResizer minWidth={200} keepAspectRatio isVisible={selected} lineClassName="rz-line" handleClassName="rz-handle" />
    <div className={`card image video${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <video className="nodrag nowheel video-el" src={assetUrl(data.assetId)} controls loop playsInline preload="metadata" />
      <div className="img-meta">
        <VideoIcon className="ico-image" /> 视频
        <a className="dl nodrag" href={downloadUrl(data.assetId)} title="下载视频">下载</a>
      </div>
      {data.label && <div className="img-label top" title={`由 ${data.label} 生成`}>{data.label}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
    </>
  )
}

export const nodeTypes = { gen: GenNode, image: ImageNode, refset: RefsetNode, vgen: VideoGenNode, video: VideoNode }
