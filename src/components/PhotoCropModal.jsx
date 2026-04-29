import { useEffect, useRef, useState } from 'react'

/**
 * PhotoCropModal — Section 7.A.1 photo loading + cropping.
 *
 * Modal that overlays the canvas at photo upload (and from PropertiesPanel
 * "Re-crop photo"). Operator adjusts a crop rectangle over the source
 * photo and confirms; the modal returns the cropped data URL + photo
 * dimensions + crop rect so the caller can persist source + cropped to
 * IndexedDB and update store viewport.
 *
 * Inputs:
 *   sourceDataURL  — original photo as a data URL (load result of <input file>)
 *   initialCrop    — optional pre-loaded crop rect for re-crop ({x, y, w, h, rotation})
 *   onConfirm({ croppedDataURL, sourceDataURL, width, height, cropMeta })
 *   onCancel()
 *
 * Aspect lock options: free / 16:9 / 4:3 / 1:1.
 * Rotation: 90° increments only (P27 deferred for freeform).
 *
 * The modal renders the source photo into a working canvas at fit-to-overlay
 * scale, draws an adjustable crop rect on top, and exposes 4 corner + 4
 * edge handles for resize plus an interior drag for reposition.
 */
const ASPECT_OPTIONS = [
  { id: 'free',  label: 'Free' },
  { id: '16:9',  label: '16:9' },
  { id: '4:3',   label: '4:3' },
  { id: '1:1',   label: 'Square' },
]
const HANDLE_PX = 12 // hit area for corners/edges

