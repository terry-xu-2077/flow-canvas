import type { Edge } from '@xyflow/react'
import { GEN_WIDTH, IMAGE_WIDTH, REFSET_WIDTH, VIDEO_WIDTH, type CanvasNode } from '../types'

export const FINAL = new Set(['done', 'failed', 'cancelled'])
export const GEN_EST_HEIGHT = 290
export const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`
export const imgHeight = (w: number, h: number) => Math.round((IMAGE_WIDTH * h) / w)
// images made by a generation card are larger than the default image size (about the size users resized them to)
export const RESULT_WIDTH = 540
/** No image card is ever wider than this: a 6K or enlarged result must stay easy to grab and resize on the canvas. */
export const MAX_CARD_WIDTH = 720
/** A result card is 540 px wide up to 2K; bigger pictures (4K, 6K) get a somewhat bigger card, capped at MAX_CARD_WIDTH. */
export const resultWidth = (w: number, h: number) => Math.min(MAX_CARD_WIDTH, Math.round(RESULT_WIDTH * Math.max(1, Math.max(w, h) / 2752)))
export const resultHeight = (w: number, h: number, width = RESULT_WIDTH) => Math.round((width * h) / w)
export const SIZE_LONG: Record<string, number> = { '1K': 1376, '2K': 2752, '4K': 4096, '6K': 6144 }

/** Aspect of a video card's ratio setting; "adaptive" and the like fall back to 16:9. */
export const videoRatio = (ratio: string): [number, number] => {
  const [w, h] = ratio.split(':').map(Number)
  return w > 0 && h > 0 ? [w, h] : [16, 9]
}
export const ratioSize = (ratio: string): [number, number] => {
  const [w, h] = ratio.split(':').map(Number)
  return w > 0 && h > 0 ? [w, h] : [1, 1]
}

export function nodeBox(n: CanvasNode) {
  const w = n.width ?? n.measured?.width
  if (n.type === 'image') {
    const width = w ?? IMAGE_WIDTH
    return { w: width, h: n.height ?? n.measured?.height ?? Math.round((width * n.data.h) / n.data.w) }
  }
  if (n.type === 'video') {
    const width = w ?? VIDEO_WIDTH
    return { w: width, h: n.height ?? n.measured?.height ?? Math.round((width * n.data.h) / n.data.w) }
  }
  if (n.type === 'refset') return { w: w ?? REFSET_WIDTH, h: n.height ?? n.measured?.height ?? 200 }
  return { w: w ?? GEN_WIDTH, h: n.height ?? n.measured?.height ?? GEN_EST_HEIGHT }
}

/** Nudge a box down/right until it no longer overlaps an existing node. */
export function findFree(nodes: CanvasNode[], x: number, y: number, w: number, h: number) {
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

export const edgeBase: Partial<Edge> = { style: { strokeWidth: 2 } }

export interface Guides { v: { x: number; y1: number; y2: number }[]; h: { y: number; x1: number; x2: number }[] }
export const NO_GUIDES: Guides = { v: [], h: [] }

/** Snap a dragged node's edges/centre to those of the other nodes (within `thr` flow units); also returns the guide lines. */
export function snapToNodes(moving: CanvasNode, pos: { x: number; y: number }, others: CanvasNode[], thr: number) {
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
