import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react'

/** Default edge: a bezier line that shows a round ✕ button at its middle while it is selected. */
export function DeletableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, selected }: EdgeProps) {
  const { deleteElements } = useReactFlow()
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  return (
    <>
      <BaseEdge id={id} path={path} style={style} interactionWidth={20} />
      {selected && (
        <EdgeLabelRenderer>
          <button
            className="edge-x nodrag nopan" title="删除连线"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={e => { e.stopPropagation(); void deleteElements({ edges: [{ id }] }) }}
          >
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const edgeTypes = { default: DeletableEdge }
