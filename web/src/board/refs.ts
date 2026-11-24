import type { Edge } from '@xyflow/react'
import type { RefInfo } from '../PromptEditor'
import type { CanvasNode, GenNodeType, ImageNodeType, RefsetNodeType, VGenNodeType } from '../types'

/** References of a generation card in edge order; <Picture N> in the prompt means the N-th entry. */
export function collectRefs(genId: string, nodes: CanvasNode[], edges: Edge[]): RefInfo[] {
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
export function numberedRefs(refIds: string[] | undefined, connected: RefInfo[]): (RefInfo | undefined)[] {
  const known = refIds ?? []
  const all = [...known, ...connected.map(r => r.key).filter(k => !known.includes(k))]
  return all.map(k => connected.find(r => r.key === k))
}

/** Order reference pictures as numbered and renumber <Picture N> tags in the prompt to match the submitted list. */
export function prepareRefs(node: GenNodeType | VGenNodeType, nodes: CanvasNode[], edges: Edge[]) {
  const numbered = numberedRefs(node.data.refIds, collectRefs(node.id, nodes, edges))
  const refs: string[] = []
  const position: Record<number, number> = {}
  const mentioned = new Set(Array.from(node.data.prompt.matchAll(/<Picture\s+(\d+)>/gi), m => Number(m[1])))
  numbered.forEach((r, i) => {
    if (!r) return
    if (node.data.onlyRefs && !mentioned.has(i + 1)) return   // "仅发送引用的图": the unmentioned ones stay home
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
  return { refs, prompt, dropped }
}

export function serialize(nodes: CanvasNode[], edges: Edge[], viewport: unknown) {
  return {
    nodes: nodes.map(n => ({ id: n.id, type: n.type, position: n.position, width: n.width, height: n.height, data: n.data })),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, className: e.className })),
    viewport,
  }
}
