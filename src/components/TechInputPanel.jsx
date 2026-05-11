import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { parseLength } from '../utils/parseLength'
import { parseAngle } from '../utils/parseAngle'
import { shouldStopHijackedKey } from '../utils/techPanelKeyHandling'

/**
 * TechInputPanel — Phase 2 sub-step 18c (May 11 2026).
 *
 * Cursor-anchored input panel that appears when the Technical Drawing
 * line tool is drafting (anchor placed, awaiting end-point). 18b shipped
 * the length-only TechLengthInput; 18c extends it with an angle field
 * and a Degrees / Pitch unit toggle. Renamed to TechInputPanel to
 * reflect the multi-field scope.
 *
 * Layout (vertical stack, ~160px wide × ~80px tall):
 *   Length: [______________]       ← row 1
 *   Angle:  [______________]       ← row 2
 *           [Degrees | Pitch]      ← row 3 (unit toggle)
 *
 * Subscribes internally to:
 *   - store.cursorX / cursorY  — follow the cursor with +12/+12 offset
 *   - store.setTechDraft        — write typed values back per keystroke
 *
 * Commit gestures (parent CanvasStage owns the geometry math):
 *   - Click on canvas         → commit. Uses whichever typed values are
 *                               present; freehand for the rest.
 *   - Enter from either input → shortcut for both-locked. Only fires
 *                               onCommit when BOTH length AND angle parse
 *                               cleanly. Otherwise no-op (operator clicks
 *                               to commit a partial-lock scenario).
 *   - Escape                  → onCancel → setTechDraft(null) → unmount
 *
 * Escape-after-typing fix (18b regression resurfaced in 18c investigation):
 * a `focusin` listener on document re-focuses the length input if focus
 * escapes the panel for any reason while it's mounted. Belt-and-suspenders
 * autofocus + native capture-phase keydown stopper from 18b carried forward.
 *
 * Smart parser (parseAngle):
 *   - `/` in input → pitch (always)
 *   - `°` or `deg` in input → degrees (always)
 *   - otherwise → defaultUnit from the toggle state
 *
 * Invalid input: red border on the offending input, no toast. Parser
 * returns null; commit treats null as "use freehand for this axis".
 *
 * Debug hook: set `window.__rmDebugFocus = true` in DevTools to log
 * document.activeElement.tagName on every keystroke. Off by default.
 */
const CURSOR_OFFSET_X = 12
const CURSOR_OFFSET_Y = 12

