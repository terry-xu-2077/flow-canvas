import type { Node } from '@xyflow/react'
import type { ModelInfo } from './api'
import type { RefInfo } from './PromptEditor'

export interface JobState {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: string
  error?: string | null
}

export interface GenData extends Record<string, unknown> {
  prompt: string
  model: string
  ratio: string
  size: string
  quality?: string // quality tier of the models that have one; empty = the platform's default
  count: number
  jobs: JobState[]
  handled: string[] // job ids whose result image was already placed on the canvas
  refIds?: string[] // stable reference numbering of this card: <Picture N> = refIds[N-1]; entries are never reused
  onlyRefs?: boolean // send only the pictures the prompt mentions (<Picture N>) instead of every connected one
  notice?: string
}

/** Video generation card: same prompt / reference handling as the image card, plus the video settings. */
export interface VGenData extends Record<string, unknown> {
  prompt: string
  model: string // terry2api model id, "provider:name"
  ratio: string
  resolution: string
  duration: number // seconds, 0 = the model's default
  sound: boolean
  mode: 'auto' | 'reference' // auto: 1 picture = first frame, 2 = first + last frame, more = references
  count: number
  jobs: JobState[]
  handled: string[]
  refIds?: string[]
  onlyRefs?: boolean
  notice?: string
}

export interface VideoData extends Record<string, unknown> {
  assetId: string
  w: number // aspect only (the real pixel size is not known)
  h: number
  label?: string // "厂商 · 模型名" that made the video
  prompt?: string
  pending?: boolean
  jobId?: string
  status?: string
  progress?: string
  error?: string | null
}

/** One layer of an annotated picture. Coordinates are in pixels of the base image.
 *  pen: all points; arrow / ellipse / rect: [start, end]; text: [position]. `size` is relative (1000 px of the long side = 1). */
export type ShapeKind = 'pen' | 'arrow' | 'ellipse' | 'rect' | 'text'
export interface Shape {
  id: string
  t: ShapeKind
  color: string
  size: number
  pts: [number, number][]
  text?: string
  rotation?: number // radians around the layer's center
  scale?: number // uniform multiplier for geometry, stroke and text
}
/** The editable source of an annotated picture: the untouched base image plus its layers. */
export interface Markup { base: string; w: number; h: number; shapes: Shape[] }

export interface ImageData extends Record<string, unknown> {
  assetId: string
  markup?: Markup // present on an annotated copy: assetId is the merged result, markup the layered source
  w: number
  h: number
  prompt?: string
  // a placeholder while its job runs (the node is filled in place when the image is ready)
  pending?: boolean
  jobId?: string
  upscale?: boolean // the placeholder belongs to an enlarge job (not to a generation card)
  label?: string // "厂商 · 模型名" that made the picture
  status?: string
  progress?: string
  error?: string | null
}

export interface Slot { id: string; assetId?: string; w?: number; h?: number; name?: string }

export interface RefsetData extends Record<string, unknown> {
  slots: Slot[]
  collapsed?: boolean
}

export type GenNodeType = Node<GenData, 'gen'>
export type ImageNodeType = Node<ImageData, 'image'>
export type RefsetNodeType = Node<RefsetData, 'refset'>
export type VGenNodeType = Node<VGenData, 'vgen'>
export type VideoNodeType = Node<VideoData, 'video'>
export type CanvasNode = GenNodeType | ImageNodeType | RefsetNodeType | VGenNodeType | VideoNodeType

export const GEN_WIDTH = 480
export const GEN_HEIGHT = 280
export const IMAGE_WIDTH = 280
export const REFSET_WIDTH = 420
export const VIDEO_WIDTH = 480

export interface CanvasActions {
  submitting: ReadonlySet<string>   // cards whose 生成 request is still on its way (a second click does nothing)
  models: ModelInfo[]
  maxCount: number
  patchNode: (id: string, patch: Record<string, unknown>) => void
  editSlots: (id: string, fn: (slots: Slot[]) => Slot[]) => void
  dissolve: (id: string) => void
  generate: (id: string) => void
  generateVideo: (id: string) => void
  cancelJobs: (id: string) => void
  duplicate: (id: string) => void
  continueFrom: (imageIds: string[]) => void
  preview: (assetId: string) => void
  refCount: (genId: string) => number
  refsOf: (genId: string) => (RefInfo | undefined)[]
}
