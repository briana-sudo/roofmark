import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * TechSnapMenu — Phase 2 sub-step 18-snap (May 12 2026).
 *
 * Chevron dropdown sibling to the Technical Drawing master Snap button.
 * Mirrors the Field Markup SnapMenu pattern but with 2 chips (Endpoint
 * + Midpoint) instead of FM's 5 (close / grid / corner / midpoint /
 * cline). Independent state — Tech snap chips do not read or write
 * FM `snapTypes` and vice versa.
 *
 * Reuses the SnapMenu CSS classes (.snap-menu, .btn-snap-chevron,
 * .snap-menu-panel, .snap-chip-list, .snap-chip, …) — those styles are
 * purely presentational, not FM-specific, so visual parity stays free.
 *
 * Persistence: `techSnapTypes` is in PERSIST_KEYS so per-type chip
 * preferences survive reload. Master `techSnapEnabled` is NOT persisted
 * (session-only, mirrors FM `snapEnabled`).
 *
 * Closes via outside-click / Escape / explicit ✕ button — same pattern
 * as HelpPopover (P11.b) + HeaderMenu (Step 14) + SnapMenu (P2).
 */
const TECH_SNAP_TYPE_META = [
  { key: 'endpoint', label: 'Endpoint', hint: 'Snap to existing line endpoints' },
  { key: 'midpoint', label: 'Midpoint', hint: 'Snap to midpoints of existing lines' },
]

export default function TechSnapMenu() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const techSnapTypes = useAppStore((s) => s.techSnapTypes)
  const setTechSnapType = useAppStore((s) => s.setTechSnapType)

  // Close on outside click + Escape (mirror of SnapMenu / HelpPopover).
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
        title="Per-snap-type settings (Technical Drawing)"
        aria-label="Per-snap-type settings (Technical Drawing)"
        data-testid="btn-tech-snap-chevron"
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className="snap-menu-panel"
          role="dialog"
          aria-label="Technical snap settings"
          data-testid="tech-snap-menu-panel"
        >
          <div className="snap-menu-header">
            <span className="snap-menu-title">Snap settings</span>
            <button
              type="button"
              className="btn-snap-close"
              onClick={() => setOpen(false)}
              aria-label="Close snap settings"
              title="Close"
              data-testid="btn-tech-snap-close"
            >
              ×
            </button>
          </div>
          <div className="snap-menu-body">
            <p className="snap-menu-help">
              Master <strong>Snap</strong> stays the global on/off. Each chip below toggles a single snap type.
            </p>
            <ul className="snap-chip-list">
              {TECH_SNAP_TYPE_META.map((t) => {
                const enabled = techSnapTypes ? techSnapTypes[t.key] !== false : true
                return (
                  <li key={t.key}>
                    <button
                      type="button"
                      className={enabled ? 'snap-chip active' : 'snap-chip'}
                      onClick={() => setTechSnapType(t.key, !enabled)}
                      title={t.hint}
                      aria-pressed={enabled}
                      data-testid={`tech-snap-chip-${t.key}`}
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
