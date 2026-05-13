// ============================================================================
// shopDrawingSvgMath.js — Phase 2 sub-step 18h (May 12 2026)
//
// Pure math helpers extracted from shopDrawingSvgRender.jsx so the
// eval-shim test runner can load them without a JSX parser. Mirrors
// kcc-shop-drawing.py v1.1's geometry math (_rotate_geometry,
// _compute_bbox, _compute_fit_scale).
//
// Render-side (JSX emission) stays in shopDrawingSvgRender.jsx —
// imports from this module for the math, layers JSX on top.
// ============================================================================

// v1.1 color palette — locked-template colors
export const KCC_NAVY    = '#1A2F4A'
export const KCC_ORANGE  = '#E8630A'
export const DIM_AMBER   = '#B8860B'
export const GRID_LIGHT  = '#C8D8E8'
export const TEXT_DIM    = '#666666'

// v1.1 PDF dimensions (points)
export const PDF_PT_PER_PX = 72.0 / 24.0  // = 3.0, v1.1 "1:1" ratio

// v1.1 DRAW_FIT_MARGIN equivalent
export const FIT_MARGIN_PT = 18.0

// Geometry render defaults (mirror v1.1)
export const DEFAULT_FILL_OPACITY   = 0.25
export const DEFAULT_STROKE_OPACITY = 1.0
export const DEFAULT_STROKE_WEIGHT  = 1.6

// Grid + crosshair styling
export const GRID_SPACING_PT = 36.0
export const GRID_SW         = 0.25
export const CROSSHAIR_LEN   = 10
export const CROSSHAIR_SW    = 1.0

// Dimension styling
export const DIM_EXTENSION_OFFSET = 14.0
export const DIM_LINE_SW          = 0.8
export const DIM_ARROW_LEN        = 6.0
export const DIM_ARROW_HALF_W     = 2.5
export const DIM_LABEL_SIZE       = 8

/**
 * Apply geometryRotation (0/90/180/270) to all geometry points around
 * the bbox centroid. Mirrors v1.1 Python's _rotate_geometry math.
 */
export function rotateGeometry(layers, degrees) {
  if (degrees === 0 || !Array.isArray(layers) || layers.length === 0) {
    return layers
  }
  const bbox = computeBbox(layers)
  if (!bbox) return layers
  const cx = (bbox.minX + bbox.maxX) / 2
  const cy = (bbox.minY + bbox.maxY) / 2

  const rot = (x, y) => {
    if (degrees === 90)  return { x: cx + (y - cy), y: cy - (x - cx) }
    if (degrees === 180) return { x: 2 * cx - x,    y: 2 * cy - y     }
    if (degrees === 270) return { x: cx - (y - cy), y: cy + (x - cx)  }
    return { x, y }
  }
  return layers.map((layer) => ({
    ...layer,
    shapes: (layer.shapes || []).map((sh) => {
      if (!sh) return sh
      if (sh.type === 'circ') {
        const r = rot(sh.cx || 0, sh.cy || 0)
        return { ...sh, cx: r.x, cy: r.y }
      }
      if (Array.isArray(sh.pts)) {
        return { ...sh, pts: sh.pts.map((p) => rot(p.x, p.y)) }
      }
      return sh
    }),
    dimensions: (layer.dimensions || []).map((d) => {
      if (!d) return d
      // Phase 2 18k — angular dim rotation: rotate vertex/p1/p2 around
      // bbox centroid; radius is rotation-invariant. Mirrors the v1.2
      // Python pre-pass at _rotate_geometry's angular branch.
      if (d.type === 'angular') {
        const v = d.vertex ? rot(d.vertex.x || 0, d.vertex.y || 0) : null
        const p1 = d.p1 ? rot(d.p1.x || 0, d.p1.y || 0) : null
        const p2 = d.p2 ? rot(d.p2.x || 0, d.p2.y || 0) : null
        return {
          ...d,
          vertex: v ? { x: v.x, y: v.y } : d.vertex,
          p1: p1 ? { x: p1.x, y: p1.y } : d.p1,
          p2: p2 ? { x: p2.x, y: p2.y } : d.p2,
        }
      }
      const p1 = rot(d.x1 || 0, d.y1 || 0)
      const p2 = rot(d.x2 || 0, d.y2 || 0)
      return { ...d, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
    }),
    callouts: (layer.callouts || []).map((c) => {
      if (!c) return c
      const tip  = rot(c.tipX  || 0, c.tipY  || 0)
      const tail = rot(c.tailX || 0, c.tailY || 0)
      return { ...c, tipX: tip.x, tipY: tip.y, tailX: tail.x, tailY: tail.y }
    }),
  }))
}

/**
 * Compute bounding box of all geometry. Mirrors v1.1 _compute_bbox.
 */
export function computeBbox(layers) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let any = false
  const acc = (x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number') return
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    any = true
  }
  for (const layer of layers || []) {
    if (!layer) continue
    for (const sh of layer.shapes || []) {
      if (!sh) continue
      if (sh.type === 'circ') {
        const cx = sh.cx || 0, cy = sh.cy || 0, r = sh.r || 0
        acc(cx - r, cy - r); acc(cx + r, cy + r)
      } else if (Array.isArray(sh.pts)) {
        for (const p of sh.pts) acc(p.x, p.y)
      }
    }
    for (const d of layer.dimensions || []) {
      if (!d) continue
      // Phase 2 18k — angular dim bbox: vertex + p1 + p2 + 4 cardinal
      // radius points (so the arc itself, which can extend in any
      // direction from the vertex up to `radius` distance, never
      // clips the fit area). Mirrors v1.2 Python _compute_bbox's
      // angular branch.
      if (d.type === 'angular') {
        const v = d.vertex || { x: 0, y: 0 }
        const p1 = d.p1 || { x: 0, y: 0 }
        const p2 = d.p2 || { x: 0, y: 0 }
        const r = typeof d.radius === 'number' ? d.radius : 0
        acc(v.x, v.y); acc(p1.x, p1.y); acc(p2.x, p2.y)
        acc(v.x + r, v.y); acc(v.x - r, v.y)
        acc(v.x, v.y + r); acc(v.x, v.y - r)
        continue
      }
      acc(d.x1, d.y1); acc(d.x2, d.y2)
    }
    for (const ca of layer.callouts || []) {
      if (!ca) continue
      acc(ca.tipX, ca.tipY); acc(ca.tailX, ca.tailY)
    }
  }
  if (!any) return null
  return { minX, minY, maxX, maxY }
}

