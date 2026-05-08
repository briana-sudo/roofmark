// ============================================================================
// canvasRender.js — Step 16 (May 8 2026)
//
// Pure render helpers extracted from CanvasStage.jsx so the PDF generator
// (src/utils/generatePDF.js) and the live canvas can share one render path
// without drift risk.
//
// Each helper takes `ctx + drawable + viewport + photoSize + (layer|seq)`
// and writes to the supplied 2D canvas context. No closure deps, no store
// reads — callers thread state in via arguments. Reusable for offscreen
// canvases at print resolution as well as the operator's working canvas.
//
// CanvasStage.jsx imports these and replaces its in-effect closures.
// ============================================================================
import { photoNormToCanvas } from '../store/viewport'
import { arcCircumcircle, arcAnglesFor, ellipseParams } from './shapeGeometry'

// Cline render uses an out-of-canvas sentinel so the angled-line clipping
// happens at draw time. Matches the value formerly hardcoded in CanvasStage.
export const CLINE_SENT = 5000

// P31 + P35 (May 7 2026) — annotation render fallbacks.
//   anno.<field> ?? seq.default<Field> ?? hardcoded fallback
const ANNO_ACCENT_FALLBACK = '#f5a623'
const ANNO_FONT_SIZE_FALLBACK = 11

// P35 root-cause fix (May 7 2026) — Canvas 2D `ctx.font` does NOT resolve
// CSS custom properties (`var(--rm-sans, ...)`). Inline the literal font
// stack so the canvas font parser accepts the assignment. Same value as
// `--rm-sans` in App.css.
export const ANNO_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

// Math primitives (arcCircumcircle, arcAnglesFor, ellipseParams) live in
// src/utils/shapeGeometry.js — single source of truth shared with CanvasStage.

// ----------------------------------------------------------------------------
// drawShapeOnContext — paints one shape (poly/tri/rect/circ/arc/ellipse/line)
// to the supplied 2D context. layer color + fill/stroke flags + opacity all
// come from the layer object so per-layer styling is honored uniformly on
// the live canvas and PDF render alike.
// ----------------------------------------------------------------------------
export function drawShapeOnContext(ctx, shape, viewport, photoSize, layer) {
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
  } else if (shape.type === 'arc') {
    if (shape.pts && shape.pts.length >= 3) {
      const a = tx(shape.pts[0])
      const b = tx(shape.pts[1])
      const c = tx(shape.pts[2])
      const cc = arcCircumcircle(a, b, c)
      if (cc) {
        const { startAngle, endAngle, anticlockwise } = arcAnglesFor(a, b, c, cc.cx, cc.cy)
        ctx.beginPath()
        ctx.arc(cc.cx, cc.cy, cc.r, startAngle, endAngle, anticlockwise)
        if (strokeOn) { ctx.globalAlpha = strokeOpacity; ctx.stroke() }
      } else {
        // Collinear fallback — render as polyline through the 3 pts.
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(c.x, c.y)
        if (strokeOn) { ctx.globalAlpha = strokeOpacity; ctx.stroke() }
      }
    }
  } else if (shape.type === 'ellipse') {
    if (shape.pts && shape.pts.length >= 2) {
      const a = tx(shape.pts[0])
      const b = tx(shape.pts[1])
      const { cx, cy, rx, ry } = ellipseParams(a, b)
      if (rx > 0 && ry > 0) {
        ctx.beginPath()
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
        if (fillOn) { ctx.globalAlpha = fillOpacity; ctx.fill() }
        if (strokeOn) { ctx.globalAlpha = strokeOpacity; ctx.stroke() }
      }
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

// ----------------------------------------------------------------------------
// drawAnnotationOnContext — paints one annotation (note/callout/dimline) to
// the supplied 2D context. Color + font size resolve via 3-tier fallback
// (P31 + P35) — anno override > seq default > global fallback.
// ----------------------------------------------------------------------------
export function drawAnnotationOnContext(ctx, anno, viewport, photoSize, seq) {
  const color = (typeof anno.color === 'string' && anno.color.length > 0)
    ? anno.color
    : (seq && typeof seq.defaultAnnoColor === 'string' && seq.defaultAnnoColor.length > 0)
      ? seq.defaultAnnoColor
      : ANNO_ACCENT_FALLBACK
  const fontSize = (typeof anno.fontSize === 'number' && Number.isFinite(anno.fontSize))
    ? anno.fontSize
    : (seq && typeof seq.defaultAnnoFontSize === 'number' && Number.isFinite(seq.defaultAnnoFontSize))
      ? seq.defaultAnnoFontSize
      : ANNO_FONT_SIZE_FALLBACK
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.5
  ctx.font = `bold ${fontSize}px ${ANNO_FONT_STACK}`

  // P40 (May 8 2026) — Step 16 PDF render uses the operator-set EN/ES text,
  // not just textEN. The render path resolves the displayed label per the
  // requested language (defaults to 'en' for backward compat).
  const lang = anno.__lang || 'en' // private hint set by PDF render path
  const textForCallout = lang === 'es' ? (anno.textES || '') : (anno.textEN || '')
  const textForNote = lang === 'es' ? (anno.textES || '') : (anno.textEN || '')
  const calloutLabel = textForCallout ? textForCallout.slice(0, 24) : '?'
  const noteLabel = textForNote ? textForNote.slice(0, 24) : '?'

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
    ctx.fillStyle = color
    ctx.fillText(noteLabel, x + 10, y + 4)
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
    ctx.fillText(calloutLabel, tailX + 10, tailY + 4)
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
    // Label at midpoint (above the line in the +n direction). Dim values
    // are unit-bearing (e.g. 12'-6", 4/12) — language-agnostic, render
    // identically in EN/ES PDFs.
    const mx = (ax + bx) / 2, my = (ay + by) / 2
    const label = anno.value ? String(anno.value).slice(0, 16) : '?'
    ctx.fillText(label, mx + nx * (tickLen + 2), my + ny * (tickLen + 2))
  }
  ctx.restore()
}

// ----------------------------------------------------------------------------
// drawClinesOnContext — paints all visible construction lines to the supplied
// 2D context. Called when `clinesVisible !== false`. Translated through the
// viewport. Angled clines use a sentinel-length endpoint pair so the browser
// clips to canvas bounds at draw time.
// ----------------------------------------------------------------------------
export function drawClinesOnContext(ctx, clines, viewport, photoSize, canvasW, canvasH) {
  if (!Array.isArray(clines) || clines.length === 0) return
  ctx.save()
  ctx.strokeStyle = 'rgba(0, 255, 204, 0.5)'
  ctx.lineWidth = 1
  ctx.setLineDash([6, 4])
  for (const cl of clines) {
    if (cl.visible === false) continue
    if (cl.type === 'h') {
      const y = cl.y * photoSize.height * viewport.zoom + viewport.panY
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(canvasW, y)
      ctx.stroke()
    } else if (cl.type === 'v') {
      const x = cl.x * photoSize.width * viewport.zoom + viewport.panX
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, canvasH)
      ctx.stroke()
    } else if (cl.type === 'a') {
      const a = photoNormToCanvas({ x: cl.px, y: cl.py }, viewport, photoSize)
      const cosA = Math.cos(cl.angle)
      const sinA = Math.sin(cl.angle)
      ctx.beginPath()
      ctx.moveTo(a.x - CLINE_SENT * cosA, a.y - CLINE_SENT * sinA)
      ctx.lineTo(a.x + CLINE_SENT * cosA, a.y + CLINE_SENT * sinA)
      ctx.stroke()
    }
  }
  ctx.setLineDash([])
  ctx.restore()
}

