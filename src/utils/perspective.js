// ============================================================================
// perspective.js — P16 + P38 mini-step (May 8 2026)
//
// Pure math for the perspective grid (P16) + grid rotation (P38).
//
// P16 — 4-corner homography:
//   The operator drags 4 corner points over the photo to mark "this is where
//   the flat roof actually is." Those 4 corners (in photo-norm space, 0..1)
//   define the destination quadrilateral. The source rectangle is the
//   conceptual flat roof at (0..photoW, 0..photoH) photo-px. A 3×3 homography
//   matrix H maps source → dest. Grid lines are drawn axis-aligned in source
//   space, then forward-transformed through H to dest, then dest-photo-px →
//   canvas-px via the existing viewport math.
//
//   Snap reverses the chain: cursor canvas-px → cursor photo-px → cursor
//   source-px (via inverse H) → snap to nearest grid step in source space →
//   forward H back to dest photo-px → snap point canvas-px.
//
// P38 — single-angle rotation:
//   Simpler than perspective. Rotation is about the photo center (0.5, 0.5
//   in photo-norm = photoW/2, photoH/2 in photo-px). Render rotates each
//   grid line endpoint about the center; snap inverse-rotates the cursor,
//   snaps in rotated-grid space, then forward-rotates the snap point back.
//
// Option Y interaction:
//   When perspectiveCorners != null, perspective dominates and rotation is
//   IGNORED at render + snap time. Rotation field is preserved in the store
//   so clearing perspective restores the operator's rotation choice.
// ============================================================================

// ----------------------------------------------------------------------------
// Linear-system solver (Gaussian elimination with partial pivoting). Used by
// the homography builder. Returns null if the system is singular.
// ----------------------------------------------------------------------------
function solveLinearSystem(A, b) {
  const n = A.length
  // Augmented matrix copy so the input arrays aren't mutated.
  const M = A.map((row, i) => [...row, b[i]])
  for (let i = 0; i < n; i++) {
    // Partial pivot
    let maxRow = i
    let maxVal = Math.abs(M[i][i])
    for (let k = i + 1; k < n; k++) {
      const v = Math.abs(M[k][i])
      if (v > maxVal) { maxRow = k; maxVal = v }
    }
    if (maxVal < 1e-9) return null // singular
    if (maxRow !== i) {
      const tmp = M[i]; M[i] = M[maxRow]; M[maxRow] = tmp
    }
    // Eliminate below
    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / M[i][i]
      for (let j = i; j <= n; j++) M[k][j] -= factor * M[i][j]
    }
  }
  // Back-substitute
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n]
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j]
    x[i] = sum / M[i][i]
  }
  return x
}

// ----------------------------------------------------------------------------
// computeHomography — given 4 source points and 4 destination points,
// returns a flat 9-element array [h0, h1, h2, h3, h4, h5, h6, h7, h8]
// representing the row-major 3×3 homography H such that
//   H · [sx, sy, 1]ᵀ ∝ [dx, dy, 1]ᵀ
//
// Returns null if the system is degenerate (3 collinear corners on either
// side, or the linear solve fails).
//
// Each point pair contributes 2 rows to the 8×8 system. h8 fixed to 1.
// ----------------------------------------------------------------------------
export function computeHomography(srcPoints, dstPoints) {
  if (!Array.isArray(srcPoints) || srcPoints.length !== 4) return null
  if (!Array.isArray(dstPoints) || dstPoints.length !== 4) return null
  // Reject if any 3 destination points are collinear — homography would be
  // degenerate.
  if (anyThreeCollinear(dstPoints)) return null
  if (anyThreeCollinear(srcPoints)) return null

  const A = []
  const b = []
  for (let i = 0; i < 4; i++) {
    const sx = srcPoints[i].x, sy = srcPoints[i].y
    const dx = dstPoints[i].x, dy = dstPoints[i].y
    if (!Number.isFinite(sx) || !Number.isFinite(sy)
      || !Number.isFinite(dx) || !Number.isFinite(dy)) {
      return null
    }
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy])
    b.push(dx)
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy])
    b.push(dy)
  }
  const x = solveLinearSystem(A, b)
  if (!x) return null
  return [
    x[0], x[1], x[2],
    x[3], x[4], x[5],
    x[6], x[7], 1,
  ]
}

// ----------------------------------------------------------------------------
// applyHomography — forward-transform a point through a homography matrix.
// Returns null if the resulting w is near zero (point at infinity / outside
// the projection's domain).
// ----------------------------------------------------------------------------
export function applyHomography(H, point) {
  if (!H || !point) return null
  const x = point.x, y = point.y
  const w = H[6] * x + H[7] * y + H[8]
  if (Math.abs(w) < 1e-12) return null
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  }
}

