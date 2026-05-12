// Node-side runner for Phase 2 sub-step 18e block tests.
//
// 18e ships dimension callouts (Linear horizontal/vertical + Aligned)
// with two placement workflows (1-click-on-line shortcut + 2-point
// manual pick), associativity (DIMASSOC=2 equivalent), and removes
// the auto-rendered length label from tech-line shapes.
//
// Coverage blocks (per RoofMark §21.18e spec §"Test coverage requirements"
// + investigation §10):
//   A. Shape schema (~6 tests)
//   B. formatArchitecturalLength (~12 tests)
//   C. Orientation algorithm (~10 tests)
//   D. Workflow 1 commit (~6 tests)
//   E. Workflow 2 state machine (~10 tests)
//   F. Snap integration (~6 tests)
//   G. Associativity propagate + cascade (~12 tests)
//   H. Render geometry + length-label removal regression (~10 tests)
//
// Target: ≥60 new tests. Total suite: 964 (existing) + 60+ = ≥1024.
//
// Same eval-shim pattern as step-18d-edit / step-18-snap. Pure modules
// (formatArchitecturalLength, dimGeometry, techGeometry) load via
// fs.readFileSync + regex-strip imports/exports + new Function. Store
// behavior is mocked via plain JS objects mirroring the production
// setters — same approach as step-18d-edit's command-state mocks.

const path = require('path')
const fs = require('fs')

function loadModule(relpath, returnNames, preamble) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', relpath),
    'utf-8'
  )
  const transformed = src
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/export\s+function/g, 'function')
    .replace(/export\s+const/g, 'const')
  const body = (preamble || '') + '\n' + transformed
  const factory = new Function(`${body}\nreturn { ${returnNames.join(', ')} }`)
  return factory()
}

// formatArchitecturalLength — no external deps, loads cleanly.
const { formatArchitecturalLength } = loadModule(
  'src/utils/formatArchitecturalLength.js',
  ['formatArchitecturalLength'],
  'const PX_PER_INCH = 24',
)

// dimGeometry — depends on PX_PER_INCH (techConstants), dim style
// constants (dimConstants), and formatArchitecturalLength. Seed all
// of these in the preamble so the eval-shim load doesn't need the
// imports to resolve.
const dimGeomPreamble = `
  const PX_PER_INCH = 24
  const DIMEXO = 3
  const DIMEXE = 3
  const DIMASZ = 6
  const DIMTXT = 10
  const DIMGAP = 2
  const DIM_COLOR = '#1f2937'
  // Inline formatArchitecturalLength (compact mirror of the production
  // module). Only the hit-test code path consumes this — geometry tests
  // don't exercise text formatting via dimGeometry, so the format result
  // only affects approximate text width in hitTestDimension's bbox check.
  function formatArchitecturalLength(inches) {
    if (typeof inches !== 'number' || !isFinite(inches)) return null
    const sign = inches < 0 ? '-' : ''
    const abs = Math.abs(inches)
    const eighthsTotal = Math.round(abs * 8)
    const totalInches = eighthsTotal / 8
    const feet = Math.floor(totalInches / 12)
    const remainInches = totalInches - feet * 12
    const wholeInches = Math.floor(remainInches)
    const fractionalEighths = Math.round((remainInches - wholeInches) * 8)
    let fractionStr = ''
    if (fractionalEighths > 0) {
      let num = fractionalEighths
      let den = 8
      while (den > 1 && num % 2 === 0) { num /= 2; den /= 2 }
      fractionStr = num + '/' + den
    }
    if (feet === 0 && wholeInches === 0 && fractionalEighths === 0) return '0"'
    if (feet === 0) {
      if (wholeInches === 0) return sign + fractionStr + '"'
      if (fractionalEighths === 0) return sign + wholeInches + '"'
      return sign + wholeInches + ' ' + fractionStr + '"'
    }
    let inchPart
    if (wholeInches === 0 && fractionalEighths === 0) inchPart = '0"'
    else if (fractionalEighths === 0) inchPart = wholeInches + '"'
    else if (wholeInches === 0) inchPart = fractionStr + '"'
    else inchPart = wholeInches + ' ' + fractionStr + '"'
    return sign + feet + "'-" + inchPart
  }
`
const {
  resolveDimensionPoints,
  identifySnapSourceShape,
  computeDimensionOrientation,
  computeDimensionLengthInches,
  computeDimensionGeometry,
  hitTestDimension,
  distanceFromSegment2,
} = loadModule(
  'src/utils/dimGeometry.js',
  [
    'resolveDimensionPoints', 'identifySnapSourceShape', 'computeDimensionOrientation',
    'computeDimensionLengthInches', 'computeDimensionGeometry', 'hitTestDimension',
    'distanceFromSegment2',
  ],
  dimGeomPreamble,
)

const PX_PER_INCH_TEST = 24
const DEFAULT_DIM_OFFSET_TEST = 24

const tests = []
function pass(name, ok, extra) {
  tests.push({ name, ok: !!ok, extra })
}
function near(a, b, tol) {
  return Math.abs(a - b) < (tol || 0.001)
}

// ============================================================================
// BLOCK A — Shape schema (1–6)
//
// New dimension shape lives in technicalLayers[].shapes[] alongside lines.
// addTechnicalShape and import/export are type-agnostic (line filter
// removed in 18e). PERSIST_KEYS and dataSnapshot already capture
// technicalLayers verbatim, so dimensions round-trip for free.
// ============================================================================

// Helper: build a canonical dimension shape for tests.
function mkLineShape(id, ax, ay, bx, by) {
  return {
    id, type: 'line',
    a: { x: ax, y: ay }, b: { x: bx, y: by },
    lengthInches: Math.hypot(bx - ax, by - ay) / 24,
    lengthSource: 'freehand',
    angleSource: 'freehand',
  }
}
function mkDimShape(id, pointA, pointB, opts) {
  return {
    id, type: 'dimension',
    dimType: (opts && opts.dimType) || 'aligned',
    orientation: (opts && opts.orientation) || 'aligned',
    pointA, pointB,
    offset: (opts && typeof opts.offset === 'number') ? opts.offset : DEFAULT_DIM_OFFSET_TEST,
    textOverride: null,
  }
}

