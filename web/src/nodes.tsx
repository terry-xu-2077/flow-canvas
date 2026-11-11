import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { assetUrl, downloadUrl } from './api'
import { useCanvas } from './CanvasContext'
import { IMAGE_WIDTH, type GenNodeType, type ImageNodeType } from './types'

const FINAL = new Set(['done', 'failed', 'cancelled'])

export function GenNode({ id, data, selected }: NodeProps<GenNodeType>) {
  const canvas = useCanvas()
  const { deleteElements } = useReactFlow()
  const model = canvas.models.find(m => m.key === data.model) ?? canvas.models[0]
  const running = data.jobs.some(j => !FINAL.has(j.status))
  const refs = canvas.refCount(id)
  const patch = (p: Record<string, unknown>) => canvas.patchNode(id, p)
  const visibleJobs = data.jobs.filter(j => !FINAL.has(j.status) || j.status === 'failed')

  return (
    <div className={`card gen${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="card-head">
        <span>生成卡片</span>
        <button className="icon nodrag" title="删除卡片" onClick={() => deleteElements({ nodes: [{ id }] })}>✕</button>
      </div>
      <textarea
        className="nodrag nowheel" rows={4} placeholder="描述你想生成的画面…"
        value={data.prompt} onChange={e => patch({ prompt: e.target.value })}
      />
      <div className="row nodrag">
        <select value={model?.key ?? ''} onChange={e => {
          const next = canvas.models.find(m => m.key === e.target.value)
          if (!next) return
          patch({
            model: next.key,
            ratio: next.ratios.includes(data.ratio) ? data.ratio : next.ratios[0],
            size: next.sizes.includes(data.size) ? data.size : next.sizes[0],
          })
        }}>
          {canvas.models.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
      </div>
      <div className="row nodrag">
        <select value={data.ratio} onChange={e => patch({ ratio: e.target.value })}>
          {(model?.ratios ?? [data.ratio]).map(r => <option key={r}>{r}</option>)}
        </select>
        <select value={data.size} onChange={e => patch({ size: e.target.value })}>
          {(model?.sizes ?? [data.size]).map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={data.count} title="一次生成几张" onChange={e => patch({ count: Number(e.target.value) })}>
          {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 张</option>)}
        </select>
      </div>
      <div className="hint">{refs > 0 ? `参考图 ${refs} 张` : '把图片的右侧圆点拖线到本卡片左侧，即可作为参考图'}</div>
      <div className="row nodrag">
        <button className="primary" disabled={!data.prompt.trim() || running || !model} onClick={() => canvas.generate(id)}>
          {running ? '生成中…' : '生成'}
        </button>
        {running && <button onClick={() => canvas.cancelJobs(id)}>取消</button>}
      </div>
      {visibleJobs.length > 0 && (
        <ul className="jobs">
          {visibleJobs.map(j => (
            <li key={j.id} className={j.status}>
              {j.status === 'failed' ? `❌ ${j.error || '失败'}` : `⏳ ${j.progress || (j.status === 'queued' ? '排队中…' : '生成中…')}`}
            </li>
          ))}
        </ul>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export function ImageNode({ id, data, selected }: NodeProps<ImageNodeType>) {
  const canvas = useCanvas()
  const { deleteElements } = useReactFlow()
  const height = Math.round((IMAGE_WIDTH * data.h) / data.w)
  return (
    <div className={`card image${selected ? ' selected' : ''}`} style={{ width: IMAGE_WIDTH }}>
      <Handle type="target" position={Position.Left} />
      <img
        className="nodrag-img" draggable={false} src={assetUrl(data.assetId, 640)}
        width={IMAGE_WIDTH} height={height} alt="" onDoubleClick={() => canvas.preview(data.assetId)}
      />
      <div className="img-bar nodrag">
        <button title="以此图为参考，新建生成卡片" onClick={() => canvas.continueFrom([id], 'together')}>继续生成</button>
        <button title="大图预览（双击图片也可）" onClick={() => canvas.preview(data.assetId)}>预览</button>
        <a title="下载原图" href={downloadUrl(data.assetId)}>下载</a>
        <button className="icon" title="删除" onClick={() => deleteElements({ nodes: [{ id }] })}>✕</button>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export const nodeTypes = { gen: GenNode, image: ImageNode }
