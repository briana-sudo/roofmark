import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { parseLength } from '../utils/parseLength'
import { parseAngle } from '../utils/parseAngle'
import { parseMoveInput } from '../utils/parseMoveInput'
import { commitTechLine } from '../utils/techLineCommit'
import { techShapeCentroid, getSelectedTechShapes } from '../utils/techGeometry'
// 18d-edit boundary fix (May 11 2026) — operator-typed grip-edit delta
// is in INCHES; shape coords are canvas PIXELS. Convert at this caller
// (the store's commitGripEditCommand receives newPoint already in
// pixels). Imported from shared techConstants to match the convention
// used by commitMoveCommand / commitCopyCommand in the store.
import { PX_PER_INCH } from '../utils/techConstants'

/**
 * TechInputPanel — Phase 2 sub-step 18d-edit (May 11 2026).
 *
 * Replaces 18d-pivot's rotation-only panel with AutoCAD command pattern.
 *
 * Visibility (visible when appMode === 'TECHNICAL' AND one of):
 *   - tool === 'tech-line'              → length + angle inputs
 *   - tool === 'tech-select' &&
 *     (techGripEdit !== null            → grip-edit input
 *      OR techActiveCommand !== null    → command input bar (rotate/move/copy)
 *      OR techSelected.length > 0)      → command-button bar
 *   - otherwise hidden
 *
 * State machine (all read from store):
 *   - techActiveCommand: 'rotate' | 'move' | 'copy' | null
 *   - techCommandBasePoint: {x,y} | null (set once base picked)
 *   - techCommandOriginShapes: Array<shape> | null
 *   - techCommandPreSnap: string | null
 *   - techCommandInput: parsed value | null (not used as render source;
 *                       local rawInput drives the visible field)
 *   - techGripEdit: {layerId, shapeId, pointKey, originPoint, preSnap} | null
 *
 * Per-command typed Enter behavior:
 *   - Rotate: reset origins, apply absolute typed degrees around base point
 *   - Move: reset origins, apply typed delta (parseMoveInput)
 *   - Copy: add clones at typed offset (parseMoveInput), originals stay
 *   - Grip edit: apply typed delta to originPoint, update endpoint
 *
 * Cancel button: revert in-progress preview + clear command state.
 *                Selection PERSISTS (operator can re-run a command).
 *
 * Delete button: instant — push snapshot, remove selected, clear sel.
 *                No confirm dialog (Cmd+Z is the safety).
 */
