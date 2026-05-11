import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  effectivePhotoSize, photoNormToCanvas, canvasToPhotoNorm,
  computeFitViewport, clampPan, zoomAtCursor, clampZoom,
} from '../store/viewport'
import { arcCircumcircle, arcAnglesFor, ellipseParams } from '../utils/shapeGeometry'
import {
  drawShapeOnContext as drawShapeOnContextShared,
  drawAnnotationOnContext as drawAnnotationOnContextShared,
} from '../utils/canvasRender'
import { buildPerspectiveTransform, rotatePoint } from '../utils/perspective'
import ContextMenu from './ContextMenu'
// Phase 2 18b — Technical Drawing internal scale (24 px = 1 inch per
// Spec §21). Used by the line-tool dispatch + render. Importing the
// constant rather than redefining it keeps the canvas in lock-step with
// the store actions and the parseLength contract.
import { PX_PER_INCH } from '../store/useAppStore'
// Phase 2 18c — shared commit helper used by the canvas click-commit
// path. The Enter-typed commit path lives in TechInputPanel (docked
// panel, mounted by App.jsx since 18c docked pivot May 11 2026) and
// imports commitTechLine directly from the same module.
import { commitTechLine } from '../utils/techLineCommit'
// Phase 2 18d (May 11 2026) — pure tech geometry helpers for
// selection hit-test, centroid math (single + multi), shape rotation.
import {
  techShapeCentroid, techMultiShapeCentroid,
  techHitTest, rotateTechShape, getSelectedTechShapes,
} from '../utils/techGeometry'

/**
 * CanvasStage — Step 3 substrate + Step 5 drawing tools (Spec §6, §7).
 *
 * Owns:
 *   - Two stacked canvases (cvStatic z-index 1, cvDynamic z-index 2)
 *   - DPR compensation on mount + ResizeObserver + window resize
 *   - rAF loop with closure-scoped staticDirty / dynamicDirty flags
 *   - Mouse + touch handlers that mutate Zustand cursor + flip dynamicDirty
 *   - Tool-aware drawing state machine (poly / rect / tri / circ / line)
 *   - Draft commit produces normalized-coord shape and calls store.addShape
 *   - Static draw renders all layer shapes (5 types) bottom-to-top with
 *     per-layer fill/stroke/opacity
 *   - Dynamic draw renders rubber-band preview from draft state + cursor
 *     crosshair on top
 *   - Store subscription flips staticDirty on layers/clines reference change
 *     and clears in-progress draft on tool change
 *
 * Constants match /test/step-5-functional.html block test verbatim so the
 * standalone proof and the React clone behave identically.
 */
const SNAP_TOLERANCE_DEFAULT = 12
const MIN_RECT_SIZE = 3
const MIN_CIRCLE_R = 3
// Spec §6.6 — cline categorization tolerances. ORTHO_TOL is the px window
// within which a drag is treated as horizontal or vertical. MIN_CLINE_DRAG
// gates accidental clicks-without-drag from creating clines.
const ORTHO_TOL = 3
const MIN_CLINE_DRAG = 5
// Length used to render an angled cline far past the canvas edges so the
// browser clips it for us. 5000px is plenty for any reasonable canvas size.
const CLINE_SENT = 5000

// Spec §8 — snap engine pure function. Inputs in canvas px (cursor +
// canvas dims), output { x, y, type } | null in canvas px. Section 7.A
// — translate normalized 0..1 photo coords to canvas px via the viewport
// before any geometric math. The snap tolerance stays in canvas px
// because the operator's snap-feel is pixel-distance on screen.
function getShapeCorners(shape, viewport, photoSize) {
  const tx = (p) => photoNormToCanvas(p, viewport, photoSize)
  if (shape.type === 'circ') return [tx({ x: shape.cx, y: shape.cy })]
  if (!shape.pts) return []
  return shape.pts.map(tx)
}

function getShapeEdges(shape, viewport, photoSize) {
  if (shape.type === 'circ') return []
  // P6 — arc + ellipse aren't piecewise-linear, so they don't have
  // straight-edge midpoints. Skip both for midpoint-snap purposes.
  if (shape.type === 'arc' || shape.type === 'ellipse') return []
  if (!shape.pts || shape.pts.length < 2) return []
  const tx = (p) => photoNormToCanvas(p, viewport, photoSize)
  const pts = shape.pts.map(tx)
  const edges = []
  for (let i = 0; i < pts.length - 1; i++) edges.push([pts[i], pts[i + 1]])
  if (shape.type !== 'line' && pts.length >= 3) {
    edges.push([pts[pts.length - 1], pts[0]])
  }
  return edges
}

function projectOntoCline(cursorX, cursorY, cl, viewport, photoSize) {
  // Section 7.A — clines are normalized to photo dims (h: y; v: x; angled:
  // px/py + angle); translate to canvas px via the viewport.
  if (cl.type === 'h') {
    const y = cl.y * photoSize.height * viewport.zoom + viewport.panY
    return { x: cursorX, y }
  }
  if (cl.type === 'v') {
    const x = cl.x * photoSize.width * viewport.zoom + viewport.panX
    return { x, y: cursorY }
  }
  const a = photoNormToCanvas({ x: cl.px, y: cl.py }, viewport, photoSize)
  const cosA = Math.cos(cl.angle), sinA = Math.sin(cl.angle)
  const dx = cursorX - a.x, dy = cursorY - a.y
  const t = dx * cosA + dy * sinA
  return { x: a.x + t * cosA, y: a.y + t * sinA }
}

// Spec §9 — edit-mode hit-test + handle helpers. Same math as the block
// test at /test/step-9-functional.html.
function pointInPolygon(px, py, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y
    const xj = pts[j].x, yj = pts[j].y
    const intersect = ((yi > py) !== (yj > py))
      && (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-12) {
    const ex = px - ax, ey = py - ay
    return Math.sqrt(ex * ex + ey * ey)
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  const ex = px - cx, ey = py - cy
  return Math.sqrt(ex * ex + ey * ey)
}

// ============================================================================
// P6 (May 7 2026) — Arc (3-point) + Ellipse (bounding-box) hit-test helpers.
// The math primitives (arcCircumcircle, arcAnglesFor, ellipseParams) live in
// src/utils/shapeGeometry.js so they can be shared with the offscreen PDF
// render pipeline (Step 16, May 8 2026 — see canvasRender.js). Hit-test is
// canvas-px aware and stays here.
//
//   Arc:     { type: 'arc', pts: [start, mid, end] }
//   Ellipse: { type: 'ellipse', pts: [tlOrAny, brOrAny] } (any 2 opposite corners)
// ============================================================================

// Hit-test for a 3-point arc. Returns true if the cursor is within
// `tolerance` canvas-px of the arc curve AND between the start/end
// angles in the sweep direction.
function arcHit(p1, p2, p3, cursorX, cursorY, tolerance) {
  const cc = arcCircumcircle(p1, p2, p3)
  if (!cc) {
    // Collinear — fall back to two segments p1→p2, p2→p3.
    const d1 = distToSegment(cursorX, cursorY, p1.x, p1.y, p2.x, p2.y)
    const d2 = distToSegment(cursorX, cursorY, p2.x, p2.y, p3.x, p3.y)
    return Math.min(d1, d2) <= tolerance
  }
  const { cx, cy, r } = cc
  const dCircle = Math.abs(Math.hypot(cursorX - cx, cursorY - cy) - r)
  if (dCircle > tolerance) return false
  // Cursor is on the circumcircle within tolerance — check arc segment.
  const TWOPI = 2 * Math.PI
  const a1 = Math.atan2(p1.y - cy, p1.x - cx)
  const a2 = Math.atan2(p2.y - cy, p2.x - cx)
  const a3 = Math.atan2(p3.y - cy, p3.x - cx)
  const aT = Math.atan2(cursorY - cy, cursorX - cx)
  const ccwSweep = ((a3 - a1 + TWOPI) % TWOPI)
  const a2Pos = ((a2 - a1 + TWOPI) % TWOPI)
  if (a2Pos <= ccwSweep) {
    // Default direction sweep — check cursor in [a1, a1+ccwSweep].
    const tPos = ((aT - a1 + TWOPI) % TWOPI)
    return tPos <= ccwSweep + 1e-3
  } else {
    // Reverse direction sweep — check cursor in [a1, a1-cwSweep].
    const cwSweep = TWOPI - ccwSweep
    const tPos = ((a1 - aT + TWOPI) % TWOPI)
    return tPos <= cwSweep + 1e-3
  }
}

// Hit-test for an ellipse — point-in-ellipse via the standard
// (x-cx)²/rx² + (y-cy)²/ry² ≤ 1 inequality. Degenerate (rx or ry < 1)
// → no hit.
function ellipseHit(p1, p2, cursorX, cursorY) {
  const { cx, cy, rx, ry } = ellipseParams(p1, p2)
  if (rx < 1 || ry < 1) return false
  const dx = (cursorX - cx) / rx
  const dy = (cursorY - cy) / ry
  return dx * dx + dy * dy <= 1
}

function shapeHit(shape, cursorCanvas, viewport, photoSize) {
  // Section 7.A — hit-test in canvas-px space after translating shape
  // coords through the viewport. Tolerance for line-proximity stays at
  // 6 canvas px (same operator-feel as before §7.A).
  const tx = (p) => photoNormToCanvas(p, viewport, photoSize)
  if (shape.type === 'circ') {
    const c = tx({ x: shape.cx, y: shape.cy })
    const dx = cursorCanvas.x - c.x
    const dy = cursorCanvas.y - c.y
    const r = shape.r * photoSize.width * viewport.zoom
    return Math.sqrt(dx * dx + dy * dy) <= r
  }
  if (shape.type === 'line') {
    if (!shape.pts || shape.pts.length < 2) return false
    const a = tx(shape.pts[0])
    const b = tx(shape.pts[1])
    return distToSegment(cursorCanvas.x, cursorCanvas.y, a.x, a.y, b.x, b.y) <= 6
  }
  // P6 — arc: project cursor onto the circumcircle and check if it's
  // within tolerance + within the arc's swept angle range.
  if (shape.type === 'arc') {
    if (!shape.pts || shape.pts.length < 3) return false
    const a = tx(shape.pts[0])
    const b = tx(shape.pts[1])
    const c = tx(shape.pts[2])
    return arcHit(a, b, c, cursorCanvas.x, cursorCanvas.y, 6)
  }
  // P6 — ellipse: standard point-in-ellipse inequality.
  if (shape.type === 'ellipse') {
    if (!shape.pts || shape.pts.length < 2) return false
    const a = tx(shape.pts[0])
    const b = tx(shape.pts[1])
    return ellipseHit(a, b, cursorCanvas.x, cursorCanvas.y)
  }
  if (!shape.pts || shape.pts.length < 3) return false
  const polyCanvas = shape.pts.map(tx)
  return pointInPolygon(cursorCanvas.x, cursorCanvas.y, polyCanvas)
}

function hitTest(cursorCanvas, layers, viewport, photoSize) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    if (!layer.visible) continue
    const shapes = layer.shapes || []
    for (let j = shapes.length - 1; j >= 0; j--) {
      if (shapeHit(shapes[j], cursorCanvas, viewport, photoSize)) {
        return { layerId: layer.id, shapeId: shapes[j].id }
      }
    }
  }
  return null
}

// ============================================================================
// P34 (May 7 2026) — Annotation handle / hit-test helpers (EDIT mode).
// Each annotation type exposes per-point handles (vertex dots) for drag-to-
// reshape, plus a body-center handle for translate. Patterns mirror the
// existing shape helpers (shapeHandlePoints / shapeCentroid / movePoint /
// moveBody) so the EDIT-mode drag plumbing reuses cleanly.
//
// Handle field-name semantics — important for the drag handler since it
// has to call updateAnnotation(seqId, annoId, { [field]: newPt }):
//   note     — single 'at' point (handle index 0)
//   callout  — 'tip' (handle index 0) + 'tail' (handle index 1)
//   dimline  — 'a' (handle index 0) + 'b' (handle index 1)
// ============================================================================
function annotationHandles(anno) {
  // Returns array of { field, point } in canvas-norm space (0..1).
  // Caller translates to canvas px via photoNormToCanvas before render
  // / hit-test.
  if (!anno || typeof anno !== 'object') return []
  if (anno.type === 'note') {
    return anno.at ? [{ field: 'at', point: anno.at }] : []
  }
  if (anno.type === 'callout') {
    const out = []
    if (anno.tip)  out.push({ field: 'tip',  point: anno.tip })
    if (anno.tail) out.push({ field: 'tail', point: anno.tail })
    return out
  }
  if (anno.type === 'dimline') {
    const out = []
    if (anno.a) out.push({ field: 'a', point: anno.a })
    if (anno.b) out.push({ field: 'b', point: anno.b })
    return out
  }
  return []
}

// Body-center for translate. Note has no separate body-center (its single
// point IS the body); callout / dimline use the midpoint of their two
// points.
function annotationCentroid(anno) {
  if (!anno) return null
  if (anno.type === 'note') return null  // body == single anchor; no separate centroid handle
  if (anno.type === 'callout' && anno.tip && anno.tail) {
    return { x: (anno.tip.x + anno.tail.x) / 2, y: (anno.tip.y + anno.tail.y) / 2 }
  }
  if (anno.type === 'dimline' && anno.a && anno.b) {
    return { x: (anno.a.x + anno.b.x) / 2, y: (anno.a.y + anno.b.y) / 2 }
  }
  return null
}

// Hit-test for new annotation selection (cursor near anchor point).
// Tolerance is 8 canvas-px (slightly looser than shape's 6px since
// annotations are smaller markers).
function annotationHit(anno, cursorCanvas, viewport, photoSize, tolerance = 8) {
  const handles = annotationHandles(anno)
  for (const h of handles) {
    const c = photoNormToCanvas(h.point, viewport, photoSize)
    const dx = cursorCanvas.x - c.x
    const dy = cursorCanvas.y - c.y
    if (dx * dx + dy * dy <= tolerance * tolerance) return true
  }
  return false
}

// Hit-test scan across all annotations of a sequence. Returns
// { sequenceId, annotationId } for the first hit (creation order),
// or null if none.
function annotationHitTest(annotations, sequenceId, cursorCanvas, viewport, photoSize, tolerance = 8) {
  if (!annotations) return null
  // Iterate in REVERSE so top-rendered (later-in-array) annotations
  // are hit first under the cursor.
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i]
    if (annotationHit(a, cursorCanvas, viewport, photoSize, tolerance)) {
      return { sequenceId, annotationId: a.id }
    }
  }
  return null
}

// Translate a single annotation field-point by canvas-px delta. Used for
// body drag (callout / dimline shift all points; note shifts its single
// .at). Returns the partial that updateAnnotation should receive.
function annotationBodyTranslatePartial(anno, deltaCanvas, viewport, photoSize) {
  const dxN = deltaCanvas.x / (photoSize.width * viewport.zoom || 1)
  const dyN = deltaCanvas.y / (photoSize.height * viewport.zoom || 1)
  if (anno.type === 'note' && anno.at) {
    return { at: { x: anno.at.x + dxN, y: anno.at.y + dyN } }
  }
  if (anno.type === 'callout' && anno.tip && anno.tail) {
    return {
      tip:  { x: anno.tip.x  + dxN, y: anno.tip.y  + dyN },
      tail: { x: anno.tail.x + dxN, y: anno.tail.y + dyN },
    }
  }
  if (anno.type === 'dimline' && anno.a && anno.b) {
    return {
      a: { x: anno.a.x + dxN, y: anno.a.y + dyN },
      b: { x: anno.b.x + dxN, y: anno.b.y + dyN },
    }
  }
  return null
}

function shapeHandlePoints(shape, viewport, photoSize) {
  const tx = (p) => photoNormToCanvas(p, viewport, photoSize)
  if (shape.type === 'circ') {
    const center = tx({ x: shape.cx, y: shape.cy })
    return [
      center,
      { x: center.x + shape.r * photoSize.width * viewport.zoom, y: center.y },
    ]
  }
  if (!shape.pts) return []
  return shape.pts.map(tx)
}

function shapeCentroid(shape, viewport, photoSize) {
  const tx = (p) => photoNormToCanvas(p, viewport, photoSize)
  if (shape.type === 'circ') return tx({ x: shape.cx, y: shape.cy })
  if (!shape.pts || shape.pts.length === 0) return null
  let sx = 0, sy = 0
  for (const p of shape.pts) { sx += p.x; sy += p.y }
  return tx({ x: sx / shape.pts.length, y: sy / shape.pts.length })
}

