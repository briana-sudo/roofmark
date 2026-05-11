import { useAppStore } from '../store/useAppStore'

/**
 * AppModeToggle — Phase 2 sub-step 18a (May 10 2026).
 *
 * Top-level mode switch sits ABOVE the existing DRAW/EDIT/SEQUENCE
 * ModeToggle in the persistent header. Two pills:
 *   [ Field Markup ]  [ Technical Drawing ]
 *
 * Switching mode:
 *   - Calls store.setAppMode which clears transient selection state
 *     (selected, selectedAnnotation, tool) but preserves layers, the
 *     technicalLayers array, and the undo/redo stacks (cross-mode undo
 *     stays unified).
 *   - Each appMode has its own viewport stored in state.viewports[mode],
 *     so pan/zoom in one mode doesn't leak into the other.
 *
 * Render gating elsewhere (driven by appMode):
 *   - DRAW/EDIT/SEQUENCE ModeToggle: only renders under FIELD
 *   - Toolbar tool groups: TECHNICAL collapses to viewport-only
 *   - Properties drawer: hidden under TECHNICAL
 *   - CanvasStage: TECHNICAL renders an empty canvas (no Field Markup
 *     layers / clines / annotations / perspective handles). Field Markup
 *     hit-testing all early-returns under TECHNICAL.
 *
 * Technical Drawing tools (length input, angle input, rotation, callouts,
 * spec table, JSON export) land in sub-steps 18b–18i. 18a is skeleton only.
 *
 * Visual: separate class root from .mode-toggle so it reads as a higher-
 * level switch — slightly larger pills, more prominent active state.
 */
const APP_MODES = [
  { id: 'FIELD',     label: 'Field Markup'       },
  { id: 'TECHNICAL', label: 'Technical Drawing'  },
]

export default function AppModeToggle() {
  const appMode = useAppStore((s) => s.appMode)
  const setAppMode = useAppStore((s) => s.setAppMode)
  return (
    <div className="app-mode-toggle" role="tablist" aria-label="Application mode">
      {APP_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={appMode === m.id ? 'app-mode-pill active' : 'app-mode-pill'}
          onClick={() => setAppMode(m.id)}
          role="tab"
          aria-selected={appMode === m.id}
          data-app-mode={m.id}
          data-testid={`app-mode-${m.id.toLowerCase()}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
