// ============================================================================
// techGeometry.js — Phase 2 sub-step 18d (May 11 2026)
//
// Pure geometry helpers for Technical Drawing selection + rotation. No
// React, no store, no DOM imports — the test runner's eval-shim loads
// this file the same way it loads parseLength / parseAngle.
//
// Functions:
//   techShapeCentroid(shape)
//     Returns {x, y} in TECHNICAL world coords (px at zoom=1) for the
//     given shape. 18b ships only the line shape (returns midpoint).
//     Future shape types (rect, arc, circle in 18d+) extend with their
//     own centroid branches.
//
//   techMultiShapeCentroid(shapes)
//     Returns the centroid of the bounding box of all provided shapes,
//     in world coords. Used as the pivot for multi-select rotation.
//     Bbox-centroid (not average-of-centroids) gives a more predictable
//     pivot for asymmetric selections — operator visually expects the
//     pivot at the geometric center of the selection footprint.
//
//   techHitTest(cursorCanvasPx, technicalLayers, techViewport, tolPx=7)
//     Returns {layerId, shapeId} for the topmost shape under the cursor
//     within tolPx canvas-pixel proximity, or null. Iterates layers in
//     reverse order; within each layer, iterates shapes in reverse order
//     (most recently added = on top).
//
//   distanceFromSegment(px, py, x1, y1, x2, y2)
//     Standard point-to-line-segment distance. Exposed for test access
//     so the hit-test math is independently verifiable.
//
//   rotateTechShape(shape, center, deltaDeg)
//     Returns a new shape with its endpoints rotated by deltaDeg around
//     center. Uses the same convention as src/utils/perspective.js'
//     rotatePoint — positive degrees = math-CCW (canvas-Y-down: visually
//     clockwise). Matches the 18c typedAngleDegrees convention.
//
//   getSelectedTechShapes(technicalLayers, techSelected)
//     Looks up the actual shape objects from the {layerId, shapeId}
//     pairs in techSelected. Returns an array; invalid entries are
//     silently dropped (the store's setTechSelection validates, but
//     the canvas reads this helper at render time where state may
//     have drifted by one tick).
// ============================================================================

import { rotatePoint } from './perspective'

export function techShapeCentroid(shape) {
  if (!shape) return null
  if (shape.type === 'line') {
    if (!shape.a || !shape.b) return null
    return {
      x: (shape.a.x + shape.b.x) / 2,
      y: (shape.a.y + shape.b.y) / 2,
    }
  }
  // Future shape types (rect, arc, circle) extend here.
  return null
}

export function techMultiShapeCentroid(shapes) {
  if (!shapes || shapes.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let any = false
  for (const sh of shapes) {
    if (sh && sh.type === 'line' && sh.a && sh.b) {
      minX = Math.min(minX, sh.a.x, sh.b.x)
      minY = Math.min(minY, sh.a.y, sh.b.y)
      maxX = Math.max(maxX, sh.a.x, sh.b.x)
      maxY = Math.max(maxY, sh.a.y, sh.b.y)
      any = true
    }
    // Future shape types extend here.
  }
  if (!any) return null
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  }
}

export function distanceFromSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) {
    // Degenerate segment — return distance to the point.
    const ddx = px - x1
    const ddy = py - y1
    return Math.sqrt(ddx * ddx + ddy * ddy)
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  const projX = x1 + t * dx
  const projY = y1 + t * dy
  const ddx = px - projX
  const ddy = py - projY
  return Math.sqrt(ddx * ddx + ddy * ddy)
}

export function techHitTest(cursorCanvasPx, technicalLayers, techViewport, tolPx) {
  const tol = typeof tolPx === 'number' ? tolPx : 7
  const zoom = (techViewport && techViewport.zoom) || 1
  const panX = (techViewport && techViewport.panX) || 0
  const panY = (techViewport && techViewport.panY) || 0
  const cx = cursorCanvasPx.x
  const cy = cursorCanvasPx.y
  if (!Array.isArray(technicalLayers)) return null
  // Reverse-iterate layers (topmost render order first). Within each
  // layer, reverse-iterate shapes (most recently added on top).
  for (let i = technicalLayers.length - 1; i >= 0; i--) {
    const layer = technicalLayers[i]
    if (!layer || layer.visible === false) continue
    const shapes = layer.shapes || []
    for (let j = shapes.length - 1; j >= 0; j--) {
      const sh = shapes[j]
      if (!sh) continue
      if (sh.type === 'line' && sh.a && sh.b) {
        const ax = sh.a.x * zoom + panX
        const ay = sh.a.y * zoom + panY
        const bx = sh.b.x * zoom + panX
        const by = sh.b.y * zoom + panY
        if (distanceFromSegment(cx, cy, ax, ay, bx, by) <= tol) {
          return { layerId: layer.id, shapeId: sh.id }
        }
      }
      // Future shape types extend here (rect / arc / circle hit-tests).
    }
  }
  return null
}

export function rotateTechShape(shape, center, deltaDeg) {
  if (!shape || !center) return shape
  if (shape.type === 'line' && shape.a && shape.b) {
    return {
      ...shape,
      a: rotatePoint(shape.a, center, deltaDeg),
      b: rotatePoint(shape.b, center, deltaDeg),
    }
  }
  // Future shape types extend here.
  return shape
}

export function getSelectedTechShapes(technicalLayers, techSelected) {
  if (!Array.isArray(technicalLayers) || !Array.isArray(techSelected)) return []
  const out = []
  for (const entry of techSelected) {
    if (!entry) continue
    const layer = technicalLayers.find((tl) => tl && tl.id === entry.layerId)
    if (!layer) continue
    const shape = (layer.shapes || []).find((sh) => sh && sh.id === entry.shapeId)
    if (shape) out.push(shape)
  }
  return out
}
