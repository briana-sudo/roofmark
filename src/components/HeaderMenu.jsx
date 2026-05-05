import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * HeaderMenu — Step 14 of Kickoff Spec §3 / §14.
 *
 * Persistent-header dropdown that hosts project-level destructive /
 * housekeeping actions. Step 14 ships only the New Project item (which
 * closes Punch List P15 — Clear All rename + relocate). Future steps
 * (16 export, 17 save/load) extend this menu rather than scattering
 * project-level actions across the app.
 *
 * Discoverability (Rule 28): a visible kebab button (⋮) sits at the
 * right edge of the header next to the save indicator. Click toggles
 * the dropdown. Escape or click-outside closes. Each menu item closes
 * the dropdown when fired so the operator returns to the canvas.
 */
export default function HeaderMenu() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

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
    </div>
  )
}
