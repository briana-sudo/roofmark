import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import CanvasStage from './components/CanvasStage'
import LayerPanel from './components/LayerPanel'
import DrawingTools from './components/DrawingTools'
import ModeToggle from './components/ModeToggle'
import AppModeToggle from './components/AppModeToggle'
import PropertiesPanel from './components/PropertiesPanel'
import SequencePanel from './components/SequencePanel'
import AnnotationPanel from './components/AnnotationPanel'
import PhotoPanel from './components/PhotoPanel'
import HelpPopover from './components/HelpPopover'
import HeaderMenu from './components/HeaderMenu'
import './App.css'

export default function App() {
  // Phase 2 18a (May 10 2026) — top-level app mode. Gates several UI
  // surfaces: ModeToggle (DRAW/EDIT/SEQUENCE pills hidden under
  // TECHNICAL), Properties drawer (not rendered under TECHNICAL),
  // DrawingTools tool groups (collapsed to viewport-only under TECHNICAL).
  const appMode = useAppStore((s) => s.appMode)
  // P45 — current save target filename indicator in header.
  const currentFileName = useAppStore((s) => s.currentFileName)
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
  // Step 17 partial-completion #2 (Gap 1) — Photo tab visibility.
  // Visible whenever a photo is loaded (any mode). When the photo is
  // cleared while the operator is on the Photo tab, fall back to
  // Properties (mirrors the Annotations tab gate fallback).
  const photoMeta = useAppStore((s) => s.photoMeta)
  const showAnnotationsTab = mode === 'SEQUENCE' && !!activeSeqId
  const showPhotoTab = !!photoMeta
  const effectiveDrawerTab =
    drawerTab === 'annotations' && !showAnnotationsTab ? 'properties'
    : drawerTab === 'photo' && !showPhotoTab ? 'properties'
    : drawerTab

  // Step 17 — Save / Undo / Redo (P7 bundled). Header buttons + Cmd+S
  // keyboard. Undo / Redo keyboard shortcuts already wired in
  // CanvasStage (Step 2 partial-completion fix); the buttons here are
  // the operator-facing affordance + disabled-state indicator.
  const undoStack = useAppStore((s) => s.undoStack)
  const redoStack = useAppStore((s) => s.redoStack)

  const shapeCount = layers.reduce((n, l) => n + (l.shapes?.length || 0), 0)

  // Step 17 + P45 (Phase 2 18a, May 10 2026) — manual save handler.
  // Delegates to store.saveProject which routes through either:
  //   (a) writeToHandle (Chrome/Edge, silent re-save when handle exists), or
  //   (b) saveProjectAs (first save / no handle / native picker), or
  //   (c) legacy Blob + <a download> fallback (Safari/Firefox).
  // Filename composition + Blob + URL.createObjectURL plumbing all moved
  // into the store actions (saveProject / saveProjectAs). App.jsx just
  // fires the action and lets the store handle the saveState / lastSavedAt
  // updates + IDB persistence of the FileSystemFileHandle.
  const handleSave = async () => {
    try {
      useAppStore.getState().saveNow()
      await useAppStore.getState().saveProject()
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
        {/*
          Phase 2 18a — top-level app mode toggle [Field Markup] [Technical
          Drawing]. Sits above the existing DRAW/EDIT/SEQUENCE mode pill row.
          ModeToggle (DRAW/EDIT/SEQUENCE) renders only when appMode === FIELD;
          under TECHNICAL the inner sub-mode row is hidden entirely because
          Technical Drawing has its own mode semantics (tools land in 18b+).
        */}
        <AppModeToggle />
        {appMode === 'FIELD' && <ModeToggle />}
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
        {/*
          P45 (Phase 2 18a, May 10 2026) — current save target filename.
          Renders the operator's last picked filename so they know where
          subsequent Save will write (no picker needed). Shows "(unsaved)"
          when no handle is captured. Truncates with ellipsis at ~30 chars.
        */}
        <span
          className="hdr-filename"
          data-slot="filename"
          title={currentFileName || 'No save target yet — Save will open a picker'}
          data-testid="hdr-filename"
        >
          {currentFileName ?? '(unsaved)'}
        </span>
        <span className={`hdr-save state-${saveState}`} data-slot="save">
          ● {saveState}
        </span>
        {/*
          Punch list P11.b (May 5 2026) — in-app quick reference popover
          for keyboard shortcuts + UI tour. Sits between the autosave
          indicator and the ⋮ Project menu so the right-side cluster
          reads "feedback (autosave) / help / project actions" left to
          right.
        */}
        <HelpPopover />
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
          Phase 2 18a — gated under appMode === 'FIELD'. Under TECHNICAL the
          drawer infrastructure remains in code; it just doesn't render. The
          rightDrawerOpen state persists across mode switches, so toggling
          back to FIELD restores the prior drawer open/closed state.
        */}
        {appMode === 'FIELD' && (
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
            {showPhotoTab && (
              <button
                type="button"
                role="tab"
                className={effectiveDrawerTab === 'photo' ? 'drawer-tab active' : 'drawer-tab'}
                onClick={() => setDrawerTab('photo')}
                aria-selected={effectiveDrawerTab === 'photo'}
                data-testid="drawer-tab-photo"
              >
                Photo
              </button>
            )}
          </div>
          <div className="drawer-tab-body" role="tabpanel">
            {effectiveDrawerTab === 'annotations'
              ? <AnnotationPanel />
              : effectiveDrawerTab === 'photo'
              ? <PhotoPanel />
              : effectiveDrawerTab === 'sequences'
              ? <SequencePanel />
              : <PropertiesPanel />}
          </div>
        </aside>
        )}
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
