import { useRef } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * AnnotationPanel — Step 13 of Kickoff Spec §11/§13. Extended P31 + P35
 * (May 7 2026) with per-sequence annotation defaults + per-annotation
 * color/font-size overrides.
 *
 * Tab body for the third tab in the right drawer ("Annotations"). The tab
 * itself is conditionally rendered in App.jsx (only when
 * mode === 'SEQUENCE' AND activeSeqId is set).
 *
 * Layout:
 *   - Header: "Annotations"
 *   - "Sequence defaults" mini-section (P31 + P35) — color palette + font
 *     stepper that drive the inherited defaults for new + un-overridden
 *     annotations.
 *   - Body: one card per annotation in the active sequence. Each card
 *     shows the type-specific fields (callout/note: EN+ES textareas;
 *     dimline: value input) PLUS a "Style" row with per-annotation
 *     color box + font stepper + ↺ reset buttons.
 *
 * Render-time fallback chain in CanvasStage:
 *   anno.color    ?? seq.defaultAnnoColor    ?? '#f5a623'
 *   anno.fontSize ?? seq.defaultAnnoFontSize ?? 11
 *
 * Override semantics: per-annotation override sticks across sequence-
 * default changes; only ↺ reset clears it (sets the field to null).
 */
const TYPE_ICON = { callout: '➥', dimline: '⤢', note: '✎' }
const TYPE_LABEL = { callout: 'Callout', dimline: 'Dim', note: 'Note' }

// P31 — same 10-swatch palette as PropertiesPanel layer color (operator
// already learned this idiom). Used in the per-sequence defaults; the
// per-annotation override uses a single color box opening the OS color
// picker instead, so cards don't turn into a swatch wall.
const ANNO_COLOR_PALETTE = [
  { name: 'Amber',      value: '#f5a623' },  // default — annotation-friendly
  { name: 'KCC Orange', value: '#f47f1f' },
  { name: 'KCC Navy',   value: '#1f2a44' },
  { name: 'Red',        value: '#dc2626' },
  { name: 'Blue',       value: '#2563eb' },
  { name: 'Green',      value: '#16a34a' },
  { name: 'Yellow',     value: '#eab308' },
  { name: 'Purple',     value: '#9333ea' },
  { name: 'White',      value: '#ffffff' },
  { name: 'Black',      value: '#000000' },
]
const ANNO_FONT_SIZE_MIN = 8
const ANNO_FONT_SIZE_MAX = 32
const ANNO_FONT_SIZE_DEFAULT = 11
const ANNO_COLOR_DEFAULT = '#f5a623'

export default function AnnotationPanel() {
  const activeSeqId = useAppStore((s) => s.activeSeqId)
  const sequences = useAppStore((s) => s.sequences)
  const selectedAnnotation = useAppStore((s) => s.selectedAnnotation)

  const seq = sequences.find((x) => x.id === activeSeqId) || null
  const annotations = seq?.annotations || []

  // Per-creation-index callout numbering. Indexing by creation order
  // (not "current position in the filtered list") so operators don't
  // lose "Callout #3" when an earlier callout is deleted.
  const calloutNumberById = new Map()
  let calloutSeq = 0
  for (const a of annotations) {
    if (a.type === 'callout') {
      calloutSeq += 1
      calloutNumberById.set(a.id, calloutSeq)
    }
  }

  return (
    <>
      <div className="panel-header">Annotations</div>
      {/* P31 + P35 — sequence-level defaults section. Always rendered
          when a sequence is active so operator can set defaults BEFORE
          adding annotations (don't gate on annotations.length > 0). */}
      {seq && <SequenceDefaultsSection seq={seq} />}
      {annotations.length === 0 ? (
        <div className="panel-body panel-empty">
          No annotations yet. Use Callout, Dim, or Note tools to add.
        </div>
      ) : (
        <div className="panel-body anno-panel-body">
          {annotations.map((a) => (
            <AnnotationCard
              key={a.id}
              seqId={activeSeqId}
              seq={seq}
              anno={a}
              calloutNumber={calloutNumberById.get(a.id)}
              isSelected={
                selectedAnnotation?.sequenceId === activeSeqId
                && selectedAnnotation?.annotationId === a.id
              }
            />
          ))}
        </div>
      )}
    </>
  )
}

