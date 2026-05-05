import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * HeaderMenu — Step 14 of Kickoff Spec §3 / §14, extended in Step 17.
 *
 * Persistent-header dropdown that hosts project-level destructive /
 * housekeeping actions. Step 14 shipped New Project; Step 17 adds
 * Load Project… (JSON file picker → importJSON). The Save action is
 * inline in the header (frequent, Cmd+S equivalent); Load is here
 * (less frequent, no keyboard equivalent in v1) so project-level
 * stuff stays in the kebab.
 *
 * Discoverability (Rule 28): a visible kebab button (⋮) sits at the
 * right edge of the header next to the save indicator. Click toggles
 * the dropdown. Escape or click-outside closes. Each menu item closes
 * the dropdown when fired so the operator returns to the canvas.
 */
export default function HeaderMenu() {
  const [open, setOpen] = useState(false)
  const [importError, setImportError] = useState('')
  const wrapRef = useRef(null)
  const fileInputRef = useRef(null)

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
  const onFilePicked = (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again later
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result
      if (typeof text !== 'string') {
        window.alert('Could not read file as text.')
        return
      }
      try {
        useAppStore.getState().importJSON(text)
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
    </div>
  )
}
