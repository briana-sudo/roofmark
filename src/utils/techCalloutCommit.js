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

/**
 * Phase 2 18k bug-fix (May 12 2026) — Canvas 2D render for a callout
 * shape. Mirrors shopDrawingSvgRender.renderCallout's structure:
 *   - leader line from tip to tail (navy)
 *   - text box at tail (white fill + orange border, navy text)
 *   - orange tip circle (with white number when tipStyle === 'numbered')
 *
 * Caller (CanvasStage.drawStatic) is expected to have applied the
 * TECHNICAL viewport transform (translate + scale) BEFORE calling, so
 * this function operates entirely in WORLD coordinates.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} ca - callout shape
 *   { id, type: 'callout',
 *     tip: { mode, x, y },  // 'free' resolved coords used directly
 *     tail: { x, y },
 *     num: int | null,
 *     textEN: string,
 *     tipStyle: 'numbered' | 'dot' | 'none' }
 * @param {Array} [technicalLayers] - reserved for future attached-tip
 *   lookup; unused in 18k initial.
 * @param {boolean} [isSelected=false]
 */
export function renderCalloutCanvas(ctx, ca, technicalLayers, isSelected) {
  if (!ca || ca.type !== 'callout') return
  const tip = ca.tip || {}
  const tail = ca.tail || {}
  if (typeof tip.x !== 'number' || typeof tip.y !== 'number') return
  if (typeof tail.x !== 'number' || typeof tail.y !== 'number') return

  const KCC_NAVY = '#1A2F4A'
  const KCC_ORANGE = '#e8531a'
  const SELECT_ORANGE = '#ff7a3a'
  const num = Number.isFinite(+ca.num) ? +ca.num : 0
  const text = (typeof ca.textEN === 'string' && ca.textEN.trim()) ? ca.textEN.trim() : ''
  const tipStyle = ca.tipStyle || 'numbered'

  ctx.save()

  // Leader line — navy stroke (or selection orange when selected).
  const leaderColor = isSelected ? SELECT_ORANGE : KCC_NAVY
  ctx.strokeStyle = leaderColor
  ctx.lineWidth = 0.8
  ctx.beginPath()
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(tail.x, tail.y)
  ctx.stroke()

  // Text box at tail (only when textEN is non-empty).
  if (text) {
    ctx.font = '8px Helvetica, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(text).width
    const padX = 5, padY = 3
    const boxW = tw + 2 * padX
    const boxH = 8 + 2 * padY
    const bx = tail.x - boxW / 2
    const by = tail.y - boxH / 2
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = KCC_ORANGE
    ctx.lineWidth = 0.6
    ctx.beginPath()
    ctx.rect(bx, by, boxW, boxH)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = KCC_NAVY
    ctx.fillText(text, tail.x, tail.y)
  }

  // Tip dot — orange filled circle, white stroke.
  if (tipStyle !== 'none') {
    const TIP_R = 8
    ctx.beginPath()
    ctx.arc(tip.x, tip.y, TIP_R, 0, Math.PI * 2)
    ctx.fillStyle = KCC_ORANGE
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.2
    ctx.stroke()
    // White number inside the tip (only when tipStyle === 'numbered'
    // AND num > 0). Operators expect to see #1, #2, etc. printed on the
    // orange dot.
    if (tipStyle === 'numbered' && num > 0) {
      ctx.font = 'bold 9px Helvetica, Arial, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#ffffff'
      ctx.fillText(String(num), tip.x, tip.y)
    }
  }

  ctx.restore()
}
