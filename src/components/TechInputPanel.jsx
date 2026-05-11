import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { parseLength } from '../utils/parseLength'
import { parseAngle } from '../utils/parseAngle'
import { commitTechLine } from '../utils/techLineCommit'
import {
  techShapeCentroid, techMultiShapeCentroid,
  rotateTechShape, getSelectedTechShapes,
} from '../utils/techGeometry'

/**
 * TechInputPanel — Phase 2 sub-step 18c DOCKED PIVOT (May 11 2026),
 * extended in 18d (May 11 2026) with a rotation input mode for the
 * Select tool.
 *
 * Visibility predicate (tool-aware):
 *   - tool === 'tech-line'                                    → length + angle inputs
 *   - tool === 'tech-select' && techSelected.length > 0       → rotation input
 *   - otherwise                                                → hidden (null)
 *
 * The docked container + flex layout is shared across tool modes; the
 * inner content swaps by tool. Future Technical Drawing tools (rect /
 * arc in 18d+, callouts in 18e+) extend this same switch.
 *
 * Rotation input behavior:
 *   - Operator types an absolute angle in degrees (CCW positive,
 *     canvas-Y-down convention — matches 18c typedAngleDegrees).
 *   - Enter: commit rotation. For a single-shape selection, the line's
 *     current orientation is computed via atan2(b.y - a.y, b.x - a.x);
 *     delta = typed - current; the shape rotates by delta around its
 *     centroid. For multi-select, the FIRST selected shape's
 *     orientation is the reference (delta = typed - first.angle);
 *     all shapes rotate by the same delta around the combined bbox
 *     centroid. Commit pushes one undo entry. Local input clears.
 *   - Escape: clear selection + typed rotation input (Item 7 of
 *     locked decisions). Document-level CanvasStage Escape handler
 *     also covers this when focus is on the canvas.
 *
 * Carried forward from 18c:
 *   - Single autofocus on mount (length input for tech-line; rotation
 *     input for tech-select).
 *   - Commit-clears-inputs useEffect (technicalLayers shape-count
 *     increment triggers reset).
 *   - Pre-fill flow for tech-line (onLengthChange / onAngleChange
 *     write into techDraft even when techDraft is null).
 */
