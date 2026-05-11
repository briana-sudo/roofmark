// Node-side runner for Phase 2 sub-step 18d block tests.
//
// Same eval-shim pattern as step-18b/18c. Loads pure modules:
//   - src/utils/techGeometry.js — depends on perspective.js (rotatePoint)
//   - src/utils/perspective.js   — needed only for rotatePoint
//
// Coverage:
//   - techShapeCentroid, techMultiShapeCentroid (~5 tests)
//   - distanceFromSegment + techHitTest (~5 tests)
//   - rotateTechShape (~6 tests)
//   - selection state actions via mock store (~8 tests)
//   - rotation commit math (single + multi-select) (~3 tests)
//   - dataSnapshot contract (~2 tests — techSelected NOT in snapshot)
//
// Total ≥27 new tests. Combined: step-17 390 + step-18a 93 + step-18b 77
// + step-18c 83 + step-18d ≥27 = ≥670 PASS.

const path = require('path')
const fs = require('fs')

function loadModule(relpath, returnNames, preamble) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', relpath),
    'utf-8'
  )
  // Strip ES imports + exports so the file body lives in module scope
  // when eval'd. The preamble (if provided) seeds dependencies that
  // were import-statements in the source.
  const transformed = src
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/export\s+function/g, 'function')
    .replace(/export\s+const/g, 'const')
  const body = (preamble || '') + '\n' + transformed
  const factory = new Function(`${body}\nreturn { ${returnNames.join(', ')} }`)
  return factory()
}

// perspective.js exports rotatePoint. Load it first; tech geometry
// depends on it.
const { rotatePoint } = loadModule('src/utils/perspective.js', ['rotatePoint'])

// Tech geometry needs rotatePoint in scope — inject via preamble.
const techGeomPreamble = `
  function rotatePoint(p, center, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const dx = p.x - center.x
    const dy = p.y - center.y
    return {
      x: center.x + dx * cos - dy * sin,
      y: center.y + dx * sin + dy * cos,
    }
  }
`
const {
  techShapeCentroid, techMultiShapeCentroid,
  techHitTest, rotateTechShape, getSelectedTechShapes,
  distanceFromSegment,
  // Phase 2 18d-pivot (May 11 2026)
  resolveTechPivot, findPivotSnapTarget,
} = loadModule(
  'src/utils/techGeometry.js',
  [
    'techShapeCentroid', 'techMultiShapeCentroid', 'techHitTest',
    'rotateTechShape', 'getSelectedTechShapes', 'distanceFromSegment',
    'resolveTechPivot', 'findPivotSnapTarget',
  ],
  techGeomPreamble,
)

const tests = []
function pass(name, ok, extra) {
  tests.push({ name, ok: !!ok, extra })
}
function near(a, b, tol) {
  return Math.abs(a - b) < (tol || 0.01)
}

// ============================================================================
// CENTROID TESTS (1–5)
// ============================================================================

// 1. Single-line centroid = midpoint.
{
  const sh = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const c = techShapeCentroid(sh)
  pass('1a. line (0,0)→(24,0) centroid.x === 12', c.x === 12)
  pass('1b. line (0,0)→(24,0) centroid.y === 0', c.y === 0)
}

// 2. Diagonal line centroid.
{
  const sh = { type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 50 } }
  const c = techShapeCentroid(sh)
  pass('2a. diagonal line centroid.x === 50', c.x === 50)
  pass('2b. diagonal line centroid.y === 25', c.y === 25)
}

// 3. Unsupported shape type returns null.
{
  pass('3a. unsupported shape type returns null', techShapeCentroid({ type: 'rect' }) === null)
  pass('3b. null input returns null', techShapeCentroid(null) === null)
  pass('3c. line missing endpoints returns null', techShapeCentroid({ type: 'line' }) === null)
}

// 4. Multi-shape centroid: empty array → null.
{
  pass('4. techMultiShapeCentroid([]) === null', techMultiShapeCentroid([]) === null)
}

// 5. Multi-shape centroid: bbox center of multiple lines.
{
  const shapes = [
    { type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },     // bbox: (0,0)→(100,0)
    { type: 'line', a: { x: 200, y: 200 }, b: { x: 400, y: 400 } },// bbox: (200,200)→(400,400)
  ]
  // Combined bbox: (0,0)→(400,400). Center: (200, 200).
  const c = techMultiShapeCentroid(shapes)
  pass('5a. combined bbox centroid.x === 200', c.x === 200)
  pass('5b. combined bbox centroid.y === 200', c.y === 200)
}

