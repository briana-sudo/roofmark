import { useRef } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * AnnotationPanel — Step 13 of Kickoff Spec §11/§13.
 *
 * Tab body for the third tab in the right drawer ("Annotations"). The tab
 * itself is conditionally rendered in App.jsx (only when
 * mode === 'SEQUENCE' AND activeSeqId is set), so this component can
 * assume a sequence is active when mounted — but render an empty-state
 * card for the no-annotations case.
 *
 * Each annotation in the active sequence renders one editable card:
 *   callout — numbered display + EN textarea + ES textarea
 *   dimline — editable value text input
 *   note    — EN textarea + ES textarea
 *
 * Cards sort by creation order (annotation insertion order in the
 * sequence's annotations[] array). Callouts get a sequential number
 * (Callout #1, #2, …) computed from creation order — stable across
 * insertions because deleting an earlier callout doesn't renumber
 * later ones (we use creation index, not array index, so the operator
 * doesn't lose track of "Callout #3" mid-job).
 *
 * Click a card to set the panel-driven selection (`selectedAnnotation`
 * in the store); CanvasStage paints a small white highlight ring
 * around the annotation's primary anchor in response. Click again to
 * clear (toggle behavior).
 */
const TYPE_ICON = { callout: '➥', dimline: '⤢', note: '✎' }
const TYPE_LABEL = { callout: 'Callout', dimline: 'Dim', note: 'Note' }

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

  if (annotations.length === 0) {
    return (
      <>
        <div className="panel-header">Annotations</div>
        <div className="panel-body panel-empty">
          No annotations yet. Use Callout, Dim, or Note tools to add.
        </div>
      </>
    )
  }

  return (
    <>
      <div className="panel-header">Annotations</div>
      <div className="panel-body anno-panel-body">
        {annotations.map((a) => (
          <AnnotationCard
            key={a.id}
            seqId={activeSeqId}
            anno={a}
            calloutNumber={calloutNumberById.get(a.id)}
            isSelected={
              selectedAnnotation?.sequenceId === activeSeqId
              && selectedAnnotation?.annotationId === a.id
            }
          />
        ))}
      </div>
    </>
  )
}

function AnnotationCard({ seqId, anno, calloutNumber, isSelected }) {
  const updateField = (field, value) => {
    useAppStore.getState().updateAnnotation(seqId, anno.id, { [field]: value })
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
    </div>
  )
}
