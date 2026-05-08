import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { exportProjectPDF } from '../utils/generatePDF'

/**
 * HeaderMenu — Step 14 of Kickoff Spec §3 / §14, extended in Step 17 +
 * Step 16 (May 8 2026).
 *
 * Persistent-header dropdown that hosts project-level destructive /
 * housekeeping actions. Step 14 shipped New Project; Step 17 adds
 * Load Project… (JSON file picker → importJSON). The Save action is
 * inline in the header (frequent, Cmd+S equivalent); Load is here
 * (less frequent, no keyboard equivalent in v1) so project-level
 * stuff stays in the kebab.
 *
 * Step 16 (May 8 2026) extension:
 *   - Export English PDF
 *   - Exportar PDF Español
 *   - Orientation: Auto / Portrait / Landscape (persisted radio)
 *
 * Edge-case disable rules:
 *   - 0 sequences → both export buttons disabled with tooltip "Add a sequence first"
 *   - No photo loaded → both buttons disabled with tooltip "Load a photo first"
 *
 * Discoverability (Rule 28): a visible kebab button (⋮) sits at the
 * right edge of the header next to the save indicator. Click toggles
 * the dropdown. Escape or click-outside closes. Each menu item closes
 * the dropdown when fired so the operator returns to the canvas.
 */
