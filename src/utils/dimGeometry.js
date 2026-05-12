// ============================================================================
// dimGeometry.js — Phase 2 sub-step 18e (May 12 2026)
//
// Dimension-specific geometry helpers. Lives separately from techGeometry.js
// (which stays shape-agnostic plumbing) so the dim-specific math has its
// own home. Per RoofMark §21.18e canonical spec.
//
// Pure module: no React, no DOM, no store. The render helper takes a
// Canvas2D context as parameter so the same code can serve drawStatic
// AND drawDynamic (live preview) — caller controls globalAlpha for
// ghost rendering.
//
// Exports:
//   resolveDimensionPoints       — pure: cached vs attached world coords
//   identifySnapSourceShape      — pure: snap target → (shapeId, pointKey) | null
//   computeDimensionOrientation  — pure: orientation algorithm per spec
//   computeDimensionLengthInches — pure: resolved length in inches
//   computeDimensionGeometry     — pure: dim/ext/text geometry for render+hit-test
//   hitTestDimension             — pure: cursor → boolean hit on dim region
//   distanceFromSegment2         — pure: helper for hit-test math
//   drawArchTick                 — render: 45° slash at dim line endpoint
//   renderDimension              — render: full dimension via ctx (impure side
//                                  effects on the passed ctx only)
// ============================================================================

import { PX_PER_INCH } from './techConstants'
import { DIMEXO, DIMEXE, DIMASZ, DIMTXT, DIMGAP, DIM_COLOR } from './dimConstants'
import { formatArchitecturalLength } from './formatArchitecturalLength'

/**
 * Resolve a dimension's pointA + pointB to current world coordinates.
 *
 * For each point:
 *   - If mode === 'attached' AND the referenced shape+endpoint exist,
 *     read the live coords from that shape (DIMASSOC=2 behavior).
 *   - Otherwise fall back to the cached pointA.x / pointA.y.
 *
 * Cached coords are kept up-to-date by propagateDimensionUpdates in
 * useAppStore.js after every parent-shape commit, so the cache fallback
 * is only hit when the attached shape was deleted (mode flipped to
 * 'free' via cascadeDimensionDeletion).
 *
 * @param {Object} dim - dimension shape
 * @param {Array}  technicalLayers - full layer array for attached lookup
 * @returns {{A: {x, y}, B: {x, y}}}
 */
export function resolveDimensionPoints(dim, technicalLayers) {
  const resolveOne = (p) => {
    if (p && p.mode === 'attached' && p.shapeId && p.pointKey && Array.isArray(technicalLayers)) {
      for (const layer of technicalLayers) {
        if (!layer || !Array.isArray(layer.shapes)) continue
        const sh = layer.shapes.find((s) => s && s.id === p.shapeId)
        if (sh && sh[p.pointKey]) {
          return { x: sh[p.pointKey].x, y: sh[p.pointKey].y }
        }
      }
    }
    return { x: p.x, y: p.y }
  }
  return { A: resolveOne(dim.pointA), B: resolveOne(dim.pointB) }
}

/**
 * Identify which line endpoint a snap target came from.
 *
 * Returns `{ shapeId, pointKey }` only for ENDPOINT snap hits whose
 * coords match a known line's a or b endpoint within `tolPx`. Returns
 * `null` for midpoint hits per spec §"Workflow 2" step 4 — midpoints
 * are NOT defpoints in the DIMASSOC=2 model; mid-snap commits land
 * as 'free' coords.
 *
 * @param {{x, y, type} | null} snapTarget
 * @param {Array} technicalLayers
 * @param {number} [tolPx=0.5] - sub-pixel tolerance for coord match
 * @returns {{shapeId, pointKey} | null}
 */
