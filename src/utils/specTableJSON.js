// ============================================================================
// specTableJSON.js — Phase 2 sub-step 18h (May 12 2026)
//
// Build the v1.1 kcc-shop-drawing.py JSON input payload from the
// RoofMark store state + the operator's preview controls.
//
// Contract is locked at kcc-shop-drawing.py v1.1's docstring (lines 21-
// 76 of that file): specTable (9 fields, drawingNo required), layers
// (each with shapes/dimensions/callouts), drawingType, internalScale,
// plus the 4 v1.1 fields (pageOrientation, geometryRotation, fitMode,
// customScale).
//
// This module is pure: no React, no DOM, no store import. Caller (the
// useShopDrawingPdf hook / TechnicalPreview) passes a snapshot of
// store state + preview controls.
//
// Single function buildShopDrawingPayload(storeState, previewControls).
// Strips RoofMark-internal fields (layer.id, layer.visible, shape.id,
// etc.) so the JSON is minimal and matches the v1.1 contract exactly.
// Internal IDs would be ignored by v1.1 — stripping keeps payload size
// down and makes debugging easier.
// ============================================================================

import { SPEC_TABLE_FIELDS } from './specTableValidation'
import { formatArchitecturalLength } from './formatArchitecturalLength'
import { computeAngleDegrees, formatAngle } from './angularDimMath'

/**
 * Convert a RoofMark technicalLayers shape to the v1.1 shape contract.
 * Strips RoofMark-internal fields (id, layer attribution) and copies
 * only the geometry + render-attribute fields v1.1 reads.
 */
function stripShape(shape) {
  if (!shape) return null
  const out = { type: shape.type }
  // Geometry by type.
  //
  // 18h Bug 1 bridge (May 12 2026): RoofMark's Technical Drawing line
  // tool (techLineCommit.js) stores lines as {type:'line', a:{x,y},
  // b:{x,y}, ...}. The v1.1 Python contract + the SVG preview renderer
  // both expect pts:[{x,y},{x,y}] for line shapes. Bridge a/b → pts
  // here so the rest of the pipeline (renderer + Python) sees the
  // canonical pts form. Future tech-rect / tech-arc / tech-circ shape
  // primitives shipped in 18i+ will need similar bridges if they don't
  // store pts natively.
  if (shape.type === 'line' && shape.a && shape.b
    && typeof shape.a.x === 'number' && typeof shape.b.x === 'number') {
    out.pts = [
      { x: shape.a.x, y: shape.a.y },
      { x: shape.b.x, y: shape.b.y },
    ]
  } else if (shape.type === 'circ') {
    if (typeof shape.cx === 'number') out.cx = shape.cx
    if (typeof shape.cy === 'number') out.cy = shape.cy
    if (typeof shape.r === 'number') out.r = shape.r
  } else if (Array.isArray(shape.pts)) {
    out.pts = shape.pts.map((p) => ({ x: p.x, y: p.y }))
  }
  // Render attributes (all optional — v1.1 falls back to its DEFAULT_*
  // constants when omitted, so we only emit non-null values).
  if (typeof shape.fillOpacity === 'number') out.fillOpacity = shape.fillOpacity
  if (typeof shape.strokeOpacity === 'number') out.strokeOpacity = shape.strokeOpacity
  if (typeof shape.strokeWeight === 'number') out.strokeWeight = shape.strokeWeight
  if (typeof shape.fillOn === 'boolean') out.fillOn = shape.fillOn
  if (typeof shape.strokeOn === 'boolean') out.strokeOn = shape.strokeOn
  return out
}

/**
 * Convert a RoofMark dimension shape (Phase 2 18e) to the v1.1
 * dimension contract. v1.1 takes x1/y1/x2/y2 + value; RoofMark stores
 * pointA/pointB attached to source lines (DIMASSOC=2). We resolve via
 * the cached coords (always populated; propagateDimensionUpdates keeps
 * them in sync per 18e contract).
 */
