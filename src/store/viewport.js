/**
 * Viewport math — Section 7.A.2.
 *
 * Coordinate spaces:
 *   PHOTO_NORM    — shape coords stored in the project, 0.0..1.0 of cropped
 *                   photo dimensions. Reference frame = the cropped working
 *                   photo (or canvas dims when no photo loaded).
 *   PHOTO_PX      — photo coords in pixels (photoNorm * photoMeta.width|height).
 *   CANVAS_PX     — pixel coords on the rendered canvas (mouse, snap, render).
 *
 * Translation:
 *   canvasX = photoNormX * photoW * zoom + panX
 *   canvasY = photoNormY * photoH * zoom + panY
 *
 *   photoNormX = (canvasX - panX) / (photoW * zoom)
 *   photoNormY = (canvasY - panY) / (photoH * zoom)
 *
 * When no photo is loaded, the helpers fall back to canvasW/canvasH as the
 * "photo" dimensions and viewport={0,0,1}, so render math degenerates to
 * the pre-Section-7.A behavior (shape * canvasW = canvas px).
 */

export const ZOOM_MAX = 4.0
export const ZOOM_MIN_CAP = 0.05

/**
 * Resolve effective photo dimensions used for normalized → canvas math.
 * Spec §7.A.8 migration: when no photo is loaded the canvas is the photo,
 * so existing pre-§7.A markup keeps painting at its original positions.
 */
export function effectivePhotoSize(photoMeta, canvasW, canvasH) {
  if (photoMeta && photoMeta.width > 0 && photoMeta.height > 0) {
    return { width: photoMeta.width, height: photoMeta.height }
  }
  return { width: canvasW || 1, height: canvasH || 1 }
}

/** Convert a single photo-normalized point (0..1) to canvas-px. */
export function photoNormToCanvas(p, viewport, photoSize) {
  return {
    x: p.x * photoSize.width * viewport.zoom + viewport.panX,
    y: p.y * photoSize.height * viewport.zoom + viewport.panY,
  }
}

/** Convert a canvas-px point back to photo-normalized (0..1). */
export function canvasToPhotoNorm(c, viewport, photoSize) {
  const denomX = photoSize.width * viewport.zoom || 1
  const denomY = photoSize.height * viewport.zoom || 1
  return {
    x: (c.x - viewport.panX) / denomX,
    y: (c.y - viewport.panY) / denomY,
  }
}

/**
 * Compute the fit-to-viewport zoom — the largest zoom that still lets the
 * entire photo fit inside the canvas. §7.A.4 says this is the zoom-OUT
 * floor (operator can't zoom further out than fit).
 */
export function computeFitZoom(photoSize, canvasW, canvasH) {
  if (!canvasW || !canvasH) return 1
  const sx = canvasW / photoSize.width
  const sy = canvasH / photoSize.height
  return Math.max(ZOOM_MIN_CAP, Math.min(sx, sy))
}

/**
 * Compute viewport state that fits + centers the photo in the canvas.
 * This is the §7.A.4 "default at photo load" and the response to the
 * Fit toolbar button / `0` keyboard shortcut.
 */
export function computeFitViewport(photoSize, canvasW, canvasH) {
  const zoom = computeFitZoom(photoSize, canvasW, canvasH)
  const photoCanvasW = photoSize.width * zoom
  const photoCanvasH = photoSize.height * zoom
  return {
    panX: Math.round((canvasW - photoCanvasW) / 2),
    panY: Math.round((canvasH - photoCanvasH) / 2),
    zoom,
  }
}

/**
 * Constrain pan so at least `minVisibleFraction` of the photo stays
 * visible inside the canvas (§7.A.3 — minimum 10% of photo must remain
 * visible). Returns clamped {panX, panY}.
 */
export function clampPan(viewport, photoSize, canvasW, canvasH, minVisibleFraction = 0.1) {
  const photoCanvasW = photoSize.width * viewport.zoom
  const photoCanvasH = photoSize.height * viewport.zoom
  const minVisX = Math.max(1, photoCanvasW * minVisibleFraction)
  const minVisY = Math.max(1, photoCanvasH * minVisibleFraction)
  // Right edge of photo at canvas X: panX + photoCanvasW. Must be ≥ minVisX
  // (i.e. at least minVisX worth of photo overlaps from the left).
  // Left edge of photo: panX. Must be ≤ canvasW - minVisX so at least
  // minVisX overlaps from the right.
  const minPanX = -photoCanvasW + minVisX
  const maxPanX = canvasW - minVisX
  const minPanY = -photoCanvasH + minVisY
  const maxPanY = canvasH - minVisY
  return {
    panX: Math.min(maxPanX, Math.max(minPanX, viewport.panX)),
    panY: Math.min(maxPanY, Math.max(minPanY, viewport.panY)),
  }
}

/**
 * Cursor-aligned zoom (§7.A.4) — returns a new viewport where the photo
 * point currently under the cursor remains under the cursor after zoom.
 *   Before: cursor canvas px = photoPt * photoW * zOld + panOld
 *   After:  cursor canvas px = photoPt * photoW * zNew + panNew
 *   Solve: panNew = cursor - photoPt * photoW * zNew
 */
export function zoomAtCursor(viewport, photoSize, cursorCanvasPx, newZoom) {
  const z = clampZoom(newZoom)
  const denomX = photoSize.width * viewport.zoom || 1
  const denomY = photoSize.height * viewport.zoom || 1
  const photoPtX = (cursorCanvasPx.x - viewport.panX) / denomX
  const photoPtY = (cursorCanvasPx.y - viewport.panY) / denomY
  return {
    panX: Math.round(cursorCanvasPx.x - photoPtX * photoSize.width * z),
    panY: Math.round(cursorCanvasPx.y - photoPtY * photoSize.height * z),
    zoom: z,
  }
}

export function clampZoom(z, fitMin = ZOOM_MIN_CAP) {
  if (!Number.isFinite(z)) return 1
  return Math.min(ZOOM_MAX, Math.max(fitMin, z))
}