export default function TechInputPanel() {
  const appMode = useAppStore((s) => s.appMode)
  const tool = useAppStore((s) => s.tool)
  const techDraft = useAppStore((s) => s.techDraft)
  const setTechDraft = useAppStore((s) => s.setTechDraft)
  const techSelected = useAppStore((s) => s.techSelected)
  // 18d-edit command + grip state.
  const techActiveCommand = useAppStore((s) => s.techActiveCommand)
  const techCommandBasePoint = useAppStore((s) => s.techCommandBasePoint)
  const techCommandOriginShapes = useAppStore((s) => s.techCommandOriginShapes)
  const techCommandPreSnap = useAppStore((s) => s.techCommandPreSnap)
  const techGripEdit = useAppStore((s) => s.techGripEdit)
  const setTechActiveCommand = useAppStore((s) => s.setTechActiveCommand)
  const setTechCommandBasePoint = useAppStore((s) => s.setTechCommandBasePoint)
  const setTechCommandOriginShapes = useAppStore((s) => s.setTechCommandOriginShapes)
  const setTechCommandPreSnap = useAppStore((s) => s.setTechCommandPreSnap)
  const setTechCommandInput = useAppStore((s) => s.setTechCommandInput)
  const setTechCommandHover = useAppStore((s) => s.setTechCommandHover)
  const setTechGripEdit = useAppStore((s) => s.setTechGripEdit)
  const updateTechnicalShapeNoUndo = useAppStore((s) => s.updateTechnicalShapeNoUndo)
  // 18d-edit commit actions (May 11 2026 addendum) — single source of
  // truth so typed-Enter and CanvasStage click-commit reach the same
  // implementation.
  const commitRotateCommand = useAppStore((s) => s.commitRotateCommand)
  const commitMoveCommand = useAppStore((s) => s.commitMoveCommand)
  const commitCopyCommand = useAppStore((s) => s.commitCopyCommand)
  const commitDeleteCommand = useAppStore((s) => s.commitDeleteCommand)
  const commitGripEditCommand = useAppStore((s) => s.commitGripEditCommand)
  const clearTechSelection = useAppStore((s) => s.clearTechSelection)
  // Phase 2 18e (May 12 2026) — dimension command state + actions.
  const techDimStage = useAppStore((s) => s.techDimStage)
  const techDimPointA = useAppStore((s) => s.techDimPointA)
  const techDimPointB = useAppStore((s) => s.techDimPointB)
  const setTechDimStage = useAppStore((s) => s.setTechDimStage)
  const setTechDimPointA = useAppStore((s) => s.setTechDimPointA)
  const setTechDimPointB = useAppStore((s) => s.setTechDimPointB)
  const commitWorkflow1Dimension = useAppStore((s) => s.commitWorkflow1Dimension)
  const captureUndoSnapshot = useAppStore((s) => s.captureUndoSnapshot)
  const technicalLayers = useAppStore((s) => s.technicalLayers)
  // Total tech-shape count — trigger to clear tech-line inputs after commit.
  const totalShapes = useAppStore((s) =>
    (s.technicalLayers || []).reduce((n, tl) => n + (tl.shapes?.length || 0), 0)
  )

  // Phase 2 18e — selection composition check for the Dim-button-dispatch
  // and the Rotate/Move/Copy-hide rule per spec §"Decision flags" #11+#12.
  //   selectionHasDimension: true if ANY selected shape is a dimension →
  //                          Rotate/Move/Copy hidden (out of scope for
  //                          18e initial — dim mutation via parent only).
  //   workflow1Eligible:     true ONLY when selection is exactly one
  //                          line. Anything else (empty, multi, dim,
  //                          mixed) routes through Workflow 2.
  const selectionShapes = useMemo(
    () => getSelectedTechShapes(technicalLayers, techSelected),
    [technicalLayers, techSelected],
  )
  const selectionHasDimension = selectionShapes.some((sh) => sh.type === 'dimension')
  const workflow1Eligible = selectionShapes.length === 1 && selectionShapes[0].type === 'line'

  // Local raw input state (one per render branch; only one is active at a time).
  const [rawLength, setRawLength] = useState('')
  const [rawAngle, setRawAngle] = useState('')
  const [rawCommandInput, setRawCommandInput] = useState('')
  const [rawGripInput, setRawGripInput] = useState('')
  const [unit, setUnit] = useState('degrees') // 'degrees' | 'pitch'

  const lengthInputRef = useRef(null)
  const angleInputRef = useRef(null)
  const commandInputRef = useRef(null)
  const gripInputRef = useRef(null)
  const prevShapesRef = useRef(totalShapes)

  // Visibility (derived).
  // Phase 2 18e (May 12 2026) — the panel now ALWAYS renders under
  // tech-select (was previously gated on `grip || command || selection`).
  // Reason: the Dim button is the entry point to Workflow 2 (2-point
  // pick), which by definition starts with NO selection. Without an
  // always-visible panel, the Dim button can't be reached from an
  // empty-selection state and Workflow 2 is undiscoverable.
  // Different render branches inside the panel switch on state — the
  // visibility broadening is purely additive.
  const isLineMode = appMode === 'TECHNICAL' && tool === 'tech-line'
  const isSelectMode = appMode === 'TECHNICAL' && tool === 'tech-select'
  const visible = isLineMode || isSelectMode
  const anchorPlaced = !!(techDraft && techDraft.a)

  const parsedInches = parseLength(rawLength)
  const parsedAngle = parseAngle(rawAngle, unit)
  const lengthInvalid = rawLength.length > 0 && parsedInches === null
  const angleInvalid = rawAngle.length > 0 && parsedAngle === null

  // Autofocus the right input when render branch changes.
  useEffect(() => {
    if (isLineMode) {
      lengthInputRef.current?.focus()
    } else if (isSelectMode) {
      if (techGripEdit) gripInputRef.current?.focus()
      else if (techActiveCommand && techCommandBasePoint) commandInputRef.current?.focus()
    }
  }, [isLineMode, isSelectMode, techGripEdit, techActiveCommand, techCommandBasePoint])

  // Clear tech-line raw inputs after a successful tech-line commit.
  useEffect(() => {
    if (totalShapes > prevShapesRef.current) {
      setRawLength('')
      setRawAngle('')
    }
    prevShapesRef.current = totalShapes
  }, [totalShapes])

  // Reset rawCommandInput / rawGripInput when their backing state clears.
  const prevCmdRef = useRef(techActiveCommand)
  const prevGripRef = useRef(techGripEdit)
  useEffect(() => {
    if (prevCmdRef.current && !techActiveCommand) setRawCommandInput('')
    if (prevGripRef.current && !techGripEdit) setRawGripInput('')
    prevCmdRef.current = techActiveCommand
    prevGripRef.current = techGripEdit
  }, [techActiveCommand, techGripEdit])

  // ===== tech-line handlers (unchanged from 18c) =====
  const onLengthChange = (e) => {
    const next = e.target.value
    setRawLength(next)
    const p = parseLength(next)
    const cur = useAppStore.getState().techDraft
    if (cur) setTechDraft({ ...cur, typedInches: p })
    else setTechDraft({ a: null, typedInches: p, typedAngleDegrees: null })
  }
  const onAngleChange = (e) => {
    const next = e.target.value
    setRawAngle(next)
    const p = parseAngle(next, unit)
    const cur = useAppStore.getState().techDraft
    if (cur) setTechDraft({ ...cur, typedAngleDegrees: p })
    else setTechDraft({ a: null, typedInches: null, typedAngleDegrees: p })
  }
  const handleLineEnter = () => {
    const s = useAppStore.getState()
    const d = s.techDraft
    if (!d || !d.a) return
    if (parsedInches === null || parsedAngle === null) return
    const v = s.viewports?.TECHNICAL || { panX: 0, panY: 0, zoom: 1 }
    const cursorW = {
      x: (s.cursorX - v.panX) / (v.zoom || 1),
      y: (s.cursorY - v.panY) / (v.zoom || 1),
    }
    commitTechLine({
      anchor: d.a, cursorWorld: cursorW,
      typedInches: parsedInches, typedAngleDegrees: parsedAngle,
      addTechnicalShape: s.addTechnicalShape, setTechDraft: s.setTechDraft,
    })
  }
  const handleLineEscape = () => setTechDraft(null)
  const onLineKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleLineEnter() }
    else if (e.key === 'Escape') { e.preventDefault(); handleLineEscape() }
  }
  const onToggleUnit = () => {
    const nextUnit = unit === 'degrees' ? 'pitch' : 'degrees'
    setUnit(nextUnit)
    const cur = useAppStore.getState().techDraft
    if (cur && rawAngle.length > 0) {
      const p = parseAngle(rawAngle, nextUnit)
      setTechDraft({ ...cur, typedAngleDegrees: p })
    }
    angleInputRef.current?.focus()
  }

  // ===== 18d-edit command handlers =====
  const startCommand = (cmd) => {
    setTechActiveCommand(cmd)
    setRawCommandInput('')
  }

  const cancelCommand = () => {
    // Revert any live preview (rotate/move; copy doesn't mutate origins
    // so the revert loop is a safe no-op).
    if (Array.isArray(techCommandOriginShapes)) {
      for (const orig of techCommandOriginShapes) {
        const selEntry = techSelected.find((s) => s.shapeId === orig.id)
        if (selEntry) {
          updateTechnicalShapeNoUndo(selEntry.layerId, orig.id, orig)
        }
      }
    }
    setTechActiveCommand(null)
    setTechCommandBasePoint(null)
    setTechCommandOriginShapes(null)
    setTechCommandPreSnap(null)
    setTechCommandInput(null)
    setTechCommandHover(null)
    setRawCommandInput('')
    // Selection persists on Cancel (matches AutoCAD: Esc/Cancel exits
    // the command, keeps selection for the next attempt).
  }

  const clearAllCommandState = () => {
    setTechActiveCommand(null)
    setTechCommandBasePoint(null)
    setTechCommandOriginShapes(null)
    setTechCommandPreSnap(null)
    setTechCommandInput(null)
    setTechCommandHover(null)
    setRawCommandInput('')
  }

  const commitTypedCommand = () => {
    if (!techActiveCommand || !techCommandBasePoint || !Array.isArray(techCommandOriginShapes)) return
    const origins = techCommandOriginShapes
    const basePoint = techCommandBasePoint
    const preSnap = techCommandPreSnap
    const cmd = techActiveCommand

    if (cmd === 'rotate') {
      const deg = parseAngle(rawCommandInput, 'degrees')
      if (deg === null) return
      // Compute delta = typed - baselineFromOriginCentroid. The store
      // commitRotateCommand takes the delta and writes rotated origins
      // to live state in one set() — overwrites any live-preview state
      // implicitly (so the "revert origins first" loop is unnecessary).
      const firstCentroid = techShapeCentroid(origins[0])
      if (!firstCentroid) return
      const baselineDeg = (Math.atan2(
        firstCentroid.y - basePoint.y,
        firstCentroid.x - basePoint.x,
      ) * 180) / Math.PI
      const deltaDeg = deg - baselineDeg
      commitRotateCommand(origins, basePoint, deltaDeg, preSnap)
    } else if (cmd === 'move') {
      const delta = parseMoveInput(rawCommandInput)
      if (!delta) return
      commitMoveCommand(origins, delta, preSnap)
    } else if (cmd === 'copy') {
      const delta = parseMoveInput(rawCommandInput)
      if (!delta) return
      commitCopyCommand(origins, delta, preSnap)
    }

    clearAllCommandState()
    clearTechSelection()  // selection clears on commit per AutoCAD convention
  }

  const onCommandKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitTypedCommand()
    }
    // Escape handled at document level (CanvasStage onKeyDown)
  }

  const handleDelete = () => {
    if (techSelected.length === 0) return
    const preSnap = useAppStore.getState().captureUndoSnapshot()
    commitDeleteCommand(techSelected.slice(), preSnap)
    clearTechSelection()
  }

  // ===== Phase 2 18e dimension handlers =====
  //
  // Dim button dispatch per spec §"Decision flags" #12:
  //   - Workflow 1: exactly one line selected → instant placement of
  //                 an aligned dim attached to that line's a/b.
  //   - Workflow 2: empty selection, multi-select, or selection
  //                 contains a dimension → enter 3-click state machine.
  //
  // captureUndoSnapshot at start of either workflow so Cmd+Z removes
  // the dim cleanly (matches single-undo-per-logical-command convention).
  const handleDim = () => {
    if (workflow1Eligible) {
      const lineShape = selectionShapes[0]
      const layer = technicalLayers.find((l) =>
        (l.shapes || []).some((sh) => sh.id === lineShape.id)
      )
      if (!layer) return
      const preSnap = captureUndoSnapshot()
      commitWorkflow1Dimension(lineShape.id, layer.id, preSnap)
    } else {
      // Workflow 2: capture pre-command snapshot then enter state machine.
      // CanvasStage's onMouseDown handles the 3 clicks; this handler
      // just starts the command.
      const preSnap = captureUndoSnapshot()
      setTechCommandPreSnap(preSnap)
      setTechActiveCommand('dimension')
      setTechDimStage('awaitPointA')
      setTechDimPointA(null)
      setTechDimPointB(null)
    }
  }

  // Cancel button during dim command — equivalent to Escape per spec.
  // Cleans up all transient state regardless of stage.
  const cancelDimCommand = () => {
    setTechActiveCommand(null)
    setTechDimStage(null)
    setTechDimPointA(null)
    setTechDimPointB(null)
    setTechCommandHover(null)
    setTechCommandPreSnap(null)
  }

  // ===== Grip-edit typed Enter =====
  const commitTypedGripEdit = () => {
    if (!techGripEdit) return
    const delta = parseMoveInput(rawGripInput)
    if (!delta) return
    // 18d-edit boundary fix (May 11 2026) — parseMoveInput returns
    // operator-typed INCHES. techGripEdit.originPoint is in canvas
    // PIXELS (read from the live shape's a or b field at grip-pick
    // time). Multiply at this boundary before adding to the origin.
    const dxPx = delta.dx * PX_PER_INCH
    const dyPx = delta.dy * PX_PER_INCH
    const newPoint = {
      x: techGripEdit.originPoint.x + dxPx,
      y: techGripEdit.originPoint.y + dyPx,
    }
    // Use store action for consistency with click-commit path AND for
    // testability (the Node test runner calls commitGripEditCommand
    // directly to verify undo/redo round-trip).
    commitGripEditCommand(
      techGripEdit.layerId,
      techGripEdit.shapeId,
      techGripEdit.pointKey,
      newPoint,
      techGripEdit.preSnap,
    )
    setTechGripEdit(null)
    setTechCommandInput(null)
    setTechCommandHover(null)
    setRawGripInput('')
    // Selection persists per AutoCAD grip-edit convention.
  }

  const onGripKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitTypedGripEdit()
    }
    // Escape handled at document level
  }

  if (!visible) return null

  // ===== Render: tech-line content =====
  if (isLineMode) {
    const anglePlaceholder = unit === 'degrees' ? `45 or 45°` : `4/12`
    const lengthPlaceholder = anchorPlaced ? `4"  or  1'6"` : `Click on canvas to place anchor`
    return (
      <div
        className="tech-input-panel"
        role="toolbar"
        aria-label="Technical Drawing line input"
        data-testid="tech-input-panel"
      >
        <div className="tip-row">
          <label htmlFor="tech-length-input-field">Length</label>
          <input
            id="tech-length-input-field"
            ref={lengthInputRef}
            type="text"
            className={lengthInvalid ? 'invalid' : ''}
            value={rawLength}
            onChange={onLengthChange}
            onKeyDown={onLineKeyDown}
            placeholder={lengthPlaceholder}
            aria-invalid={lengthInvalid}
            data-testid="tech-length-input-field"
          />
        </div>
        <div className="tip-row">
          <label htmlFor="tech-angle-input-field">Angle</label>
          <input
            id="tech-angle-input-field"
            ref={angleInputRef}
            type="text"
            className={angleInvalid ? 'invalid' : ''}
            value={rawAngle}
            onChange={onAngleChange}
            onKeyDown={onLineKeyDown}
            placeholder={anglePlaceholder}
            aria-invalid={angleInvalid}
            data-testid="tech-angle-input-field"
          />
        </div>
        <button
          type="button"
          className={unit === 'degrees' ? 'unit-toggle active' : 'unit-toggle'}
          onClick={onToggleUnit}
          aria-pressed={unit === 'degrees'}
          data-testid="tech-unit-toggle"
        >
          {unit === 'degrees' ? 'Degrees' : 'Pitch'}
        </button>
        {!anchorPlaced && (
          <span className="placeholder-hint" data-testid="tech-placeholder-hint">
            Click on canvas to place anchor
          </span>
        )}
      </div>
    )
  }

  // ===== Render: tech-select branches =====

  // Grip edit branch — operator clicked a blue grip, endpoint is being edited.
  if (techGripEdit) {
    return (
      <div className="tech-input-panel" role="toolbar" data-testid="tech-input-panel">
        <span className="cmd-prompt">Edit endpoint: click new position or type</span>
        <input
          ref={gripInputRef}
          type="text"
          value={rawGripInput}
          onChange={(e) => setRawGripInput(e.target.value)}
          onKeyDown={onGripKeyDown}
          placeholder="24, 0 or 24 @ 45"
          autoFocus
          data-testid="tech-grip-input-field"
        />
      </div>
    )
  }

  // Phase 2 18e — Dimension command branch (Workflow 2 state machine).
  // Three stage-specific prompts plus a Cancel button. CanvasStage's
  // mousedown drives the state machine; this panel just displays where
  // the operator is in the flow.
  if (techActiveCommand === 'dimension') {
    const dimPrompts = {
      awaitPointA: 'Dimension: click first point (snap-aware)',
      awaitPointB: 'Dimension: click second point',
      awaitPosition: 'Dimension: drag to position dimension line; click to commit',
    }
    const promptText = dimPrompts[techDimStage] || 'Dimension'
    return (
      <div className="tech-input-panel" role="toolbar" data-testid="tech-input-panel">
        <span className="cmd-prompt" data-testid="tech-dim-prompt">{promptText}</span>
        <button
          type="button"
          className="cmd-cancel"
          onClick={cancelDimCommand}
          data-testid="tech-dim-cancel-button"
        >
          Cancel
        </button>
      </div>
    )
  }

  // Active command branch.
  if (techActiveCommand) {
    const cmdLabel = { rotate: 'Rotate', move: 'Move', copy: 'Copy' }[techActiveCommand] || techActiveCommand
    const placeholder = techActiveCommand === 'rotate'
      ? '45 or 45° or 4/12'
      : '24, 0 or 24 @ 45 or 24 @ 4/12'
    const promptText = techCommandBasePoint
      ? `${cmdLabel}: type ${placeholder} and press Enter, or click to commit`
      : `${cmdLabel}: click base point on canvas`
    return (
      <div className="tech-input-panel" role="toolbar" data-testid="tech-input-panel">
        <span className="cmd-prompt">{promptText}</span>
        {techCommandBasePoint && (
          <input
            ref={commandInputRef}
            type="text"
            value={rawCommandInput}
            onChange={(e) => setRawCommandInput(e.target.value)}
            onKeyDown={onCommandKeyDown}
            placeholder={placeholder}
            autoFocus
            data-testid="tech-command-input-field"
          />
        )}
        <button
          type="button"
          className="cmd-cancel"
          onClick={cancelCommand}
          data-testid="tech-cancel-button"
        >
          Cancel
        </button>
      </div>
    )
  }

  // Phase 2 18e (May 12 2026) — empty-selection branch under tech-select.
  // Renders ONLY the Dim button + a hint so Workflow 2 is discoverable
  // even when there's no selection. Per spec §"Workflow 1" + §"Workflow 2":
  // the Dim button is always available under tech-select; the workflow
  // chosen depends on selection composition.
  if (techSelected.length === 0) {
    return (
      <div className="tech-input-panel" role="toolbar" data-testid="tech-input-panel">
        <button
          type="button"
          className="cmd-btn"
          onClick={handleDim}
          data-testid="tech-dim-button"
        >
          📏 Dim
        </button>
        <span className="placeholder-hint">
          Click Dim to start a 2-point dimension, or select a shape to edit it.
        </span>
      </div>
    )
  }

  // Default tech-select branch: selection without active command — show command bar.
  // Phase 2 18e: when ANY selected shape is a dimension, hide
  // Rotate/Move/Copy per spec §"Decision flags" #11 (those operations
  // are out of scope for 18e initial on dim shapes — Delete + recreate
  // is the workflow). Dim button is always present.
  return (
    <div className="tech-input-panel" role="toolbar" data-testid="tech-input-panel">
      {!selectionHasDimension && (
        <>
          <button
            type="button"
            className="cmd-btn"
            onClick={() => startCommand('rotate')}
            data-testid="tech-rotate-button"
          >
            ↻ Rotate
          </button>
          <button
            type="button"
            className="cmd-btn"
            onClick={() => startCommand('move')}
            data-testid="tech-move-button"
          >
            → Move
          </button>
          <button
            type="button"
            className="cmd-btn"
            onClick={() => startCommand('copy')}
            data-testid="tech-copy-button"
          >
            ⧉ Copy
          </button>
        </>
      )}
      <button
        type="button"
        className="cmd-btn"
        onClick={handleDim}
        data-testid="tech-dim-button"
      >
        📏 Dim
      </button>
      <button
        type="button"
        className="cmd-btn cmd-danger"
        onClick={handleDelete}
        data-testid="tech-delete-button"
      >
        ✕ Delete
      </button>
      <span className="tech-selection-count" data-testid="tech-selection-count">
        {techSelected.length} selected
      </span>
    </div>
  )
}
