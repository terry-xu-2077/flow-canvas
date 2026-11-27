import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, assetUrl, type AssetInfo } from './api'
import type { Markup, Shape, ShapeKind } from './types'

type Tool = 'select' | ShapeKind
type Point = Shape['pts'][number]
type Box = { x: number; y: number; w: number; h: number }
type TextDraft = { at: Point; id?: string; value: string; size: number }
type TransformKind = 'move' | 'rotate' | 'scale'
type Drag = { kind: 'draw'; id: string; pointerId: number } | {
  kind: TransformKind
  shape: Shape
  pointerId: number
  start: Point
  center: Point
  moved: boolean
}

/** Stroke icons from Lucide (https://lucide.dev, ISC licence), 24x24. */
const Ico = ({ children }: { children: React.ReactNode }) => (
  <svg className="mk-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
)
const ICONS: Record<string, React.ReactNode> = {
  select: <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />,
  pen: <><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></>,
  text: <><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" x2="15" y1="20" y2="20" /><line x1="12" x2="12" y1="4" y2="20" /></>,
  arrow: <><path d="M7 7h10v10" /><path d="M7 17 17 7" /></>,
  ellipse: <circle cx="12" cy="12" r="10" />,
  rect: <rect width="18" height="18" x="3" y="3" rx="2" />,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" /></>,
}
const TOOLS: { id: Tool; label: string; tip: string }[] = [
  { id: 'select', label: '选择', tip: '拖动标记移动，上方圆点旋转，四角等比缩放。双击编辑文字，Delete 删除' },
  { id: 'pen', label: '画笔', tip: '自由绘制' },
  { id: 'text', label: '文字', tip: '点一下画面，输入文字，回车确定（Shift+回车换行）' },
  { id: 'arrow', label: '箭头', tip: '按住拖出箭头' },
  { id: 'ellipse', label: '圆圈', tip: '按住拖出椭圆；按住 Shift 为正圆' },
  { id: 'rect', label: '方框', tip: '按住拖出矩形；按住 Shift 为正方形' },
]
const KIND_ZH: Record<ShapeKind, string> = { pen: '画笔', arrow: '箭头', ellipse: '圆圈', rect: '方框', text: '文字' }
const SWATCHES = ['#ff3b30', '#ffcc00', '#d7f23b', '#34c759', '#00c7ff', '#ffffff', '#000000']
const uid = () => Math.random().toString(36).slice(2, 10)

/** Sizes are relative to the picture: 1 unit = 1/1000 of its long side, so a mark looks the same on any resolution. */
const unit = (w: number, h: number) => Math.max(w, h) / 1000
const fontPx = (size: number, k: number) => size * 4 * k
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max))

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(lines: string[], font: number) {
  const ctx = measureCtx ??= document.createElement('canvas').getContext('2d')!
  ctx.font = `bold ${font}px sans-serif`
  return lines.reduce((width, line) => Math.max(width, ctx.measureText(line).width), 1)
}

function textBox(s: Shape, k: number) {
  const f = fontPx(s.size, k)
  const lines = (s.text ?? '').split('\n')
  return { x: s.pts[0][0], y: s.pts[0][1], w: textWidth(lines, f), h: f * 1.25 * lines.length }
}

function arrowhead(s: Shape, k: number): [Point, Point] {
  const [[x1, y1], [x2, y2]] = s.pts
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const length = Math.max(s.size * k * 4, 16 * k)
  return [
    [x2 - length * Math.cos(angle - 0.42), y2 - length * Math.sin(angle - 0.42)],
    [x2 - length * Math.cos(angle + 0.42), y2 - length * Math.sin(angle + 0.42)],
  ]
}

