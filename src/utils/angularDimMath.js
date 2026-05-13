// ============================================================================
// angularDimMath.js — Phase 2 sub-step 18k (May 12 2026)
//
// Pure math helpers for angular dimensions. Companion to dimGeometry.js
// (which stays linear-dim-focused per 18e's split). Per RoofMark §21.18k
// canonical spec.
//
// Exports (all pure, no React, no DOM, no store):
//   intersectLines(L1, L2)               → {x,y} | null (Cramer's rule)
//   rayFromVertex(vertex, line)          → {x,y} far endpoint of line
//   computeAngularOrientation(L1, L2, cursorWorld)
//                                        → {vertex, p1, p2, radius}
//   computeAngularGeometry(dim)          → {arcCenter, radius,
//                                           startAngleRad, endAngleRad,
//                                           sweep, midAngle, textPos,
//                                           angleDegrees}
//   computeAngleDegrees(dim)             → number (absolute degrees)
//   formatAngle(degrees, mode, decimalPlaces) → string
//
// Test-shim-compatible: no internal imports. The eval-shim runner loads
// this module the same way it loads parseLength.js / parseAngle.js.
// ============================================================================

/**
 * Find the intersection point of two infinite lines in 2D space.
 * Cramer's rule formulation. Returns null when the determinant is
 * near zero (parallel / collinear).
 *
 * @param {{a:{x,y}, b:{x,y}}} L1
 * @param {{a:{x,y}, b:{x,y}}} L2
 * @param {number} [tol=1e-9] - determinant tolerance below which lines
 *   are treated as parallel
 * @returns {{x: number, y: number} | null}
 */
export function intersectLines(L1, L2, tol = 1e-9) {
  if (!L1 || !L1.a || !L1.b || !L2 || !L2.a || !L2.b) return null
  // Convert to general form: a*x + b*y = c
  const a1 = L1.b.y - L1.a.y
  const b1 = L1.a.x - L1.b.x
  const c1 = a1 * L1.a.x + b1 * L1.a.y
  const a2 = L2.b.y - L2.a.y
  const b2 = L2.a.x - L2.b.x
  const c2 = a2 * L2.a.x + b2 * L2.a.y
  const det = a1 * b2 - a2 * b1
  if (Math.abs(det) < tol) return null
  return {
    x: (b2 * c1 - b1 * c2) / det,
    y: (a1 * c2 - a2 * c1) / det,
  }
}

/**
 * Identify which endpoint of `line` is farther from `vertex` and return it.
 * Used to pick the "p1" or "p2" reference point for the ray from the
 * vertex along this line — we always want the far endpoint so the
 * extension line spans visibly past the vertex.
 *
 * Tie-break (equidistant — degenerate): returns `line.b`.
 *
 * @param {{x, y}} vertex
 * @param {{a:{x,y}, b:{x,y}}} line
 * @returns {{x, y}}
 */
export function rayFromVertex(vertex, line) {
  if (!line || !line.a || !line.b) return { x: 0, y: 0 }
  if (!vertex) return line.b
  const dA = Math.hypot(line.a.x - vertex.x, line.a.y - vertex.y)
  const dB = Math.hypot(line.b.x - vertex.x, line.b.y - vertex.y)
  return dA > dB ? line.a : line.b
}

/**
 * Workflow 1 — given two selected lines + a cursor position, derive the
 * angular-dim parameters:
 *   - vertex: shared endpoint if the lines share one within tolerance,
 *     else line-line intersection point
 *   - p1, p2: each line's far endpoint from vertex
 *   - radius: distance from vertex to cursor (in world px)
 *
 * Returns null if the lines are parallel + don't share an endpoint
 * (no vertex available).
 *
 * @param {{a:{x,y}, b:{x,y}}} L1
 * @param {{a:{x,y}, b:{x,y}}} L2
 * @param {{x, y}} cursorWorld
 * @param {number} [shareTol=0.5] - pixel tolerance for shared-endpoint match
 * @returns {{vertex, p1, p2, radius} | null}
 */