// P31 + P35 — sequence-level annotation defaults. Color: 10-swatch
// palette (matches PropertiesPanel layer color UX) + native fine-tune
// picker. Font size: number stepper (8–32). Both update via
// setSeqAnnoDefaults; capture+push undo snapshot per discrete click.
function SequenceDefaultsSection({ seq }) {
  const setSeqAnnoDefaults = useAppStore((s) => s.setSeqAnnoDefaults)

  const defaultColor = seq.defaultAnnoColor || ANNO_COLOR_DEFAULT
  const defaultFontSize = typeof seq.defaultAnnoFontSize === 'number'
    ? seq.defaultAnnoFontSize : ANNO_FONT_SIZE_DEFAULT

  // Discrete-click undo: capture pre-change snapshot, push it, then
  // apply the change. Same convention as setLayerColor's undo handling
  // would use if it had one (it doesn't, but the pattern is safe to
  // adopt here for sequence-level changes that operators reasonably
  // expect to be reversible).
  const pickColor = (color) => {
    const snap = useAppStore.getState().captureUndoSnapshot()
    setSeqAnnoDefaults(seq.id, { defaultAnnoColor: color })
    useAppStore.getState().pushCapturedSnapshot(snap)
  }

  // Font stepper uses focus→blur edit-session pattern (matches Step 17
  // partial #1 textarea undo): capture snapshot on focus, push on blur
  // if value changed. Stepper arrows fire onChange repeatedly during a
  // single click — focus→blur batches them as one undo entry.
  const fontSnapRef = useRef(null)
  const fontOriginalRef = useRef(null)
  const onFontFocus = (e) => {
    fontSnapRef.current = useAppStore.getState().captureUndoSnapshot()
    fontOriginalRef.current = e.target.value
  }
  const onFontBlur = (e) => {
    const original = fontOriginalRef.current
    const snap = fontSnapRef.current
    if (typeof original === 'string' && e.target.value !== original && typeof snap === 'string') {
      useAppStore.getState().pushCapturedSnapshot(snap)
    }
    fontSnapRef.current = null
    fontOriginalRef.current = null
  }

  return (
    <div className="anno-seq-defaults">
      <div className="anno-seq-defaults-title">Sequence defaults</div>
      <div className="anno-seq-defaults-row">
        <span className="anno-seq-defaults-label">Color</span>
        <div
          className="anno-color-palette"
          role="radiogroup"
          aria-label="Sequence default annotation color"
        >
          {ANNO_COLOR_PALETTE.map((c) => {
            const active = c.value.toLowerCase() === defaultColor.toLowerCase()
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                className={active ? 'anno-swatch active' : 'anno-swatch'}
                style={{ background: c.value }}
                onClick={() => pickColor(c.value)}
                title={c.name}
                aria-label={c.name}
                aria-checked={active}
                data-testid={`anno-seq-swatch-${c.value}`}
              />
            )
          })}
          <input
            type="color"
            className="anno-swatch-fine-tune"
            value={defaultColor}
            onChange={(e) => pickColor(e.target.value)}
            title="Fine-tune sequence default color"
            aria-label="Fine-tune sequence default annotation color"
            data-testid="anno-seq-swatch-fine-tune"
          />
        </div>
      </div>
      <label className="anno-seq-defaults-row">
        <span className="anno-seq-defaults-label">Size</span>
        <input
          type="number"
          className="anno-font-stepper"
          min={ANNO_FONT_SIZE_MIN}
          max={ANNO_FONT_SIZE_MAX}
          step="1"
          value={defaultFontSize}
          onFocus={onFontFocus}
          onBlur={onFontBlur}
          onChange={(e) => setSeqAnnoDefaults(seq.id, { defaultAnnoFontSize: e.target.value })}
          aria-label="Sequence default annotation font size"
          data-testid="anno-seq-font-size"
        />
        <span className="anno-seq-defaults-unit">px</span>
      </label>
    </div>
  )
}