/**
 * Compute fit transform per fitMode. Returns
 *   { scale, tx, ty, overflow, bw, bh, fw, fh }
 *
 * scale + tx + ty feed makeTxPt below; overflow flag tells the renderer
 * to show a warning banner (preview does NOT throw; v1.1 Python does).
 */
export function computeFitTransform(bbox, drawingAreaPx_w, drawingAreaPx_h, fitMode, customScale) {
  if (!bbox) {
    return { scale: 1, tx: 0, ty: 0, overflow: false, bw: 0, bh: 0, fw: 0, fh: 0 }
  }
  const bw = Math.max(bbox.maxX - bbox.minX, 1e-6)
  const bh = Math.max(bbox.maxY - bbox.minY, 1e-6)

  const fitInset = Math.min(drawingAreaPx_w, drawingAreaPx_h) * 0.05
  const fw = Math.max(drawingAreaPx_w - 2 * fitInset, 1e-6)
  const fh = Math.max(drawingAreaPx_h - 2 * fitInset, 1e-6)

  let scale, overflow = false
  if (fitMode === '1:1') {
    scale = 96.0 / 24.0  // 4.0 preview px per JSON px (screen 1:1)
    overflow = (bw * scale > fw) || (bh * scale > fh)
  } else if (fitMode === 'custom') {
    const cs = typeof customScale === 'number' && customScale > 0 ? customScale : 1.0
    scale = (96.0 / 24.0) * cs
    overflow = (bw * scale > fw) || (bh * scale > fh)
  } else {
    scale = Math.min(fw / bw, fh / bh)
  }

  const fitX0 = fitInset
  const fitY1 = drawingAreaPx_h - fitInset
  const tx = fitX0 + (fw - bw * scale) / 2 - bbox.minX * scale
  const ty = fitY1 - (fh - bh * scale) / 2 + bbox.minY * scale

  return { scale, tx, ty, overflow, bw, bh, fw, fh }
}

/**
 * Closure factory for tx_pt(x, y) → [svgX, svgY] mapping. y-flip baked in.
 */
export function makeTxPt(scale, tx, ty) {
  return (x, y) => [tx + x * scale, ty - y * scale]
}
