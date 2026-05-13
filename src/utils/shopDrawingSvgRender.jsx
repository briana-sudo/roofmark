// ============================================================================
// shopDrawingSvgRender.jsx — Phase 2 sub-step 18h (May 12 2026)
//
// SVG renderer for the Technical Drawing preview. Renders the same
// geometry that kcc-shop-drawing.py v1.1 will produce for the PDF, so
// the operator can verify the layout BEFORE kicking off the proxy /
// Code Execution Tool run.
//
// Not a Konva swap — RoofMark uses raw Canvas 2D for its live canvas,
// but the preview is a separate visualization sized for the operator's
// screen + bound to the v1.1 page geometry. Pure JSX output.
//
// Architecture:
//   - Pure math helpers (rotateGeometry, computeBbox, computeFitTransform,
//     makeTxPt) live in shopDrawingSvgMath.js — testable via eval-shim
//     without a JSX parser. This file re-exports them so callers can
//     stay on one import.
//   - renderShopDrawingSVG(...) is the JSX entry. Returns an <svg> element
//     with shapes / dimensions / corner crosshairs / faint grid.
//   - Title-block surround (header / orange stripe / spec table / footer)
//     is HTML/CSS in TechnicalPreview.jsx, NOT in this module. The SVG
//     is just the drawing-area content.
//
// Color palette mirrors v1.1.
// ============================================================================

import { formatArchitecturalLength } from './formatArchitecturalLength'
import {
  KCC_NAVY, KCC_ORANGE, DIM_AMBER, GRID_LIGHT, TEXT_DIM,
  DEFAULT_FILL_OPACITY, DEFAULT_STROKE_OPACITY, DEFAULT_STROKE_WEIGHT,
  GRID_SPACING_PT, GRID_SW, CROSSHAIR_LEN, CROSSHAIR_SW,
  DIM_EXTENSION_OFFSET, DIM_LINE_SW, DIM_ARROW_LEN, DIM_ARROW_HALF_W, DIM_LABEL_SIZE,
  rotateGeometry, computeBbox, computeFitTransform, makeTxPt,
} from './shopDrawingSvgMath'

// Re-export math helpers + constants so callers can stay on one import.
export {
  KCC_NAVY, KCC_ORANGE, DIM_AMBER, GRID_LIGHT, TEXT_DIM,
  DEFAULT_FILL_OPACITY, DEFAULT_STROKE_OPACITY, DEFAULT_STROKE_WEIGHT,
  rotateGeometry, computeBbox, computeFitTransform, makeTxPt,
}

/**
 * Resolve dim label for display. RoofMark dimension shapes carry
 * pre-computed pxDist (set in specTableJSON.dimensionFromRoofMarkDim)
 * — convert to inches and format architecturally for the preview. v1.1
 * Python uses the `value` field verbatim; preview renders it the same
 * way the PDF will look so the operator sees what they'll get.
 */
function dimLabel(dim) {
  if (dim && typeof dim.value === 'string' && dim.value.trim()) {
    return dim.value.trim()
  }
  if (dim && typeof dim.pxDist === 'number') {
    return formatArchitecturalLength(dim.pxDist / 24.0) || ''
  }
  if (dim && typeof dim.x1 === 'number') {
    const dx = (dim.x2 || 0) - dim.x1
    const dy = (dim.y2 || 0) - (dim.y1 || 0)
    return formatArchitecturalLength(Math.hypot(dx, dy) / 24.0) || ''
  }
  return ''
}

