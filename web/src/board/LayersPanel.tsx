import { memo } from 'react'
import { Panel } from '@xyflow/react'
import { assetUrl } from '../api'
import { BananaIcon, CollectionIcon, ImageIcon, VideoIcon } from '../icons'
import type { CanvasNode, GenNodeType, ImageNodeType, RefsetNodeType, VGenNodeType, VideoNodeType } from '../types'

/** What a row of the layers panel shows, as plain values so that unchanged rows skip rendering while nodes are dragged. */
function layerInfo(n: CanvasNode) {
  const base = { id: n.id, selected: !!n.selected }
  if (n.type === 'gen') return { ...base, kind: 'gen', text: ((n as GenNodeType).data.prompt || '空').slice(0, 16), thumb: '' }
  if (n.type === 'vgen') return { ...base, kind: 'vgen', text: ((n as VGenNodeType).data.prompt || '空').slice(0, 16), thumb: '' }
  if (n.type === 'video') return { ...base, kind: 'video', text: (n as VideoNodeType).data.pending ? '视频 · 生成中' : '视频', thumb: '' }
  if (n.type === 'refset') {
    const slots = (n as RefsetNodeType).data.slots
    return { ...base, kind: 'refset', text: `参考集合 · ${slots.filter(s => s.assetId).length} 张`, thumb: slots.find(s => s.assetId)?.assetId ?? '' }
  }
  const d = (n as ImageNodeType).data
  return { ...base, kind: 'image', text: d.pending ? '图片 · 生成中' : `图片 · ${d.w}×${d.h}`, thumb: d.assetId || '' }
}

const LayerRow = memo(function LayerRow({ id, selected, kind, text, thumb, onFocus }:
  ReturnType<typeof layerInfo> & { onFocus: (id: string) => void }) {
  const pic = thumb ? <img className="layer-thumb" src={assetUrl(thumb, 96)} alt="" draggable={false} /> : null
  const icon = kind === 'gen' ? <BananaIcon className="ico-banana" />
    : kind === 'vgen' ? <VideoIcon className="ico-banana" />
    : kind === 'video' ? <VideoIcon className="ico-image" />
    : kind === 'refset' ? (pic ?? <CollectionIcon className="ico-collection" />)
    : (pic ?? <ImageIcon className="ico-image" />)
  const label = kind === 'gen' ? `图片生成 · ${text}` : kind === 'vgen' ? `视频生成 · ${text}` : text
  return <li className={selected ? 'on' : ''} onClick={() => onFocus(id)}>{icon} {label}</li>
})

export function LayersPanel({ nodes, onClose, onFocus }: { nodes: CanvasNode[]; onClose: () => void; onFocus: (id: string) => void }) {
  return (
    <Panel position="top-right" className="layers">
      <div className="layers-head"><strong>图层</strong>
        <button className="icon" onClick={onClose}>✕</button></div>
      {nodes.length === 0 && <div className="hint">画布上还没有内容</div>}
      <ul>
        {[...nodes].reverse().map(n => <LayerRow key={n.id} {...layerInfo(n)} onFocus={onFocus} />)}
      </ul>
    </Panel>
  )
}