function dimensionFromRoofMarkDim(dim) {
  if (!dim || dim.type !== 'dimension') return null

  // Phase 2 18k — angular dim branch. v1.2 contract:
  //   { type: 'angular', vertex: {x,y}, p1: {x,y}, p2: {x,y},
  //     radius: number, value: string }
  // Operator stores vertex with attached-mode metadata (forward-compat
  // for future "vertex follows a parent line endpoint"); the JSON
  // contract takes the plain {x,y} only. textOverride wins when non-
  // empty, mirroring linear-dim behavior; empty/missing override falls
  // back to formatAngle(computedDegrees, 'degrees', 1) → "45.0°".
  if (dim.dimType === 'angular') {
    if (!dim.vertex || !dim.p1 || !dim.p2) return null
    if (typeof dim.vertex.x !== 'number' || typeof dim.vertex.y !== 'number') return null
    if (typeof dim.p1.x !== 'number' || typeof dim.p1.y !== 'number') return null
    if (typeof dim.p2.x !== 'number' || typeof dim.p2.y !== 'number') return null
    const radius = typeof dim.radius === 'number' && dim.radius > 0 ? dim.radius : 24
    const override = typeof dim.textOverride === 'string'
      ? dim.textOverride.trim()
      : ''
    let value
    if (override !== '') {
      value = override
    } else {
      const degrees = computeAngleDegrees({
        vertex: { x: dim.vertex.x, y: dim.vertex.y },
        p1: { x: dim.p1.x, y: dim.p1.y },
        p2: { x: dim.p2.x, y: dim.p2.y },
        radius,
      })
      value = formatAngle(degrees, 'degrees', 1)
    }
    return {
      type: 'angular',
      vertex: { x: dim.vertex.x, y: dim.vertex.y },
      p1: { x: dim.p1.x, y: dim.p1.y },
      p2: { x: dim.p2.x, y: dim.p2.y },
      radius,
      value,
    }
  }

  // Linear dim path (18e/18h contract — unchanged).
  const A = dim.pointA && { x: dim.pointA.x, y: dim.pointA.y }
  const B = dim.pointB && { x: dim.pointB.x, y: dim.pointB.y }
  if (!A || !B) return null
  // v1.1 expects a `value` string for the dim label. v1.1 honors whatever
  // string we send — empty string skips the label render entirely (the
  // dim lines + arrows still render but the operator-visible inches text
  // is gone). Resolved length math mirrors 18e
  // dimGeometry.computeDimensionLengthInches.
  let pxDist
  if (dim.orientation === 'horizontal') pxDist = Math.abs(B.x - A.x)
  else if (dim.orientation === 'vertical') pxDist = Math.abs(B.y - A.y)
  else pxDist = Math.hypot(B.x - A.x, B.y - A.y)
  // 18h Bug 3 fix (May 12 2026): compute value via
  // formatArchitecturalLength to match the SVG preview's dimLabel()
  // behavior. Pre-fix shipped value='' which silently dropped every dim
  // label in the PDF (operator-perceived as "dims missing"). Honor
  // textOverride when the operator sets a non-empty override (preserves
  // the 18e contract for the future override editor); empty-string
  // textOverride is treated as not-set so computed value wins.
  const override = typeof dim.textOverride === 'string'
    ? dim.textOverride.trim()
    : ''
  const value = override !== ''
    ? override
    : (formatArchitecturalLength(pxDist / 24.0) || '')
  return { x1: A.x, y1: A.y, x2: B.x, y2: B.y, value, pxDist }
}

/**
 * Build a v1.1-shaped layer from a RoofMark technicalLayer. Filters
 * shapes into lines+polys (v1.1 shape types) and dimensions (v1.1
 * dimension array). RoofMark dimensions and lines coexist in the same
 * `shapes` array on the canvas side; we split them here.
 */
/**
 * Phase 2 18k — Bridge a RoofMark callout shape to the v1.1 callout
 * contract. RoofMark stores callouts as:
 *   { id, type: 'callout',
 *     tip: { mode, shapeId?, pointKey?, x, y },
 *     tail: { x, y },
 *     num, textEN, tipStyle }
 * v1.1 contract:
 *   { id, tipX, tipY, tailX, tailY, num, textEN }
 * v1.2 Python ignores unknown fields, so `tipStyle` may be sent through
 * for forward-compat with the (future) v1.3 amendment.
 */
function calloutFromRoofMarkCallout(ca) {
  if (!ca || ca.type !== 'callout') return null
  const tip = ca.tip || {}
  const tail = ca.tail || {}
  if (typeof tip.x !== 'number' || typeof tip.y !== 'number') return null
  if (typeof tail.x !== 'number' || typeof tail.y !== 'number') return null
  return {
    id: ca.id || undefined,
    tipX: tip.x,
    tipY: tip.y,
    tailX: tail.x,
    tailY: tail.y,
    num: typeof ca.num === 'number' ? ca.num : 0,
    textEN: typeof ca.textEN === 'string' ? ca.textEN : '',
    tipStyle: ca.tipStyle === 'dot' || ca.tipStyle === 'none' ? ca.tipStyle : 'numbered',
  }
}