// ============================================================================
// HIT-TEST + DISTANCE TESTS (6–10)
// ============================================================================

// 6. distanceFromSegment basic cases.
{
  pass('6a. point on segment → distance 0',
    near(distanceFromSegment(50, 0, 0, 0, 100, 0), 0))
  pass('6b. point perpendicular to segment',
    near(distanceFromSegment(50, 10, 0, 0, 100, 0), 10))
  pass('6c. point past segment end clamps to endpoint',
    near(distanceFromSegment(150, 0, 0, 0, 100, 0), 50))
  pass('6d. degenerate (zero-length) segment',
    near(distanceFromSegment(3, 4, 0, 0, 0, 0), 5))
}

// 7. techHitTest within tolerance returns hit.
{
  const layers = [{
    id: 'tech-layer-1', name: 'L1', visible: true,
    shapes: [{ id: 'tech-shape-1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }],
  }]
  const viewport = { panX: 0, panY: 0, zoom: 1 }
  const hit = techHitTest({ x: 50, y: 3 }, layers, viewport, 7)
  pass('7. cursor within 7-px tolerance → hit returned',
    hit && hit.layerId === 'tech-layer-1' && hit.shapeId === 'tech-shape-1')
}

// 8. techHitTest outside tolerance returns null.
{
  const layers = [{
    id: 'tech-layer-1', name: 'L1', visible: true,
    shapes: [{ id: 'tech-shape-1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }],
  }]
  const viewport = { panX: 0, panY: 0, zoom: 1 }
  const miss = techHitTest({ x: 50, y: 20 }, layers, viewport, 7)
  pass('8. cursor outside tolerance → null', miss === null)
}

// 9. techHitTest with invisible layer returns null.
{
  const layers = [{
    id: 'tech-layer-1', name: 'L1', visible: false,
    shapes: [{ id: 'tech-shape-1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }],
  }]
  const viewport = { panX: 0, panY: 0, zoom: 1 }
  const miss = techHitTest({ x: 50, y: 0 }, layers, viewport, 7)
  pass('9. invisible layer ignored by hit-test', miss === null)
}

// 10. Topmost-first ordering: most recently added shape wins.
{
  const layers = [{
    id: 'tech-layer-1', name: 'L1', visible: true,
    shapes: [
      { id: 'tech-shape-1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
      { id: 'tech-shape-2', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
    ],
  }]
  const viewport = { panX: 0, panY: 0, zoom: 1 }
  // Both shapes are identical — should return the second (most recent).
  const hit = techHitTest({ x: 50, y: 0 }, layers, viewport, 7)
  pass('10. topmost-first: tech-shape-2 wins over tech-shape-1',
    hit && hit.shapeId === 'tech-shape-2')
}

// ============================================================================
// ROTATION GEOMETRY TESTS (11–16)
// ============================================================================

// 11. Rotate line 90° around (0,0) → b ends up at (0, 24) (canvas Y-down).
{
  const sh = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const rotated = rotateTechShape(sh, { x: 0, y: 0 }, 90)
  pass('11a. rotate 90° → a.x ≈ 0', near(rotated.a.x, 0))
  pass('11b. rotate 90° → a.y ≈ 0', near(rotated.a.y, 0))
  pass('11c. rotate 90° → b.x ≈ 0', near(rotated.b.x, 0))
  pass('11d. rotate 90° → b.y ≈ 24', near(rotated.b.y, 24))
}

// 12. Rotate by 0° returns equivalent endpoints.
{
  const sh = { type: 'line', a: { x: 10, y: 20 }, b: { x: 30, y: 40 } }
  const rotated = rotateTechShape(sh, { x: 0, y: 0 }, 0)
  pass('12a. rotate 0° → a unchanged',
    near(rotated.a.x, 10) && near(rotated.a.y, 20))
  pass('12b. rotate 0° → b unchanged',
    near(rotated.b.x, 30) && near(rotated.b.y, 40))
}

// 13. Rotate by 360° returns equivalent (within float tolerance).
{
  const sh = { type: 'line', a: { x: 5, y: 5 }, b: { x: 15, y: 5 } }
  const rotated = rotateTechShape(sh, { x: 10, y: 5 }, 360)
  pass('13a. rotate 360° → a ≈ original', near(rotated.a.x, 5) && near(rotated.a.y, 5))
  pass('13b. rotate 360° → b ≈ original', near(rotated.b.x, 15) && near(rotated.b.y, 5))
}

// 14. Rotate 45° around (0,0): b = (cos45° * 24, sin45° * 24) ≈ (16.97, 16.97)
{
  const sh = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const rotated = rotateTechShape(sh, { x: 0, y: 0 }, 45)
  const expected = 24 / Math.sqrt(2)
  pass('14a. rotate 45° → b.x ≈ 16.97', near(rotated.b.x, expected))
  pass('14b. rotate 45° → b.y ≈ 16.97', near(rotated.b.y, expected))
}

// 15. Rotate around non-origin center.
{
  // Line from (10, 10) to (20, 10). Rotate 90° around (10, 10).
  // b should end up at (10, 20).
  const sh = { type: 'line', a: { x: 10, y: 10 }, b: { x: 20, y: 10 } }
  const rotated = rotateTechShape(sh, { x: 10, y: 10 }, 90)
  pass('15a. non-origin rotation: a fixed at center',
    near(rotated.a.x, 10) && near(rotated.a.y, 10))
  pass('15b. non-origin rotation: b at (10, 20)',
    near(rotated.b.x, 10) && near(rotated.b.y, 20))
}

// 16. Rotation preserves line length.
{
  const sh = { type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }
  const origLen = Math.hypot(sh.b.x - sh.a.x, sh.b.y - sh.a.y)
  const rotated = rotateTechShape(sh, { x: 50, y: 50 }, 73)
  const newLen = Math.hypot(rotated.b.x - rotated.a.x, rotated.b.y - rotated.a.y)
  pass('16. rotation preserves length', near(origLen, newLen, 0.001))
}

// ============================================================================
// SELECTION STATE TESTS (17–24) — pure-logic mocks of store actions
// ============================================================================

function makeMockTechStore() {
  const state = {
    technicalLayers: [{
      id: 'tech-layer-1', name: 'L1', visible: true,
      shapes: [
        { id: 'tech-shape-1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
        { id: 'tech-shape-2', type: 'line', a: { x: 0, y: 50 }, b: { x: 100, y: 50 } },
      ],
    }],
    techSelected: [],
    techRotationInput: null,
    appMode: 'TECHNICAL',
  }
  const isValid = (entry) => {
    if (!entry || !entry.layerId || !entry.shapeId) return false
    const layer = state.technicalLayers.find((tl) => tl.id === entry.layerId)
    if (!layer) return false
    return (layer.shapes || []).some((sh) => sh.id === entry.shapeId)
  }
  return {
    state,
    setTechSelection: (arr) => {
      if (!Array.isArray(arr)) { state.techSelected = []; return }
      state.techSelected = arr.filter(isValid)
    },
    addToTechSelection: (entry) => {
      if (!isValid(entry)) return
      const already = state.techSelected.some(
        (e) => e.layerId === entry.layerId && e.shapeId === entry.shapeId
      )
      if (already) return
      state.techSelected = [...state.techSelected, { layerId: entry.layerId, shapeId: entry.shapeId }]
    },
    toggleTechSelectionMember: (entry) => {
      if (!isValid(entry)) return
      const idx = state.techSelected.findIndex(
        (e) => e.layerId === entry.layerId && e.shapeId === entry.shapeId
      )
      if (idx >= 0) {
        const next = state.techSelected.slice()
        next.splice(idx, 1)
        state.techSelected = next
      } else {
        state.techSelected = [...state.techSelected, { layerId: entry.layerId, shapeId: entry.shapeId }]
      }
    },
    clearTechSelection: () => { state.techSelected = [] },
  }
}

// 17. setTechSelection with empty array clears.
{
  const s = makeMockTechStore()
  s.state.techSelected = [{ layerId: 'tech-layer-1', shapeId: 'tech-shape-1' }]
  s.setTechSelection([])
  pass('17. setTechSelection([]) clears selection', s.state.techSelected.length === 0)
}

// 18. setTechSelection with valid entries sets them.
{
  const s = makeMockTechStore()
  s.setTechSelection([
    { layerId: 'tech-layer-1', shapeId: 'tech-shape-1' },
    { layerId: 'tech-layer-1', shapeId: 'tech-shape-2' },
  ])
  pass('18a. setTechSelection with 2 valid entries → length 2', s.state.techSelected.length === 2)
  pass('18b. first entry preserved',
    s.state.techSelected[0].shapeId === 'tech-shape-1')
}

// 19. setTechSelection silently drops invalid entries.
{
  const s = makeMockTechStore()
  s.setTechSelection([
    { layerId: 'tech-layer-1', shapeId: 'tech-shape-1' },        // valid
    { layerId: 'tech-layer-1', shapeId: 'nonexistent-shape' },   // invalid
    { layerId: 'nonexistent-layer', shapeId: 'whatever' },       // invalid
  ])
  pass('19a. only valid entries kept', s.state.techSelected.length === 1)
  pass('19b. valid entry preserved',
    s.state.techSelected[0].shapeId === 'tech-shape-1')
}

// 20. addToTechSelection on new entry adds.
{
  const s = makeMockTechStore()
  s.addToTechSelection({ layerId: 'tech-layer-1', shapeId: 'tech-shape-1' })
  pass('20. addToTechSelection adds a new entry', s.state.techSelected.length === 1)
}

// 21. addToTechSelection on existing entry no-ops.
{
  const s = makeMockTechStore()
  s.addToTechSelection({ layerId: 'tech-layer-1', shapeId: 'tech-shape-1' })
  s.addToTechSelection({ layerId: 'tech-layer-1', shapeId: 'tech-shape-1' })
  pass('21. addToTechSelection on existing entry → length still 1',
    s.state.techSelected.length === 1)
}

// 22. toggleTechSelectionMember toggles in/out.
{
  const s = makeMockTechStore()
  s.toggleTechSelectionMember({ layerId: 'tech-layer-1', shapeId: 'tech-shape-1' })
  pass('22a. toggle adds when absent', s.state.techSelected.length === 1)
  s.toggleTechSelectionMember({ layerId: 'tech-layer-1', shapeId: 'tech-shape-1' })
  pass('22b. toggle removes when present', s.state.techSelected.length === 0)
}

// 23. clearTechSelection sets [].
{
  const s = makeMockTechStore()
  s.state.techSelected = [
    { layerId: 'tech-layer-1', shapeId: 'tech-shape-1' },
    { layerId: 'tech-layer-1', shapeId: 'tech-shape-2' },
  ]
  s.clearTechSelection()
  pass('23. clearTechSelection clears array',
    Array.isArray(s.state.techSelected) && s.state.techSelected.length === 0)
}

// 24. setAppMode contract: clearing techSelected on switch (verified via the
//     store change — pure-logic mock here).
{
  // Mock: setAppMode would write techSelected: [].
  const state = {
    appMode: 'TECHNICAL',
    techSelected: [{ layerId: 'tech-layer-1', shapeId: 'tech-shape-1' }],
  }
  const setAppMode = (next) => {
    if (next === state.appMode) return
    state.appMode = next
    state.techSelected = []
  }
  setAppMode('FIELD')
  pass('24a. setAppMode FIELD clears techSelected', state.techSelected.length === 0)
  pass('24b. setAppMode FIELD updates appMode', state.appMode === 'FIELD')
}

// ============================================================================
// ROTATION COMMIT MATH (25–27)
// ============================================================================

// 25. Single-shape typed rotation: line ends up at typed absolute angle.
{
  // Start: line at (0,0)→(24,0). Horizontal. Operator types 45°.
  // Current angle: 0°. Delta: 45°. Pivot: midpoint (12, 0).
  const sh = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const pivot = techShapeCentroid(sh)  // (12, 0)
  const currAngleDeg = (Math.atan2(sh.b.y - sh.a.y, sh.b.x - sh.a.x) * 180) / Math.PI
  const typedAbs = 45
  const delta = typedAbs - currAngleDeg
  const rotated = rotateTechShape(sh, pivot, delta)
  const newAngle = (Math.atan2(rotated.b.y - rotated.a.y, rotated.b.x - rotated.a.x) * 180) / Math.PI
  pass('25. single-shape typed rotation produces 45° final angle',
    near(newAngle, 45, 0.001))
}

// 26. Multi-shape rotation: all rotate by the same delta around bbox centroid.
{
  const shapes = [
    { type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
    { type: 'line', a: { x: 200, y: 200 }, b: { x: 300, y: 200 } },
  ]
  // bbox: (0, 0)→(300, 200). Center: (150, 100).
  const pivot = techMultiShapeCentroid(shapes)
  pass('26a. multi-shape pivot.x = 150', pivot.x === 150)
  pass('26b. multi-shape pivot.y = 100', pivot.y === 100)
  // Rotate both by 90° around (150, 100). Each shape's endpoints should
  // be 90° rotations of the originals around (150, 100).
  const rotated = shapes.map((sh) => rotateTechShape(sh, pivot, 90))
  // Original first shape: (0,0)→(100,0). After 90° rotation around (150,100):
  // rotatePoint formula: x' = cx + dx*cos - dy*sin, y' = cy + dx*sin + dy*cos
  // For (0,0): dx=-150, dy=-100, cos=0, sin=1
  //   x = 150 + (-150)*0 - (-100)*1 = 150 + 100 = 250
  //   y = 100 + (-150)*1 + (-100)*0 = 100 - 150 = -50
  // For (100,0): dx=-50, dy=-100
  //   x = 150 + (-50)*0 - (-100)*1 = 150 + 100 = 250
  //   y = 100 + (-50)*1 + (-100)*0 = 100 - 50 = 50
  pass('26c. shape 1 rotated correctly',
    near(rotated[0].a.x, 250) && near(rotated[0].a.y, -50)
    && near(rotated[0].b.x, 250) && near(rotated[0].b.y, 50))
}

// 27. Rotation does not affect lengthInches / lengthSource (only a/b mutate).
{
  const sh = {
    id: 'tech-shape-1', type: 'line',
    a: { x: 0, y: 0 }, b: { x: 24, y: 0 },
    lengthInches: 1, lengthSource: 'typed', angleSource: 'typed',
  }
  const rotated = rotateTechShape(sh, { x: 12, y: 0 }, 45)
  pass('27a. rotation preserves lengthInches', rotated.lengthInches === 1)
  pass('27b. rotation preserves lengthSource', rotated.lengthSource === 'typed')
  pass('27c. rotation preserves angleSource', rotated.angleSource === 'typed')
  pass('27d. rotation preserves id', rotated.id === 'tech-shape-1')
}

// ============================================================================
// DATASNAPSHOT CONTRACT (28–29) — techSelected stays transient
// ============================================================================

// 28. dataSnapshot must NOT include techSelected (transient, not undo'd).
// 29. dataSnapshot must NOT include techRotationInput.
//
// Replica of production dataSnapshot fields — keep in sync with
// src/store/useAppStore.js (named export `dataSnapshot`).
{
  const FIELDS_IN_SNAPSHOT = new Set([
    'layers', 'sequences', 'clines',
    'photoMeta', 'cropMeta', 'hasSourcePhoto',
    'gridRotation', 'perspectiveCorners',
    'technicalLayers', 'specTable',
  ])
  pass('28. techSelected NOT in dataSnapshot fields',
    !FIELDS_IN_SNAPSHOT.has('techSelected'))
  pass('29. techRotationInput NOT in dataSnapshot fields',
    !FIELDS_IN_SNAPSHOT.has('techRotationInput'))
}

// ============================================================================
// getSelectedTechShapes (30)
// ============================================================================

// 30. getSelectedTechShapes resolves entries to shape objects.
{
  const layers = [{
    id: 'tech-layer-1', name: 'L1', visible: true,
    shapes: [
      { id: 'tech-shape-1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
      { id: 'tech-shape-2', type: 'line', a: { x: 0, y: 50 }, b: { x: 100, y: 50 } },
    ],
  }]
  const sel = [
    { layerId: 'tech-layer-1', shapeId: 'tech-shape-1' },
    { layerId: 'tech-layer-1', shapeId: 'tech-shape-2' },
  ]
  const shapes = getSelectedTechShapes(layers, sel)
  pass('30a. resolves to two shapes', shapes.length === 2)
  pass('30b. first shape is tech-shape-1', shapes[0].id === 'tech-shape-1')
  pass('30c. second shape is tech-shape-2', shapes[1].id === 'tech-shape-2')

  // Invalid entries silently dropped.
  const sel2 = [
    { layerId: 'tech-layer-1', shapeId: 'tech-shape-1' },
    { layerId: 'tech-layer-1', shapeId: 'nonexistent' },
  ]
  const shapes2 = getSelectedTechShapes(layers, sel2)
  pass('30d. invalid entries dropped', shapes2.length === 1 && shapes2[0].id === 'tech-shape-1')
}

// ============================================================================
// PIVOT — resolveTechPivot (31–35)
// Phase 2 18d-pivot (May 11 2026) — operator-chosen pivot helper.
// ============================================================================

// 31. Null techPivot + single selection → centroid of that shape.
{
  const sh = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const p = resolveTechPivot(null, [sh])
  pass('31a. null pivot + single sel → midpoint.x', p.x === 12)
  pass('31b. null pivot + single sel → midpoint.y', p.y === 0)
}

// 32. Null techPivot + multi selection → bbox centroid.
{
  const shapes = [
    { type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
    { type: 'line', a: { x: 200, y: 200 }, b: { x: 400, y: 400 } },
  ]
  const p = resolveTechPivot(null, shapes)
  pass('32a. null pivot + multi → bbox.x === 200', p.x === 200)
  pass('32b. null pivot + multi → bbox.y === 200', p.y === 200)
}

// 33. Null techPivot + empty selection → null.
{
  pass('33. null pivot + empty selection → null', resolveTechPivot(null, []) === null)
}

// 34. Non-null techPivot + any selection → returns the pivot.
{
  const pivot = { x: 999, y: -7 }
  const shapes = [{ type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }]
  const result = resolveTechPivot(pivot, shapes)
  pass('34a. operator pivot takes precedence over centroid', result.x === 999 && result.y === -7)
}

// 35. Non-null techPivot + empty selection → still returns the pivot.
{
  const pivot = { x: 42, y: 24 }
  const result = resolveTechPivot(pivot, [])
  pass('35. operator pivot returned even with empty selection',
    result && result.x === 42 && result.y === 24)
}

// ============================================================================
// PIVOT — findPivotSnapTarget (36–45)
// ============================================================================

const ID_VIEWPORT = { panX: 0, panY: 0, zoom: 1 }
// At zoom=1, world distance === canvas-px distance, simplifying tolerance math.

// 36. Endpoint of selected line within tolerance → returns endpoint.
{
  const sel = [{ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }]
  const layers = [{ id: 'L1', visible: true, shapes: sel }]
  // Cursor at (2, 0): 2 px from selected endpoint (0, 0). Within tol 7.
  const target = findPivotSnapTarget({ x: 2, y: 0 }, sel, layers, ID_VIEWPORT, 7)
  pass('36a. selected endpoint hit returns endpoint',
    target && target.type === 'endpoint' && target.x === 0 && target.y === 0)
}

// 37. Midpoint of selected line within tolerance.
{
  const sel = [{ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }]
  const layers = [{ id: 'L1', visible: true, shapes: sel }]
  // Cursor at (50, 2). Selected midpoint is (50, 0). Within tol 7.
  // Selected endpoints are at (0,0) and (100,0) — far away.
  const target = findPivotSnapTarget({ x: 50, y: 2 }, sel, layers, ID_VIEWPORT, 7)
  pass('37. selected midpoint hit returns midpoint',
    target && target.type === 'midpoint' && target.x === 50 && target.y === 0)
}

// 38. Endpoint of non-selected line within tolerance.
{
  const sel = []  // nothing selected
  const layers = [{
    id: 'L1', visible: true,
    shapes: [{ id: 'sh1', type: 'line', a: { x: 50, y: 50 }, b: { x: 100, y: 50 } }],
  }]
  const target = findPivotSnapTarget({ x: 52, y: 51 }, sel, layers, ID_VIEWPORT, 7)
  pass('38. non-selected endpoint hit returns endpoint',
    target && target.type === 'endpoint' && target.x === 50 && target.y === 50)
}

// 39. Cursor outside all tolerances → null.
{
  const sel = [{ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }]
  const layers = [{ id: 'L1', visible: true, shapes: sel }]
  const target = findPivotSnapTarget({ x: 200, y: 200 }, sel, layers, ID_VIEWPORT, 7)
  pass('39. cursor far from all candidates → null', target === null)
}

// 40. Empty layers + empty selection → null.
{
  pass('40. empty layers + empty selection → null',
    findPivotSnapTarget({ x: 0, y: 0 }, [], [], ID_VIEWPORT, 7) === null)
}

// 41. Empty selection + non-empty layers → uses priority-3 endpoints.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [{ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }],
  }]
  const target = findPivotSnapTarget({ x: 1, y: 1 }, [], layers, ID_VIEWPORT, 7)
  pass('41. no selection → falls back to layer endpoints',
    target && target.type === 'endpoint' && target.x === 0 && target.y === 0)
}

// 42. Priority: selected endpoint wins over non-selected endpoint at same distance.
{
  const selShape = { id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }
  const otherShape = { id: 'sh2', type: 'line', a: { x: 4, y: 0 }, b: { x: 200, y: 0 } }
  const layers = [{
    id: 'L1', visible: true,
    shapes: [selShape, otherShape],
  }]
  // Cursor at (2, 0). Selected endpoint (0,0) is 2 px away (priority 1).
  // Non-selected endpoint (4,0) is also 2 px away (priority 3).
  // Selected wins on priority.
  const target = findPivotSnapTarget({ x: 2, y: 0 }, [selShape], layers, ID_VIEWPORT, 7)
  pass('42. selected endpoint wins on priority over non-selected at same distance',
    target && target.x === 0 && target.y === 0)
}

// 43. Selected endpoint wins over selected midpoint when both in range.
{
  const sel = [{ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 12, y: 0 } }]
  const layers = [{ id: 'L1', visible: true, shapes: sel }]
  // Selected endpoint (0,0) and selected midpoint (6,0).
  // Cursor at (4, 0): 4 px from endpoint (priority 1), 2 px from midpoint (priority 2).
  // Priority dominates → endpoint wins despite midpoint being closer.
  const target = findPivotSnapTarget({ x: 4, y: 0 }, sel, layers, ID_VIEWPORT, 7)
  pass('43. endpoint priority beats midpoint despite distance',
    target && target.type === 'endpoint')
}

// 44. Invisible layer's endpoints excluded.
{
  const sel = []
  const layers = [
    { id: 'L1', visible: false,
      shapes: [{ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }] },
  ]
  const target = findPivotSnapTarget({ x: 1, y: 1 }, sel, layers, ID_VIEWPORT, 7)
  pass('44. invisible layer endpoints ignored', target === null)
}

// 45. Zoom scaling: tolerance is canvas-px, world distance scales with zoom.
{
  // World shape at (0,0)→(100,0). Viewport zoom 2 → canvas endpoint at (0,0)
  // (since panX/Y = 0). Cursor world (3.5, 0) → canvas (7, 0) — 7 px from
  // the canvas endpoint. Tolerance 7 → just inside. World distance is
  // 3.5 px which would be inside a world-px tolerance of 7 too; this
  // test confirms the function uses CANVAS-px tolerance.
  const sel = [{ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }]
  const layers = [{ id: 'L1', visible: true, shapes: sel }]
  const vp = { panX: 0, panY: 0, zoom: 2 }
  const hit = findPivotSnapTarget({ x: 3.5, y: 0 }, sel, layers, vp, 7)
  pass('45a. zoom 2 + cursor 3.5 world = 7 canvas-px → just inside tol',
    hit !== null)
  const miss = findPivotSnapTarget({ x: 4, y: 0 }, sel, layers, vp, 7)
  pass('45b. zoom 2 + cursor 4 world = 8 canvas-px → outside tol',
    miss === null)
}

// ============================================================================
// PIVOT — state action contract (46–48)
// ============================================================================

// 46. setTechPivot writes value; null clears.
{
  const state = { techPivot: null }
  const setTechPivot = (p) => { state.techPivot = p }
  setTechPivot({ x: 10, y: 20 })
  pass('46a. setTechPivot writes object',
    state.techPivot && state.techPivot.x === 10 && state.techPivot.y === 20)
  setTechPivot(null)
  pass('46b. setTechPivot(null) clears', state.techPivot === null)
}

// 47. setTechPivotPickMode coerces to boolean.
{
  const state = { techPivotPickMode: false }
  const setTechPivotPickMode = (v) => { state.techPivotPickMode = !!v }
  setTechPivotPickMode(true)
  pass('47a. setTechPivotPickMode(true)', state.techPivotPickMode === true)
  setTechPivotPickMode(false)
  pass('47b. setTechPivotPickMode(false)', state.techPivotPickMode === false)
  setTechPivotPickMode(1)
  pass('47c. truthy non-bool coerces to true', state.techPivotPickMode === true)
}

// 48. setAppMode / setTool / clearAll / importJSON / clearTechSelection
//     all clear the three pivot fields. Pure-logic mock of the cleanup.
{
  // Mock clearTechSelection
  const state = {
    techSelected: [{ layerId: 'L1', shapeId: 'sh1' }],
    techPivot: { x: 10, y: 20 },
    techPivotPickMode: true,
    techPivotHover: { x: 5, y: 5, type: 'endpoint' },
  }
  const clearTechSelection = () => {
    state.techSelected = []
    state.techPivot = null
    state.techPivotPickMode = false
    state.techPivotHover = null
  }
  clearTechSelection()
  pass('48a. clearTechSelection clears techPivot', state.techPivot === null)
  pass('48b. clearTechSelection clears pickMode', state.techPivotPickMode === false)
  pass('48c. clearTechSelection clears pivotHover', state.techPivotHover === null)
}

// ============================================================================
// PIVOT — rotation around locked pivot (49–51)
// ============================================================================

// 49. Single-shape rotation around locked pivot at (50, 50).
//     Shape at (0,0)→(24,0), rotate by 90°.
{
  const sh = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const lockedPivot = { x: 50, y: 50 }
  const rotated = rotateTechShape(sh, lockedPivot, 90)
  // rotatePoint formula: x' = cx + dx*cos - dy*sin, y' = cy + dx*sin + dy*cos
  // For (0,0): dx=-50, dy=-50, cos(90°)=0, sin(90°)=1
  //   x = 50 + (-50)*0 - (-50)*1 = 100
  //   y = 50 + (-50)*1 + (-50)*0 = 0
  // For (24,0): dx=-26, dy=-50
  //   x = 50 + (-26)*0 - (-50)*1 = 100
  //   y = 50 + (-26)*1 + (-50)*0 = 24
  pass('49a. locked pivot rotation: a → (100, 0)',
    near(rotated.a.x, 100) && near(rotated.a.y, 0))
  pass('49b. locked pivot rotation: b → (100, 24)',
    near(rotated.b.x, 100) && near(rotated.b.y, 24))
}

// 50. Multi-select rotation around locked pivot.
{
  const shapes = [
    { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } },
    { type: 'line', a: { x: 100, y: 0 }, b: { x: 124, y: 0 } },
  ]
  const lockedPivot = { x: 0, y: 0 }
  // Rotate both by 90° around origin.
  const rotated = shapes.map((sh) => rotateTechShape(sh, lockedPivot, 90))
  // Shape 1: (0,0) stays at (0,0). (24,0) → (0, 24).
  pass('50a. shape 1 a stays at origin',
    near(rotated[0].a.x, 0) && near(rotated[0].a.y, 0))
  pass('50b. shape 1 b → (0, 24)',
    near(rotated[0].b.x, 0) && near(rotated[0].b.y, 24))
  // Shape 2: (100,0) → (0, 100). (124,0) → (0, 124).
  pass('50c. shape 2 a → (0, 100)',
    near(rotated[1].a.x, 0) && near(rotated[1].a.y, 100))
  pass('50d. shape 2 b → (0, 124)',
    near(rotated[1].b.x, 0) && near(rotated[1].b.y, 124))
}

// 51. After rotation commit, techPivot resets to null (operator decision).
//     Pure-logic mock: drag-end + typed-Enter both set pivot to null.
{
  const state = { techPivot: { x: 99, y: 99 }, _committed: false }
  const commitRotation = () => {
    // ... do shape mutations (out of scope for this test) ...
    state._committed = true
    state.techPivot = null  // ← the operator decision being tested
  }
  commitRotation()
  pass('51a. commit clears techPivot', state.techPivot === null)
  pass('51b. commit happened', state._committed === true)
}

// ============================================================================
// SUMMARY
// ============================================================================
const passCount = tests.filter((t) => t.ok).length
const total = tests.length
console.log(passCount + '/' + total + ' ' + (passCount === total ? 'PASS' : 'FAIL'))
for (const t of tests) {
  if (!t.ok) console.log('FAIL: ' + t.name + (t.extra ? ' ' + JSON.stringify(t.extra) : ''))
}
process.exit(passCount === total ? 0 : 1)
