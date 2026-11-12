import { useEffect, useRef, useState } from 'react'
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
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => { if (!menuRoot.current?.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])
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
          <CollectionIcon className="ico-collection" />
          <strong>参考集合</strong>
          <span className="rs-count">{filledCount} 张{busy ? ` · 上传中 ${busy}` : ''}</span>
          <span className="grow" />
          <div className="rs-menu-wrap nodrag" ref={menuRoot}>
            <button className={`icon rs-more${menuOpen ? ' open' : ''}`} title="更多" onClick={() => setMenuOpen(o => !o)}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><circle cx="8" cy="3" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="8" cy="13" r="1.5" /></svg>
            </button>
            {menuOpen && (
              <div className="rs-menu">
                <button onClick={() => { setMenuOpen(false); canvas.editSlots(id, ss => [...ss, { id: uid() }]) }}>添加空槽位</button>
                <button title="拆成独立的图片节点，连线和提示词里的编号保持不变" onClick={() => { setMenuOpen(false); canvas.dissolve(id) }}>解散集合</button>
                <button className="danger" onClick={() => { setMenuOpen(false); deleteElements({ nodes: [{ id }] }) }}>删除集合</button>
              </div>
            )}
          </div>
        </div>
        {(
          <div className="rs-grid nowheel">
            {slots.map((slot, idx) => {
              return (
                <div
                  key={slot.id} data-slot={slot.id} draggable={!!slot.assetId}
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
                  {slot.assetId && (
                    <button className="rs-zoom icon" title="放大查看" onClick={() => canvas.preview(slot.assetId!)}>
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9.2 6.8M2.5 13.5l4.3-4.3" /></svg>
                    </button>
                  )}
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
