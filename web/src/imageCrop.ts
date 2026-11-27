import type { CropRect } from './types'

export const CROP_RATIOS = {
  '1:1': [1, 1],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '3:2': [3, 2],
  '2:3': [2, 3],
  '16:9': [16, 9],
  '9:16': [9, 16],
} as const

export const CROP_HANDLES = [
  { x: -1, y: -1, cursor: 'nwse-resize' },
  { x: 0, y: -1, cursor: 'ns-resize' },
  { x: 1, y: -1, cursor: 'nesw-resize' },
  { x: -1, y: 0, cursor: 'ew-resize' },
  { x: 1, y: 0, cursor: 'ew-resize' },
  { x: -1, y: 1, cursor: 'nesw-resize' },
  { x: 0, y: 1, cursor: 'ns-resize' },
  { x: 1, y: 1, cursor: 'nwse-resize' },
] as const

type Point = [number, number]
export type CropRatio = keyof typeof CROP_RATIOS
export type CropHandle = 'draw' | 'move' | typeof CROP_HANDLES[number]

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max))

export function isCropRatio(value: unknown): value is CropRatio {
  return typeof value === 'string' && Object.hasOwn(CROP_RATIOS, value)
}

export function cropRatioFits(rect: CropRect, ratio: CropRatio) {
  const [w, h] = CROP_RATIOS[ratio]
  return rect.w >= w && rect.h >= h
}

export function sameCrop(a: CropRect | null, b: CropRect | null) {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
}

export function normalizeCrop(crop: CropRect | null | undefined, full: CropRect) {
  if (!crop || ![crop.x, crop.y, crop.w, crop.h].every(Number.isFinite) || crop.w <= 0 || crop.h <= 0) return null
  const x = clamp(Math.round(crop.x), 0, full.w - 1)
  const y = clamp(Math.round(crop.y), 0, full.h - 1)
  const right = clamp(Math.round(crop.x + crop.w), x + 1, full.w)
  const bottom = clamp(Math.round(crop.y + crop.h), y + 1, full.h)
  const rect = { x, y, w: right - x, h: bottom - y }
  return sameCrop(rect, full) ? null : rect
}

export function matchesCropRatio(rect: CropRect, ratio: CropRatio) {
  if (!isCropRatio(ratio)) return false
  const [w, h] = CROP_RATIOS[ratio]
  return rect.w * h === rect.h * w
}

export function fitCropRatio(full: CropRect, rect: CropRect, ratio: CropRatio): CropRect | null {
  const [w, h] = CROP_RATIOS[ratio]
  const maxUnits = Math.floor(Math.min(full.w / w, full.h / h))
  if (!maxUnits) return null
  const units = clamp(Math.floor(Math.min(rect.w / w, rect.h / h)), 1, maxUnits)
  const width = units * w, height = units * h
  return {
    x: clamp(Math.round(rect.x + (rect.w - width) / 2), 0, full.w - width),
    y: clamp(Math.round(rect.y + (rect.h - height) / 2), 0, full.h - height),
    w: width, h: height,
  }
}

function roomAtAnchor(position: number, direction: number, limit: number) {
  if (direction === 0) return 2 * Math.min(position, limit - position)
  return direction < 0 ? position : limit - position
}

// Integer multiples keep the exported pixel dimensions at the selected ratio.
function anchoredCrop(full: CropRect, anchor: Point, direction: Point, requestedUnits: number, ratio: CropRatio): CropRect | null {
  const [x, y] = anchor, [dx, dy] = direction
  const [w, h] = CROP_RATIOS[ratio]
  const maxUnits = Math.floor(Math.min(roomAtAnchor(x, dx, full.w) / w, roomAtAnchor(y, dy, full.h) / h))
  const units = Math.min(maxUnits, Math.round(requestedUnits))
  if (units < 1) return null
  const width = units * w, height = units * h
  return { x: Math.round(x - (1 - dx) * width / 2), y: Math.round(y - (1 - dy) * height / 2), w: width, h: height }
}

function unitsFromDrag([dx, dy]: Point, [x, y]: Point, ratio: CropRatio) {
  const [w, h] = CROP_RATIOS[ratio]
  const vx = x * w, vy = y * h
  return (dx * vx + dy * vy) / (vx * vx + vy * vy)
}

export function dragCrop(full: CropRect, initial: CropRect | null, handle: CropHandle, start: Point, point: Point, ratio: CropRatio | null = null): CropRect | null {
  if (handle === 'draw') {
    const x1 = clamp(Math.round(start[0]), 0, full.w), y1 = clamp(Math.round(start[1]), 0, full.h)
    const x2 = clamp(Math.round(point[0]), 0, full.w), y2 = clamp(Math.round(point[1]), 0, full.h)
    if (ratio) {
      const delta: Point = [x2 - x1, y2 - y1]
      const direction: Point = [Math.sign(delta[0]) || (x1 < full.w / 2 ? 1 : -1), Math.sign(delta[1]) || (y1 < full.h / 2 ? 1 : -1)]
      return anchoredCrop(full, [x1, y1], direction, unitsFromDrag(delta, direction, ratio), ratio) ?? initial
    }
    if (x1 === x2 || y1 === y2) return initial
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
  }
  if (!initial) return null
  const dx = Math.round(point[0] - start[0]), dy = Math.round(point[1] - start[1])
  if (handle === 'move') {
    return { ...initial, x: clamp(initial.x + dx, 0, full.w - initial.w), y: clamp(initial.y + dy, 0, full.h - initial.h) }
  }
  if (ratio) {
    const { x, y } = handle
    const anchor: Point = [initial.x + (1 - x) * initial.w / 2, initial.y + (1 - y) * initial.h / 2]
    const direction: Point = [x, y]
    const units = initial.w / CROP_RATIOS[ratio][0] + unitsFromDrag([dx, dy], direction, ratio)
    return anchoredCrop(full, anchor, direction, Math.max(1, units), ratio) ?? initial
  }
  let { x, y } = initial
  let right = x + initial.w, bottom = y + initial.h
  if (handle.x < 0) x = clamp(x + dx, 0, right - 1)
  if (handle.x > 0) right = clamp(right + dx, x + 1, full.w)
  if (handle.y < 0) y = clamp(y + dy, 0, bottom - 1)
  if (handle.y > 0) bottom = clamp(bottom + dy, y + 1, full.h)
  return { x, y, w: right - x, h: bottom - y }
}