function shapeBox(s: Shape, k: number): Box {
  if (s.t === 'text') return textBox(s, k)
  const points = s.t === 'arrow' ? [...s.pts, ...arrowhead(s, k)] : s.pts
  let [left, top] = points[0]
  let right = left, bottom = top
  for (const [x, y] of points) {
    left = Math.min(left, x); right = Math.max(right, x)
    top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  const pad = s.size * k / 2
  return { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 }
}

const boxCenter = (b: Box): Point => [b.x + b.w / 2, b.y + b.h / 2]

function rotate([x, y]: Point, angle: number): Point {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  return [x * cos - y * sin, x * sin + y * cos]
}

function textOrigin(s: Shape, k: number): Point {
  const [x, y] = s.pts[0]
  const rotation = s.rotation ?? 0, scale = s.scale ?? 1
  if (rotation === 0 && scale === 1) return [x, y]
  const [cx, cy] = boxCenter(textBox(s, k))
  const [dx, dy] = rotate([(x - cx) * scale, (y - cy) * scale], rotation)
  return [cx + dx, cy + dy]
}

/** Paint the layers (bottom first) onto a context whose pixels are the base image's pixels. */
export function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], k: number) {
  for (const s of shapes) {
    ctx.save()
    const rotation = s.rotation ?? 0, scale = s.scale ?? 1
    if (rotation !== 0 || scale !== 1) {
      const [cx, cy] = boxCenter(shapeBox(s, k))
      ctx.translate(cx, cy)
      ctx.rotate(rotation)
      ctx.scale(scale, scale)
      ctx.translate(-cx, -cy)
    }
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color
    ctx.lineWidth = s.size * k; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    const p = s.pts
    if (s.t === 'pen') {
      if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill() }
      else { ctx.beginPath(); p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke() }
    } else if (s.t === 'arrow' && p.length === 2) {
      const [[x1, y1], [x2, y2]] = p
      const a = Math.atan2(y2 - y1, x2 - x1)
      const hl = Math.max(s.size * k * 4, 16 * k)
      const len = Math.hypot(x2 - x1, y2 - y1)
      const back = Math.min(hl * 0.8, len)
      const [left, right] = arrowhead(s, k)
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - Math.cos(a) * back, y2 - Math.sin(a) * back); ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(...left)
      ctx.lineTo(...right)
      ctx.closePath(); ctx.fill()
    } else if (s.t === 'rect' && p.length === 2) {
      ctx.strokeRect(Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.abs(p[1][0] - p[0][0]), Math.abs(p[1][1] - p[0][1]))
    } else if (s.t === 'ellipse' && p.length === 2) {
      ctx.beginPath()
      ctx.ellipse((p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2, Math.abs(p[1][0] - p[0][0]) / 2, Math.abs(p[1][1] - p[0][1]) / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (s.t === 'text' && s.text) {
      const [x, y] = p[0], font = fontPx(s.size, k)
      ctx.font = `bold ${font}px sans-serif`; ctx.textBaseline = 'top'
      s.text.split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * font * 1.25))
    }
    ctx.restore()
  }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function hit(s: Shape, x: number, y: number, k: number, tol: number): boolean {
  const rotation = s.rotation ?? 0, scale = s.scale ?? 1
  if (rotation !== 0 || scale !== 1) {
    const [cx, cy] = boxCenter(shapeBox(s, k))
    const [dx, dy] = rotate([x - cx, y - cy], -rotation)
    x = cx + dx / scale; y = cy + dy / scale; tol /= scale
  }
  const p = s.pts
  const reach = (s.size * k) / 2 + tol
  if (s.t === 'pen') {
    if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= reach
    return p.some((q, i) => i > 0 && segDist(x, y, p[i - 1][0], p[i - 1][1], q[0], q[1]) <= reach)
  }
  if (s.t === 'arrow') {
    const [left, right] = arrowhead(s, k)
    return segDist(x, y, ...p[0], ...p[1]) <= Math.max(reach, 8 * k)
      || segDist(x, y, ...p[1], ...left) <= tol
      || segDist(x, y, ...p[1], ...right) <= tol
      || segDist(x, y, ...left, ...right) <= tol
  }
  if (s.t === 'text') { const b = textBox(s, k); return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol }
  const x0 = Math.min(p[0][0], p[1][0]), x1 = Math.max(p[0][0], p[1][0]), y0 = Math.min(p[0][1], p[1][1]), y1 = Math.max(p[0][1], p[1][1])
  if (s.t === 'rect') {
    const outer = x >= x0 - reach && x <= x1 + reach && y >= y0 - reach && y <= y1 + reach
    const inner = x > x0 + reach && x < x1 - reach && y > y0 + reach && y < y1 - reach
    return outer && !inner
  }
  const rx = (x1 - x0) / 2 || 1, ry = (y1 - y0) / 2 || 1
  const r = Math.hypot((x - (x0 + x1) / 2) / rx, (y - (y0 + y1) / 2) / ry)
  return Math.abs(r - 1) * Math.min(rx, ry) <= reach
}

interface Props {
  markup: Markup
  inPlace?: boolean // editing an already annotated card: saving updates it instead of making a new one
  onClose: () => void
  onSave: (info: AssetInfo, markup: Markup) => void
}