// 1. Dimension shape has all required fields per spec §"Dimension shape schema".
{
  const dim = mkDimShape('dim1',
    { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
    { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 24, y: 0 },
  )
  pass('1a. dim has id', typeof dim.id === 'string')
  pass('1b. dim type === "dimension"', dim.type === 'dimension')
  pass('1c. dim has dimType + orientation', !!dim.dimType && !!dim.orientation)
  pass('1d. dim has pointA + pointB', !!dim.pointA && !!dim.pointB)
  pass('1e. dim has numeric offset', typeof dim.offset === 'number')
  pass('1f. dim has textOverride field (nullable)', 'textOverride' in dim && dim.textOverride === null)
}

// 2. Dimension shape coexists with line shapes in technicalLayers (mixed array).
{
  const layer = {
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 0, 0, 24, 0),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
        { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 24, y: 0 },
      ),
    ],
  }
  pass('2a. layer.shapes[] contains line', layer.shapes[0].type === 'line')
  pass('2b. layer.shapes[] contains dimension', layer.shapes[1].type === 'dimension')
  pass('2c. layer.shapes has 2 entries (mixed)', layer.shapes.length === 2)
}

// 3. Dimension shape serializes through JSON round-trip intact.
{
  const dim = mkDimShape('dim1',
    { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
    { mode: 'free', shapeId: null, pointKey: null, x: 24, y: 12 },
  )
  const json = JSON.stringify(dim)
  const parsed = JSON.parse(json)
  pass('3a. serialized dim has type', parsed.type === 'dimension')
  pass('3b. pointA.mode preserved (attached)', parsed.pointA.mode === 'attached')
  pass('3c. pointB.mode preserved (free)', parsed.pointB.mode === 'free')
  pass('3d. pointA.shapeId preserved', parsed.pointA.shapeId === 'sh1')
  pass('3e. pointB.shapeId null on free point', parsed.pointB.shapeId === null)
}

// 4. dimType + orientation enum combinations valid.
{
  const aligned = mkDimShape('d1', { x: 0, y: 0 }, { x: 24, y: 0 },
    { dimType: 'aligned', orientation: 'aligned' })
  const linH = mkDimShape('d2', { x: 0, y: 0 }, { x: 24, y: 0 },
    { dimType: 'linear', orientation: 'horizontal' })
  const linV = mkDimShape('d3', { x: 0, y: 0 }, { x: 0, y: 24 },
    { dimType: 'linear', orientation: 'vertical' })
  pass('4a. aligned/aligned valid', aligned.dimType === 'aligned' && aligned.orientation === 'aligned')
  pass('4b. linear/horizontal valid', linH.dimType === 'linear' && linH.orientation === 'horizontal')
  pass('4c. linear/vertical valid', linV.dimType === 'linear' && linV.orientation === 'vertical')
}

// 5. DEFAULT_DIM_OFFSET === 24 (1 inch at zoom 1).
{
  pass('5. DEFAULT_DIM_OFFSET === 24 (constant + matches spec)',
    DEFAULT_DIM_OFFSET_TEST === 24)
}

// 6. pointA / pointB nullable shapeId + pointKey (free mode).
{
  const dim = mkDimShape('d1',
    { mode: 'free', shapeId: null, pointKey: null, x: 5, y: 10 },
    { mode: 'free', shapeId: null, pointKey: null, x: 15, y: 20 },
  )
  pass('6a. free pointA has null shapeId', dim.pointA.shapeId === null)
  pass('6b. free pointA has null pointKey', dim.pointA.pointKey === null)
  pass('6c. free pointA preserves cached x/y', dim.pointA.x === 5 && dim.pointA.y === 10)
}

// ============================================================================
// BLOCK B — formatArchitecturalLength (7–18)
//
// Per spec §"Text format". 1/8" precision (DIMRND=0.125). All examples
// from the spec verified explicitly.
// ============================================================================

pass('7.  formatArchitecturalLength(0) === "0\\""',
  formatArchitecturalLength(0) === '0"')
pass('8.  formatArchitecturalLength(0.125) === "1/8\\""',
  formatArchitecturalLength(0.125) === '1/8"')
pass('9.  formatArchitecturalLength(0.5) === "1/2\\""',
  formatArchitecturalLength(0.5) === '1/2"')
pass('10. formatArchitecturalLength(6) === "6\\""',
  formatArchitecturalLength(6) === '6"')
pass('11. formatArchitecturalLength(12) === "1\'-0\\""',
  formatArchitecturalLength(12) === '1\'-0"')
pass('12. formatArchitecturalLength(15.5) === "1\'-3 1/2\\""',
  formatArchitecturalLength(15.5) === '1\'-3 1/2"')
pass('13. formatArchitecturalLength(18.375) === "1\'-6 3/8\\""',
  formatArchitecturalLength(18.375) === '1\'-6 3/8"')
pass('14. formatArchitecturalLength(96) === "8\'-0\\""',
  formatArchitecturalLength(96) === '8\'-0"')
// 18.4375 × 8 = 147.5 → round half-up → 148 → ÷ 8 → 18.5 = 1'-6 1/2"
pass('15. formatArchitecturalLength(18.4375) rounds up to "1\'-6 1/2\\""',
  formatArchitecturalLength(18.4375) === '1\'-6 1/2"')
// 18.4374 × 8 = 147.4992 → round down → 147 → ÷ 8 → 18.375 = 1'-6 3/8"
pass('16. formatArchitecturalLength(18.4374) rounds down to "1\'-6 3/8\\""',
  formatArchitecturalLength(18.4374) === '1\'-6 3/8"')
// Negative input: -6 inches → "-6\""
pass('17. formatArchitecturalLength(-6) === "-6\\""',
  formatArchitecturalLength(-6) === '-6"')
// Invalid inputs return null
pass('18a. formatArchitecturalLength(NaN) === null',
  formatArchitecturalLength(NaN) === null)
pass('18b. formatArchitecturalLength("12") === null (string rejected)',
  formatArchitecturalLength('12') === null)
pass('18c. formatArchitecturalLength(Infinity) === null',
  formatArchitecturalLength(Infinity) === null)

// ============================================================================
// BLOCK C — Orientation algorithm (19–28)
//
// Per spec §"Orientation algorithm". Tests cover the full decision tree:
// diagonal baselines → always aligned; horizontal baselines → linear-H
// when cursor is perp-dominant, else aligned; vertical mirror.
// Boundary case at exactly 22.5° verified.
// ============================================================================

// 19. Horizontal baseline (0°) + cursor above midpoint → LINEAR-HORIZONTAL.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  // Cursor at (50, 50): perpComponent = 50 (down in canvas Y), alongComponent = 0.
  // perp dominates → linear-horizontal.
  const result = computeDimensionOrientation(A, B, { x: 50, y: 50 })
  pass('19a. Horizontal baseline + cursor below → dimType linear',
    result.dimType === 'linear')
  pass('19b. → orientation horizontal',
    result.orientation === 'horizontal')
  pass('19c. → offset = perpComponent (positive Y in canvas convention)',
    result.offset === 50)
}