export function identifySnapSourceShape(snapTarget, technicalLayers, tolPx) {
  if (!snapTarget || snapTarget.type !== 'endpoint') return null
  const tol = typeof tolPx === 'number' ? tolPx : 0.5
  if (!Array.isArray(technicalLayers)) return null
  for (const layer of technicalLayers) {
    if (!layer || layer.visible === false) continue
    for (const sh of layer.shapes || []) {
      if (!sh || sh.type !== 'line' || !sh.a || !sh.b) continue
      for (const pk of ['a', 'b']) {
        const dx = sh[pk].x - snapTarget.x
        const dy = sh[pk].y - snapTarget.y
        if (Math.hypot(dx, dy) < tol) {
          return { shapeId: sh.id, pointKey: pk }
        }
      }
    }
  }
  return null
}

// ============================================================================
// Phase 2 18e-dim-split (May 12 2026) — spec v1.2.
//
// The original `computeDimensionOrientation` (single-Dim model, retired
// here) collapsed AutoCAD's DIMLINEAR + DIMALIGNED into a single drag-to-
// discover UI. Operator-reported friction (`b52c9f5` ship): the perp-vs-
// along dominance gate to escape Aligned default required precise drag
// aim. Spec v1.2 splits back to two explicit commands matching AutoCAD's
// pattern.
//
// Three new pure functions replace the deleted helper:
//   - computeAlignedOrientation: Workflow 2 Aligned awaitPosition.
//     Returns { offset } only. Orientation is always 'aligned'.
//   - computeLinearOrientation: Workflow 2 Linear awaitPosition.
//     Returns { orientation: 'horizontal' | 'vertical', offset }.
//     World-axis-relative (NOT baseline-relative) cursor side
//     determines H vs V — operator-friendly for axis-aligned baselines.
//   - pickLinearOrientationFromLine: Workflow 1 Linear. No cursor
//     input — orientation derived purely from line baseline angle.
//
// Plus one helper:
//   - isDimensionCommand: shared by all dim-state-aware code paths.
// ============================================================================

/**
 * Workflow 2 Aligned awaitPosition orientation computation.
 *
 * Drag chooses offset + side only — orientation is always 'aligned',
 * dim line parallel to the A→B baseline. Offset is the signed
 * perpendicular projection of cursor from baseline midpoint (positive =
 * one side, negative = other).
 *
 * @param {{x, y}} pointA
 * @param {{x, y}} pointB
 * @param {{x, y}} cursorWorld
 * @returns {{offset: number}}
 */
export function computeAlignedOrientation(pointA, pointB, cursorWorld) {
  const M = { x: (pointA.x + pointB.x) / 2, y: (pointA.y + pointB.y) / 2 }
  const baselineAngleRad = Math.atan2(pointB.y - pointA.y, pointB.x - pointA.x)
  const baselineUnit = { x: Math.cos(baselineAngleRad), y: Math.sin(baselineAngleRad) }
  const perpUnit = { x: -baselineUnit.y, y: baselineUnit.x } // 90° CCW
  const cursorVec = { x: cursorWorld.x - M.x, y: cursorWorld.y - M.y }
  const offset = cursorVec.x * perpUnit.x + cursorVec.y * perpUnit.y
  return { offset }
}

/**
 * Workflow 2 Linear awaitPosition orientation computation.
 *
 * Cursor side relative to baseline midpoint in WORLD coords determines
 * horizontal vs vertical. NO aligned outcome possible.
 *   - |cursor.y - mid.y| > |cursor.x - mid.x|
 *       → 'horizontal' (dim line horizontal, measures X-distance)
 *   - else
 *       → 'vertical' (dim line vertical, measures Y-distance)
 *
 * Tie-break (|dx| === |dy|): falls into else branch → 'vertical'.
 *
 * Offset is signed distance from midpoint along the chosen
 * perpendicular axis:
 *   - horizontal: offset = cursor.y - mid.y
 *   - vertical:   offset = cursor.x - mid.x
 *
 * @param {{x, y}} pointA
 * @param {{x, y}} pointB
 * @param {{x, y}} cursorWorld
 * @returns {{orientation: 'horizontal' | 'vertical', offset: number}}
 */
export function computeLinearOrientation(pointA, pointB, cursorWorld) {
  const M = { x: (pointA.x + pointB.x) / 2, y: (pointA.y + pointB.y) / 2 }
  const dx = cursorWorld.x - M.x
  const dy = cursorWorld.y - M.y
  if (Math.abs(dy) > Math.abs(dx)) {
    return { orientation: 'horizontal', offset: dy }
  }
  return { orientation: 'vertical', offset: dx }
}