function movePoint(shape, pointIndex, newCanvasPt, viewport, photoSize) {
  // Translate the new canvas-px point back to photo-normalized.
  const newNorm = canvasToPhotoNorm(newCanvasPt, viewport, photoSize)
  if (shape.type === 'circ') {
    if (pointIndex === 0) return { ...shape, cx: newNorm.x, cy: newNorm.y }
    // Radius handle drag — recompute r as canvas distance / photoW / zoom.
    const center = photoNormToCanvas({ x: shape.cx, y: shape.cy }, viewport, photoSize)
    const dx = newCanvasPt.x - center.x
    const dy = newCanvasPt.y - center.y
    const rPx = Math.sqrt(dx * dx + dy * dy)
    return { ...shape, r: rPx / (photoSize.width * viewport.zoom || 1) }
  }
  if (!shape.pts) return shape
  const newPts = shape.pts.map((p, i) => (i === pointIndex ? newNorm : p))
  return { ...shape, pts: newPts }
}

function moveBody(shape, deltaCanvas, viewport, photoSize) {
  // Translate the canvas-px delta into normalized-photo delta.
  const dxN = deltaCanvas.x / (photoSize.width * viewport.zoom || 1)
  const dyN = deltaCanvas.y / (photoSize.height * viewport.zoom || 1)
  if (shape.type === 'circ') return { ...shape, cx: shape.cx + dxN, cy: shape.cy + dyN }
  if (!shape.pts) return shape
  return { ...shape, pts: shape.pts.map((p) => ({ x: p.x + dxN, y: p.y + dyN })) }
}

function computeSnap(args) {
  const {
    cursorX, cursorY, layers, clines,
    snapEnabled, snapTypes,
    gridEnabled, gridSize, snapTolerance,
    draft, tool, clinesVisible, viewport, photoSize,
    // P16 + P38 (May 8 2026) — perspective corners + grid rotation. Both
    // optional / default-zero. Per Option Y, perspective dominates when
    // active.
    perspectiveCorners, gridRotation,
  } = args
  if (!snapEnabled) return null
  // P2 (May 7 2026) — per-snap-type gates. Each branch checks its own
  // snapTypes[name] flag; default-true if missing for forward-compat.
  // Master snapEnabled stays the global override above.
  const st = snapTypes || {}
  const allowClose = st.close !== false
  const allowGrid = st.grid !== false
  const allowCorner = st.corner !== false
  const allowMidpoint = st.midpoint !== false
  const allowCline = st.cline !== false
  const tolSq = snapTolerance * snapTolerance

  // 1. CLOSE — draft polygon points are stored in canvas px (since draft
  // is built incrementally as the operator clicks), so this comparison
  // stays in canvas px.
  if (allowClose && (tool === 'poly' || tool === 'tri') && draft && draft.pts && draft.pts.length >= 3) {
    const first = draft.pts[0]
    const dx = cursorX - first.x, dy = cursorY - first.y
    if (dx * dx + dy * dy < tolSq) return { x: first.x, y: first.y, type: 'close' }
  }

  // 2. GRID — Step 10 / P12+P14 rectangular grid in PHOTO px. Snap targets
  // are at integer multiples of (gridSize.x, gridSize.y) in photo space;
  // translate to canvas px before the distance test so the on-screen
  // tolerance remains pixel-true regardless of zoom.
  // P16 + P38 (May 8 2026) — three branches matching the render path.
  // Option Y: perspective dominates rotation when both are active.
  if (allowGrid && gridEnabled) {
    const gxStep = (typeof gridSize === 'object' ? gridSize.x : gridSize) || 20
    const gyStep = (typeof gridSize === 'object' ? gridSize.y : gridSize) || 20
    // Cursor canvas → photo px (common to all branches).
    const cursorPhotoX = (cursorX - viewport.panX) / viewport.zoom
    const cursorPhotoY = (cursorY - viewport.panY) / viewport.zoom

    const persp = (perspectiveCorners && perspectiveCorners.length === 4)
      ? buildPerspectiveTransform(perspectiveCorners, photoSize)
      : null
    const rotation = (typeof gridRotation === 'number' && Number.isFinite(gridRotation))
      ? gridRotation : 0

    let gxPhoto, gyPhoto
    if (persp && !persp.isIdentity) {
      // ---- PERSPECTIVE: cursor dest-photo-px → source-photo-px (inverse
      // homography) → snap in source space → forward back to dest. ----
      const sourcePt = persp.inverse({ x: cursorPhotoX, y: cursorPhotoY })
      if (!sourcePt) return null
      const sx = Math.round(sourcePt.x / gxStep) * gxStep
      const sy = Math.round(sourcePt.y / gyStep) * gyStep
      const destPt = persp.forward({ x: sx, y: sy })
      if (!destPt) return null
      gxPhoto = destPt.x
      gyPhoto = destPt.y
    } else if (rotation !== 0) {
      // ---- ROTATION: cursor → unrotated photo space → snap → rotate back. ----
      const center = { x: photoSize.width / 2, y: photoSize.height / 2 }
      const unrot = rotatePoint({ x: cursorPhotoX, y: cursorPhotoY }, center, -rotation)
      const sx = Math.round(unrot.x / gxStep) * gxStep
      const sy = Math.round(unrot.y / gyStep) * gyStep
      const back = rotatePoint({ x: sx, y: sy }, center, rotation)
      gxPhoto = back.x
      gyPhoto = back.y
    } else {
      // ---- AXIS-ALIGNED (existing pre-P16/P38 behavior). ----
      gxPhoto = Math.round(cursorPhotoX / gxStep) * gxStep
      gyPhoto = Math.round(cursorPhotoY / gyStep) * gyStep
    }

    // photo-px → canvas px for the distance test + snap point return.
    const gx = gxPhoto * viewport.zoom + viewport.panX
    const gy = gyPhoto * viewport.zoom + viewport.panY
    const dx = cursorX - gx, dy = cursorY - gy
    if (dx * dx + dy * dy < tolSq) return { x: gx, y: gy, type: 'grid' }
  }

  // 3. CORNER
  let bestDistSq = tolSq
  let bestPt = null
  if (allowCorner) {
    for (const layer of layers) {
      if (!layer.visible) continue
      for (const shape of layer.shapes || []) {
        const corners = getShapeCorners(shape, viewport, photoSize)
        for (const p of corners) {
          const dx = cursorX - p.x, dy = cursorY - p.y
          const d2 = dx * dx + dy * dy
          if (d2 < bestDistSq) { bestDistSq = d2; bestPt = { x: p.x, y: p.y, type: 'corner' } }
        }
      }
    }
    if (bestPt) return bestPt
  }

  // 4. MIDPOINT
  if (allowMidpoint) {
    bestDistSq = tolSq
    for (const layer of layers) {
      if (!layer.visible) continue
      for (const shape of layer.shapes || []) {
        const edges = getShapeEdges(shape, viewport, photoSize)
        for (const [a, b] of edges) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
          const dx = cursorX - mx, dy = cursorY - my
          const d2 = dx * dx + dy * dy
          if (d2 < bestDistSq) { bestDistSq = d2; bestPt = { x: mx, y: my, type: 'midpoint' } }
        }
      }
    }
    if (bestPt) return bestPt
  }

  // 5. CLINE
  if (allowCline && clinesVisible !== false) {
    bestDistSq = tolSq
    for (const cl of clines) {
      if (cl.visible === false) continue
      const proj = projectOntoCline(cursorX, cursorY, cl, viewport, photoSize)
      const dx = cursorX - proj.x, dy = cursorY - proj.y
      const d2 = dx * dx + dy * dy
      if (d2 < bestDistSq) { bestDistSq = d2; bestPt = { x: proj.x, y: proj.y, type: 'cline' } }
    }
  }
  return bestPt
}

