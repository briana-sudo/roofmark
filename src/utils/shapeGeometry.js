// ============================================================================
// shapeGeometry.js — pure shape math primitives.
//
// Single source of truth for arc + ellipse math used by:
//   - CanvasStage.jsx (live render + hit-tests)
//   - canvasRender.js (offscreen render for PDF export — Step 16, May 8 2026)
//
// Functions operate in canvas-px space (after viewport translation).
// No DOM dependencies; safe to import from any context.
// ============================================================================

// Compute the unique circle through 3 points. Returns { cx, cy, r } or null
// if the 3 points are collinear (no circumcircle exists).
export function arcCircumcircle(p1, p2, p3) {
  const A = p2.x - p1.x
  const B = p2.y - p1.y
  const C = p3.x - p1.x
  const D = p3.y - p1.y
  const E = A * (p1.x + p2.x) + B * (p1.y + p2.y)
  const F = C * (p1.x + p3.x) + D * (p1.y + p3.y)
  const G = 2 * (A * (p3.y - p2.y) - B * (p3.x - p2.x))
  if (Math.abs(G) < 1e-9) return null
  const cx = (D * E - B * F) / G
  const cy = (A * F - C * E) / G
  const r = Math.hypot(cx - p1.x, cy - p1.y)
  return { cx, cy, r }
}

// For a 3-point arc, determine sweep direction so the canvas `ctx.arc()`
// call passes through p2. Returns { startAngle, endAngle, anticlockwise }.
// Default direction is anticlockwise=false (math-CCW which renders visually
// CW on screen due to y-down). Picks the direction whose angular sweep
// from a1 to a3 contains a2.
export function arcAnglesFor(p1, p2, p3, cx, cy) {
  const TWOPI = 2 * Math.PI
  const a1 = Math.atan2(p1.y - cy, p1.x - cx)
  const a2 = Math.atan2(p2.y - cy, p2.x - cx)
  const a3 = Math.atan2(p3.y - cy, p3.x - cx)
  const ccwSweep = ((a3 - a1 + TWOPI) % TWOPI)
  const a2Pos = ((a2 - a1 + TWOPI) % TWOPI)
  const useDefault = a2Pos <= ccwSweep
  return { startAngle: a1, endAngle: a3, anticlockwise: !useDefault }
}

// Decompose an ellipse's 2-pt bounding box into render parameters.
// Accepts any two opposite corners; doesn't matter which is TL.
export function ellipseParams(p1, p2) {
  const cx = (p1.x + p2.x) / 2
  const cy = (p1.y + p2.y) / 2
  const rx = Math.abs(p1.x - p2.x) / 2
  const ry = Math.abs(p1.y - p2.y) / 2
  return { cx, cy, rx, ry }
}
