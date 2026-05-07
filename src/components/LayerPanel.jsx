import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

// P10 (May 5 2026) — inline SVG visibility icons. Replaces the prior
// ●/○ unicode dots which operators didn't recognize as a visibility
// toggle. Shapes mirror the lucide-react Eye / EyeOff design (same
// stroke / arc / diagonal-slash conventions) so operators familiar
// with that icon set read them instinctively. Inline rather than
// pulled from a 3rd-party package because we only need two icons.
function EyeIcon({ size = 14 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
function EyeOffIcon({ size = 14 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  )
}

/**
 * LayerPanel — Step 4 of Kickoff Spec §5.
 *
 * Header buttons: + Add Layer (creates "New Layer" #ffffff, focuses name
 * input on the new row), Clear All (confirm dialog before wiping all
 * layers + shapes).
 *
 * Per row:
 *   - Drag handle ⠿ (HTML5 drag-and-drop reorders the layer)
 *   - Color swatch (native <input type="color"> — live updates layer.color)
 *   - Name input (always editable inline; commits to store on every change)
 *   - Shape count (read-only)
 *   - Visibility toggle (👁 / 🚫)
 *   - Delete ✕ (confirm dialog before remove)
 *
 * Selecting a row sets activeLayerId so future drawing tools commit
 * shapes to that layer.
 *
 * Touch drag-reorder is not implemented in this step — desktop-only via
 * HTML5 drag-and-drop. iPad/iPhone reorder is a future enhancement.
 */
export default function LayerPanel() {
  const layers = useAppStore((s) => s.layers)
  const activeLayerId = useAppStore((s) => s.activeLayerId)

  const [pendingFocusId, setPendingFocusId] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)
  const dragSourceIndex = useRef(null)
  const inputRefs = useRef({})

  // Pass a setter (not the ref object) to LayerRow so React's
  // immutability rules stay clean even though the underlying map mutates.
  const setInputRef = (id, el) => {
    if (el) inputRefs.current[id] = el
    else delete inputRefs.current[id]
  }

  // Focus the name input of a newly-added layer (Spec §5: "cursor auto-focuses
  // the name input of the new row"). Pendings clear after the effect runs.
  useEffect(() => {
    if (!pendingFocusId) return
    const el = inputRefs.current[pendingFocusId]
    if (el) {
      el.focus()
      el.select()
      setPendingFocusId(null)
    }
  }, [pendingFocusId, layers])

  const handleAdd = () => {
    const id = useAppStore.getState().addLayer({ color: '#ffffff' })
    setPendingFocusId(id)
  }
  // Step 14 / Punch List P15 RESOLVED — Clear All removed from the
  // LayerPanel header. Project-wipe semantics now live as "New Project"
  // in the persistent-header dropdown menu (HeaderMenu.jsx).

  // ---- Drag-and-drop reorder (HTML5 D&D, desktop only) -------------------
  const onDragStart = (e, index) => {
    dragSourceIndex.current = index
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', String(index)) } catch { /* Safari quirk */ }
  }
  const onDragOver = (e, index) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverIndex !== index) setDragOverIndex(index)
  }
  const onDragLeave = () => setDragOverIndex(null)
  const onDrop = (e, targetIndex) => {
    e.preventDefault()
    const sourceIndex = dragSourceIndex.current
    setDragOverIndex(null)
    dragSourceIndex.current = null
    if (sourceIndex == null || sourceIndex === targetIndex) return
    const idsInOrder = layers.map((l) => l.id)
    const [moved] = idsInOrder.splice(sourceIndex, 1)
    idsInOrder.splice(targetIndex, 0, moved)
    useAppStore.getState().reorderLayers(idsInOrder)
  }
  const onDragEnd = () => {
    setDragOverIndex(null)
    dragSourceIndex.current = null
  }

  return (
    <aside className="panel-left" aria-label="Layer / sequence panel">
      <div className="panel-header layer-panel-header">
        <span className="panel-title">Layers</span>
        <button
          type="button"
          className="btn-panel-action btn-add"
          onClick={handleAdd}
          title="Add a new layer"
          data-testid="btn-add-layer"
        >
          + Add
        </button>
      </div>

      <div className="panel-body layer-panel-body">
        {layers.length === 0 ? (
          <div className="panel-empty">
            No layers yet — tap <strong>+ Add</strong> to start.
          </div>
        ) : (
          <ul className="layer-list" role="list">
            {layers.map((layer, index) => (
              <LayerRow
                key={layer.id}
                layer={layer}
                index={index}
                isActive={layer.id === activeLayerId}
                isDragOver={dragOverIndex === index}
                setInputRef={setInputRef}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function LayerRow({
  layer,
  index,
  isActive,
  isDragOver,
  setInputRef,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}) {
  const handleDelete = (e) => {
    e.stopPropagation()
    const ok = window.confirm(
      `Delete layer "${layer.name}" and ${layer.shapes?.length || 0} shape(s)?`
    )
    if (ok) useAppStore.getState().deleteLayer(layer.id)
  }

  const handleVisibilityToggle = (e) => {
    e.stopPropagation()
    useAppStore.getState().toggleLayerVisibility(layer.id)
  }

  // Row activation runs on mousedown (not click) so it fires regardless of
  // which child element the pointer lands on — clicks on the layer-name /
  // color inputs would otherwise be swallowed by the inputs' own
  // stopPropagation. Clicking vis/delete buttons also activates the row,
  // which is harmless: deleteLayer nulls the activeLayerId for the deleted
  // layer, and the other actions (color, name, visibility) are coherent
  // with "click on a row → that row is now active."
  const handleActivate = () => {
    useAppStore.getState().setActiveLayer(layer.id)
  }

  const handleColorChange = (e) => {
    useAppStore.getState().setLayerColor(layer.id, e.target.value)
  }

  const handleNameChange = (e) => {
    useAppStore.getState().renameLayer(layer.id, e.target.value)
  }

  const shapeCount = layer.shapes?.length || 0

  let className = 'layer-row'
  if (isActive) className += ' active'
  if (isDragOver) className += ' drag-over'

  return (
    <li
      className={className}
      draggable="true"
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, index)}
      onDragEnd={onDragEnd}
      onMouseDown={handleActivate}
      onTouchStart={handleActivate}
      data-layer-id={layer.id}
      data-layer-index={index}
    >
      <span className="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
      <input
        type="color"
        className="layer-color"
        value={layer.color || '#ffffff'}
        onChange={handleColorChange}
        onClick={(e) => e.stopPropagation()}
        title="Layer color"
        aria-label={`${layer.name} color`}
      />
      <input
        type="text"
        className="layer-name"
        value={layer.name}
        onChange={handleNameChange}
        onClick={(e) => e.stopPropagation()}
        ref={(el) => setInputRef(layer.id, el)}
        spellCheck={false}
        aria-label={`Layer ${index + 1} name`}
      />
      <span className="shape-count" title={`${shapeCount} shape${shapeCount === 1 ? '' : 's'}`}>
        ({shapeCount})
      </span>
      <button
        type="button"
        className={layer.visible ? 'btn-icon btn-vis on' : 'btn-icon btn-vis off'}
        onClick={handleVisibilityToggle}
        title={layer.visible ? 'Hide layer' : 'Show layer'}
        aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
        aria-pressed={layer.visible}
        data-testid={`btn-vis-${layer.id}`}
      >
        {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      <button
        type="button"
        className="btn-icon btn-delete"
        onClick={handleDelete}
        title="Delete layer"
        aria-label="Delete layer"
      >
        ✕
      </button>
    </li>
  )
}
