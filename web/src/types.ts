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
  count: number
  jobs: JobState[]
  handled: string[] // job ids whose result image was already placed on the canvas
}

export interface ImageData extends Record<string, unknown> {
  assetId: string
  w: number
  h: number
  prompt?: string
}

export interface Slot { id: string; assetId?: string; w?: number; h?: number; name?: string }

export interface RefsetData extends Record<string, unknown> {
  slots: Slot[]
  collapsed?: boolean
}

export type GenNodeType = Node<GenData, 'gen'>
export type ImageNodeType = Node<ImageData, 'image'>
export type RefsetNodeType = Node<RefsetData, 'refset'>
export type CanvasNode = GenNodeType | ImageNodeType | RefsetNodeType

export const GEN_WIDTH = 340
export const GEN_HEIGHT = 300
export const IMAGE_WIDTH = 280
export const REFSET_WIDTH = 420

export interface CanvasActions {
  models: ModelInfo[]
  maxCount: number
  patchNode: (id: string, patch: Record<string, unknown>) => void
  editSlots: (id: string, fn: (slots: Slot[]) => Slot[]) => void
  generate: (id: string) => void
  cancelJobs: (id: string) => void
  continueFrom: (imageIds: string[], mode: 'together' | 'each') => void
  preview: (assetId: string) => void
  refCount: (genId: string) => number
  refsOf: (genId: string) => RefInfo[]
}
