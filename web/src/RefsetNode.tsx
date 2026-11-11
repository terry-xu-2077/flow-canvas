import { useRef, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { api, assetUrl } from './api'
import { useCanvas } from './CanvasContext'
import { CollectionIcon } from './icons'
import type { RefsetNodeType, Slot } from './types'

const uid = () => `s${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`
const isImage = (f: File) => f.type.startsWith('image/')

/** A reference collection: ordered image slots wired as one block into any number of generation cards. */
export function RefsetNode({ id, data, selected }: NodeProps<RefsetNodeType>) {
  const canvas = useCanvas()
  const { deleteElements } = useReactFlow()
  const fileInput = useRef<HTMLInputElement>(null)
  const pickFor = useRef<string | null>(null)
  const dragId = useRef<string | null>(null)
  const [busy, setBusy] = useState(0)
  const [overSlot, setOverSlot] = useState<string | null>(null)
  const slots = data.slots
  const filledCount = slots.filter(s => s.assetId).length

  /** Upload files in order; the first one fills `startSlot` when it is an empty slot, the rest become new slots. */
  const addFiles = async (files: File[], startSlot?: string | null) => {
    const images = files.filter(isImage)
    let target = startSlot ?? null
    for (const file of images) {
      setBusy(b => b + 1)
      try {
        const info = await api.uploadAsset(file)
        const fill = { assetId: info.id, w: info.w, h: info.h, name: file.name }
        if (target) {
          const slotId = target
          canvas.editSlots(id, ss => ss.map(s => (s.id === slotId && !s.assetId ? { ...s, ...fill } : s)))
          target = null
        } else {
          canvas.editSlots(id, ss => [...ss, { id: uid(), ...fill }])
        }
      } catch (e) {
        alert(`上传失败：${(e as Error).message}`)
      } finally {
        setBusy(b => b - 1)
      }
    }
  }

  const remove = (slot: Slot) => {
    // first click empties the slot (the numbering of the others stays), second click removes the empty slot
    canvas.editSlots(id, ss => (slot.assetId
      ? ss.map(s => (s.id === slot.id ? { id: s.id } : s))
      : ss.filter(s => s.id !== slot.id)))
  }

  const move = (from: string, to: string) => {
    if (from === to) return
    canvas.editSlots(id, ss => {
      const a = ss.findIndex(s => s.id === from)
      const b = ss.findIndex(s => s.id === to)
      if (a < 0 || b < 0) return ss
      const next = [...ss]
      const [item] = next.splice(a, 1)
      next.splice(b, 0, item)
      return next
    })
  }

  const onDropOnSlot = (e: React.DragEvent, slot: Slot) => {
    e.preventDefault()
    e.stopPropagation()
    setOverSlot(null)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) { void addFiles(files, slot.assetId ? null : slot.id); return }
    if (dragId.current) move(dragId.current, slot.id)
    dragId.current = null
  }

  return (
    <>
      <NodeResizer minWidth={300} minHeight={120} isVisible={selected} lineClassName="rz-line" handleClassName="rz-handle" />
      <div
        className={`card refset${selected ? ' selected' : ''}`}
        onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation() } }}
        onDrop={e => {
          const files = Array.from(e.dataTransfer.files)
          if (files.length) { e.preventDefault(); e.stopPropagation(); void addFiles(files) }
        }}
      >
        <div className="rs-head">
          <button className="icon nodrag" title={data.collapsed ? '展开' : '收起'}
                  onClick={() => canvas.patchNode(id, { collapsed: !data.collapsed })}>{data.collapsed ? '▸' : '▾'}</button>
          <CollectionIcon className="ico-collection" />
          <strong>参考集合</strong>
          <span className="rs-count">{filledCount} 张{busy ? ` · 上传中 ${busy}` : ''}</span>
          <span className="grow" />
          <button className="nodrag" title="解散集合：拆成独立的图片节点，连线和提示词里的编号保持不变"
                  onClick={() => canvas.dissolve(id)}>解散</button>
          {!data.collapsed && (
            <button className="nodrag" title="添加空槽位" onClick={() => canvas.editSlots(id, ss => [...ss, { id: uid() }])}>＋</button>
          )}
          <button className="icon nodrag" title="删除集合" onClick={() => deleteElements({ nodes: [{ id }] })}>✕</button>
        </div>
        {!data.collapsed && (
          <div className="rs-grid nowheel">
            {slots.map((slot, idx) => {
              return (
                <div
                  key={slot.id} draggable={!!slot.assetId}
                  className={`rs-slot nodrag${slot.assetId ? '' : ' rs-empty'}${overSlot === slot.id ? ' over' : ''}`}
                  onDragStart={e => { dragId.current = slot.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-slot', slot.id) }}
                  onDragEnd={() => { dragId.current = null; setOverSlot(null) }}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); setOverSlot(slot.id) }}
                  onDragLeave={() => setOverSlot(o => (o === slot.id ? null : o))}
                  onDrop={e => onDropOnSlot(e, slot)}
                >
                  <div className="rs-tag">{slot.assetId ? `图片 ${idx + 1}` : `槽位 ${idx + 1}`}</div>
                  {slot.assetId ? (
                    <img src={assetUrl(slot.assetId, 320)} alt="" draggable={false} title="双击大图预览；拖动可调整顺序"
                         onDoubleClick={() => canvas.preview(slot.assetId!)} />
                  ) : (
                    <button className="rs-add" title="点击选择图片，也可以把图片拖到这里"
                            onClick={() => { pickFor.current = slot.id; fileInput.current?.click() }}>＋</button>
                  )}
                  <div className="rs-cap" title={slot.name}>{slot.assetId ? (slot.name ?? `${slot.w} × ${slot.h}`) : '点击添加'}</div>
                  <button className="rs-x icon" title={slot.assetId ? '清空图片（保留槽位）' : '移除空槽位'} onClick={() => remove(slot)}>✕</button>
                </div>
              )
            })}
            {slots.length === 0 && <div className="hint rs-hint">点「＋」添加槽位，或直接把图片拖到这里</div>}
          </div>
        )}
        <input ref={fileInput} type="file" accept="image/*" multiple hidden
               onChange={e => { void addFiles(Array.from(e.target.files ?? []), pickFor.current); pickFor.current = null; e.target.value = '' }} />
        <Handle type="source" position={Position.Right} />
      </div>
    </>
  )
}