export default function HeaderMenu() {
  const [open, setOpen] = useState(false)
  const [importError, setImportError] = useState('')
  const [exportError, setExportError] = useState('')
  const [exportingLang, setExportingLang] = useState(null) // 'en' | 'es' | null
  const wrapRef = useRef(null)
  const fileInputRef = useRef(null)
  const sequences = useAppStore((s) => s.sequences)
  const photoMeta = useAppStore((s) => s.photoMeta)
  const pdfOrientation = useAppStore((s) => s.pdfOrientation)
  const setPdfOrientation = useAppStore((s) => s.setPdfOrientation)
  const exportDisabled = sequences.length === 0 || !photoMeta
  const exportDisabledReason =
    sequences.length === 0 ? 'Add a sequence first'
    : !photoMeta ? 'Load a photo first'
    : ''

  // Close on click-outside / Escape. Defer the document listener via
  // setTimeout(0) so the same click that opens the menu doesn't
  // immediately close it (same pattern as Step 9 ContextMenu).
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDown, true)
      document.addEventListener('keydown', onKey, true)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDocMouseDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const onNewProject = () => {
    setOpen(false)
    const ok = window.confirm(
      'Start a new project? This clears all layers, shapes, sequences, annotations, and the current photo.'
    )
    if (ok) useAppStore.getState().clearAll()
  }

  // Step 16 (May 8 2026) — PDF export handler. Shared by EN + ES menu items.
  // Closes the dropdown, sets exportingLang for spinner UI, builds the
  // project payload from current store state, awaits exportProjectPDF.
  // Auto-download fires inside exportProjectPDF; we only manage the
  // spinner + error surface here.
  const onExportPDF = async (language) => {
    setOpen(false)
    setExportError('')
    setExportingLang(language)
    try {
      const s = useAppStore.getState()
      // backgroundImage is the loaded HTMLImageElement on the live canvas.
      // It's set by photo-load microtasks; for a freshly-loaded project
      // the image may still be decoding — wait if needed.
      const bg = s.backgroundImage
      if (bg && bg.complete && bg.naturalWidth > 0) {
        await exportProjectPDF({
          project: {
            layers: s.layers,
            sequences: s.sequences,
            clines: s.clines,
            jobContext: s.jobContext,
            photoMeta: s.photoMeta,
            clinesVisible: s.clinesVisible,
          },
          language,
          orientationPref: s.pdfOrientation,
          photoImage: bg,
        })
      } else {
        throw new Error('Photo not ready — wait a moment and try again.')
      }
    } catch (err) {
      const msg = err?.message || String(err)
      setExportError(msg)
      window.alert(`PDF export failed: ${msg}`)
    } finally {
      setExportingLang(null)
    }
  }

  // Orientation radio handler — pure setter, doesn't close the dropdown so
  // the operator can switch between auto/portrait/landscape and immediately
  // see the preview-text update before triggering an export.
  const onOrientation = (val) => {
    setPdfOrientation(val)
  }

  // Step 17 — Load Project. Trigger the hidden file input from the menu
  // item; on file select, read as text and pass through importJSON.
  // importJSON validates schemaVersion + applies the full PERSIST_KEYS
  // set; throws on bad input. Surface throw messages via window.alert
  // (matches the existing confirm-dialog UX for project-level actions —
  // Step 18 mobile audit may revisit if a non-blocking toast becomes the
  // norm).
  const onLoadProject = () => {
    setOpen(false)
    setImportError('')
    fileInputRef.current?.click()
  }
  // Step 17 partial-completion fix (Failure 2): importJSON is async to
  // restore embedded photos to IndexedDB before flipping store state.
  // The FileReader.onload handler is itself async so a v2 file's photo
  // round-trip lands cleanly before the canvas re-renders.
  const onFilePicked = (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again later
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const text = ev.target?.result
      if (typeof text !== 'string') {
        window.alert('Could not read file as text.')
        return
      }
      try {
        await useAppStore.getState().importJSON(text)
      } catch (err) {
        const msg = err?.message || String(err)
        window.alert(`Load failed: ${msg}`)
        setImportError(msg)
      }
    }
    reader.onerror = () => {
      window.alert('Could not read the selected file.')
    }
    reader.readAsText(file)
  }

  return (
    <div className="header-menu" ref={wrapRef}>
      <button
        type="button"
        className={open ? 'btn-header-menu open' : 'btn-header-menu'}
        onClick={() => setOpen((s) => !s)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Project menu"
        aria-label="Project menu"
        data-testid="btn-header-menu"
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open && (
        <div
          className="header-menu-dropdown"
          role="menu"
          aria-label="Project menu"
          data-testid="header-menu-dropdown"
        >
          {/* Step 17 — Load Project (JSON import). File picker triggered
              by the hidden input below. Sits above New Project because
              loading is non-destructive (just replaces state from a
              file the operator already owns) while New Project is. */}
          <button
            type="button"
            role="menuitem"
            className="header-menu-item"
            onClick={onLoadProject}
            data-testid="menu-load-project"
          >
            <span className="menu-icon" aria-hidden="true">⤒</span>
            Load Project…
            <span className="menu-hint">Open a previously-saved .json export</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="header-menu-item header-menu-destructive"
            onClick={onNewProject}
            data-testid="menu-new-project"
          >
            <span className="menu-icon" aria-hidden="true">⟲</span>
            New Project
            <span className="menu-hint">Clears layers, shapes, sequences, annotations, photo</span>
          </button>

          {/* Step 16 (May 8 2026) — PDF export. Two language buttons +
              orientation radio group. Disabled-with-tooltip when project
              isn't export-ready (no sequence / no photo). */}
          <div className="header-menu-divider" role="separator" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="header-menu-item"
            onClick={() => onExportPDF('en')}
            disabled={exportDisabled || exportingLang !== null}
            title={exportDisabled ? exportDisabledReason : undefined}
            data-testid="menu-export-pdf-en"
          >
            <span className="menu-icon" aria-hidden="true">📄</span>
            {exportingLang === 'en' ? 'Generating English PDF…' : 'Export English PDF'}
            <span className="menu-hint">
              {exportDisabled ? exportDisabledReason : 'Auto-downloads with smart filename'}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="header-menu-item"
            onClick={() => onExportPDF('es')}
            disabled={exportDisabled || exportingLang !== null}
            title={exportDisabled ? exportDisabledReason : undefined}
            data-testid="menu-export-pdf-es"
          >
            <span className="menu-icon" aria-hidden="true">📄</span>
            {exportingLang === 'es' ? 'Generando PDF en Español…' : 'Exportar PDF Español'}
            <span className="menu-hint">
              {exportDisabled ? exportDisabledReason : 'Auto-descarga con nombre de archivo inteligente'}
            </span>
          </button>

          {/* Orientation submenu — radio-style (persisted preference).
              Click does NOT close the dropdown so the operator can flip
              orientation and re-run an export without re-opening. */}
          <div className="header-menu-divider" role="separator" aria-hidden="true" />
          <div className="header-menu-section-label" aria-hidden="true">PDF Orientation</div>
          {[
            { val: 'auto',      label: 'Auto', hint: 'Landscape if photo is wide; portrait otherwise' },
            { val: 'portrait',  label: 'Portrait', hint: 'Force portrait page' },
            { val: 'landscape', label: 'Landscape', hint: 'Force landscape page' },
          ].map((opt) => (
            <button
              key={opt.val}
              type="button"
              role="menuitemradio"
              aria-checked={pdfOrientation === opt.val}
              className={
                pdfOrientation === opt.val
                  ? 'header-menu-item header-menu-radio active'
                  : 'header-menu-item header-menu-radio'
              }
              onClick={() => onOrientation(opt.val)}
              data-testid={`menu-orientation-${opt.val}`}
            >
              <span className="menu-icon" aria-hidden="true">
                {pdfOrientation === opt.val ? '●' : '○'}
              </span>
              {opt.label}
              <span className="menu-hint">{opt.hint}</span>
            </button>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={onFilePicked}
        style={{ display: 'none' }}
        data-testid="menu-load-file-input"
      />
      {importError && (
        <div className="header-menu-error" role="alert" style={{ display: 'none' }} data-testid="menu-import-error">
          {importError}
        </div>
      )}
      {exportError && (
        <div className="header-menu-error" role="alert" style={{ display: 'none' }} data-testid="menu-export-error">
          {exportError}
        </div>
      )}
    </div>
  )
}