/** Render one shape as JSX. */
function renderShape(shape, key, layer, txPt) {
  const color = (shape.color) || (layer && layer.color) || KCC_NAVY
  const fillOp = (typeof shape.fillOpacity === 'number') ? shape.fillOpacity
    : (typeof layer?.fillOpacity === 'number') ? layer.fillOpacity
    : DEFAULT_FILL_OPACITY
  const strokeOp = (typeof shape.strokeOpacity === 'number') ? shape.strokeOpacity
    : (typeof layer?.strokeOpacity === 'number') ? layer.strokeOpacity
    : DEFAULT_STROKE_OPACITY
  const sw = (typeof shape.strokeWeight === 'number') ? shape.strokeWeight
    : (typeof layer?.strokeWeight === 'number') ? layer.strokeWeight
    : DEFAULT_STROKE_WEIGHT
  const fillOn = shape.fillOn !== false && layer?.fillOn !== false
  const strokeOn = shape.strokeOn !== false && layer?.strokeOn !== false

  if (shape.type === 'circ') {
    const [cx, cy] = txPt(shape.cx || 0, shape.cy || 0)
    const [cx2] = txPt((shape.cx || 0) + (shape.r || 0), shape.cy || 0)
    const rPx = Math.abs(cx2 - cx)
    return (
      <circle
        key={key}
        cx={cx} cy={cy} r={rPx}
        fill={fillOn ? color : 'none'}
        fillOpacity={fillOn ? fillOp : 0}
        stroke={strokeOn ? color : 'none'}
        strokeOpacity={strokeOn ? strokeOp : 0}
        strokeWidth={sw}
      />
    )
  }
  if (shape.type === 'line' && Array.isArray(shape.pts) && shape.pts.length >= 2) {
    const [x1, y1] = txPt(shape.pts[0].x, shape.pts[0].y)
    const [x2, y2] = txPt(shape.pts[1].x, shape.pts[1].y)
    return (
      <line
        key={key}
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={strokeOn ? color : 'none'}
        strokeOpacity={strokeOn ? strokeOp : 0}
        strokeWidth={sw}
      />
    )
  }
  if ((shape.type === 'poly' || shape.type === 'tri' || shape.type === 'rect')
    && Array.isArray(shape.pts) && shape.pts.length >= 2) {
    const d = shape.pts.map((p, i) => {
      const [px, py] = txPt(p.x, p.y)
      return `${i === 0 ? 'M' : 'L'}${px} ${py}`
    }).join(' ') + ' Z'
    return (
      <path
        key={key}
        d={d}
        fill={fillOn ? color : 'none'}
        fillOpacity={fillOn ? fillOp : 0}
        stroke={strokeOn ? color : 'none'}
        strokeOpacity={strokeOn ? strokeOp : 0}
        strokeWidth={sw}
      />
    )
  }
  return null
}

/**
 * Phase 2 18k — Render an angular dimension as SVG. Mirrors v1.2 Python
 * _render_angular_dim's output shape:
 *   - Arc (smaller sweep) at radius from vertex
 *   - Extension lines along each ray from far endpoint past arc
 *   - Tangent arrow tips at arc endpoints
 *   - Label at mid-angle outside arc with white-bg pad
 *
 * SVG arc uses <path d="M{x1},{y1} A{rx},{ry} 0 {largeArc},{sweepFlag}
 * {x2},{y2}" />. largeArc=0 + sweepFlag=0 picks the smaller-sweep CCW
 * arc; we choose flags from the sign of the normalized sweep.
 */