// 20. Horizontal baseline + cursor above → LINEAR-HORIZONTAL, negative offset.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  const result = computeDimensionOrientation(A, B, { x: 50, y: -50 })
  pass('20a. Horizontal baseline + cursor above → linear-horizontal',
    result.dimType === 'linear' && result.orientation === 'horizontal')
  pass('20b. → negative offset (above baseline)',
    result.offset === -50)
}

// 21. Horizontal baseline + cursor far right along baseline → ALIGNED.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  // Cursor at (200, 5): alongComponent = 150, perpComponent = 5.
  // along dominates → aligned.
  const result = computeDimensionOrientation(A, B, { x: 200, y: 5 })
  pass('21a. Horizontal baseline + along-dominant cursor → aligned',
    result.dimType === 'aligned' && result.orientation === 'aligned')
  pass('21b. → offset still perpComponent',
    result.offset === 5)
}

// 22. Vertical baseline + cursor to the right → LINEAR-VERTICAL.
{
  const A = { x: 0, y: 0 }, B = { x: 0, y: 100 }
  // Cursor at (50, 50): perpUnit is (-1, 0) (90° CCW from (0,1)).
  // perpComponent = (50)*(-1) + (50)*(0) = -50.
  // alongComponent = (50)*(0) + (50)*(1) = 50.
  // |perp|=50, |along|=50 — NOT perp-dominant (equal). With strict > we
  // get aligned at the boundary. Use cursor clearly off to one side.
  const result = computeDimensionOrientation(A, B, { x: 80, y: 50 })
  pass('22a. Vertical baseline + cursor far right → linear-vertical',
    result.dimType === 'linear' && result.orientation === 'vertical')
}

// 23. Vertical baseline + cursor above along axis → ALIGNED.
{
  const A = { x: 0, y: 0 }, B = { x: 0, y: 100 }
  // Cursor at (5, 200): along baseline by 150, perp by -5. along dominates.
  const result = computeDimensionOrientation(A, B, { x: 5, y: 200 })
  pass('23. Vertical baseline + along-dominant cursor → aligned',
    result.dimType === 'aligned' && result.orientation === 'aligned')
}

// 24. Diagonal baseline (45°) + cursor on either side → ALIGNED.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 100 }
  const upperLeft = computeDimensionOrientation(A, B, { x: 0, y: 80 })
  const lowerRight = computeDimensionOrientation(A, B, { x: 80, y: 0 })
  pass('24a. Diagonal baseline + cursor upper-left → aligned',
    upperLeft.dimType === 'aligned' && upperLeft.orientation === 'aligned')
  pass('24b. Diagonal baseline + cursor lower-right → aligned',
    lowerRight.dimType === 'aligned' && lowerRight.orientation === 'aligned')
  pass('24c. Opposite cursor sides produce opposite offset signs',
    Math.sign(upperLeft.offset) !== Math.sign(lowerRight.offset))
}

// 25. Boundary case: baseline at exactly 22.5° (just outside horizontal threshold).
{
  // Compute B.y using precise tan() so atan2 lands at exactly 22.5°.
  const A = { x: 0, y: 0 }
  const B = { x: 100, y: 100 * Math.tan(22.5 * Math.PI / 180) }
  const result = computeDimensionOrientation(A, B, { x: 50, y: -30 })
  // baselineDeg = atan2(B.y, 100) === 22.5° exactly; "roughly horizontal"
  // requires < 22.5 strictly, so 22.5° is NOT roughly horizontal → ALIGNED.
  pass('25. Baseline at exactly 22.5° → outside horizontal threshold → aligned',
    result.dimType === 'aligned')
}

// 26. Boundary case: baseline at 15° (inside horizontal threshold).
{
  // 15° → (100, tan(15°)*100) ≈ (100, 26.79)
  const A = { x: 0, y: 0 }, B = { x: 100, y: 26.79 }
  // Cursor far perp-dominant to ensure linear classification fires.
  const result = computeDimensionOrientation(A, B, { x: 50, y: -200 })
  pass('26. Baseline at 15° + perp cursor → linear-horizontal (inside threshold)',
    result.dimType === 'linear' && result.orientation === 'horizontal')
}

// 27. Diagonal baseline 60°: roughly vertical (60° is > 67.5? No, 60° is < 67.5,
//     so it's NEITHER horizontal NOR vertical → diagonal → always aligned).
{
  const A = { x: 0, y: 0 }, B = { x: 50, y: 86.6 } // 60° from horizontal
  const result = computeDimensionOrientation(A, B, { x: 100, y: 0 })
  pass('27. Baseline at 60° (diagonal, not in either threshold) → aligned',
    result.dimType === 'aligned')
}

// 28. Offset sign reflects cursor side of baseline.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  const above = computeDimensionOrientation(A, B, { x: 50, y: -30 })
  const below = computeDimensionOrientation(A, B, { x: 50, y: 30 })
  pass('28a. Cursor above horizontal baseline → negative offset',
    above.offset < 0)
  pass('28b. Cursor below horizontal baseline → positive offset',
    below.offset > 0)
  pass('28c. Offsets are mirror values',
    Math.abs(above.offset) === Math.abs(below.offset))
}

// ============================================================================
// BLOCK D — Workflow 1 commit (29–34)
//
// Mirror of useAppStore.commitWorkflow1Dimension. Captures the full
// schema produced by the action: attached pointA/B, default offset,
// aligned dimType+orientation. Mock store walks the same set-+-snapshot
// flow as the production store.
// ============================================================================

let _idSeq = 0
const newId = () => `sh-test-${++_idSeq}`

function makeMockStore() {
  const state = {
    technicalLayers: [],
    techSelected: [],
    undoStack: [],
    techActiveCommand: null,
    techDimStage: null,
    techDimPointA: null,
    techDimPointB: null,
    techCommandHover: null,
    techCommandPreSnap: null,
  }
  // Production-mirror commitWorkflow1Dimension (logic per useAppStore.js).
  const commitWorkflow1Dimension = (lineId, layerId, preSnap) => {
    const layer = state.technicalLayers.find((l) => l.id === layerId)
    const line = layer && layer.shapes.find((sh) => sh.id === lineId)
    if (!line || line.type !== 'line' || !line.a || !line.b) return
    const dx = line.b.x - line.a.x
    const dy = line.b.y - line.a.y
    if (Math.hypot(dx, dy) === 0) return
    const dim = {
      id: newId(),
      type: 'dimension',
      dimType: 'aligned',
      orientation: 'aligned',
      pointA: { mode: 'attached', shapeId: lineId, pointKey: 'a', x: line.a.x, y: line.a.y },
      pointB: { mode: 'attached', shapeId: lineId, pointKey: 'b', x: line.b.x, y: line.b.y },
      offset: DEFAULT_DIM_OFFSET_TEST,
      textOverride: null,
    }
    state.technicalLayers = state.technicalLayers.map((l) =>
      l.id === layerId ? { ...l, shapes: [...l.shapes, dim] } : l
    )
    state.techSelected = []
    if (typeof preSnap === 'string') state.undoStack.push(preSnap)
  }
  return { state, commitWorkflow1Dimension }
}

