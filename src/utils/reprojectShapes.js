/**
 * reprojectShapes — Step 17 partial-completion #4 (Bug C / Option C-C).
 *
 * Pure functions for re-projecting shape / cline / annotation coordinates
 * across a crop change on the same source photo.
 *
 * Coordinate spaces (mirror of viewport.js doc):
 *   PHOTO_NORM    — 0.0..1.0 of cropped photo dims. Reference frame = the
 *                   currently-active cropped working photo.
 *   SOURCE_PX     — pixel coordinates in the ORIGINAL source photo
 *                   (cropMeta.x/y are in this space).
 *
 * Re-crop transforms:
 *   old norm -> source px  (via OLD cropMeta — accounts for crop offset
 *                           + rotation)
 *   source px -> new norm  (via NEW cropMeta — inverse)
 *
 * The composition (oldNorm -> srcPx -> newNorm) is what keeps shapes
 * "locked" to physical roof features when the operator re-crops.
 *
 * Rotation handling:
 *   cropMeta.rotation ∈ {0, 90, 180, 270} (degrees CCW per the Canvas
 *   ctx.rotate semantics in PhotoCropModal). The output cropped photo
 *   has dims (cropMeta.w, cropMeta.h) for rotation 0/180 and
 *   (cropMeta.h, cropMeta.w) for rotation 90/270 (the axes swap).
 *
 *   For old norm -> source px: we counter-rotate by `-rotation`.
 *   For source px -> new norm: we forward-rotate by `+rotation`.
 *
 * Pre-Section-7.A migration:
 *   When cropMeta is null on either side, we substitute a fallback
 *   `{ x: 0, y: 0, w: sourceW, h: sourceH, rotation: 0 }` — i.e. "the
 *   old/new crop is the entire source." In practice this fires only on
 *   v1 imports + legacy IndexedDB hydration, and Re-crop is gated on
 *   hasSourcePhoto (which is false in those cases) so the path mostly
 *   protects against future schema changes.
 *
 * Cline type may change across re-projection:
 *   An h-cline (constant y) re-projected through a 90° rotation
 *   becomes a v-cline (constant x) in the new space. We detect via
 *   forward-projecting two points along the old line direction; if the
 *   new direction is axis-aligned we emit 'h'/'v', else 'a' (angled).
 *
 * Circle radius (`shape.r`):
 *   Stored as a single normalized scalar (relative to photo width per
 *   CanvasStage.jsx render). For non-uniform aspect-ratio crops the
 *   true post-crop shape would be an ellipse; the data model can only
 *   carry one radius. We scale by the output-width ratio
 *   (r_new = r_old * outW_old / outW_new). The visual circle stays
 *   circular but distorts slightly when the new crop's aspect ratio
 *   differs from the old. Documented limit.
 *
 * Out-of-bounds detection:
 *   After re-projection a point may have norm < 0 or > 1 (the source
 *   pixel is outside the new crop). The caller (commitCroppedPhoto)
 *   counts these and prompts the operator before committing. Coords
 *   that fall off-canvas persist — re-cropping wider recovers them.
 */

// Default crop fallback for pre-Section-7.A migration. Source photo
// IS the working photo (no crop, no rotation).
function fallbackCrop(sourceDims) {
  return { x: 0, y: 0, w: sourceDims.w, h: sourceDims.h, rotation: 0 }
}

// Output cropped-photo dimensions (axes swap on 90/270 rotation —
// matches PhotoCropModal.jsx onConfirmClick output dim derivation).
function outDims(crop) {
  const isRotated90 = (crop.rotation === 90 || crop.rotation === 270)
  return {
    w: isRotated90 ? crop.h : crop.w,
    h: isRotated90 ? crop.w : crop.h,
  }
}

