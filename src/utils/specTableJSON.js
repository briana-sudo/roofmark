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
  const A = dim.pointA && { x: dim.pointA.x, y: dim.pointA.y }
  const B = dim.pointB && { x: dim.pointB.x, y: dim.pointB.y }
  if (!A || !B) return null
  // v1.1 expects a `value` string for the dim label. RoofMark renders
  // formatArchitecturalLength at canvas-draw time; for the PDF payload
  // we send the computed length string so v1.1's render path uses it
  // verbatim (no recompute on the Python side). Resolved length math
  // mirrors 18e dimGeometry.computeDimensionLengthInches.
  let pxDist
  if (dim.orientation === 'horizontal') pxDist = Math.abs(B.x - A.x)
  else if (dim.orientation === 'vertical') pxDist = Math.abs(B.y - A.y)
  else pxDist = Math.hypot(B.x - A.x, B.y - A.y)
  // Format: leave to v1.1's display layer (we don't import the architectural
  // formatter here to avoid coupling). v1.1 reads the `value` field as a
  // string — pass the raw pixel distance with units inferred. Operator can
  // override at the RoofMark canvas in a future 18i amendment.
  // For now: empty string lets v1.1 fall through to its default behavior.
  const value = '' // v1.1 skips the label render when value is empty
  return { x1: A.x, y1: A.y, x2: B.x, y2: B.y, value, pxDist }
}

/**
 * Build a v1.1-shaped layer from a RoofMark technicalLayer. Filters
 * shapes into lines+polys (v1.1 shape types) and dimensions (v1.1
 * dimension array). RoofMark dimensions and lines coexist in the same
 * `shapes` array on the canvas side; we split them here.
 */
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
    if (sh.type === 'line' || sh.type === 'poly' || sh.type === 'tri'
      || sh.type === 'rect' || sh.type === 'circ') {
      const stripped = stripShape(sh)
      if (stripped) shapes.push(stripped)
    }
    // Unknown shape types (future arcs/ellipses) silently skipped.
  }
  // RoofMark Technical Drawing has no callout primitive today; included
  // for forward-compat with v1.1's contract which accepts them.
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
