import { useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import { savePhoto, clearPhoto } from '../store/photoIDB'

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

export default function DrawingTools() {
  const tool = useAppStore((s) => s.tool)
  const setTool = useAppStore((s) => s.setTool)
  const activeLayerId = useAppStore((s) => s.activeLayerId)
  const clinesVisible = useAppStore((s) => s.clinesVisible)
  const toggleClinesVisibility = useAppStore((s) => s.toggleClinesVisibility)
  const snapEnabled = useAppStore((s) => s.snapEnabled)
  const toggleSnap = useAppStore((s) => s.toggleSnap)
  const gridEnabled = useAppStore((s) => s.gridEnabled)
  const toggleGrid = useAppStore((s) => s.toggleGrid)
  const backgroundImage = useAppStore((s) => s.backgroundImage)
  const setBackgroundImage = useAppStore((s) => s.setBackgroundImage)
  const clearBackgroundImage = useAppStore((s) => s.clearBackgroundImage)

  // Shape tools require an active layer (they commit shapes into it).
  // CLines do not — they live in their own array, not in any layer.
  const shapeDisabled = !activeLayerId
  const clineDisabled = false

  const onSelect = (id, disabled) => {
    if (disabled) return
    setTool(tool === id ? null : id)
  }

  // Spec §7 step 2 — photo background loader. Step 8 places the picker
  // here in the canvas toolbar; Step 10 (properties panel) takes
  // ownership of the file-picker UI per Spec §12 and this temporary
  // button can be removed (or rerouted to open the right drawer's
  // picker) at that time.
  const fileInputRef = useRef(null)
  const onPickPhoto = () => fileInputRef.current?.click()
  const onPhotoFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again later
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataURL = ev.target?.result
      if (typeof dataURL !== 'string') return
      const img = new Image()
      img.onload = () => {
        setBackgroundImage(img)
        // Persist to IndexedDB so the photo survives refresh. Fire and
        // forget — render path doesn't depend on this resolving.
        savePhoto(dataURL).catch((err) => {
          console.warn('Failed to persist photo to IndexedDB:', err)
        })
      }
      img.onerror = () => {
        // Bad image — surface to console; don't update store.
        console.warn('Failed to decode photo:', file.name)
      }
      img.src = dataURL
    }
    reader.readAsDataURL(file)
  }

  const onClearPhoto = () => {
    clearBackgroundImage()
    // Also wipe the persisted copy so a refresh doesn't bring it back.
    clearPhoto().catch((err) => {
      console.warn('Failed to clear persisted photo from IndexedDB:', err)
    })
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
    </div>
  )
}