// 29. Single-line selection + commitWorkflow1Dimension → dim shape exists.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 10, 20, 34, 20)] },
  ]
  s.state.techSelected = [{ layerId: 'L1', shapeId: 'sh1' }]
  s.commitWorkflow1Dimension('sh1', 'L1', 'preSnapMarker')
  const dims = s.state.technicalLayers[0].shapes.filter((sh) => sh.type === 'dimension')
  pass('29. Workflow 1 commit adds exactly one dimension', dims.length === 1)
}

// 30. Workflow 1 dim attaches pointA to line a, pointB to line b.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 10, 20, 34, 20)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'preSnap')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('30a. pointA.shapeId === line.id', dim.pointA.shapeId === 'sh1')
  pass('30b. pointA.pointKey === "a"', dim.pointA.pointKey === 'a')
  pass('30c. pointA.mode === "attached"', dim.pointA.mode === 'attached')
  pass('30d. pointB.shapeId === line.id', dim.pointB.shapeId === 'sh1')
  pass('30e. pointB.pointKey === "b"', dim.pointB.pointKey === 'b')
  pass('30f. pointB.mode === "attached"', dim.pointB.mode === 'attached')
}

// 31. Workflow 1 dim has DEFAULT_DIM_OFFSET (24).
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 24, 0)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'preSnap')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('31. Workflow 1 default offset = 24', dim.offset === 24)
}

// 32. Workflow 1 push exactly one undo snapshot.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 24, 0)] },
  ]
  const lenBefore = s.state.undoStack.length
  s.commitWorkflow1Dimension('sh1', 'L1', 'preSnapMarker')
  pass('32a. undoStack grew by 1', s.state.undoStack.length === lenBefore + 1)
  pass('32b. last entry is the passed preSnap',
    s.state.undoStack[s.state.undoStack.length - 1] === 'preSnapMarker')
}

// 33. Selection clears after Workflow 1 commit.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 24, 0)] },
  ]
  s.state.techSelected = [{ layerId: 'L1', shapeId: 'sh1' }]
  s.commitWorkflow1Dimension('sh1', 'L1', 'preSnap')
  pass('33. techSelected empty after commit', s.state.techSelected.length === 0)
}

// 34. Workflow 1 silently fails on zero-length line.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 5, 5, 5, 5)] },
  ]
  const lenBefore = s.state.undoStack.length
  s.commitWorkflow1Dimension('sh1', 'L1', 'preSnap')
  pass('34a. Zero-length line → no dim added',
    s.state.technicalLayers[0].shapes.filter((sh) => sh.type === 'dimension').length === 0)
  pass('34b. Zero-length line → no undo pushed',
    s.state.undoStack.length === lenBefore)
}

// ============================================================================
// BLOCK E — Workflow 2 state machine (35–44)
//
// Mock the state-machine transitions: setTechActiveCommand('dimension')
// + setTechDimStage('awaitPointA') → click captures pointA → advance
// → click captures pointB → advance → click commits.
// ============================================================================

function makeWorkflow2Store() {
  const s = makeMockStore()
  s.setTechActiveCommand = (c) => { s.state.techActiveCommand = c }
  s.setTechDimStage = (st) => { s.state.techDimStage = st }
  s.setTechDimPointA = (p) => { s.state.techDimPointA = p }
  s.setTechDimPointB = (p) => { s.state.techDimPointB = p }
  s.setTechCommandHover = (h) => { s.state.techCommandHover = h }
  s.setTechCommandPreSnap = (p) => { s.state.techCommandPreSnap = p }
  // Mock of CanvasStage's onMouseDown dim dispatch — captures the
  // production code's branching exactly. Tests call this to simulate
  // a click at a given world position with optional snap hover state.
  s.simulateDimClick = (cursorWorld, snapHover, techSnapEnabled) => {
    const stage = s.state.techDimStage
    const useSnap = !!snapHover && techSnapEnabled
    const sourceShape = useSnap && snapHover.type === 'endpoint'
      ? identifySnapSourceShape(snapHover, s.state.technicalLayers)
      : null
    const pickX = useSnap ? snapHover.x : cursorWorld.x
    const pickY = useSnap ? snapHover.y : cursorWorld.y
    const picked = sourceShape
      ? { mode: 'attached', shapeId: sourceShape.shapeId, pointKey: sourceShape.pointKey, x: pickX, y: pickY }
      : { mode: 'free', shapeId: null, pointKey: null, x: pickX, y: pickY }
    if (stage === 'awaitPointA') {
      s.setTechDimPointA(picked)
      s.setTechDimStage('awaitPointB')
      s.setTechCommandHover(null)
    } else if (stage === 'awaitPointB') {
      s.setTechDimPointB(picked)
      s.setTechDimStage('awaitPosition')
      s.setTechCommandHover(null)
    } else if (stage === 'awaitPosition') {
      // Commit
      const pointA = s.state.techDimPointA
      const pointB = s.state.techDimPointB
      if (!pointA || !pointB) return
      if (pointA.x === pointB.x && pointA.y === pointB.y) {
        // Zero-distance silent fail per spec §"Decision flags" #13.
        s.setTechActiveCommand(null)
        s.setTechDimStage(null)
        s.setTechDimPointA(null)
        s.setTechDimPointB(null)
        s.setTechCommandHover(null)
        s.setTechCommandPreSnap(null)
        return
      }
      const { dimType, orientation, offset } = computeDimensionOrientation(pointA, pointB, cursorWorld)
      // Determine target layer from pointA's attachment if any.
      let layerId = null
      if (pointA.mode === 'attached' && pointA.shapeId) {
        const l = s.state.technicalLayers.find((l2) => l2.shapes.some((sh) => sh.id === pointA.shapeId))
        if (l) layerId = l.id
      }
      if (!layerId && s.state.technicalLayers.length > 0) layerId = s.state.technicalLayers[0].id
      const dim = {
        id: newId(),
        type: 'dimension',
        dimType, orientation,
        pointA, pointB,
        offset,
        textOverride: null,
      }
      if (layerId) {
        s.state.technicalLayers = s.state.technicalLayers.map((l) =>
          l.id === layerId ? { ...l, shapes: [...l.shapes, dim] } : l
        )
      } else {
        s.state.technicalLayers = [{ id: 'L-auto', visible: true, shapes: [dim] }]
      }
      const preSnap = s.state.techCommandPreSnap
      if (typeof preSnap === 'string') s.state.undoStack.push(preSnap)
      s.setTechActiveCommand(null)
      s.setTechDimStage(null)
      s.setTechDimPointA(null)
      s.setTechDimPointB(null)
      s.setTechCommandHover(null)
      s.setTechCommandPreSnap(null)
    }
  }
  s.simulateEscape = () => {
    if (s.state.techActiveCommand === 'dimension') {
      s.setTechActiveCommand(null)
      s.setTechDimStage(null)
      s.setTechDimPointA(null)
      s.setTechDimPointB(null)
      s.setTechCommandHover(null)
      s.setTechCommandPreSnap(null)
    }
  }
  return s
}

