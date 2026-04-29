import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

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

  const handleClearAll = () => {
    const ok = window.confirm(
      'This will remove ALL layers and shapes. This cannot be undone.'
    )
    if (ok) useAppStore.getState().clearAll()
  }

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
        <button
          type="button"
          className="btn-panel-action btn-clear"
          onClick={handleClearAll}
          title="Remove all layers and shapes"
          disabled={layers.length === 0}
          data-testid="btn-clear-all"
        >
          Clear All
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
      >
        {layer.visible ? '●' : '○'}
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