export function computeAngularOrientation(L1, L2, cursorWorld, shareTol = 0.5) {
  if (!L1 || !L2 || !cursorWorld) return null

  // First try shared-endpoint detection. Tests all 4 endpoint pairings;
  // returns the matching endpoint at the first hit.
  let vertex = null
  const endpoints = [
    ['a', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'b'],
  ]
  for (const [k1, k2] of endpoints) {
    if (!L1[k1] || !L2[k2]) continue
    if (
      Math.abs(L1[k1].x - L2[k2].x) < shareTol
      && Math.abs(L1[k1].y - L2[k2].y) < shareTol
    ) {
      vertex = { x: L1[k1].x, y: L1[k1].y }
      break
    }
  }

  // No shared endpoint — fall back to line-line intersection.
  if (!vertex) {
    vertex = intersectLines(L1, L2)
    if (!vertex) return null
  }

  const p1 = rayFromVertex(vertex, L1)
  const p2 = rayFromVertex(vertex, L2)
  const radius = Math.hypot(cursorWorld.x - vertex.x, cursorWorld.y - vertex.y)
  return {
    vertex,
    p1: { x: p1.x, y: p1.y },
    p2: { x: p2.x, y: p2.y },
    radius,
  }
}

/**
 * Compute the full geometry of an angular dimension for both render +
 * hit-test paths. Pure function — same input → same output. Mirrors
 * dimGeometry.computeDimensionGeometry's shape for linear dims so
 * downstream code can branch on dim.dimType and stay parallel.
 *
 * Returns:
 *   {
 *     arcCenter: {x, y}            // = vertex
 *     radius: number
 *     startAngleRad: number        // angle of ray 1 from vertex
 *     endAngleRad: number          // angle of ray 2 from vertex
 *     sweep: number                // signed, normalized to (-π, π]
 *     midAngle: number             // start + sweep/2
 *     textPos: {x, y}              // label position outside arc
 *     angleDegrees: number         // absolute sweep magnitude in degrees
 *   }
 *
 * @param {Object} dim - {vertex, p1, p2, radius}
 * @returns {Object}
 */
export function computeAngularGeometry(dim) {
  if (!dim || !dim.vertex || !dim.p1 || !dim.p2) {
    return null
  }
  const v = dim.vertex
  const r = (typeof dim.radius === 'number' && dim.radius > 0) ? dim.radius : 24
  const a1 = Math.atan2(dim.p1.y - v.y, dim.p1.x - v.x)
  const a2 = Math.atan2(dim.p2.y - v.y, dim.p2.x - v.x)
  // Smaller sweep — normalize to (-π, π].
  let sweep = a2 - a1
  while (sweep > Math.PI) sweep -= 2 * Math.PI
  while (sweep < -Math.PI) sweep += 2 * Math.PI
  const midAngle = a1 + sweep / 2
  // Label sits ~14 world px outside the arc at the mid-angle.
  const labelOffset = 14
  const textPos = {
    x: v.x + (r + labelOffset) * Math.cos(midAngle),
    y: v.y + (r + labelOffset) * Math.sin(midAngle),
  }
  return {
    arcCenter: { x: v.x, y: v.y },
    radius: r,
    startAngleRad: a1,
    endAngleRad: a1 + sweep,
    sweep,
    midAngle,
    textPos,
    angleDegrees: Math.abs(sweep) * 180 / Math.PI,
  }
}

/**
 * Compute the absolute angle in degrees between an angular dim's two
 * rays. Convenience wrapper around computeAngularGeometry — useful for
 * specTableJSON's bridge which only needs the scalar.
 *
 * @param {Object} dim
 * @returns {number} absolute degrees, in [0, 180]
 */
export function computeAngleDegrees(dim) {
  const g = computeAngularGeometry(dim)
  return g ? g.angleDegrees : 0
}