// 35. awaitPointA click → captures pointA, advances to awaitPointB.
{
  const s = makeWorkflow2Store()
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  s.setTechCommandPreSnap('preSnap1')
  s.simulateDimClick({ x: 10, y: 20 }, null, false)
  pass('35a. Stage advanced to awaitPointB', s.state.techDimStage === 'awaitPointB')
  pass('35b. techDimPointA captured', s.state.techDimPointA !== null)
  pass('35c. techDimPointA at cursor (no snap → free)',
    s.state.techDimPointA.x === 10 && s.state.techDimPointA.y === 20)
  pass('35d. techDimPointA mode === "free" (no snap)',
    s.state.techDimPointA.mode === 'free')
}

// 36. Snap at endpoint during awaitPointA → pointA.mode === "attached".
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 100, 100, 200, 100)] },
  ]
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  // Simulate snap target at sh1's endpoint a
  s.simulateDimClick({ x: 102, y: 102 }, { x: 100, y: 100, type: 'endpoint' }, true)
  pass('36a. Snap endpoint → pointA.mode === "attached"',
    s.state.techDimPointA.mode === 'attached')
  pass('36b. → pointA.shapeId === "sh1"', s.state.techDimPointA.shapeId === 'sh1')
  pass('36c. → pointA.pointKey === "a"', s.state.techDimPointA.pointKey === 'a')
  pass('36d. → pointA coords at snap target', s.state.techDimPointA.x === 100)
}

// 37. Snap at midpoint → pointA.mode === "free" (midpoints NOT defpoints).
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 100, 0)] },
  ]
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  // Snap target with type 'midpoint' — not an endpoint, so identifySnapSourceShape returns null
  s.simulateDimClick({ x: 50, y: 5 }, { x: 50, y: 0, type: 'midpoint' }, true)
  pass('37a. Midpoint snap → pointA.mode === "free"',
    s.state.techDimPointA.mode === 'free')
  pass('37b. → pointA.shapeId is null', s.state.techDimPointA.shapeId === null)
  pass('37c. → pointA coords at snap target (still snapped, just unattached)',
    s.state.techDimPointA.x === 50 && s.state.techDimPointA.y === 0)
}

// 38. awaitPointB click → captures pointB, advances to awaitPosition.
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = []
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  s.simulateDimClick({ x: 0, y: 0 }, null, false)
  s.simulateDimClick({ x: 100, y: 0 }, null, false)
  pass('38a. Stage advanced to awaitPosition',
    s.state.techDimStage === 'awaitPosition')
  pass('38b. techDimPointB captured at (100, 0)',
    s.state.techDimPointB && s.state.techDimPointB.x === 100)
}

// 39. awaitPosition click commits → dim added, all transient cleared.
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 100, 0)] },
  ]
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  s.setTechCommandPreSnap('snap-commit')
  s.simulateDimClick({ x: 0, y: 0 }, null, false)
  s.simulateDimClick({ x: 100, y: 0 }, null, false)
  s.simulateDimClick({ x: 50, y: 30 }, null, false)
  pass('39a. Dim added to technicalLayers',
    s.state.technicalLayers[0].shapes.filter((sh) => sh.type === 'dimension').length === 1)
  pass('39b. techActiveCommand cleared', s.state.techActiveCommand === null)
  pass('39c. techDimStage cleared', s.state.techDimStage === null)
  pass('39d. techDimPointA cleared', s.state.techDimPointA === null)
  pass('39e. techDimPointB cleared', s.state.techDimPointB === null)
  pass('39f. preSnap pushed to undoStack',
    s.state.undoStack[s.state.undoStack.length - 1] === 'snap-commit')
}

// 40. Escape at awaitPointA → command cleared, no shape created.
{
  const s = makeWorkflow2Store()
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  s.setTechCommandPreSnap('preSnap')
  s.simulateEscape()
  pass('40a. techActiveCommand null', s.state.techActiveCommand === null)
  pass('40b. techDimStage null', s.state.techDimStage === null)
  pass('40c. techCommandPreSnap null', s.state.techCommandPreSnap === null)
}

// 41. Escape at awaitPointB → command cleared, pointA discarded.
{
  const s = makeWorkflow2Store()
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  s.simulateDimClick({ x: 10, y: 10 }, null, false)
  pass('41a. After first click: pointA captured', s.state.techDimPointA !== null)
  s.simulateEscape()
  pass('41b. After Escape: techDimPointA cleared', s.state.techDimPointA === null)
}

// 42. Escape at awaitPosition → command cleared, both points discarded.
{
  const s = makeWorkflow2Store()
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  s.simulateDimClick({ x: 0, y: 0 }, null, false)
  s.simulateDimClick({ x: 100, y: 0 }, null, false)
  s.simulateEscape()
  pass('42a. techDimPointA cleared', s.state.techDimPointA === null)
  pass('42b. techDimPointB cleared', s.state.techDimPointB === null)
  pass('42c. techActiveCommand null', s.state.techActiveCommand === null)
}

// 43. Zero-distance commit (pointA = pointB) → silent fail, no shape.
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = [{ id: 'L1', visible: true, shapes: [] }]
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  s.setTechCommandPreSnap('preSnap')
  s.simulateDimClick({ x: 50, y: 50 }, null, false)
  s.simulateDimClick({ x: 50, y: 50 }, null, false)
  const undoLenBefore = s.state.undoStack.length
  s.simulateDimClick({ x: 60, y: 60 }, null, false)
  pass('43a. Zero-distance → no dim added',
    s.state.technicalLayers[0].shapes.filter((sh) => sh.type === 'dimension').length === 0)
  pass('43b. → undoStack unchanged',
    s.state.undoStack.length === undoLenBefore)
  pass('43c. → all dim transient state cleared',
    s.state.techActiveCommand === null && s.state.techDimStage === null)
}