function renderAngularDim(dim, key, txPt) {
  if (!dim || !dim.vertex || !dim.p1 || !dim.p2) return null
  const [vx, vy] = txPt(dim.vertex.x || 0, dim.vertex.y || 0)
  const [p1x, p1y] = txPt(dim.p1.x || 0, dim.p1.y || 0)
  const [p2x, p2y] = txPt(dim.p2.x || 0, dim.p2.y || 0)
  // Derive radius in screen pt by transforming vertex + (radius, 0) and
  // measuring the resulting distance. Picks up the fit scale.
  const radius_px = typeof dim.radius === 'number' && dim.radius > 0 ? dim.radius : 24
  const [rax, ray] = txPt((dim.vertex.x || 0) + radius_px, dim.vertex.y || 0)
  const radius = Math.hypot(rax - vx, ray - vy)
  if (radius < 1e-6) return null

  // Ray angles in screen space. tx_pt y-flips so atan2 here operates on
  // the post-flip vectors directly — the angle we render is what the
  // operator sees on the preview / PDF page.
  const a1 = Math.atan2(p1y - vy, p1x - vx)
  const a2 = Math.atan2(p2y - vy, p2x - vx)
  let sweep = a2 - a1
  while (sweep > Math.PI) sweep -= 2 * Math.PI
  while (sweep < -Math.PI) sweep += 2 * Math.PI

  const arcStartX = vx + radius * Math.cos(a1)
  const arcStartY = vy + radius * Math.sin(a1)
  const arcEndX   = vx + radius * Math.cos(a1 + sweep)
  const arcEndY   = vy + radius * Math.sin(a1 + sweep)

  // SVG arc flags: largeArc=0 (we always pick smaller arc); sweep=1 for
  // CCW (positive sweep), 0 for CW.
  const sweepFlag = sweep >= 0 ? 1 : 0
  const arcD = `M${arcStartX} ${arcStartY} A${radius} ${radius} 0 0 ${sweepFlag} ${arcEndX} ${arcEndY}`

  // Extension lines along each ray. Unit vector from vertex toward each
  // far point.
  const u1L = Math.hypot(p1x - vx, p1y - vy) || 1
  const u1x = (p1x - vx) / u1L, u1y = (p1y - vy) / u1L
  const u2L = Math.hypot(p2x - vx, p2y - vy) || 1
  const u2x = (p2x - vx) / u2L, u2y = (p2y - vy) / u2L
  const extPast = DIM_EXTENSION_OFFSET
  const ext1x = vx + (radius + extPast) * u1x
  const ext1y = vy + (radius + extPast) * u1y
  const ext2x = vx + (radius + extPast) * u2x
  const ext2y = vy + (radius + extPast) * u2y

  // Tangent arrow tips. Tangent at start (along arc CCW) = (-sin a1, cos a1).
  // For CW sweep, flip sign.
  const sweepSign = sweep >= 0 ? 1 : -1
  const tStartX = -Math.sin(a1) * sweepSign
  const tStartY =  Math.cos(a1) * sweepSign
  const tEndX  =  Math.sin(a1 + sweep) * sweepSign
  const tEndY  = -Math.cos(a1 + sweep) * sweepSign

  const arrow = (tipX, tipY, dirX, dirY, akey) => {
    const bx = tipX - dirX * DIM_ARROW_LEN
    const by = tipY - dirY * DIM_ARROW_LEN
    const apx = dirY, apy = -dirX
    const p1ax = bx + apx * DIM_ARROW_HALF_W
    const p1ay = by + apy * DIM_ARROW_HALF_W
    const p2ax = bx - apx * DIM_ARROW_HALF_W
    const p2ay = by - apy * DIM_ARROW_HALF_W
    return (
      <path
        key={akey}
        d={`M${tipX} ${tipY} L${p1ax} ${p1ay} L${p2ax} ${p2ay} Z`}
        fill={DIM_AMBER} stroke="none"
      />
    )
  }

  // Label at mid-angle outside arc.
  const midAngle = a1 + sweep / 2
  const labelRadius = radius + 12
  const lx = vx + labelRadius * Math.cos(midAngle)
  const ly = vy + labelRadius * Math.sin(midAngle)
  const label = (typeof dim.value === 'string' && dim.value.trim()) ? dim.value.trim() : ''

  return (
    <g key={key} data-dim-type="angular">
      {/* Extension lines */}
      <line x1={p1x} y1={p1y} x2={ext1x} y2={ext1y}
        stroke={DIM_AMBER} strokeWidth={DIM_LINE_SW} />
      <line x1={p2x} y1={p2y} x2={ext2x} y2={ext2y}
        stroke={DIM_AMBER} strokeWidth={DIM_LINE_SW} />
      {/* Arc */}
      <path d={arcD} fill="none" stroke={DIM_AMBER} strokeWidth={DIM_LINE_SW} />
      {/* Tangent arrow tips */}
      {arrow(arcStartX, arcStartY, tStartX, tStartY, 'a1')}
      {arrow(arcEndX,   arcEndY,   tEndX,   tEndY,   'a2')}
      {label && (
        <g>
          <rect
            x={lx - label.length * DIM_LABEL_SIZE * 0.3 - 2}
            y={ly - DIM_LABEL_SIZE * 0.9}
            width={label.length * DIM_LABEL_SIZE * 0.6 + 4}
            height={DIM_LABEL_SIZE + 4}
            fill="white" stroke="none"
          />
          <text
            x={lx} y={ly}
            fontFamily="Helvetica, Arial, sans-serif"
            fontSize={DIM_LABEL_SIZE}
            fontWeight="bold"
            fill={DIM_AMBER}
            textAnchor="middle"
          >
            {label}
          </text>
        </g>
      )}
    </g>
  )
}