/**
 * Format an angle for display. v1.2 default: degrees with 1 decimal
 * place ("45.0°"). `mode: 'pitch'` returns N/12 fractional notation
 * (rise/run, common in roofing). 18k default per spec D2 is 'degrees'
 * — pitch mode is plumbed for future per-dim toggle (18k.2 if it ships).
 *
 * @param {number} degrees
 * @param {'degrees' | 'pitch'} [mode='degrees']
 * @param {number} [decimalPlaces=1]
 * @returns {string}
 */
/**
 * Phase 2 18k bug-fix (May 12 2026) — Canvas 2D render for an angular
 * dimension. Mirrors shopDrawingSvgRender.renderAngularDim's geometry
 * (arc + extension lines + tangent arrow tips + label with white bg
 * pad) but emits to a Canvas 2D context instead of SVG JSX.
 *
 * Caller (CanvasStage.drawStatic) is expected to have applied the
 * TECHNICAL viewport transform (translate + scale) BEFORE calling, so
 * this function operates entirely in WORLD coordinates — same
 * convention as dimGeometry.renderDimension.
 *
 * Selection state is communicated via `isSelected` flag (orange instead
 * of amber). isSelected for 18k is wired through but visually subtle;
 * the existing dim selection grip pattern from dimGeometry can be
 * grafted on in a future polish step.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} dim - angular dimension shape
 *   { vertex: {x,y}, p1: {x,y}, p2: {x,y}, radius, value, textOverride }
 *   Operator-stored 'vertex.mode' is ignored here — only the cached x/y
 *   matter for render (resolveDimensionPoints-equivalent for angular
 *   dims is deferred to a future associativity pass).
 * @param {Array} [technicalLayers] - reserved for future attached-vertex
 *   lookup; unused in 18k.
 * @param {boolean} [isSelected=false]
 */