// 44. Snap disabled → pointA always 'free' regardless of hover.
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 100, 100, 200, 100)] },
  ]
  s.setTechActiveCommand('dimension')
  s.setTechDimStage('awaitPointA')
  // Snap hover present but techSnapEnabled=false → useSnap is false → falls to cursor
  s.simulateDimClick({ x: 102, y: 102 }, { x: 100, y: 100, type: 'endpoint' }, false)
  pass('44a. Snap disabled → pointA.mode === "free"',
    s.state.techDimPointA.mode === 'free')
  pass('44b. → uses raw cursor coords',
    s.state.techDimPointA.x === 102 && s.state.techDimPointA.y === 102)
}

// ============================================================================
// BLOCK F — Snap integration: identifySnapSourceShape (45–50)
// ============================================================================

// 45. identifySnapSourceShape with endpoint match → returns shapeId + pointKey.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [mkLineShape('sh1', 100, 100, 200, 200)],
  }]
  const result = identifySnapSourceShape({ x: 100, y: 100, type: 'endpoint' }, layers)
  pass('45a. Endpoint match returns object',
    result && result.shapeId === 'sh1' && result.pointKey === 'a')
}

// 46. identifySnapSourceShape with midpoint target → returns null per spec.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [mkLineShape('sh1', 0, 0, 100, 0)],
  }]
  const result = identifySnapSourceShape({ x: 50, y: 0, type: 'midpoint' }, layers)
  pass('46. Midpoint target → null (midpoints NOT defpoints per spec)',
    result === null)
}

// 47. identifySnapSourceShape with no match → null.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [mkLineShape('sh1', 100, 100, 200, 200)],
  }]
  const result = identifySnapSourceShape({ x: 500, y: 500, type: 'endpoint' }, layers)
  pass('47. No matching endpoint → null', result === null)
}

// 48. Identifies endpoint 'b' correctly.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [mkLineShape('sh1', 0, 0, 100, 100)],
  }]
  const result = identifySnapSourceShape({ x: 100, y: 100, type: 'endpoint' }, layers)
  pass('48. Endpoint b match returns pointKey "b"',
    result && result.pointKey === 'b')
}

// 49. Skips invisible layers.
{
  const layers = [{
    id: 'L1', visible: false,
    shapes: [mkLineShape('sh1', 100, 100, 200, 200)],
  }]
  const result = identifySnapSourceShape({ x: 100, y: 100, type: 'endpoint' }, layers)
  pass('49. Invisible layer → match skipped, null returned', result === null)
}

// 50. Skips non-line shapes (dim endpoints aren't defpoints).
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkDimShape('dim1',
        { mode: 'free', shapeId: null, pointKey: null, x: 100, y: 100 },
        { mode: 'free', shapeId: null, pointKey: null, x: 200, y: 200 },
      ),
    ],
  }]
  const result = identifySnapSourceShape({ x: 100, y: 100, type: 'endpoint' }, layers)
  pass('50. Dimension endpoint NOT a defpoint → null', result === null)
}

// ============================================================================
// BLOCK G — Associativity: propagateDimensionUpdates + cascadeDimensionDeletion
// (51–62)
//
// Production-mirror helpers. The actual store functions live in
// useAppStore.js and are called by every commit action; tests here
// exercise them as pure functions with mock layer arrays.
// ============================================================================

// Production-mirror propagateDimensionUpdates (logic per useAppStore.js).
function propagateDimensionUpdates(technicalLayers, mutatedShapeIds) {
  if (!Array.isArray(technicalLayers)) return technicalLayers
  if (!(mutatedShapeIds instanceof Set) || mutatedShapeIds.size === 0) {
    return technicalLayers
  }
  let anyLayerChanged = false
  const nextLayers = technicalLayers.map((layer) => {
    if (!layer || !Array.isArray(layer.shapes)) return layer
    let anyShapeChanged = false
    const nextShapes = layer.shapes.map((sh) => {
      if (!sh || sh.type !== 'dimension') return sh
      let changed = false
      const updatePoint = (p) => {
        if (!p || p.mode !== 'attached' || !p.shapeId || !p.pointKey) return p
        if (!mutatedShapeIds.has(p.shapeId)) return p
        for (const l of technicalLayers) {
          if (!l || !Array.isArray(l.shapes)) continue
          const target = l.shapes.find((s) => s && s.id === p.shapeId)
          if (target && target[p.pointKey]) {
            changed = true
            return { ...p, x: target[p.pointKey].x, y: target[p.pointKey].y }
          }
        }
        return p
      }
      const newA = updatePoint(sh.pointA)
      const newB = updatePoint(sh.pointB)
      if (!changed) return sh
      anyShapeChanged = true
      return { ...sh, pointA: newA, pointB: newB }
    })
    if (!anyShapeChanged) return layer
    anyLayerChanged = true
    return { ...layer, shapes: nextShapes }
  })
  return anyLayerChanged ? nextLayers : technicalLayers
}

// Production-mirror cascadeDimensionDeletion (logic per useAppStore.js).
function cascadeDimensionDeletion(technicalLayers, deletedShapeIds) {
  if (!Array.isArray(technicalLayers)) return technicalLayers
  if (!(deletedShapeIds instanceof Set) || deletedShapeIds.size === 0) {
    return technicalLayers
  }
  let anyLayerChanged = false
  const nextLayers = technicalLayers.map((layer) => {
    if (!layer || !Array.isArray(layer.shapes)) return layer
    let anyShapeChanged = false
    const nextShapes = layer.shapes.map((sh) => {
      if (!sh || sh.type !== 'dimension') return sh
      const flipPoint = (p) => {
        if (!p || p.mode !== 'attached' || !p.shapeId) return p
        if (!deletedShapeIds.has(p.shapeId)) return p
        return { mode: 'free', shapeId: null, pointKey: null, x: p.x, y: p.y }
      }
      const newA = flipPoint(sh.pointA)
      const newB = flipPoint(sh.pointB)
      if (newA === sh.pointA && newB === sh.pointB) return sh
      anyShapeChanged = true
      return { ...sh, pointA: newA, pointB: newB }
    })
    if (!anyShapeChanged) return layer
    anyLayerChanged = true
    return { ...layer, shapes: nextShapes }
  })
  return anyLayerChanged ? nextLayers : technicalLayers
}

// 51. Propagate updates dim's cached pointA.x when parent line moves.
{
  // Setup: line moved from (0,0)→(24,0) to (10,0)→(34,0). Dim attached
  // to its endpoints. Propagate the move.
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 10, 0, 34, 0),                       // moved line
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },  // stale cache
        { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 24, y: 0 },
      ),
    ],
  }]
  const next = propagateDimensionUpdates(layers, new Set(['sh1']))
  const dim = next[0].shapes[1]
  pass('51a. dim.pointA.x updated to live line.a.x', dim.pointA.x === 10)
  pass('51b. dim.pointB.x updated to live line.b.x', dim.pointB.x === 34)
}

