import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { parseLength } from '../utils/parseLength'

/**
 * TechLengthInput — Phase 2 sub-step 18b (May 10 2026), Kickoff Spec §21.
 *
 * Cursor-anchored input that appears when the Technical Drawing line tool
 * is drafting (anchor placed, awaiting end-point). Operator types a length
 * in any of the accepted forms (4", 4in, 4, 1'6", 1.5', 18", etc.); on
 * each keystroke the parsed inches value is written to store.techDraft.
 * typedInches so the rubber-band line can re-project against typed length
 * live.
 *
 * Subscribes internally to:
 *   - store.cursorX / cursorY  — follow the cursor with a +12/+12 offset
 *   - store.techDraft           — read existing draft on mount, write back
 *                                 typedInches on each keystroke
 *
 * Commit gestures (handled by parent CanvasStage):
 *   - Enter in the input            → onCommit(parsedInches)
 *   - Click on canvas (no Enter)    → freehand commit (CanvasStage path)
 *   - Escape                        → onCancel()
 *   - Tool toggle off / appMode flip → store-side cleanup clears techDraft
 *
 * Positioning: absolute, anchored at the cursor with a +12/+12 offset so
 * the input doesn't overlap the cursor or the rubber-band line. Pattern A
 * precedent: ContextMenu's floating div with raw left/top coords.
 *
 * Invalid input: red border on the input, no toast. Parser returns null
 * and the parent rubber-band falls back to freehand projection. Empty
 * input treated the same as invalid (no number → no typed override).
 */
const CURSOR_OFFSET_X = 12
const CURSOR_OFFSET_Y = 12

export default function TechLengthInput({ onCommit, onCancel }) {
  const cursorX = useAppStore((s) => s.cursorX)
  const cursorY = useAppStore((s) => s.cursorY)
  const setTechDraft = useAppStore((s) => s.setTechDraft)
  // Read once at mount via getState — we WRITE techDraft.typedInches but
  // never re-render from it (the rubber-band reads from the store fresh
  // on each rAF tick via the dynamic-canvas subscription).
  const [raw, setRaw] = useState('')
  const inputRef = useRef(null)

  // Autofocus on mount so the operator can start typing immediately.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const parsed = parseLength(raw)
  const invalid = raw.length > 0 && parsed === null

  const onChange = (e) => {
    const next = e.target.value
    setRaw(next)
    const p = parseLength(next)
    // Write typedInches into the store techDraft. Null when invalid OR
    // empty — both mean "no typed override, use freehand projection."
    // Mutate via setTechDraft so the dynamic-canvas subscription flips
    // dirty + repaints the rubber-band with the new projection.
    const cur = useAppStore.getState().techDraft
    if (cur) setTechDraft({ ...cur, typedInches: p })
  }

  const onKeyDown = (e) => {
    // Stop propagation so document-level keydown listeners in CanvasStage
    // (Delete shape, etc.) don't fire while the operator is typing.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      if (parsed !== null && typeof onCommit === 'function') onCommit(parsed)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (typeof onCancel === 'function') onCancel()
    }
  }

  return (
    <div
      className="tech-length-input"
      style={{ left: cursorX + CURSOR_OFFSET_X, top: cursorY + CURSOR_OFFSET_Y }}
      role="dialog"
      aria-label="Technical Drawing length input"
      data-testid="tech-length-input"
    >
      <label className="tech-length-label" htmlFor="tech-length-input-field">
        Length
      </label>
      <input
        id="tech-length-input-field"
        ref={inputRef}
        type="text"
        className={invalid ? 'tech-length-field invalid' : 'tech-length-field'}
        value={raw}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={`4"  or  1'6"`}
        aria-invalid={invalid}
        aria-label={'Length (inches or feet/inches). Enter to commit. Escape to cancel.'}
        data-testid="tech-length-input-field"
      />
    </div>
  )
}
