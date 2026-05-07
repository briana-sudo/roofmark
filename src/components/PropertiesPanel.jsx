import { useAppStore } from '../store/useAppStore'

/**
 * PropertiesPanel — Step 10 of Kickoff Spec §5/§6.
 *
 * Tab body for the Properties tab in the right drawer. Edits the ACTIVE
 * layer's render properties:
 *   - Color (10-swatch palette + native fine-tune picker for custom RGB)
 *   - Fill on/off + opacity slider
 *   - Stroke on/off + weight (px) + opacity slider
 *
 * Single source of truth: every control writes through the store actions
 * (`setLayerColor` / `updateLayerProps`), so the LayerPanel's color swatch
 * and the canvas renderer reflect changes immediately. The Properties panel
 * and the LayerPanel are parallel views of the same underlying layer state.
 *
 * Step 11 refactor: the `<aside class="panel-right">` wrapper moved to
 * App.jsx so the drawer can host two tab bodies (Properties + Sequences).
 * This component returns the tab body content only (a panel-header for
 * the active layer name, plus a panel-body div).
 *
 * Step 17 partial-completion #2 (Gap 1): the Re-crop / photo-management
 * section that previously lived at the bottom of this panel moved to a
 * dedicated PhotoPanel.jsx (4th drawer tab). PropertiesPanel is now
 * pure per-active-layer.
 */
const COLOR_PALETTE = [
  // KCC brand
  { name: 'KCC Orange', value: '#f47f1f' },
  { name: 'KCC Navy',   value: '#1f2a44' },
  // Standard layer palette (P5)
  { name: 'Red',        value: '#dc2626' },
  { name: 'Blue',       value: '#2563eb' },
  { name: 'Green',      value: '#16a34a' },
  { name: 'Yellow',     value: '#eab308' },
  { name: 'Purple',     value: '#9333ea' },
  { name: 'Gray',       value: '#6b7280' },
  { name: 'Brown',      value: '#78350f' },
  { name: 'White',      value: '#ffffff' },
]

