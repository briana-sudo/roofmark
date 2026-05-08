import { useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
// Step 17 partial #2 (Gap 2) — photoIDB writes moved into the store
// (commitCroppedPhoto + clearBackgroundImage). Components no longer
// touch photoIDB directly so backup-to-_undo always runs.
import {
  effectivePhotoSize, computeFitViewport, zoomAtCursor, clampPan, clampZoom,
} from '../store/viewport'
import PhotoCropModal from './PhotoCropModal'
import SnapMenu from './SnapMenu'

/**
 * DrawingTools — Step 5 of Kickoff Spec §6.
 *
 * Toolbar that selects the active drawing tool. Reads `tool` from the
 * store and calls `setTool(id)`; clicking the active tool toggles it
 * off (sets tool to null). Buttons are disabled when no active layer
 * is selected, with a hint to pick one.
 *
 * The actual drawing state machine lives in CanvasStage — this is just
 * the UI for changing the `tool` slice.
 */
const SHAPE_TOOLS = [
  { id: 'poly', icon: '▱', name: 'Poly', label: 'Polygon — click to place points, double-click or snap-close to commit' },
  { id: 'rect', icon: '▭', name: 'Rect', label: 'Rectangle — click and drag, release to commit' },
  { id: 'tri',  icon: '△', name: 'Tri',  label: 'Triangle — three clicks; auto-commits on third' },
  { id: 'circ', icon: '○', name: 'Circ', label: 'Circle — click center, drag radius, release to commit' },
  // P6 (May 7 2026) — Arc + Ellipse.
  { id: 'arc',     icon: '⌒', name: 'Arc', label: 'Arc — 3 clicks: start, mid, end. Arc passes through all three points.' },
  { id: 'ellipse', icon: '⬭', name: 'Ellipse', label: 'Ellipse — click and drag to define a bounding box; ellipse fits inscribed.' },
  { id: 'line', icon: '╱', name: 'Line', label: 'Line — two clicks; auto-commits on second' },
]

const CLINE_TOOL = {
  id: 'cline',
  icon: '┊',
  name: 'CLine',
  label: 'Construction line — drag to place horizontal / vertical / angled reference line',
}

// Step 12 — annotation tools per Spec §12. Active only in SEQUENCE mode
// with an active sequence; annotations are stored under
// `sequence.annotations` and lock to the active sequence at create-time.
//   callout — 2-click (tip + tail) -> { type, tip:{x,y}, tail:{x,y}, textEN, textES }
//   dimline — 2-click (a + b)        -> { type, a:{x,y}, b:{x,y}, value }
//   note    — 1-click                -> { type, at:{x,y}, textEN, textES }
const ANNOTATION_TOOLS = [
  { id: 'callout', icon: '➥', name: 'Callout', label: 'Callout — click tip, then click tail. Adds a labelled marker for the active sequence.' },
  { id: 'dimline', icon: '⤢', name: 'Dim',     label: 'Dimension line — click two endpoints to place a measurement line for the active sequence.' },
  { id: 'note',    icon: '✎', name: 'Note',    label: 'General note — click once to drop a sequence-scoped note pin.' },
]

export default function DrawingTools() {
  const tool = useAppStore((s) => s.tool)
  const setTool = useAppStore((s) => s.setTool)
  const activeLayerId = useAppStore((s) => s.activeLayerId)
  // Step 12 — annotation tools require SEQUENCE mode + an active sequence.
  const mode = useAppStore((s) => s.mode)
  const activeSeqId = useAppStore((s) => s.activeSeqId)
  // Section 7.A — viewport state drives the toolbar zoom buttons.
  const viewport = useAppStore((s) => s.viewport)
  const photoMeta = useAppStore((s) => s.photoMeta)
  const setViewport = useAppStore((s) => s.setViewport)
  // P37 (May 7 2026) — Zoom in/out are operator-initiated so they mark
  // the viewport touched. Fit routes through fitToViewport which
  // computes fit + clears the flag, restoring auto-fit behavior on
  // subsequent canvas-size changes.
  const markViewportTouched = useAppStore((s) => s.markViewportTouched)
  const fitToViewport = useAppStore((s) => s.fitToViewport)
  const clinesVisible = useAppStore((s) => s.clinesVisible)
  const toggleClinesVisibility = useAppStore((s) => s.toggleClinesVisibility)
  const snapEnabled = useAppStore((s) => s.snapEnabled)
  const toggleSnap = useAppStore((s) => s.toggleSnap)
  const gridEnabled = useAppStore((s) => s.gridEnabled)
  const toggleGrid = useAppStore((s) => s.toggleGrid)
  // Step 10 / P12+P14 — operator-adjustable rectangular grid spacing.
  const gridSize = useAppStore((s) => s.gridSize)
  const setGridSizeAxis = useAppStore((s) => s.setGridSizeAxis)
  // P19 (May 7 2026) — operator-adjustable grid line opacity.
  const gridOpacity = useAppStore((s) => s.gridOpacity)
  const setGridOpacity = useAppStore((s) => s.setGridOpacity)
  // P38 (May 8 2026) — single-angle grid rotation. Dimmed (NOT hidden)
  // when perspectiveCorners are active (Option Y).
  const gridRotation = useAppStore((s) => s.gridRotation)
  const setGridRotation = useAppStore((s) => s.setGridRotation)
  // P16 (May 8 2026) — perspective grid edit mode toggle + corners state.
  const perspectiveEditMode = useAppStore((s) => s.perspectiveEditMode)
  const togglePerspectiveEditMode = useAppStore((s) => s.togglePerspectiveEditMode)
  const perspectiveCorners = useAppStore((s) => s.perspectiveCorners)
  const clearPerspectiveCorners = useAppStore((s) => s.clearPerspectiveCorners)
  // Option Y composition: rotation is ignored at render+snap time when
  // perspective is active. UI dims the rotation input + tooltip explains.
  const perspectiveActive = !!(perspectiveCorners && perspectiveCorners.length === 4)
  const backgroundImage = useAppStore((s) => s.backgroundImage)
  const clearBackgroundImage = useAppStore((s) => s.clearBackgroundImage)

  // Shape tools require an active layer (they commit shapes into it).
  // CLines do not — they live in their own array, not in any layer.
  // Step 12 — annotation tools require SEQUENCE mode + an active sequence.
  const shapeDisabled = !activeLayerId
  const clineDisabled = false
  const annoDisabled = mode !== 'SEQUENCE' || !activeSeqId
  const annoHint = mode !== 'SEQUENCE'
    ? 'Switch to SEQ mode to use annotation tools'
    : 'Select a sequence to use annotation tools'

  const onSelect = (id, disabled) => {
    if (disabled) return
    setTool(tool === id ? null : id)
  }

  // Section 7.A.5 — viewport toolbar handlers. The canvas size is read from
  // the live `.canvas-stage` element so the math matches whatever the
  // canvas is actually rendered at right now (matches CanvasStage's own
  // viewport math). photoSize falls back to canvas dims when no photo is
  // loaded so the buttons still behave (no-op-ish at zoom=1).
  const readCanvasSize = () => {
    const el = document.querySelector('.canvas-stage')
    return { cw: el?.clientWidth || 0, ch: el?.clientHeight || 0 }
  }
  const applyZoom = (factor) => {
    const { cw, ch } = readCanvasSize()
    if (!cw || !ch) return
    const ps = effectivePhotoSize(photoMeta, cw, ch)
    const fitFloor = computeFitViewport(ps, cw, ch).zoom
    const target = clampZoom(viewport.zoom * factor, fitFloor)
    const center = { x: cw / 2, y: ch / 2 }
    const v = zoomAtCursor(viewport, ps, center, target)
    const clamped = clampPan(v, ps, cw, ch)
    // P37 — operator-initiated toolbar zoom. Mark touched so subsequent
    // window resize / toolbar wrap doesn't auto-fit back.
    markViewportTouched()
    setViewport({ zoom: v.zoom, panX: clamped.panX, panY: clamped.panY })
  }
  const onZoomIn  = () => applyZoom(1.25)
  const onZoomOut = () => applyZoom(0.8)
  const onFit = () => {
    const { cw, ch } = readCanvasSize()
    if (!cw || !ch) return
    // P37 — Fit button is "reset my viewport." fitToViewport sets the
    // computed fit + clears the touched flag so subsequent canvas-size
    // changes auto-fit again until the operator pans/zooms manually.
    fitToViewport(cw, ch)
  }

  // Section 7.A — photo flow:
  //   1. operator clicks 📷 Photo → file picker opens
  //   2. operator selects file → load into PhotoCropModal as source
  //   3. operator adjusts crop + confirms → cropped data URL + dims
  //      get persisted to IDB (cropped + source slots) and the canvas
  //      switches to the new working photo with fit-to-viewport
  const fileInputRef = useRef(null)
  const [pendingSource, setPendingSource] = useState(null) // {dataURL} for modal
  const onPickPhoto = () => fileInputRef.current?.click()
  const onPhotoFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again later
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataURL = ev.target?.result
      if (typeof dataURL !== 'string') return
      // Open the crop modal with this data URL as the source. The modal
      // calls back with cropped dataURL + dims on confirm.
      setPendingSource({ dataURL })
    }
    reader.readAsDataURL(file)
  }

  // Step 17 partial-completion #2 (Gap 2) — commitCroppedPhoto backs
  // up the previous photo to _undo slots before writing the new one
  // (Cmd+Z reverses both first-time uploads AND replaces). Mirror
  // change in PhotoPanel.jsx Replace path.
  // Step 17 partial #4 (Bug C) — 📷 toolbar is always Replace from
  // this component (isRecrop: false). Re-crop lives in PhotoPanel.
  // commitCroppedPhoto returns boolean; on false (operator cancelled
  // an out-of-bounds confirm — won't fire here since isRecrop=false
  // skips re-projection, but we honor the contract for safety) keep
  // the modal open.
  const onCropConfirm = async (payload) => {
    try {
      const committed = await useAppStore.getState().commitCroppedPhoto({
        ...payload,
        isRecrop: false,
      })
      if (committed) setPendingSource(null)
    } catch (err) {
      const msg = err?.message || String(err)
      console.warn('Photo commit failed:', msg)
      setPendingSource(null)
      window.alert(`Could not apply photo: ${msg}`)
    }
  }

  const onCropCancel = () => setPendingSource(null)

  // Step 17 partial #2 (Gap 2) — clearBackgroundImage is now async and
  // backs up to _undo slots before wiping live IDB. The component just
  // awaits a single action; the IDB clearing happens inside the store.
  const onClearPhoto = async () => {
    await clearBackgroundImage()
  }

  return (
    <div className="drawing-tools" role="toolbar" aria-label="Drawing tools">
      {/*
        Punch list P4 + P8 (May 7 2026) — `.tool-group` wrappers preserve
        logical groupings under flex-wrap. Each group is `flex-wrap: nowrap`
        so its contents stay together; the parent `.drawing-tools` is
        `flex-wrap: wrap` so groups wrap as units when the canvas-area
        narrows. Dividers sit between groups as bare children of
        `.drawing-tools` so they collapse cleanly at wrap boundaries.
      */}
      {/* Group 1: Shape tools (Poly / Rect / Tri / Circ / Line) */}
      <div className="tool-group" data-tool-group="shape">
        {SHAPE_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tool === t.id ? 'tool-btn active' : 'tool-btn'}
            onClick={() => onSelect(t.id, shapeDisabled)}
            disabled={shapeDisabled}
            title={shapeDisabled ? 'Select a layer first' : t.label}
            aria-pressed={tool === t.id}
            data-tool={t.id}
          >
            <span className="tool-icon" aria-hidden="true">{t.icon}</span>
            <span className="tool-name">{t.name}</span>
          </button>
        ))}
      </div>

      <span className="tool-divider" aria-hidden="true" />

      {/* Group 2: Construction line tool */}
      <div className="tool-group" data-tool-group="cline">
        <button
          key={CLINE_TOOL.id}
          type="button"
          className={tool === CLINE_TOOL.id ? 'tool-btn active' : 'tool-btn'}
          onClick={() => onSelect(CLINE_TOOL.id, clineDisabled)}
          disabled={clineDisabled}
          title={CLINE_TOOL.label}
          aria-pressed={tool === CLINE_TOOL.id}
          data-tool={CLINE_TOOL.id}
        >
          <span className="tool-icon" aria-hidden="true">{CLINE_TOOL.icon}</span>
          <span className="tool-name">{CLINE_TOOL.name}</span>
        </button>
      </div>

      <span className="tool-divider" aria-hidden="true" />

      {/* Group 3: Annotation tools + CLines visibility toggle.
          Step 12 — annotation tools. Visible always (Rule 28 — discoverable
          affordance) but disabled outside SEQUENCE mode + active sequence.
          Hover title surfaces the gating reason on desktop; the inline hint
          at the right of the toolbar surfaces the same reason on iPad/touch
          where hover is unavailable. */}
      <div className="tool-group" data-tool-group="annotation">
        {ANNOTATION_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tool === t.id ? 'tool-btn anno-btn active' : 'tool-btn anno-btn'}
            onClick={() => onSelect(t.id, annoDisabled)}
            disabled={annoDisabled}
            title={annoDisabled ? annoHint : t.label}
            aria-pressed={tool === t.id}
            data-tool={t.id}
          >
            <span className="tool-icon" aria-hidden="true">{t.icon}</span>
            <span className="tool-name">{t.name}</span>
          </button>
        ))}
        <button
          type="button"
          className={clinesVisible ? 'tool-btn cline-vis active' : 'tool-btn cline-vis'}
          onClick={toggleClinesVisibility}
          title={clinesVisible ? 'Hide construction lines' : 'Show construction lines'}
          aria-pressed={clinesVisible}
          data-testid="btn-clines-vis"
        >
          <span className="tool-icon" aria-hidden="true">👁</span>
          <span className="tool-name">CLines</span>
        </button>
      </div>

      <span className="tool-divider" aria-hidden="true" />

      {/* Group 4: Snap + Grid + Grid X/Y inputs + Grid opacity slider.
          P2 (May 7 2026) — SnapMenu (chevron dropdown) sits next to the
          master Snap button. Master toggles all snapping on/off; chevron
          opens a popover with 5 toggle chips for per-type control.
          P19 (May 7 2026) — Grid opacity slider after Grid X/Y inputs.
          Grid X / Grid Y inputs — Step 10 / P12 + P14. */}
      <div className="tool-group" data-tool-group="snap-grid">
        <button
          type="button"
          className={snapEnabled ? 'tool-btn snap-toggle active' : 'tool-btn snap-toggle'}
          onClick={toggleSnap}
          title={snapEnabled ? 'Disable snap' : 'Enable snap'}
          aria-pressed={snapEnabled}
          data-testid="btn-snap"
        >
          <span className="tool-icon" aria-hidden="true">⊞</span>
          <span className="tool-name">Snap</span>
        </button>
        <SnapMenu />
        <button
          type="button"
          className={gridEnabled ? 'tool-btn grid-toggle active' : 'tool-btn grid-toggle'}
          onClick={toggleGrid}
          title={gridEnabled ? 'Disable grid snap' : 'Enable grid snap'}
          aria-pressed={gridEnabled}
          data-testid="btn-grid"
        >
          <span className="tool-icon" aria-hidden="true">▦</span>
          <span className="tool-name">Grid</span>
        </button>
        <label className="grid-axis-input" title="Grid X spacing in pixels">
          <span className="grid-axis-label">X</span>
          <input
            type="number"
            min="1"
            step="1"
            value={gridSize?.x ?? 20}
            onChange={(e) => setGridSizeAxis('x', e.target.value)}
            data-testid="input-grid-x"
          />
        </label>
        <label className="grid-axis-input" title="Grid Y spacing in pixels">
          <span className="grid-axis-label">Y</span>
          <input
            type="number"
            min="1"
            step="1"
            value={gridSize?.y ?? 20}
            onChange={(e) => setGridSizeAxis('y', e.target.value)}
            data-testid="input-grid-y"
          />
        </label>
        <label
          className="grid-opacity-slider"
          title={`Grid line opacity: ${Math.round((gridOpacity ?? 0.16) * 100)}%`}
        >
          <span className="grid-opacity-label" aria-hidden="true">⌬</span>
          <input
            type="range"
            min="0.05"
            max="0.6"
            step="0.02"
            value={gridOpacity ?? 0.16}
            onChange={(e) => setGridOpacity(Number(e.target.value))}
            aria-label="Grid line opacity"
            data-testid="input-grid-opacity"
          />
        </label>
        {/* P38 (May 8 2026) — grid rotation input. Dimmed (NOT hidden)
            when perspective is active per Option Y so the operator's
            rotation choice persists across perspective on/off cycles. */}
        <label
          className={perspectiveActive ? 'grid-rotation-input dimmed' : 'grid-rotation-input'}
          title={
            perspectiveActive
              ? 'Disabled while perspective grid is active'
              : `Grid rotation: ${gridRotation ?? 0}°`
          }
        >
          <span className="grid-rotation-icon" aria-hidden="true">↻</span>
          <input
            type="number"
            min="-180"
            max="180"
            step="1"
            value={gridRotation ?? 0}
            onChange={(e) => setGridRotation(e.target.value)}
            disabled={perspectiveActive}
            aria-label="Grid rotation in degrees"
            data-testid="input-grid-rotation"
          />
          <span className="grid-rotation-unit">°</span>
        </label>
        {/* P16 (May 8 2026) — Perspective button. Click toggles
            perspective-edit mode; when active, 4 corner handles render on
            canvas. First-time activation pre-loads default corners. The
            same button doubles as a "Clear" affordance: shift-click or
            right-click clears corners and exits edit mode. */}
        <button
          type="button"
          className={perspectiveEditMode ? 'tool-btn perspective-btn active' : 'tool-btn perspective-btn'}
          onClick={togglePerspectiveEditMode}
          onContextMenu={(e) => {
            e.preventDefault()
            // Right-click clears perspective corners + exits edit mode.
            if (perspectiveCorners) clearPerspectiveCorners()
            if (perspectiveEditMode) togglePerspectiveEditMode()
          }}
          title={
            perspectiveEditMode
              ? 'Exit perspective edit mode (Esc). Right-click to clear corners.'
              : perspectiveActive
                ? 'Edit perspective grid corners. Right-click to clear corners.'
                : 'Define perspective grid (drag 4 corners over the visible roof rectangle)'
          }
          aria-pressed={perspectiveEditMode}
          data-testid="btn-perspective"
        >
          <span className="tool-icon" aria-hidden="true">▱</span>
          <span className="tool-name">Persp</span>
        </button>
      </div>

      <span className="tool-divider" aria-hidden="true" />

      {/* Group 5: Viewport controls.
          Section 7.A.5 — viewport controls. Visible always (Rule 28); cyan
          tint differentiates them from drawing / annotation tools. Status
          bar carries the live zoom readout for verification. */}
      <div className="tool-group" data-tool-group="viewport">
        <button
          type="button"
          className="tool-btn viewport-btn"
          onClick={onZoomOut}
          title="Zoom out (- key)"
          data-testid="btn-zoom-out"
        >
          <span className="tool-icon" aria-hidden="true">🔍−</span>
        </button>
        <button
          type="button"
          className="tool-btn viewport-btn"
          onClick={onZoomIn}
          title="Zoom in (+ key)"
          data-testid="btn-zoom-in"
        >
          <span className="tool-icon" aria-hidden="true">🔍+</span>
        </button>
        <button
          type="button"
          className="tool-btn viewport-btn"
          onClick={onFit}
          title="Fit photo to viewport (0 key)"
          data-testid="btn-fit"
        >
          <span className="tool-icon" aria-hidden="true">⊡</span>
          <span className="tool-name">Fit</span>
        </button>
      </div>

      <span className="tool-divider" aria-hidden="true" />

      {/* Group 6: Photo (load + clear). The hidden file input lives inside
          the group so it stays mounted alongside the photo button. */}
      <div className="tool-group" data-tool-group="photo">
        <button
          type="button"
          className={backgroundImage ? 'tool-btn photo-btn active' : 'tool-btn photo-btn'}
          onClick={onPickPhoto}
          title={backgroundImage ? 'Replace background photo' : 'Load background photo'}
          data-testid="btn-photo"
        >
          <span className="tool-icon" aria-hidden="true">📷</span>
          <span className="tool-name">Photo</span>
        </button>
        {backgroundImage && (
          <button
            type="button"
            className="tool-btn photo-clear"
            onClick={onClearPhoto}
            title="Clear background photo"
            data-testid="btn-photo-clear"
          >
            <span className="tool-icon" aria-hidden="true">✕</span>
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onPhotoFile}
          style={{ display: 'none' }}
          data-testid="photo-file-input"
        />
      </div>

      {shapeDisabled && <span className="tool-hint">Select a layer to draw shapes</span>}
      {pendingSource && (
        <PhotoCropModal
          sourceDataURL={pendingSource.dataURL}
          onConfirm={onCropConfirm}
          onCancel={onCropCancel}
        />
      )}
    </div>
  )
}