export default function TechInputPanel() {
  const appMode = useAppStore((s) => s.appMode)
  const tool = useAppStore((s) => s.tool)
  const techDraft = useAppStore((s) => s.techDraft)
  const setTechDraft = useAppStore((s) => s.setTechDraft)
  const techSelected = useAppStore((s) => s.techSelected)
  const technicalLayers = useAppStore((s) => s.technicalLayers)
  const techRotationInput = useAppStore((s) => s.techRotationInput)
  const setTechRotationInput = useAppStore((s) => s.setTechRotationInput)
  // Phase 2 18d-pivot (May 11 2026) — operator-chosen rotation pivot.
  // Set Pivot button reads + drives these. Pivot reset on rotation
  // commit happens in handleRotationEnter below.
  const techPivot = useAppStore((s) => s.techPivot)
  const techPivotPickMode = useAppStore((s) => s.techPivotPickMode)
  const setTechPivot = useAppStore((s) => s.setTechPivot)
  const setTechPivotPickMode = useAppStore((s) => s.setTechPivotPickMode)
  const setTechPivotHover = useAppStore((s) => s.setTechPivotHover)
  // Total tech-shape count across all technical layers — the trigger
  // signal for clearing line inputs after a successful tech-line commit.
  const totalShapes = useAppStore((s) =>
    (s.technicalLayers || []).reduce((n, tl) => n + (tl.shapes?.length || 0), 0)
  )

  const [rawLength, setRawLength] = useState('')
  const [rawAngle, setRawAngle] = useState('')
  const [rawRotation, setRawRotation] = useState('')
  const [unit, setUnit] = useState('degrees') // 'degrees' | 'pitch'
  const lengthInputRef = useRef(null)
  const angleInputRef = useRef(null)
  const rotationInputRef = useRef(null)
  const prevShapesRef = useRef(totalShapes)

  // Visibility predicate. tech-line: always visible when tool active.
  // tech-select: visible only when something is selected (no point
  // showing a rotation input with no shapes to rotate).
  const isLineMode = appMode === 'TECHNICAL' && tool === 'tech-line'
  const isSelectMode = appMode === 'TECHNICAL' && tool === 'tech-select' && techSelected.length > 0
  const visible = isLineMode || isSelectMode
  const anchorPlaced = !!(techDraft && techDraft.a)

  const parsedInches = parseLength(rawLength)
  const parsedAngle = parseAngle(rawAngle, unit)
  const parsedRotation = parseAngle(rawRotation, 'degrees')
  const lengthInvalid = rawLength.length > 0 && parsedInches === null
  const angleInvalid = rawAngle.length > 0 && parsedAngle === null
  const rotationInvalid = rawRotation.length > 0 && parsedRotation === null

  // Autofocus the right input when the panel becomes visible OR the
  // operator switches between line / select modes.
  useEffect(() => {
    if (isLineMode) {
      lengthInputRef.current?.focus()
    } else if (isSelectMode) {
      rotationInputRef.current?.focus()
    }
  }, [isLineMode, isSelectMode])

  // Clear local line inputs after a successful tech-line commit.
  useEffect(() => {
    if (totalShapes > prevShapesRef.current) {
      setRawLength('')
      setRawAngle('')
    }
    prevShapesRef.current = totalShapes
  }, [totalShapes])

  // 18d — Sync local rawRotation with external state changes (selection
  // clears OR techRotationInput nulled). React 19's
  // react-hooks/set-state-in-effect rule discourages setState-in-effect
  // generally, but here the clearing IS a sync — the source of truth
  // (techSelected / techRotationInput in the store) becoming null
  // means "no selection / no typed value to display." Tracking the
  // transition via a ref keeps the setState call from flapping. The
  // refactor to fully-derived display would push rawRotation into the
  // store (string + parsed pair) and is deferred to 18e+ when more
  // tool input panels share this pattern.
  const prevSelLenRef = useRef(techSelected.length)
  const prevRotInputRef = useRef(techRotationInput)
  useEffect(() => {
    const selJustEmptied = prevSelLenRef.current > 0 && techSelected.length === 0
    const rotJustNulled = prevRotInputRef.current !== null && techRotationInput === null
    if (selJustEmptied || rotJustNulled) {
      setRawRotation('')
    }
    prevSelLenRef.current = techSelected.length
    prevRotInputRef.current = techRotationInput
  }, [techSelected.length, techRotationInput])

  // ===== tech-line handlers (carried forward from 18c) =====
  const onLengthChange = (e) => {
    const next = e.target.value
    setRawLength(next)
    const p = parseLength(next)
    const cur = useAppStore.getState().techDraft
    if (cur) {
      setTechDraft({ ...cur, typedInches: p })
    } else {
      setTechDraft({ a: null, typedInches: p, typedAngleDegrees: null })
    }
  }

  const onAngleChange = (e) => {
    const next = e.target.value
    setRawAngle(next)
    const p = parseAngle(next, unit)
    const cur = useAppStore.getState().techDraft
    if (cur) {
      setTechDraft({ ...cur, typedAngleDegrees: p })
    } else {
      setTechDraft({ a: null, typedInches: null, typedAngleDegrees: p })
    }
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
      anchor: d.a,
      cursorWorld: cursorW,
      typedInches: parsedInches,
      typedAngleDegrees: parsedAngle,
      addTechnicalShape: s.addTechnicalShape,
      setTechDraft: s.setTechDraft,
    })
  }

  const handleLineEscape = () => {
    setTechDraft(null)
  }

  const onLineKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleLineEnter()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleLineEscape()
    }
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

  // ===== tech-select (rotation input) handlers (18d) =====
  const onRotationChange = (e) => {
    const next = e.target.value
    setRawRotation(next)
    const p = parseAngle(next, 'degrees')
    setTechRotationInput(p)
  }

  const handleRotationEnter = () => {
    // Commit rotation: rotate all selected shapes so that the FIRST
    // selected shape ends up at the typed absolute angle. Delta is
    // computed against the first shape's current orientation; all
    // shapes rotate by the same delta around the combined pivot.
    if (parsedRotation === null) return
    const shapes = getSelectedTechShapes(technicalLayers, techSelected)
    if (shapes.length === 0) return
    const first = shapes[0]
    if (first.type !== 'line') return
    const currAngleDeg = (Math.atan2(first.b.y - first.a.y, first.b.x - first.a.x) * 180) / Math.PI
    const deltaDeg = parsedRotation - currAngleDeg
    const pivot = techSelected.length === 1
      ? techShapeCentroid(first)
      : techMultiShapeCentroid(shapes)
    if (!pivot) return
    // Apply rotation. updateTechnicalShape (with pushUndo) is called
    // once per shape; the first call pushes the undo snapshot, the
    // rest are batched into the same logical edit at the React-render
    // level. Operator's Cmd+Z undoes the entire multi-shape rotation
    // as one entry IF we push only one snapshot — but each call to
    // updateTechnicalShape pushes a fresh snapshot. To keep "one undo
    // per rotation commit," we use the capture+push pattern.
    const snap = useAppStore.getState().captureUndoSnapshot()
    for (let i = 0; i < shapes.length; i++) {
      const sh = shapes[i]
      const entry = techSelected[i]
      if (!entry) continue
      const rotated = rotateTechShape(sh, pivot, deltaDeg)
      // No-undo mutator — we own the undo lifecycle via the captured snapshot.
      useAppStore.getState().updateTechnicalShapeNoUndo(entry.layerId, entry.shapeId, rotated)
    }
    // Push one snapshot for the entire rotation commit.
    useAppStore.getState().pushCapturedSnapshot(snap)
    setRawRotation('')
    setTechRotationInput(null)
    // Phase 2 18d-pivot — pivot resets to centroid after each rotation
    // commit (operator decision May 11 2026 — pivot is a single-action
    // tool, not a sticky preference). Mirrors the same reset in
    // CanvasStage's drag-end path.
    setTechPivot(null)
  }

  const handleRotationEscape = () => {
    useAppStore.getState().clearTechSelection()
    setTechRotationInput(null)
    setRawRotation('')
  }

  const onRotationKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleRotationEnter()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleRotationEscape()
    }
  }

  // Phase 2 18d-pivot — Set Pivot button state machine + click handler.
  // Three visual states cycle in order based on current pivot state:
  //   1. Default (no locked pivot, not picking) — operator entry point.
  //   2. Picking (techPivotPickMode = true)     — waiting for canvas click.
  //   3. Locked  (techPivot non-null)           — operator-chosen pivot active.
  // Click on the button cycles: default → picking, picking → cancel (back to
  // default), locked → reset to default. Canvas click during picking locks
  // the pivot (handled in CanvasStage onMouseDown).
  let pivotButtonLabel
  let pivotButtonClassName
  let pivotButtonTooltip
  if (techPivotPickMode) {
    pivotButtonLabel = 'Click canvas…'
    pivotButtonClassName = 'tech-pivot-btn picking'
    pivotButtonTooltip = 'Click anywhere on the canvas to lock the pivot. Escape to cancel.'
  } else if (techPivot) {
    pivotButtonLabel = 'Pivot ↺'
    pivotButtonClassName = 'tech-pivot-btn locked'
    pivotButtonTooltip = 'Pivot locked. Click to reset to centroid.'
  } else {
    pivotButtonLabel = 'Set pivot'
    pivotButtonClassName = 'tech-pivot-btn'
    pivotButtonTooltip = 'Click to pick a custom rotation pivot. Then click on the canvas to lock it.'
  }
  const handlePivotClick = () => {
    if (techPivotPickMode) {
      setTechPivotPickMode(false)
      setTechPivotHover(null)
    } else if (techPivot) {
      setTechPivot(null)
    } else {
      setTechPivotPickMode(true)
      setTechPivotHover(null)
    }
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
            aria-label={'Length (inches or feet/inches). Enter to commit when both fields typed.'}
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
            aria-label={'Angle (degrees or rise/run pitch).'}
            data-testid="tech-angle-input-field"
          />
        </div>
        <button
          type="button"
          className={unit === 'degrees' ? 'unit-toggle active' : 'unit-toggle'}
          onClick={onToggleUnit}
          aria-pressed={unit === 'degrees'}
          title={unit === 'degrees' ? 'Switch to pitch (rise/run)' : 'Switch to degrees'}
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

  // ===== Render: tech-select (rotation) content =====
  return (
    <div
      className="tech-input-panel"
      role="toolbar"
      aria-label="Technical Drawing rotation input"
      data-testid="tech-input-panel"
    >
      <div className="tip-row">
        <label htmlFor="tech-rotation-input-field">Rotate</label>
        <input
          id="tech-rotation-input-field"
          ref={rotationInputRef}
          type="text"
          className={rotationInvalid ? 'invalid' : ''}
          value={rawRotation}
          onChange={onRotationChange}
          onKeyDown={onRotationKeyDown}
          placeholder="45 or 45°"
          aria-invalid={rotationInvalid}
          aria-label={'Rotation angle in degrees (absolute, CCW positive). Enter commits; Escape clears selection.'}
          data-testid="tech-rotation-input-field"
        />
        {/* Phase 2 18d-pivot — Set Pivot button. Three states (default /
            picking / locked) drive the label, className, tooltip, and
            click behavior. See state machine above for handler logic. */}
        <button
          type="button"
          className={pivotButtonClassName}
          onClick={handlePivotClick}
          title={pivotButtonTooltip}
          aria-pressed={techPivotPickMode || techPivot !== null}
          data-testid="tech-pivot-button"
        >
          {pivotButtonLabel}
        </button>
      </div>
      <span className="tech-selection-count" data-testid="tech-selection-count">
        {techSelected.length} selected
      </span>
      <span className="placeholder-hint">
        Drag the orange handle to rotate, or type an angle and press Enter.
      </span>
    </div>
  )
}