// ----------------------------------------------------------------------------
// invertHomography — invert a 3×3 matrix via cofactor expansion. Returns
// null if the determinant is near zero (matrix is singular).
// ----------------------------------------------------------------------------
export function invertHomography(H) {
  if (!H || H.length !== 9) return null
  const a = H[0], b = H[1], c = H[2]
  const d = H[3], e = H[4], f = H[5]
  const g = H[6], h = H[7], i = H[8]
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) return null
  const invDet = 1 / det
  return [
    (e * i - f * h) * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet,
    (f * g - d * i) * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet,
    (d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet,
  ]
}

// ----------------------------------------------------------------------------
// anyThreeCollinear — degenerate-quad detector. 3 points are collinear if
// the 2D cross product (b-a) × (c-a) is near zero.
// ----------------------------------------------------------------------------
export function anyThreeCollinear(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return false
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      for (let k = j + 1; k < pts.length; k++) {
        const a = pts[i], b = pts[j], c = pts[k]
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
        // Tolerance scaled to typical photo-norm coords (0..1) so a near-
        // collinear quad isn't quietly accepted.
        if (Math.abs(cross) < 1e-6) return true
      }
    }
  }
  return false
}

// ----------------------------------------------------------------------------
// rotatePoint — 2D rotation of a point about a center, angle in degrees CCW.
// Used by P38 grid rotation render + snap.
// ----------------------------------------------------------------------------
export function rotatePoint(p, center, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p.x - center.x
  const dy = p.y - center.y
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  }
}

// ----------------------------------------------------------------------------
// buildPerspectiveTransform — convenience builder used by render + snap. Given
// the 4 perspective corners (in photo-norm 0..1) plus photo dimensions,
// returns:
//   - forward: source-photo-px → dest-photo-px
//   - inverse: dest-photo-px → source-photo-px
//   - destCornersPx: the 4 corners scaled to photo-px (for clipping the grid)
// or null if the homography is degenerate.
// ----------------------------------------------------------------------------
export function buildPerspectiveTransform(cornersNorm, photoSize) {
  if (!cornersNorm || cornersNorm.length !== 4 || !photoSize) return null
  const W = photoSize.width
  const H = photoSize.height
  if (!(W > 0 && H > 0)) return null

  // Source rectangle = the conceptual "flat roof" in photo-px (0..W, 0..H).
  // Dest = the operator's 4 corners, scaled from norm to photo-px.
  // Convention for corner order: top-left, top-right, bottom-right,
  // bottom-left (corner index 0..3 ↔ TL/TR/BR/BL).
  const src = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ]
  const dst = cornersNorm.map((c) => ({ x: c.x * W, y: c.y * H }))
  const Hfwd = computeHomography(src, dst)
  if (!Hfwd) return null
  const Hinv = invertHomography(Hfwd)
  if (!Hinv) return null

  return {
    forward: (p) => applyHomography(Hfwd, p),
    inverse: (p) => applyHomography(Hinv, p),
    destCornersPx: dst,
    // Default-corner detection (operator hasn't dragged): corners exactly
    // at photo bounds → identity homography. Render path can short-circuit
    // to the axis-aligned grid in this case.
    isIdentity: cornersAreAtPhotoBounds(cornersNorm),
  }
}

function cornersAreAtPhotoBounds(corners) {
  if (!corners || corners.length !== 4) return false
  const eps = 1e-6
  const expected = [[0, 0], [1, 0], [1, 1], [0, 1]]
  for (let i = 0; i < 4; i++) {
    if (Math.abs(corners[i].x - expected[i][0]) > eps) return false
    if (Math.abs(corners[i].y - expected[i][1]) > eps) return false
  }
  return true
}

// ----------------------------------------------------------------------------
// DEFAULT_PERSPECTIVE_CORNERS — the four corners of the cropped photo, in
// TL/TR/BR/BL order. New perspectiveCorners default to this; render path
// short-circuits to axis-aligned grid via `isIdentity`.
// ----------------------------------------------------------------------------
export const DEFAULT_PERSPECTIVE_CORNERS = Object.freeze([
  Object.freeze({ x: 0, y: 0 }),
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 1, y: 1 }),
  Object.freeze({ x: 0, y: 1 }),
])

// ----------------------------------------------------------------------------
// pointsAreValidPerspectiveCorners — gate before write. 4 points, each
// with finite numeric x/y in [0, 1], no 3 collinear.
// ----------------------------------------------------------------------------
export function pointsAreValidPerspectiveCorners(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return false
  for (const c of corners) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return false
    if (c.x < -0.001 || c.x > 1.001 || c.y < -0.001 || c.y > 1.001) return false
  }
  if (anyThreeCollinear(corners)) return false
  return true
}
