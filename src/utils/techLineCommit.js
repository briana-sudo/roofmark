// ============================================================================
// techLineCommit.js — Phase 2 sub-step 18c (May 11 2026)
//
// Shared commit helper for the Technical Drawing line tool. Called from
// two paths:
//   1. CanvasStage onMouseDown click-commit (operator clicked the canvas
//      to set the end-point) — passes the click position as the cursor.
//   2. TechInputPanel onCommit handler when Enter fires the both-locked
//      shortcut — passes the LIVE cursor position (but doesn't actually
//      consult it since both typed values are present).
//
// Both paths respect the operator's typed values when present:
//   - typedInches  set → length locks, freehand otherwise
//   - typedAngleDegrees set → angle locks, freehand otherwise
//   - Both null → fully freehand (length = cursor distance, angle = cursor
//                 direction from anchor)
//   - Both set → fully locked (cursor ignored — end point projected purely
//                 from anchor + length + angle)
//
// Freehand length rounds to nearest 0.5" (Spec §21 shop-drawing convention).
// Freehand zero-length lines are rejected — the helper returns false so the
// caller can decide whether to clear the draft (we always do).
//
// Angle convention: typedAngleDegrees is in canvas Y-down coords
// (positive = clockwise from horizontal). Matches Math.atan2(dy, dx)
// directly so freehand and typed paths interoperate without negation.
//
// Pure: no React, no DOM, no store. Side effects routed through the
// `addTechnicalShape` and `setTechDraft` action references passed in by
// the caller (so the test runner can mock them).
// ============================================================================

// 18d-edit follow-on (May 11 2026) — PX_PER_INCH hoisted to
// src/utils/techConstants.js as the single source of truth.
import { PX_PER_INCH } from './techConstants'

export function commitTechLine({
  anchor,             // {x, y} world coords
  cursorWorld,        // {x, y} world coords — used only when a typed field is null
  typedInches,        // number | null
  typedAngleDegrees,  // number | null
  addTechnicalShape,  // (shape) => void
  setTechDraft,       // (draft) => void
}) {
  if (!anchor || !cursorWorld) return false

  let lengthInches
  let lengthSource
  if (typeof typedInches === 'number' && typedInches > 0) {
    lengthInches = typedInches
    lengthSource = 'typed'
  } else {
    const dx = cursorWorld.x - anchor.x
    const dy = cursorWorld.y - anchor.y
    const raw = Math.hypot(dx, dy) / PX_PER_INCH
    lengthInches = Math.round(raw * 2) / 2
    lengthSource = 'freehand'
    if (lengthInches <= 0) {
      // Zero-length freehand line — don't commit. Clear the draft so the
      // operator can start over without a stale anchor.
      setTechDraft(null)
      return false
    }
  }

  let angleRad
  let angleSource
  if (typeof typedAngleDegrees === 'number' && Number.isFinite(typedAngleDegrees)) {
    angleRad = (typedAngleDegrees * Math.PI) / 180
    angleSource = 'typed'
  } else {
    const dx = cursorWorld.x - anchor.x
    const dy = cursorWorld.y - anchor.y
    angleRad = Math.atan2(dy, dx)
    angleSource = 'freehand'
  }

  const pxDistance = lengthInches * PX_PER_INCH
  const b = {
    x: anchor.x + Math.cos(angleRad) * pxDistance,
    y: anchor.y + Math.sin(angleRad) * pxDistance,
  }

  addTechnicalShape({
    type: 'line',
    a: anchor,
    b,
    lengthInches,
    lengthSource,
    angleSource,
  })
  setTechDraft(null)
  return true
}
