import { useAppStore } from '../store/useAppStore'

/**
 * ModeToggle — Spec §3 persistent header mode badge, made interactive in
 * Step 9 of Kickoff Spec §16.
 *
 * Renders DRAW / EDIT / SEQUENCE pills — the Field Markup sub-mode row.
 * Phase 2 18a (May 10 2026): TECHNICAL was NOT added here as originally
 * planned. Instead, a separate top-level `appMode` switch (AppModeToggle)
 * lives above this row; ModeToggle (DRAW / EDIT / SEQUENCE) only renders
 * when appMode === 'FIELD'. Click flips `store.mode` via setMode (which
 * also clears the active tool and selection on any mode change).
 * SEQUENCE mode tells the canvas to filter layers by the active
 * sequence's per-layer visibility map (Step 11).
 */
const VISIBLE_MODES = [
  { id: 'DRAW', label: 'Draw' },
  { id: 'EDIT', label: 'Edit' },
  { id: 'SEQUENCE', label: 'Seq' },
]

export default function ModeToggle() {
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)
  return (
    <div className="mode-toggle" role="tablist" aria-label="Editor mode">
      {VISIBLE_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={mode === m.id ? 'mode-pill active' : 'mode-pill'}
          onClick={() => setMode(m.id)}
          role="tab"
          aria-selected={mode === m.id}
          data-mode={m.id}
          data-testid={`mode-${m.id.toLowerCase()}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
