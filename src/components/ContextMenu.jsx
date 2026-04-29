import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * ContextMenu — Spec §9 right-click context menu on a selected shape.
 *
 * Items:
 *   - Delete shape
 *   - Duplicate shape (offset 10 px right + 10 px down per Spec §9)
 *   - ── divider ──
 *   - Move to: <layer name> (one item per OTHER layer)
 *
 * Closes on click anywhere outside the menu, on Escape, or after any item
 * fires. Position (x, y) is canvas-stage-relative pixels.
 */
export default function ContextMenu({ x, y, layerId, shapeId, canvasSize, onClose }) {
  const ref = useRef(null)
  const layers = useAppStore((s) => s.layers)
  const deleteShape = useAppStore((s) => s.deleteShape)
  const duplicateShape = useAppStore((s) => s.duplicateShape)
  const moveShapeToLayer = useAppStore((s) => s.moveShapeToLayer)

  useEffect(() => {
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    // Defer the click listener until after the current event has finished
    // bubbling, otherwise the same right-click that opens the menu would
    // close it immediately.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDocClick, true)
      document.addEventListener('contextmenu', onDocClick, true)
      document.addEventListener('keydown', onKey, true)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDocClick, true)
      document.removeEventListener('contextmenu', onDocClick, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const handleDelete = () => {
    deleteShape(layerId, shapeId)
    onClose()
  }
  const handleDuplicate = () => {
    duplicateShape(layerId, shapeId, { x: 10, y: 10 }, canvasSize)
    onClose()
  }
  const handleMoveTo = (toLayerId) => {
    moveShapeToLayer(layerId, shapeId, toLayerId)
    onClose()
  }

  const otherLayers = layers.filter((l) => l.id !== layerId)

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      data-testid="context-menu"
    >
      <button type="button" role="menuitem" className="ctx-item ctx-delete" onClick={handleDelete} data-testid="ctx-delete">
        <span className="ctx-icon">✕</span>
        Delete shape
      </button>
      <button type="button" role="menuitem" className="ctx-item" onClick={handleDuplicate} data-testid="ctx-duplicate">
        <span className="ctx-icon">⎘</span>
        Duplicate shape
      </button>
      {otherLayers.length > 0 && <div className="ctx-divider" role="separator" />}
      {otherLayers.map((l) => (
        <button
          key={l.id}
          type="button"
          role="menuitem"
          className="ctx-item ctx-move-to"
          onClick={() => handleMoveTo(l.id)}
          data-testid={`ctx-move-${l.id}`}
        >
          <span className="ctx-icon" aria-hidden="true">→</span>
          Move to: <span className="ctx-layer-name">{l.name || l.id}</span>
        </button>
      ))}
    </div>
  )
}
