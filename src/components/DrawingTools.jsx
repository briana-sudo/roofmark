import { useAppStore } from '../store/useAppStore'

/**
 * DrawingTools — Step 5 of Kickoff Spec §6.
 *
 * Toolbar that selects the active drawing tool. Reads `tool` from the
 * store and calls `setTool(id)`; clicking the active tool toggles it
 * off (sets tool to null). Buttons are disabled when no active layer
 * is selected, with a hint to pick one.
 *
 * The actual drawing state machine lives in CanvasStage — this is just
 * the UI for changing the `tool` slice.
 */
const TOOLS = [
  { id: 'poly', icon: '▱', name: 'Poly', label: 'Polygon — click to place points, double-click or snap-close to commit' },
  { id: 'rect', icon: '▭', name: 'Rect', label: 'Rectangle — click and drag, release to commit' },
  { id: 'tri',  icon: '△', name: 'Tri',  label: 'Triangle — three clicks; auto-commits on third' },
  { id: 'circ', icon: '○', name: 'Circ', label: 'Circle — click center, drag radius, release to commit' },
  { id: 'line', icon: '╱', name: 'Line', label: 'Line — two clicks; auto-commits on second' },
]

export default function DrawingTools() {
  const tool = useAppStore((s) => s.tool)
  const setTool = useAppStore((s) => s.setTool)
  const activeLayerId = useAppStore((s) => s.activeLayerId)
  const disabled = !activeLayerId

  const onSelect = (id) => setTool(tool === id ? null : id)

  return (
    <div className="drawing-tools" role="toolbar" aria-label="Drawing tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={tool === t.id ? 'tool-btn active' : 'tool-btn'}
          onClick={() => onSelect(t.id)}
          disabled={disabled}
          title={disabled ? 'Select a layer first' : t.label}
          aria-pressed={tool === t.id}
          data-tool={t.id}
        >
          <span className="tool-icon" aria-hidden="true">{t.icon}</span>
          <span className="tool-name">{t.name}</span>
        </button>
      ))}
      {disabled && <span className="tool-hint">Select a layer to draw</span>}
    </div>
  )
}
