import { useAppStore } from './store/useAppStore'
import CanvasStage from './components/CanvasStage'
import LayerPanel from './components/LayerPanel'
import DrawingTools from './components/DrawingTools'
import ModeToggle from './components/ModeToggle'
import PropertiesPanel from './components/PropertiesPanel'
import SequencePanel from './components/SequencePanel'
import AnnotationPanel from './components/AnnotationPanel'
import './App.css'

export default function App() {
  const mode = useAppStore((s) => s.mode)
  const saveState = useAppStore((s) => s.saveState)
  const rightDrawerOpen = useAppStore((s) => s.rightDrawerOpen)
  const toggleRightDrawer = useAppStore((s) => s.toggleRightDrawer)
  // Step 11 — drawer tab determines which body fills the right drawer.
  const drawerTab = useAppStore((s) => s.drawerTab)
  const setDrawerTab = useAppStore((s) => s.setDrawerTab)
  const jobContext = useAppStore((s) => s.jobContext)
  const tool = useAppStore((s) => s.tool)
  const activeLayerId = useAppStore((s) => s.activeLayerId)
  const cursorX = useAppStore((s) => s.cursorX)
  const cursorY = useAppStore((s) => s.cursorY)
  const snapType = useAppStore((s) => s.snapType)
  const layers = useAppStore((s) => s.layers)
  // Section 7.A — viewport zoom level for the status bar readout.
  const viewportZoom = useAppStore((s) => s.viewport?.zoom ?? 1)
  // Step 13 — Annotations tab is gated to SEQUENCE mode + active sequence.
  // The tab BUTTON only renders under that gate; if drawerTab persisted
  // as 'annotations' from a prior session but the gate is closed now, the
  // body falls back to 'properties' for rendering. The persisted choice
  // is preserved so the operator returns to the Annotations tab when the
  // gate re-opens.
  const activeSeqId = useAppStore((s) => s.activeSeqId)
  const showAnnotationsTab = mode === 'SEQUENCE' && !!activeSeqId
  const effectiveDrawerTab =
    drawerTab === 'annotations' && !showAnnotationsTab ? 'properties' : drawerTab

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

        {/*
          Step 11 — right drawer hosts a two-tab view: Properties (per-active-
          layer color/fill/stroke from Step 10) and Sequences (per-sequence
          layer-visibility from Step 11). Tabs are visible chips at the top of
          the drawer (Rule 28: every new affordance must be operator-discoverable
          via natural UI exploration). Drawer wrapper + tab strip live here so
          the body can swap content without re-mounting the wrapper.
        */}
        <aside
          className="panel-right"
          aria-label="Properties / Sequences drawer"
          aria-hidden={!rightDrawerOpen}
          id="panel-right"
        >
          <div className="drawer-tabs" role="tablist" aria-label="Drawer view">
            <button
              type="button"
              role="tab"
              className={effectiveDrawerTab === 'properties' ? 'drawer-tab active' : 'drawer-tab'}
              onClick={() => setDrawerTab('properties')}
              aria-selected={effectiveDrawerTab === 'properties'}
              data-testid="drawer-tab-properties"
            >
              Properties
            </button>
            <button
              type="button"
              role="tab"
              className={effectiveDrawerTab === 'sequences' ? 'drawer-tab active' : 'drawer-tab'}
              onClick={() => setDrawerTab('sequences')}
              aria-selected={effectiveDrawerTab === 'sequences'}
              data-testid="drawer-tab-sequences"
            >
              Sequences
            </button>
            {showAnnotationsTab && (
              <button
                type="button"
                role="tab"
                className={effectiveDrawerTab === 'annotations' ? 'drawer-tab active' : 'drawer-tab'}
                onClick={() => setDrawerTab('annotations')}
                aria-selected={effectiveDrawerTab === 'annotations'}
                data-testid="drawer-tab-annotations"
              >
                Annotations
              </button>
            )}
          </div>
          <div className="drawer-tab-body" role="tabpanel">
            {effectiveDrawerTab === 'annotations'
              ? <AnnotationPanel />
              : effectiveDrawerTab === 'sequences'
              ? <SequencePanel />
              : <PropertiesPanel />}
          </div>
        </aside>
      </div>

      <footer className="status-bar" role="status">
        <span className="status-cell">Mode: {mode}</span>
        <span className="status-cell">Tool: {tool ?? '—'}</span>
        <span className="status-cell">Layer: {activeLayerId ?? '—'}</span>
        <span className="status-cell">X: {cursorX}</span>
        <span className="status-cell">Y: {cursorY}</span>
        <span className="status-cell">Snap: {snapType ?? '—'}</span>
        <span className="status-cell">Shapes: {shapeCount}</span>
        {/* Section 7.A.5 — viewport zoom readout. */}
        <span className="status-cell" data-testid="status-zoom">
          Zoom: {viewportZoom.toFixed(2)}x
        </span>
        {/*
          Step 12 partial-completion fix — operator-verifiable build marker.
          Lets the operator confirm the page is loading the latest deployed
          bundle (not a stale browser cache). Compare to the commit SHA of
          the most-recent deploy. Defined at build time via Vite `define`.
        */}
        <span className="status-cell status-build" title="Loaded build commit (short SHA)" data-testid="status-build">
          Build: {typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev'}
        </span>
      </footer>
    </div>
  )
}