function AnnotationCard({ seqId, seq, anno, calloutNumber, isSelected }) {
  const updateField = (field, value) => {
    useAppStore.getState().updateAnnotation(seqId, anno.id, { [field]: value })
  }

  // P31 — per-annotation color override. Native color box (no swatch
  // palette per card — see file header). Reads effective color via
  // 3-tier fallback for the swatch's display value, but the override
  // is whatever the operator explicitly picked. ↺ reset clears the
  // override (sets color to null) and the swatch falls back to the
  // sequence default visually on the next render.
  const effectiveColor = anno.color
    || (seq && seq.defaultAnnoColor)
    || ANNO_COLOR_DEFAULT
  const hasColorOverride = typeof anno.color === 'string' && anno.color.length > 0
  const onColorPick = (color) => {
    const snap = useAppStore.getState().captureUndoSnapshot()
    useAppStore.getState().updateAnnotation(seqId, anno.id, { color })
    useAppStore.getState().pushCapturedSnapshot(snap)
  }
  const onColorReset = () => {
    if (!hasColorOverride) return
    const snap = useAppStore.getState().captureUndoSnapshot()
    useAppStore.getState().updateAnnotation(seqId, anno.id, { color: null })
    useAppStore.getState().pushCapturedSnapshot(snap)
  }

  // P35 — per-annotation font size override. Same focus→blur edit-
  // session pattern as the sequence stepper.
  const effectiveFontSize = (typeof anno.fontSize === 'number' && Number.isFinite(anno.fontSize))
    ? anno.fontSize
    : (seq && typeof seq.defaultAnnoFontSize === 'number' ? seq.defaultAnnoFontSize : ANNO_FONT_SIZE_DEFAULT)
  const hasFontOverride = typeof anno.fontSize === 'number' && Number.isFinite(anno.fontSize)
  const onFontReset = () => {
    if (!hasFontOverride) return
    const snap = useAppStore.getState().captureUndoSnapshot()
    useAppStore.getState().updateAnnotation(seqId, anno.id, { fontSize: null })
    useAppStore.getState().pushCapturedSnapshot(snap)
  }

  // Step 17 partial-completion fix (Failure 1, Option B). Each annotation
  // text input gets a focus→blur edit-session: focus captures the full
  // pre-edit dataSnapshot + the original field value into refs. Blur
  // compares; if changed, pushes the captured snapshot onto the undo
  // stack. Result: one undo entry per edit session, regardless of
  // keystroke count. Matches the rest of the app's "one action = one
  // undo" convention.
  //
  // Per-input scoping: the field name is read from each element's
  // data-field attribute (set in the JSX), so a single pair of handlers
  // serves all 3-5 inputs without curried factories — react-hooks/refs
  // disallows ref reads inside curried render-time factories.
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
    if (typeof original === 'string' && e.target.value !== original && typeof snap === 'string') {
      useAppStore.getState().pushCapturedSnapshot(snap)
    }
    delete preEditSnapshotRef.current[field]
    delete originalValueRef.current[field]
  }

  // Click anywhere on the card surface (except the controls) toggles
  // the panel selection. Step 9 mousedown-vs-click pattern carried
  // forward — activation fires on `onMouseDown` so clicking the
  // textarea / input doesn't get swallowed by the input's own
  // focus-stop semantics.
  const onActivate = () => {
    const cur = useAppStore.getState().selectedAnnotation
    const isCurSelected =
      cur?.sequenceId === seqId && cur?.annotationId === anno.id
    useAppStore.getState().setSelectedAnnotation(
      isCurSelected ? null : { sequenceId: seqId, annotationId: anno.id }
    )
  }

  const onDelete = (e) => {
    e.stopPropagation()
    const label = anno.type === 'callout' && calloutNumber != null
      ? `Callout #${calloutNumber}`
      : TYPE_LABEL[anno.type] || 'annotation'
    const ok = window.confirm(`Delete this ${label}?`)
    if (ok) useAppStore.getState().deleteAnnotation(seqId, anno.id)
  }

  const title = anno.type === 'callout' && calloutNumber != null
    ? `Callout #${calloutNumber}`
    : TYPE_LABEL[anno.type] || 'Annotation'

  return (
    <div
      className={isSelected ? 'anno-card active' : 'anno-card'}
      onMouseDown={onActivate}
      onTouchStart={onActivate}
      data-anno-id={anno.id}
      data-anno-type={anno.type}
    >
      <div className="anno-card-header">
        <span className="anno-card-icon" aria-hidden="true">{TYPE_ICON[anno.type]}</span>
        <span className="anno-card-title">{title}</span>
        <button
          type="button"
          className="btn-icon btn-delete"
          onClick={onDelete}
          onMouseDown={(e) => e.stopPropagation()}
          title="Delete annotation"
          aria-label="Delete annotation"
          data-testid={`anno-card-delete-${anno.id}`}
        >
          ✕
        </button>
      </div>
      {(anno.type === 'callout' || anno.type === 'note') && (
        <div className="anno-card-fields">
          <label className="anno-field">
            <span className="anno-field-label">EN</span>
            <textarea
              className="anno-textarea"
              value={anno.textEN || ''}
              onChange={(e) => updateField('textEN', e.target.value)}
              onFocus={onFieldFocus}
              onBlur={onFieldBlur}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder={anno.type === 'callout' ? 'English label for this callout…' : 'English note…'}
              rows={2}
              data-field="textEN"
              data-testid={`anno-card-en-${anno.id}`}
            />
          </label>
          <label className="anno-field">
            <span className="anno-field-label">ES</span>
            <textarea
              className="anno-textarea"
              value={anno.textES || ''}
              onChange={(e) => updateField('textES', e.target.value)}
              onFocus={onFieldFocus}
              onBlur={onFieldBlur}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder={anno.type === 'callout' ? 'Etiqueta en español para este callout…' : 'Nota en español…'}
              rows={2}
              data-field="textES"
              data-testid={`anno-card-es-${anno.id}`}
            />
          </label>
        </div>
      )}
      {anno.type === 'dimline' && (
        <div className="anno-card-fields">
          <label className="anno-field">
            <span className="anno-field-label">Value</span>
            <input
              type="text"
              className="anno-text-input"
              value={anno.value || ''}
              onChange={(e) => updateField('value', e.target.value)}
              onFocus={onFieldFocus}
              onBlur={onFieldBlur}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder={'e.g. 12\'-6", 3.5 m, 4/12 pitch'}
              data-field="value"
              data-testid={`anno-card-value-${anno.id}`}
            />
          </label>
        </div>
      )}
      {/* P31 + P35 — per-annotation style row. Color is a single
          native color box (override only — no swatch palette per
          card; sequence defaults section above is where the palette
          lives). Font is a number stepper. ↺ reset buttons appear
          only when an override is set. */}
      <div className="anno-card-style-row" onMouseDown={(e) => e.stopPropagation()}>
        <label className="anno-style-cell">
          <span className="anno-style-label">Color</span>
          <input
            type="color"
            className={hasColorOverride ? 'anno-color-box override' : 'anno-color-box'}
            value={effectiveColor}
            onChange={(e) => onColorPick(e.target.value)}
            title={hasColorOverride
              ? 'Per-annotation color override (click ↺ to use sequence default)'
              : 'Click to override the sequence default color for this annotation'}
            aria-label="Annotation color"
            data-testid={`anno-card-color-${anno.id}`}
          />
          {hasColorOverride && (
            <button
              type="button"
              className="anno-style-reset"
              onClick={onColorReset}
              title="Reset to sequence default color"
              aria-label="Reset annotation color to sequence default"
              data-testid={`anno-card-color-reset-${anno.id}`}
            >
              ↺
            </button>
          )}
        </label>
        <label className="anno-style-cell">
          <span className="anno-style-label">Size</span>
          <input
            type="number"
            className={hasFontOverride ? 'anno-font-stepper override' : 'anno-font-stepper'}
            min={ANNO_FONT_SIZE_MIN}
            max={ANNO_FONT_SIZE_MAX}
            step="1"
            value={effectiveFontSize}
            onFocus={onFieldFocus}
            onBlur={onFieldBlur}
            onChange={(e) => updateField('fontSize', Number(e.target.value))}
            data-field="fontSize"
            aria-label="Annotation font size"
            data-testid={`anno-card-font-size-${anno.id}`}
          />
          <span className="anno-style-unit">px</span>
          {hasFontOverride && (
            <button
              type="button"
              className="anno-style-reset"
              onClick={onFontReset}
              title="Reset to sequence default font size"
              aria-label="Reset annotation font size to sequence default"
              data-testid={`anno-card-font-reset-${anno.id}`}
            >
              ↺
            </button>
          )}
        </label>
      </div>
    </div>
  )
}
