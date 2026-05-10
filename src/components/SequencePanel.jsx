import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * SequencePanel — Step 11 of Kickoff Spec §10.
 *
 * Tab body for the Sequences tab in the right drawer. Owns the sequence
 * list (add / reorder / activate / rename / delete) and the per-sequence
 * layer-visibility toggles for the ACTIVE sequence.
 *
 * Layout:
 *   ┌──────────────────────────┐
 *   │ Sequences        [+ Add] │  <- panel-header
 *   ├──────────────────────────┤
 *   │ ⠿ ● S1 — Tear-off    ✕  │  <- sequence row (active)
 *   │ ⠿ ○ S2 — Dry-in      ✕  │  <- sequence row
 *   │ ⠿ ○ S3 — Shingles    ✕  │
 *   ├──────────────────────────┤
 *   │ Layers in S1 — Tear-off  │  <- per-active-seq layer toggle list
 *   │   ● Substrate (visible)  │
 *   │   ○ Underlayment (hidden)│
 *   │   ● Shingles (visible)   │
 *   └──────────────────────────┘
 *
 * Active-sequence indicator: filled blue dot ● vs hollow ○. Clicking the
 * sequence row sets it active (Step 9 mousedown-vs-click pattern carried
 * forward — activation fires on `onMouseDown` so the click is robust to
 * inputs/buttons inside the row).
 *
 * Per-layer visibility default: TRUE (a layer not explicitly listed in
 * `seq.layers` is assumed visible in that sequence). This keeps newly
 * added layers visible across all existing sequences without forcing
 * the operator to revisit each one. Operators selectively hide layers
 * via the toggle list.
 *
 * Drag-reorder uses HTML5 D&D — same pattern as LayerPanel. Touch reorder
 * is a future enhancement (matches LayerPanel's known limitation).
 */
export default function SequencePanel() {
  const sequences = useAppStore((s) => s.sequences)
  const layers = useAppStore((s) => s.layers)
  const activeSeqId = useAppStore((s) => s.activeSeqId)

  const [pendingFocusId, setPendingFocusId] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)
  const dragSourceIndex = useRef(null)

  const handleAdd = () => {
    const id = useAppStore.getState().addSequence()
    setPendingFocusId(id)
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
    const idsInOrder = sequences.map((seq) => seq.id)
    const [moved] = idsInOrder.splice(sourceIndex, 1)
    idsInOrder.splice(targetIndex, 0, moved)
    useAppStore.getState().reorderSequences(idsInOrder)
  }
  const onDragEnd = () => {
    setDragOverIndex(null)
    dragSourceIndex.current = null
  }

  const activeSeq = sequences.find((s) => s.id === activeSeqId) || null

  return (
    <>
      <div className="panel-header sequence-panel-header">
        <span className="panel-title">Sequences</span>
        <button
          type="button"
          className="btn-panel-action btn-add"
          onClick={handleAdd}
          title="Add a new sequence"
          data-testid="btn-add-sequence"
        >
          + Add
        </button>
      </div>

      <div className="panel-body sequence-panel-body">
        {sequences.length === 0 ? (
          <div className="panel-empty">
            No sequences yet — tap <strong>+ Add</strong> to create one.
          </div>
        ) : (
          <ul className="sequence-list" role="list">
            {sequences.map((seq, index) => (
              <SequenceRow
                key={seq.id}
                sequence={seq}
                index={index}
                isActive={seq.id === activeSeqId}
                isDragOver={dragOverIndex === index}
                pendingFocus={pendingFocusId === seq.id}
                clearPendingFocus={() => setPendingFocusId(null)}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
              />
            ))}
          </ul>
        )}

        {activeSeq && (
          <section className="sequence-layer-list" aria-label="Layers in active sequence">
            <div className="sequence-layer-list-title">
              Layers in {activeSeq.title || activeSeq.id}
            </div>
            {layers.length === 0 ? (
              <div className="panel-empty">
                No layers yet. Add layers in the Layers panel; they appear here for per-sequence visibility.
              </div>
            ) : (
              <ul className="sequence-layer-toggles" role="list">
                {layers.map((layer) => {
                  // Default TRUE per file-level note — unlisted = visible in this sequence.
                  const visible = activeSeq.layers?.[layer.id] !== false
                  return (
                    <li key={layer.id} className="sequence-layer-toggle-row">
                      <button
                        type="button"
                        className={visible ? 'btn-icon btn-vis on' : 'btn-icon btn-vis off'}
                        onClick={() => useAppStore.getState().setSeqLayerVisibility(activeSeq.id, layer.id, !visible)}
                        title={visible ? `Hide "${layer.name}" in this sequence` : `Show "${layer.name}" in this sequence`}
                        aria-label={visible ? 'Visible in sequence' : 'Hidden in sequence'}
                        aria-pressed={visible}
                        data-testid={`seq-layer-vis-${layer.id}`}
                      >
                        {visible ? '●' : '○'}
                      </button>
                      <span
                        className="sequence-layer-name"
                        style={{ color: layer.color || '#ffffff' }}
                      >
                        {layer.name}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  )
}

function SequenceRow({
  sequence,
  index,
  isActive,
  isDragOver,
  pendingFocus,
  clearPendingFocus,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}) {
  const inputRef = useRef(null)

  // Focus the title input on the just-added sequence (Spec §10 parity with
  // LayerPanel + Add behavior). Effect-scheduled so the ref is read after
  // the row is committed, not during render.
  useEffect(() => {
    if (pendingFocus && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
      clearPendingFocus()
    }
  }, [pendingFocus, clearPendingFocus])

  const handleDelete = (e) => {
    e.stopPropagation()
    const ok = window.confirm(
      `Delete sequence "${sequence.title || sequence.id}" and ${(sequence.annotations || []).length} annotation(s)?`
    )
    if (ok) useAppStore.getState().deleteSequence(sequence.id)
  }

  // Pass 2 undo gap closure (May 10 2026) — setSeqTitle uses the focus→
  // blur edit-session pattern. Capture pre-edit snapshot on focus + the
  // original value, push the captured snapshot on blur if the value
  // actually changed. One undo entry per edit session.
  const titleSnapRef = useRef(null)
  const titleOriginalRef = useRef(null)
  const onTitleFocus = (e) => {
    titleSnapRef.current = useAppStore.getState().captureUndoSnapshot()
    titleOriginalRef.current = e.target.value
  }
  const onTitleBlur = (e) => {
    const original = titleOriginalRef.current
    const snap = titleSnapRef.current
    if (typeof original === 'string' && e.target.value !== original && typeof snap === 'string') {
      useAppStore.getState().pushCapturedSnapshot(snap)
    }
    titleSnapRef.current = null
    titleOriginalRef.current = null
  }
  const handleTitleChange = (e) => {
    useAppStore.getState().setSeqTitle(sequence.id, e.target.value)
  }

  // Same Step 9 mousedown-vs-click pattern as LayerRow — activation fires
  // on mousedown so clicking the inline title input still activates the row.
  const handleActivate = () => {
    useAppStore.getState().setActiveSequence(sequence.id)
  }

  let className = 'sequence-row'
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
      data-sequence-id={sequence.id}
      data-sequence-index={index}
    >
      <span className="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
      <span
        className={isActive ? 'seq-active-dot active' : 'seq-active-dot'}
        title={isActive ? 'Active sequence' : 'Click to activate'}
        aria-hidden="true"
      >
        {isActive ? '●' : '○'}
      </span>
      <input
        type="text"
        className="sequence-title"
        value={sequence.title || ''}
        onChange={handleTitleChange}
        onFocus={onTitleFocus}
        onBlur={onTitleBlur}
        onClick={(e) => e.stopPropagation()}
        ref={inputRef}
        spellCheck={false}
        aria-label={`Sequence ${index + 1} title`}
      />
      <button
        type="button"
        className="btn-icon btn-delete"
        onClick={handleDelete}
        title="Delete sequence"
        aria-label="Delete sequence"
      >
        ✕
      </button>
    </li>
  )
}
