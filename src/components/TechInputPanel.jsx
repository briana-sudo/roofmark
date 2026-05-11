import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { parseLength } from '../utils/parseLength'
import { parseAngle } from '../utils/parseAngle'
import { commitTechLine } from '../utils/techLineCommit'

/**
 * TechInputPanel — Phase 2 sub-step 18c DOCKED PIVOT (May 11 2026).
 *
 * Three failed fix attempts on a cursor-anchored floating panel
 * (18b autofocus belt-and-suspenders, 18c focusin restorer, 18c-fix
 * selective wrapper keydown listener) all surfaced the same class of
 * bug: a child-of-canvas input element fights the canvas event
 * hierarchy for focus and keystroke delivery. Pivoted to a docked
 * panel mounted as a sibling of DrawingTools in App.jsx's
 * `.canvas-area`, OUTSIDE the canvas event hierarchy.
 *
 * Architecture changes vs. pre-pivot:
 *   - Panel visibility: mounts when `appMode === 'TECHNICAL' && tool
 *     === 'tech-line'`, regardless of techDraft state. Operator can
 *     pre-fill length + angle BEFORE clicking the canvas to place an
 *     anchor.
 *   - No cursor subscription. No absolute positioning.
 *   - No focusin restorer (focus competition with canvas eliminated).
 *   - No native capture-phase keydown listener (panel is outside the
 *     canvas event subtree; document keydown shortcuts can't hijack
 *     keystrokes that reach the input).
 *   - No wrapper-mousedown re-focus (operator clicks the input
 *     directly; no margin-click problem).
 *   - The autofocus useEffect remains but simpler: single focus()
 *     call when the panel becomes visible (deps: appMode + tool).
 *
 * Pre-fill flow:
 *   1. Operator switches to Technical Drawing → picks Line tool.
 *   2. Panel mounts. Operator can type "4"" in Length, "45" in Angle.
 *   3. onLengthChange / onAngleChange write the parsed values to
 *      store.techDraft (creating it if null — anchor remains null).
 *   4. Operator clicks the canvas → CanvasStage's onMouseDown sees
 *      techDraft exists with typed values, spreads `a` into it.
 *   5. Rubber-band immediately uses pre-filled values.
 *
 * Commit-clears-inputs:
 *   When a shape commits successfully, the total tech-shape count
 *   increments AND techDraft transitions to null. The useEffect below
 *   watches the shape count; on increment, local rawLength/rawAngle
 *   reset to empty so the next anchor click starts fresh. Escape also
 *   nulls techDraft but does NOT increment the shape count, so
 *   Escape's "Inputs retain typed values" UX from §21 holds.
 *
 * Smart parser (parseAngle): `/` → pitch, `°`/`deg` → degrees,
 * otherwise → defaultUnit (from the toggle).
 *
 * Debug hook: set `window.__rmDebugFocus = true` in DevTools to log
 * keystroke + focus events from the panel. Off by default.
 */
export default function TechInputPanel() {
  const appMode = useAppStore((s) => s.appMode)
  const tool = useAppStore((s) => s.tool)
  const techDraft = useAppStore((s) => s.techDraft)
  const setTechDraft = useAppStore((s) => s.setTechDraft)
  // Total tech-shape count across all technical layers — the trigger
  // signal for clearing inputs after a successful commit (commit
  // increments count; Escape doesn't).
  const totalShapes = useAppStore((s) =>
    (s.technicalLayers || []).reduce((n, tl) => n + (tl.shapes?.length || 0), 0)
  )

  const [rawLength, setRawLength] = useState('')
  const [rawAngle, setRawAngle] = useState('')
  const [unit, setUnit] = useState('degrees') // 'degrees' | 'pitch'
  const lengthInputRef = useRef(null)
  const angleInputRef = useRef(null)
  const prevShapesRef = useRef(totalShapes)

  const visible = appMode === 'TECHNICAL' && tool === 'tech-line'
  const anchorPlaced = !!(techDraft && techDraft.a)

  const parsedInches = parseLength(rawLength)
  const parsedAngle = parseAngle(rawAngle, unit)
  const lengthInvalid = rawLength.length > 0 && parsedInches === null
  const angleInvalid = rawAngle.length > 0 && parsedAngle === null

  // Autofocus when the panel becomes visible. The docked panel is
  // OUTSIDE the canvas event hierarchy, so the rAF retry + focusin
  // restorer from the floating-panel era are no longer necessary.
  // Single focus call is sufficient.
  useEffect(() => {
    if (visible) {
      lengthInputRef.current?.focus()
    }
  }, [visible])

  // Clear local typed values after a successful commit. A commit
  // increments totalShapes (addTechnicalShape pushes a shape into
  // technicalLayers); Escape clears techDraft without committing
  // (totalShapes unchanged). The deps array catches the increment
  // and clears; Escape doesn't trigger this effect.
  useEffect(() => {
    if (totalShapes > prevShapesRef.current) {
      setRawLength('')
      setRawAngle('')
    }
    prevShapesRef.current = totalShapes
  }, [totalShapes])

  const debugLog = (label, extra) => {
    if (typeof window !== 'undefined' && window.__rmDebugFocus === true) {
      console.log(`[TechInputPanel ${label}]`, extra || '')
    }
  }

  // Write typed values into store.techDraft on every keystroke. If
  // techDraft is null (operator hasn't clicked the canvas yet), create
  // it with a null anchor — the value carries forward to when the
  // operator places the anchor (CanvasStage's onMouseDown spreads the
  // current techDraft when setting `a`).
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
    debugLog('length-change', next)
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
    debugLog('angle-change', next)
  }

  const handleEnter = () => {
    // Enter shortcut: commit only when anchor placed AND both values
    // typed cleanly. Otherwise no-op — operator clicks canvas for
    // partial-lock and no-lock cases.
    const s = useAppStore.getState()
    const d = s.techDraft
    if (!d || !d.a) return
    if (parsedInches === null || parsedAngle === null) return
    const v = s.viewports?.TECHNICAL || { panX: 0, panY: 0, zoom: 1 }
    // Cursor world coords used only as freehand fallback. With both
    // typed values present here, the helper's typed-vs-freehand decision
    // picks 'typed' for both and ignores the cursor.
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

  const handleEscape = () => {
    // Cancel draft. Per §21 amendment: inputs retain their typed values
    // (the operator may want to apply the same length/angle to another
    // anchor placement). The setTechDraft(null) here transitions techDraft
    // away from any anchor; totalShapes does NOT increment, so the
    // commit-clears-inputs useEffect doesn't fire.
    setTechDraft(null)
  }

  const onKeyDown = (e) => {
    debugLog(`keydown ${e.key}`)
    if (e.key === 'Enter') {
      e.preventDefault()
      handleEnter()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleEscape()
    }
  }

  const onToggleUnit = () => {
    const nextUnit = unit === 'degrees' ? 'pitch' : 'degrees'
    setUnit(nextUnit)
    // Re-parse existing angle input against the new unit so techDraft's
    // typed value stays consistent with the toggle.
    const cur = useAppStore.getState().techDraft
    if (cur && rawAngle.length > 0) {
      const p = parseAngle(rawAngle, nextUnit)
      setTechDraft({ ...cur, typedAngleDegrees: p })
    }
    angleInputRef.current?.focus()
  }

  if (!visible) return null

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
          onKeyDown={onKeyDown}
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
          onKeyDown={onKeyDown}
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
