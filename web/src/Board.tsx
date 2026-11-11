import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, ControlButton, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, ViewportPortal,
  addEdge, useEdgesState, useNodesState, useReactFlow, useViewport,
  type Connection, type Edge, type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, assetUrl, downloadUrl, getUser, type JobInfo, type ModelInfo } from './api'
import { CanvasContext } from './CanvasContext'
import { BananaIcon, BrandMark, CollectionIcon, ImageIcon } from './icons'
import { nodeTypes } from './nodes'
import UsageBadge from './UsageBadge'
import type { RefInfo } from './PromptEditor'
import {
  GEN_HEIGHT, GEN_WIDTH, IMAGE_WIDTH, REFSET_WIDTH, type CanvasActions, type RefsetNodeType, type Slot, type CanvasNode, type GenNodeType, type ImageNodeType, type JobState,
} from './types'

const FINAL = new Set(['done', 'failed', 'cancelled'])
const GEN_EST_HEIGHT = 330
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`
const imgHeight = (w: number, h: number) => Math.round((IMAGE_WIDTH * h) / w)
const ratioSize = (ratio: string): [number, number] => {
  const [w, h] = ratio.split(':').map(Number)
  return w > 0 && h > 0 ? [w, h] : [1, 1]
}

function nodeBox(n: CanvasNode) {
  const w = n.width ?? n.measured?.width
  if (n.type === 'image') {
    const width = w ?? IMAGE_WIDTH
    return { w: width, h: n.height ?? n.measured?.height ?? Math.round((width * n.data.h) / n.data.w) }
  }
  if (n.type === 'refset') return { w: w ?? REFSET_WIDTH, h: n.height ?? n.measured?.height ?? 200 }
  return { w: w ?? GEN_WIDTH, h: n.height ?? n.measured?.height ?? GEN_EST_HEIGHT }
}

/** Nudge a box down/right until it no longer overlaps an existing node. */
function findFree(nodes: CanvasNode[], x: number, y: number, w: number, h: number) {
  const gap = 24
  for (let i = 0; i < 60; i++) {
    const hit = nodes.find(n => {
      const b = nodeBox(n)
      return x < n.position.x + b.w + gap && x + w + gap > n.position.x &&
             y < n.position.y + b.h + gap && y + h + gap > n.position.y
    })
    if (!hit) return { x, y }
    y = hit.position.y + nodeBox(hit).h + gap
  }
  return { x, y }
}

const edgeBase: Partial<Edge> = { style: { strokeWidth: 2 } }

interface Guides { v: { x: number; y1: number; y2: number }[]; h: { y: number; x1: number; x2: number }[] }
const NO_GUIDES: Guides = { v: [], h: [] }

/** Snap a dragged node's edges/centre to those of the other nodes (within `thr` flow units); also returns the guide lines. */
function snapToNodes(moving: CanvasNode, pos: { x: number; y: number }, others: CanvasNode[], thr: number) {
  const b = nodeBox(moving)
  const xs = [pos.x, pos.x + b.w / 2, pos.x + b.w]
  const ys = [pos.y, pos.y + b.h / 2, pos.y + b.h]
  let dx: number | null = null, dy: number | null = null
  for (const o of others) {
    const ob = nodeBox(o)
    const oxs = [o.position.x, o.position.x + ob.w / 2, o.position.x + ob.w]
    const oys = [o.position.y, o.position.y + ob.h / 2, o.position.y + ob.h]
    for (const x of xs) for (const ox of oxs) if (Math.abs(ox - x) < thr && (dx === null || Math.abs(ox - x) < Math.abs(dx))) dx = ox - x
    for (const y of ys) for (const oy of oys) if (Math.abs(oy - y) < thr && (dy === null || Math.abs(oy - y) < Math.abs(dy))) dy = oy - y
  }
  const snapped = { x: pos.x + (dx ?? 0), y: pos.y + (dy ?? 0) }
  const guides: Guides = { v: [], h: [] }
  const sxs = [snapped.x, snapped.x + b.w / 2, snapped.x + b.w]
  const sys = [snapped.y, snapped.y + b.h / 2, snapped.y + b.h]
  for (const o of others) {
    const ob = nodeBox(o)
    const oxs = [o.position.x, o.position.x + ob.w / 2, o.position.x + ob.w]
    const oys = [o.position.y, o.position.y + ob.h / 2, o.position.y + ob.h]
    if (dx !== null) for (const x of sxs) if (oxs.some(ox => Math.abs(ox - x) < 0.5)) {
      guides.v.push({ x, y1: Math.min(snapped.y, o.position.y), y2: Math.max(snapped.y + b.h, o.position.y + ob.h) })
    }
    if (dy !== null) for (const y of sys) if (oys.some(oy => Math.abs(oy - y) < 0.5)) {
      guides.h.push({ y, x1: Math.min(snapped.x, o.position.x), x2: Math.max(snapped.x + b.w, o.position.x + ob.w) })
    }
  }
  return { snapped, guides }
}

/** References of a generation card in edge order; <Picture N> in the prompt means the N-th entry. */
function collectRefs(genId: string, nodes: CanvasNode[], edges: Edge[]): RefInfo[] {
  const out: RefInfo[] = []
  for (const e of edges.filter(e => e.target === genId)) {
    const src = nodes.find(n => n.id === e.source)
    const add = (r: RefInfo) => { if (!out.some(x => x.key === r.key)) out.push(r) }
    if (src?.type === 'image' && (src as ImageNodeType).data.assetId) {
      const d = (src as ImageNodeType).data
      add({ key: `n:${src.id}`, assetId: d.assetId, w: d.w, h: d.h, note: d.prompt ? d.prompt.slice(0, 24) : undefined })
    } else if (src?.type === 'refset') {
      for (const s of (src as RefsetNodeType).data.slots) {
        if (s.assetId) add({ key: `s:${s.id}`, assetId: s.assetId, w: s.w ?? 0, h: s.h ?? 0, note: s.name })
      }
    }
  }
  return out
}

/** <Picture N> numbering of a card: refIds keeps every reference it ever had, so a number never moves to another
 *  image; a reference that is no longer connected leaves a hole (undefined) instead of shifting the others. */
function numberedRefs(refIds: string[] | undefined, connected: RefInfo[]): (RefInfo | undefined)[] {
  const known = refIds ?? []
  const all = [...known, ...connected.map(r => r.key).filter(k => !known.includes(k))]
  return all.map(k => connected.find(r => r.key === k))
}

function serialize(nodes: CanvasNode[], edges: Edge[], viewport: unknown) {
  return {
    nodes: nodes.map(n => ({ id: n.id, type: n.type, position: n.position, width: n.width, height: n.height, data: n.data })),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, className: e.className })),
    viewport,
  }
}

function BoardInner({ boardId, onBack }: { boardId: string; onBack: () => void }) {
  const rf = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [maxCount, setMaxCount] = useState(4)
  const [modelError, setModelError] = useState('')
  const [name, setName] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [busyUploads, setBusyUploads] = useState(0)
  const [layersOpen, setLayersOpen] = useState(false)
  const [dropMenu, setDropMenu] = useState<{ files: File[]; at?: { x: number; y: number }; x: number; y: number } | null>(null)
  const [snapOn, setSnapOn] = useState(() => localStorage.getItem('fc_snap') === '1')
  const [guides, setGuides] = useState<Guides>(NO_GUIDES)
  const nodesRef = useRef<CanvasNode[]>([])
  const edgesRef = useRef<Edge[]>([])
  const viewportRef = useRef<unknown>({ x: 0, y: 0, zoom: 1 })
  const lastSaved = useRef('')
  const fileInput = useRef<HTMLInputElement>(null)
  nodesRef.current = nodes
  edgesRef.current = edges

  // ---- load board + models
  const loadModels = useCallback(() => {
    api.models().then(r => { setModels(r.models); setMaxCount(r.max_count); setModelError('') })
      .catch(e => setModelError(String(e.message || e)))
  }, [])
  useEffect(() => { loadModels() }, [loadModels])
  useEffect(() => {
    let dead = false
    api.getBoard(boardId).then(b => {
      if (dead) return
      const d = b.data || {}
      // Boards saved before nodes were resizable have no stored size: give them the default one.
      const loadedNodes = ((d.nodes || []) as CanvasNode[]).map(n => {
        const width = n.width ?? (n.type === 'image' ? IMAGE_WIDTH : n.type === 'refset' ? REFSET_WIDTH : GEN_WIDTH)
        const height = n.height ?? (n.type === 'image' ? Math.round((width * n.data.h) / n.data.w) : n.type === 'refset' ? undefined : GEN_HEIGHT)
        return { ...n, width, height } as CanvasNode
      })
      const loadedEdges = (d.edges || []) as Edge[]
      setName(b.name)
      setNodes(loadedNodes)
      setEdges(loadedEdges.map(e => ({ ...edgeBase, ...e })))
      if (d.viewport) { viewportRef.current = d.viewport; rf.setViewport(d.viewport) }
      lastSaved.current = JSON.stringify(serialize(loadedNodes, loadedEdges, d.viewport ?? viewportRef.current))
      setLoaded(true)
    }).catch(e => setLoadError(String(e.message || e)))
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId])

  // ---- autosave (debounced; skips when nothing meaningful changed)
  const saveNow = useCallback(async () => {
    const payload = serialize(nodesRef.current, edgesRef.current, viewportRef.current)
    const text = JSON.stringify(payload)
    if (text === lastSaved.current) return
    setSaveState('saving')
    try {
      await api.saveBoard(boardId, payload)
      lastSaved.current = text
      setSaveState('saved')
    } catch { setSaveState('error') }
  }, [boardId])
  useEffect(() => {
    if (!loaded) return
    const t = setTimeout(saveNow, 800)
    return () => clearTimeout(t)
  }, [nodes, edges, loaded, saveNow])
  useEffect(() => {
    const flush = () => { void saveNow() }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [saveNow])

  // Settings the admin switched off in config.json (model / resolution / count) are replaced by valid ones.
  useEffect(() => {
    if (!loaded || !models.length) return
    setNodes(ns => {
      let changed = false
      const next = ns.map(n => {
        if (n.type !== 'gen') return n
        const d = (n as GenNodeType).data
        const m = models.find(x => x.key === d.model) ?? models[0]
        const ratio = m.ratios.includes(d.ratio) ? d.ratio : (m.ratios.includes('16:9') ? '16:9' : m.ratios[0])
        const size = m.sizes.includes(d.size) ? d.size : m.sizes[0]
        const count = Math.min(Math.max(1, d.count || 1), maxCount)
        if (m.key === d.model && ratio === d.ratio && size === d.size && count === d.count) return n
        changed = true
        return { ...n, data: { ...d, model: m.key, ratio, size, count } } as CanvasNode
      })
      return changed ? next : ns
    })
  }, [loaded, models, maxCount, setNodes])

  // Remember the numbering of every reference connected to a card (new ones get the next free number).
  useEffect(() => {
    if (!loaded) return
    const updates = new Map<string, string[]>()
    for (const n of nodes) {
      if (n.type !== 'gen') continue
      const known = (n as GenNodeType).data.refIds
      const keys = collectRefs(n.id, nodes, edges).map(r => r.key)
      const fresh = keys.filter(k => !(known ?? []).includes(k))
      if (known === undefined || fresh.length) updates.set(n.id, [...(known ?? []), ...fresh])
    }
    if (updates.size) setNodes(ns => ns.map(n => (updates.has(n.id) ? ({ ...n, data: { ...n.data, refIds: updates.get(n.id) } } as CanvasNode) : n)))
  }, [loaded, nodes, edges, setNodes])

  const toggleSnap = useCallback(() => {
    setSnapOn(on => { localStorage.setItem('fc_snap', on ? '0' : '1'); return !on })
    setGuides(NO_GUIDES)
  }, [])

  // With alignment on, a single node being dragged snaps to the edges/centres of the others (guide lines shown).
  const handleNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    if (snapOn) {
      // the drop itself arrives as a (dragging: false) position change, so it has to be snapped too
      const moves = changes.filter((c): c is Extract<NodeChange<CanvasNode>, { type: 'position' }> => c.type === 'position' && !!c.position)
      if (moves.length === 1) {
        const c = moves[0]
        const moving = nodesRef.current.find(n => n.id === c.id)
        if (moving) {
          const others = nodesRef.current.filter(n => n.id !== c.id && !n.selected)
          const { snapped, guides: g } = snapToNodes(moving, c.position!, others, 8 / rf.getZoom())
          c.position = snapped
          setGuides(c.dragging ? g : NO_GUIDES)
        }
      } else if (changes.some(c => c.type === 'position' && c.dragging === false)) setGuides(NO_GUIDES)
    }
    onNodesChange(changes)
  }, [snapOn, onNodesChange, rf])

  // ---- node helpers
  const patchNode = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes(ns => ns.map(n => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as CanvasNode) : n)))
  }, [setNodes])

  const editSlots = useCallback((id: string, fn: (slots: Slot[]) => Slot[]) => {
    setNodes(ns => ns.map(n => (n.id === id && n.type === 'refset'
      ? ({ ...n, data: { ...n.data, slots: fn(n.data.slots) } } as CanvasNode) : n)))
  }, [setNodes])

  const newGenNode = useCallback((x: number, y: number, prompt = ''): GenNodeType => {
    const m = models[0]
    return {
      id: uid('g'), type: 'gen', position: { x, y }, width: GEN_WIDTH, height: GEN_HEIGHT,
      data: {
        prompt, model: m?.key ?? '', ratio: m?.ratios.includes('16:9') ? '16:9' : (m?.ratios[0] ?? '16:9'),
        size: m?.sizes[0] ?? '1K', count: 1, jobs: [], handled: [],
      },
    }
  }, [models])

  const newImageNode = (assetId: string, w: number, h: number, x: number, y: number, prompt?: string): ImageNodeType => ({
    id: uid('i'), type: 'image', position: { x, y }, width: IMAGE_WIDTH, height: imgHeight(w, h), data: { assetId, w, h, prompt },
  })

  const addRefset = useCallback((slots: Slot[] = [], at?: { x: number; y: number }): string => {
    const el = document.querySelector('.react-flow')?.getBoundingClientRect()
    const c = at ?? rf.screenToFlowPosition({ x: (el?.left ?? 0) + (el?.width ?? 800) / 2 - REFSET_WIDTH / 2, y: (el?.top ?? 0) + (el?.height ?? 600) / 3 })
    const spot = findFree(nodesRef.current, c.x, c.y, REFSET_WIDTH, 220)
    const node: RefsetNodeType = {
      id: uid('r'), type: 'refset', position: spot, width: REFSET_WIDTH,
      data: { slots: slots.length ? slots : [{ id: uid('s') }, { id: uid('s') }, { id: uid('s') }] },
    }
    setNodes(ns => [...ns.map(n => (n.selected ? { ...n, selected: false } : n)), { ...node, selected: true } as CanvasNode])
    return node.id
  }, [rf, setNodes])

  // Replace the chosen images by one collection at their place; edges and <Picture N> numbering move to the slots.
  const mergeIntoRefset = useCallback((imageIds: string[]) => {
    const images = nodesRef.current.filter((n): n is ImageNodeType => n.type === 'image' && imageIds.includes(n.id))
    if (!images.length) return
    const slots: Slot[] = images.map(i => ({ id: uid('s'), assetId: i.data.assetId, w: i.data.w, h: i.data.h }))
    const keyMap: Record<string, string> = {}
    images.forEach((img, i) => { keyMap[`n:${img.id}`] = `s:${slots[i].id}` })
    const gone = new Set(images.map(i => i.id))
    const rest = nodesRef.current.filter(n => !gone.has(n.id))
    const spot = findFree(rest, Math.min(...images.map(i => i.position.x)), Math.min(...images.map(i => i.position.y)), REFSET_WIDTH, 220)
    const node: RefsetNodeType = { id: uid('r'), type: 'refset', position: spot, width: REFSET_WIDTH, data: { slots } }
    setNodes(ns => [
      ...ns.filter(n => !gone.has(n.id)).map(n => {
        if (n.type === 'gen' && n.data.refIds) return { ...n, selected: false, data: { ...n.data, refIds: n.data.refIds.map(k => keyMap[k] ?? k) } } as CanvasNode
        return n.selected ? { ...n, selected: false } : n
      }),
      { ...node, selected: true } as CanvasNode,
    ])
    setEdges(es => {
      const kept: Edge[] = []
      const wired = new Set<string>()
      for (const e of es) {
        if (gone.has(e.source)) {
          if (!gone.has(e.target) && !wired.has(e.target)) {
            wired.add(e.target)
            kept.push({ ...edgeBase, id: uid('e'), source: node.id, target: e.target } as Edge)
          }
        } else if (!gone.has(e.target)) kept.push(e)
      }
      return kept
    })
  }, [setNodes, setEdges])

  // Split a collection back into loose image nodes; every card it fed keeps the same references and numbers.
  const dissolve = useCallback((id: string) => {
    const rs = nodesRef.current.find(n => n.id === id) as RefsetNodeType | undefined
    if (!rs) return
    const rest = nodesRef.current.filter(n => n.id !== id)
    const created: ImageNodeType[] = []
    const keyMap: Record<string, string> = {}
    rs.data.slots.filter(s => s.assetId).forEach((s, i) => {
      const w = s.w || 1024, h = s.h || 1024
      const spot = findFree([...rest, ...created], rs.position.x + (i % 3) * (IMAGE_WIDTH + 24),
        rs.position.y + Math.floor(i / 3) * (imgHeight(w, h) + 24), IMAGE_WIDTH, imgHeight(w, h))
      const node = newImageNode(s.assetId!, w, h, spot.x, spot.y)
      created.push(node)
      keyMap[`s:${s.id}`] = `n:${node.id}`
    })
    setNodes(ns => [
      ...ns.filter(n => n.id !== id).map(n => (n.type === 'gen' && n.data.refIds
        ? ({ ...n, data: { ...n.data, refIds: n.data.refIds.map(k => keyMap[k] ?? k) } } as CanvasNode) : n)),
      ...created.map(n => ({ ...n, selected: false })),
    ])
    setEdges(es => es.flatMap(e => {
      if (e.target === id) return []
      if (e.source !== id) return [e]
      return created.map(c => ({ ...edgeBase, id: uid('e'), source: c.id, target: e.target } as Edge))
    }))
  }, [setNodes, setEdges])

  const addGenCard = useCallback(() => {
    const el = document.querySelector('.react-flow')?.getBoundingClientRect()
    const center = rf.screenToFlowPosition({ x: (el?.left ?? 0) + (el?.width ?? 800) / 2, y: (el?.top ?? 0) + (el?.height ?? 600) / 2 })
    const spot = findFree(nodesRef.current, center.x - GEN_WIDTH / 2, center.y - GEN_EST_HEIGHT / 2, GEN_WIDTH, GEN_EST_HEIGHT)
    setNodes(ns => [...ns, newGenNode(spot.x, spot.y)])
  }, [rf, setNodes, newGenNode])

  // ---- uploads (button, drag & drop, paste)
  const addToRefset = useCallback(async (id: string, files: File[]) => {
    for (const file of files.filter(f => f.type.startsWith('image/'))) {
      try {
        const info = await api.uploadAsset(file)
        const fill = { assetId: info.id, w: info.w, h: info.h, name: file.name }
        editSlots(id, ss => {
          const free = ss.findIndex(s => !s.assetId)
          return free >= 0 ? ss.map((s, i) => (i === free ? { ...s, ...fill } : s)) : [...ss, { id: uid('s'), ...fill }]
        })
      } catch (e) { alert(`上传失败：${(e as Error).message}`) }
    }
  }, [editSlots])

  const addImages = useCallback(async (files: File[], at?: { x: number; y: number }) => {
    const images = files.filter(f => f.type.startsWith('image/'))
    if (!images.length) return
    setBusyUploads(c => c + images.length)
    let offset = 0
    for (const file of images) {
      try {
        const info = await api.uploadAsset(file)
        const base = at ?? rf.screenToFlowPosition({ x: window.innerWidth / 2 - 140, y: window.innerHeight / 2 - 100 })
        const spot = findFree(nodesRef.current, base.x + offset, base.y, IMAGE_WIDTH, imgHeight(info.w, info.h) + 40)
        offset += 30
        setNodes(ns => [...ns, newImageNode(info.id, info.w, info.h, spot.x, spot.y)])
      } catch (e) {
        alert(`上传失败：${(e as Error).message}`)
      } finally {
        setBusyUploads(c => c - 1)
      }
    }
  }, [rf, setNodes])

  // One image goes straight onto the canvas; several ask first (loose images or one collection).
  const placeImages = useCallback((files: File[], at?: { x: number; y: number }, screen?: { x: number; y: number }) => {
    const imgs = files.filter(f => f.type.startsWith('image/'))
    if (imgs.length < 2) { void addImages(imgs, at); return }
    setDropMenu({ files: imgs, at, x: screen?.x ?? innerWidth / 2 - 130, y: screen?.y ?? innerHeight / 2 - 60 })
  }, [addImages])

  const addAsRefset = useCallback((files: File[], at?: { x: number; y: number }) => {
    const id = addRefset(files.map(() => ({ id: uid('s') })), at)
    void addToRefset(id, files)
  }, [addRefset, addToRefset])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return
      const files = Array.from(e.clipboardData?.files ?? [])
      if (!files.some(f => f.type.startsWith('image/'))) return
      e.preventDefault()
      const sets = nodesRef.current.filter(n => n.selected && n.type === 'refset')
      if (sets.length === 1) void addToRefset(sets[0].id, files)
      else placeImages(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [placeImages, addToRefset])

  const fitAll = useCallback(() => { void rf.fitView({ duration: 250, padding: 0.2, maxZoom: 1 }) }, [rf])
  const focusNode = useCallback((id: string) => {
    setNodes(ns => ns.map(n => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })))
    void rf.fitView({ nodes: [{ id }], duration: 250, padding: 0.6, maxZoom: 1 })
  }, [rf, setNodes])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (['TEXTAREA', 'INPUT', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'escape') { setPreviewId(null); setDropMenu(null); return }
      if (previewId) return
      if (k === 'a') { e.preventDefault(); addGenCard() }
      else if (k === 'u') { e.preventDefault(); fileInput.current?.click() }
      else if (k === 'r') { e.preventDefault(); addRefset() }
      else if (k === 'f') { e.preventDefault(); fitAll() }
      else if (k === 'l') { e.preventDefault(); setLayersOpen(o => !o) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addGenCard, addRefset, fitAll, previewId])

  // ---- continue from images: new generation card(s) wired to the chosen images
  const continueFrom = useCallback((imageIds: string[]) => {
    const images = nodesRef.current.filter((n): n is ImageNodeType => n.type === 'image' && imageIds.includes(n.id))
    if (!images.length) return
    const x = Math.max(...images.map(i => i.position.x)) + IMAGE_WIDTH + 120
    const y = images.reduce((s, i) => s + i.position.y, 0) / images.length
    const spot = findFree(nodesRef.current, x, y, GEN_WIDTH, GEN_EST_HEIGHT)
    const gen = newGenNode(spot.x, spot.y)
    setNodes(ns => [...ns, gen])
    setEdges(es => [...es, ...images.map(img => ({ ...edgeBase, id: uid('e'), source: img.id, target: gen.id } as Edge)),])
  }, [newGenNode, setNodes, setEdges])

  // ---- generation
  const generate = useCallback(async (genId: string) => {
    const node = nodesRef.current.find(n => n.id === genId) as GenNodeType | undefined
    if (!node || !node.data.prompt.trim()) return
    // Submit the images in number order and renumber the tags to match: <Picture N> in the text must name the
    // same image that ends up as the N-th reference of the request.
    const numbered = numberedRefs(node.data.refIds, collectRefs(genId, nodesRef.current, edgesRef.current))
    const refs: string[] = []
    const position: Record<number, number> = {}
    numbered.forEach((r, i) => {
      if (!r) return
      let p = refs.indexOf(r.assetId)
      if (p < 0) { refs.push(r.assetId); p = refs.length - 1 }
      position[i + 1] = p + 1
    })
    let dropped = 0
    const prompt = node.data.prompt.trim().replace(/<Picture\s+(\d+)>/gi, (_m, n) => {
      const p = position[Number(n)]
      if (!p) { dropped++; return '' }
      return `<Picture ${p}>`
    })
    try {
      const ids = await api.createJobs({
        board: boardId, node: genId, model: node.data.model, ratio: node.data.ratio, size: node.data.size,
        prompt, refs, count: node.data.count,
      })
      const [rw, rh] = ratioSize(node.data.ratio)
      const stacked = edgesRef.current.filter(e => e.source === genId && e.className === 'out').length
      const placeholders: ImageNodeType[] = []
      ids.forEach((jobId, i) => {
        const spot = findFree([...nodesRef.current, ...placeholders], node.position.x + (node.width ?? GEN_WIDTH) + 110,
          node.position.y + (stacked + i) * (imgHeight(rw, rh) + 90), IMAGE_WIDTH, imgHeight(rw, rh) + 40)
        placeholders.push({
          id: `img_${jobId}`, type: 'image', position: spot, width: IMAGE_WIDTH, height: imgHeight(rw, rh),
          data: { assetId: '', w: rw, h: rh, prompt: node.data.prompt, pending: true, jobId, status: 'queued', progress: '' },
        })
      })
      setNodes(ns => [
        ...ns.map(n => (n.id === genId ? ({ ...n, data: {
          ...n.data, jobs: ids.map<JobState>(id => ({ id, status: 'queued', progress: '' })),
          handled: [...(n as GenNodeType).data.handled, ...ids],
          notice: dropped ? `提示词里有 ${dropped} 处引用的参考图已不存在，提交时已忽略` : '',
        } } as CanvasNode) : n)),
        ...placeholders,
      ])
      setEdges(es => [...es, ...placeholders.map(p => ({ ...edgeBase, id: `out_${p.data.jobId}`, source: genId, target: p.id, className: 'out' } as Edge))])
    } catch (e) {
      patchNode(genId, { jobs: [{ id: uid('x'), status: 'failed', progress: '', error: (e as Error).message }] })
    }
  }, [boardId, patchNode, setNodes, setEdges])

  const cancelJobs = useCallback((genId: string) => {
    const node = nodesRef.current.find(n => n.id === genId) as GenNodeType | undefined
    node?.data.jobs.filter(j => !FINAL.has(j.status)).forEach(j => { void api.cancelJob(j.id) })
  }, [])

  const applyJobUpdates = useCallback((updates: JobInfo[]) => {
    // Computed from the latest snapshot (not inside a state updater) so edge creation stays idempotent.
    let next = nodesRef.current
    const added: CanvasNode[] = []
    const addedEdges: Edge[] = []
    const removed = new Set<string>()
    for (const info of updates) {
      const idx = next.findIndex(n => n.id === info.node)
      if (idx < 0) continue
      const gen = next[idx] as GenNodeType
      const jobs = gen.data.jobs.map(j => j.id === info.id
        ? { id: j.id, status: info.status, progress: info.progress, error: info.error } : j)
      let handled = gen.data.handled
      const imgId = `img_${info.id}`
      if (next.some(n => n.id === imgId)) {
        if (info.status === 'cancelled') {
          removed.add(imgId)
        } else {
          next = next.map(n => {
            if (n.id !== imgId) return n
            const d = (n as ImageNodeType).data
            if (info.status === 'done' && info.result_asset) {
              const w = info.result_w || 1024, h = info.result_h || 1024
              return { ...n, height: imgHeight(w, h), data: { assetId: info.result_asset, w, h, prompt: d.prompt } } as CanvasNode
            }
            return { ...n, data: { ...d, status: info.status, progress: info.progress, error: info.error } } as CanvasNode
          })
        }
      }
      if (info.status === 'done' && info.result_asset && !handled.includes(info.id)) {
        handled = [...handled, info.id]
        if (![...next, ...added].some(n => n.id === imgId)) {
          const w = info.result_w || 1024, h = info.result_h || 1024
          const k = handled.length - 1
          // stack results in one column to the right of the card so edges stay readable
          const spot = findFree([...next, ...added], gen.position.x + GEN_WIDTH + 110,
            gen.position.y + k * (imgHeight(w, h) + 70), IMAGE_WIDTH, imgHeight(w, h) + 40)
          added.push({
            id: imgId, type: 'image', position: spot, width: IMAGE_WIDTH, height: imgHeight(w, h),
            data: { assetId: info.result_asset, w, h, prompt: gen.data.prompt },
          } as ImageNodeType)
          addedEdges.push({ ...edgeBase, id: `out_${info.id}`, source: gen.id, target: imgId, className: 'out' } as Edge)
        }
      }
      next = next.map((n, i) => (i === idx ? ({ ...n, data: { ...n.data, jobs, handled } } as CanvasNode) : n))
    }
    if (removed.size) next = next.filter(n => !removed.has(n.id))
    setNodes(added.length ? [...next, ...added] : next)
    if (removed.size) setEdges(es => es.filter(e => !removed.has(e.target)))
    if (updates.some(u => u.status === 'done')) window.dispatchEvent(new Event('fc-usage'))
    if (addedEdges.length) setEdges(es => [...es, ...addedEdges.filter(e => !es.some(x => x.id === e.id))])
  }, [setNodes, setEdges])

  useEffect(() => {
    if (!loaded) return
    const tick = async () => {
      const pending = nodesRef.current.flatMap(n => (n.type === 'gen' ? (n as GenNodeType).data.jobs : []))
        .filter(j => !FINAL.has(j.status)).map(j => j.id)
      if (!pending.length) return
      try {
        const updates = await api.jobs(pending.slice(0, 64))
        const changed = updates.filter(u => {
          const cur = nodesRef.current.flatMap(n => (n.type === 'gen' ? (n as GenNodeType).data.jobs : [])).find(j => j.id === u.id)
          return cur && (cur.status !== u.status || cur.progress !== u.progress || u.status === 'done')
        })
        if (changed.length) applyJobUpdates(changed)
      } catch { /* transient network error: try again next tick */ }
    }
    const t = setInterval(tick, 1500)
    return () => clearInterval(t)
  }, [loaded, applyJobUpdates])

  // ---- canvas wiring
  const isValidConnection = useCallback((c: Connection | Edge) => {
    const s = nodesRef.current.find(n => n.id === c.source)
    const t = nodesRef.current.find(n => n.id === c.target)
    if ((s?.type !== 'image' && s?.type !== 'refset') || t?.type !== 'gen') return false
    return !edgesRef.current.some(e => e.source === c.source && e.target === c.target)
  }, [])
  const onConnect = useCallback((c: Connection) => setEdges(es => addEdge({ ...edgeBase, ...c }, es)), [setEdges])

  const refsOf = useCallback((genId: string) => {
    const gen = nodes.find(n => n.id === genId) as GenNodeType | undefined
    return numberedRefs(gen?.data.refIds, collectRefs(genId, nodes, edges))
  }, [nodes, edges])
  const refCount = useCallback((genId: string) => collectRefs(genId, nodes, edges).length, [nodes, edges])

  const actions = useMemo<CanvasActions>(() => ({
    models, maxCount, patchNode, editSlots, dissolve, generate, cancelJobs, continueFrom, preview: setPreviewId, refCount, refsOf,
  }), [models, maxCount, patchNode, editSlots, dissolve, generate, cancelJobs, continueFrom, refCount, refsOf])

  const selectedImages = nodes.filter(n => n.selected && n.type === 'image' && !(n as ImageNodeType).data.pending)
  const viewport = useViewport()
  const selBar = (() => {
    if (!selectedImages.length) return null
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const n of selectedImages) {
      const b = nodeBox(n)
      x1 = Math.min(x1, n.position.x); y1 = Math.min(y1, n.position.y)
      x2 = Math.max(x2, n.position.x + b.w); y2 = Math.max(y2, n.position.y + b.h)
    }
    const below = y2 * viewport.zoom + viewport.y + 14
    const above = y1 * viewport.zoom + viewport.y - 14 - 46
    return {
      left: Math.min(Math.max(((x1 + x2) / 2) * viewport.zoom + viewport.x, 230), innerWidth - 230),
      top: below + 46 > innerHeight - 80 ? Math.max(8, above) : below,
    }
  })()

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length) placeImages(files, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }), { x: e.clientX, y: e.clientY })
  }

  if (loadError) return <div className="center-msg">打开画板失败：{loadError} <button onClick={onBack}>返回</button></div>

  return (
    <CanvasContext.Provider value={actions}>
      <div className="board" onDrop={onDrop} onDragOver={e => e.preventDefault()}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange} onEdgesChange={onEdgesChange}
          onConnect={onConnect} isValidConnection={isValidConnection}
          onMoveEnd={(_e, vp) => { viewportRef.current = vp; void saveNow() }}
          minZoom={0.1} maxZoom={2} selectionOnDrag panOnDrag={[1, 2]} panActivationKeyCode="Space"
          selectionKeyCode={null} multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          deleteKeyCode={['Delete', 'Backspace']} proOptions={{ hideAttribution: true }}
          colorMode="dark" fitView={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          <Controls showInteractive={false}>
            <ControlButton className={snapOn ? 'on' : ''} onClick={toggleSnap}
                           title={snapOn ? '自动对齐：已开启（拖动节点时吸附到其他节点的边缘和中心）' : '自动对齐：已关闭（点击开启）'}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <path d="M2 1.5v13M14 1.5v13" /><rect x="4.5" y="3.5" width="7" height="3" rx="1" /><rect x="3.5" y="9.5" width="9" height="3" rx="1" />
              </svg>
            </ControlButton>
          </Controls>
          {snapOn && (
            <ViewportPortal>
              {guides.v.map((g, i) => <div key={`v${i}`} className="guide" style={{ left: g.x, top: g.y1, width: 0, height: g.y2 - g.y1 }} />)}
              {guides.h.map((g, i) => <div key={`h${i}`} className="guide" style={{ left: g.x1, top: g.y, width: g.x2 - g.x1, height: 0 }} />)}
            </ViewportPortal>
          )}
          <MiniMap pannable zoomable nodeStrokeWidth={2} />
          <Panel position="top-left" className="toolbar">
            <button className="brand-btn" onClick={onBack} title="返回画板列表"><BrandMark size={32} /></button>
            <input className="board-name" value={name} onChange={e => setName(e.target.value)}
                   onBlur={() => { if (name.trim()) void api.renameBoard(boardId, name.trim()) }} />
            <span className={`save ${saveState}`}>{saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : '保存失败'}</span>
          </Panel>
          <Panel position="top-right" className="toolbar who"><UsageBadge /><span className="user-pill">{getUser()}</span></Panel>
          {layersOpen && (
            <Panel position="top-right" className="layers">
              <div className="layers-head"><strong>图层</strong>
                <button className="icon" onClick={() => setLayersOpen(false)}>✕</button></div>
              {nodes.length === 0 && <div className="hint">画布上还没有内容</div>}
              <ul>
                {[...nodes].reverse().map(n => (
                  <li key={n.id} className={n.selected ? 'on' : ''} onClick={() => focusNode(n.id)}>
                    {n.type === 'gen'
                      ? <><BananaIcon className="ico-banana" /> 生成卡片 · {((n as GenNodeType).data.prompt || '空').slice(0, 16)}</>
                      : n.type === 'refset'
                        ? <><CollectionIcon className="ico-collection" /> 参考集合 · {(n as RefsetNodeType).data.slots.filter(s => s.assetId).length} 张</>
                        : <><ImageIcon className="ico-image" /> {(n as ImageNodeType).data.pending ? '图片 · 生成中' : `图片 · ${(n as ImageNodeType).data.w}×${(n as ImageNodeType).data.h}`}</>}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel position="bottom-center" className="dock">
            <button className="primary" onClick={addGenCard} disabled={!models.length} title="新建生成卡片（A）">
              <BananaIcon /> 生成卡片 <kbd>A</kbd>
            </button>
            <button onClick={() => addRefset()} title="新建参考集合（R）：把多张参考图放在一起，连给任意生成卡片">
              <CollectionIcon /> 参考集合 <kbd>R</kbd>
            </button>
            <button onClick={() => fileInput.current?.click()} title="上传图片（U）">
              <ImageIcon /> 上传图片{busyUploads ? `（${busyUploads}）` : ''} <kbd>U</kbd>
            </button>
            <span className="sep" />
            <button onClick={fitAll} title="适应画面（F）">适应画面 <kbd>F</kbd></button>
            <button className={layersOpen ? 'on' : ''} onClick={() => setLayersOpen(o => !o)} title="图层（L）">图层 <kbd>L</kbd></button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden
                   onChange={e => { placeImages(Array.from(e.target.files ?? [])); e.target.value = '' }} />
          </Panel>
          {modelError && (
            <Panel position="top-center" className="banner">
              无法读取模型列表：{modelError} <button onClick={loadModels}>重试</button>
            </Panel>
          )}
        </ReactFlow>
        {loaded && nodes.length === 0 && (
          <div className="empty">
            点「＋ 生成卡片」写提示词开始生成<br />也可以把图片拖进来、或 Ctrl+V 粘贴，再从图片右侧圆点连线到卡片作为参考图
          </div>
        )}
        {selBar && (
          <div className="selbar selbar-float" style={{ left: selBar.left, top: selBar.top }}>
            已选 {selectedImages.length} 张图
            <button className="primary" onClick={() => continueFrom(selectedImages.map(n => n.id))}
                    title="在右侧新建一张生成卡片，并把选中的图作为它的参考图（已连好线）">
              <BananaIcon />新建生成卡片
            </button>
            {selectedImages.length === 1 ? (
              <>
                <a className="btn" href={downloadUrl((selectedImages[0] as ImageNodeType).data.assetId)} title="下载原图">下载</a>
                <button className="icon" title="删除（Delete 键也可）" onClick={() => rf.deleteElements({ nodes: [{ id: selectedImages[0].id }] })}>✕</button>
              </>
            ) : (
              <button onClick={() => mergeIntoRefset(selectedImages.map(n => n.id))} title="把选中的图放进一个参考集合，之后可一次连给多个生成卡片">
                <CollectionIcon />合并为集合
              </button>
            )}
          </div>
        )}
        {dropMenu && (
          <>
            <div className="drop-backdrop" onPointerDown={() => setDropMenu(null)} />
            <div className="drop-menu" style={{ left: Math.max(8, Math.min(dropMenu.x, innerWidth - 292)), top: Math.max(8, Math.min(dropMenu.y, innerHeight - 150)) }}>
              <div className="dm-title">放入 {dropMenu.files.length} 张图片</div>
              <button onClick={() => { void addImages(dropMenu.files, dropMenu.at); setDropMenu(null) }}>
                <ImageIcon className="ico-image" /><span>散开<small>每张一个图片节点</small></span>
              </button>
              <button className="primary" onClick={() => { addAsRefset(dropMenu.files, dropMenu.at); setDropMenu(null) }}>
                <CollectionIcon /><span>集合<small>放进一个参考集合</small></span>
              </button>
            </div>
          </>
        )}
        {previewId && (
          <div className="lightbox" onClick={() => setPreviewId(null)}>
            <img src={assetUrl(previewId)} alt="" />
            <a href={downloadUrl(previewId)} onClick={e => e.stopPropagation()}>下载原图</a>
          </div>
        )}
      </div>
    </CanvasContext.Provider>
  )
}

export default function Board(props: { boardId: string; onBack: () => void }) {
  return <ReactFlowProvider><BoardInner {...props} /></ReactFlowProvider>
}