/** Render one dimension. Dispatches on dim.type (default 'linear'). */
function renderDimension(dim, key, txPt) {
  if (!dim) return null
  if (dim.type === 'angular') return renderAngularDim(dim, key, txPt)
  const [x1, y1] = txPt(dim.x1 || 0, dim.y1 || 0)
  const [x2, y2] = txPt(dim.x2 || 0, dim.y2 || 0)
  const dx = x2 - x1, dy = y2 - y1
  const L = Math.hypot(dx, dy)
  if (L < 1e-6) return null
  const ux = dx / L, uy = dy / L
  const px = uy,  py = -ux
  const ox = px * DIM_EXTENSION_OFFSET
  const oy = py * DIM_EXTENSION_OFFSET
  const ax1 = x1 + ox, ay1 = y1 + oy
  const ax2 = x2 + ox, ay2 = y2 + oy

  const arrow = (tipX, tipY, dirX, dirY, akey) => {
    const bx = tipX - dirX * DIM_ARROW_LEN
    const by = tipY - dirY * DIM_ARROW_LEN
    const apx = dirY, apy = -dirX
    const p1x = bx + apx * DIM_ARROW_HALF_W
    const p1y = by + apy * DIM_ARROW_HALF_W
    const p2x = bx - apx * DIM_ARROW_HALF_W
    const p2y = by - apy * DIM_ARROW_HALF_W
    return (
      <path
        key={akey}
        d={`M${tipX} ${tipY} L${p1x} ${p1y} L${p2x} ${p2y} Z`}
        fill={DIM_AMBER} stroke="none"
      />
    )
  }

  const label = dimLabel(dim)
  const mx = (ax1 + ax2) / 2, my = (ay1 + ay2) / 2
  const labelOffset = 3 + DIM_LABEL_SIZE * 0.55
  const lx = mx + px * labelOffset
  const ly = my + py * labelOffset

  return (
    <g key={key}>
      <line x1={x1} y1={y1} x2={x1 + ox} y2={y1 + oy}
        stroke={DIM_AMBER} strokeWidth={DIM_LINE_SW} />
      <line x1={x2} y1={y2} x2={x2 + ox} y2={y2 + oy}
        stroke={DIM_AMBER} strokeWidth={DIM_LINE_SW} />
      <line x1={ax1} y1={ay1} x2={ax2} y2={ay2}
        stroke={DIM_AMBER} strokeWidth={DIM_LINE_SW} />
      {arrow(ax1, ay1, -ux, -uy, 'a1')}
      {arrow(ax2, ay2,  ux,  uy, 'a2')}
      {label && (
        <g>
          <rect
            x={lx - label.length * DIM_LABEL_SIZE * 0.3 - 2}
            y={ly - DIM_LABEL_SIZE * 0.9}
            width={label.length * DIM_LABEL_SIZE * 0.6 + 4}
            height={DIM_LABEL_SIZE + 4}
            fill="white" stroke="none"
          />
          <text
            x={lx} y={ly}
            fontFamily="Helvetica, Arial, sans-serif"
            fontSize={DIM_LABEL_SIZE}
            fontWeight="bold"
            fill={DIM_AMBER}
            textAnchor="middle"
          >
            {label}
          </text>
        </g>
      )}
    </g>
  )
}

/** Render one callout (leader + tip circle + numbered + text box). */
function renderCallout(ca, key, txPt) {
  if (!ca) return null
  const [tipx, tipy]   = txPt(ca.tipX  || 0, ca.tipY  || 0)
  const [tailx, taily] = txPt(ca.tailX || 0, ca.tailY || 0)
  const num = Number.isFinite(+ca.num) ? +ca.num : 0
  const text = (typeof ca.textEN === 'string' && ca.textEN.trim()) ? ca.textEN.trim() : ''
  const TIP_R = 8
  const TEXT_SIZE = 8
  const BOX_PAD_X = 5
  const BOX_PAD_Y = 3
  const approxTw = text.length * TEXT_SIZE * 0.55
  const boxW = approxTw + 2 * BOX_PAD_X
  const boxH = TEXT_SIZE + 2 * BOX_PAD_Y
  return (
    <g key={key}>
      <line x1={tipx} y1={tipy} x2={tailx} y2={taily}
        stroke={KCC_NAVY} strokeWidth={0.8} />
      {text && (
        <g>
          <rect
            x={tailx - boxW / 2}
            y={taily - boxH / 2}
            width={boxW}
            height={boxH}
            fill="white"
            stroke={KCC_ORANGE}
            strokeWidth={0.6}
          />
          <text
            x={tailx}
            y={taily + TEXT_SIZE * 0.32}
            fontFamily="Helvetica, Arial, sans-serif"
            fontSize={TEXT_SIZE}
            fill={KCC_NAVY}
            textAnchor="middle"
          >
            {text}
          </text>
        </g>
      )}
      <circle cx={tipx} cy={tipy} r={TIP_R}
        fill={KCC_ORANGE} stroke="white" strokeWidth={1.2} />
      {num > 0 && (
        <text
          x={tipx} y={tipy + 3.2}
          fontFamily="Helvetica, Arial, sans-serif"
          fontSize={9}
          fontWeight="bold"
          fill="white"
          textAnchor="middle"
        >
          {String(num)}
        </text>
      )}
    </g>
  )
}