/**
 * Workflow 1 Linear orientation pick — no cursor input.
 *
 * Uses the same ±22.5° thresholds as Workflow 2 Linear's world-axis
 * decision so the two paths stay visually consistent:
 *   - baseline within ±22.5° of horizontal → 'horizontal'
 *   - baseline within ±22.5° of vertical → 'vertical'
 *   - diagonal (22.5°–67.5° band): longer projection wins
 *       (|dx| > |dy| → 'horizontal', else 'vertical')
 *
 * Defensive: invalid input (no line or no a/b) defaults to 'horizontal'.
 *
 * @param {Object} line - tech-line shape with a + b endpoints
 * @returns {'horizontal' | 'vertical'}
 */
export function pickLinearOrientationFromLine(line) {
  if (!line || line.type !== 'line' || !line.a || !line.b) return 'horizontal'
  const dx = line.b.x - line.a.x
  const dy = line.b.y - line.a.y
  let baselineDeg = (Math.atan2(dy, dx) * 180 / Math.PI) % 180
  if (baselineDeg < 0) baselineDeg += 180
  if (baselineDeg < 22.5 || baselineDeg > 157.5) return 'horizontal'
  if (baselineDeg >= 67.5 && baselineDeg <= 112.5) return 'vertical'
  return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
}

/**
 * Shared predicate — true iff `cmd` is one of the dim command values.
 *
 * Used by all dim-state-aware call sites (drawDynamic visibility, snap-
 * scan gate, onMouseDown dispatch, Escape chain, TechInputPanel render
 * branch). Centralizing the literal-string list here means adding a
 * future dim command type (angular, radial) is a one-line change.
 *
 * @param {string | null | undefined} cmd
 * @returns {boolean}
 */
export function isDimensionCommand(cmd) {
  return cmd === 'dim-aligned' || cmd === 'dim-linear'
}

/**
 * Compute resolved length in inches for a dimension.
 *
 *   - aligned:            hypot(A→B) / PX_PER_INCH
 *   - linear-horizontal:  |B.x - A.x| / PX_PER_INCH
 *   - linear-vertical:    |B.y - A.y| / PX_PER_INCH
 *
 * @param {Object} dim - dimension shape
 * @param {Array}  technicalLayers - for resolveDimensionPoints attached lookup
 * @returns {number} length in inches (pre-rounding; formatter rounds to 1/8")
 */
export function computeDimensionLengthInches(dim, technicalLayers) {
  const { A, B } = resolveDimensionPoints(dim, technicalLayers)
  let pxDist
  if (dim.orientation === 'horizontal') pxDist = Math.abs(B.x - A.x)
  else if (dim.orientation === 'vertical') pxDist = Math.abs(B.y - A.y)
  else pxDist = Math.hypot(B.x - A.x, B.y - A.y)
  return pxDist / PX_PER_INCH
}

/**
 * Compute the full geometry of a dimension for both render AND hit-test
 * paths. Pure function — same input → same output. Split out so the
 * render helper + hit-test helper share one source of truth for the
 * dim/ext-line endpoint math.
 *
 * Returns:
 *   {
 *     dimA, dimB: dim line endpoints (world coords)
 *     extA1, extA2, extB1, extB2: extension line endpoints (world)
 *     baselineUnit, perpUnit: unit vectors for tick / text math
 *     mid: dim line midpoint
 *     textPos: text label center (world)
 *     textRot: text rotation in radians
 *   }
 *
 * Orientation math notes:
 *   - 'aligned': dim line is parallel to baseline, offset by `dim.offset`
 *                in the CCW-perpendicular direction
 *   - 'horizontal': dim line is at midpoint.y + offset, spans pointA.x to
 *                   pointB.x; extension lines vertical
 *   - 'vertical': dim line is at midpoint.x + offset, spans pointA.y to
 *                 pointB.y; extension lines horizontal
 *
 * @param {Object} dim - dimension shape
 * @param {{x, y}} A - resolved pointA world coords
 * @param {{x, y}} B - resolved pointB world coords
 * @returns {Object} geometry bundle
 */
