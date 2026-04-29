import { useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { savePhoto, clearPhoto } from '../store/photoIDB'
import {
  effectivePhotoSize, computeFitViewport, zoomAtCursor, clampPan, clampZoom,
} from '../store/viewport'
import PhotoCropModal from './PhotoCropModal'

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
  const clinesVisible = useAppStore((s) => s.clinesVisible)
  const toggleClinesVisibility = useAppStore((s) => s.toggleClinesVisibility)
  const snapEnabled = useAppStore((s) => s.snapEnabled)
  const toggleSnap = useAppStore((s) => s.toggleSnap)
  const gridEnabled = useAppStore((s) => s.gridEnabled)
  const toggleGrid = useAppStore((s) => s.toggleGrid)
  // Step 10 / P12+P14 — operator-adjustable rectangular grid spacing.
  const gridSize = useAppStore((s) => s.gridSize)
  const setGridSizeAxis = useAppStore((s) => s.setGridSizeAxis)
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
    setViewport({ zoom: v.zoom, panX: clamped.panX, panY: clamped.panY })
  }
  const onZoomIn  = () => applyZoom(1.25)
  const onZoomOut = () => applyZoom(0.8)
  const onFit = () => {
    const { cw, ch } = readCanvasSize()
    if (!cw || !ch) return
    const ps = effectivePhotoSize(photoMeta, cw, ch)
    setViewport(computeFitViewport(ps, cw, ch))
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

  const onCropConfirm = ({ croppedDataURL, sourceDataURL, width, height, cropMeta }) => {
    // Decode cropped image, set on store, persist BOTH source + cropped
    // to IDB. fit-to-viewport happens automatically in CanvasStage's
    // photo-load subscription hook (Section 7.A.2 default).
    const img = new Image()
    img.onload = () => {
      useAppStore.getState().setCroppedPhoto({
        image: img,
        width,
        height,
        cropMeta,
        hasSourcePhoto: true,
      })
    }
    img.src = croppedDataURL
    Promise.all([
      savePhoto(croppedDataURL, 'cropped'),
      savePhoto(sourceDataURL, 'source'),
    ]).catch((err) => console.warn('Failed to persist photos to IndexedDB:', err))
    setPendingSource(null)
  }

  const onCropCancel = () => setPendingSource(null)

  const onClearPhoto = () => {
    clearBackgroundImage()
    // Wipe BOTH slots (cropped + source) so a refresh doesn't bring it back.
    clearPhoto('cropped').catch((err) => console.warn('Failed to clear cropped photo:', err))
    clearPhoto('source').catch((err) => console.warn('Failed to clear source photo:', err))
    // Also clean up the legacy pre-§7.A key just in case.
    clearPhoto('background').catch(() => {})
  }

  return (
    <div className="drawing-tools" role="toolbar" aria-label="Drawing tools">
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

      <span className="tool-divider" aria-hidden="true" />

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

      <span className="tool-divider" aria-hidden="true" />

      {/*
        Step 12 — annotation tools. Visible always (Rule 28 — discoverable
        affordance) but disabled outside SEQUENCE mode + active sequence.
        Hover title surfaces the gating reason on desktop; the inline hint
        at the right of the toolbar surfaces the same reason on iPad/touch
        where hover is unavailable.
      */}
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

      <span className="tool-divider" aria-hidden="true" />

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

      {/*
        Grid X / Grid Y inputs — Step 10 / P12 + P14.
        Independent X and Y spacing for rectangular grids (e.g. standing-seam
        panel layouts: X = 24 px = 1", Y = 384 px = 16" panel width). Default
        20×20 keeps Step 7 square-grid behavior. Clamped to positive integers
        in `setGridSizeAxis`.
      */}
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

      <span className="tool-divider" aria-hidden="true" />

      {/*
        Section 7.A.5 — viewport controls. Visible always (Rule 28); cyan
        tint differentiates them from drawing / annotation tools. Status
        bar carries the live zoom readout for verification.
      */}
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

      <span className="tool-divider" aria-hidden="true" />

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