// 52. Propagate is no-op if mutatedShapeIds doesn't include any dim parent.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 0, 0, 24, 0),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
        { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 24, y: 0 },
      ),
    ],
  }]
  const next = propagateDimensionUpdates(layers, new Set(['sh-other']))
  pass('52. Unrelated mutated shape → same layers ref (no change)',
    next === layers)
}

// 53. Propagate skips 'free' points.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 10, 0, 34, 0),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
        { mode: 'free', shapeId: null, pointKey: null, x: 200, y: 0 },
      ),
    ],
  }]
  const next = propagateDimensionUpdates(layers, new Set(['sh1']))
  const dim = next[0].shapes[1]
  pass('53a. attached pointA updated', dim.pointA.x === 10)
  pass('53b. free pointB unchanged', dim.pointB.x === 200)
}

// 54. Cascade flips 'attached' → 'free' on parent deletion.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 10, 20, 34, 20),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 10, y: 20 },
        { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 34, y: 20 },
      ),
    ],
  }]
  const next = cascadeDimensionDeletion(layers, new Set(['sh1']))
  const dim = next[0].shapes[1]
  pass('54a. pointA.mode flipped to "free"', dim.pointA.mode === 'free')
  pass('54b. pointA.shapeId nulled', dim.pointA.shapeId === null)
  pass('54c. pointA.pointKey nulled', dim.pointA.pointKey === null)
  pass('54d. pointA.x cached preserved', dim.pointA.x === 10)
  pass('54e. pointA.y cached preserved', dim.pointA.y === 20)
}

// 55. Cascade skips dims whose attached shape isn't in deletion set.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 10, 0, 34, 0),
      mkLineShape('sh2', 50, 0, 80, 0),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 10, y: 0 },
        { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 34, y: 0 },
      ),
    ],
  }]
  // Delete sh2 (unrelated to dim1's attachment)
  const next = cascadeDimensionDeletion(layers, new Set(['sh2']))
  pass('55. Unrelated deletion → same layers ref (no cascade)',
    next === layers)
}

// 56. Cascade handles partial attachment (one attached, one free).
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 10, 0, 34, 0),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 10, y: 0 },
        { mode: 'free', shapeId: null, pointKey: null, x: 200, y: 0 },
      ),
    ],
  }]
  const next = cascadeDimensionDeletion(layers, new Set(['sh1']))
  const dim = next[0].shapes[1]
  pass('56a. attached pointA flipped to free', dim.pointA.mode === 'free')
  pass('56b. already-free pointB unchanged ref', dim.pointB === layers[0].shapes[1].pointB)
}

// 57. Propagate handles multiple dims attached to same parent.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 10, 0, 34, 0),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
        { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 24, y: 0 },
      ),
      mkDimShape('dim2',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
        { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 24, y: 0 },
      ),
    ],
  }]
  const next = propagateDimensionUpdates(layers, new Set(['sh1']))
  pass('57a. dim1 updated', next[0].shapes[1].pointA.x === 10)
  pass('57b. dim2 updated', next[0].shapes[2].pointA.x === 10)
}

// 58. Propagate handles dim with attached pointA on lineA, pointB on lineB.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 10, 0, 34, 0),
      mkLineShape('sh2', 100, 0, 124, 0),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
        { mode: 'attached', shapeId: 'sh2', pointKey: 'a', x: 0, y: 0 },
      ),
    ],
  }]
  const next = propagateDimensionUpdates(layers, new Set(['sh1']))
  const dim = next[0].shapes[2]
  pass('58a. dim pointA updated (sh1 mutated)', dim.pointA.x === 10)
  pass('58b. dim pointB unchanged (sh2 not in mutated set)',
    dim.pointB.x === 0)
}

// 59. Cascade returns same layers when mutatedShapeIds is empty Set.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [mkDimShape('dim1',
      { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
      { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 24, y: 0 },
    )],
  }]
  pass('59a. propagateDimensionUpdates empty set → ref equal',
    propagateDimensionUpdates(layers, new Set()) === layers)
  pass('59b. cascadeDimensionDeletion empty set → ref equal',
    cascadeDimensionDeletion(layers, new Set()) === layers)
}

// 60. Propagate handles line shape that has been deleted (cache fallback).
{
  // Dim attached to sh1 but sh1 doesn't exist in current layers.
  // Propagate's lookup falls through; returns dim unchanged.
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh-missing', pointKey: 'a', x: 5, y: 5 },
        { mode: 'attached', shapeId: 'sh-missing', pointKey: 'b', x: 25, y: 5 },
      ),
    ],
  }]
  const next = propagateDimensionUpdates(layers, new Set(['sh-missing']))
  // sh-missing isn't in the layer so propagate finds no live coords;
  // the dim should be returned unchanged (cached fallback in render).
  pass('60. Propagate with missing parent → no change (cache preserved)',
    next === layers)
}

// 61. Cascade handles multi-deletion.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 0, 0, 24, 0),
      mkLineShape('sh2', 50, 0, 74, 0),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
        { mode: 'attached', shapeId: 'sh2', pointKey: 'b', x: 74, y: 0 },
      ),
    ],
  }]
  const next = cascadeDimensionDeletion(layers, new Set(['sh1', 'sh2']))
  const dim = next[0].shapes[2]
  pass('61a. Both pointA and pointB cascaded to free',
    dim.pointA.mode === 'free' && dim.pointB.mode === 'free')
  pass('61b. Both cached coords preserved',
    dim.pointA.x === 0 && dim.pointB.x === 74)
}

// 62. Cascade preserves non-dim shapes unchanged.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [
      mkLineShape('sh1', 0, 0, 24, 0),
      mkLineShape('sh2', 50, 0, 74, 0),
      mkDimShape('dim1',
        { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },
        { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 24, y: 0 },
      ),
    ],
  }]
  const next = cascadeDimensionDeletion(layers, new Set(['sh1']))
  // sh2 should be ref-equal to original (no flip happened to it).
  pass('62. Lines pass through cascade unchanged',
    next[0].shapes[1] === layers[0].shapes[1])
}

// ============================================================================
// BLOCK H — Render geometry + length-label removal regression (63–72)
// ============================================================================

// 63. resolveDimensionPoints returns attached coords when parent line exists.
{
  const layers = [{
    id: 'L1', visible: true,
    shapes: [mkLineShape('sh1', 100, 200, 300, 400)],
  }]
  const dim = mkDimShape('dim1',
    { mode: 'attached', shapeId: 'sh1', pointKey: 'a', x: 0, y: 0 },   // stale cache
    { mode: 'attached', shapeId: 'sh1', pointKey: 'b', x: 0, y: 0 },
  )
  const { A, B } = resolveDimensionPoints(dim, layers)
  pass('63a. A resolves to live line.a',
    A.x === 100 && A.y === 200)
  pass('63b. B resolves to live line.b',
    B.x === 300 && B.y === 400)
}

