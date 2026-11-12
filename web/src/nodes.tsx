import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { assetUrl } from './api'
import { useCanvas } from './CanvasContext'
import { BananaIcon, ImageIcon, SparkleIcon } from './icons'
import PromptEditor from './PromptEditor'
import { RefsetNode } from './RefsetNode'
import { type GenNodeType, type ImageNodeType } from './types'

const FINAL = new Set(['done', 'failed', 'cancelled'])

/** Tiny aspect-ratio glyph for the ratio grid. */
function RatioGlyph({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(':').map(Number)
  const max = 16
  const k = max / Math.max(w, h)
  return <span className="glyph" style={{ width: Math.round(w * k), height: Math.round(h * k) }} />
}

function Segmented<T extends string | number>(props: {
  options: T[]; value: T; onChange: (v: T) => void; label?: (v: T) => string
}) {
  return (
    <div className="seg">
      {props.options.map(o => (
        <button key={String(o)} className={o === props.value ? 'on' : ''} onClick={() => props.onChange(o)}>
          {props.label ? props.label(o) : String(o)}
        </button>
      ))}
    </div>
  )
}

export function GenNode({ id, data, selected }: NodeProps<GenNodeType>) {
  const canvas = useCanvas()
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)
  const [popUp, setPopUp] = useState<number | null>(null) // bottom offset (px, canvas units) when the settings pop opens upwards
  const model = canvas.models.find(m => m.key === data.model) ?? canvas.models[0]
  const running = data.jobs.some(j => !FINAL.has(j.status))
  const refs = canvas.refCount(id)
  const patch = (p: Record<string, unknown>) => canvas.patchNode(id, p)
  // progress lives under each result placeholder; only a submit that failed before any job existed is shown here
  const visibleJobs = data.jobs.filter(j => j.id.startsWith('x') && j.status === 'failed')
  const canRun = !!data.prompt.trim() && !running && !!model

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
    })
  }

  return (
    <>
    <NodeResizer minWidth={300} minHeight={220} isVisible={selected} lineClassName="rz-line" handleClassName="rz-handle" />
    <div className={`card gen${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="card-head">
        <span className="node-title"><BananaIcon className="ico-banana" />生成卡片{refs > 0 ? ` · 参考图 ${refs}` : ''}</span>
      </div>
      <PromptEditor
        value={data.prompt} refs={canvas.refsOf(id)} onChange={v => patch({ prompt: v })}
        onSubmit={() => { if (canRun) canvas.generate(id) }}
      />
      <div className="foot nodrag">
        <button className={`summary${open ? " open" : ""}`} onClick={() => setOpen(o => !o)} title="图像设置">
          {model?.name ?? '…'} · {data.ratio} · {data.size} · {data.count} 张 <span className="caret">▾</span>
        </button>
        {running && <button onClick={() => canvas.cancelJobs(id)}>取消</button>}
        <button className="primary" disabled={!canRun} onClick={() => canvas.generate(id)}>
          <SparkleIcon className="ico-spark" />{running ? '生成中…' : '生成'}
        </button>
      </div>
      {open && (
        <div className={`pop nodrag nowheel nopan${popUp !== null ? " up" : ""}`} ref={popRef}
             style={popUp !== null ? { top: "auto", bottom: popUp } : undefined}>
          <div className="pop-title">图像设置</div>
          <div className="pop-label">模型</div>
          <div className="models">
            {canvas.models.map(m => (
              <button key={m.key} className={m.key === model?.key ? 'on' : ''} onClick={() => pickModel(m.key)}>{m.name}</button>
            ))}
          </div>
          <div className="pop-label">宽高比</div>
          <div className="ratios">
            {(model?.ratios ?? []).map(r => (
              <button key={r} className={r === data.ratio ? 'on' : ''} onClick={() => patch({ ratio: r })}>
                <RatioGlyph ratio={r} /><span>{r}</span>
              </button>
            ))}
          </div>
          <div className="pop-label">分辨率</div>
          <Segmented options={model?.sizes ?? []} value={data.size} onChange={v => patch({ size: v })} />
          {canvas.maxCount > 1 && (<>
            <div className="pop-label">一次生成</div>
            <Segmented options={Array.from({ length: canvas.maxCount }, (_, i) => i + 1)} value={data.count}
                       onChange={v => patch({ count: v })} label={n => `${n} 张`} />
          </>)}
        </div>
      )}
      {(data.notice || visibleJobs.length > 0) && (
        <div className="status-out nodrag nowheel">
          {data.notice && <div className="hint warn">{data.notice}</div>}
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
      <Handle type="source" position={Position.Right} />
    </div>
    </>
  )
}

export const nodeTypes = { gen: GenNode, image: ImageNode, refset: RefsetNode }
