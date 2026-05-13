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
 * Phase 2 18l (May 12 2026) — compose the display text for a callout's
 * text box. Format mirrors v1.3 Python _render_layer_callouts (D2):
 *
 *   num > 0 && textEN     → "#{num} {textEN}"
 *   num > 0 && !textEN    → "#{num}"
 *   else                  → textEN (may be empty — caller skips box)
 *
 * Pure — no DOM, no store. Shared by canvas + SVG renderers so the
 * two paths can never drift apart on text composition.
 *
 * @param {number | null | undefined} num
 * @param {string | null | undefined} textEN
 * @returns {string}
 */
export function composeCalloutText(num, textEN) {
  const n = Number.isFinite(+num) ? +num : 0
  const t = (typeof textEN === 'string' ? textEN : '').trim()
  if (n > 0 && t) return `#${n} ${t}`
  if (n > 0) return `#${n}`
  return t
}

/**
 * Phase 2 18l (May 12 2026) — Canvas 2D render for a callout shape.
 * v1.3 visual style — matches v1.3 Python _render_layer_callouts:
 *   - Leader line: amber DIM_AMBER (#B8860B), width matches dim
 *     line styling.
 *   - Tip: small amber filled dot (3px world-radius, no outline).
 *   - Text box: white fill + orange border + navy text. Contents
 *     composed via composeCalloutText (number prefix in front of
 *     textEN). Empty composed display skips the box entirely.
 *
 * Caller (CanvasStage.drawStatic) is expected to have applied the
 * TECHNICAL viewport transform (translate + scale) BEFORE calling, so
 * this function operates entirely in WORLD coordinates.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} ca - callout shape
 *   { id, type: 'callout',
 *     tip: { mode, x, y },  tail: { x, y },
 *     num: int | null, textEN: string,
 *     tipStyle: 'numbered' | 'dot' | 'none' }    // 18l: ignored;
 *                                                  always dot style
 * @param {Array} [technicalLayers] - reserved for attached-tip
 *   lookup; unused in 18l.
 * @param {boolean} [isSelected=false] - render in selection orange.
 * @param {number} [textSize=8] - global font size for the box text,
 *   driven by store.calloutTextSize (operator control in SpecTable).
 */
export function renderCalloutCanvas(ctx, ca, technicalLayers, isSelected, textSize) {
  if (!ca || ca.type !== 'callout') return
  const tip = ca.tip || {}
  const tail = ca.tail || {}
  if (typeof tip.x !== 'number' || typeof tip.y !== 'number') return
  if (typeof tail.x !== 'number' || typeof tail.y !== 'number') return

  // v1.3 palette — must match the locked Python constants 1:1.
  const DIM_AMBER = '#B8860B'
  const KCC_NAVY = '#1A2F4A'
  const KCC_ORANGE = '#e8531a'
  const SELECT_ORANGE = '#ff7a3a'

  const num = Number.isFinite(+ca.num) ? +ca.num : 0
  const display = composeCalloutText(num, ca.textEN)
  // 18l D4 — clamp text size to v1.3's valid range [6, 20].
  const fontPx = Math.max(6, Math.min(20, Math.round(+textSize || 8)))

  ctx.save()

  // Leader line — amber (selection orange when selected) at dim-line
  // width 0.8. Matches v1.3 Python CALLOUT_LEADER_COLOR + CALLOUT_LEADER_SW.
  const leaderColor = isSelected ? SELECT_ORANGE : DIM_AMBER
  ctx.strokeStyle = leaderColor
  ctx.lineWidth = 0.8
  ctx.beginPath()
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(tail.x, tail.y)
  ctx.stroke()

  // Text box at tail — only when composed display string is non-empty.
  // Skips the box entirely when num=0 AND textEN is blank (D5).
  if (display) {
    ctx.font = `bold ${fontPx}px Helvetica, Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(display).width
    const padX = 5, padY = 3
    const boxW = tw + 2 * padX
    const boxH = fontPx + 2 * padY
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
    ctx.fillText(display, tail.x, tail.y)
  }

  // Tip dot — small amber filled circle, no outline (v1.3 D1).
  // CALLOUT_TIP_DOT_R = 3.0 in the Python; matching here.
  ctx.beginPath()
  ctx.arc(tip.x, tip.y, 3, 0, Math.PI * 2)
  ctx.fillStyle = leaderColor
  ctx.fill()

  ctx.restore()
}