export default function TechInputPanel({ onCommit, onCancel }) {
  const cursorX = useAppStore((s) => s.cursorX)
  const cursorY = useAppStore((s) => s.cursorY)
  const setTechDraft = useAppStore((s) => s.setTechDraft)
  const [rawLength, setRawLength] = useState('')
  const [rawAngle, setRawAngle] = useState('')
  const [unit, setUnit] = useState('degrees') // 'degrees' | 'pitch'
  const lengthInputRef = useRef(null)
  const angleInputRef = useRef(null)
  const wrapperRef = useRef(null)

  const parsedInches = parseLength(rawLength)
  const parsedAngle = parseAngle(rawAngle, unit)
  const lengthInvalid = rawLength.length > 0 && parsedInches === null
  const angleInvalid = rawAngle.length > 0 && parsedAngle === null

  // Belt-and-suspenders autofocus on the LENGTH input — 18b's three
  // independent paths to win focus, carried forward verbatim:
  //   1. <input autoFocus> on the length input element
  //   2. lengthInputRef.current.focus() synchronously on first render
  //   3. rAF re-focus if step 1+2 lose focus to a sibling event
  useEffect(() => {
    lengthInputRef.current?.focus()
    const raf = requestAnimationFrame(() => {
      if (lengthInputRef.current && document.activeElement !== lengthInputRef.current) {
        lengthInputRef.current.focus()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // 18b native capture-phase keydown stopper on the wrapper — prevents
  // CanvasStage's document-level zoom-key shortcuts (`+`/`-`/`0`/`1`)
  // from hijacking keystrokes meant for the inputs.
  //
  // 18c Escape regression fix (operator-reported on `af1f3c8`):
  //   The original 18b implementation called stopPropagation()
  //   UNCONDITIONALLY for every key. That silently consumed Escape and
  //   Enter at the wrapper before they could reach the input's React
  //   onKeyDown handler (cancel + commit paths). Typing characters
  //   appeared to work because text input uses a separate `input` event
  //   path, not blocked by the keydown listener.
  //
  // Fix: stop propagation ONLY for keys the document handler would
  // hijack. Everything else (Enter, Escape, printable chars, Tab,
  // arrows, modifiers) flows through to the input's React handler.
  //
  // The set below mirrors CanvasStage.onKeyDown's zoom/space branches
  // (CanvasStage.jsx ~lines 2348-2365). Keep in sync if those shortcuts
  // change.
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const stop = (e) => {
      const stopIt = shouldStopHijackedKey(e)
      if (typeof window !== 'undefined' && window.__rmDebugFocus === true) {
        const t = `${new Date().toISOString().slice(11, 23)}`
        const tag = `${e.target?.tagName}#${e.target?.id || '(no-id)'}`
        const active = `${document.activeElement?.tagName}#${document.activeElement?.id || '(no-id)'}`
        console.log(`[${t}] [wrapper capture] key=${e.key} code=${e.code} target=${tag} active=${active} willStop=${stopIt}`)
      }
      if (stopIt) e.stopPropagation()
    }
    wrapper.addEventListener('keydown', stop, true)
    return () => wrapper.removeEventListener('keydown', stop, true)
  }, [])

  // 18c Escape-after-typing fix — document-level focusin listener that
  // restores focus to the length input whenever it escapes the panel.
  // (See header comment for full backstory.)
  useEffect(() => {
    const handleFocusIn = (e) => {
      const wrapper = wrapperRef.current
      if (!wrapper) return
      if (typeof window !== 'undefined' && window.__rmDebugFocus === true) {
        const t = `${new Date().toISOString().slice(11, 23)}`
        const inside = wrapper.contains(e.target)
        console.log(`[${t}] [focusin] target=${e.target?.tagName}#${e.target?.id || '(no-id)'} wrapperContains=${inside}`)
      }
      if (!wrapper.contains(e.target) && lengthInputRef.current) {
        lengthInputRef.current.focus()
      }
    }
    document.addEventListener('focusin', handleFocusIn)
    return () => document.removeEventListener('focusin', handleFocusIn)
  }, [])

  // DEBUG branch: additional focus-trace listeners gated behind the
  // window.__rmDebugFocus flag. focusout, plus direct focus/blur on
  // each input element. Production-default off; zero overhead until
  // operator flips the flag in DevTools.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const ts = () => `${new Date().toISOString().slice(11, 23)}`
    const onFocusOut = (e) => {
      if (window.__rmDebugFocus !== true) return
      console.log(`[${ts()}] [focusout] target=${e.target?.tagName}#${e.target?.id || '(no-id)'} relatedTarget=${e.relatedTarget?.tagName || 'null'}#${e.relatedTarget?.id || ''}`)
    }
    const onLenFocus = () => {
      if (window.__rmDebugFocus !== true) return
      console.log(`[${ts()}] [length-input focus]`)
    }
    const onLenBlur = (e) => {
      if (window.__rmDebugFocus !== true) return
      console.log(`[${ts()}] [length-input blur] relatedTarget=${e.relatedTarget?.tagName || 'null'}#${e.relatedTarget?.id || ''}`)
    }
    const onAngFocus = () => {
      if (window.__rmDebugFocus !== true) return
      console.log(`[${ts()}] [angle-input focus]`)
    }
    const onAngBlur = (e) => {
      if (window.__rmDebugFocus !== true) return
      console.log(`[${ts()}] [angle-input blur] relatedTarget=${e.relatedTarget?.tagName || 'null'}#${e.relatedTarget?.id || ''}`)
    }
    document.addEventListener('focusout', onFocusOut, true)
    const lenEl = lengthInputRef.current
    const angEl = angleInputRef.current
    if (lenEl) {
      lenEl.addEventListener('focus', onLenFocus)
      lenEl.addEventListener('blur', onLenBlur)
    }
    if (angEl) {
      angEl.addEventListener('focus', onAngFocus)
      angEl.addEventListener('blur', onAngBlur)
    }
    return () => {
      document.removeEventListener('focusout', onFocusOut, true)
      if (lenEl) {
        lenEl.removeEventListener('focus', onLenFocus)
        lenEl.removeEventListener('blur', onLenBlur)
      }
      if (angEl) {
        angEl.removeEventListener('focus', onAngFocus)
        angEl.removeEventListener('blur', onAngBlur)
      }
    }
  }, [])

  // Re-focus the length input on any wrapper-margin click (clicking the
  // padding / label / toggle button shouldn't strand focus on a non-
  // typable child). Carried forward from 18b.
  const handleWrapperMouseDown = (e) => {
    // Don't steal focus if the operator clicked an interactive element
    // inside the panel (the angle input, the unit toggle). Only re-focus
    // when the click landed on the wrapper itself or its dead space.
    if (e.target === wrapperRef.current || e.target.tagName === 'LABEL') {
      lengthInputRef.current?.focus()
    }
  }

  const debugLog = (label) => {
    if (typeof window !== 'undefined' && window.__rmDebugFocus === true) {
      console.log(`[TechInputPanel ${label}] activeElement=`, document.activeElement?.tagName, document.activeElement?.id)
    }
  }

  const onLengthChange = (e) => {
    const next = e.target.value
    setRawLength(next)
    const p = parseLength(next)
    const cur = useAppStore.getState().techDraft
    if (cur) setTechDraft({ ...cur, typedInches: p })
    debugLog('length-change')
  }

  const onAngleChange = (e) => {
    const next = e.target.value
    setRawAngle(next)
    const p = parseAngle(next, unit)
    const cur = useAppStore.getState().techDraft
    if (cur) setTechDraft({ ...cur, typedAngleDegrees: p })
    debugLog('angle-change')
  }

  // Enter from EITHER input field — shortcut for both-locked. Only fires
  // when both length AND angle parsed cleanly. Otherwise the operator
  // commits via canvas click (partial-lock cases).
  const handleEnter = (e) => {
    if (parsedInches !== null && parsedAngle !== null) {
      e.preventDefault()
      if (typeof onCommit === 'function') {
        onCommit({ inches: parsedInches, angleDegrees: parsedAngle })
      }
    }
    // Otherwise: Enter does nothing. Operator clicks to commit.
  }

  const handleEscape = (e) => {
    e.preventDefault()
    if (typeof onCancel === 'function') onCancel()
  }

  const onKeyDown = (e) => {
    if (typeof window !== 'undefined' && window.__rmDebugFocus === true) {
      const t = `${new Date().toISOString().slice(11, 23)}`
      const tag = `${e.target?.tagName}#${e.target?.id || '(no-id)'}`
      console.log(`[${t}] [react onKeyDown] key=${e.key} target=${tag}`)
    }
    e.stopPropagation()
    if (e.key === 'Enter') {
      handleEnter(e)
    } else if (e.key === 'Escape') {
      handleEscape(e)
    }
    debugLog(`keydown ${e.key}`)
  }

  const onToggleUnit = () => {
    setUnit((u) => (u === 'degrees' ? 'pitch' : 'degrees'))
    // After toggle, re-parse the existing angle input against the new
    // default unit so the rubber-band reflects the operator's intent.
    // Done implicitly via the next render — `parsedAngle` reads from
    // the new `unit` value. We also need to push the new parsed value
    // to techDraft right now so the rubber-band doesn't lag a frame.
    const cur = useAppStore.getState().techDraft
    if (cur) {
      // Compute against the NEW unit by inverting from old.
      const nextUnit = unit === 'degrees' ? 'pitch' : 'degrees'
      const p = parseAngle(rawAngle, nextUnit)
      setTechDraft({ ...cur, typedAngleDegrees: p })
    }
    // Keep focus where it was so the operator can continue typing.
    // If focus was on the toggle button itself (from a click), move
    // back to the angle input.
    angleInputRef.current?.focus()
  }

  const anglePlaceholder = unit === 'degrees' ? `45 or 45°` : `4/12`

  return (
    <div
      ref={wrapperRef}
      className="tech-input-panel"
      style={{ left: cursorX + CURSOR_OFFSET_X, top: cursorY + CURSOR_OFFSET_Y }}
      role="dialog"
      aria-label="Technical Drawing line input"
      data-testid="tech-input-panel"
      onMouseDown={handleWrapperMouseDown}
    >
      <div className="tip-row">
        <label className="tip-label" htmlFor="tech-length-input-field">Length</label>
        <input
          id="tech-length-input-field"
          ref={lengthInputRef}
          type="text"
          className={lengthInvalid ? 'tip-field invalid' : 'tip-field'}
          value={rawLength}
          onChange={onLengthChange}
          onKeyDown={onKeyDown}
          placeholder={`4"  or  1'6"`}
          autoFocus
          aria-invalid={lengthInvalid}
          aria-label={'Length (inches or feet/inches). Enter to commit both. Click canvas to commit.'}
          data-testid="tech-length-input-field"
        />
      </div>
      <div className="tip-row">
        <label className="tip-label" htmlFor="tech-angle-input-field">Angle</label>
        <input
          id="tech-angle-input-field"
          ref={angleInputRef}
          type="text"
          className={angleInvalid ? 'tip-field invalid' : 'tip-field'}
          value={rawAngle}
          onChange={onAngleChange}
          onKeyDown={onKeyDown}
          placeholder={anglePlaceholder}
          aria-invalid={angleInvalid}
          aria-label={'Angle (degrees or rise/run pitch). Smart parser: slash → pitch, ° or deg → degrees, otherwise uses the toggle.'}
          data-testid="tech-angle-input-field"
        />
      </div>
      <div className="tip-toggle-row">
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
      </div>
    </div>
  )
}