function stripLayer(layer) {
  if (!layer) return null
  const shapes = []
  const dimensions = []
  const callouts = []
  for (const sh of layer.shapes || []) {
    if (!sh) continue
    if (sh.type === 'dimension') {
      const d = dimensionFromRoofMarkDim(sh)
      if (d) dimensions.push(d)
      continue
    }
    if (sh.type === 'callout') {
      // Phase 2 18k — emit callouts to layer.callouts[] (v1.1 contract).
      const c = calloutFromRoofMarkCallout(sh)
      if (c) callouts.push(c)
      continue
    }
    if (sh.type === 'line' || sh.type === 'poly' || sh.type === 'tri'
      || sh.type === 'rect' || sh.type === 'circ') {
      const stripped = stripShape(sh)
      if (stripped) shapes.push(stripped)
    }
    // Unknown shape types (future arcs/ellipses) silently skipped.
  }
  return {
    name: layer.name || 'Layer',
    color: layer.color || '#1A2F4A',
    order: typeof layer.order === 'number' ? layer.order : 0,
    shapes,
    dimensions,
    callouts,
  }
}

/**
 * Build the full v1.1 JSON payload.
 *
 * @param {Object} storeState - snapshot of useAppStore state (typically
 *                              `useAppStore.getState()`).
 * @param {Object} previewControls - { pageOrientation, geometryRotation,
 *                                     fitMode, customScale }
 * @returns {Object} v1.1 JSON contract
 */
export function buildShopDrawingPayload(storeState, previewControls) {
  const specTableIn = storeState.specTable || {}
  // specTable: keep only the 9 locked fields, in canonical order.
  const specTable = {}
  for (const field of SPEC_TABLE_FIELDS) {
    specTable[field] = typeof specTableIn[field] === 'string' ? specTableIn[field] : ''
  }
  // technicalLayers → v1.1 layers
  const layers = (storeState.technicalLayers || [])
    .filter((l) => l && l.visible !== false)
    .map(stripLayer)
    .filter(Boolean)

  // v1.1 preview-control fields with defaults matching v1.1's own defaults.
  const pageOrientation = previewControls && previewControls.pageOrientation === 'portrait'
    ? 'portrait' : 'landscape'
  const validRotations = [0, 90, 180, 270]
  const geometryRotation = previewControls && validRotations.includes(previewControls.geometryRotation)
    ? previewControls.geometryRotation : 0
  const validFitModes = ['auto', '1:1', 'custom']
  const fitMode = previewControls && validFitModes.includes(previewControls.fitMode)
    ? previewControls.fitMode : 'auto'
  const customScale = previewControls
    && typeof previewControls.customScale === 'number'
    && previewControls.customScale > 0
    ? previewControls.customScale : 1.0

  return {
    specTable,
    drawingType: 'profile',
    internalScale: 24,
    layers,
    pageOrientation,
    geometryRotation,
    fitMode,
    customScale,
  }
}

/**
 * Filename slug rule per v1.1 decision D8: spaces → hyphens, drop non-
 * alphanumeric/underscore/hyphen, collapse double hyphens, trim
 * leading/trailing hyphens/underscores. Output is filesystem-safe.
 *
 * Used by the async pipeline to compose the `filename` field sent to
 * the proxy (proxy + v1.1 use it for both the Content-Disposition
 * header AND v1.1's internal output filename pattern).
 */
export function slugify(s) {
  let out = String(s || '').trim()
  out = out.replace(/\s+/g, '-')
  out = out.replace(/[^A-Za-z0-9_\-]/g, '')
  out = out.replace(/-{2,}/g, '-')
  out = out.replace(/^[-_]+|[-_]+$/g, '')
  return out || 'untitled'
}

/**
 * Compose the canonical filename per v1.1 pattern: `<drawingNo-slug>_
 * <partName-slug>.pdf`. Matches v1.1's internal filename so the proxy
 * Content-Disposition header agrees with the in-file metadata.
 */
export function shopDrawingFilename(specTable) {
  const drawingNo = (specTable && specTable.drawingNo) || ''
  const partName  = (specTable && specTable.partName)  || ''
  return `${slugify(drawingNo)}_${slugify(partName)}.pdf`
}
