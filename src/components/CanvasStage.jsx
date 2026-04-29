import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'

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

// Spec §8 — snap engine pure function. Inputs in canvas px (already
// denormalized). Output { x, y, type } | null. Identical logic to the
// block test at /test/step-7-functional.html.
function getShapeCorners(shape, cw, ch) {
  if (shape.type === 'circ') return [{ x: shape.cx * cw, y: shape.cy * ch }]
  if (!shape.pts) return []
  return shape.pts.map((p) => ({ x: p.x * cw, y: p.y * ch }))
}

function getShapeEdges(shape, cw, ch) {
  if (shape.type === 'circ') return []
  if (!shape.pts || shape.pts.length < 2) return []
  const pts = shape.pts.map((p) => ({ x: p.x * cw, y: p.y * ch }))
  const edges = []
  for (let i = 0; i < pts.length - 1; i++) edges.push([pts[i], pts[i + 1]])
  if (shape.type !== 'line' && pts.length >= 3) {
    edges.push([pts[pts.length - 1], pts[0]])
  }
  return edges
}

function projectOntoCline(cursorX, cursorY, cl, cw, ch) {
  if (cl.type === 'h') return { x: cursorX, y: cl.y * ch }
  if (cl.type === 'v') return { x: cl.x * cw, y: cursorY }
  const ax = cl.px * cw, ay = cl.py * ch
  const cosA = Math.cos(cl.angle), sinA = Math.sin(cl.angle)
  const dx = cursorX - ax, dy = cursorY - ay
  const t = dx * cosA + dy * sinA
  return { x: ax + t * cosA, y: ay + t * sinA }
}