// ----------------------------------------------------------------------------
// renderSequencePageToCanvas — Step 16 (May 8 2026)
//
// Renders one sequence's PDF page content to the supplied offscreen canvas.
// Mirrors the live canvas's drawStatic flow but at native photo resolution
// (viewport = identity). Sequence visibility filter applies (layers with
// `seq.layers[id] === false` are skipped, mirroring SEQUENCE-mode behavior).
// Annotations from this sequence render via 3-tier fallback. Clines render
// when globally visible.
//
// Caller responsibilities:
//   - canvas dims set to photoMeta.width × photoMeta.height (or print
//     resolution multiple) BEFORE calling this function
//   - photoImage is a loaded HTMLImageElement (caller awaits onload)
//   - language is 'en' | 'es' — drives the textEN/textES selection in the
//     rendered annotation labels
// ----------------------------------------------------------------------------
export function renderSequencePageToCanvas({
  canvas, sequence, layers, clines, photoImage, photoMeta,
  language = 'en', clinesVisible = false,
}) {
  if (!canvas || !photoMeta) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  // Print render uses identity viewport — photo fills the canvas.
  const viewport = { panX: 0, panY: 0, zoom: W / photoMeta.width }
  const photoSize = { width: photoMeta.width, height: photoMeta.height }

  // 1. Photo background (or solid fallback)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#0d1117'
  ctx.fillRect(0, 0, W, H)
  if (photoImage && photoImage.complete && photoImage.naturalWidth > 0) {
    ctx.drawImage(photoImage, 0, 0, W, H)
  }
  ctx.restore()

  // 2. Construction lines (skip if globally hidden)
  if (clinesVisible !== false) {
    drawClinesOnContext(ctx, clines, viewport, photoSize, W, H)
  }

  // 3. Layer shapes — sequence visibility filter applies
  const seqLayers = sequence?.layers || {}
  for (const layer of layers || []) {
    if (!layer.visible) continue
    if (seqLayers[layer.id] === false) continue
    for (const shape of layer.shapes || []) {
      drawShapeOnContext(ctx, shape, viewport, photoSize, layer)
    }
  }

  // 4. Annotations — only this sequence's annotations
  if (sequence && Array.isArray(sequence.annotations)) {
    for (const a of sequence.annotations) {
      // Pass language hint via a non-persistent property on a clone so the
      // shared drawAnnotationOnContext can pick the right text without a
      // breaking signature change.
      const clone = { ...a, __lang: language }
      drawAnnotationOnContext(ctx, clone, viewport, photoSize, sequence)
    }
  }
}

// ----------------------------------------------------------------------------
// computeContributingLayers — Step 16 (May 8 2026). Returns the list of layers
// that contribute at least one shape to the rendered page for `sequence`.
// Used to populate the PDF footer's Materials row.
// ----------------------------------------------------------------------------
export function computeContributingLayers(sequence, layers) {
  if (!Array.isArray(layers)) return []
  const seqLayers = sequence?.layers || {}
  return layers.filter((layer) => {
    if (!layer.visible) return false
    if (seqLayers[layer.id] === false) return false
    return Array.isArray(layer.shapes) && layer.shapes.length > 0
  })
}
