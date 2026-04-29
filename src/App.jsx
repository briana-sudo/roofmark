import { useAppStore } from './store/useAppStore'
import CanvasStage from './components/CanvasStage'
import LayerPanel from './components/LayerPanel'
import DrawingTools from './components/DrawingTools'
import ModeToggle from './components/ModeToggle'
import PropertiesPanel from './components/PropertiesPanel'
import './App.css'

export default function App() {
  const mode = useAppStore((s) => s.mode)
  const saveState = useAppStore((s) => s.saveState)
  const rightDrawerOpen = useAppStore((s) => s.rightDrawerOpen)
  const toggleRightDrawer = useAppStore((s) => s.toggleRightDrawer)
  const jobContext = useAppStore((s) => s.jobContext)
  const tool = useAppStore((s) => s.tool)
  const activeLayerId = useAppStore((s) => s.activeLayerId)
  const cursorX = useAppStore((s) => s.cursorX)
  const cursorY = useAppStore((s) => s.cursorY)
  const snapType = useAppStore((s) => s.snapType)
  const layers = useAppStore((s) => s.layers)

  const shapeCount = layers.reduce((n, l) => n + (l.shapes?.length || 0), 0)

  return (
    <div className="app">
      <header className="app-header" role="banner">
        <span className="hdr-app">RoofMark</span>
        <span className="hdr-divider" />
        <span className="hdr-job" data-slot="job">
          <span className="hdr-label">Job:</span>
          <span className="hdr-value">{jobContext?.address ?? '—'}</span>
        </span>
        <span className="hdr-scope" data-slot="scope">
          <span className="hdr-label">Scope:</span>
          <span className="hdr-value">{jobContext?.scope ?? '—'}</span>
        </span>
        <span className="hdr-spacer" />
        <ModeToggle />
        <button
          type="button"
          className={rightDrawerOpen ? 'btn-drawer-toggle active' : 'btn-drawer-toggle'}
          onClick={toggleRightDrawer}
          title={rightDrawerOpen ? 'Hide properties drawer' : 'Show properties drawer'}
          aria-pressed={rightDrawerOpen}
          aria-controls="panel-right"
          data-testid="btn-drawer-toggle"
        >
          ⚙ Properties
        </button>
        <span className={`hdr-save state-${saveState}`} data-slot="save">
          ● {saveState}
        </span>
      </header>

      <div className={`app-body ${rightDrawerOpen ? 'right-open' : 'right-collapsed'}`}>
        <LayerPanel />

        <main className="canvas-area" aria-label="Canvas">
          <div className="canvas-toolbar">
            <DrawingTools />
          </div>
          <CanvasStage />
          {/*
            Drawer-edge handle — belt-and-suspenders affordance for the
            right drawer toggle (Step 10 partial-completion fix). The
            header button is the primary control; this floating tab on
            the canvas right edge provides a visually-obvious "open me"
            cue when the drawer is collapsed, and a "close me" cue when
            open. Pinned to the right edge of the canvas-area so it
            stays reachable regardless of header overflow.
          */}
          <button
            type="button"
            className="drawer-edge-handle"
            onClick={toggleRightDrawer}
            title={rightDrawerOpen ? 'Close properties drawer' : 'Open properties drawer'}
            aria-label={rightDrawerOpen ? 'Close properties drawer' : 'Open properties drawer'}
            aria-pressed={rightDrawerOpen}
            data-testid="btn-drawer-edge"
          >
            <span aria-hidden="true">{rightDrawerOpen ? '›' : '‹'}</span>
          </button>
        </main>

        <PropertiesPanel />
      </div>

      <footer className="status-bar" role="status">
        <span className="status-cell">Mode: {mode}</span>
        <span className="status-cell">Tool: {tool ?? '—'}</span>
        <span className="status-cell">Layer: {activeLayerId ?? '—'}</span>
        <span className="status-cell">X: {cursorX}</span>
        <span className="status-cell">Y: {cursorY}</span>
        <span className="status-cell">Snap: {snapType ?? '—'}</span>
        <span className="status-cell">Shapes: {shapeCount}</span>
      </footer>
    </div>
  )
}