export default function PropertiesPanel() {
  const activeLayerId = useAppStore((s) => s.activeLayerId)
  const layer = useAppStore((s) =>
    s.layers.find((l) => l.id === activeLayerId) || null
  )
  // P18 (May 5 2026) — when a shape is selected in EDIT mode, expose a
  // "Move to layer…" dropdown so the operator can reassign it without
  // hunting for the right-click context menu. Subscribe to mode +
  // selected + layers so the dropdown reflects current state.
  const mode = useAppStore((s) => s.mode)
  const selected = useAppStore((s) => s.selected)
  const layers = useAppStore((s) => s.layers)

  if (!layer) {
    return (
      <>
        <div className="panel-header">Properties</div>
        <div className="panel-body panel-empty">
          Select a layer to edit its properties.
        </div>
      </>
    )
  }

  const setColor = (color) => useAppStore.getState().setLayerColor(layer.id, color)
  const setProps = (partial) => useAppStore.getState().updateLayerProps(layer.id, partial)

  // P18 — dropdown options exclude the shape's CURRENT parent layer
  // (selected.layerId). Note that after P17 selected.layerId ===
  // activeLayerId in EDIT mode, but using selected.layerId here is the
  // robust choice if the operator changes activeLayerId via LayerPanel
  // while a shape is still selected.
  const showMoveToLayer =
    mode === 'EDIT'
    && selected
    && selected.shapeId != null
    && selected.layerId != null
    && layers.length > 1
  const moveTargets = showMoveToLayer
    ? layers.filter((l) => l.id !== selected.layerId)
    : []
  const onMoveToLayer = (e) => {
    const targetId = e.target.value
    if (!targetId) return
    useAppStore.getState().moveShapeToLayer(selected.layerId, selected.shapeId, targetId)
    // Native <select> resets to "" after the controlled value="" prop
    // re-renders — no manual reset needed.
  }

  // Match LayerPanel's defaults so a freshly-added layer renders predictably
  // even before the operator touches any slider.
  const fillOn = layer.fillOn !== false
  const strokeOn = layer.strokeOn !== false
  const fillOpacity = layer.fillOpacity ?? 0.25
  const strokeOpacity = layer.strokeOpacity ?? 1.0
  const strokeWeight = layer.strokeWeight ?? 2

  return (
    <>
      <div className="panel-header">
        <span className="panel-title">{layer.name || 'Layer'}</span>
      </div>
      <div className="panel-body props-body">
        {/* P18 — Selected Shape section. Only renders in EDIT mode with
            a shape selected AND at least one OTHER layer to move to.
            Sits above the per-layer Color/Fill/Stroke sections so the
            shape-scoped action is visually distinct from the layer-
            scoped editing controls. */}
        {showMoveToLayer && (
          <section className="props-section selected-shape-section" aria-label="Selected shape">
            <div className="props-section-title">Selected Shape</div>
            <label className="prop-row prop-move-to">
              <span className="prop-label">Move to:</span>
              <select
                className="prop-move-select"
                value=""
                onChange={onMoveToLayer}
                onMouseDown={(e) => e.stopPropagation()}
                title="Reassign this shape to a different layer"
                aria-label="Move shape to layer"
                data-testid="prop-move-to-layer"
              >
                <option value="">Choose layer…</option>
                {moveTargets.map((l) => (
                  <option key={l.id} value={l.id}>{l.name || 'Layer'}</option>
                ))}
              </select>
            </label>
          </section>
        )}
        <section className="props-section" aria-label="Color">
          <div className="props-section-title">Color</div>
          <div className="color-palette" role="radiogroup" aria-label="Layer color palette">
            {COLOR_PALETTE.map((c) => {
              const active = c.value.toLowerCase() === (layer.color || '').toLowerCase()
              return (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  className={active ? 'swatch active' : 'swatch'}
                  style={{ background: c.value }}
                  onClick={() => setColor(c.value)}
                  title={c.name}
                  aria-label={c.name}
                  aria-checked={active}
                  data-testid={`swatch-${c.value}`}
                />
              )
            })}
            {/*
              Fine-tune affordance per P5 — the native color picker is
              the escape hatch for custom RGB outside the 10-swatch
              palette. Styled to look like a small "+" button so it
              doesn't visually compete with the palette swatches.
            */}
            <input
              type="color"
              className="swatch-fine-tune"
              value={layer.color || '#ffffff'}
              onChange={(e) => setColor(e.target.value)}
              title="Fine-tune color (custom RGB)"
              aria-label="Fine-tune color"
              data-testid="swatch-fine-tune"
            />
          </div>
        </section>

        <section className="props-section" aria-label="Fill">
          <div className="props-section-title">Fill</div>
          <label className="prop-row prop-toggle">
            <input
              type="checkbox"
              checked={fillOn}
              onChange={(e) => setProps({ fillOn: e.target.checked })}
              data-testid="prop-fill-on"
            />
            <span>Fill on</span>
          </label>
          <label className="prop-row prop-slider">
            <span className="prop-label">Opacity</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={fillOpacity}
              onChange={(e) => setProps({ fillOpacity: Number(e.target.value) })}
              disabled={!fillOn}
              data-testid="prop-fill-opacity"
            />
            <span className="prop-value">{Math.round(fillOpacity * 100)}%</span>
          </label>
        </section>

        <section className="props-section" aria-label="Stroke">
          <div className="props-section-title">Stroke</div>
          <label className="prop-row prop-toggle">
            <input
              type="checkbox"
              checked={strokeOn}
              onChange={(e) => setProps({ strokeOn: e.target.checked })}
              data-testid="prop-stroke-on"
            />
            <span>Stroke on</span>
          </label>
          <label className="prop-row prop-number">
            <span className="prop-label">Weight</span>
            <input
              type="number"
              min="1"
              step="1"
              value={strokeWeight}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value))
                if (isFinite(n) && n >= 1) setProps({ strokeWeight: n })
              }}
              disabled={!strokeOn}
              data-testid="prop-stroke-weight"
            />
            <span className="prop-value">px</span>
          </label>
          <label className="prop-row prop-slider">
            <span className="prop-label">Opacity</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={strokeOpacity}
              onChange={(e) => setProps({ strokeOpacity: Number(e.target.value) })}
              disabled={!strokeOn}
              data-testid="prop-stroke-opacity"
            />
            <span className="prop-value">{Math.round(strokeOpacity * 100)}%</span>
          </label>
        </section>

      </div>
    </>
  )
}
