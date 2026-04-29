import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * CanvasStage — Step 3 of Kickoff Spec §7
 *
 * React clone of the proven block at /test/step-3-functional.html. Owns:
 *   - Two stacked canvases (cvStatic z-index 1, cvDynamic z-index 2)
 *   - DPR compensation on mount and resize
 *   - requestAnimationFrame loop with dirty flags (staticDirty, dynamicDirty)
 *   - Mouse / touch handler that mutates the Zustand store cursor state
 *     and flips dynamicDirty — never calls draw functions directly
 *   - Store subscription that flips staticDirty when committed-data slices
 *     (layers / clines) change
 *
 * Step 5 onward will replace the static draw routine's placeholder with
 * the real shape rendering pipeline. Step 3 only proves the substrate.
 */
export default function CanvasStage() {
  const containerRef = useRef(null)
  const staticCanvasRef = useRef(null)
  const dynamicCanvasRef = useRef(null)

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

    const resizeAll = () => {
      sizeCanvas(cvStatic)
      sizeCanvas(cvDynamic)
      staticDirty = true
      dynamicDirty = true
    }
    resizeAll()

    const ro = new ResizeObserver(resizeAll)
    ro.observe(container)
    // window resize covers DPR changes (cross-display drag)
    window.addEventListener('resize', resizeAll)

    // ---- Draw routines (called from rAF loop only) --------------------------
    const drawStatic = () => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      ctxStatic.save()
      ctxStatic.setTransform(1, 0, 0, 1, 0, 0)
      ctxStatic.clearRect(0, 0, cvStatic.width, cvStatic.height)
      ctxStatic.scale(dpr, dpr)
      // Spec §7 static draw step 2: dark grid background (no photo loaded yet)
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
      // Spec §7 static draw step 5: render shapes per visible layer order.
      // Step 3 substrate placeholder — Step 5 will replace with real shapes.
      const layers = useAppStore.getState().layers
      for (const layer of layers) {
        if (!layer.visible) continue
        ctxStatic.strokeStyle = layer.color || '#3b82f6'
        ctxStatic.lineWidth = layer.strokeWeight || 2
        ctxStatic.globalAlpha = layer.strokeOpacity ?? 1.0
        for (const shape of layer.shapes || []) {
          if (shape.type === 'rect' && shape.pts && shape.pts.length === 4) {
            // Shapes use normalized 0.0–1.0 coords (Spec §20). Map to canvas.
            const xs = shape.pts.map((p) => p.x * cw)
            const ys = shape.pts.map((p) => p.y * ch)
            ctxStatic.beginPath()
            ctxStatic.moveTo(xs[0], ys[0])
            for (let i = 1; i < xs.length; i++) ctxStatic.lineTo(xs[i], ys[i])
            ctxStatic.closePath()
            ctxStatic.stroke()
          }
        }
      }
      ctxStatic.globalAlpha = 1
      ctxStatic.restore()
    }

    const drawDynamic = () => {
      const state = useAppStore.getState()
      ctxDynamic.save()
      ctxDynamic.setTransform(1, 0, 0, 1, 0, 0)
      ctxDynamic.clearRect(0, 0, cvDynamic.width, cvDynamic.height)
      ctxDynamic.scale(dpr, dpr)
      // Spec §7 dynamic draw step 5: crosshair at cursor
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

    // ---- rAF loop -----------------------------------------------------------
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

    // ---- Pointer handlers (state + flag only — no direct draw calls) -------
    const onPointerMove = (clientX, clientY) => {
      const rect = cvDynamic.getBoundingClientRect()
      const x = Math.round(clientX - rect.left)
      const y = Math.round(clientY - rect.top)
      useAppStore.getState().setCursor(x, y)
      dynamicDirty = true
    }
    const onMouseMove = (e) => onPointerMove(e.clientX, e.clientY)
    const onTouchMove = (e) => {
      if (e.touches && e.touches.length) {
        useAppStore.getState().setPointerType('touch')
        onPointerMove(e.touches[0].clientX, e.touches[0].clientY)
      }
    }
    cvDynamic.addEventListener('mousemove', onMouseMove)
    cvDynamic.addEventListener('touchmove', onTouchMove, { passive: true })

    // ---- Store subscription: flip staticDirty when committed data changes ---
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.layers !== prev.layers || state.clines !== prev.clines) {
        staticDirty = true
      }
    })

    return () => {
      cancelled = true
      if (rafHandle) cancelAnimationFrame(rafHandle)
      ro.disconnect()
      window.removeEventListener('resize', resizeAll)
      cvDynamic.removeEventListener('mousemove', onMouseMove)
      cvDynamic.removeEventListener('touchmove', onTouchMove)
      unsub()
    }
  }, [])

  return (
    <div className="canvas-stage" ref={containerRef}>
      <canvas id="cvStatic" ref={staticCanvasRef} className="cv-static" aria-hidden="true" />
      <canvas id="cvDynamic" ref={dynamicCanvasRef} className="cv-dynamic" aria-hidden="true" />
    </div>
  )
}