function computeSnap(args) {
  const {
    cursorX, cursorY, layers, clines,
    snapEnabled, gridEnabled, gridSize, snapTolerance,
    draft, tool, clinesVisible, cw, ch,
  } = args
  if (!snapEnabled) return null
  const tolSq = snapTolerance * snapTolerance

  // 1. CLOSE
  if ((tool === 'poly' || tool === 'tri') && draft && draft.pts && draft.pts.length >= 3) {
    const first = draft.pts[0]
    const dx = cursorX - first.x, dy = cursorY - first.y
    if (dx * dx + dy * dy < tolSq) return { x: first.x, y: first.y, type: 'close' }
  }

  // 2. GRID
  if (gridEnabled) {
    const gx = Math.round(cursorX / gridSize) * gridSize
    const gy = Math.round(cursorY / gridSize) * gridSize
    const dx = cursorX - gx, dy = cursorY - gy
    if (dx * dx + dy * dy < tolSq) return { x: gx, y: gy, type: 'grid' }
  }

  // 3. CORNER
  let bestDistSq = tolSq
  let bestPt = null
  for (const layer of layers) {
    if (!layer.visible) continue
    for (const shape of layer.shapes || []) {
      const corners = getShapeCorners(shape, cw, ch)
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
      const edges = getShapeEdges(shape, cw, ch)
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
      const proj = projectOntoCline(cursorX, cursorY, cl, cw, ch)
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

    const resizeAll = () => {
      sizeCanvas(cvStatic)
      sizeCanvas(cvDynamic)
      staticDirty = true
      dynamicDirty = true
    }
    resizeAll()

    const ro = new ResizeObserver(resizeAll)
    ro.observe(container)
    window.addEventListener('resize', resizeAll)

    // ---- Shape rendering (Spec §7 static draw step 5) ----------------------
    const drawShapeOnContext = (ctx, shape, cw, ch, layer) => {
      const color = layer?.color || '#3b82f6'
      const fillOn = layer?.fillOn !== false
      const strokeOn = layer?.strokeOn !== false
      const fillOpacity = layer?.fillOpacity ?? 0.25
      const strokeOpacity = layer?.strokeOpacity ?? 1.0
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = layer?.strokeWeight || 2

      if (shape.type === 'circ') {
        ctx.beginPath()
        ctx.arc(shape.cx * cw, shape.cy * ch, shape.r * cw, 0, Math.PI * 2)
        if (fillOn) { ctx.globalAlpha = fillOpacity; ctx.fill() }
        if (strokeOn) { ctx.globalAlpha = strokeOpacity; ctx.stroke() }
      } else if (shape.type === 'line') {
        if (shape.pts && shape.pts.length === 2) {
          ctx.beginPath()
          ctx.moveTo(shape.pts[0].x * cw, shape.pts[0].y * ch)
          ctx.lineTo(shape.pts[1].x * cw, shape.pts[1].y * ch)
          if (strokeOn) { ctx.globalAlpha = strokeOpacity; ctx.stroke() }
        }
      } else {
        // poly / tri / rect — closed path
        if (shape.pts && shape.pts.length >= 2) {
          ctx.beginPath()
          shape.pts.forEach((p, i) => {
            const x = p.x * cw, y = p.y * ch
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          })
          ctx.closePath()
          if (fillOn) { ctx.globalAlpha = fillOpacity; ctx.fill() }
          if (strokeOn) { ctx.globalAlpha = strokeOpacity; ctx.stroke() }
        }
      }
      ctx.globalAlpha = 1
    }

    // ---- Static draw -------------------------------------------------------
    const drawStatic = () => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      ctxStatic.save()
      ctxStatic.setTransform(1, 0, 0, 1, 0, 0)
      ctxStatic.clearRect(0, 0, cvStatic.width, cvStatic.height)
      ctxStatic.scale(dpr, dpr)
      // Background grid (Spec §7 static draw step 2)
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
      // Construction lines (Spec §7 static draw step 4 — rendered after the
      // background grid, before layer shapes so committed shapes paint over).
      const storeState = useAppStore.getState()
      if (storeState.clinesVisible !== false) {
        ctxStatic.strokeStyle = 'rgba(0, 255, 204, 0.5)'
        ctxStatic.lineWidth = 1
        ctxStatic.setLineDash([6, 4])
        for (const cl of storeState.clines) {
          if (cl.visible === false) continue
          if (cl.type === 'h') {
            const y = cl.y * ch
            ctxStatic.beginPath()
            ctxStatic.moveTo(0, y)
            ctxStatic.lineTo(cw, y)
            ctxStatic.stroke()
          } else if (cl.type === 'v') {
            const x = cl.x * cw
            ctxStatic.beginPath()
            ctxStatic.moveTo(x, 0)
            ctxStatic.lineTo(x, ch)
            ctxStatic.stroke()
          } else if (cl.type === 'a') {
            const ax = cl.px * cw
            const ay = cl.py * ch
            const cosA = Math.cos(cl.angle)
            const sinA = Math.sin(cl.angle)
            ctxStatic.beginPath()
            ctxStatic.moveTo(ax - CLINE_SENT * cosA, ay - CLINE_SENT * sinA)
            ctxStatic.lineTo(ax + CLINE_SENT * cosA, ay + CLINE_SENT * sinA)
            ctxStatic.stroke()
          }
        }
        ctxStatic.setLineDash([])
      }

      // Layer shapes (bottom to top, skipping invisible layers)
      const layers = storeState.layers
      for (const layer of layers) {
        if (!layer.visible) continue
        for (const shape of layer.shapes || []) {
          drawShapeOnContext(ctxStatic, shape, cw, ch, layer)
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
        }
        ctxDynamic.setLineDash([])
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
    const commitDraft = () => {
      if (!draft) return
      const cw = container.clientWidth
      const ch = container.clientHeight
      const activeLayerId = useAppStore.getState().activeLayerId
      if (!activeLayerId) {
        draft = null
        isDragging = false
        return
      }
      let shape = null
      if (draft.type === 'poly' || draft.type === 'tri' || draft.type === 'line') {
        shape = {
          type: draft.type,
          pts: draft.pts.map((p) => ({ x: p.x / cw, y: p.y / ch })),
        }
      } else if (draft.type === 'rect') {
        const x1 = Math.min(draft.startX, draft.x) / cw
        const y1 = Math.min(draft.startY, draft.y) / ch
        const x2 = Math.max(draft.startX, draft.x) / cw
        const y2 = Math.max(draft.startY, draft.y) / ch
        shape = {
          type: 'rect',
          pts: [
            { x: x1, y: y1 }, // TL
            { x: x2, y: y1 }, // TR
            { x: x2, y: y2 }, // BR
            { x: x1, y: y2 }, // BL
          ],
        }
      } else if (draft.type === 'circ') {
        // Spec §20 — coords normalized. Single scalar r is normalized to
        // canvas width; render multiplies r by current cw to scale back.
        shape = {
          type: 'circ',
          cx: draft.cx / cw,
          cy: draft.cy / ch,
          r: draft.r / cw,
        }
      }
      if (shape) useAppStore.getState().addShape(activeLayerId, shape)
      draft = null
      isDragging = false
    }

    // ---- Construction-line commit (no active layer required, lives in
    // the separate clines array per Spec §6.6).
    const commitClineDraft = () => {
      if (!draft || draft.type !== 'cline') return
      const cw = container.clientWidth
      const ch = container.clientHeight
      const dx = draft.x - draft.startX
      const dy = draft.y - draft.startY
      let cline
      if (Math.abs(dy) < ORTHO_TOL) {
        cline = { type: 'h', y: draft.startY / ch }
      } else if (Math.abs(dx) < ORTHO_TOL) {
        cline = { type: 'v', x: draft.startX / cw }
      } else {
        cline = {
          type: 'a',
          px: draft.startX / cw,
          py: draft.startY / ch,
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
      if (draft) {
        if (draft.type === 'rect' && isDragging) { draft.x = x; draft.y = y }
        else if (draft.type === 'circ' && isDragging) {
          draft.r = Math.hypot(x - draft.cx, y - draft.cy)
        }
        else if (draft.type === 'cline' && isDragging) { draft.x = x; draft.y = y }
      }
      // Spec §8 — recompute the best snap target on every mousemove.
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
        cw: container.clientWidth,
        ch: container.clientHeight,
      })
      // Avoid spurious store mutations when the snap result is unchanged
      // (cursor moved a pixel but snap target stayed the same).
      const prev = store.snapPt
      const same = (prev && snapPt
        && prev.x === snapPt.x && prev.y === snapPt.y && prev.type === snapPt.type)
        || (prev === null && snapPt === null)
      if (!same) store.setSnap(snapPt)
      dynamicDirty = true
    }

    const onMouseDown = (e) => {
      const store = useAppStore.getState()
      const t = store.tool
      const activeLayerId = store.activeLayerId
      if (!t) return
      // Shape tools commit into the active layer; cline lives in its own
      // array and doesn't need one (Spec §6.6).
      if (t !== 'cline' && !activeLayerId) return
      const raw = pointFromClient(e.clientX, e.clientY)
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
      }
      dynamicDirty = true
    }

    const onMouseUp = () => {
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

    const onKeyDown = (e) => {
      // Don't intercept while the user is typing in inputs/textareas
      // (layer rename, future annotation textareas, etc.).
      const tag = (e.target?.tagName || '').toUpperCase()
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable
      if (editable) return

      if (e.key === 'Escape' && draft) {
        draft = null
        isDragging = false
        dynamicDirty = true
        return
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

    const onTouchStart = (e) => {
      if (e.touches && e.touches.length) {
        useAppStore.getState().setPointerType('touch')
        const t = e.touches[0]
        onMouseDown({ clientX: t.clientX, clientY: t.clientY })
      }
    }
    const onTouchMove = (e) => {
      if (e.touches && e.touches.length) {
        useAppStore.getState().setPointerType('touch')
        const t = e.touches[0]
        onMouseMove({ clientX: t.clientX, clientY: t.clientY })
      }
    }
    const onTouchEnd = () => onMouseUp()

    cvDynamic.addEventListener('mousedown', onMouseDown)
    cvDynamic.addEventListener('mousemove', onMouseMove)
    cvDynamic.addEventListener('mouseup', onMouseUp)
    cvDynamic.addEventListener('dblclick', onDblClick)
    cvDynamic.addEventListener('touchstart', onTouchStart, { passive: true })
    cvDynamic.addEventListener('touchmove', onTouchMove, { passive: true })
    cvDynamic.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('keydown', onKeyDown)

    // ---- Store subscription -----------------------------------------------
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.layers !== prev.layers || state.clines !== prev.clines) {
        staticDirty = true
      }
      // Toggling the global CLines visibility flag must redraw static so
      // the lines appear/disappear without a separate mutation to clines.
      if (state.clinesVisible !== prev.clinesVisible) {
        staticDirty = true
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
      cvDynamic.removeEventListener('touchstart', onTouchStart)
      cvDynamic.removeEventListener('touchmove', onTouchMove)
      cvDynamic.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('keydown', onKeyDown)
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
    </div>
  )
}
