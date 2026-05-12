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
// 18-snap Bug B fix (May 12 2026): added `snapMode` parameter. When true,
// the freehand 0.5" rounding is skipped — `b` is committed directly at
// `cursorWorld` (which the caller has set to the snap target). Without
// this flag, the snap target gets rounded to the nearest 0.5" length and
// re-projected along the cursor angle, drifting the endpoint up to a
// half inch off the snap target. Snap intent is exact; 0.5" rounding
// only makes sense for un-snapped freehand clicks where cursor coords
// are inherently imprecise.
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
  snapMode = false,   // 18-snap Bug B fix — true when cursorWorld IS a snap target
  addTechnicalShape,  // (shape) => void
  setTechDraft,       // (draft) => void
}) {
  if (!anchor || !cursorWorld) return false

  const hasTypedInches = typeof typedInches === 'number' && typedInches > 0
  const hasTypedAngle = typeof typedAngleDegrees === 'number' && Number.isFinite(typedAngleDegrees)

  let b
  let lengthInches
  let lengthSource
  let angleSource

  if (snapMode && !hasTypedInches && !hasTypedAngle) {
    // SNAP COMMIT — operator clicked on a snap target with no typed
    // values. cursorWorld IS the operator's exact intent; b lands there
    // verbatim with no rounding. Length is computed for the label /
    // schema field but b's geometry doesn't depend on the rounded
    // value. Round length display to 0.1" so the on-canvas label is
    // human-readable without exposing floating-point drift.
    b = { x: cursorWorld.x, y: cursorWorld.y }
    const dx = cursorWorld.x - anchor.x
    const dy = cursorWorld.y - anchor.y
    const rawIn = Math.hypot(dx, dy) / PX_PER_INCH
    lengthInches = Math.round(rawIn * 10) / 10
    if (lengthInches <= 0) {
      // Zero-length snap (operator clicked the anchor itself somehow)
      // — reject. Clear draft so they can start over without a stale
      // anchor.
      setTechDraft(null)
      return false
    }
    lengthSource = 'snap'
    angleSource = 'snap'
  } else {
    // ---- Non-snap or typed path — preserve pre-18-snap behavior. ----
    if (hasTypedInches) {
      lengthInches = typedInches
      lengthSource = 'typed'
    } else {
      const dx = cursorWorld.x - anchor.x
      const dy = cursorWorld.y - anchor.y
      const raw = Math.hypot(dx, dy) / PX_PER_INCH
      lengthInches = Math.round(raw * 2) / 2
      lengthSource = 'freehand'
      if (lengthInches <= 0) {
        // Zero-length freehand line — don't commit. Clear the draft so
        // the operator can start over without a stale anchor.
        setTechDraft(null)
        return false
      }
    }

    let angleRad
    if (hasTypedAngle) {
      angleRad = (typedAngleDegrees * Math.PI) / 180
      angleSource = 'typed'
    } else {
      const dx = cursorWorld.x - anchor.x
      const dy = cursorWorld.y - anchor.y
      angleRad = Math.atan2(dy, dx)
      angleSource = 'freehand'
    }

    const pxDistance = lengthInches * PX_PER_INCH
    b = {
      x: anchor.x + Math.cos(angleRad) * pxDistance,
      y: anchor.y + Math.sin(angleRad) * pxDistance,
    }
  }

  // Final guard: anchor === b is a degenerate line. Snap path already
  // rejects zero-length above; typed path could theoretically produce
  // a zero-length shape if typedInches is exactly 0 (caught by the
  // hasTypedInches > 0 check) but defensive belt anyway.
  if (!b || (anchor.x === b.x && anchor.y === b.y)) {
    setTechDraft(null)
    return false
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
