import { useEffect, useRef, useState } from 'react'

/**
 * HelpPopover — Punch list P11.b (May 5 2026).
 *
 * In-app quick reference for keyboard shortcuts + key UI affordances.
 * Closes the gap where operators had to leave the app to consult the
 * Notion Operator Guide. This is a lightweight quick-reference, not a
 * replacement for the full Operator Guide page.
 *
 * Mirror of the HeaderMenu open-on-click + Escape + click-outside
 * dismiss pattern (Step 14) so operators learn one interaction model
 * for header dropdowns. Click the ? button → popover opens; click
 * outside / Escape / explicit X button → popover closes.
 *
 * Content is a constant in this component for v1. Future enhancement:
 * pull from a shared source so the Operator Guide and in-app help
 * stay in sync without manual duplication.
 */
export default function HelpPopover() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  // Close on click-outside + Escape (mirror of HeaderMenu pattern,
  // including the setTimeout(0) defer so the same click that opens
  // the popover doesn't immediately close it).
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

  return (
    <div className="help-popover" ref={wrapRef}>
      <button
        type="button"
        className={open ? 'btn-help open' : 'btn-help'}
        onClick={() => setOpen((s) => !s)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Quick reference (keyboard shortcuts + UI tour)"
        aria-label="Quick reference"
        data-testid="btn-help"
      >
        <span aria-hidden="true">?</span>
      </button>
      {open && (
        <div
          className="help-popover-panel"
          role="dialog"
          aria-label="Quick reference"
          data-testid="help-popover-panel"
        >
          <div className="help-popover-header">
            <span className="help-popover-title">RoofMark Quick Reference</span>
            <button
              type="button"
              className="btn-help-close"
              onClick={() => setOpen(false)}
              aria-label="Close quick reference"
              title="Close"
              data-testid="btn-help-close"
            >
              ×
            </button>
          </div>
          <div className="help-popover-body">
            <section className="help-section">
              <div className="help-section-title">Keyboard shortcuts</div>
              <dl className="help-kbd-list">
                <dt><kbd>Esc</kbd></dt>
                <dd>Cancel in-progress draft (poly / tri / rect / circ / line / cline)</dd>
                <dt><kbd>Ctrl/Cmd</kbd>+<kbd>Z</kbd></dt>
                <dd>Undo (50-step history; covers shape edits, photo wipes)</dd>
                <dt><kbd>Ctrl/Cmd</kbd>+<kbd>Y</kbd> or <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></dt>
                <dd>Redo (geometry only — photo wipes are not redoable)</dd>
                <dt><kbd>Ctrl/Cmd</kbd>+<kbd>S</kbd></dt>
                <dd>Save project as JSON (skipped when focus is in a text input)</dd>
                <dt><kbd>Space</kbd> (held)</dt>
                <dd>Hand tool — drag to pan the canvas</dd>
                <dt><kbd>+</kbd> / <kbd>-</kbd></dt>
                <dd>Zoom in / out at canvas center</dd>
                <dt><kbd>0</kbd></dt>
                <dd>Fit photo to viewport</dd>
                <dt><kbd>1</kbd></dt>
                <dd>Zoom to 100% (1× native pixels)</dd>
              </dl>
            </section>
            <section className="help-section">
              <div className="help-section-title">Modes (header)</div>
              <ul className="help-bullet-list">
                <li><strong>DRAW</strong> — draw shapes / construction lines on the active layer</li>
                <li><strong>EDIT</strong> — select + manipulate shapes; selecting a shape auto-activates its parent layer</li>
                <li><strong>SEQUENCE</strong> — preview the crew packet for the active sequence (per-sequence layer filter applies)</li>
              </ul>
            </section>
            <section className="help-section">
              <div className="help-section-title">Right drawer tabs</div>
              <ul className="help-bullet-list">
                <li><strong>Properties</strong> — active layer's color / fill / stroke; Move-to-layer dropdown when a shape is selected in EDIT mode</li>
                <li><strong>Sequences</strong> — sequence list + per-sequence layer toggles</li>
                <li><strong>Annotations</strong> — visible in SEQUENCE mode + active sequence; per-annotation EN / ES textareas</li>
                <li><strong>Photo</strong> — visible when a photo is loaded; Re-crop / Replace / Clear actions (all undoable)</li>
              </ul>
            </section>
            <section className="help-section">
              <div className="help-section-title">⋮ Project menu (right of header)</div>
              <ul className="help-bullet-list">
                <li><strong>Load Project…</strong> — open a previously-saved .json export</li>
                <li><strong>New Project</strong> — clears layers / shapes / sequences / annotations / photo. <em>Irrevocable — no Cmd+Z across the boundary.</em></li>
              </ul>
            </section>
            <section className="help-section">
              <div className="help-section-title">Photo workflow</div>
              <ul className="help-bullet-list">
                <li><strong>📷</strong> (canvas toolbar) — upload a photo, then crop in the modal</li>
                <li><strong>✕</strong> (next to 📷) — clear the photo (Cmd+Z reverses)</li>
                <li><strong>Photo tab</strong> — Re-crop preserves shape positions on roof features; off-canvas shapes get a confirm dialog</li>
              </ul>
            </section>
            <p className="help-footnote">
              For the full operator guide (every UI affordance, every shortcut, every persisted field), see the
              <strong> RoofMark Operator Guide</strong> page in Notion.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
