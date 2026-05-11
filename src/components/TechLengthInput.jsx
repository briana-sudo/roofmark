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
  const wrapperRef = useRef(null)

  // Phase 2 18b bug fix (operator-reported May 10 2026 on `1edd117`):
  // belt-and-suspenders autofocus. Pre-fix the input never received
  // focus on the live build, so every keystroke was lost (and `0` / `1`
  // / `+` / `-` got hijacked by CanvasStage's document-level zoom-key
  // shortcuts). Three independent paths now race to win focus:
  //   1. <input autoFocus> — native attribute, applied at HTML parse time.
  //   2. inputRef.current.focus() — fires synchronously on first render.
  //   3. rAF re-focus — if step 1+2 lose focus to a sibling event
  //      (mouseup released to body, etc.), the next animation frame
  //      retries. Cleanup cancels the rAF on unmount.
  useEffect(() => {
    inputRef.current?.focus()
    const raf = requestAnimationFrame(() => {
      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.focus()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // Phase 2 18b bug fix: native capture-phase keydown listener on the
  // wrapper. React's synthetic `e.stopPropagation()` in the input's
  // onKeyDown stops React's synthetic event from bubbling, but the
  // NATIVE event still bubbles up to document-level listeners (the
  // CanvasStage zoom-key shortcuts at lines 2334-2342 hijack `0`/`1`/
  // `+`/`-` even though the operator is typing in this input). Adding
  // a capture-phase listener on the wrapper intercepts the native
  // event BEFORE it can bubble out — stopPropagation here stops
  // bubbling to document entirely. Capture phase (third arg `true`)
  // is important: bubble-phase would fire after document's listener.
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const stop = (e) => { e.stopPropagation() }
    wrapper.addEventListener('keydown', stop, true)
    return () => wrapper.removeEventListener('keydown', stop, true)
  }, [])

  // Re-focus the input on any wrapper-margin click. The wrapper has
  // padding + a label element; clicking the dead space around the
  // input element would otherwise steal focus from the input. This
  // belt-and-suspenders handler snaps focus back so the operator
  // never lands in a "looks like typing should work but doesn't" state.
  const handleWrapperMouseDown = () => {
    inputRef.current?.focus()
  }

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
      ref={wrapperRef}
      className="tech-length-input"
      style={{ left: cursorX + CURSOR_OFFSET_X, top: cursorY + CURSOR_OFFSET_Y }}
      role="dialog"
      aria-label="Technical Drawing length input"
      data-testid="tech-length-input"
      onMouseDown={handleWrapperMouseDown}
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
        autoFocus
        aria-invalid={invalid}
        aria-label={'Length (inches or feet/inches). Enter to commit. Escape to cancel.'}
        data-testid="tech-length-input-field"
      />
    </div>
  )
}