/** Faint blueprint grid + 4 corner crosshairs for the drawing area. */
function renderGridAndCrosshairs(w, h) {
  const lines = []
  const step = GRID_SPACING_PT * 1.5
  for (let x = step; x < w; x += step) {
    lines.push(<line key={`gv${x}`} x1={x} y1={0} x2={x} y2={h}
      stroke={GRID_LIGHT} strokeWidth={GRID_SW} />)
  }
  for (let y = step; y < h; y += step) {
    lines.push(<line key={`gh${y}`} x1={0} y1={y} x2={w} y2={y}
      stroke={GRID_LIGHT} strokeWidth={GRID_SW} />)
  }
  const corners = [
    { cx: 0, cy: 0 }, { cx: w, cy: 0 },
    { cx: 0, cy: h }, { cx: w, cy: h },
  ]
  for (const { cx, cy } of corners) {
    lines.push(
      <line key={`chh-${cx}-${cy}`} x1={cx - CROSSHAIR_LEN} y1={cy} x2={cx + CROSSHAIR_LEN} y2={cy}
        stroke={KCC_ORANGE} strokeWidth={CROSSHAIR_SW} />
    )
    lines.push(
      <line key={`chv-${cx}-${cy}`} x1={cx} y1={cy - CROSSHAIR_LEN} x2={cx} y2={cy + CROSSHAIR_LEN}
        stroke={KCC_ORANGE} strokeWidth={CROSSHAIR_SW} />
    )
  }
  return lines
}

/**
 * Main render entry. Returns { svg, overflow } where svg is a complete
 * <svg> element and overflow is a boolean for the caller's warning UI.
 */
export function renderShopDrawingSVG({ data, drawingAreaPx, previewControls }) {
  const { width: w, height: h } = drawingAreaPx
  const layers = (data && data.layers) || []
  const controls = previewControls || {}
  const rotation = [0, 90, 180, 270].includes(controls.geometryRotation) ? controls.geometryRotation : 0
  const fitMode = ['auto', '1:1', 'custom'].includes(controls.fitMode) ? controls.fitMode : 'auto'
  const customScale = typeof controls.customScale === 'number' && controls.customScale > 0
    ? controls.customScale : 1.0

  const rotatedLayers = rotateGeometry(layers, rotation)
  const bbox = computeBbox(rotatedLayers)
  const { scale, tx, ty, overflow } = computeFitTransform(bbox, w, h, fitMode, customScale)
  const txPt = makeTxPt(scale, tx, ty)
  const sortedLayers = [...rotatedLayers].sort((a, b) => (a.order || 0) - (b.order || 0))

  const svg = (
    <svg
      width={w} height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: 'block', background: 'white' }}
      data-testid="shop-drawing-svg"
    >
      <rect x={0} y={0} width={w} height={h} fill="white" stroke={GRID_LIGHT} strokeWidth={0.5} />
      {renderGridAndCrosshairs(w, h)}
      {(!bbox) && (
        <text
          x={w / 2} y={h / 2}
          fontFamily="Helvetica, Arial, sans-serif"
          fontSize={12}
          fill={TEXT_DIM}
          textAnchor="middle"
          fontStyle="italic"
        >
          (no geometry yet — draw something in Technical Drawing first)
        </text>
      )}
      {sortedLayers.map((layer, li) => (
        <g key={`l-shapes-${li}`}>
          {(layer.shapes || []).map((sh, si) => renderShape(sh, `s-${li}-${si}`, layer, txPt))}
        </g>
      ))}
      {sortedLayers.map((layer, li) => (
        <g key={`l-dims-${li}`}>
          {(layer.dimensions || []).map((d, di) => renderDimension(d, `d-${li}-${di}`, txPt))}
        </g>
      ))}
      {sortedLayers.map((layer, li) => (
        <g key={`l-cas-${li}`}>
          {(layer.callouts || []).map((ca, ci) => renderCallout(ca, `c-${li}-${ci}`, txPt))}
        </g>
      ))}
    </svg>
  )

  return { svg, overflow }
}