export default function MarkupEditor({ markup, inPlace, onClose, onSave }: Props) {
  const { base, w, h } = markup
  const k = unit(w, h)
  const [shapes, setShapes] = useState<Shape[]>(markup.shapes)
  const past = useRef<Shape[][]>([])
  const future = useRef<Shape[][]>([])
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(() => localStorage.getItem('fc_mk_color') || '#ff3b30')
  const [size, setSize] = useState(() => Number(localStorage.getItem('fc_mk_size')) || 6)
  const [sel, setSel] = useState<string | null>(null)
  const [typing, setTyping] = useState<TextDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1) // on top of the fit-to-window size
  const [pan, setPan] = useState({ x: 0, y: 0 }) // offset of the picture's centre from the stage's centre, in screen px
  const [spaceDown, setSpaceDown] = useState(false)
  const panning = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const fit = stageSize.width ? clamp(Math.min((stageSize.width - 64) / w, (stageSize.height - 64) / h), 0.02, 1) : 1
  const scale = fit * zoom
  const img = useRef<HTMLImageElement | null>(null)
  const [ready, setReady] = useState(false)
  const cv = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const shapesRef = useRef(shapes)
  shapesRef.current = shapes
  const editingId = typing?.id

  useEffect(() => { localStorage.setItem('fc_mk_color', color) }, [color])
  useEffect(() => { localStorage.setItem('fc_mk_size', String(size)) }, [size])

  useEffect(() => {
    const i = new Image()
    i.onload = () => { img.current = i; setReady(true) }
    i.onerror = () => setErr('原图加载失败')
    i.src = assetUrl(base)
  }, [base])

  // Leave space around the picture for selection handles.
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setStageSize({ width, height })
    })
    observer.observe(stage.current!)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const c = cv.current
    if (!c || !ready || !img.current) return
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(img.current, 0, 0, w, h)
    drawShapes(ctx, editingId ? shapes.filter(s => s.id !== editingId) : shapes, k)
  }, [shapes, ready, w, h, k, editingId])

  // wheel = zoom around the pointer
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      if (e.target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      if (drag.current) return
      const r = el.getBoundingClientRect()
      const px = e.clientX - (r.left + r.width / 2), py = e.clientY - (r.top + r.height / 2)
      setZoom(z => {
        const z2 = Math.min(16, Math.max(0.1, z * Math.exp(-e.deltaY * 0.0015)))
        const f = z2 / z
        setPan(p => ({ x: px - (px - p.x) * f, y: py - (py - p.y) * f }))
        return z2
      })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  // hold Space to drag the picture around
  useEffect(() => {
    const dn = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing || drag.current) return
      e.preventDefault(); setSpaceDown(true)
    }
    const upk = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false) }
    window.addEventListener('keydown', dn)
    window.addEventListener('keyup', upk)
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', upk) }
  }, [typing])

  const stageDown = (e: React.PointerEvent) => {
    if (drag.current || (!(spaceDown && e.button === 0) && e.button !== 1)) return
    e.preventDefault()
    panning.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const stageMove = (e: React.PointerEvent) => {
    const d = panning.current
    if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y })
  }
  const stageUp = () => { panning.current = null }

  const push = useCallback(() => { past.current = [...past.current.slice(-49), shapesRef.current]; future.current = [] }, [])
  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(shapesRef.current); setShapes(prev); setSel(null)
  }, [])
  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(shapesRef.current); setShapes(next); setSel(null)
  }, [])
  const remove = useCallback((id: string) => { push(); setShapes(ss => ss.filter(s => s.id !== id)); setSel(null) }, [push])

  const commitText = useCallback(() => {
    const current = shapesRef.current
    if (!typing) return current
    const value = typing.value.replace(/\s+$/, '')
    const original = current.find(s => s.id === typing.id)
    setTyping(null)
    let next: Shape[]
    if (original && value) {
      if (value === original.text && typing.size === original.size) return current
      const updated = { ...original, text: value, size: typing.size }
      // Keep the visible text origin stable when editing a transformed layer.
      const [x, y] = typing.at
      const [newX, newY] = textOrigin(updated, k)
      updated.pts = [[original.pts[0][0] + x - newX, original.pts[0][1] + y - newY]]
      next = current.map(s => s.id === updated.id ? updated : s)
    } else if (original) {
      next = current.filter(s => s.id !== original.id)
      setSel(null)
    } else {
      if (!value || typing.id) return current
      const shape: Shape = { id: uid(), t: 'text', color, size: typing.size, pts: [typing.at], text: value }
      next = [...current, shape]
      setSel(shape.id)
    }
    push()
    shapesRef.current = next
    setShapes(next)
    return next
  }, [typing, push, color, k])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typing || drag.current) return
      if (e.key === 'Escape') onClose()
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); remove(sel) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [typing, sel, undo, redo, remove, onClose])

  const at = (e: React.PointerEvent): Point => {
    const r = cv.current!.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h]
  }

  const startTransform = (e: React.PointerEvent, kind: TransformKind, shape: Shape) => {
    if (e.button !== 0 || spaceDown || panning.current || drag.current) return
    if (kind !== 'move') e.preventDefault()
    drag.current = { kind, shape, pointerId: e.pointerId, start: at(e), center: boxCenter(shapeBox(shape, k)), moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || spaceDown || panning.current || drag.current) return
    if (typing) { e.preventDefault(); commitText(); return }
    const pt = at(e)
    if (tool === 'select') {
      const found = [...shapesRef.current].reverse().find(s => hit(s, pt[0], pt[1], k, 8 / scale))
      setSel(found?.id ?? null)
      if (found) startTransform(e, 'move', found)
      return
    }
    if (tool === 'text') { setSel(null); setTyping({ at: pt, value: '', size }); e.preventDefault(); return }
    push()
    const id = uid()
    const s: Shape = { id, t: tool, color, size, pts: tool === 'pen' ? [pt] : [pt, pt] }
    setShapes(ss => [...ss, s]); setSel(null)
    drag.current = { kind: 'draw', id, pointerId: e.pointerId }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const pt = at(e)
    if (d.kind === 'draw') {
      setShapes(ss => ss.map(s => {
        if (s.id !== d.id) return s
        if (s.t === 'pen') return { ...s, pts: [...s.pts, pt] }
        let [x, y] = pt
        if (e.shiftKey && s.t !== 'arrow') { // square / circle
          const dx = x - s.pts[0][0], dy = y - s.pts[0][1], m = Math.max(Math.abs(dx), Math.abs(dy))
          x = s.pts[0][0] + (dx < 0 ? -m : m); y = s.pts[0][1] + (dy < 0 ? -m : m)
        }
        return { ...s, pts: [s.pts[0], [x, y]] }
      }))
      return
    }
    const dx = pt[0] - d.start[0], dy = pt[1] - d.start[1]
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 3 / scale) return
      push()
      d.moved = true
    }
    const changed = { ...d.shape }
    if (d.kind === 'move') changed.pts = d.shape.pts.map(([x, y]) => [x + dx, y + dy])
    else {
      const sx = d.start[0] - d.center[0], sy = d.start[1] - d.center[1]
      const x = sx + dx, y = sy + dy
      if (d.kind === 'rotate') {
        const angle = (d.shape.rotation ?? 0) + Math.atan2(y, x) - Math.atan2(sy, sx)
        changed.rotation = Math.atan2(Math.sin(angle), Math.cos(angle))
      } else {
        const factor = (x * sx + y * sy) / (sx * sx + sy * sy)
        changed.scale = clamp((d.shape.scale ?? 1) * factor, 0.05, 20)
      }
    }
    setShapes(ss => ss.map(s => s.id === changed.id ? changed : s))
  }

  const up = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    if (d.kind !== 'draw' && e.type === 'pointerup') move(e)
    drag.current = null
    if (d.kind !== 'draw') return
    // a plain click with a shape tool leaves nothing behind (a pen click leaves a dot)
    const tiny = (s: Shape) => s.t !== 'pen' && s.pts.length === 2 && Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1]) <= 4 / scale
    const made = shapesRef.current.find(s => s.id === d.id)
    if (made && tiny(made)) { setShapes(ss => ss.filter(s => s.id !== d.id)); past.current.pop() } else setSel(d.id)
  }

  const recolor = (c: string) => {
    setColor(c)
    if (sel) { push(); setShapes(ss => ss.map(s => (s.id === sel ? { ...s, color: c } : s))) }
  }
  const resize = (v: number) => {
    setSize(v)
    if (sel) setShapes(ss => ss.map(s => (s.id === sel ? { ...s, size: v } : s)))
  }

  const save = async () => {
    if (!img.current || saving) return
    const savedShapes = commitText()
    setSaving(true); setErr('')
    try {
      const out = document.createElement('canvas')
      out.width = w; out.height = h
      const ctx = out.getContext('2d')!
      ctx.drawImage(img.current, 0, 0, w, h)
      drawShapes(ctx, savedShapes, k)
      const blob = await new Promise<Blob>((ok, no) => out.toBlob(b => (b ? ok(b) : no(new Error('导出失败'))), 'image/png'))
      const info = await api.uploadAsset(blob)
      onSave(info, { base, w, h, shapes: savedShapes })
    } catch (e) { setErr(`保存失败：${(e as Error).message}`); setSaving(false) }
  }

  // the pen's cursor is a ring as wide as the stroke would be on screen (the browser caps cursor images at 128 px)
  const penCursor = useMemo(() => {
    const d = Math.max(6, Math.round(size * k * scale))
    if (d > 126) return undefined
    const box = d + 4, c = box / 2, r = d / 2
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${box}' height='${box}'><circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='black' stroke-width='3' opacity='.55'/><circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='white' stroke-width='1.5'/></svg>`
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`
  }, [size, k, scale])

  const layers = useMemo(() => [...shapes].reverse(), [shapes])
  const selected = shapes.find(s => s.id === sel)
  const selectionBox = selected && !typing ? shapeBox(selected, k) : null
  const wrapX = (stageSize.width - w * scale) / 2 + pan.x
  const wrapY = (stageSize.height - h * scale) / 2 + pan.y

  let textLayout: { x: number; y: number; w: number; h: number; font: number; rotation: number; toolbarX: number; toolbarY: number } | undefined
  if (typing) {
    const rotation = selected?.rotation ?? 0
    const font = fontPx(typing.size, k) * (selected?.scale ?? 1)
    const screenFont = font * scale
    const lines = typing.value.split('\n')
    const minWidth = Math.min(Math.ceil(screenFont * 3) + 6, Math.max(24, stageSize.width - 16))
    const lineHeight = Math.ceil(screenFont * 1.25) + 2
    const x = rotation ? typing.at[0] * scale : Math.min(typing.at[0] * scale, stageSize.width - wrapX - minWidth - 8)
    const y = rotation ? typing.at[1] * scale : Math.min(typing.at[1] * scale, stageSize.height - wrapY - lineHeight - 8)
    const width = clamp(Math.ceil(textWidth(lines, screenFont)) + 7, minWidth, stageSize.width - wrapX - x - 8)
    const height = clamp(Math.ceil(screenFont * 1.25 * lines.length) + 2, lineHeight, stageSize.height - wrapY - y - 8)
    const toolbarX = clamp(x, 8 - wrapX, stageSize.width - wrapX - 124)
    const toolbarY = y + wrapY >= 38 ? y - 34 : Math.min(y + height + 4, stageSize.height - wrapY - 34)
    textLayout = { x, y, w: width, h: height, font, rotation, toolbarX, toolbarY }
  }

  return (
    <div className="mk" onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <div className="mk-bar">
        <strong>添加标记</strong>
        <div className="mk-tools">
          {TOOLS.map(t => (
            <button key={t.id} className={tool === t.id ? 'on' : ''} title={t.tip} onClick={() => { commitText(); setTool(t.id) }}><Ico>{ICONS[t.id]}</Ico>{t.label}</button>
          ))}
        </div>
        <label className="mk-field" title="新标记的颜色；选中一个图层时也会改它的颜色">颜色
          <input type="color" value={color} onChange={e => recolor(e.target.value)} />
        </label>
        <span className="mk-sw">
          {SWATCHES.map(c => <i key={c} className={c === color ? 'on' : ''} style={{ background: c }} onClick={() => recolor(c)} />)}
        </span>
        <label className="mk-field" title="画笔 / 线条 / 文字的粗细（选中图层时同步修改）">粗细
          <input type="range" min={2} max={100} value={size} onChange={e => resize(Number(e.target.value))} />
          <span className="mk-num">{size}</span>
        </label>
        <button onClick={undo} title="撤销 Ctrl+Z"><Ico>{ICONS.undo}</Ico>撤销</button>
        <button onClick={redo} title="重做 Ctrl+Shift+Z"><Ico>{ICONS.redo}</Ico>重做</button>
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} title="滚轮缩放，按住空格拖动画面；点这里回到适应窗口">{Math.round(scale * 100)}%</button>
        <span className="mk-gap" />
        {err && <span className="mk-err">{err}</span>}
        <button onClick={onClose}>取消</button>
        <button className="primary" disabled={saving || !ready} onClick={() => void save()} title={inPlace ? '更新这张卡片（合并图和图层一起替换）' : '合并成一张新图放到画板上，同时保留可再编辑的图层'}>
          {saving ? '保存中…' : inPlace ? '保存' : '保存为新卡片'}
        </button>
      </div>
      <div className="mk-main">
        <div className="mk-stage" ref={stage} onPointerDown={stageDown} onPointerMove={stageMove} onPointerUp={stageUp} onPointerCancel={stageUp}
             style={{ cursor: spaceDown ? (panning.current ? 'grabbing' : 'grab') : undefined }}>
          {!ready && <span className="mk-hint">{err || '加载中…'}</span>}
          <div className="mk-wrap" style={{ width: w * scale, height: h * scale, display: ready ? 'block' : 'none', left: wrapX, top: wrapY }}
               onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}>
            <canvas ref={cv} width={w} height={h} className={`mk-cv tool-${tool}`} style={{ width: w * scale, height: h * scale, cursor: spaceDown ? 'inherit' : tool === 'pen' ? penCursor : undefined }}
                    onPointerDown={down}
                    onDoubleClick={() => {
                      const s = shapesRef.current.find(x => x.id === sel)
                      if (tool === 'select' && s?.t === 'text') setTyping({ at: textOrigin(s, k), id: s.id, value: s.text ?? '', size: s.size })
                    }} />
            {selected && selectionBox && (
              <div className="mk-selection" style={{
                left: (selectionBox.x + selectionBox.w / 2) * scale,
                top: (selectionBox.y + selectionBox.h / 2) * scale,
                width: Math.max(20, selectionBox.w * (selected.scale ?? 1) * scale + 10),
                height: Math.max(20, selectionBox.h * (selected.scale ?? 1) * scale + 10),
                transform: `translate(-50%, -50%) rotate(${selected.rotation ?? 0}rad)`,
              }}>
                {tool === 'select' && !spaceDown && (
                  <>
                    <span className="mk-handle mk-handle-rotate" title="拖动旋转" onPointerDown={e => startTransform(e, 'rotate', selected)} />
                    {([0, 1, 2, 3] as const).map((corner) => (
                      <span key={corner} className="mk-handle mk-handle-scale" title="拖动等比缩放" style={{
                        left: corner % 2 ? '100%' : 0,
                        top: corner >= 2 ? '100%' : 0,
                        cursor: ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][
                          (Math.round((selected.rotation ?? 0) / (Math.PI / 4)) + (corner === 0 || corner === 3 ? 1 : 3) + 4) % 4
                        ],
                      }} onPointerDown={e => startTransform(e, 'scale', selected)} />
                    ))}
                  </>
                )}
              </div>
            )}
            {typing && textLayout && (
              <div className="mk-text-edit" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) commitText() }}
                   onKeyDown={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) setTyping(null) }}>
                <textarea className="mk-type" aria-label="标记文字" autoFocus value={typing.value} rows={1} wrap="off"
                          style={{ left: textLayout.x, top: textLayout.y, width: textLayout.w, height: textLayout.h,
                            fontSize: textLayout.font * scale, color: selected?.color ?? color, transform: `rotate(${textLayout.rotation}rad)` }}
                          onChange={e => setTyping({ ...typing, value: e.target.value })}
                          onKeyDown={e => {
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText() }
                          }} />
                <div className="mk-text-size" role="group" aria-label="文字大小" style={{ left: textLayout.toolbarX, top: textLayout.toolbarY }}
                     onPointerDown={e => { if (e.button === 0) e.preventDefault() }}>
                  <button type="button" aria-label="减小字号" title="减小字号" disabled={typing.size <= 1}
                          onClick={() => setTyping({ ...typing, size: typing.size - 1 })}>−</button>
                  <output aria-label="字号">{Math.round(textLayout.font)} px</output>
                  <button type="button" aria-label="增大字号" title="增大字号" disabled={typing.size >= 100}
                          onClick={() => setTyping({ ...typing, size: typing.size + 1 })}>+</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="mk-layers">
          <div className="mk-lh">图层（{shapes.length}）</div>
          {layers.length === 0 && <div className="mk-empty">还没有标记</div>}
          {layers.map(s => (
            <div key={s.id} className={`mk-layer${s.id === sel ? ' on' : ''}`} onClick={() => { setSel(s.id); setTool('select') }}>
              <i style={{ background: s.color }} />
              <span>{KIND_ZH[s.t]}{s.t === 'text' && s.text ? ` · ${s.text.slice(0, 10)}` : ''}</span>
              <button className="icon" title="删除这一层" onClick={e => { e.stopPropagation(); remove(s.id) }}>✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