export function renderAngularDimCanvas(ctx, dim, technicalLayers, isSelected) {
  if (!dim || !dim.vertex || !dim.p1 || !dim.p2) return
  const v = dim.vertex
  const p1 = dim.p1
  const p2 = dim.p2
  const radius = (typeof dim.radius === 'number' && dim.radius > 0) ? dim.radius : 24

  // Ray angles in world coords (canvas y-down).
  const a1 = Math.atan2(p1.y - v.y, p1.x - v.x)
  const a2 = Math.atan2(p2.y - v.y, p2.x - v.x)
  let sweep = a2 - a1
  while (sweep > Math.PI) sweep -= 2 * Math.PI
  while (sweep < -Math.PI) sweep += 2 * Math.PI
  const sweepSign = sweep >= 0 ? 1 : -1

  // Arc endpoints.
  const arcStartX = v.x + radius * Math.cos(a1)
  const arcStartY = v.y + radius * Math.sin(a1)
  const arcEndX   = v.x + radius * Math.cos(a1 + sweep)
  const arcEndY   = v.y + radius * Math.sin(a1 + sweep)

  // Extension line endpoints — vertex → past-arc along each ray.
  const u1L = Math.hypot(p1.x - v.x, p1.y - v.y) || 1
  const u1x = (p1.x - v.x) / u1L, u1y = (p1.y - v.y) / u1L
  const u2L = Math.hypot(p2.x - v.x, p2.y - v.y) || 1
  const u2x = (p2.x - v.x) / u2L, u2y = (p2.y - v.y) / u2L
  const extPast = 14  // matches DIM_EXTENSION_OFFSET (linear dim style)
  const ext1x = v.x + (radius + extPast) * u1x
  const ext1y = v.y + (radius + extPast) * u1y
  const ext2x = v.x + (radius + extPast) * u2x
  const ext2y = v.y + (radius + extPast) * u2y

  ctx.save()
  const amber = '#B8860B'
  const orange = '#e8531a'
  const strokeColor = isSelected ? orange : amber
  ctx.strokeStyle = strokeColor
  ctx.fillStyle = strokeColor
  ctx.lineWidth = 0.8
  // Use stroke / fill in world units; caller has scaled the ctx so
  // visual stroke width tracks zoom (matches linear dim style).

  // Extension lines from p1/p2 (far endpoints) through vertex to past-arc.
  ctx.beginPath()
  ctx.moveTo(p1.x, p1.y)
  ctx.lineTo(ext1x, ext1y)
  ctx.moveTo(p2.x, p2.y)
  ctx.lineTo(ext2x, ext2y)
  ctx.stroke()

  // Arc itself — Canvas2D arc takes (cx, cy, radius, startAngle, endAngle, anticlockwise).
  ctx.beginPath()
  // canvas-y-down → atan2 angles match standard math, but anticlockwise
  // flag flips because canvas y is inverted from math convention.
  // We want the SHORTER sweep; anticlockwise = sweep < 0.
  ctx.arc(v.x, v.y, radius, a1, a1 + sweep, sweepSign < 0)
  ctx.stroke()

  // Tangent arrow tips at arc endpoints. Tangent at arc_start oriented
  // along CCW direction; at arc_end oriented back toward arc_start.
  const tStartX = -Math.sin(a1) * sweepSign
  const tStartY =  Math.cos(a1) * sweepSign
  const tEndX  =  Math.sin(a1 + sweep) * sweepSign
  const tEndY  = -Math.cos(a1 + sweep) * sweepSign
  const drawArrow = (tipX, tipY, dirX, dirY) => {
    const arrowLen = 6, arrowHalfW = 2.5
    const bx = tipX - dirX * arrowLen
    const by = tipY - dirY * arrowLen
    const apx = dirY, apy = -dirX
    const p1ax = bx + apx * arrowHalfW
    const p1ay = by + apy * arrowHalfW
    const p2ax = bx - apx * arrowHalfW
    const p2ay = by - apy * arrowHalfW
    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(p1ax, p1ay)
    ctx.lineTo(p2ax, p2ay)
    ctx.closePath()
    ctx.fill()
  }
  drawArrow(arcStartX, arcStartY, tStartX, tStartY)
  drawArrow(arcEndX,   arcEndY,   tEndX,   tEndY)

  // Label at mid-angle outside the arc.
  const label = (() => {
    const override = typeof dim.textOverride === 'string'
      ? dim.textOverride.trim()
      : ''
    if (override !== '') return override
    if (typeof dim.value === 'string' && dim.value.trim()) return dim.value.trim()
    const degrees = Math.abs(sweep) * 180 / Math.PI
    return formatAngle(degrees, 'degrees', 1)
  })()
  if (label) {
    const midAngle = a1 + sweep / 2
    const labelRadius = radius + 12
    const lx = v.x + labelRadius * Math.cos(midAngle)
    const ly = v.y + labelRadius * Math.sin(midAngle)
    // White background pad for the label so it reads over geometry.
    ctx.save()
    ctx.font = 'bold 8px Helvetica, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(label).width
    const padX = 2, padY = 2
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(lx - tw / 2 - padX, ly - 4 - padY, tw + 2 * padX, 8 + 2 * padY)
    ctx.fillStyle = strokeColor
    ctx.fillText(label, lx, ly)
    ctx.restore()
  }

  ctx.restore()
}

export function formatAngle(degrees, mode = 'degrees', decimalPlaces = 1) {
  if (typeof degrees !== 'number' || !Number.isFinite(degrees)) return ''
  if (mode === 'pitch') {
    // Pitch = tan(angle) * 12 (rise over run-of-12).
    // Clamp to non-negative — pitch is conventionally positive.
    const rise = Math.abs(Math.tan(degrees * Math.PI / 180) * 12)
    // Round to 1/8 inch precision for readability.
    const rounded = Math.round(rise * 8) / 8
    return `${rounded}/12`
  }
  // degrees mode
  const dp = Math.max(0, Math.min(6, Math.floor(decimalPlaces)))
  return `${degrees.toFixed(dp)}°`
}
