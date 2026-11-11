import type { Node } from '@xyflow/react'
import type { ModelInfo } from './api'

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

export type GenNodeType = Node<GenData, 'gen'>
export type ImageNodeType = Node<ImageData, 'image'>
export type CanvasNode = GenNodeType | ImageNodeType

export const GEN_WIDTH = 340
export const IMAGE_WIDTH = 280

export interface CanvasActions {
  models: ModelInfo[]
  patchNode: (id: string, patch: Record<string, unknown>) => void
  generate: (id: string) => void
  cancelJobs: (id: string) => void
  continueFrom: (imageIds: string[], mode: 'together' | 'each') => void
  preview: (assetId: string) => void
  refCount: (genId: string) => number
}
