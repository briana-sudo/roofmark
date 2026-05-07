import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * SnapMenu — Punch list P2 (May 7 2026).
 *
 * Chevron dropdown that opens a popover with 5 per-snap-type toggle
 * chips (Close / Grid / Corner / Midpoint / CLine). Sits next to the
 * master Snap button in the canvas toolbar's snap-grid group.
 *
 * The master Snap button stays as the global on/off (toggleSnap). The
 * chevron + chips control per-type gates. Both work independently:
 *   - Master Snap off → all snapping disabled regardless of per-type.
 *   - Master Snap on AND a per-type off → that type alone skips; others
 *     still active.
 *   - No master cascade — toggling Snap off then on doesn't reset
 *     per-type gates (operator's chosen settings persist).
 *
 * Closes via outside-click / Escape / explicit ✕ button — mirrors the
 * HelpPopover (P11.b) + HeaderMenu (Step 14) pattern. Chips remain
 * interactive while the popover is open so the operator can flip
 * multiple types in one sitting.
 *
 * Persistence: snapTypes is in PERSIST_KEYS so per-type gates survive
 * page reload.
 */
const SNAP_TYPE_META = [
  { key: 'close',    label: 'Close',    hint: 'Snap to first point of poly/tri-in-progress' },
  { key: 'grid',     label: 'Grid',     hint: 'Snap to grid intersections (when Grid is on)' },
  { key: 'corner',   label: 'Corner',   hint: 'Snap to existing shape corners' },
  { key: 'midpoint', label: 'Midpoint', hint: 'Snap to midpoints of existing shape edges' },
  { key: 'cline',    label: 'CLine',    hint: 'Snap to construction lines' },
]

export default function SnapMenu() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const snapTypes = useAppStore((s) => s.snapTypes)
  const setSnapType = useAppStore((s) => s.setSnapType)

  // Close on outside click + Escape (mirror of HelpPopover / HeaderMenu).
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
    <div className="snap-menu" ref={wrapRef}>
      <button
        type="button"
        className={open ? 'btn-snap-chevron open' : 'btn-snap-chevron'}
        onClick={() => setOpen((s) => !s)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Per-snap-type settings"
        aria-label="Per-snap-type settings"
        data-testid="btn-snap-chevron"
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className="snap-menu-panel"
          role="dialog"
          aria-label="Snap settings"
          data-testid="snap-menu-panel"
        >
          <div className="snap-menu-header">
            <span className="snap-menu-title">Snap settings</span>
            <button
              type="button"
              className="btn-snap-close"
              onClick={() => setOpen(false)}
              aria-label="Close snap settings"
              title="Close"
              data-testid="btn-snap-close"
            >
              ×
            </button>
          </div>
          <div className="snap-menu-body">
            <p className="snap-menu-help">
              Master <strong>Snap</strong> stays the global on/off. Each chip below toggles a single snap type.
            </p>
            <ul className="snap-chip-list">
              {SNAP_TYPE_META.map((t) => {
                const enabled = snapTypes ? snapTypes[t.key] !== false : true
                return (
                  <li key={t.key}>
                    <button
                      type="button"
                      className={enabled ? 'snap-chip active' : 'snap-chip'}
                      onClick={() => setSnapType(t.key, !enabled)}
                      title={t.hint}
                      aria-pressed={enabled}
                      data-testid={`snap-chip-${t.key}`}
                    >
                      <span className="snap-chip-mark" aria-hidden="true">{enabled ? '●' : '○'}</span>
                      <span className="snap-chip-label">{t.label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