export function computeDimensionGeometry(dim, A, B) {
  let dimA, dimB
  let baselineUnit
  let perpDir // unit vector pointing from origin (pointA/B) toward its dim point

  if (dim.orientation === 'horizontal') {
    const midY = (A.y + B.y) / 2
    const dimY = midY + dim.offset
    dimA = { x: A.x, y: dimY }
    dimB = { x: B.x, y: dimY }
    // Baseline unit points along the dim line (left-to-right by convention).
    const baseSign = B.x >= A.x ? 1 : -1
    baselineUnit = { x: baseSign, y: 0 }
    // Perpendicular unit points from origin toward dim line. For linear-H
    // this is straight up or down depending on offset sign relative to
    // origin Y. We use sign of offset (which equals sign(dimY - midY))
    // as the canonical direction; for typical use both pointA and pointB
    // are close to midY so this matches sign(dimY - pointA.y) too.
    const sign = dim.offset >= 0 ? 1 : -1
    perpDir = { x: 0, y: sign }
  } else if (dim.orientation === 'vertical') {
    const midX = (A.x + B.x) / 2
    const dimX = midX + dim.offset
    dimA = { x: dimX, y: A.y }
    dimB = { x: dimX, y: B.y }
    // Baseline unit points along dim line (top-to-bottom in canvas Y).
    const baseSign = B.y >= A.y ? 1 : -1
    baselineUnit = { x: 0, y: baseSign }
    const sign = dim.offset >= 0 ? 1 : -1
    perpDir = { x: sign, y: 0 }
  } else {
    // ALIGNED — dim line parallel to baseline, offset along perp.
    const baseAng = Math.atan2(B.y - A.y, B.x - A.x)
    const bu = { x: Math.cos(baseAng), y: Math.sin(baseAng) }
    const pu = { x: -bu.y, y: bu.x } // 90° CCW
    dimA = { x: A.x + pu.x * dim.offset, y: A.y + pu.y * dim.offset }
    dimB = { x: B.x + pu.x * dim.offset, y: B.y + pu.y * dim.offset }
    baselineUnit = bu
    // perpDir points from origin to dim point — flip if offset negative.
    perpDir = dim.offset >= 0 ? pu : { x: -pu.x, y: -pu.y }
  }

  // Extension lines: gap from origin (DIMEXO) to past-dim-line (DIMEXE).
  const extA1 = { x: A.x + perpDir.x * DIMEXO, y: A.y + perpDir.y * DIMEXO }
  const extA2 = { x: dimA.x + perpDir.x * DIMEXE, y: dimA.y + perpDir.y * DIMEXE }
  const extB1 = { x: B.x + perpDir.x * DIMEXO, y: B.y + perpDir.y * DIMEXO }
  const extB2 = { x: dimB.x + perpDir.x * DIMEXE, y: dimB.y + perpDir.y * DIMEXE }

  const mid = { x: (dimA.x + dimB.x) / 2, y: (dimA.y + dimB.y) / 2 }

  // Text sits above the dim line (DIMTAD=1 per spec) — offset further
  // along perpDir by (DIMTXT/2 + DIMGAP) so the text BASELINE clears
  // the dim line by DIMGAP and the text CENTER sits half-text-height
  // further out. perpDir is from origin → dim line; the same direction
  // pushes text "away from origin" which is consistent with DIMTAD=1.
  const textPos = {
    x: mid.x + perpDir.x * (DIMTXT / 2 + DIMGAP),
    y: mid.y + perpDir.y * (DIMTXT / 2 + DIMGAP),
  }

  // Text rotation:
  //   horizontal: 0
  //   vertical: -π/2 (reads bottom-to-top per industry convention)
  //   aligned: parallel to baseline, flipped if upside-down so text
  //            reads left-to-right
  let textRot
  if (dim.orientation === 'horizontal') textRot = 0
  else if (dim.orientation === 'vertical') textRot = -Math.PI / 2
  else {
    textRot = Math.atan2(B.y - A.y, B.x - A.x)
    if (textRot > Math.PI / 2 || textRot < -Math.PI / 2) textRot += Math.PI
  }

  return {
    dimA, dimB,
    extA1, extA2, extB1, extB2,
    baselineUnit, perpUnit: perpDir,
    mid, textPos, textRot,
  }
}

