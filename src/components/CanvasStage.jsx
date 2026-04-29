import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  effectivePhotoSize, photoNormToCanvas, canvasToPhotoNorm,
  computeFitViewport, clampPan, zoomAtCursor, clampZoom,
} from '../store/viewport'
import ContextMenu from './ContextMenu'

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
    snapEnabled, gridEnabled, gridSize, snapTolerance,
    draft, tool, clinesVisible, viewport, photoSize,
  } = args
  if (!snapEnabled) return null
  const tolSq = snapTolerance * snapTolerance

  // 1. CLOSE — draft polygon points are stored in canvas px (since draft
  // is built incrementally as the operator clicks), so this comparison
  // stays in canvas px.
  if ((tool === 'poly' || tool === 'tri') && draft && draft.pts && draft.pts.length >= 3) {
    const first = draft.pts[0]
    const dx = cursorX - first.x, dy = cursorY - first.y
    if (dx * dx + dy * dy < tolSq) return { x: first.x, y: first.y, type: 'close' }
  }

  // 2. GRID — Step 10 / P12+P14 rectangular grid in PHOTO px. Snap targets
  // are at integer multiples of (gridSize.x, gridSize.y) in photo space;
  // translate to canvas px before the distance test so the on-screen
  // tolerance remains pixel-true regardless of zoom.
  if (gridEnabled) {
    const gxStep = (typeof gridSize === 'object' ? gridSize.x : gridSize) || 20
    const gyStep = (typeof gridSize === 'object' ? gridSize.y : gridSize) || 20
    // Convert cursor to photo-px to find the nearest grid intersection.
    const cursorPhotoX = (cursorX - viewport.panX) / viewport.zoom
    const cursorPhotoY = (cursorY - viewport.panY) / viewport.zoom
    const gxPhoto = Math.round(cursorPhotoX / gxStep) * gxStep
    const gyPhoto = Math.round(cursorPhotoY / gyStep) * gyStep
    // Translate back to canvas px for the distance test + the snap point.
    const gx = gxPhoto * viewport.zoom + viewport.panX
    const gy = gyPhoto * viewport.zoom + viewport.panY
    const dx = cursorX - gx, dy = cursorY - gy
    if (dx * dx + dy * dy < tolSq) return { x: gx, y: gy, type: 'grid' }
  }

  // 3. CORNER
  let bestDistSq = tolSq
  let bestPt = null
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

  // 4. MIDPOINT
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

  // 5. CLINE
  if (clinesVisible !== false) {
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

    // Section 7.A — viewport pan state (closure-scoped). Set when a pan
    // input begins (middle-mouse, space+left, two-finger touch); applies
    // delta to the store viewport on each move; cleared on release.
    //   originCursor: cursor canvas-px at pan start
    //   originPan:    {panX, panY} at pan start
    //   trigger:      'middle' | 'space' | 'touch' (informational)
    let panDrag = null
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
      // Section 7.A — when canvas dims change AND a photo is loaded but
      // its viewport zoom is below the new fit-to-viewport floor, raise
      // it so the photo stays visible. Pan is also clamped to keep ≥10%
      // of photo on-screen.
      const s = useAppStore.getState()
      if (s.photoMeta) {
        const cw = container.clientWidth
        const ch = container.clientHeight
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
    }
    // Default viewport literal for closure (matches store's DEFAULT_VIEWPORT
    // — kept inline to avoid an extra import).
    const DEFAULT_VIEWPORT_LOCAL = { panX: 0, panY: 0, zoom: 1 }
    resizeAll()

    const ro = new ResizeObserver(resizeAll)
    ro.observe(container)
    window.addEventListener('resize', resizeAll)

    // ---- Annotation rendering (Step 12, Spec §12) -------------------------
    // Renders one annotation. Section 7.A — translate normalized photo coords
    // to canvas px via the viewport. Pin geometry (size of dot, tick length,
    // diamond size) intentionally stays in canvas px so labels remain legible
    // regardless of zoom (similar to dimension labels in CAD apps).
    const ANNO_ACCENT = '#f5a623' // amber — distinct from layer colors
    const drawAnnotationOnContext = (ctx, anno, viewport, photoSize) => {
      ctx.save()
      ctx.strokeStyle = ANNO_ACCENT
      ctx.fillStyle = ANNO_ACCENT
      ctx.lineWidth = 1.5
      ctx.font = 'bold 11px var(--rm-sans, sans-serif)'

      if (anno.type === 'note') {
        const at = photoNormToCanvas(anno.at, viewport, photoSize)
        const x = at.x
        const y = at.y
        // Pin: filled circle + center dot in white
        ctx.beginPath()
        ctx.arc(x, y, 7, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#000'
        ctx.beginPath()
        ctx.arc(x, y, 2, 0, Math.PI * 2)
        ctx.fill()
        // Body indicator: "?" placeholder until Step 13 adds the text panel
        const label = anno.textEN ? anno.textEN.slice(0, 24) : '?'
        ctx.fillStyle = ANNO_ACCENT
        ctx.fillText(label, x + 10, y + 4)
      } else if (anno.type === 'callout') {
        const tipPt  = photoNormToCanvas(anno.tip,  viewport, photoSize)
        const tailPt = photoNormToCanvas(anno.tail, viewport, photoSize)
        const tipX = tipPt.x, tipY = tipPt.y
        const tailX = tailPt.x, tailY = tailPt.y
        // Tip: small filled diamond (caller end)
        ctx.beginPath()
        ctx.moveTo(tipX, tipY - 5); ctx.lineTo(tipX + 5, tipY)
        ctx.lineTo(tipX, tipY + 5); ctx.lineTo(tipX - 5, tipY)
        ctx.closePath()
        ctx.fill()
        // Lead line tip → tail
        ctx.beginPath()
        ctx.moveTo(tipX, tipY)
        ctx.lineTo(tailX, tailY)
        ctx.stroke()
        // Tail: hollow circle marker around the label anchor
        ctx.beginPath()
        ctx.arc(tailX, tailY, 6, 0, Math.PI * 2)
        ctx.stroke()
        const label = anno.textEN ? anno.textEN.slice(0, 24) : '?'
        ctx.fillText(label, tailX + 10, tailY + 4)
      } else if (anno.type === 'dimline') {
        const aP = photoNormToCanvas(anno.a, viewport, photoSize)
        const bP = photoNormToCanvas(anno.b, viewport, photoSize)
        const ax = aP.x, ay = aP.y, bx = bP.x, by = bP.y
        const dx = bx - ax, dy = by - ay
        const len = Math.hypot(dx, dy) || 1
        const ux = dx / len, uy = dy / len
        const nx = -uy, ny = ux // perpendicular unit vector
        const tickLen = 6
        // Main line
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
        ctx.stroke()
        // Extension ticks at each endpoint perpendicular to the line
        ctx.beginPath()
        ctx.moveTo(ax + nx * tickLen, ay + ny * tickLen)
        ctx.lineTo(ax - nx * tickLen, ay - ny * tickLen)
        ctx.moveTo(bx + nx * tickLen, by + ny * tickLen)
        ctx.lineTo(bx - nx * tickLen, by - ny * tickLen)
        ctx.stroke()
        // Label at midpoint (above the line in the +n direction)
        const mx = (ax + bx) / 2, my = (ay + by) / 2
        const label = anno.value ? String(anno.value).slice(0, 16) : '?'
        ctx.fillText(label, mx + nx * (tickLen + 2), my + ny * (tickLen + 2))
      }
      ctx.restore()
    }

    // ---- Shape rendering (Spec §7 static draw step 5) ----------------------
    // Section 7.A — translate normalized photo coords to canvas px via the
    // viewport. Stroke weight stays in canvas px (visual stroke thickness
    // is operator-tuning, not photo-anchored). Circle radius scales WITH
    // zoom because `r` is normalized to photo width.
    const drawShapeOnContext = (ctx, shape, viewport, photoSize, layer) => {
      const color = layer?.color || '#3b82f6'
      const fillOn = layer?.fillOn !== false
      const strokeOn = layer?.strokeOn !== false
      const fillOpacity = layer?.fillOpacity ?? 0.25
      const strokeOpacity = layer?.strokeOpacity ?? 1.0
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = layer?.strokeWeight || 2

      const tx = (p) => photoNormToCanvas(p, viewport, photoSize)
      if (shape.type === 'circ') {
        const c = tx({ x: shape.cx, y: shape.cy })
        const rPx = shape.r * photoSize.width * viewport.zoom
        ctx.beginPath()
        ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2)
        if (fillOn) { ctx.globalAlpha = fillOpacity; ctx.fill() }
        if (strokeOn) { ctx.globalAlpha = strokeOpacity; ctx.stroke() }
      } else if (shape.type === 'line') {
        if (shape.pts && shape.pts.length === 2) {
          const a = tx(shape.pts[0]), b = tx(shape.pts[1])
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          if (strokeOn) { ctx.globalAlpha = strokeOpacity; ctx.stroke() }
        }
      } else {
        // poly / tri / rect — closed path
        if (shape.pts && shape.pts.length >= 2) {
          ctx.beginPath()
          shape.pts.forEach((p, i) => {
            const c = tx(p)
            if (i === 0) ctx.moveTo(c.x, c.y)
            else ctx.lineTo(c.x, c.y)
          })
          ctx.closePath()
          if (fillOn) { ctx.globalAlpha = fillOpacity; ctx.fill() }
          if (strokeOn) { ctx.globalAlpha = strokeOpacity; ctx.stroke() }
        }
      }
      ctx.globalAlpha = 1
    }

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
      // grid lives in PHOTO px (so e.g. X=24 px / 1" stays 1" regardless
      // of zoom). Compute the visible photo-px range that overlaps the
      // canvas, then iterate grid steps within it.
      if (storeState.gridEnabled) {
        const gs = storeState.gridSize
        const gxStep = (typeof gs === 'object' ? gs.x : gs) || 20
        const gyStep = (typeof gs === 'object' ? gs.y : gs) || 20
        const z = viewport.zoom || 1
        // Visible photo-px range within the canvas:
        const photoX0 = Math.max(0, (-viewport.panX) / z)
        const photoX1 = Math.min(photoSize.width,  (cw - viewport.panX) / z)
        const photoY0 = Math.max(0, (-viewport.panY) / z)
        const photoY1 = Math.min(photoSize.height, (ch - viewport.panY) / z)
        ctxStatic.strokeStyle = 'rgba(0, 255, 204, 0.16)'
        ctxStatic.lineWidth = 1
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
        for (const a of activeSeq.annotations) drawAnnotationOnContext(ctxStatic, a, viewport, photoSize)
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
        } else if (draft.type === 'rect' && isDragging) {
          ctxDynamic.strokeRect(
            draft.startX,
            draft.startY,
            draft.x - draft.startX,
            draft.y - draft.startY
          )
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
      } else if (draft.type === 'rect') {
        const x1c = Math.min(draft.startX, draft.x), x2c = Math.max(draft.startX, draft.x)
        const y1c = Math.min(draft.startY, draft.y), y2c = Math.max(draft.startY, draft.y)
        const tl = toNorm({ x: x1c, y: y1c })
        const tr = toNorm({ x: x2c, y: y1c })
        const br = toNorm({ x: x2c, y: y2c })
        const bl = toNorm({ x: x1c, y: y2c })
        shape = { type: 'rect', pts: [tl, tr, br, bl] }
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
        store.setPan(next.panX, next.panY)
        dynamicDirty = true
        return
      }
      if (draft) {
        if (draft.type === 'rect' && isDragging) { draft.x = x; draft.y = y }
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
        gridEnabled: store.gridEnabled,
        gridSize: store.gridSize,
        snapTolerance: store.snapTolerance,
        draft,
        tool: store.tool,
        clinesVisible: store.clinesVisible,
        viewport: store.viewport,
        photoSize: photoSizeLocal,
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

      // Spec §9 — EDIT mode branches BEFORE the tool dispatch.
      // Section 7.A — handle / hit-test math uses viewport so a zoomed-in
      // shape gets a 7-canvas-px handle just like a zoomed-out one.
      if (store.mode === 'EDIT') {
        // Don't intercept right-clicks (handled by onContextMenu instead).
        if (e.button === 2) return
        const photoSizeMD = effectivePhotoSize(store.photoMeta, cw, ch)
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
                editDrag = {
                  mode: 'point',
                  layerId: sel.layerId,
                  shapeId: sel.shapeId,
                  pointIndex: i,
                  originShape: JSON.parse(JSON.stringify(shape)),
                  originCursor: { x: raw.x, y: raw.y },
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
        } else {
          store.clearSelection()
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
      if (editDrag) {
        editDrag = null
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
      store.setViewport({ zoom: v.zoom, panX: clamped.panX, panY: clamped.panY })
    }
    const fitViewport = () => {
      const store = useAppStore.getState()
      const cwL = container.clientWidth
      const chL = container.clientHeight
      const ps = effectivePhotoSize(store.photoMeta, cwL, chL)
      store.setViewport(computeFitViewport(ps, cwL, chL))
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
        // clear selection. Each layer is independent so Escape always
        // unwinds the topmost interaction.
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
        const s = useAppStore.getState()
        if (s.mode === 'EDIT' && s.selected) {
          s.clearSelection()
          return
        }
      }

      // Spec §9 — Delete / Backspace removes the selected shape (no
      // confirm dialog per spec; rely on undo).
      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        const s = useAppStore.getState()
        if (s.mode === 'EDIT' && s.selected) {
          e.preventDefault()
          s.deleteShape(s.selected.layerId, s.selected.shapeId)
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
      // Step 11 — sequence-array change OR active sequence change updates
      // the SEQUENCE-mode layer filter so the canvas reflects the new
      // visibility map immediately.
      if (state.sequences !== prev.sequences || state.activeSeqId !== prev.activeSeqId) {
        staticDirty = true
      }
      // Toggling the global CLines visibility flag must redraw static so
      // the lines appear/disappear without a separate mutation to clines.
      if (state.clinesVisible !== prev.clinesVisible) {
        staticDirty = true
      }
      // Spec §7 step 3 — grid overlay visibility flips redraw static.
      if (state.gridEnabled !== prev.gridEnabled || state.gridSize !== prev.gridSize) {
        staticDirty = true
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
            // honor it; otherwise fit-to-viewport.
            const v = s.viewport || DEFAULT_VIEWPORT_LOCAL
            if (v.zoom <= 0 || (!prev.backgroundImage && (v.panX === 0 && v.panY === 0))) {
              s.setViewport(computeFitViewport(s.photoMeta, cwL, chL))
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