// 64. resolveDimensionPoints falls back to cache when parent missing.
{
  const layers = []
  const dim = mkDimShape('dim1',
    { mode: 'attached', shapeId: 'sh-missing', pointKey: 'a', x: 100, y: 200 },
    { mode: 'attached', shapeId: 'sh-missing', pointKey: 'b', x: 300, y: 400 },
  )
  const { A, B } = resolveDimensionPoints(dim, layers)
  pass('64a. A falls back to cache',
    A.x === 100 && A.y === 200)
  pass('64b. B falls back to cache',
    B.x === 300 && B.y === 400)
}

// 65. computeDimensionLengthInches — aligned dim.
{
  // A=(0,0), B=(24, 0): hypot = 24 px = 1 inch
  const dim = mkDimShape('d1',
    { mode: 'free', shapeId: null, pointKey: null, x: 0, y: 0 },
    { mode: 'free', shapeId: null, pointKey: null, x: 24, y: 0 },
    { dimType: 'aligned', orientation: 'aligned' },
  )
  pass('65. Aligned 24-px dim → 1.0 inches',
    near(computeDimensionLengthInches(dim, []), 1.0))
}

// 66. computeDimensionLengthInches — linear-horizontal ignores Y component.
{
  // A=(0,0), B=(48, 24): horizontal dim uses |48-0|=48 px = 2 inches
  const dim = mkDimShape('d1',
    { mode: 'free', shapeId: null, pointKey: null, x: 0, y: 0 },
    { mode: 'free', shapeId: null, pointKey: null, x: 48, y: 24 },
    { dimType: 'linear', orientation: 'horizontal' },
  )
  pass('66. Linear-H 48-px-x dim → 2.0 inches',
    near(computeDimensionLengthInches(dim, []), 2.0))
}

// 67. computeDimensionLengthInches — linear-vertical ignores X component.
{
  const dim = mkDimShape('d1',
    { mode: 'free', shapeId: null, pointKey: null, x: 0, y: 0 },
    { mode: 'free', shapeId: null, pointKey: null, x: 48, y: 24 },
    { dimType: 'linear', orientation: 'vertical' },
  )
  pass('67. Linear-V dim → 1.0 inch (only Y component)',
    near(computeDimensionLengthInches(dim, []), 1.0))
}

// 68. computeDimensionGeometry — aligned dim line is parallel to baseline.
{
  // Horizontal baseline + offset=24 (positive) means dim line is below
  // baseline (positive Y in canvas).
  const dim = mkDimShape('d1', { x: 0, y: 0 }, { x: 100, y: 0 },
    { dimType: 'aligned', orientation: 'aligned', offset: 24 })
  const geom = computeDimensionGeometry(dim, { x: 0, y: 0 }, { x: 100, y: 0 })
  pass('68a. Aligned dim line at y = offset (24)',
    geom.dimA.y === 24 && geom.dimB.y === 24)
  pass('68b. dim line spans baseline x range',
    geom.dimA.x === 0 && geom.dimB.x === 100)
}

// 69. computeDimensionGeometry — linear-horizontal dim line is Y-only offset.
{
  const dim = mkDimShape('d1', { x: 0, y: 0 }, { x: 100, y: 0 },
    { dimType: 'linear', orientation: 'horizontal', offset: 30 })
  const geom = computeDimensionGeometry(dim, { x: 0, y: 0 }, { x: 100, y: 0 })
  pass('69a. Linear-H dim line at midpoint.y + offset',
    geom.dimA.y === 30 && geom.dimB.y === 30)
  pass('69b. textRot === 0 for linear-horizontal',
    geom.textRot === 0)
}

// 70. computeDimensionGeometry — linear-vertical dim line is X-only offset.
{
  const dim = mkDimShape('d1', { x: 0, y: 0 }, { x: 0, y: 100 },
    { dimType: 'linear', orientation: 'vertical', offset: 30 })
  const geom = computeDimensionGeometry(dim, { x: 0, y: 0 }, { x: 0, y: 100 })
  pass('70a. Linear-V dim line at midpoint.x + offset',
    geom.dimA.x === 30 && geom.dimB.x === 30)
  pass('70b. textRot === -π/2 for linear-vertical (reads bottom-to-top)',
    near(geom.textRot, -Math.PI / 2))
}

// 71. hitTestDimension hits cursor on dim line.
{
  // Horizontal dim line spans (0,30) to (100,30). Cursor at (50, 30)
  // should hit.
  const dim = mkDimShape('d1', { x: 0, y: 0 }, { x: 100, y: 0 },
    { dimType: 'linear', orientation: 'horizontal', offset: 30 })
  // viewport zoom=1, pan=0 → world == canvas
  const hit = hitTestDimension(dim, { x: 50, y: 30 }, [], 1, 0, 0, 7)
  pass('71a. Cursor on dim line → hit', hit === true)
  // Cursor far away → no hit.
  const miss = hitTestDimension(dim, { x: 500, y: 500 }, [], 1, 0, 0, 7)
  pass('71b. Cursor far away → no hit', miss === false)
}

// 72. Length-label removal regression: drawStatic source has NO fillText
//     call referencing sh.lengthInches.
//
// Source-grep test — reads CanvasStage.jsx, finds the TECHNICAL branch
// of drawStatic, asserts the per-shape loop contains no `fillText` that
// references `sh.lengthInches`. Per spec §"Length labels on lines —
// REMOVAL" and §"Decision flags" #14.
{
  const canvasSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'CanvasStage.jsx'),
    'utf-8',
  )
  // Find the TECHNICAL branch of drawStatic.
  const techBranchStart = canvasSrc.indexOf("appMode === 'TECHNICAL'")
  // Heuristic: scan for the closing `return}` of that branch — match
  // `ctxStatic.restore()\n        return` within the first 4000 chars.
  const techBranchSlice = canvasSrc.slice(techBranchStart, techBranchStart + 4000)
  // The label-render block had: `ctxStatic.fillText(label, lx, ly)` AND
  // a `const v = sh.lengthInches` read. Both should be gone in 18e.
  const hasLengthInchesRead = /sh\.lengthInches/.test(techBranchSlice)
  const hasLabelFillText = /fillText\(label,/.test(techBranchSlice)
  pass('72a. drawStatic TECHNICAL branch: no `sh.lengthInches` read',
    !hasLengthInchesRead)
  pass('72b. drawStatic TECHNICAL branch: no `fillText(label, ...)` call',
    !hasLabelFillText)
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
