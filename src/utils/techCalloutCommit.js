// ============================================================================
// techCalloutCommit.js — Phase 2 sub-step 18k (May 12 2026)
//
// Shared commit helpers for the Technical Drawing callout tool. Two-click
// commit (tip → tail) followed by inline text entry. Pure module — no
// React, no Zustand, no DOM. Side effects routed through action references
// passed in by the caller so the test runner can mock them.
//
// State machine:
//   idle → awaitTip → awaitTail → awaitText → idle
//
// Stage transitions:
//   beginCalloutPlacement → sets draft = {stage: 'awaitTip'}
//   placeCalloutTip(x,y)  → draft.tip = {x,y}; stage = 'awaitTail'
//   placeCalloutTail(x,y) → draft.tail = {x,y}; stage = 'awaitText';
//                           caller spawns InlineTextEditor at tail
//   commitCallout(text)   → creates callout shape with auto-num,
//                           increments layer.nextCalloutNum, draft → null
//   cancelCalloutDraft    → draft → null, stage → idle
//
// Per-layer numbering (D5 + D6): each technicalLayer carries a
// `nextCalloutNum` counter, incremented on commit, never decremented on
// delete. Operator's mental model preserved: "this is #3 even after #2
// is deleted." Pre-18k JSON imports backfill nextCalloutNum to
// max(existing nums) + 1 (or 1 if no callouts).
// ============================================================================

/**
 * Begin a callout placement session. Caller (CanvasStage tech-callout
 * tool) calls this when the tool is activated or after a previous
 * commit. Resets any stale draft.
 *
 * @param {Object} actions - { setTechCalloutDraft }
 */
export function beginCalloutPlacement(actions) {
  if (!actions || typeof actions.setTechCalloutDraft !== 'function') return
  actions.setTechCalloutDraft({ stage: 'awaitTip', tip: null, tail: null })
}

/**
 * Place the callout tip and advance to awaitTail. The tip can be a snap
 * target (endpoint or midpoint on an existing line); caller resolves
 * snap before passing the (x, y) world coords.
 *
 * @param {Object} draft - current techCalloutDraft from store
 * @param {number} x
 * @param {number} y
 * @param {Object} actions - { setTechCalloutDraft }
 * @returns {boolean} true if transition happened
 */
export function placeCalloutTip(draft, x, y, actions) {
  if (!draft || draft.stage !== 'awaitTip') return false
  if (typeof x !== 'number' || typeof y !== 'number') return false
  if (!actions || typeof actions.setTechCalloutDraft !== 'function') return false
  actions.setTechCalloutDraft({
    stage: 'awaitTail',
    tip: { x, y },
    tail: null,
  })
  return true
}

/**
 * Place the callout tail and advance to awaitText. Caller is responsible
 * for converting (x, y) world coords to screen coords for InlineTextEditor
 * positioning and dispatching openInlineEditor(kind='callout', targetId=null,
 * screenX, screenY).
 *
 * Reject zero-distance commit — tip and tail at the same point is
 * degenerate (no leader line).
 *
 * @param {Object} draft - current techCalloutDraft
 * @param {number} x
 * @param {number} y
 * @param {Object} actions - { setTechCalloutDraft }
 * @returns {boolean} true if transition happened
 */
export function placeCalloutTail(draft, x, y, actions) {
  if (!draft || draft.stage !== 'awaitTail' || !draft.tip) return false
  if (typeof x !== 'number' || typeof y !== 'number') return false
  if (!actions || typeof actions.setTechCalloutDraft !== 'function') return false
  // Reject zero-distance leader (tip === tail).
  const dx = x - draft.tip.x
  const dy = y - draft.tip.y
  if (Math.hypot(dx, dy) < 0.5) return false
  actions.setTechCalloutDraft({
    stage: 'awaitText',
    tip: draft.tip,
    tail: { x, y },
  })
  return true
}

/**
 * Commit the callout to the store. Creates a shape with:
 *   - type: 'callout'
 *   - tip, tail: from the draft
 *   - num: auto-assigned from the target layer's nextCalloutNum counter
 *   - textEN: the operator-typed text (may be empty string)
 *   - tipStyle: 'numbered' (D11 — only style shipped in 18k)
 *
 * Caller (InlineTextEditor onCommit handler) passes the final text.
 *
 * @param {Object} draft - current techCalloutDraft (must be at awaitText)
 * @param {string} textEN - operator-typed label (may be empty)
 * @param {Object} actions - { addTechnicalCallout, setTechCalloutDraft }
 * @returns {string | null} created callout id, or null on no-op
 */
export function commitCallout(draft, textEN, actions) {
  if (!draft || draft.stage !== 'awaitText' || !draft.tip || !draft.tail) {
    return null
  }
  if (!actions || typeof actions.addTechnicalCallout !== 'function') return null
  const calloutId = actions.addTechnicalCallout({
    tip: { mode: 'free', x: draft.tip.x, y: draft.tip.y },
    tail: { x: draft.tail.x, y: draft.tail.y },
    textEN: typeof textEN === 'string' ? textEN : '',
    tipStyle: 'numbered',
  })
  if (typeof actions.setTechCalloutDraft === 'function') {
    actions.setTechCalloutDraft(null)
  }
  return calloutId
}

/**
 * Cancel an in-progress callout draft at any stage. Clears the draft
 * without creating a shape. Useful for Escape key + tool-switch cancel.
 *
 * @param {Object} actions - { setTechCalloutDraft }
 */
export function cancelCalloutDraft(actions) {
  if (!actions || typeof actions.setTechCalloutDraft !== 'function') return
  actions.setTechCalloutDraft(null)
}