/**
 * Point-to-segment distance (squared distance returned squared
 * for tolerance comparison — caller decides whether to sqrt).
 *
 * Pure helper, separate from techGeometry's distanceFromSegment so
 * dimGeometry's eval-shim load doesn't need to share that helper.
 *
 * @returns {number} euclidean distance in same units as inputs
 */
export function distanceFromSegment2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  const projX = x1 + t * dx
  const projY = y1 + t * dy
  return Math.hypot(px - projX, py - projY)
}

/**
 * Hit-test a dimension shape against a cursor in canvas pixel coords.
 *
 * Hit region per spec §"Selection / interaction":
 *   - dim line (between extension lines)
 *   - extension lines A and B
 *   - text bounding box
 *
 * All checks happen in canvas pixels (after viewport transform).
 *
 * @param {Object} dim
 * @param {{x, y}} cursorCanvas - cursor in canvas px
 * @param {Array} technicalLayers
 * @param {number} zoom
 * @param {number} panX
 * @param {number} panY
 * @param {number} tolPx
 * @returns {boolean} true if cursor hits any dim component
 */
export function hitTestDimension(dim, cursorCanvas, technicalLayers, zoom, panX, panY, tolPx) {
  const tol = typeof tolPx === 'number' ? tolPx : 7
  const { A, B } = resolveDimensionPoints(dim, technicalLayers)
  const geom = computeDimensionGeometry(dim, A, B)

  // Convert world coords to canvas px for distance test.
  const toCanvas = (p) => ({ x: p.x * zoom + panX, y: p.y * zoom + panY })
  const c = cursorCanvas
  const segments = [
    [toCanvas(geom.dimA), toCanvas(geom.dimB)],   // dim line
    [toCanvas(geom.extA1), toCanvas(geom.extA2)], // extension A
    [toCanvas(geom.extB1), toCanvas(geom.extB2)], // extension B
  ]
  for (const [p1, p2] of segments) {
    if (distanceFromSegment2(c.x, c.y, p1.x, p1.y, p2.x, p2.y) <= tol) return true
  }

  // Text bounding box (approximate): centered at textPos, axis-aligned
  // box of width = estimated text width + 2*DIMGAP, height = DIMTXT + 2*DIMGAP.
  // We don't have ctx for measureText here, so use a generous default
  // width based on the formatted label length. Pure approximation —
  // the tolerance buffer (tol = 7 px) on each side absorbs the rounding.
  const inches = computeDimensionLengthInches(dim, technicalLayers)
  const label = formatArchitecturalLength(inches) || ''
  // Approximate text width: 6 px per char (mono-ish default for 10 px
  // sans-serif). Multiplied by zoom because the canvas transform scales
  // glyphs with the viewport.
  const approxWidth = (label.length * 6 + 2 * DIMGAP) * zoom
  const approxHeight = (DIMTXT + 2 * DIMGAP) * zoom
  const tp = toCanvas(geom.textPos)
  // Rotate cursor into text frame to test against axis-aligned box.
  const dx = c.x - tp.x
  const dy = c.y - tp.y
  const cosR = Math.cos(-geom.textRot)
  const sinR = Math.sin(-geom.textRot)
  const localX = dx * cosR - dy * sinR
  const localY = dx * sinR + dy * cosR
  if (
    Math.abs(localX) <= approxWidth / 2 + tol
    && Math.abs(localY) <= approxHeight / 2 + tol
  ) {
    return true
  }
  return false
}

