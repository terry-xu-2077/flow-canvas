import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, assetUrl, downloadUrl, type JobInfo, type ModelInfo } from './api'
import { CanvasContext } from './CanvasContext'
import { nodeTypes } from './nodes'
import {
  GEN_WIDTH, IMAGE_WIDTH, type CanvasActions, type CanvasNode, type GenNodeType, type ImageNodeType, type JobState,
} from './types'

const FINAL = new Set(['done', 'failed', 'cancelled'])
const GEN_EST_HEIGHT = 330
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`
const imgHeight = (w: number, h: number) => Math.round((IMAGE_WIDTH * h) / w)

function nodeBox(n: CanvasNode) {
  if (n.type === 'image') return { w: IMAGE_WIDTH, h: imgHeight(n.data.w, n.data.h) + 40 }
  return { w: GEN_WIDTH, h: n.measured?.height ?? GEN_EST_HEIGHT }
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

function serialize(nodes: CanvasNode[], edges: Edge[], viewport: unknown) {
  return {
    nodes: nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, className: e.className })),
    viewport,
  }
}

function BoardInner({ boardId, onBack }: { boardId: string; onBack: () => void }) {
  const rf = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelError, setModelError] = useState('')
  const [name, setName] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [busyUploads, setBusyUploads] = useState(0)
  const nodesRef = useRef<CanvasNode[]>([])
  const edgesRef = useRef<Edge[]>([])
  const viewportRef = useRef<unknown>({ x: 0, y: 0, zoom: 1 })
  const lastSaved = useRef('')
  const fileInput = useRef<HTMLInputElement>(null)
  nodesRef.current = nodes
  edgesRef.current = edges

  // ---- load board + models
  const loadModels = useCallback(() => {
    api.models().then(m => { setModels(m); setModelError('') }).catch(e => setModelError(String(e.message || e)))
  }, [])
  useEffect(() => { loadModels() }, [loadModels])
  useEffect(() => {
    let dead = false
    api.getBoard(boardId).then(b => {
      if (dead) return
      const d = b.data || {}
      const loadedNodes = (d.nodes || []) as CanvasNode[]
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

  // ---- node helpers
  const patchNode = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes(ns => ns.map(n => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as CanvasNode) : n)))
  }, [setNodes])

  const newGenNode = useCallback((x: number, y: number, prompt = ''): GenNodeType => {
    const m = models[0]
    return {
      id: uid('g'), type: 'gen', position: { x, y }, width: GEN_WIDTH,
      data: {
        prompt, model: m?.key ?? '', ratio: m?.ratios.includes('16:9') ? '16:9' : (m?.ratios[0] ?? '16:9'),
        size: m?.sizes[0] ?? '1K', count: 1, jobs: [], handled: [],
      },
    }
  }, [models])

  const newImageNode = (assetId: string, w: number, h: number, x: number, y: number, prompt?: string): ImageNodeType => ({
    id: uid('i'), type: 'image', position: { x, y }, width: IMAGE_WIDTH, data: { assetId, w, h, prompt },
  })

  const addGenCard = useCallback(() => {
    const el = document.querySelector('.react-flow')?.getBoundingClientRect()
    const center = rf.screenToFlowPosition({ x: (el?.left ?? 0) + (el?.width ?? 800) / 2, y: (el?.top ?? 0) + (el?.height ?? 600) / 2 })
    const spot = findFree(nodesRef.current, center.x - GEN_WIDTH / 2, center.y - GEN_EST_HEIGHT / 2, GEN_WIDTH, GEN_EST_HEIGHT)
    setNodes(ns => [...ns, newGenNode(spot.x, spot.y)])
  }, [rf, setNodes, newGenNode])

  // ---- uploads (button, drag & drop, paste)
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

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.some(f => f.type.startsWith('image/'))) { e.preventDefault(); void addImages(files) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addImages])

  // ---- continue from images: new generation card(s) wired to the chosen images
  const continueFrom = useCallback((imageIds: string[], mode: 'together' | 'each') => {
    const images = nodesRef.current.filter((n): n is ImageNodeType => n.type === 'image' && imageIds.includes(n.id))
    if (!images.length) return
    const groups = mode === 'together' ? [images] : images.map(i => [i])
    const created: CanvasNode[] = []
    const newEdges: Edge[] = []
    for (const group of groups) {
      const x = Math.max(...group.map(i => i.position.x)) + IMAGE_WIDTH + 120
      const y = group.reduce((s, i) => s + i.position.y, 0) / group.length
      const spot = findFree([...nodesRef.current, ...created], x, y, GEN_WIDTH, GEN_EST_HEIGHT)
      const g = newGenNode(spot.x, spot.y)
      created.push(g)
      for (const img of group) newEdges.push({ ...edgeBase, id: uid('e'), source: img.id, target: g.id } as Edge)
    }
    setNodes(ns => [...ns, ...created])
    setEdges(es => [...es, ...newEdges])
  }, [newGenNode, setNodes, setEdges])

  // ---- generation
  const generate = useCallback(async (genId: string) => {
    const node = nodesRef.current.find(n => n.id === genId) as GenNodeType | undefined
    if (!node || !node.data.prompt.trim()) return
    const refs: string[] = []
    for (const e of edgesRef.current.filter(e => e.target === genId)) {
      const src = nodesRef.current.find(n => n.id === e.source)
      if (src?.type === 'image' && !refs.includes((src as ImageNodeType).data.assetId)) refs.push((src as ImageNodeType).data.assetId)
    }
    try {
      const ids = await api.createJobs({
        board: boardId, node: genId, model: node.data.model, ratio: node.data.ratio, size: node.data.size,
        prompt: node.data.prompt.trim(), refs, count: node.data.count,
      })
      patchNode(genId, { jobs: ids.map<JobState>(id => ({ id, status: 'queued', progress: '' })) })
    } catch (e) {
      patchNode(genId, { jobs: [{ id: uid('x'), status: 'failed', progress: '', error: (e as Error).message }] })
    }
  }, [boardId, patchNode])

  const cancelJobs = useCallback((genId: string) => {
    const node = nodesRef.current.find(n => n.id === genId) as GenNodeType | undefined
    node?.data.jobs.filter(j => !FINAL.has(j.status)).forEach(j => { void api.cancelJob(j.id) })
  }, [])

  const applyJobUpdates = useCallback((updates: JobInfo[]) => {
    // Computed from the latest snapshot (not inside a state updater) so edge creation stays idempotent.
    let next = nodesRef.current
    const added: CanvasNode[] = []
    const addedEdges: Edge[] = []
    for (const info of updates) {
      const idx = next.findIndex(n => n.id === info.node)
      if (idx < 0) continue
      const gen = next[idx] as GenNodeType
      const jobs = gen.data.jobs.map(j => j.id === info.id
        ? { id: j.id, status: info.status, progress: info.progress, error: info.error } : j)
      let handled = gen.data.handled
      const imgId = `img_${info.id}`
      if (info.status === 'done' && info.result_asset && !handled.includes(info.id)) {
        handled = [...handled, info.id]
        if (![...next, ...added].some(n => n.id === imgId)) {
          const w = info.result_w || 1024, h = info.result_h || 1024
          const k = handled.length - 1
          // stack results in one column to the right of the card so edges stay readable
          const spot = findFree([...next, ...added], gen.position.x + GEN_WIDTH + 110,
            gen.position.y + k * (imgHeight(w, h) + 70), IMAGE_WIDTH, imgHeight(w, h) + 40)
          added.push({
            id: imgId, type: 'image', position: spot, width: IMAGE_WIDTH,
            data: { assetId: info.result_asset, w, h, prompt: gen.data.prompt },
          } as ImageNodeType)
          addedEdges.push({ ...edgeBase, id: `out_${info.id}`, source: gen.id, target: imgId, className: 'out' } as Edge)
        }
      }
      next = next.map((n, i) => (i === idx ? ({ ...n, data: { ...n.data, jobs, handled } } as CanvasNode) : n))
    }
    setNodes(added.length ? [...next, ...added] : next)
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
    if (s?.type !== 'image' || t?.type !== 'gen') return false
    return !edgesRef.current.some(e => e.source === c.source && e.target === c.target)
  }, [])
  const onConnect = useCallback((c: Connection) => setEdges(es => addEdge({ ...edgeBase, ...c }, es)), [setEdges])

  const refCount = useCallback((genId: string) => {
    const ids = new Set<string>()
    for (const e of edges.filter(e => e.target === genId)) {
      const src = nodes.find(n => n.id === e.source)
      if (src?.type === 'image') ids.add(e.source)
    }
    return ids.size
  }, [nodes, edges])

  const actions = useMemo<CanvasActions>(() => ({
    models, patchNode, generate, cancelJobs, continueFrom, preview: setPreviewId, refCount,
  }), [models, patchNode, generate, cancelJobs, continueFrom, refCount])

  const selectedImages = nodes.filter(n => n.selected && n.type === 'image')

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length) void addImages(files, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }

  if (loadError) return <div className="center-msg">打开画板失败：{loadError} <button onClick={onBack}>返回</button></div>

  return (
    <CanvasContext.Provider value={actions}>
      <div className="board" onDrop={onDrop} onDragOver={e => e.preventDefault()}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={(c: NodeChange<CanvasNode>[]) => onNodesChange(c)} onEdgesChange={onEdgesChange}
          onConnect={onConnect} isValidConnection={isValidConnection}
          onMoveEnd={(_e, vp) => { viewportRef.current = vp; void saveNow() }}
          minZoom={0.1} maxZoom={2} selectionOnDrag panOnDrag={[1, 2]} panActivationKeyCode="Space"
          selectionKeyCode={null} multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          deleteKeyCode={['Delete', 'Backspace']} proOptions={{ hideAttribution: true }}
          colorMode="dark" fitView={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeStrokeWidth={2} />
          <Panel position="top-left" className="toolbar">
            <button onClick={onBack} title="返回画板列表">←</button>
            <input className="board-name" value={name} onChange={e => setName(e.target.value)}
                   onBlur={() => { if (name.trim()) void api.renameBoard(boardId, name.trim()) }} />
            <button className="primary" onClick={addGenCard} disabled={!models.length}>＋ 生成卡片</button>
            <button onClick={() => fileInput.current?.click()}>上传图片{busyUploads ? `（${busyUploads}）` : ''}</button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden
                   onChange={e => { void addImages(Array.from(e.target.files ?? [])); e.target.value = '' }} />
            <span className={`save ${saveState}`}>{saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : '保存失败'}</span>
          </Panel>
          {modelError && (
            <Panel position="top-center" className="banner">
              无法读取模型列表：{modelError} <button onClick={loadModels}>重试</button>
            </Panel>
          )}
          {selectedImages.length > 0 && (
            <Panel position="bottom-center" className="selbar">
              已选 {selectedImages.length} 张图
              <button className="primary" onClick={() => continueFrom(selectedImages.map(n => n.id), 'together')}>
                作为参考，新建 1 张卡片
              </button>
              {selectedImages.length > 1 && (
                <button onClick={() => continueFrom(selectedImages.map(n => n.id), 'each')}>每张图各建一张卡片</button>
              )}
            </Panel>
          )}
        </ReactFlow>
        {loaded && nodes.length === 0 && (
          <div className="empty">
            点「＋ 生成卡片」写提示词开始生成<br />也可以把图片拖进来、或 Ctrl+V 粘贴，再从图片右侧圆点连线到卡片作为参考图
          </div>
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