// Rotate a point by `deg` degrees (CCW per Canvas convention).
//   R(θ): (x, y) → (x cos θ - y sin θ, x sin θ + y cos θ)
function rotatePointDeg(p, deg) {
  if (!deg) return { x: p.x, y: p.y }
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/**
 * Map a normalized point (in OLD cropped-photo norm) → source-photo
 * pixel coords.
 *
 *   1. norm × outDims_old           = cropped pixel (output canvas)
 *   2. − outDims_old/2              = centered output coord
 *   3. R(-rotation_old)             = centered crop-coord (the
 *                                     pre-rotation drawImage frame)
 *   4. + (crop.w/2, crop.h/2)       = source-crop-relative coord
 *   5. + (crop.x, crop.y)           = source-photo pixel
 */
export function oldNormToSourcePx(p, oldCrop, sourceDims) {
  const meta = oldCrop || fallbackCrop(sourceDims)
  const out = outDims(meta)
  const cropped = { x: p.x * out.w, y: p.y * out.h }
  const centered = { x: cropped.x - out.w / 2, y: cropped.y - out.h / 2 }
  const inv = rotatePointDeg(centered, -(meta.rotation || 0))
  const inCrop = { x: inv.x + meta.w / 2, y: inv.y + meta.h / 2 }
  return { x: inCrop.x + meta.x, y: inCrop.y + meta.y }
}

/**
 * Map a source-photo pixel → normalized point in the NEW cropped-photo
 * coordinate space. Inverse of oldNormToSourcePx.
 */
export function sourcePxToNewNorm(sp, newCrop, sourceDims) {
  const meta = newCrop || fallbackCrop(sourceDims)
  const out = outDims(meta)
  const inCrop = { x: sp.x - meta.x, y: sp.y - meta.y }
  const centered = { x: inCrop.x - meta.w / 2, y: inCrop.y - meta.h / 2 }
  const fwd = rotatePointDeg(centered, meta.rotation || 0)
  const cropped = { x: fwd.x + out.w / 2, y: fwd.y + out.h / 2 }
  return { x: cropped.x / out.w, y: cropped.y / out.h }
}

/** Composition: old norm → source px → new norm. */
export function reprojectPoint(p, oldCrop, newCrop, sourceDims) {
  return sourcePxToNewNorm(
    oldNormToSourcePx(p, oldCrop, sourceDims),
    newCrop,
    sourceDims,
  )
}

/**
 * Re-project a shape's coordinate-bearing fields. Switch on shape.type:
 *   - circle   — center (cx, cy) + radius (r). Radius scaled by output-
 *                width ratio (see file-level comment for caveat).
 *   - poly/rect/tri/line — pts[] array of {x, y}.
 *   - arc      — pts[] of [start, mid, end] (P6, May 7 2026). Falls
 *                through to the generic pts-mapper. Re-projection
 *                preserves arc identity because the circumcircle is
 *                derivable from the 3 transformed points.
 *   - ellipse  — pts[] of [tl, br] bounding-box corners (P6, May 7
 *                2026). Falls through to the generic pts-mapper. After
 *                non-uniform aspect-ratio re-crop, the bounding box
 *                may become non-axis-aligned (operator drew an axis-
 *                aligned ellipse, but the new crop's coordinate frame
 *                differs); render code computes axis-aligned cx/cy/
 *                rx/ry from the bounding box and treats it as still
 *                axis-aligned. Documented limit.
 */
export function reprojectShape(shape, oldCrop, newCrop, sourceDims) {
  if (shape.type === 'circ') {
    const center = reprojectPoint({ x: shape.cx, y: shape.cy }, oldCrop, newCrop, sourceDims)
    const oldOut = outDims(oldCrop || fallbackCrop(sourceDims))
    const newOut = outDims(newCrop || fallbackCrop(sourceDims))
    const ratio = oldOut.w / (newOut.w || 1)
    return { ...shape, cx: center.x, cy: center.y, r: shape.r * ratio }
  }
  if (!Array.isArray(shape.pts)) return shape
  const pts = shape.pts.map((p) => reprojectPoint(p, oldCrop, newCrop, sourceDims))
  return { ...shape, pts }
}

/**
 * Re-project a construction line. Vector-based: take two points along
 * the OLD line direction, transform both, recompute the new direction
 * (and therefore type — h/v/a may change across rotations).
 */
export function reprojectCline(cl, oldCrop, newCrop, sourceDims) {
  let p1, p2
  if (cl.type === 'h') {
    // Horizontal in old space — anchor on left edge, second point on right.
    p1 = { x: 0, y: cl.y }
    p2 = { x: 1, y: cl.y }
  } else if (cl.type === 'v') {
    p1 = { x: cl.x, y: 0 }
    p2 = { x: cl.x, y: 1 }
  } else {
    // Angled — step along the angle direction in normalized space.
    const eps = 0.01
    p1 = { x: cl.px, y: cl.py }
    p2 = { x: cl.px + Math.cos(cl.angle) * eps, y: cl.py + Math.sin(cl.angle) * eps }
  }
  const np1 = reprojectPoint(p1, oldCrop, newCrop, sourceDims)
  const np2 = reprojectPoint(p2, oldCrop, newCrop, sourceDims)
  const dx = np2.x - np1.x
  const dy = np2.y - np1.y

  // Detect axis-alignment in the new space (within float tolerance).
  // Avoids "almost-horizontal" angled clines for the common rotation=0
  // case + preserves h/v specialization across uniform-aspect crops.
  const TOL = 1e-6
  const isHorizontal = Math.abs(dy) < TOL
  const isVertical = Math.abs(dx) < TOL

  if (isHorizontal) {
    return { ...cl, type: 'h', y: np1.y }
  }
  if (isVertical) {
    return { ...cl, type: 'v', x: np1.x }
  }
  return { ...cl, type: 'a', px: np1.x, py: np1.y, angle: Math.atan2(dy, dx) }
}

/** Re-project an annotation. note=at; callout=tip+tail; dimline=a+b. */
export function reprojectAnnotation(anno, oldCrop, newCrop, sourceDims) {
  if (anno.type === 'note' && anno.at) {
    return { ...anno, at: reprojectPoint(anno.at, oldCrop, newCrop, sourceDims) }
  }
  if (anno.type === 'callout' && anno.tip && anno.tail) {
    return {
      ...anno,
      tip: reprojectPoint(anno.tip, oldCrop, newCrop, sourceDims),
      tail: reprojectPoint(anno.tail, oldCrop, newCrop, sourceDims),
    }
  }
  if (anno.type === 'dimline' && anno.a && anno.b) {
    return {
      ...anno,
      a: reprojectPoint(anno.a, oldCrop, newCrop, sourceDims),
      b: reprojectPoint(anno.b, oldCrop, newCrop, sourceDims),
    }
  }
  return anno
}

// ---------------------------------------------------------------------
// Out-of-bounds detection. Used by commitCroppedPhoto's pre-validate
// step to count shapes/clines/annotations that would fall outside the
// new crop. The operator gets a single confirm dialog summarizing the
// counts before the destructive action commits.
// ---------------------------------------------------------------------
export function isPointOutOfBounds(p) {
  return !p || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1
}

export function shapeOutOfBounds(shape) {
  if (shape.type === 'circ') {
    return isPointOutOfBounds({ x: shape.cx, y: shape.cy })
  }
  if (!Array.isArray(shape.pts)) return false
  return shape.pts.some(isPointOutOfBounds)
}

export function clineOutOfBounds(cl) {
  if (cl.type === 'h') return cl.y < 0 || cl.y > 1
  if (cl.type === 'v') return cl.x < 0 || cl.x > 1
  if (cl.type === 'a') return isPointOutOfBounds({ x: cl.px, y: cl.py })
  return false
}

export function annoOutOfBounds(anno) {
  if (anno.type === 'note') return isPointOutOfBounds(anno.at)
  if (anno.type === 'callout') return isPointOutOfBounds(anno.tip) || isPointOutOfBounds(anno.tail)
  if (anno.type === 'dimline') return isPointOutOfBounds(anno.a) || isPointOutOfBounds(anno.b)
  return false
}

/**
 * Tally out-of-bounds counts across an entire project's coord-bearing
 * data. Returns { shapes, clines, annotations } — feeds the confirm
 * dialog "This crop will hide N shapes, M clines, K annotations."
 */
export function countOutOfBounds(layers, clines, sequences) {
  let shapes = 0
  for (const l of layers || []) {
    for (const sh of l.shapes || []) {
      if (shapeOutOfBounds(sh)) shapes += 1
    }
  }
  let cl = 0
  for (const c of clines || []) {
    if (clineOutOfBounds(c)) cl += 1
  }
  let annotations = 0
  for (const s of sequences || []) {
    for (const a of s.annotations || []) {
      if (annoOutOfBounds(a)) annotations += 1
    }
  }
  return { shapes, clines: cl, annotations }
}