/**
 * Draw a 45° architectural tick at a dim line endpoint.
 *
 * Per spec §"Architectural tick arrow shape": a short slash crossing
 * the dim line at 45° to it, length DIMASZ. Mid-point at endPoint.
 *
 * Slash direction = (baselineUnit + perpUnit) normalized — the
 * diagonal that bisects the dim line and the extension line.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x, y}} endPoint
 * @param {{x, y}} baselineUnit
 * @param {{x, y}} perpUnit
 * @param {number} length - tick length (DIMASZ)
 */
export function drawArchTick(ctx, endPoint, baselineUnit, perpUnit, length) {
  const halfL = length / 2
  // Diagonal direction = (baseline + perp) / √2 — normalized unit.
  const dx = halfL * (baselineUnit.x + perpUnit.x) / Math.SQRT2
  const dy = halfL * (baselineUnit.y + perpUnit.y) / Math.SQRT2
  ctx.beginPath()
  ctx.moveTo(endPoint.x - dx, endPoint.y - dy)
  ctx.lineTo(endPoint.x + dx, endPoint.y + dy)
  ctx.stroke()
}

/**
 * Render a dimension to a Canvas2D context.
 *
 * Shared by drawStatic (committed dims) and drawDynamic (live preview).
 * Caller sets globalAlpha for preview rendering. Caller applies the
 * viewport transform (translate + scale) BEFORE calling this — the
 * helper operates in world coords throughout.
 *
 * Selection state is communicated via `isSelected` flag (caller looks
 * up techSelected). Selected dim renders in KCC orange + grip squares.
 * 18e initial: grips are inert (visual only). Grip-edit on dims is
 * deferred to 18e.2.
 *
 * @param {CanvasRenderingContext2D} ctx - context with viewport transform applied
 * @param {Object} dim - dimension shape
 * @param {Array} technicalLayers - for resolveDimensionPoints
 * @param {boolean} [isSelected=false] - render selected style (orange + grips)
 */
export function renderDimension(ctx, dim, technicalLayers, isSelected) {
  const { A, B } = resolveDimensionPoints(dim, technicalLayers)
  const geom = computeDimensionGeometry(dim, A, B)
  const inches = computeDimensionLengthInches(dim, technicalLayers)
  const label = formatArchitecturalLength(inches) || ''

  ctx.save()
  ctx.strokeStyle = isSelected ? '#e8531a' : DIM_COLOR
  ctx.fillStyle = isSelected ? '#e8531a' : DIM_COLOR
  ctx.lineWidth = 1.5

  // Extension lines
  ctx.beginPath()
  ctx.moveTo(geom.extA1.x, geom.extA1.y)
  ctx.lineTo(geom.extA2.x, geom.extA2.y)
  ctx.moveTo(geom.extB1.x, geom.extB1.y)
  ctx.lineTo(geom.extB2.x, geom.extB2.y)
  ctx.stroke()

  // Dim line
  ctx.beginPath()
  ctx.moveTo(geom.dimA.x, geom.dimA.y)
  ctx.lineTo(geom.dimB.x, geom.dimB.y)
  ctx.stroke()

  // Architectural ticks at each dim line endpoint
  drawArchTick(ctx, geom.dimA, geom.baselineUnit, geom.perpUnit, DIMASZ)
  drawArchTick(ctx, geom.dimB, geom.baselineUnit, geom.perpUnit, DIMASZ)

  // Text label
  ctx.save()
  ctx.translate(geom.textPos.x, geom.textPos.y)
  ctx.rotate(geom.textRot)
  ctx.font = `${DIMTXT}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 0, 0)
  ctx.restore()

  // Selection grips — inert in 18e initial per spec §"Decision flags" #10.
  // Three blue grip squares: dim line A, dim line B, text center.
  if (isSelected) {
    const gripSize = 6
    ctx.fillStyle = '#3b82f6'
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1
    for (const pt of [geom.dimA, geom.dimB, geom.textPos]) {
      ctx.fillRect(pt.x - gripSize / 2, pt.y - gripSize / 2, gripSize, gripSize)
      ctx.strokeRect(pt.x - gripSize / 2, pt.y - gripSize / 2, gripSize, gripSize)
    }
  }

  ctx.restore()
}
