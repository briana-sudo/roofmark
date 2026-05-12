import { useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  SPEC_TABLE_FIELDS,
  SPEC_TABLE_REQUIRED_FIELDS,
  SPEC_FIELD_MAX_LENGTHS,
  SPEC_FIELD_LABELS,
  isFieldRequiredAndEmpty,
} from '../utils/specTableValidation'

/**
 * SpecTablePanel — Phase 2 sub-step 18g (May 12 2026).
 *
 * Right-drawer body for Technical Drawing mode. 9 input fields per the
 * locked Python template (`kcc-shop-drawing.py v1.0` + RoofMark §21.18g
 * spec v1.1). Field order matches the template's PDF title-block grid
 * so operator's mental model maps 1:1 to output.
 *
 * Required fields (partName, material, drawingNo) flag empty state with
 * a red border (.spec-input--invalid) + "Required" placeholder. Optional
 * fields render plain. JSON export (18h scope) gates on
 * `useAppStore.getState().isSpecTableValid()`.
 *
 * Undo: focus→blur edit-session pattern matching AnnotationPanel. One
 * undo entry per field-focus session regardless of keystroke count.
 * Shared handlers operate on `e.target.dataset.field` so the same
 * onFocus/onBlur serve all 9 inputs without curried factories.
 *
 * Persistence:
 *   - All 9 fields persist via PERSIST_KEYS + dataSnapshot (existing
 *     project-level autosave + Save/Load JSON).
 *   - `drawnBy` ALSO mirrors to localStorage `roofmark_drawnBy_v1` via
 *     setSpecTable's coupling — survives across project loads + mode
 *     switches per spec v1.1 §"Cross-project persistence".
 *
 * Visibility: panel is mounted only when App.jsx renders the TECHNICAL-
 * mode `<aside>` (mode-isolation gate at the parent level). The panel
 * itself does NOT check appMode — it trusts the parent.
 */
export default function SpecTablePanel() {
  const specTable = useAppStore((s) => s.specTable)
  const setSpecTable = useAppStore((s) => s.setSpecTable)

  // Focus→blur edit-session refs. Both keyed by field name so multiple
  // in-flight focus sessions can coexist (rare but safe — tab between
  // inputs without intermediate state). Mirrors AnnotationPanel.jsx
  // ~line 367 — same shape, same semantics, same data-field protocol.
  const preEditSnapshotRef = useRef({})
  const originalValueRef = useRef({})

  const onFieldFocus = (e) => {
    const field = e.target.dataset.field
    if (!field) return
    preEditSnapshotRef.current[field] = useAppStore.getState().captureUndoSnapshot()
    originalValueRef.current[field] = e.target.value
  }

  const onFieldBlur = (e) => {
    const field = e.target.dataset.field
    if (!field) return
    const original = originalValueRef.current[field]
    const snap = preEditSnapshotRef.current[field]
    if (
      typeof original === 'string'
      && e.target.value !== original
      && typeof snap === 'string'
    ) {
      useAppStore.getState().pushCapturedSnapshot(snap)
    }
    delete preEditSnapshotRef.current[field]
    delete originalValueRef.current[field]
  }

  const onFieldChange = (e) => {
    const field = e.target.dataset.field
    if (!field) return
    // setSpecTable is partial-merge. drawnBy persistence to localStorage
    // is coupled inside the store action so any setSpecTable caller
    // gets correct cross-project persistence for free.
    setSpecTable({ [field]: e.target.value })
  }

  return (
    <div className="spec-table-panel" data-testid="spec-table-panel">
      <div className="spec-table-scroll">
        {SPEC_TABLE_FIELDS.map((field) => {
          const value = specTable[field] || ''
          const isRequired = SPEC_TABLE_REQUIRED_FIELDS.includes(field)
          const isInvalid = isFieldRequiredAndEmpty(field, value)
          const label = SPEC_FIELD_LABELS[field]
          const maxLength = SPEC_FIELD_MAX_LENGTHS[field]
          return (
            <div className="spec-row" key={field}>
              <label className="spec-label" htmlFor={`spec-input-${field}`}>
                {label}
                {isRequired && <span className="spec-required-asterisk"> *</span>}
              </label>
              <input
                id={`spec-input-${field}`}
                type="text"
                className={`spec-input${isInvalid ? ' spec-input--invalid' : ''}`}
                data-field={field}
                data-testid={`spec-input-${field}`}
                value={value}
                placeholder={isInvalid ? 'Required' : ''}
                maxLength={maxLength}
                onChange={onFieldChange}
                onFocus={onFieldFocus}
                onBlur={onFieldBlur}
              />
            </div>
          )
        })}
        <div className="spec-required-hint">
          Required fields: Part Name, Material, Drawing No
        </div>
      </div>
    </div>
  )
}