export default function CanvasStage() {
  const containerRef = useRef(null)
  const staticCanvasRef = useRef(null)
  const dynamicCanvasRef = useRef(null)
  const tool = useAppStore((s) => s.tool)
  // Spec §9 — context menu state lives at component-level so the JSX can
  // render <ContextMenu> conditionally. The useEffect captures setCtxMenu
  // (stable across renders) to call from inside the contextmenu handler.
  const [ctxMenu, setCtxMenu] = useState(null)

  useEffect(() => {
    const container = containerRef.current
    const cvStatic = staticCanvasRef.current
    const cvDynamic = dynamicCanvasRef.current
    if (!container || !cvStatic || !cvDynamic) return

    const ctxStatic = cvStatic.getContext('2d')
    const ctxDynamic = cvDynamic.getContext('2d')

    // ---- DPR-aware sizing ---------------------------------------------------
    let dpr = window.devicePixelRatio || 1
    const sizeCanvas = (canvas) => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(ch * dpr)
      canvas.style.width = cw + 'px'
      canvas.style.height = ch + 'px'
    }

    let staticDirty = true
    let dynamicDirty = true

    // Drawing-tool draft state (closure-scoped — not in store, not observable
    // from React render). The rAF draw routine reads these directly.
    let draft = null
    let isDragging = false

    // Spec §9 — edit-mode drag state (closure-scoped). Set on mousedown
    // when a handle or body-center is hit; mutated each mousemove via
    // movePoint / moveBody; cleared on mouseup.
    //   mode:        'point' | 'body'
    //   layerId:     id of the layer containing the dragged shape
    //   shapeId:     id of the dragged shape
    //   pointIndex:  for 'point' drag, which handle (0…N-1); for circle,
    //                0 = center, 1 = radius handle
    //   originShape: deep-clone of the shape at drag start; movePoint /
    //                moveBody apply against this so re-drags compose
    //                from the same baseline
    //   originCursor: cursor canvas-px at drag start (for body delta)
    let editDrag = null

    // P34 (May 7 2026) — annotation drag state (closure-scoped). Mirrors
    // editDrag for shapes. Set on EDIT-mode mousedown when a handle / body
    // / new-annotation hit fires; updated on mousemove via updateAnnotation;
    // cleared + (if changed) pushCapturedSnapshot at mouseup.
    //   mode:         'point' (vertex handle) | 'body' (centroid drag)
    //   sequenceId:   active sequence id at drag start
    //   annotationId: target annotation id
    //   field:        'at' | 'tip' | 'tail' | 'a' | 'b'  (point mode only)
    //   originAnno:   deep-cloned annotation at drag start (for body delta
    //                 baseline + Cancel semantics)
    //   originCursor: cursor canvas-px at drag start (for body delta)
    //   preDragSnap:  dataSnapshot string captured at drag start, pushed
    //                 to undoStack on mouseup if anything changed
    let annoDrag = null

    // P16 (May 8 2026) — perspective corner drag state. Set on mousedown
    // when in perspective-edit mode AND the cursor hits one of the 4
    // corner handles. Mirrors editDrag/annoDrag's preDragSnap pattern so
    // Cmd+Z reverts the entire drag as one undo entry.
    //   cornerIndex:  0..3 (TL/TR/BR/BL)
    //   originCorners: deep-clone of the 4 corners at drag start
    //   originCursor:  cursor canvas-px at drag start (unused but kept
    //                  for parity with editDrag/annoDrag)
    //   preDragSnap:   dataSnapshot string captured at drag start
    let perspectiveDrag = null

    // Section 7.A — viewport pan state (closure-scoped). Set when a pan
    // input begins (middle-mouse, space+left, two-finger touch); applies
    // delta to the store viewport on each move; cleared on release.
    //   originCursor: cursor canvas-px at pan start
    //   originPan:    {panX, panY} at pan start
    //   trigger:      'middle' | 'space' | 'touch' (informational)
    let panDrag = null

    // Phase 2 18d (May 11 2026) — Technical Drawing rotation drag state.
    // Closure-scoped (same convention as editDrag, panDrag, etc.). Set on
    // tech-select mousedown when the cursor hits the rotation grip; per-
    // mousemove rotates the originShapes around originCenter and writes
    // back via updateTechnicalShapeNoUndo (no per-pixel undo); cleared
    // on mouseup with one preDragSnap pushed if anything changed.
    //   originShapes: array of deep-cloned selected shapes at drag start
    //   originCenter: pivot point in TECHNICAL world coords
    //   originCursor: cursor canvas-px at drag start (for delta-angle)
    //   preDragSnap:  dataSnapshot string captured at drag start
    let techRotateDrag = null
    // Section 7.A — `Space` (held) acts as a hand tool. `space+leftclick
    // drag` pans the canvas. The flag prevents accidental drawing while
    // the hand tool is engaged.
    let spaceHeld = false
    // Section 7.A — pinch state. `originDist` is the two-finger distance
    // when pinch began; `originZoom` is the viewport zoom at that moment;
    // each move computes a new zoom = originZoom * (currentDist / originDist)
    // anchored at the pinch midpoint.
    let pinch = null

    const resizeAll = () => {
      sizeCanvas(cvStatic)
      sizeCanvas(cvDynamic)
      staticDirty = true
      dynamicDirty = true
      // Section 7.A — handle canvas dims change.
      // P37 (May 7 2026): two branches based on viewportTouchedSinceFit:
      //   - flag === false (operator has NOT manually panned/zoomed
      //     since last fit): auto-fit to the new canvas dims via
      //     fitToViewport, which preserves the flag at false.
      //   - flag === true (operator has manually panned/zoomed):
      //     preserve their viewport — only do the protective clamp
      //     (raise zoom to fit-floor + clamp pan to keep ≥10% of photo
      //     visible) so the canvas isn't visually broken at very small
      //     sizes.
      // The ResizeObserver on container (below) catches both window
      // resizes AND toolbar-wrap canvas-area-height changes (which
      // don't fire window.resize); both route through this same path.
      const s = useAppStore.getState()
      if (!s.photoMeta) return
      const cw = container.clientWidth
      const ch = container.clientHeight
      if (!cw || !ch) return
      if (!s.viewportTouchedSinceFit) {
        useAppStore.getState().fitToViewport(cw, ch)
        return
      }
      // Operator-touched branch: protective clamp only, never auto-fit.
      const fit = computeFitViewport({ width: s.photoMeta.width, height: s.photoMeta.height }, cw, ch)
      const v = s.viewport || DEFAULT_VIEWPORT_LOCAL
      let nextZoom = v.zoom
      if (nextZoom < fit.zoom) nextZoom = fit.zoom
      const nextPan = clampPan(
        { ...v, zoom: nextZoom },
        { width: s.photoMeta.width, height: s.photoMeta.height },
        cw, ch,
      )
      if (nextZoom !== v.zoom || nextPan.panX !== v.panX || nextPan.panY !== v.panY) {
        useAppStore.getState().setViewport({ zoom: nextZoom, panX: nextPan.panX, panY: nextPan.panY })
      }
    }
    // Default viewport literal for closure (matches store's DEFAULT_VIEWPORT
    // — kept inline to avoid an extra import).
    const DEFAULT_VIEWPORT_LOCAL = { panX: 0, panY: 0, zoom: 1 }
    resizeAll()

    const ro = new ResizeObserver(resizeAll)
    ro.observe(container)
    window.addEventListener('resize', resizeAll)

    // ---- Annotation + shape rendering ---------------------------------
    // Step 16 (May 8 2026) — render helpers extracted to src/utils/
    // canvasRender.js so the PDF generator (src/utils/generatePDF.js) can
    // share the exact same render path. Single source of truth means no
    // drift risk between the live canvas and the PDF output. The closure-
    // local aliases below preserve the existing call shape inside drawStatic.
    const drawAnnotationOnContext = drawAnnotationOnContextShared
    const drawShapeOnContext = drawShapeOnContextShared

    // ---- Static draw -------------------------------------------------------
    // Section 7.A — viewport-onto-photo render. The PHOTO is drawn at
    // (panX, panY, photoW * zoom, photoH * zoom). Everything that lives
    // in photo-normalized coords (shapes, clines, annotations, grid) is
    // translated to canvas px through the same viewport. The CANVAS is
    // the window the operator looks through; the PHOTO is the world.
    const drawStatic = () => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      ctxStatic.save()
      ctxStatic.setTransform(1, 0, 0, 1, 0, 0)
      ctxStatic.clearRect(0, 0, cvStatic.width, cvStatic.height)
      ctxStatic.scale(dpr, dpr)

      const storeState = useAppStore.getState()
      const viewport = storeState.viewport || { panX: 0, panY: 0, zoom: 1 }
      const photoSize = effectivePhotoSize(storeState.photoMeta, cw, ch)
      const bg = storeState.backgroundImage

      // Always paint dark canvas-area first so out-of-photo regions read
      // as "outside the world" rather than as garbage from prior frames.
      ctxStatic.fillStyle = '#0d1117'
      ctxStatic.fillRect(0, 0, cw, ch)

      // Phase 2 18a/18b (May 10 2026) — Technical Drawing render path.
      // 18a left this as an early-return after the dark background fill.
      // 18b paints any committed line shapes from state.technicalLayers
      // before returning. Field Markup content (photo, layers, clines,
      // annotations, perspective handles) is suppressed under TECHNICAL.
      // Grid drawing skipped — operators have no shapes to align to in
      // the dimensional-CAD sense (18c+ may add a tech-only grid).
      if (storeState.appMode === 'TECHNICAL') {
        const techV = storeState.viewports?.TECHNICAL || { panX: 0, panY: 0, zoom: 1 }
        const techZoom = techV.zoom || 1
        // 18b: render each visible technical layer's line shapes.
        // Stroke color is a neutral mid-gray for 18b; 18c+ may add
        // per-layer color and per-shape override.
        const TECH_STROKE = '#9ca3af'
        // Phase 2 18d — selected shapes render in KCC orange (matches
        // --rm-orange in App.css) so selection state is unambiguous at
        // a glance. Stroke color flips per-shape inside the inner loop;
        // unselected shapes keep the neutral mid-gray.
        const TECH_STROKE_SELECTED = '#e8531a'
        const TECH_LABEL_FONT = '11px sans-serif'
        ctxStatic.lineWidth = 2
        ctxStatic.font = TECH_LABEL_FONT
        const techSel = storeState.techSelected || []
        for (const tl of storeState.technicalLayers || []) {
          if (tl.visible === false) continue
          for (const sh of tl.shapes || []) {
            if (sh.type !== 'line') continue
            const isSelected = techSel.some(
              (s) => s.layerId === tl.id && s.shapeId === sh.id
            )
            const strokeColor = isSelected ? TECH_STROKE_SELECTED : TECH_STROKE
            ctxStatic.strokeStyle = strokeColor
            ctxStatic.fillStyle = strokeColor
            // Transform world coords → canvas px via TECHNICAL viewport.
            const ax = sh.a.x * techZoom + techV.panX
            const ay = sh.a.y * techZoom + techV.panY
            const bx = sh.b.x * techZoom + techV.panX
            const by = sh.b.y * techZoom + techV.panY
            ctxStatic.beginPath()
            ctxStatic.moveTo(ax, ay)
            ctxStatic.lineTo(bx, by)
            ctxStatic.stroke()
            // Length label at midpoint, offset perpendicular to the
            // stroke by 8px so it doesn't overlap the line. Whole inches
            // render without decimal; non-whole render to one decimal.
            const mx = (ax + bx) / 2
            const my = (ay + by) / 2
            const dx = bx - ax
            const dy = by - ay
            const dist = Math.hypot(dx, dy)
            const nx = dist > 0 ? -dy / dist : 0
            const ny = dist > 0 ?  dx / dist : -1
            const lx = mx + nx * 8
            const ly = my + ny * 8
            const v = sh.lengthInches
            const label = Number.isInteger(v) ? `${v}"` : `${v.toFixed(1)}"`
            ctxStatic.textAlign = 'center'
            ctxStatic.textBaseline = 'middle'
            ctxStatic.fillText(label, lx, ly)
          }
        }
        ctxStatic.restore()
        return
      }

      if (bg && bg.complete && bg.naturalWidth > 0) {
        // Section 7.A.2 — photo at viewport coordinates. drawImage clamps
        // outside the canvas naturally; no manual clipping needed.
        const drawW = photoSize.width * viewport.zoom
        const drawH = photoSize.height * viewport.zoom
        ctxStatic.drawImage(bg, viewport.panX, viewport.panY, drawW, drawH)
      } else {
        // Pre-photo / no-photo fallback: a 40-px dark grid as a visible
        // canvas surface so the operator can draft markup before loading
        // a photo (existing pre-§7.A behavior).
        ctxStatic.strokeStyle = '#1a1f2e'
        ctxStatic.lineWidth = 1
        for (let x = 0; x < cw; x += 40) {
          ctxStatic.beginPath()
          ctxStatic.moveTo(x + 0.5, 0)
          ctxStatic.lineTo(x + 0.5, ch)
          ctxStatic.stroke()
        }
        for (let y = 0; y < ch; y += 40) {
          ctxStatic.beginPath()
          ctxStatic.moveTo(0, y + 0.5)
          ctxStatic.lineTo(cw, y + 0.5)
          ctxStatic.stroke()
        }
      }

      // Spec §7 step 3 — snap grid overlay when gridEnabled. Section 7.A —
      // grid lives in PHOTO px. P16 + P38 (May 8 2026) — three branches:
      //   1. perspective active (corners != null AND not at default bounds)
      //      → grid lines transform through homography from source-rect
      //        space (0..photoW, 0..photoH) to dest-quad photo-px, then
      //        photo-px → canvas-px via existing viewport math
      //   2. rotation != 0 → rotate each photo-px endpoint about the photo
      //      center (0.5, 0.5 normalized) before photo-px → canvas-px
      //   3. neither → existing axis-aligned path (unchanged)
      // Per Option Y (locked May 8 2026): perspective dominates rotation
      // when both are set. Rotation field is preserved in store but
      // ignored at render+snap time when perspective corners are active.
      if (storeState.gridEnabled) {
        const gs = storeState.gridSize
        const gxStep = (typeof gs === 'object' ? gs.x : gs) || 20
        const gyStep = (typeof gs === 'object' ? gs.y : gs) || 20
        const z = viewport.zoom || 1
        const gridOpacity = typeof storeState.gridOpacity === 'number' ? storeState.gridOpacity : 0.16
        ctxStatic.strokeStyle = `rgba(0, 255, 204, ${gridOpacity})`
        ctxStatic.lineWidth = 1

        const corners = storeState.perspectiveCorners
        const persp = (corners && corners.length === 4)
          ? buildPerspectiveTransform(corners, photoSize)
          : null
        const rotation = (typeof storeState.gridRotation === 'number' && Number.isFinite(storeState.gridRotation))
          ? storeState.gridRotation : 0

        // Helper: photo-px → canvas-px
        const toCanvas = (p) => ({ x: p.x * z + viewport.panX, y: p.y * z + viewport.panY })

        if (persp && !persp.isIdentity) {
          // ---- BRANCH 1: PERSPECTIVE GRID ----
          // Clip to dest quadrilateral so grid lines don't extend beyond
          // the operator's marked roof rectangle.
          ctxStatic.save()
          ctxStatic.beginPath()
          const d0 = toCanvas(persp.destCornersPx[0])
          const d1 = toCanvas(persp.destCornersPx[1])
          const d2 = toCanvas(persp.destCornersPx[2])
          const d3 = toCanvas(persp.destCornersPx[3])
          ctxStatic.moveTo(d0.x, d0.y)
          ctxStatic.lineTo(d1.x, d1.y)
          ctxStatic.lineTo(d2.x, d2.y)
          ctxStatic.lineTo(d3.x, d3.y)
          ctxStatic.closePath()
          ctxStatic.clip()

          // Vertical lines: in source space, x = k * gxStep, y from 0 to photoH
          for (let xPhoto = 0; xPhoto <= photoSize.width; xPhoto += gxStep) {
            const a = persp.forward({ x: xPhoto, y: 0 })
            const b = persp.forward({ x: xPhoto, y: photoSize.height })
            if (!a || !b) continue
            const ac = toCanvas(a), bc = toCanvas(b)
            ctxStatic.beginPath()
            ctxStatic.moveTo(ac.x, ac.y)
            ctxStatic.lineTo(bc.x, bc.y)
            ctxStatic.stroke()
          }
          // Horizontal lines: y = k * gyStep
          for (let yPhoto = 0; yPhoto <= photoSize.height; yPhoto += gyStep) {
            const a = persp.forward({ x: 0, y: yPhoto })
            const b = persp.forward({ x: photoSize.width, y: yPhoto })
            if (!a || !b) continue
            const ac = toCanvas(a), bc = toCanvas(b)
            ctxStatic.beginPath()
            ctxStatic.moveTo(ac.x, ac.y)
            ctxStatic.lineTo(bc.x, bc.y)
            ctxStatic.stroke()
          }
          ctxStatic.restore()
        } else if (rotation !== 0) {
          // ---- BRANCH 2: ROTATED GRID ----
          // Rotate each photo-px endpoint about the photo center.
          const center = { x: photoSize.width / 2, y: photoSize.height / 2 }
          // Pre-compute extent — rotated grid lines need to span far
          // enough to cover the canvas under any rotation. Use a
          // diagonal-of-photo length to be safe.
          const ext = Math.hypot(photoSize.width, photoSize.height) * 1.5
          // Vertical lines (in unrotated space): x = k*gxStep
          for (let xPhoto = 0; xPhoto <= photoSize.width; xPhoto += gxStep) {
            const a = rotatePoint({ x: xPhoto, y: -ext }, center, rotation)
            const b = rotatePoint({ x: xPhoto, y: photoSize.height + ext }, center, rotation)
            const ac = toCanvas(a), bc = toCanvas(b)
            ctxStatic.beginPath()
            ctxStatic.moveTo(ac.x, ac.y)
            ctxStatic.lineTo(bc.x, bc.y)
            ctxStatic.stroke()
          }
          for (let yPhoto = 0; yPhoto <= photoSize.height; yPhoto += gyStep) {
            const a = rotatePoint({ x: -ext, y: yPhoto }, center, rotation)
            const b = rotatePoint({ x: photoSize.width + ext, y: yPhoto }, center, rotation)
            const ac = toCanvas(a), bc = toCanvas(b)
            ctxStatic.beginPath()
            ctxStatic.moveTo(ac.x, ac.y)
            ctxStatic.lineTo(bc.x, bc.y)
            ctxStatic.stroke()
          }
        } else {
          // ---- BRANCH 3: AXIS-ALIGNED (existing pre-P16/P38 behavior) ----
          const photoX0 = Math.max(0, (-viewport.panX) / z)
          const photoX1 = Math.min(photoSize.width,  (cw - viewport.panX) / z)
          const photoY0 = Math.max(0, (-viewport.panY) / z)
          const photoY1 = Math.min(photoSize.height, (ch - viewport.panY) / z)
          const startX = Math.ceil(photoX0 / gxStep) * gxStep
          for (let xPhoto = startX; xPhoto <= photoX1; xPhoto += gxStep) {
            const x = xPhoto * z + viewport.panX
            ctxStatic.beginPath()
            ctxStatic.moveTo(x + 0.5, 0)
            ctxStatic.lineTo(x + 0.5, ch)
            ctxStatic.stroke()
          }
          const startY = Math.ceil(photoY0 / gyStep) * gyStep
          for (let yPhoto = startY; yPhoto <= photoY1; yPhoto += gyStep) {
            const y = yPhoto * z + viewport.panY
            ctxStatic.beginPath()
            ctxStatic.moveTo(0, y + 0.5)
            ctxStatic.lineTo(cw, y + 0.5)
            ctxStatic.stroke()
          }
        }

        // P16 — when perspective corners are set (whether identity or
        // not), paint a subtle dotted outline of the 4-corner quad on
        // the static canvas so the operator sees the anchored plane
        // even when grid is off OR when corners ARE at default bounds.
        if (corners && corners.length === 4) {
          const persp2 = persp || buildPerspectiveTransform(corners, photoSize)
          if (persp2) {
            ctxStatic.save()
            ctxStatic.strokeStyle = 'rgba(232, 83, 26, 0.55)' // KCC orange
            ctxStatic.setLineDash([4, 3])
            ctxStatic.lineWidth = 1.5
            ctxStatic.beginPath()
            const c0 = toCanvas(persp2.destCornersPx[0])
            const c1 = toCanvas(persp2.destCornersPx[1])
            const c2 = toCanvas(persp2.destCornersPx[2])
            const c3 = toCanvas(persp2.destCornersPx[3])
            ctxStatic.moveTo(c0.x, c0.y)
            ctxStatic.lineTo(c1.x, c1.y)
            ctxStatic.lineTo(c2.x, c2.y)
            ctxStatic.lineTo(c3.x, c3.y)
            ctxStatic.closePath()
            ctxStatic.stroke()
            ctxStatic.restore()
          }
        }
      }

      // Construction lines — translated through the viewport. Angled
      // clines use a sentinel-length endpoint pair so the browser clips.
      if (storeState.clinesVisible !== false) {
        ctxStatic.strokeStyle = 'rgba(0, 255, 204, 0.5)'
        ctxStatic.lineWidth = 1
        ctxStatic.setLineDash([6, 4])
        for (const cl of storeState.clines) {
          if (cl.visible === false) continue
          if (cl.type === 'h') {
            const y = cl.y * photoSize.height * viewport.zoom + viewport.panY
            ctxStatic.beginPath()
            ctxStatic.moveTo(0, y)
            ctxStatic.lineTo(cw, y)
            ctxStatic.stroke()
          } else if (cl.type === 'v') {
            const x = cl.x * photoSize.width * viewport.zoom + viewport.panX
            ctxStatic.beginPath()
            ctxStatic.moveTo(x, 0)
            ctxStatic.lineTo(x, ch)
            ctxStatic.stroke()
          } else if (cl.type === 'a') {
            const a = photoNormToCanvas({ x: cl.px, y: cl.py }, viewport, photoSize)
            const cosA = Math.cos(cl.angle)
            const sinA = Math.sin(cl.angle)
            ctxStatic.beginPath()
            ctxStatic.moveTo(a.x - CLINE_SENT * cosA, a.y - CLINE_SENT * sinA)
            ctxStatic.lineTo(a.x + CLINE_SENT * cosA, a.y + CLINE_SENT * sinA)
            ctxStatic.stroke()
          }
        }
        ctxStatic.setLineDash([])
      }

      // Layer shapes (bottom to top, skipping invisible layers).
      // Step 11 — SEQUENCE-mode per-sequence visibility filter. Section
      // 7.A — render through viewport.
      const layers = storeState.layers
      const seqFilter = (storeState.mode === 'SEQUENCE' && storeState.activeSeqId)
        ? (storeState.sequences.find((s) => s.id === storeState.activeSeqId)?.layers || {})
        : null
      for (const layer of layers) {
        if (!layer.visible) continue
        if (seqFilter && seqFilter[layer.id] === false) continue
        for (const shape of layer.shapes || []) {
          drawShapeOnContext(ctxStatic, shape, viewport, photoSize, layer)
        }
      }

      // Step 12 — annotations from the active sequence rendered through
      // the viewport (so they pan/zoom with the photo).
      const activeSeq = storeState.activeSeqId
        ? storeState.sequences.find((s) => s.id === storeState.activeSeqId)
        : null
      if (activeSeq && Array.isArray(activeSeq.annotations)) {
        for (const a of activeSeq.annotations) drawAnnotationOnContext(ctxStatic, a, viewport, photoSize, activeSeq)
      }

      // Step 13 — annotation selection highlight (white ring around the
      // primary anchor of the panel-selected annotation). Painted on top
      // so it sits above the annotation itself.
      // P34 (May 7 2026) — when in EDIT mode, the white ring is replaced
      // by drag handles (vertex dots + body-center crosshair if
      // applicable). The ring stays for non-EDIT modes (panel-driven
      // selection in SEQUENCE mode is just a "this is highlighted"
      // marker, not draggable). Static canvas paints the ring; dynamic
      // canvas paints the handles (handles re-render on every animation
      // frame so they track during drag).
      const selAnno = storeState.selectedAnnotation
      if (selAnno && activeSeq && selAnno.sequenceId === activeSeq.id && storeState.mode !== 'EDIT') {
        const a = (activeSeq.annotations || []).find((x) => x.id === selAnno.annotationId)
        if (a) {
          let anchor = null
          if (a.type === 'note') anchor = a.at
          else if (a.type === 'callout') anchor = a.tail
          else if (a.type === 'dimline') anchor = { x: (a.a.x + a.b.x) / 2, y: (a.a.y + a.b.y) / 2 }
          if (anchor) {
            const c = photoNormToCanvas(anchor, viewport, photoSize)
            ctxStatic.save()
            ctxStatic.strokeStyle = '#ffffff'
            ctxStatic.lineWidth = 2.5
            ctxStatic.beginPath()
            ctxStatic.arc(c.x, c.y, 12, 0, Math.PI * 2)
            ctxStatic.stroke()
            ctxStatic.restore()
          }
        }
      }

      // Spec §9 — selected shape outline (white, +1 stroke weight). Render
      // through viewport so it tracks the underlying shape.
      const sel = storeState.selected
      if (sel) {
        const layer = layers.find((l) => l.id === sel.layerId)
        const shape = layer?.visible
          ? (layer.shapes || []).find((sh) => sh.id === sel.shapeId)
          : null
        if (shape) {
          ctxStatic.strokeStyle = '#ffffff'
          ctxStatic.lineWidth = (layer.strokeWeight || 2) + 1
          ctxStatic.globalAlpha = 1
          const tx = (p) => photoNormToCanvas(p, viewport, photoSize)
          if (shape.type === 'circ') {
            const c = tx({ x: shape.cx, y: shape.cy })
            const rPx = shape.r * photoSize.width * viewport.zoom
            ctxStatic.beginPath()
            ctxStatic.arc(c.x, c.y, rPx, 0, Math.PI * 2)
            ctxStatic.stroke()
          } else if (shape.type === 'line' && shape.pts && shape.pts.length === 2) {
            const a = tx(shape.pts[0]), b = tx(shape.pts[1])
            ctxStatic.beginPath()
            ctxStatic.moveTo(a.x, a.y)
            ctxStatic.lineTo(b.x, b.y)
            ctxStatic.stroke()
          } else if (shape.type === 'arc' && shape.pts && shape.pts.length >= 3) {
            // P6 — selected-arc outline mirrors render path.
            const a = tx(shape.pts[0])
            const b = tx(shape.pts[1])
            const c = tx(shape.pts[2])
            const cc = arcCircumcircle(a, b, c)
            ctxStatic.beginPath()
            if (cc) {
              const { startAngle, endAngle, anticlockwise } = arcAnglesFor(a, b, c, cc.cx, cc.cy)
              ctxStatic.arc(cc.cx, cc.cy, cc.r, startAngle, endAngle, anticlockwise)
            } else {
              ctxStatic.moveTo(a.x, a.y)
              ctxStatic.lineTo(b.x, b.y)
              ctxStatic.lineTo(c.x, c.y)
            }
            ctxStatic.stroke()
          } else if (shape.type === 'ellipse' && shape.pts && shape.pts.length >= 2) {
            // P6 — selected-ellipse outline.
            const a = tx(shape.pts[0])
            const b = tx(shape.pts[1])
            const { cx, cy, rx, ry } = ellipseParams(a, b)
            if (rx > 0 && ry > 0) {
              ctxStatic.beginPath()
              ctxStatic.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
              ctxStatic.stroke()
            }
          } else if (shape.pts && shape.pts.length >= 2) {
            ctxStatic.beginPath()
            shape.pts.forEach((p, i) => {
              const c = tx(p)
              if (i === 0) ctxStatic.moveTo(c.x, c.y)
              else ctxStatic.lineTo(c.x, c.y)
            })
            ctxStatic.closePath()
            ctxStatic.stroke()
          }
        }
      }
      ctxStatic.restore()
    }

    // ---- Dynamic draw (rubber-band + crosshair) ----------------------------
    const drawDynamic = () => {
      const state = useAppStore.getState()
      ctxDynamic.save()
      ctxDynamic.setTransform(1, 0, 0, 1, 0, 0)
      ctxDynamic.clearRect(0, 0, cvDynamic.width, cvDynamic.height)
      ctxDynamic.scale(dpr, dpr)

      // Phase 2 18a/18b/18c — Technical Drawing dynamic render.
      // Rubber-band line preview with independent typed-vs-freehand
      // length and angle. The preview must match the commit math
      // exactly so the operator sees what they'll get.
      //
      //   length: typedInches if set, else cursor distance (rounded 0.5")
      //   angle:  typedAngleDegrees if set, else cursor direction
      //
      // Midpoint label shows both `length" @ angle°` when an angle is
      // either typed or non-zero from freehand; just `length"` for
      // horizontal freehand draws so the label stays clean.
      if (state.appMode === 'TECHNICAL') {
        const draft = state.techDraft
        if (draft && draft.a && state.tool === 'tech-line') {
          const techV = state.viewports?.TECHNICAL || { panX: 0, panY: 0, zoom: 1 }
          const techZoom = techV.zoom || 1
          // Cursor world coords (canvas px → world via TECHNICAL viewport).
          const cursorW = {
            x: (state.cursorX - techV.panX) / techZoom,
            y: (state.cursorY - techV.panY) / techZoom,
          }
          const dxC = cursorW.x - draft.a.x
          const dyC = cursorW.y - draft.a.y
          const cursorDist = Math.hypot(dxC, dyC)
          const cursorAngleRad = Math.atan2(dyC, dxC)
          // Effective length: typed if set, else cursor distance rounded.
          const effInches = (typeof draft.typedInches === 'number' && draft.typedInches > 0)
            ? draft.typedInches
            : Math.round((cursorDist / PX_PER_INCH) * 2) / 2
          // Effective angle: typed if set, else cursor direction. typed
          // angle is canvas-Y-down degrees so it composes directly with
          // atan2 without negation.
          const effAngleRad = (typeof draft.typedAngleDegrees === 'number'
            && Number.isFinite(draft.typedAngleDegrees))
            ? (draft.typedAngleDegrees * Math.PI) / 180
            : cursorAngleRad
          const pxDistance = effInches * PX_PER_INCH
          const bW = {
            x: draft.a.x + Math.cos(effAngleRad) * pxDistance,
            y: draft.a.y + Math.sin(effAngleRad) * pxDistance,
          }
          // World coords → canvas px.
          const ax = draft.a.x * techZoom + techV.panX
          const ay = draft.a.y * techZoom + techV.panY
          const bx = bW.x * techZoom + techV.panX
          const by = bW.y * techZoom + techV.panY
          ctxDynamic.save()
          ctxDynamic.strokeStyle = '#9ca3af'
          ctxDynamic.fillStyle = '#9ca3af'
          ctxDynamic.lineWidth = 2
          ctxDynamic.setLineDash([6, 4])
          ctxDynamic.beginPath()
          ctxDynamic.moveTo(ax, ay)
          ctxDynamic.lineTo(bx, by)
          ctxDynamic.stroke()
          ctxDynamic.setLineDash([])
          // Midpoint label with optional angle suffix. Angle shown when
          // typed (operator's locked intent is worth surfacing) OR when
          // the freehand angle is non-trivial (>= 1° off horizontal so
          // the label doesn't clutter horizontal freehand draws).
          if (effInches > 0) {
            const mx = (ax + bx) / 2
            const my = (ay + by) / 2
            const ddx = bx - ax
            const ddy = by - ay
            const dC = Math.hypot(ddx, ddy)
            const nx = dC > 0 ? -ddy / dC : 0
            const ny = dC > 0 ?  ddx / dC : -1
            const lx = mx + nx * 8
            const ly = my + ny * 8
            const lenStr = Number.isInteger(effInches) ? `${effInches}"` : `${effInches.toFixed(1)}"`
            const angleDeg = (effAngleRad * 180) / Math.PI
            const showAngle = (typeof draft.typedAngleDegrees === 'number')
              || Math.abs(angleDeg) >= 1
            let label
            if (showAngle) {
              const angRounded = Math.round(angleDeg * 10) / 10
              const angStr = Number.isInteger(angRounded) ? `${angRounded}°` : `${angRounded.toFixed(1)}°`
              label = `${lenStr} @ ${angStr}`
            } else {
              label = lenStr
            }
            ctxDynamic.font = '11px sans-serif'
            ctxDynamic.textAlign = 'center'
            ctxDynamic.textBaseline = 'middle'
            ctxDynamic.fillText(label, lx, ly)
          }
          ctxDynamic.restore()
        }

        // Phase 2 18d — rotation grip render. Independent of the tech-line
        // rubber-band above. Fires whenever selection is non-empty
        // (regardless of active tool — operator can switch from
        // tech-select to tech-line and the grip stays visible until
        // selection clears, which is intentional: the grip is a
        // selection-state affordance, not a tool affordance). Renders
        // at the centroid (single-select) or bbox centroid (multi).
        // KCC orange filled ring + white border + small black crosshair
        // inside so the operator can see the exact pivot point.
        const techSelDraw = state.techSelected || []
        if (techSelDraw.length > 0) {
          const techVD = state.viewports?.TECHNICAL || { panX: 0, panY: 0, zoom: 1 }
          const techZoomD = techVD.zoom || 1
          const shapesD = getSelectedTechShapes(state.technicalLayers, techSelDraw)
          if (shapesD.length > 0) {
            const centerD = techSelDraw.length === 1
              ? techShapeCentroid(shapesD[0])
              : techMultiShapeCentroid(shapesD)
            if (centerD) {
              const cxD = centerD.x * techZoomD + techVD.panX
              const cyD = centerD.y * techZoomD + techVD.panY
              ctxDynamic.save()
              ctxDynamic.fillStyle = '#e8531a'
              ctxDynamic.strokeStyle = '#ffffff'
              ctxDynamic.lineWidth = 1.5
              ctxDynamic.beginPath()
              ctxDynamic.arc(cxD, cyD, 8, 0, Math.PI * 2)
              ctxDynamic.fill()
              ctxDynamic.stroke()
              // Inner crosshair (white on orange) for precise pivot reading.
              ctxDynamic.strokeStyle = '#ffffff'
              ctxDynamic.lineWidth = 1
              ctxDynamic.beginPath()
              ctxDynamic.moveTo(cxD - 4, cyD + 0.5)
              ctxDynamic.lineTo(cxD + 4, cyD + 0.5)
              ctxDynamic.moveTo(cxD + 0.5, cyD - 4)
              ctxDynamic.lineTo(cxD + 0.5, cyD + 4)
              ctxDynamic.stroke()
              ctxDynamic.restore()
            }
          }
        }

        ctxDynamic.restore()
        return
      }

      // Rubber-band preview from draft state
      if (draft) {
        const layer = state.layers.find((l) => l.id === state.activeLayerId)
        const previewColor = layer?.color || '#3fb950'
        ctxDynamic.setLineDash([6, 4])
        ctxDynamic.strokeStyle = previewColor
        ctxDynamic.fillStyle = previewColor
        ctxDynamic.lineWidth = 2

        if (draft.type === 'poly' || draft.type === 'tri') {
          const pts = draft.pts
          if (pts.length > 0) {
            ctxDynamic.beginPath()
            ctxDynamic.moveTo(pts[0].x, pts[0].y)
            for (let i = 1; i < pts.length; i++) ctxDynamic.lineTo(pts[i].x, pts[i].y)
            ctxDynamic.lineTo(state.cursorX, state.cursorY)
            ctxDynamic.stroke()
            ctxDynamic.setLineDash([])
            for (const p of pts) {
              ctxDynamic.beginPath()
              ctxDynamic.arc(p.x, p.y, 3, 0, Math.PI * 2)
              ctxDynamic.fill()
            }
          }
        } else if (draft.type === 'arc') {
          // P6 — 3-click arc draft. After click 1: rubber-band line to
          // cursor. After click 2: live circumcircle through pts[0],
          // pts[1], cursor. Third click commits via commitDraft.
          const pts = draft.pts
          if (pts.length === 1) {
            ctxDynamic.beginPath()
            ctxDynamic.moveTo(pts[0].x, pts[0].y)
            ctxDynamic.lineTo(state.cursorX, state.cursorY)
            ctxDynamic.stroke()
          } else if (pts.length === 2) {
            const cursor = { x: state.cursorX, y: state.cursorY }
            const cc = arcCircumcircle(pts[0], pts[1], cursor)
            if (cc) {
              const { startAngle, endAngle, anticlockwise } = arcAnglesFor(pts[0], pts[1], cursor, cc.cx, cc.cy)
              ctxDynamic.beginPath()
              ctxDynamic.arc(cc.cx, cc.cy, cc.r, startAngle, endAngle, anticlockwise)
              ctxDynamic.stroke()
            } else {
              ctxDynamic.beginPath()
              ctxDynamic.moveTo(pts[0].x, pts[0].y)
              ctxDynamic.lineTo(pts[1].x, pts[1].y)
              ctxDynamic.lineTo(cursor.x, cursor.y)
              ctxDynamic.stroke()
            }
          }
          ctxDynamic.setLineDash([])
          for (const p of pts) {
            ctxDynamic.beginPath()
            ctxDynamic.arc(p.x, p.y, 3, 0, Math.PI * 2)
            ctxDynamic.fill()
          }
        } else if (draft.type === 'rect' && isDragging) {
          ctxDynamic.strokeRect(
            draft.startX,
            draft.startY,
            draft.x - draft.startX,
            draft.y - draft.startY
          )
        } else if (draft.type === 'ellipse' && isDragging) {
          // P6 — bounding-box ellipse draft. Drag from start to cursor;
          // ellipse is inscribed in the rectangle.
          const cx = (draft.startX + draft.x) / 2
          const cy = (draft.startY + draft.y) / 2
          const rx = Math.abs(draft.x - draft.startX) / 2
          const ry = Math.abs(draft.y - draft.startY) / 2
          if (rx > 0 && ry > 0) {
            ctxDynamic.beginPath()
            ctxDynamic.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
            ctxDynamic.stroke()
          }
        } else if (draft.type === 'circ' && isDragging) {
          ctxDynamic.beginPath()
          ctxDynamic.arc(draft.cx, draft.cy, draft.r, 0, Math.PI * 2)
          ctxDynamic.stroke()
        } else if (draft.type === 'line' && draft.pts.length === 1) {
          ctxDynamic.beginPath()
          ctxDynamic.moveTo(draft.pts[0].x, draft.pts[0].y)
          ctxDynamic.lineTo(state.cursorX, state.cursorY)
          ctxDynamic.stroke()
        } else if (draft.type === 'cline' && isDragging) {
          // Rubber-band preview categorized like the eventual commit
          const cw = container.clientWidth
          const ch = container.clientHeight
          const dx = draft.x - draft.startX
          const dy = draft.y - draft.startY
          ctxDynamic.beginPath()
          if (Math.abs(dy) < ORTHO_TOL) {
            ctxDynamic.moveTo(0, draft.startY)
            ctxDynamic.lineTo(cw, draft.startY)
          } else if (Math.abs(dx) < ORTHO_TOL) {
            ctxDynamic.moveTo(draft.startX, 0)
            ctxDynamic.lineTo(draft.startX, ch)
          } else {
            const ang = Math.atan2(dy, dx)
            const cosA = Math.cos(ang)
            const sinA = Math.sin(ang)
            ctxDynamic.moveTo(draft.startX - CLINE_SENT * cosA, draft.startY - CLINE_SENT * sinA)
            ctxDynamic.lineTo(draft.startX + CLINE_SENT * cosA, draft.startY + CLINE_SENT * sinA)
          }
          ctxDynamic.stroke()
        } else if (draft.type === 'callout' && draft.tip) {
          // Step 12 — rubber-band lead line tip → cursor for callout
          ctxDynamic.strokeStyle = '#f5a623'
          ctxDynamic.lineWidth = 1.5
          ctxDynamic.beginPath()
          ctxDynamic.moveTo(draft.tip.x, draft.tip.y)
          ctxDynamic.lineTo(state.cursorX, state.cursorY)
          ctxDynamic.stroke()
          // Tip diamond
          ctxDynamic.beginPath()
          ctxDynamic.moveTo(draft.tip.x, draft.tip.y - 5)
          ctxDynamic.lineTo(draft.tip.x + 5, draft.tip.y)
          ctxDynamic.lineTo(draft.tip.x, draft.tip.y + 5)
          ctxDynamic.lineTo(draft.tip.x - 5, draft.tip.y)
          ctxDynamic.closePath()
          ctxDynamic.fillStyle = '#f5a623'
          ctxDynamic.fill()
        } else if (draft.type === 'dimline' && draft.a) {
          // Step 12 — rubber-band measurement line a → cursor
          ctxDynamic.strokeStyle = '#f5a623'
          ctxDynamic.lineWidth = 1.5
          ctxDynamic.beginPath()
          ctxDynamic.moveTo(draft.a.x, draft.a.y)
          ctxDynamic.lineTo(state.cursorX, state.cursorY)
          ctxDynamic.stroke()
        }
        ctxDynamic.setLineDash([])
      }

      // Spec §9 — selection handles when in EDIT mode with a selection.
      // Section 7.A — translate handle positions through viewport so they
      // track the shape under pan/zoom.
      if (state.mode === 'EDIT' && state.selected) {
        const sel = state.selected
        const layer = state.layers.find((l) => l.id === sel.layerId)
        const shape = layer?.visible
          ? (layer.shapes || []).find((sh) => sh.id === sel.shapeId)
          : null
        if (shape) {
          const layerColor = layer.color || '#3b82f6'
          const cwLocal = container.clientWidth
          const chLocal = container.clientHeight
          const ps = effectivePhotoSize(state.photoMeta, cwLocal, chLocal)
          // Point handles
          const handles = shapeHandlePoints(shape, state.viewport, ps)
          for (const p of handles) {
            ctxDynamic.fillStyle = layerColor
            ctxDynamic.strokeStyle = '#ffffff'
            ctxDynamic.lineWidth = 1.5
            ctxDynamic.beginPath()
            ctxDynamic.arc(p.x, p.y, 5, 0, Math.PI * 2)
            ctxDynamic.fill()
            ctxDynamic.stroke()
          }
          // Body center handle (only for non-circle, since circle's pt[0] IS center)
          if (shape.type !== 'circ') {
            const c = shapeCentroid(shape, state.viewport, ps)
            if (c) {
              ctxDynamic.strokeStyle = '#ffffff'
              ctxDynamic.lineWidth = 1.5
              ctxDynamic.beginPath()
              ctxDynamic.arc(c.x, c.y, 8, 0, Math.PI * 2)
              ctxDynamic.stroke()
              ctxDynamic.beginPath()
              ctxDynamic.moveTo(c.x - 5, c.y + 0.5)
              ctxDynamic.lineTo(c.x + 5, c.y + 0.5)
              ctxDynamic.moveTo(c.x + 0.5, c.y - 5)
              ctxDynamic.lineTo(c.x + 0.5, c.y + 5)
              ctxDynamic.stroke()
            }
          }
        }
      }

      // P34 (May 7 2026) — annotation selection handles in EDIT mode.
      // Mirrors the shape handles block above. Renders only when:
      //   - mode === 'EDIT'
      //   - selectedAnnotation is set AND points at an annotation in the
      //     active sequence (cross-sequence selection is impossible —
      //     setActiveSequence clears selectedAnnotation)
      // Handle layout per type (canvas-px coords from photoNormToCanvas):
      //   note    — 1 dot at .at
      //   callout — 2 dots at .tip + .tail PLUS body-center crosshair
      //   dimline — 2 dots at .a   + .b    PLUS body-center crosshair
      // Same color/size convention as shape handles (5px filled dots,
      // 8px ringed crosshair for body), but uses the annotation's
      // effective render color (3-tier fallback) so the operator
      // visually matches the body line.
      if (state.mode === 'EDIT' && state.selectedAnnotation) {
        const selA = state.selectedAnnotation
        const activeSeqLocal = state.sequences.find((sq) => sq.id === state.activeSeqId)
        if (activeSeqLocal && selA.sequenceId === activeSeqLocal.id) {
          const anno = (activeSeqLocal.annotations || []).find((a) => a.id === selA.annotationId)
          if (anno) {
            const cwLocal = container.clientWidth
            const chLocal = container.clientHeight
            const ps = effectivePhotoSize(state.photoMeta, cwLocal, chLocal)
            const annoColor = (typeof anno.color === 'string' && anno.color.length > 0)
              ? anno.color
              : (typeof activeSeqLocal.defaultAnnoColor === 'string' && activeSeqLocal.defaultAnnoColor.length > 0)
                ? activeSeqLocal.defaultAnnoColor
                : '#f5a623'
            const handles = annotationHandles(anno)
            for (const h of handles) {
              const c = photoNormToCanvas(h.point, state.viewport, ps)
              ctxDynamic.fillStyle = annoColor
              ctxDynamic.strokeStyle = '#ffffff'
              ctxDynamic.lineWidth = 1.5
              ctxDynamic.beginPath()
              ctxDynamic.arc(c.x, c.y, 5, 0, Math.PI * 2)
              ctxDynamic.fill()
              ctxDynamic.stroke()
            }
            // Body-center crosshair for callout / dimline (note has no
            // separate centroid — its single anchor IS the body).
            const centroidNorm = annotationCentroid(anno)
            if (centroidNorm) {
              const c = photoNormToCanvas(centroidNorm, state.viewport, ps)
              ctxDynamic.strokeStyle = '#ffffff'
              ctxDynamic.lineWidth = 1.5
              ctxDynamic.beginPath()
              ctxDynamic.arc(c.x, c.y, 8, 0, Math.PI * 2)
              ctxDynamic.stroke()
              ctxDynamic.beginPath()
              ctxDynamic.moveTo(c.x - 5, c.y + 0.5)
              ctxDynamic.lineTo(c.x + 5, c.y + 0.5)
              ctxDynamic.moveTo(c.x + 0.5, c.y - 5)
              ctxDynamic.lineTo(c.x + 0.5, c.y + 5)
              ctxDynamic.stroke()
            }
          }
        }
      }

      // P16 (May 8 2026) — perspective corner handles when in
      // perspective-edit mode. 4 large filled-circle handles in KCC
      // orange so they read distinctly from shape/annotation handles.
      // Only painted while edit mode is active; the dotted outline on
      // the static canvas continues to show the locked perspective when
      // edit mode is off.
      if (state.perspectiveEditMode && state.perspectiveCorners) {
        const cwL = container.clientWidth
        const chL = container.clientHeight
        const ps = effectivePhotoSize(state.photoMeta, cwL, chL)
        for (let i = 0; i < 4; i++) {
          const c = state.perspectiveCorners[i]
          const cnv = photoNormToCanvas(c, state.viewport, ps)
          ctxDynamic.fillStyle = '#e8531a' // KCC orange
          ctxDynamic.strokeStyle = '#ffffff'
          ctxDynamic.lineWidth = 2
          ctxDynamic.beginPath()
          ctxDynamic.arc(cnv.x, cnv.y, 7, 0, Math.PI * 2)
          ctxDynamic.fill()
          ctxDynamic.stroke()
        }
      }

      // Snap indicator (Spec §8 colors + shapes)
      const snapPt = state.snapPt
      if (snapPt) {
        const sx = snapPt.x
        const sy = snapPt.y
        ctxDynamic.lineWidth = 1.5
        if (snapPt.type === 'corner' || snapPt.type === 'grid') {
          ctxDynamic.strokeStyle = '#00ffcc'
          ctxDynamic.strokeRect(sx - 6, sy - 6, 12, 12)
        } else if (snapPt.type === 'close') {
          ctxDynamic.fillStyle = '#00ffcc'
          ctxDynamic.fillRect(sx - 6, sy - 6, 12, 12)
        } else if (snapPt.type === 'midpoint') {
          ctxDynamic.strokeStyle = '#f5a623'
          ctxDynamic.beginPath()
          ctxDynamic.arc(sx, sy, 6, 0, Math.PI * 2)
          ctxDynamic.stroke()
        } else if (snapPt.type === 'cline') {
          ctxDynamic.strokeStyle = '#06b6d4'
          ctxDynamic.beginPath()
          ctxDynamic.arc(sx, sy, 6, 0, Math.PI * 2)
          ctxDynamic.stroke()
        }
      }

      // Cursor crosshair (top-most)
      ctxDynamic.strokeStyle = '#00ffcc'
      ctxDynamic.lineWidth = 1
      const x = state.cursorX
      const y = state.cursorY
      ctxDynamic.beginPath()
      ctxDynamic.moveTo(x - 8, y + 0.5)
      ctxDynamic.lineTo(x + 8, y + 0.5)
      ctxDynamic.moveTo(x + 0.5, y - 8)
      ctxDynamic.lineTo(x + 0.5, y + 8)
      ctxDynamic.stroke()
      ctxDynamic.restore()
    }

    // ---- rAF loop ----------------------------------------------------------
    let rafHandle = null
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      if (staticDirty) {
        drawStatic()
        staticDirty = false
      }
      if (dynamicDirty) {
        drawDynamic()
        dynamicDirty = false
      }
      rafHandle = requestAnimationFrame(tick)
    }
    rafHandle = requestAnimationFrame(tick)

    // ---- Draft commit (writes normalized 0–1 shape to active layer) -------
    // Section 7.A — drafts stay in canvas px while the operator is clicking
    // (immediate feedback in screen coords). At commit time, we translate
    // each canvas-px point back to photo-normalized via the viewport so
    // the persisted shape coordinates are zoom-stable.
    const commitDraft = () => {
      if (!draft) return
      const cw = container.clientWidth
      const ch = container.clientHeight
      const store = useAppStore.getState()
      const activeLayerId = store.activeLayerId
      if (!activeLayerId) {
        draft = null
        isDragging = false
        return
      }
      const photoSize = effectivePhotoSize(store.photoMeta, cw, ch)
      const viewport = store.viewport
      const toNorm = (p) => canvasToPhotoNorm(p, viewport, photoSize)
      let shape = null
      if (draft.type === 'poly' || draft.type === 'tri' || draft.type === 'line') {
        shape = {
          type: draft.type,
          pts: draft.pts.map(toNorm),
        }
      } else if (draft.type === 'arc') {
        // P6 — 3-point arc commits with all 3 pts normalized.
        shape = {
          type: 'arc',
          pts: draft.pts.map(toNorm),
        }
      } else if (draft.type === 'rect') {
        const x1c = Math.min(draft.startX, draft.x), x2c = Math.max(draft.startX, draft.x)
        const y1c = Math.min(draft.startY, draft.y), y2c = Math.max(draft.startY, draft.y)
        const tl = toNorm({ x: x1c, y: y1c })
        const tr = toNorm({ x: x2c, y: y1c })
        const br = toNorm({ x: x2c, y: y2c })
        const bl = toNorm({ x: x1c, y: y2c })
        shape = { type: 'rect', pts: [tl, tr, br, bl] }
      } else if (draft.type === 'ellipse') {
        // P6 — bounding-box ellipse commits with the 2 opposite corners.
        // Normalize "any two opposite corners" to TL + BR for stable
        // ordering across operator's drag direction.
        const x1c = Math.min(draft.startX, draft.x), x2c = Math.max(draft.startX, draft.x)
        const y1c = Math.min(draft.startY, draft.y), y2c = Math.max(draft.startY, draft.y)
        const tl = toNorm({ x: x1c, y: y1c })
        const br = toNorm({ x: x2c, y: y2c })
        shape = { type: 'ellipse', pts: [tl, br] }
      } else if (draft.type === 'circ') {
        // Section 7.A — circle radius is normalized to PHOTO width (was
        // canvas width pre-amendment). r in photo-px = r-canvas / zoom.
        const center = toNorm({ x: draft.cx, y: draft.cy })
        const rPhotoPx = draft.r / (viewport.zoom || 1)
        shape = {
          type: 'circ',
          cx: center.x,
          cy: center.y,
          r: rPhotoPx / photoSize.width,
        }
      }
      if (shape) useAppStore.getState().addShape(activeLayerId, shape)
      draft = null
      isDragging = false
    }

    // ---- Annotation commit (Step 12, Spec §12). Annotations live under
    // sequence.annotations[] and lock to whichever sequence was active at
    // create-time. SEQUENCE mode + active sequence are required at the
    // dispatch site below; this helper trusts those gates.
    const commitAnnotationDraft = () => {
      if (!draft || (draft.type !== 'callout' && draft.type !== 'dimline' && draft.type !== 'note')) return
      const cw = container.clientWidth
      const ch = container.clientHeight
      const store = useAppStore.getState()
      const seqId = store.activeSeqId
      if (!seqId) {
        draft = null
        return
      }
      // Section 7.A — translate canvas-px draft coords to photo-normalized.
      const photoSize = effectivePhotoSize(store.photoMeta, cw, ch)
      const viewport = store.viewport
      const toNorm = (p) => canvasToPhotoNorm(p, viewport, photoSize)
      let anno = null
      if (draft.type === 'callout') {
        anno = {
          type: 'callout',
          tip:  toNorm(draft.tip),
          tail: toNorm(draft.tail),
          textEN: '',
          textES: '',
        }
      } else if (draft.type === 'dimline') {
        anno = {
          type: 'dimline',
          a: toNorm(draft.a),
          b: toNorm(draft.b),
          value: '',
        }
      } else if (draft.type === 'note') {
        anno = {
          type: 'note',
          at: toNorm(draft.at),
          textEN: '',
          textES: '',
        }
      }
      if (anno) useAppStore.getState().addAnnotation(seqId, anno)
      draft = null
    }

    // ---- Construction-line commit (no active layer required, lives in
    // the separate clines array per Spec §6.6). Section 7.A — translate
    // anchor canvas-px through the viewport to photo-normalized so the
    // cline stays glued to the photo when zoomed.
    const commitClineDraft = () => {
      if (!draft || draft.type !== 'cline') return
      const cw = container.clientWidth
      const ch = container.clientHeight
      const store = useAppStore.getState()
      const photoSize = effectivePhotoSize(store.photoMeta, cw, ch)
      const viewport = store.viewport
      const startNorm = canvasToPhotoNorm({ x: draft.startX, y: draft.startY }, viewport, photoSize)
      const dx = draft.x - draft.startX
      const dy = draft.y - draft.startY
      let cline
      if (Math.abs(dy) < ORTHO_TOL) {
        cline = { type: 'h', y: startNorm.y }
      } else if (Math.abs(dx) < ORTHO_TOL) {
        cline = { type: 'v', x: startNorm.x }
      } else {
        cline = {
          type: 'a',
          px: startNorm.x,
          py: startNorm.y,
          angle: Math.atan2(dy, dx),
        }
      }
      useAppStore.getState().addCline(cline)
      draft = null
      isDragging = false
    }

    // ---- Pointer handlers (state + flag + draft mutation only) ------------
    const pointFromClient = (clientX, clientY) => {
      const rect = cvDynamic.getBoundingClientRect()
      return {
        x: Math.round(clientX - rect.left),
        y: Math.round(clientY - rect.top),
      }
    }

    const onMouseMove = (e) => {
      const { x, y } = pointFromClient(e.clientX, e.clientY)
      const store = useAppStore.getState()
      store.setCursor(x, y)
      // Phase 2 18b ride-along cleanup: pointerType recovery. Pre-18b
      // onTouchStart/onTouchMove wrote 'touch' but no handler wrote
      // 'mouse' back, so the snap tolerance stayed at the looser touch
      // value (22 px) forever after the first touch event — even when
      // the operator picked up a mouse mid-session. Now: if a real mouse
      // signature shows up (event has numeric movementX / movementY,
      // which native MouseEvents emit on mousemove and TouchEvent-
      // synthesised mousemoves don't) and the store still says 'touch',
      // flip it back to 'mouse' (which also restores the 12 px snap
      // tolerance via setPointerType's derivation).
      if (
        store.pointerType === 'touch'
        && typeof e.movementX === 'number'
        && typeof e.movementY === 'number'
      ) {
        store.setPointerType('mouse')
      }
      // Section 7.A.3 — viewport pan update. Apply delta to the original
      // pan baseline so re-entering the canvas mid-drag stays stable.
      if (panDrag) {
        const dx = x - panDrag.originCursor.x
        const dy = y - panDrag.originCursor.y
        const cwL = container.clientWidth
        const chL = container.clientHeight
        const next = clampPan(
          { ...store.viewport, panX: panDrag.originPan.panX + dx, panY: panDrag.originPan.panY + dy },
          effectivePhotoSize(store.photoMeta, cwL, chL),
          cwL, chL,
        )
        // P37 — operator-initiated drag pan. Mark touched so subsequent
        // canvas-size changes preserve the operator's viewport instead
        // of auto-fitting back.
        store.markViewportTouched()
        store.setPan(next.panX, next.panY)
        dynamicDirty = true
        return
      }
      if (draft) {
        if (draft.type === 'rect' && isDragging) { draft.x = x; draft.y = y }
        else if (draft.type === 'ellipse' && isDragging) { draft.x = x; draft.y = y }
        else if (draft.type === 'circ' && isDragging) {
          draft.r = Math.hypot(x - draft.cx, y - draft.cy)
        }
        else if (draft.type === 'cline' && isDragging) { draft.x = x; draft.y = y }
      }
      // Spec §8 — recompute the best snap target on every mousemove.
      // Section 7.A — pass viewport + effective photo size so snap math
      // operates in canvas px regardless of pan/zoom (operator-tolerance
      // is screen-pixel based).
      const cwLocal = container.clientWidth
      const chLocal = container.clientHeight
      const photoSizeLocal = effectivePhotoSize(store.photoMeta, cwLocal, chLocal)
      const snapPt = computeSnap({
        cursorX: x, cursorY: y,
        layers: store.layers,
        clines: store.clines,
        snapEnabled: store.snapEnabled,
        // P2 (May 7 2026) — per-snap-type gates threaded into computeSnap
        // so each of the 5 type branches can independently skip.
        snapTypes: store.snapTypes,
        gridEnabled: store.gridEnabled,
        gridSize: store.gridSize,
        snapTolerance: store.snapTolerance,
        draft,
        tool: store.tool,
        clinesVisible: store.clinesVisible,
        viewport: store.viewport,
        photoSize: photoSizeLocal,
        // P16 + P38 (May 8 2026) — perspective grid + grid rotation
        // threaded so the GRID-snap branch can match the render-path
        // transform (Option Y: perspective dominates when active).
        perspectiveCorners: store.perspectiveCorners,
        gridRotation: store.gridRotation,
      })
      // Avoid spurious store mutations when the snap result is unchanged
      // (cursor moved a pixel but snap target stayed the same).
      const prev = store.snapPt
      const same = (prev && snapPt
        && prev.x === snapPt.x && prev.y === snapPt.y && prev.type === snapPt.type)
        || (prev === null && snapPt === null)
      if (!same) store.setSnap(snapPt)

      // Spec §9 — edit-mode handle drag. Section 7.A — viewport-aware
      // movePoint / moveBody convert canvas-px deltas to photo-normalized
      // mutations so handles track the cursor 1:1 regardless of zoom.
      // Phase 2 18d — Technical Drawing rotation drag. Runs BEFORE
      // Field Markup editDrag so rotation in TECHNICAL doesn't fall
      // through to FM editDrag handling (which references state that
      // doesn't apply: photoSize, shape.pts, etc.). Each mousemove
      // computes the angle delta between the original cursor position
      // and the current cursor (both relative to the pivot center, in
      // canvas-px coords); rotates every origin shape's `a` and `b`
      // around the pivot in world coords; writes back via the no-undo
      // mutator. One undo entry pushed at mouseup.
      if (techRotateDrag) {
        const techV = store.viewports?.TECHNICAL || { panX: 0, panY: 0, zoom: 1 }
        const techZoom = techV.zoom || 1
        const centerCanvasX = techRotateDrag.originCenter.x * techZoom + techV.panX
        const centerCanvasY = techRotateDrag.originCenter.y * techZoom + techV.panY
        const origAngle = Math.atan2(
          techRotateDrag.originCursor.y - centerCanvasY,
          techRotateDrag.originCursor.x - centerCanvasX,
        )
        const currAngle = Math.atan2(y - centerCanvasY, x - centerCanvasX)
        const deltaDeg = ((currAngle - origAngle) * 180) / Math.PI
        for (const origShape of techRotateDrag.originShapes) {
          const rotated = rotateTechShape(origShape, techRotateDrag.originCenter, deltaDeg)
          // Look up the layerId via current techSelected — selection is
          // stable through the drag, so this stays consistent.
          const selEntry = store.techSelected.find((s) => s.shapeId === origShape.id)
          if (selEntry) {
            store.updateTechnicalShapeNoUndo(selEntry.layerId, origShape.id, rotated)
          }
        }
        staticDirty = true
        dynamicDirty = true
        return
      }

      if (editDrag) {
        // Use snap target when available (Spec §9: "Snap applies while
        // dragging handles") for point drags; body drags use raw cursor.
        const useX = (editDrag.mode === 'point' && snapPt) ? Math.round(snapPt.x) : x
        const useY = (editDrag.mode === 'point' && snapPt) ? Math.round(snapPt.y) : y
        let newShape
        if (editDrag.mode === 'point') {
          newShape = movePoint(editDrag.originShape, editDrag.pointIndex, { x: useX, y: useY }, store.viewport, photoSizeLocal)
        } else {
          const dx = useX - editDrag.originCursor.x
          const dy = useY - editDrag.originCursor.y
          newShape = moveBody(editDrag.originShape, { x: dx, y: dy }, store.viewport, photoSizeLocal)
        }
        // Apply the move via store updateShape — the layers reference
        // change triggers staticDirty via the existing subscription.
        store.updateShape(editDrag.layerId, editDrag.shapeId, newShape)
      }

      // P34 (May 7 2026) — annotation handle / body drag. Same snap-on-
      // point convention as shapes. Snap applies during point drag only;
      // body drag uses raw cursor delta from drag origin so the
      // annotation moves rigidly without snapping individual anchors.
      // Renders to the static canvas (annotations live there), so flag
      // both staticDirty and dynamicDirty.
      if (annoDrag) {
        const useX = (annoDrag.mode === 'point' && snapPt) ? Math.round(snapPt.x) : x
        const useY = (annoDrag.mode === 'point' && snapPt) ? Math.round(snapPt.y) : y
        if (annoDrag.mode === 'point') {
          // Convert canvas-px to photo-normalized coords; write the
          // single field (e.g. {tip: {x, y}}). photoSize-aware so handle
          // tracks cursor 1:1 across zoom.
          const newNorm = canvasToPhotoNorm({ x: useX, y: useY }, store.viewport, photoSizeLocal)
          store.updateAnnotation(
            annoDrag.sequenceId, annoDrag.annotationId,
            { [annoDrag.field]: newNorm },
          )
        } else {
          // Body drag — translate ALL the annotation's points by the
          // canvas-px delta from drag origin. annotationBodyTranslatePartial
          // handles the per-type field shape (note→.at, callout→.tip+.tail,
          // dimline→.a+.b).
          const dx = useX - annoDrag.originCursor.x
          const dy = useY - annoDrag.originCursor.y
          const partial = annotationBodyTranslatePartial(
            annoDrag.originAnno, { x: dx, y: dy },
            store.viewport, photoSizeLocal,
          )
          if (partial) {
            store.updateAnnotation(annoDrag.sequenceId, annoDrag.annotationId, partial)
          }
        }
        staticDirty = true
      }

      // P16 (May 8 2026) — perspective corner drag. Convert cursor canvas-px
      // → photo-norm (0..1) and update the dragged corner via the store
      // single-corner setter (clamps to [0, 1] internally). Render is
      // photo-anchored, so static repaint reflects the new corner shape.
      if (perspectiveDrag) {
        const cursorPhotoX = (x - store.viewport.panX) / store.viewport.zoom
        const cursorPhotoY = (y - store.viewport.panY) / store.viewport.zoom
        const newNorm = {
          x: cursorPhotoX / photoSizeLocal.width,
          y: cursorPhotoY / photoSizeLocal.height,
        }
        store.setPerspectiveCorner(perspectiveDrag.cornerIndex, newNorm)
        staticDirty = true
      }

      dynamicDirty = true
    }

    const onMouseDown = (e) => {
      const store = useAppStore.getState()
      const cw = container.clientWidth
      const ch = container.clientHeight
      const raw = pointFromClient(e.clientX, e.clientY)

      // Section 7.A.3 — pan triggers BEFORE any tool / mode branch.
      //   middle mouse button (e.button === 1): always pans
      //   space + left button:                  pans (hand tool engaged)
      const isPanInput = e.button === 1 || (e.button === 0 && spaceHeld)
      if (isPanInput) {
        e.preventDefault?.()
        panDrag = {
          originCursor: { x: raw.x, y: raw.y },
          originPan: { panX: store.viewport.panX, panY: store.viewport.panY },
          trigger: e.button === 1 ? 'middle' : 'space',
        }
        return
      }

      // Phase 2 18a/18b (May 10 2026) — Technical Drawing dispatch.
      // Pan input (middle-mouse / space+left / two-finger touch) handled
      // above. All Field Markup hit-testing (perspective corners,
      // annotation handles, shape handles, shape hit-test, draw tools)
      // remains suppressed under TECHNICAL.
      // 18b adds the tech-line tool state machine:
      //   - first click → capture anchor `a` (in TECHNICAL world coords),
      //                   show the floating length input
      //   - second click → freehand commit: b = cursor, length rounded
      //                    to nearest 0.5"
      //   - (Enter in floating input → typed commit; handled by the
      //     onCommit prop passed at JSX mount)
      //   - (Escape → cancel; handled by onCancel prop + keydown below)
      if (store.appMode === 'TECHNICAL') {
        if (e.button !== 0) return // only left-click commits
        const t = store.tool

        // Phase 2 18d (May 11 2026) — Select tool dispatch. Priority:
        //   1. If selection exists, check rotation grip proximity first.
        //   2. Else hit-test shapes for selection / multi-select.
        //   3. Empty-canvas click clears selection + typed rotation.
        if (t === 'tech-select') {
          const techV = store.viewports?.TECHNICAL || { panX: 0, panY: 0, zoom: 1 }
          // 1. Rotation grip hit.
          if (store.techSelected.length > 0) {
            const selectedShapes = getSelectedTechShapes(store.technicalLayers, store.techSelected)
            const center = store.techSelected.length === 1
              ? techShapeCentroid(selectedShapes[0])
              : techMultiShapeCentroid(selectedShapes)
            if (center) {
              const handleX = center.x * techV.zoom + techV.panX
              const handleY = center.y * techV.zoom + techV.panY
              const dxH = raw.x - handleX, dyH = raw.y - handleY
              const HANDLE_TOL_SQ = 81  // 9-px radius matches Field Markup body-center
              if (dxH * dxH + dyH * dyH <= HANDLE_TOL_SQ) {
                techRotateDrag = {
                  originShapes: selectedShapes.map((sh) => JSON.parse(JSON.stringify(sh))),
                  originCenter: { x: center.x, y: center.y },
                  originCursor: { x: raw.x, y: raw.y },
                  preDragSnap: useAppStore.getState().captureUndoSnapshot(),
                }
                dynamicDirty = true
                return
              }
            }
          }
          // 2. Shape hit-test for new/added selection.
          const hit = techHitTest({ x: raw.x, y: raw.y }, store.technicalLayers, techV, 7)
          if (hit) {
            if (e.shiftKey) {
              store.toggleTechSelectionMember(hit)
            } else {
              store.setTechSelection([hit])
            }
          } else if (!e.shiftKey) {
            // 3. Empty-canvas click (without shift) — clear both selection
            // and the typed rotation input. Shift+empty does nothing
            // (operator was likely shift-clicking on the canvas trying to
            // toggle a shape; missing the shape shouldn't clear).
            store.clearTechSelection()
            store.setTechRotationInput(null)
          }
          dynamicDirty = true
          return
        }

        if (t === 'tech-line') {
          const techV = store.viewports?.TECHNICAL || { panX: 0, panY: 0, zoom: 1 }
          const techZoom = techV.zoom || 1
          // Convert click canvas-px → TECHNICAL world coords.
          const worldX = (raw.x - techV.panX) / techZoom
          const worldY = (raw.y - techV.panY) / techZoom
          const draft = store.techDraft
          if (!draft || !draft.a) {
            // First click — capture anchor. 18c docked pivot: the panel
            // is already mounted (whenever tool === 'tech-line'), so the
            // operator may have pre-typed length/angle values that are
            // sitting in techDraft.typedInches / typedAngleDegrees. Spread
            // any existing draft to preserve those pre-fills; only the
            // anchor is brand new at this point.
            const cur = draft || { typedInches: null, typedAngleDegrees: null }
            store.setTechDraft({
              ...cur,
              a: { x: worldX, y: worldY },
            })
            dynamicDirty = true
            return
          }
          // Second click — commit. 18c click-commits-typed: if the
          // operator typed a length and/or angle in the input panel
          // (techDraft.typedInches / typedAngleDegrees), use those.
          // Whatever wasn't typed falls back to the cursor (length =
          // click distance rounded to 0.5", angle = cursor direction
          // from anchor). The helper makes the per-axis decision and
          // calls addTechnicalShape + setTechDraft(null).
          commitTechLine({
            anchor: draft.a,
            cursorWorld: { x: worldX, y: worldY },
            typedInches: draft.typedInches,
            typedAngleDegrees: draft.typedAngleDegrees,
            addTechnicalShape: store.addTechnicalShape,
            setTechDraft: store.setTechDraft,
          })
          dynamicDirty = true
          return
        }
        return // no tool selected — nothing to do; Field Markup paths stay suppressed
      }

      // P16 (May 8 2026) — perspective-edit mode hit-test runs BEFORE
      // mode/tool dispatch so the operator can drag corner handles
      // regardless of DRAW/EDIT/SEQUENCE mode (perspective is a grid
      // setting, not a mode). Hit-test the 4 corner handles in canvas-px
      // space; mousedown on a handle starts a perspectiveDrag.
      if (store.perspectiveEditMode && store.perspectiveCorners) {
        if (e.button === 2) return // ignore right-click
        const photoSizeP = effectivePhotoSize(store.photoMeta, cw, ch)
        const HANDLE_TOL_SQ = 100 // 10-px radius (slightly looser than shapes for confidence)
        for (let i = 0; i < 4; i++) {
          const c = store.perspectiveCorners[i]
          const cPx = { x: c.x * photoSizeP.width, y: c.y * photoSizeP.height }
          const cnv = { x: cPx.x * store.viewport.zoom + store.viewport.panX,
                        y: cPx.y * store.viewport.zoom + store.viewport.panY }
          const dx = raw.x - cnv.x
          const dy = raw.y - cnv.y
          if (dx * dx + dy * dy <= HANDLE_TOL_SQ) {
            perspectiveDrag = {
              cornerIndex: i,
              originCorners: store.perspectiveCorners.map((p) => ({ ...p })),
              originCursor: { x: raw.x, y: raw.y },
              preDragSnap: useAppStore.getState().captureUndoSnapshot(),
            }
            dynamicDirty = true
            return
          }
        }
        // No handle hit — don't intercept. Fall through to other branches.
      }

      // Spec §9 — EDIT mode branches BEFORE the tool dispatch.
      // Section 7.A — handle / hit-test math uses viewport so a zoomed-in
      // shape gets a 7-canvas-px handle just like a zoomed-out one.
      if (store.mode === 'EDIT') {
        // Don't intercept right-clicks (handled by onContextMenu instead).
        if (e.button === 2) return
        const photoSizeMD = effectivePhotoSize(store.photoMeta, cw, ch)

        // P34 (May 7 2026) — annotation hit-test runs BEFORE shape hit-test
        // so an annotation sitting on top of a shape can still be grabbed.
        // Annotations only render for the active sequence; gate on it.
        // Order: selectedAnnotation handles → selectedAnnotation body-center
        // crosshair (callout/dimline only) → any-annotation hit (new
        // selection) → fall through to shape branches below.
        const activeSeqMD = store.sequences.find((sq) => sq.id === store.activeSeqId)
        if (activeSeqMD) {
          const selA = store.selectedAnnotation
          // 0a. Drag handles of the already-selected annotation.
          if (selA && selA.sequenceId === activeSeqMD.id) {
            const selAnno = (activeSeqMD.annotations || []).find((a) => a.id === selA.annotationId)
            if (selAnno) {
              // Point handles (5px filled dots; 8-px hit tolerance).
              const aHandles = annotationHandles(selAnno)
              const ANNO_HANDLE_TOL_SQ = 64 // 8-px radius
              for (const h of aHandles) {
                const c = photoNormToCanvas(h.point, store.viewport, photoSizeMD)
                const dx = raw.x - c.x
                const dy = raw.y - c.y
                if (dx * dx + dy * dy <= ANNO_HANDLE_TOL_SQ) {
                  annoDrag = {
                    mode: 'point',
                    sequenceId: activeSeqMD.id,
                    annotationId: selAnno.id,
                    field: h.field,
                    originAnno: JSON.parse(JSON.stringify(selAnno)),
                    originCursor: { x: raw.x, y: raw.y },
                    preDragSnap: useAppStore.getState().captureUndoSnapshot(),
                  }
                  dynamicDirty = true
                  return
                }
              }
              // Body-center crosshair (callout / dimline only — note's
              // single anchor is hit by the point handle path above).
              const cNorm = annotationCentroid(selAnno)
              if (cNorm) {
                const c = photoNormToCanvas(cNorm, store.viewport, photoSizeMD)
                const dx = raw.x - c.x
                const dy = raw.y - c.y
                if (dx * dx + dy * dy <= 81) { // 9-px radius (matches shape body)
                  annoDrag = {
                    mode: 'body',
                    sequenceId: activeSeqMD.id,
                    annotationId: selAnno.id,
                    originAnno: JSON.parse(JSON.stringify(selAnno)),
                    originCursor: { x: raw.x, y: raw.y },
                    preDragSnap: useAppStore.getState().captureUndoSnapshot(),
                  }
                  dynamicDirty = true
                  return
                }
              }
            }
          }
          // 0b. Any-annotation hit-test for new panel selection. No drag —
          //     operator picks first, drags second (matches shape sel/handle
          //     pattern). Selecting an annotation clears any shape selection
          //     so the right-drawer state stays coherent.
          const annoHit = annotationHitTest(
            activeSeqMD.annotations || [],
            activeSeqMD.id,
            { x: raw.x, y: raw.y },
            store.viewport, photoSizeMD,
          )
          if (annoHit) {
            store.setSelectedAnnotation(annoHit)
            store.clearSelection()
            dynamicDirty = true
            return
          }
        }

        const sel = store.selected
        // 1. If something is already selected, check handle proximity first
        if (sel) {
          const layer = store.layers.find((l) => l.id === sel.layerId)
          const shape = layer?.visible
            ? (layer.shapes || []).find((sh) => sh.id === sel.shapeId)
            : null
          if (shape) {
            const handles = shapeHandlePoints(shape, store.viewport, photoSizeMD)
            const HANDLE_TOL_SQ = 49 // 7-px radius
            for (let i = 0; i < handles.length; i++) {
              const dx = raw.x - handles[i].x
              const dy = raw.y - handles[i].y
              if (dx * dx + dy * dy <= HANDLE_TOL_SQ) {
                // P34 side fix (May 7 2026) — capture pre-drag snapshot.
                // updateShape doesn't pushUndo (per-mousemove would burn
                // one entry per pixel); push at mouseup if changed.
                editDrag = {
                  mode: 'point',
                  layerId: sel.layerId,
                  shapeId: sel.shapeId,
                  pointIndex: i,
                  originShape: JSON.parse(JSON.stringify(shape)),
                  originCursor: { x: raw.x, y: raw.y },
                  preDragSnap: useAppStore.getState().captureUndoSnapshot(),
                }
                dynamicDirty = true
                return
              }
            }
            // Body center handle (non-circle only — circle's handle 0 IS center)
            if (shape.type !== 'circ') {
              const c = shapeCentroid(shape, store.viewport, photoSizeMD)
              if (c) {
                const dx = raw.x - c.x
                const dy = raw.y - c.y
                if (dx * dx + dy * dy <= 81) { // 9-px radius
                  editDrag = {
                    mode: 'body',
                    layerId: sel.layerId,
                    shapeId: sel.shapeId,
                    originShape: JSON.parse(JSON.stringify(shape)),
                    originCursor: { x: raw.x, y: raw.y },
                    preDragSnap: useAppStore.getState().captureUndoSnapshot(),
                  }
                  dynamicDirty = true
                  return
                }
              }
            }
          }
        }
        // 2. No handle hit — do shape hit-test for new selection.
        const hit = hitTest({ x: raw.x, y: raw.y }, store.layers, store.viewport, photoSizeMD)
        if (hit) {
          store.setSelected(hit)
          // P34 — picking a shape clears any annotation panel selection
          // so the right-drawer state stays coherent (one selection at a
          // time, like the shape branch).
          store.setSelectedAnnotation(null)
        } else {
          // P34 — empty-canvas click clears BOTH shape and annotation
          // panel selections. Shape was the only selection field before
          // P34; annotations now mirror the same deselect convention.
          store.clearSelection()
          store.setSelectedAnnotation(null)
        }
        dynamicDirty = true
        return
      }

      // ---- DRAW / SEQUENCE mode tool dispatch ----
      const t = store.tool
      const activeLayerId = store.activeLayerId
      if (!t) return
      // Step 12 — annotation tools (callout / dimline / note) require
      // SEQUENCE mode AND an active sequence. They commit into
      // `sequence.annotations[]` on the active sequence.
      const ANNO_TOOLS = new Set(['callout', 'dimline', 'note'])
      const isAnnoTool = ANNO_TOOLS.has(t)
      if (isAnnoTool && (store.mode !== 'SEQUENCE' || !store.activeSeqId)) return
      // Shape tools commit into the active layer; cline lives in its own
      // array and doesn't need one (Spec §6.6); annotation tools live
      // under the active sequence and don't need an active layer.
      if (!isAnnoTool && t !== 'cline' && !activeLayerId) return
      // Spec §8 — committing a point uses the active snap target if any.
      // Snap is the cleanest precision boundary: shape commit, cline anchor,
      // poly point placement all flow through the same coords.
      const snapPt = store.snapPt
      const x = snapPt ? Math.round(snapPt.x) : raw.x
      const y = snapPt ? Math.round(snapPt.y) : raw.y
      const snap = store.snapTolerance || SNAP_TOLERANCE_DEFAULT

      if (t === 'poly') {
        if (!draft) {
          draft = { type: 'poly', pts: [{ x, y }] }
        } else {
          const first = draft.pts[0]
          if (draft.pts.length >= 3 && Math.hypot(x - first.x, y - first.y) < snap) {
            commitDraft()
          } else {
            draft.pts.push({ x, y })
          }
        }
      } else if (t === 'rect') {
        draft = { type: 'rect', startX: x, startY: y, x, y }
        isDragging = true
      } else if (t === 'tri') {
        if (!draft) {
          draft = { type: 'tri', pts: [{ x, y }] }
        } else {
          draft.pts.push({ x, y })
          if (draft.pts.length >= 3) commitDraft()
        }
      } else if (t === 'circ') {
        draft = { type: 'circ', cx: x, cy: y, r: 0 }
        isDragging = true
      } else if (t === 'arc') {
        // P6 — 3-click arc. Click 1 = start. Click 2 = mid. Click 3 =
        // end + auto-commit. Mirrors triangle's 3-click pattern.
        if (!draft) {
          draft = { type: 'arc', pts: [{ x, y }] }
        } else {
          draft.pts.push({ x, y })
          if (draft.pts.length >= 3) commitDraft()
        }
      } else if (t === 'ellipse') {
        // P6 — drag-to-commit ellipse (mirrors rect). Bounding-box
        // form: 2 corners. Min size threshold checked in onMouseUp.
        draft = { type: 'ellipse', startX: x, startY: y, x, y }
        isDragging = true
      } else if (t === 'line') {
        if (!draft) {
          draft = { type: 'line', pts: [{ x, y }] }
        } else {
          draft.pts.push({ x, y })
          commitDraft()
        }
      } else if (t === 'cline') {
        draft = { type: 'cline', startX: x, startY: y, x, y }
        isDragging = true
      } else if (t === 'callout') {
        if (!draft) {
          draft = { type: 'callout', tip: { x, y } }
        } else {
          draft.tail = { x, y }
          commitAnnotationDraft()
        }
      } else if (t === 'dimline') {
        if (!draft) {
          draft = { type: 'dimline', a: { x, y } }
        } else {
          draft.b = { x, y }
          commitAnnotationDraft()
        }
      } else if (t === 'note') {
        draft = { type: 'note', at: { x, y } }
        commitAnnotationDraft()
      }
      dynamicDirty = true
    }

    const onMouseUp = () => {
      // Section 7.A.3 — end any in-progress pan drag.
      if (panDrag) {
        panDrag = null
        dynamicDirty = true
        return
      }
      // Spec §9 — end edit-mode drag if active
      // Phase 2 18d — Technical Drawing rotation drag commit. Mirrors
      // Field Markup editDrag's "one undo per drag" pattern: push the
      // captured pre-drag snapshot if any of the rotated shapes ended
      // up different from their origin. JSON-stringify comparison
      // covers the {a, b} rotation in one shot.
      if (techRotateDrag) {
        let changed = false
        const liveLayers = useAppStore.getState().technicalLayers
        for (const origShape of techRotateDrag.originShapes) {
          let cur = null
          for (const tl of liveLayers) {
            const found = (tl.shapes || []).find((sh) => sh.id === origShape.id)
            if (found) { cur = found; break }
          }
          if (cur && JSON.stringify(cur) !== JSON.stringify(origShape)) {
            changed = true
            break
          }
        }
        if (changed && typeof techRotateDrag.preDragSnap === 'string') {
          useAppStore.getState().pushCapturedSnapshot(techRotateDrag.preDragSnap)
        }
        techRotateDrag = null
        dynamicDirty = true
        return
      }

      if (editDrag) {
        // P34 side fix (May 7 2026) — push captured pre-drag snapshot
        // if the shape actually changed. updateShape doesn't pushUndo
        // (per-mousemove granularity would burn one entry per pixel),
        // so we do it here: one undo entry per drag, regardless of
        // mousemove count. JSON-comparison covers both point and body
        // modes uniformly.
        const layer = useAppStore.getState().layers.find((l) => l.id === editDrag.layerId)
        const cur = layer?.shapes?.find((sh) => sh.id === editDrag.shapeId)
        if (
          cur
          && JSON.stringify(cur) !== JSON.stringify(editDrag.originShape)
          && typeof editDrag.preDragSnap === 'string'
        ) {
          useAppStore.getState().pushCapturedSnapshot(editDrag.preDragSnap)
        }
        editDrag = null
        dynamicDirty = true
        return
      }
      // P34 (May 7 2026) — end annotation drag if active. Same captured-
      // snapshot pattern as shape drag (one undo entry per drag, not
      // per mousemove). updateAnnotation also doesn't pushUndo.
      if (annoDrag) {
        const sequences = useAppStore.getState().sequences
        const seqCur = sequences.find((sq) => sq.id === annoDrag.sequenceId)
        const annoCur = (seqCur?.annotations || []).find((a) => a.id === annoDrag.annotationId)
        if (
          annoCur
          && JSON.stringify(annoCur) !== JSON.stringify(annoDrag.originAnno)
          && typeof annoDrag.preDragSnap === 'string'
        ) {
          useAppStore.getState().pushCapturedSnapshot(annoDrag.preDragSnap)
        }
        annoDrag = null
        staticDirty = true
        dynamicDirty = true
        return
      }
      // P16 (May 8 2026) — end perspective corner drag if active. Same
      // captured-snapshot pattern as shape/annotation drags. setPerspectiveCorner
      // doesn't push undo per mousemove; one entry per drag at mouseup.
      if (perspectiveDrag) {
        const curCorners = useAppStore.getState().perspectiveCorners
        if (
          curCorners
          && JSON.stringify(curCorners) !== JSON.stringify(perspectiveDrag.originCorners)
          && typeof perspectiveDrag.preDragSnap === 'string'
        ) {
          useAppStore.getState().pushCapturedSnapshot(perspectiveDrag.preDragSnap)
        }
        perspectiveDrag = null
        staticDirty = true
        dynamicDirty = true
        return
      }
      if (!draft) return
      if (draft.type === 'rect') {
        const w = Math.abs(draft.x - draft.startX)
        const h = Math.abs(draft.y - draft.startY)
        if (w >= MIN_RECT_SIZE && h >= MIN_RECT_SIZE) commitDraft()
        else { draft = null; isDragging = false }
        dynamicDirty = true
      } else if (draft.type === 'ellipse') {
        // P6 — same min-size threshold as rect. Below threshold → discard.
        const w = Math.abs(draft.x - draft.startX)
        const h = Math.abs(draft.y - draft.startY)
        if (w >= MIN_RECT_SIZE && h >= MIN_RECT_SIZE) commitDraft()
        else { draft = null; isDragging = false }
        dynamicDirty = true
      } else if (draft.type === 'circ') {
        if (draft.r >= MIN_CIRCLE_R) commitDraft()
        else { draft = null; isDragging = false }
        dynamicDirty = true
      } else if (draft.type === 'cline') {
        const dist = Math.hypot(draft.x - draft.startX, draft.y - draft.startY)
        if (dist >= MIN_CLINE_DRAG) commitClineDraft()
        else { draft = null; isDragging = false }
        dynamicDirty = true
      }
    }

    const onDblClick = () => {
      if (draft?.type === 'poly' && draft.pts.length >= 3) {
        commitDraft()
        dynamicDirty = true
      }
    }

    // Section 7.A.4 — scroll-wheel zoom, cursor-aligned. Skip when ctrl/cmd
    // is held so browser-default zoom continues to work.
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) return
      e.preventDefault?.()
      const store = useAppStore.getState()
      const cwL = container.clientWidth
      const chL = container.clientHeight
      const ps = effectivePhotoSize(store.photoMeta, cwL, chL)
      const fitFloor = computeFitViewport(ps, cwL, chL).zoom
      const cursor = pointFromClient(e.clientX, e.clientY)
      // Smooth step: each wheel tick scales by ~1.1; deltaY positive =
      // scroll down = zoom out; deltaY negative = scroll up = zoom in.
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      const targetZoom = clampZoom(store.viewport.zoom * factor, fitFloor)
      const v = zoomAtCursor(store.viewport, ps, cursor, targetZoom)
      const clamped = clampPan(v, ps, cwL, chL)
      // P37 — operator-initiated wheel zoom. Mark touched.
      store.markViewportTouched()
      store.setViewport({ zoom: v.zoom, panX: clamped.panX, panY: clamped.panY })
    }

    // Section 7.A.4 — keyboard zoom helpers: zoom-at-canvas-center.
    const zoomBy = (factor) => {
      const store = useAppStore.getState()
      const cwL = container.clientWidth
      const chL = container.clientHeight
      const ps = effectivePhotoSize(store.photoMeta, cwL, chL)
      const fitFloor = computeFitViewport(ps, cwL, chL).zoom
      const target = clampZoom(store.viewport.zoom * factor, fitFloor)
      const center = { x: cwL / 2, y: chL / 2 }
      const v = zoomAtCursor(store.viewport, ps, center, target)
      const clamped = clampPan(v, ps, cwL, chL)
      // P37 — operator-initiated keyboard +/- zoom. Mark touched.
      store.markViewportTouched()
      store.setViewport({ zoom: v.zoom, panX: clamped.panX, panY: clamped.panY })
    }
    const zoomTo = (target) => {
      const store = useAppStore.getState()
      const cwL = container.clientWidth
      const chL = container.clientHeight
      const ps = effectivePhotoSize(store.photoMeta, cwL, chL)
      const fitFloor = computeFitViewport(ps, cwL, chL).zoom
      const t = clampZoom(target, fitFloor)
      const center = { x: cwL / 2, y: chL / 2 }
      const v = zoomAtCursor(store.viewport, ps, center, t)
      const clamped = clampPan(v, ps, cwL, chL)
      // P37 — operator-initiated keyboard 1 (zoom to 100%). Mark touched.
      store.markViewportTouched()
      store.setViewport({ zoom: v.zoom, panX: clamped.panX, panY: clamped.panY })
    }
    const fitViewport = () => {
      const store = useAppStore.getState()
      const cwL = container.clientWidth
      const chL = container.clientHeight
      // P37 — keyboard 0 (Fit). Routes through fitToViewport which sets
      // viewport + clears the touched flag so subsequent canvas-size
      // changes auto-fit again.
      store.fitToViewport(cwL, chL)
    }

    const onKeyDown = (e) => {
      // Don't intercept while the user is typing in inputs/textareas
      // (layer rename, future annotation textareas, etc.).
      const tag = (e.target?.tagName || '').toUpperCase()
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable
      if (editable) return

      // Section 7.A.6 — Space (held) = hand tool. Track the held state
      // for the pan-input gate in onMouseDown.
      if (e.key === ' ' || e.code === 'Space') {
        if (!spaceHeld) {
          spaceHeld = true
          // Visual feedback via the wrapper class is added by App.css
          // (handled at the React level via store-derived class).
        }
        e.preventDefault?.()
        return
      }
      // Section 7.A.6 — zoom keyboard shortcuts. `+`/`=` zoom in; `-` out;
      // `0` fit; `1` 100%. Skip when meta/ctrl/alt held so OS shortcuts
      // (Cmd+0, Ctrl+= browser zoom, etc.) keep working.
      if (!(e.ctrlKey || e.metaKey || e.altKey)) {
        if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.25); return }
        if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(0.8); return }
        if (e.key === '0') { e.preventDefault(); fitViewport(); return }
        if (e.key === '1') { e.preventDefault(); zoomTo(1.0); return }
      }

      if (e.key === 'Escape') {
        // Priority: cancel in-progress draw draft → cancel edit drag →
        // cancel annotation drag → clear selection. Each layer is
        // independent so Escape always unwinds the topmost interaction.
        // Phase 2 18b — also cancel an in-progress Technical Drawing
        // line draft when the input isn't focused (TechLengthInput's
        // onKeyDown handles Escape with stopPropagation when focused,
        // so this branch only fires when focus is elsewhere — e.g.
        // operator clicked back onto the canvas mid-draft).
        const sEscTech = useAppStore.getState()
        if (sEscTech.appMode === 'TECHNICAL') {
          // Phase 2 18d — Escape priority chain under TECHNICAL:
          //   1. Active rotation drag → cancel (shape stays at last
          //      mousemove position; matches Field Markup editDrag
          //      Escape semantics).
          //   2. Active tech-line draft → null the draft.
          //   3. Active selection → clear selection + typed rotation.
          if (techRotateDrag) {
            techRotateDrag = null
            dynamicDirty = true
            return
          }
          if (sEscTech.techDraft) {
            sEscTech.setTechDraft(null)
            dynamicDirty = true
            return
          }
          if (sEscTech.techSelected.length > 0) {
            sEscTech.clearTechSelection()
            sEscTech.setTechRotationInput(null)
            dynamicDirty = true
            return
          }
        }
        if (draft) {
          draft = null
          isDragging = false
          dynamicDirty = true
          return
        }
        if (editDrag) {
          editDrag = null
          dynamicDirty = true
          return
        }
        // P34 — Escape cancels annotation drag. updateAnnotation calls
        // during the drag mutated the live state; restore the original
        // annotation snapshot from drag start so Cancel really cancels
        // (matches the operator's mental model — Esc = back to where
        // I was at mousedown).
        if (annoDrag) {
          useAppStore.getState().updateAnnotation(
            annoDrag.sequenceId, annoDrag.annotationId, annoDrag.originAnno,
          )
          annoDrag = null
          staticDirty = true
          dynamicDirty = true
          return
        }
        // P16 — Escape cancels perspective corner drag + restores origin.
        if (perspectiveDrag) {
          useAppStore.getState().setPerspectiveCorners(perspectiveDrag.originCorners)
          perspectiveDrag = null
          staticDirty = true
          dynamicDirty = true
          return
        }
        // P16 — Escape exits perspective-edit mode (matches the toolbar
        // button toggle convention).
        const sEsc = useAppStore.getState()
        if (sEsc.perspectiveEditMode) {
          sEsc.setPerspectiveEditMode(false)
          dynamicDirty = true
          return
        }
        const s = useAppStore.getState()
        if (s.mode === 'EDIT' && (s.selected || s.selectedAnnotation)) {
          // P34 — clear both selections on Escape to mirror click-empty.
          if (s.selected) s.clearSelection()
          if (s.selectedAnnotation) s.setSelectedAnnotation(null)
          return
        }
      }

      // Spec §9 — Delete / Backspace removes the selected shape (no
      // confirm dialog per spec; rely on undo).
      // P34 (May 7 2026) — also removes the selected annotation when in
      // EDIT mode and selectedAnnotation is set. Same rely-on-undo
      // convention; deleteAnnotation pushes its own undo entry.
      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        const s = useAppStore.getState()
        if (s.mode === 'EDIT' && s.selected) {
          e.preventDefault()
          s.deleteShape(s.selected.layerId, s.selected.shapeId)
          return
        }
        if (s.mode === 'EDIT' && s.selectedAnnotation) {
          e.preventDefault()
          s.deleteAnnotation(
            s.selectedAnnotation.sequenceId,
            s.selectedAnnotation.annotationId,
          )
          s.setSelectedAnnotation(null)
          return
        }
      }

      // Spec §15 — undo/redo keyboard. Wired here as a Step 2 partial-
      // completion fix (the store actions shipped in Step 2 but the keyboard
      // surface was missing until now). Visible header buttons land at
      // Step 17 per Project Traveler Field 5.
      const meta = e.ctrlKey || e.metaKey
      if (!meta) return
      const k = (e.key || '').toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        useAppStore.getState().undo()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        useAppStore.getState().redo()
      }
    }

    // Section 7.A.6 — Space release clears the hand-tool flag.
    const onKeyUp = (e) => {
      if (e.key === ' ' || e.code === 'Space') {
        spaceHeld = false
      }
    }

    // Section 7.A.3 / 7.A.4 — touch handling distinguishes single-finger
    // drag (existing draw / edit semantics) from two-finger gestures
    // (pan + pinch zoom). pinch midpoint = average of both touches.
    const onTouchStart = (e) => {
      const store = useAppStore.getState()
      store.setPointerType('touch')
      if (e.touches.length === 2) {
        const [a, b] = e.touches
        const mid = pointFromClient((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1
        pinch = {
          originDist: dist,
          originZoom: store.viewport.zoom,
          originPan: { panX: store.viewport.panX, panY: store.viewport.panY },
          originMid: mid,
        }
        // Cancel any single-finger drag-in-progress so the pinch dominates.
        panDrag = null
        return
      }
      if (e.touches && e.touches.length === 1) {
        const t = e.touches[0]
        onMouseDown({ clientX: t.clientX, clientY: t.clientY, button: 0, preventDefault: () => {} })
      }
    }
    const onTouchMove = (e) => {
      const store = useAppStore.getState()
      store.setPointerType('touch')
      if (e.touches.length === 2 && pinch) {
        const [a, b] = e.touches
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1
        const ratio = dist / pinch.originDist
        const cwL = container.clientWidth
        const chL = container.clientHeight
        const ps = effectivePhotoSize(store.photoMeta, cwL, chL)
        const fitFloor = computeFitViewport(ps, cwL, chL).zoom
        const targetZoom = clampZoom(pinch.originZoom * ratio, fitFloor)
        // Anchor the pinch midpoint in canvas space so the photo point
        // under the midpoint remains under the midpoint as zoom changes.
        const currentMid = pointFromClient((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
        const v = zoomAtCursor(
          { ...store.viewport, panX: pinch.originPan.panX, panY: pinch.originPan.panY, zoom: pinch.originZoom },
          ps, pinch.originMid, targetZoom,
        )
        // Two-finger pan: shift by the midpoint delta on top of zoom.
        const dx = currentMid.x - pinch.originMid.x
        const dy = currentMid.y - pinch.originMid.y
        const clamped = clampPan({ ...v, panX: v.panX + dx, panY: v.panY + dy }, ps, cwL, chL)
        // P37 — operator-initiated touch pinch+pan. Mark touched.
        store.markViewportTouched()
        store.setViewport({ zoom: v.zoom, panX: clamped.panX, panY: clamped.panY })
        return
      }
      if (e.touches && e.touches.length === 1 && !pinch) {
        const t = e.touches[0]
        onMouseMove({ clientX: t.clientX, clientY: t.clientY })
      }
    }
    const onTouchEnd = (e) => {
      if (pinch && e.touches.length < 2) {
        pinch = null
      }
      onMouseUp()
    }

    // Spec §9 — right-click context menu in EDIT mode (Delete / Duplicate
    // / Move to layer). Hits the shape under the cursor (or stays on the
    // current selection if cursor is over it) and opens the menu at the
    // event position. Long-press equivalent for touch is Punch List
    // candidate (P9 keyboard / mobile audit at Step 18).
    const onContextMenu = (e) => {
      const store = useAppStore.getState()
      // Phase 2 18a — context menu is a Field Markup affordance only.
      if (store.appMode === 'TECHNICAL') return
      if (store.mode !== 'EDIT') return
      e.preventDefault()
      const cw = container.clientWidth
      const ch = container.clientHeight
      const raw = pointFromClient(e.clientX, e.clientY)
      // Hit-test under cursor; if hit, set selection AND open menu. Capture
      // canvas size at click-time (refs are safe to read here, unlike during
      // render). Section 7.A — pass viewport + photo size to hitTest.
      const sizeSnapshot = { cw, ch }
      const photoSizeCM = effectivePhotoSize(store.photoMeta, cw, ch)
      const hit = hitTest({ x: raw.x, y: raw.y }, store.layers, store.viewport, photoSizeCM)
      if (hit) {
        store.setSelected(hit)
        setCtxMenu({ x: raw.x, y: raw.y, layerId: hit.layerId, shapeId: hit.shapeId, canvasSize: sizeSnapshot })
      } else if (store.selected) {
        // No hit — but if a shape was already selected, keep selection
        // and open menu for it (operator may right-click empty area to
        // see options on the current selection).
        setCtxMenu({
          x: raw.x, y: raw.y,
          layerId: store.selected.layerId, shapeId: store.selected.shapeId,
          canvasSize: sizeSnapshot,
        })
      }
    }

    cvDynamic.addEventListener('mousedown', onMouseDown)
    cvDynamic.addEventListener('mousemove', onMouseMove)
    cvDynamic.addEventListener('mouseup', onMouseUp)
    cvDynamic.addEventListener('dblclick', onDblClick)
    cvDynamic.addEventListener('contextmenu', onContextMenu)
    // wheel must be {passive: false} so we can preventDefault to stop the
    // page from scrolling when the operator zooms over the canvas.
    cvDynamic.addEventListener('wheel', onWheel, { passive: false })
    cvDynamic.addEventListener('touchstart', onTouchStart, { passive: true })
    cvDynamic.addEventListener('touchmove', onTouchMove, { passive: true })
    cvDynamic.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)

    // ---- Store subscription -----------------------------------------------
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.layers !== prev.layers || state.clines !== prev.clines) {
        staticDirty = true
      }
      // Phase 2 18b — Technical Drawing layers + shapes feed drawStatic
      // under TECHNICAL mode. Any commit (addTechnicalShape) or future
      // edit (updateTechnicalShape / deleteTechnicalShape) bumps the
      // technicalLayers array reference; flip staticDirty so the line
      // appears (or updates) on the next rAF tick.
      if (state.technicalLayers !== prev.technicalLayers) {
        staticDirty = true
      }
      // 18b — techDraft change repaints the rubber-band on the dynamic
      // canvas. Fires on first click (draft begin), Enter / freehand
      // commit / Escape cancel (draft end), and each typedInches update
      // from TechLengthInput's onTypedChange.
      if (state.techDraft !== prev.techDraft) {
        dynamicDirty = true
      }
      // 18d — selection change repaints BOTH static (orange stroke flip)
      // and dynamic (rotation grip mount/unmount). Fires on every
      // setTechSelection / add / remove / toggle / clear.
      if (state.techSelected !== prev.techSelected) {
        staticDirty = true
        dynamicDirty = true
      }
      // Spec §9 — selection change repaints both static (selected outline)
      // and dynamic (handles).
      if (state.selected !== prev.selected) {
        staticDirty = true
        dynamicDirty = true
      }
      // Mode change repaints (handles only show in EDIT, SEQUENCE-mode
      // changes the layer filter) and closes any open context menu
      // (left-over UI from a prior mode is confusing). Step 12 — leaving
      // SEQUENCE mode while an annotation tool is selected clears the
      // tool + any in-progress annotation draft so the toolbar doesn't
      // strand the operator with a tool that can't commit.
      if (state.mode !== prev.mode) {
        staticDirty = true
        dynamicDirty = true
        setCtxMenu(null)
        if (prev.mode === 'SEQUENCE' && state.mode !== 'SEQUENCE') {
          if (draft && (draft.type === 'callout' || draft.type === 'dimline' || draft.type === 'note')) {
            draft = null
          }
          const t = state.tool
          if (t === 'callout' || t === 'dimline' || t === 'note') {
            // Defer the setTool null so we don't mutate inside a subscriber
            // callback (would re-enter the subscribe pipeline).
            queueMicrotask(() => useAppStore.getState().setTool(null))
          }
        }
      }
      // Phase 2 18a — top-level app mode change flips both dirty flags so
      // the canvas repaints with TECHNICAL's empty view (or FIELD's photo+
      // shapes+annotations). Also clears any in-progress draft so a
      // half-drawn shape doesn't survive the mode switch. Context menu is
      // closed too.
      if (state.appMode !== prev.appMode) {
        staticDirty = true
        dynamicDirty = true
        setCtxMenu(null)
        if (draft) draft = null
      }
      // Step 11 — sequence-array change OR active sequence change updates
      // the SEQUENCE-mode layer filter so the canvas reflects the new
      // visibility map immediately.
      if (state.sequences !== prev.sequences || state.activeSeqId !== prev.activeSeqId) {
        staticDirty = true
      }
      // Step 13 — annotation panel selection paints a white highlight
      // ring; flip staticDirty whenever the selection changes.
      if (state.selectedAnnotation !== prev.selectedAnnotation) {
        staticDirty = true
      }
      // Toggling the global CLines visibility flag must redraw static so
      // the lines appear/disappear without a separate mutation to clines.
      if (state.clinesVisible !== prev.clinesVisible) {
        staticDirty = true
      }
      // Spec §7 step 3 — grid overlay visibility flips redraw static.
      // P19 (May 7 2026) — gridOpacity change also redraws static so
      // the slider gives live feedback as the operator drags.
      // P16 + P38 (May 8 2026) — gridRotation + perspectiveCorners
      // changes also flip staticDirty so the operator sees live
      // updates as they type rotation OR drag corners.
      if (
        state.gridEnabled !== prev.gridEnabled
        || state.gridSize !== prev.gridSize
        || state.gridOpacity !== prev.gridOpacity
        || state.gridRotation !== prev.gridRotation
        || state.perspectiveCorners !== prev.perspectiveCorners
      ) {
        staticDirty = true
      }
      // P16 — perspective-edit mode toggle flips dynamic (corner handles
      // appear/disappear) AND static (the dotted outline still renders
      // when corners are set, but visual emphasis changes).
      if (state.perspectiveEditMode !== prev.perspectiveEditMode) {
        staticDirty = true
        dynamicDirty = true
      }
      // Spec §7 step 2 — photo background load/clear redraws static.
      // Section 7.A — when a NEW photo is set (prev was null or different
      // image), reset the viewport to fit-to-viewport so the operator
      // sees the whole photo by default. Subsequent in-session pan/zoom
      // overrides this; reload restores the persisted viewport.
      if (state.backgroundImage !== prev.backgroundImage) {
        staticDirty = true
        if (state.backgroundImage && state.photoMeta && state.backgroundImage !== prev.backgroundImage) {
          const cwL = container.clientWidth
          const chL = container.clientHeight
          // Defer one tick so the render pipeline picks up photoMeta + image
          // before the viewport-driven dirty flag flips again.
          queueMicrotask(() => {
            const s = useAppStore.getState()
            // If the operator has a persisted viewport from a prior session,
            // honor it; otherwise fit-to-viewport. P37: routes through
            // fitToViewport so the touched flag clears on auto-fit
            // (photo load + crop confirm both pass through here when
            // viewport.zoom <= 0).
            const v = s.viewport || DEFAULT_VIEWPORT_LOCAL
            if (v.zoom <= 0 || (!prev.backgroundImage && (v.panX === 0 && v.panY === 0))) {
              s.fitToViewport(cwL, chL)
            }
          })
        }
      }
      // Section 7.A — viewport / photoMeta / cropMeta change repaints.
      if (state.viewport !== prev.viewport || state.photoMeta !== prev.photoMeta) {
        staticDirty = true
        dynamicDirty = true
      }
      // Tool change clears any in-progress draft so the user doesn't end up
      // half-drawing one shape while another tool is selected.
      if (state.tool !== prev.tool && draft) {
        draft = null
        isDragging = false
        dynamicDirty = true
      }
      // Phase 2 18b — tool change also abandons any Technical Drawing
      // line draft. Mirror of the Field Markup draft clear above. Deferred
      // via queueMicrotask so the setTechDraft write doesn't re-enter the
      // subscribe pipeline mid-callback.
      if (state.tool !== prev.tool && state.techDraft) {
        queueMicrotask(() => useAppStore.getState().setTechDraft(null))
      }
    })

    return () => {
      cancelled = true
      if (rafHandle) cancelAnimationFrame(rafHandle)
      ro.disconnect()
      window.removeEventListener('resize', resizeAll)
      cvDynamic.removeEventListener('mousedown', onMouseDown)
      cvDynamic.removeEventListener('mousemove', onMouseMove)
      cvDynamic.removeEventListener('mouseup', onMouseUp)
      cvDynamic.removeEventListener('dblclick', onDblClick)
      cvDynamic.removeEventListener('contextmenu', onContextMenu)
      cvDynamic.removeEventListener('wheel', onWheel)
      cvDynamic.removeEventListener('touchstart', onTouchStart)
      cvDynamic.removeEventListener('touchmove', onTouchMove)
      cvDynamic.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      unsub()
    }
  }, [])

  // The `tool-active` class on the wrapper is the cue for the cursor change
  // (CSS .canvas-stage.tool-active .cv-dynamic { cursor: crosshair }).
  // Re-renders on tool change but the useEffect runs once — closure state
  // stays intact.
  return (
    <div
      className={tool ? 'canvas-stage tool-active' : 'canvas-stage'}
      ref={containerRef}
    >
      <canvas id="cvStatic" ref={staticCanvasRef} className="cv-static" aria-hidden="true" />
      <canvas id="cvDynamic" ref={dynamicCanvasRef} className="cv-dynamic" aria-hidden="true" />
      {/* Phase 2 18c docked pivot (May 11 2026) — TechInputPanel was
          previously mounted here as a cursor-anchored floating overlay.
          Three failed fix attempts (autofocus useEffect chain, focusin
          restorer, selective wrapper keydown listener) on the focus
          management of a child-of-canvas input revealed that the entire
          architecture was fighting the canvas event hierarchy. Pivot:
          mount the panel as a sibling of DrawingTools in App.jsx's
          .canvas-area, OUTSIDE the canvas event hierarchy. The panel
          subscribes to store state directly and owns its own commit/
          cancel paths. CanvasStage retains only the click-commit path
          (onMouseDown tech-line branch) which calls commitTechLine. */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          layerId={ctxMenu.layerId}
          shapeId={ctxMenu.shapeId}
          canvasSize={ctxMenu.canvasSize}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}
