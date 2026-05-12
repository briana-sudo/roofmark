// ============================================================================
// specTableValidation.js — Phase 2 sub-step 18g (May 12 2026)
//
// Pure helpers for the Spec Table panel + JSON export validity gating.
// Authority for field names + required-field set + length limits is the
// locked Python template `kcc-shop-drawing.py v1.0` (Title Block Design
// Session, April 28 2026). RoofMark §21.18g spec v1.1 mirrors the template
// 1:1 in field order, names, and types so operator's mental model matches
// PDF output.
//
// Pure: no React, no DOM, no store. Test-shim-compatible.
// ============================================================================

/**
 * Field order matches the locked Python template's 4-col × 2-row PDF
 * title-block grid. Used for render iteration in SpecTablePanel.
 */
export const SPEC_TABLE_FIELDS = [
  'partName', 'material', 'color', 'stockLength',
  'jobId', 'jobAddress', 'drawnBy', 'date', 'drawingNo',
]

/**
 * 3 required fields per spec §"3 required fields" + locked template
 * framing prompt. All 3 must be non-empty after trim for export to fire.
 */
export const SPEC_TABLE_REQUIRED_FIELDS = ['partName', 'material', 'drawingNo']

/**
 * Per-field maxLength values from spec v1.1 §"9 Spec Table fields" table.
 * Used as `<input maxLength={...}>` attributes — native browser enforces.
 */
export const SPEC_FIELD_MAX_LENGTHS = {
  partName: 50,
  material: 50,
  color: 50,
  stockLength: 20,
  jobId: 30,
  jobAddress: 100,
  drawnBy: 50,
  date: 30,
  drawingNo: 30,
}

/**
 * Display labels for the panel. Title-case form of the field name with
 * spec-friendly spacing.
 */
export const SPEC_FIELD_LABELS = {
  partName: 'Part Name',
  material: 'Material',
  color: 'Color',
  stockLength: 'Stock Length',
  jobId: 'Job ID',
  jobAddress: 'Job Address',
  drawnBy: 'Drawn By',
  date: 'Date',
  drawingNo: 'Drawing No',
}

/**
 * Factory for an empty spec table with all 9 fields as empty strings.
 * Used by store initial state + as the normalizer base for partial
 * loaded spec tables.
 */
export function emptySpecTable() {
  return {
    partName: '',
    material: '',
    color: '',
    stockLength: '',
    jobId: '',
    jobAddress: '',
    drawnBy: '',
    date: '',
    drawingNo: '',
  }
}

/**
 * Normalize a loaded specTable to ensure all 9 fields exist as strings.
 * Pre-18g v3 files had `specTable: {}` (no fields); 18g extends that to
 * the full 9-field shape on import. Non-string field values are coerced
 * to empty string defensively (tolerant of hand-edited JSON files).
 *
 * Unknown keys in the input are dropped — schema is closed at 9 fields.
 *
 * @param {Object | null | undefined} input
 * @returns {Object} normalized spec table with all 9 string fields
 */
export function normalizeSpecTable(input) {
  const out = emptySpecTable()
  if (!input || typeof input !== 'object') return out
  for (const field of SPEC_TABLE_FIELDS) {
    if (typeof input[field] === 'string') {
      out[field] = input[field]
    }
  }
  return out
}

/**
 * Pure helper: true iff all 3 required fields are non-empty after trim.
 *
 * Per spec §"Export button gating" + locked template framing prompt:
 * `partName`, `material`, `drawingNo` must each be non-blank. The JSON
 * export action (18h scope) consumes this signal to gate the export
 * button.
 *
 * Whitespace-only values count as empty (operator can't type only
 * spaces and have it pass).
 *
 * @param {Object | null | undefined} specTable
 * @returns {boolean}
 */
export function computeIsSpecTableValid(specTable) {
  if (!specTable || typeof specTable !== 'object') return false
  return SPEC_TABLE_REQUIRED_FIELDS.every(
    (field) => typeof specTable[field] === 'string' && specTable[field].trim() !== ''
  )
}

/**
 * Per-field validity flag for inline panel state.
 *
 * Returns true only for required fields with empty/whitespace value —
 * non-required fields never report invalid (they're optional). Used by
 * SpecTablePanel to apply the `.spec-input--invalid` red-border class
 * and the "Required" placeholder.
 *
 * @param {string} fieldName
 * @param {string} value
 * @returns {boolean}
 */
export function isFieldRequiredAndEmpty(fieldName, value) {
  if (!SPEC_TABLE_REQUIRED_FIELDS.includes(fieldName)) return false
  return typeof value !== 'string' || value.trim() === ''
}

/**
 * Today's date in long format ("May 12, 2026") per spec v1.1
 * §"Date auto-population". Uses `Intl.DateTimeFormat('en-US', ...)`
 * — output matches `MMMM D, YYYY` (month name, day-no-leading-zero,
 * 4-digit year).
 *
 * Called once at app mount by hydrateSpecTableDefaults when
 * specTable.date is empty. Editable thereafter.
 *
 * @returns {string}
 */
export function todayLongFormat() {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date())
}

/**
 * localStorage key for cross-project drawnBy persistence per spec v1.1
 * §"Cross-project persistence". Same value across Field Markup +
 * Technical Drawing projects — drawnBy is operator identity, not
 * project-specific.
 */
export const DRAWN_BY_STORAGE_KEY = 'roofmark_drawnBy_v1'
