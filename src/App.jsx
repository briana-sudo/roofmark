import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import CanvasStage from './components/CanvasStage'
import LayerPanel from './components/LayerPanel'
import DrawingTools from './components/DrawingTools'
import ModeToggle from './components/ModeToggle'
import PropertiesPanel from './components/PropertiesPanel'
import SequencePanel from './components/SequencePanel'
import AnnotationPanel from './components/AnnotationPanel'
import HeaderMenu from './components/HeaderMenu'
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

  // Step 17 — Save / Undo / Redo (P7 bundled). Header buttons + Cmd+S
  // keyboard. Undo / Redo keyboard shortcuts already wired in
  // CanvasStage (Step 2 partial-completion fix); the buttons here are
  // the operator-facing affordance + disabled-state indicator.
  const undoStack = useAppStore((s) => s.undoStack)
  const redoStack = useAppStore((s) => s.redoStack)

  const shapeCount = layers.reduce((n, l) => n + (l.shapes?.length || 0), 0)

  // Step 17 — manual save handler. Generates the JSON export payload,
  // creates a Blob, and triggers a download with a sensible filename.
  // Same handler is bound to the visible Save button + Cmd+S/Ctrl+S
  // keyboard shortcut. Per Spec §15: "Saves immediately to localStorage
  // [via the existing autosave subscription] + Updates save indicator
  // to ● saved" — `saveNow()` does both atomically; the JSON export
  // happens after, so a download interrupted mid-flow still leaves the
  // localStorage save in place.
  //
  // Async (Step 17 partial-completion fix, Failure 2): exportJSON now
  // awaits IndexedDB reads to embed both photo slots inline. Typical
  // file is 5–9 MB; the download fires after the IDB reads resolve
  // (sub-second on local browsers).
  const handleSave = async () => {
    try {
      useAppStore.getState().saveNow()
      const json = await useAppStore.getState().exportJSON()
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const d = new Date()
      const pad2 = (n) => String(n).padStart(2, '0')
      const filename = `roofmark-project-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      const msg = err?.message || String(err)
      window.alert(`Save failed: ${msg}`)
    }
  }

  // Step 17 — Cmd+S / Ctrl+S keyboard handler. Document-level so it
  // fires regardless of focus. Skips when focus is in an input/textarea
  // so native browser save dialogs aren't preempted in unexpected
  // contexts (matching the Step 2 keyboard handler conventions in
  // CanvasStage).
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.ctrlKey || e.metaKey
      if (!meta) return
      const k = (e.key || '').toLowerCase()
      if (k !== 's' || e.shiftKey) return
      const tag = (e.target?.tagName || '').toUpperCase()
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable
      if (editable) return
      e.preventDefault()
      handleSave()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // handleSave reads store via getState() only; deps stay empty.
  }, [])

  const handleUndo = () => useAppStore.getState().undo()
  const handleRedo = () => useAppStore.getState().redo()
  const undoDisabled = undoStack.length === 0
  const redoDisabled = redoStack.length === 0

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
        {/*
          Step 17 / P7 — visible Undo + Redo header buttons. Disabled
          when respective stack is empty. Keyboard shortcuts (Ctrl/Cmd
          + Z, Ctrl/Cmd + Y, Ctrl/Cmd + Shift + Z) were wired in Step 2
          partial-completion fix; these buttons are the operator-
          facing affordance for iPad / no-keyboard contexts (P7).
        */}
        <button
          type="button"
          className="btn-hdr btn-undo"
          onClick={handleUndo}
          disabled={undoDisabled}
          title="Undo (Ctrl+Z / Cmd+Z)"
          aria-label="Undo"
          data-testid="btn-undo"
        >
          ↩ Undo
        </button>
        <button
          type="button"
          className="btn-hdr btn-redo"
          onClick={handleRedo}
          disabled={redoDisabled}
          title="Redo (Ctrl+Y / Cmd+Shift+Z)"
          aria-label="Redo"
          data-testid="btn-redo"
        >
          ↪ Redo
        </button>
        {/*
          Step 17 — manual Save button (Spec §15). Triggers the JSON
          export download + flips the autosave indicator to "saved".
          Cmd+S / Ctrl+S also bound at the document level above.
        */}
        <button
          type="button"
          className="btn-hdr btn-save"
          onClick={handleSave}
          title="Save project (Ctrl+S / Cmd+S)"
          aria-label="Save project"
          data-testid="btn-save"
        >
          ⤓ Save
        </button>
        <span className={`hdr-save state-${saveState}`} data-slot="save">
          ● {saveState}
        </span>
        {/*
          Step 14 — persistent-header project menu (Spec §3 / §14).
          Hosts destructive / housekeeping actions; Step 14 ships New
          Project; Step 17 extends with Load Project… (file picker).
        */}
        <HeaderMenu />
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
