import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, assetUrl, downloadUrl, getUser, type JobInfo, type ModelInfo } from './api'
import { CanvasContext } from './CanvasContext'
import { nodeTypes } from './nodes'
import type { RefInfo } from './PromptEditor'
import {
  GEN_HEIGHT, GEN_WIDTH, IMAGE_WIDTH, type CanvasActions, type CanvasNode, type GenNodeType, type ImageNodeType, type JobState,
} from './types'

const FINAL = new Set(['done', 'failed', 'cancelled'])
const GEN_EST_HEIGHT = 330
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`
const imgHeight = (w: number, h: number) => Math.round((IMAGE_WIDTH * h) / w)

function nodeBox(n: CanvasNode) {
  const w = n.width ?? n.measured?.width
  if (n.type === 'image') {
    const width = w ?? IMAGE_WIDTH
    return { w: width, h: n.height ?? n.measured?.height ?? Math.round((width * n.data.h) / n.data.w) }
  }
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

/** References of a generation card in edge order; <Picture N> in the prompt means the N-th entry. */
function collectRefs(genId: string, nodes: CanvasNode[], edges: Edge[]): RefInfo[] {
  const out: RefInfo[] = []
  for (const e of edges.filter(e => e.target === genId)) {
    const src = nodes.find(n => n.id === e.source)
    if (src?.type !== 'image') continue
    const d = (src as ImageNodeType).data
    if (!out.some(r => r.assetId === d.assetId)) out.push({ assetId: d.assetId, w: d.w, h: d.h, note: d.prompt ? d.prompt.slice(0, 24) : undefined })
  }
  return out
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
        const width = n.width ?? (n.type === 'image' ? IMAGE_WIDTH : GEN_WIDTH)
        const height = n.height ?? (n.type === 'image' ? Math.round((width * n.data.h) / n.data.w) : GEN_HEIGHT)
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

  // ---- node helpers
  const patchNode = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes(ns => ns.map(n => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as CanvasNode) : n)))
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
      if (k === 'escape') { setPreviewId(null); return }
      if (previewId) return
      if (k === 'a') { e.preventDefault(); addGenCard() }
      else if (k === 'u') { e.preventDefault(); fileInput.current?.click() }
      else if (k === 'f') { e.preventDefault(); fitAll() }
      else if (k === 'l') { e.preventDefault(); setLayersOpen(o => !o) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addGenCard, fitAll, previewId])

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
    const refs = collectRefs(genId, nodesRef.current, edgesRef.current).map(r => r.assetId)
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
            id: imgId, type: 'image', position: spot, width: IMAGE_WIDTH, height: imgHeight(w, h),
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

  const refsOf = useCallback((genId: string) => collectRefs(genId, nodes, edges), [nodes, edges])
  const refCount = useCallback((genId: string) => refsOf(genId).length, [refsOf])

  const actions = useMemo<CanvasActions>(() => ({
    models, maxCount, patchNode, generate, cancelJobs, continueFrom, preview: setPreviewId, refCount, refsOf,
  }), [models, maxCount, patchNode, generate, cancelJobs, continueFrom, refCount, refsOf])

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
            <span className={`save ${saveState}`}>{saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : '保存失败'}</span>
          </Panel>
          <Panel position="top-right" className="toolbar who">{getUser()}</Panel>
          {layersOpen && (
            <Panel position="top-right" className="layers">
              <div className="layers-head"><strong>图层</strong>
                <button className="icon" onClick={() => setLayersOpen(false)}>✕</button></div>
              {nodes.length === 0 && <div className="hint">画布上还没有内容</div>}
              <ul>
                {[...nodes].reverse().map(n => (
                  <li key={n.id} className={n.selected ? 'on' : ''} onClick={() => focusNode(n.id)}>
                    {n.type === 'gen'
                      ? `✦ 生成卡片 · ${((n as GenNodeType).data.prompt || '空').slice(0, 16)}`
                      : `▣ 图片 · ${(n as ImageNodeType).data.w}×${(n as ImageNodeType).data.h}`}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel position="bottom-center" className="dock">
            <button className="primary" onClick={addGenCard} disabled={!models.length} title="新建生成卡片（A）">
              ＋ 生成卡片 <kbd>A</kbd>
            </button>
            <button onClick={() => fileInput.current?.click()} title="上传图片（U）">
              上传图片{busyUploads ? `（${busyUploads}）` : ''} <kbd>U</kbd>
            </button>
            <span className="sep" />
            <button onClick={fitAll} title="适应画面（F）">适应画面 <kbd>F</kbd></button>
            <button className={layersOpen ? 'on' : ''} onClick={() => setLayersOpen(o => !o)} title="图层（L）">图层 <kbd>L</kbd></button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden
                   onChange={e => { void addImages(Array.from(e.target.files ?? [])); e.target.value = '' }} />
          </Panel>
          {modelError && (
            <Panel position="top-center" className="banner">
              无法读取模型列表：{modelError} <button onClick={loadModels}>重试</button>
            </Panel>
          )}
          {selectedImages.length > 0 && (
            <Panel position="bottom-center" className="selbar" style={{ marginBottom: 66 }}>
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