export default function PhotoCropModal({ sourceDataURL, initialCrop, onConfirm, onCancel }) {
  const overlayRef = useRef(null)
  const canvasRef = useRef(null)
  const [imageEl, setImageEl] = useState(null)
  const [imageDims, setImageDims] = useState(null) // {w, h} of source-photo px
  const [aspect, setAspect] = useState('free')
  const [rotation, setRotation] = useState(initialCrop?.rotation ?? 0) // 0|90|180|270
  const [cropPx, setCropPx] = useState(null) // {x, y, w, h} in source-photo px
  // dragging: { mode: 'move'|'corner-tl'|'corner-tr'|'corner-bl'|'corner-br'
  //                  |'edge-l'|'edge-r'|'edge-t'|'edge-b',
  //             startCursor, startCrop }
  const [dragging, setDragging] = useState(null)

  // Load the source image once to get its native dims.
  useEffect(() => {
    if (!sourceDataURL) return
    const img = new Image()
    img.onload = () => {
      setImageEl(img)
      setImageDims({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = sourceDataURL
  }, [sourceDataURL])

  // Initial crop rect: use initialCrop if present, otherwise full image.
  // setState inside effect is the legitimate pattern here — `imageDims`
  // arrives asynchronously (via the image's load event), so the crop
  // initialization can't be a render-time computation.
  useEffect(() => {
    if (!imageDims) return
    if (initialCrop && initialCrop.w > 0 && initialCrop.h > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCropPx({ x: initialCrop.x, y: initialCrop.y, w: initialCrop.w, h: initialCrop.h })
    } else {
      setCropPx({ x: 0, y: 0, w: imageDims.w, h: imageDims.h })
    }
  }, [imageDims, initialCrop])

  // Compute fit-to-overlay scale. Refs aren't safe to read during render,
  // so recompute via an effect that runs after mount + on resize. The
  // setState calls inside the effect are the legitimate pattern: imageDims
  // and overlay-ref-size are external (async) inputs.
  const [fit, setFit] = useState(null)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!imageDims) { setFit(null); return }
    const overlay = overlayRef.current
    if (!overlay) return
    const recompute = () => {
      const r = overlay.getBoundingClientRect()
      const maxW = r.width - 64
      const maxH = r.height - 160
      const rotated = (rotation === 90 || rotation === 270)
        ? { w: imageDims.h, h: imageDims.w }
        : { w: imageDims.w, h: imageDims.h }
      const scale = Math.min(maxW / rotated.w, maxH / rotated.h, 1)
      setFit({ scale, dispW: rotated.w * scale, dispH: rotated.h * scale, rotatedW: rotated.w, rotatedH: rotated.h })
    }
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [imageDims, rotation])

  // Render the source photo + crop rect into the overlay canvas. Re-runs
  // every time crop / rotation / dims change.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !imageEl || !cropPx || !fit) return
    const dpr = window.devicePixelRatio || 1
    cv.width  = Math.round(fit.dispW * dpr)
    cv.height = Math.round(fit.dispH * dpr)
    cv.style.width  = fit.dispW + 'px'
    cv.style.height = fit.dispH + 'px'
    const ctx = cv.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.scale(dpr, dpr)

    // Draw the source image, applying rotation around the canvas center.
    ctx.save()
    ctx.translate(fit.dispW / 2, fit.dispH / 2)
    ctx.rotate((rotation * Math.PI) / 180)
    const w = imageDims.w * fit.scale
    const h = imageDims.h * fit.scale
    ctx.drawImage(imageEl, -w / 2, -h / 2, w, h)
    ctx.restore()

    // Translate crop rect from source-photo px to overlay canvas px.
    // (We do this only for the un-rotated case for now; rotation is
    // applied to the photo render but the crop rect lives in source-px
    // space — this is a known limitation, captured by P27/P28.)
    const cx = cropPx.x * fit.scale
    const cy = cropPx.y * fit.scale
    const cw = cropPx.w * fit.scale
    const ch = cropPx.h * fit.scale

    // Dim outside the crop rect.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.fillRect(0, 0, fit.dispW, cy)
    ctx.fillRect(0, cy + ch, fit.dispW, fit.dispH - cy - ch)
    ctx.fillRect(0, cy, cx, ch)
    ctx.fillRect(cx + cw, cy, fit.dispW - cx - cw, ch)

    // Crop rect outline.
    ctx.strokeStyle = '#1f6feb'
    ctx.lineWidth = 2
    ctx.strokeRect(cx + 0.5, cy + 0.5, cw, ch)

    // Handle dots: 4 corners + 4 edge midpoints.
    const drawHandle = (hx, hy) => {
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#1f6feb'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(hx, hy, HANDLE_PX / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    drawHandle(cx, cy)              // tl
    drawHandle(cx + cw, cy)         // tr
    drawHandle(cx, cy + ch)         // bl
    drawHandle(cx + cw, cy + ch)    // br
    drawHandle(cx + cw / 2, cy)     // edge-t
    drawHandle(cx + cw / 2, cy + ch) // edge-b
    drawHandle(cx, cy + ch / 2)     // edge-l
    drawHandle(cx + cw, cy + ch / 2) // edge-r
  }, [imageEl, imageDims, cropPx, fit, rotation])

  // ---- Pointer handling on the overlay canvas ----
  const handleAt = (clientX, clientY) => {
    if (!cropPx || !fit) return null
    const rect = canvasRef.current.getBoundingClientRect()
    const cx = cropPx.x * fit.scale
    const cy = cropPx.y * fit.scale
    const cw = cropPx.w * fit.scale
    const ch = cropPx.h * fit.scale
    const x = clientX - rect.left
    const y = clientY - rect.top
    const hits = [
      { id: 'corner-tl', x: cx,         y: cy },
      { id: 'corner-tr', x: cx + cw,    y: cy },
      { id: 'corner-bl', x: cx,         y: cy + ch },
      { id: 'corner-br', x: cx + cw,    y: cy + ch },
      { id: 'edge-t',    x: cx + cw/2,  y: cy },
      { id: 'edge-b',    x: cx + cw/2,  y: cy + ch },
      { id: 'edge-l',    x: cx,         y: cy + ch/2 },
      { id: 'edge-r',    x: cx + cw,    y: cy + ch/2 },
    ]
    for (const h of hits) {
      const dx = x - h.x, dy = y - h.y
      if (dx * dx + dy * dy <= (HANDLE_PX / 2 + 4) ** 2) return h.id
    }
    if (x >= cx && x <= cx + cw && y >= cy && y <= cy + ch) return 'move'
    return null
  }

  const onMouseDown = (e) => {
    e.preventDefault()
    const id = handleAt(e.clientX, e.clientY)
    if (!id) return
    setDragging({
      mode: id,
      startCursor: { x: e.clientX, y: e.clientY },
      startCrop: { ...cropPx },
    })
  }
  const onMouseMove = (e) => {
    if (!dragging || !imageDims) return
    const dxPx = (e.clientX - dragging.startCursor.x) / fit.scale
    const dyPx = (e.clientY - dragging.startCursor.y) / fit.scale
    let { x, y, w, h } = dragging.startCrop
    if (dragging.mode === 'move') {
      x += dxPx; y += dyPx
    } else {
      // Resize. Map handle id to which edges move.
      let nx = x, ny = y, nw = w, nh = h
      if (dragging.mode.includes('l') || dragging.mode === 'edge-l') { nx = x + dxPx; nw = w - dxPx }
      if (dragging.mode.includes('r') || dragging.mode === 'edge-r') { nw = w + dxPx }
      if (dragging.mode.includes('t') || dragging.mode === 'edge-t') { ny = y + dyPx; nh = h - dyPx }
      if (dragging.mode.includes('b') || dragging.mode === 'edge-b') { nh = h + dyPx }
      x = nx; y = ny; w = nw; h = nh
    }
    // Aspect lock: reshape h to match aspect after resize (simple impl).
    if (aspect !== 'free' && (dragging.mode.startsWith('corner') || dragging.mode.startsWith('edge'))) {
      const r = aspect === '16:9' ? 16/9 : aspect === '4:3' ? 4/3 : 1
      // Anchor on corner-tl by default; recompute h from w.
      h = w / r
    }
    // Clamp to image bounds + minimum size.
    const MIN = 16
    if (w < MIN) w = MIN
    if (h < MIN) h = MIN
    if (x < 0) { w += x; x = 0 }
    if (y < 0) { h += y; y = 0 }
    if (x + w > imageDims.w) w = imageDims.w - x
    if (y + h > imageDims.h) h = imageDims.h - y
    setCropPx({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) })
  }
  const onMouseUp = () => setDragging(null)

  const onConfirmClick = () => {
    if (!imageEl || !cropPx) return
    // Render the cropped + rotated photo to a buffer canvas and emit
    // its data URL. For 90/270 rotations the output is rotated.
    const buffer = document.createElement('canvas')
    const useRotated = rotation === 90 || rotation === 270
    const outW = useRotated ? cropPx.h : cropPx.w
    const outH = useRotated ? cropPx.w : cropPx.h
    buffer.width = outW
    buffer.height = outH
    const ctx = buffer.getContext('2d')
    ctx.save()
    ctx.translate(outW / 2, outH / 2)
    ctx.rotate((rotation * Math.PI) / 180)
    // Source rect = cropPx; dest = centered around 0,0.
    ctx.drawImage(imageEl, cropPx.x, cropPx.y, cropPx.w, cropPx.h, -cropPx.w / 2, -cropPx.h / 2, cropPx.w, cropPx.h)
    ctx.restore()
    onConfirm({
      croppedDataURL: buffer.toDataURL('image/jpeg', 0.9),
      sourceDataURL,
      width: outW,
      height: outH,
      cropMeta: { x: cropPx.x, y: cropPx.y, w: cropPx.w, h: cropPx.h, rotation },
    })
  }

  return (
    <div
      ref={overlayRef}
      className="photo-crop-overlay"
      role="dialog"
      aria-label="Crop photo"
      data-testid="photo-crop-modal"
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <div className="photo-crop-shell">
        <div className="photo-crop-header">
          <span className="photo-crop-title">Crop photo</span>
          <span className="photo-crop-spacer" />
          <label className="photo-crop-aspect">
            Aspect:&nbsp;
            <select value={aspect} onChange={(e) => setAspect(e.target.value)} data-testid="photo-crop-aspect">
              {ASPECT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <button type="button" className="btn-panel-action" onClick={() => setRotation((rotation + 270) % 360)} title="Rotate left 90°" data-testid="photo-crop-rotate-l">⟲ Rotate L</button>
          <button type="button" className="btn-panel-action" onClick={() => setRotation((rotation + 90) % 360)} title="Rotate right 90°" data-testid="photo-crop-rotate-r">⟳ Rotate R</button>
        </div>
        <div className="photo-crop-canvas-wrap">
          <canvas ref={canvasRef} onMouseDown={onMouseDown} className="photo-crop-canvas" />
        </div>
        <div className="photo-crop-footer">
          <span className="photo-crop-meta" data-testid="photo-crop-meta">
            {cropPx ? `${cropPx.w} × ${cropPx.h} px` : ''}
            {rotation ? ` · rotated ${rotation}°` : ''}
          </span>
          <span className="photo-crop-spacer" />
          <button type="button" className="btn-panel-action" onClick={onCancel} data-testid="photo-crop-cancel">Cancel</button>
          <button type="button" className="btn-panel-action btn-add" onClick={onConfirmClick} data-testid="photo-crop-confirm">
            Confirm crop
          </button>
        </div>
      </div>
    </div>
  )
}
