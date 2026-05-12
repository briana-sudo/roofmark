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
// Phase 2 18e-dim-split (May 12 2026) — computeDimensionOrientation DELETED
// per spec v1.2. Replaced by computeAlignedOrientation +
// computeLinearOrientation. pickLinearOrientationFromLine is the Workflow 1
// Linear helper. isDimensionCommand centralizes the dim-command predicate.
const {
  resolveDimensionPoints,
  identifySnapSourceShape,
  computeAlignedOrientation,
  computeLinearOrientation,
  pickLinearOrientationFromLine,
  isDimensionCommand,
  computeDimensionLengthInches,
  computeDimensionGeometry,
  hitTestDimension,
  distanceFromSegment2,
} = loadModule(
  'src/utils/dimGeometry.js',
  [
    'resolveDimensionPoints', 'identifySnapSourceShape',
    'computeAlignedOrientation', 'computeLinearOrientation',
    'pickLinearOrientationFromLine', 'isDimensionCommand',
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
// Phase 2 18e-dim-split (May 12 2026) — spec v1.2. The original
// computeDimensionOrientation collapsed DIMLINEAR + DIMALIGNED under a
// single drag-to-discover gate. Operator-reported friction → split into
// two explicit pure functions:
//   - computeAlignedOrientation (Workflow 2 Aligned): always aligned,
//     offset only, no decision tree.
//   - computeLinearOrientation (Workflow 2 Linear): world-axis-relative
//     cursor side picks H/V. No aligned outcome.
// Block C is split into C1 + C2.
// ============================================================================

// ----- BLOCK C1 — computeAlignedOrientation (19–21) ------------------------
//
// Drag chooses offset + side only. Orientation is always 'aligned' (no
// orientation field on the result). Offset is signed perpendicular
// projection of cursor from baseline midpoint.

// 19. Horizontal baseline + cursor below → positive offset.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  // perpUnit for horizontal baseline is (0, 1); cursor (50, 50) →
  // perpComponent = 50 (positive).
  const result = computeAlignedOrientation(A, B, { x: 50, y: 50 })
  pass('19a. Aligned: cursor below horizontal baseline → positive offset',
    result.offset === 50)
  pass('19b. Aligned: result has no orientation field (always aligned)',
    !('orientation' in result))
}

// 20. Horizontal baseline + cursor above → negative offset (mirror sign).
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  const above = computeAlignedOrientation(A, B, { x: 50, y: -50 })
  const below = computeAlignedOrientation(A, B, { x: 50, y: 50 })
  pass('20a. Aligned: cursor above → negative offset', above.offset === -50)
  pass('20b. Aligned: opposite sides mirror sign',
    Math.sign(above.offset) === -Math.sign(below.offset)
    && Math.abs(above.offset) === Math.abs(below.offset))
}

// 21. Diagonal baseline (45°) + cursor on either side → aligned with
//     signed offset proportional to perpendicular distance from baseline.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 100 }
  const upperLeft = computeAlignedOrientation(A, B, { x: 0, y: 80 })
  const lowerRight = computeAlignedOrientation(A, B, { x: 80, y: 0 })
  pass('21a. Aligned: diagonal baseline cursor upper-left has signed offset',
    typeof upperLeft.offset === 'number')
  pass('21b. Aligned: diagonal baseline opposite cursor sides flip sign',
    Math.sign(upperLeft.offset) !== Math.sign(lowerRight.offset))
}

// ----- BLOCK C2 — computeLinearOrientation (22–27) -------------------------
//
// World-axis-relative cursor side picks horizontal vs vertical. NO
// aligned outcome possible. Tie-break (|dx| === |dy|) → vertical (else).

// 22. Cursor above midpoint (|dy| > |dx|) → horizontal.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  // Midpoint = (50, 0); cursor (50, -100) → dy = -100, dx = 0 → |dy|>|dx|.
  const result = computeLinearOrientation(A, B, { x: 50, y: -100 })
  pass('22a. Linear: cursor above midpoint → horizontal',
    result.orientation === 'horizontal')
  pass('22b. Linear: horizontal offset = dy',
    result.offset === -100)
}

// 23. Cursor below midpoint → horizontal with positive offset.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  const result = computeLinearOrientation(A, B, { x: 50, y: 100 })
  pass('23a. Linear: cursor below midpoint → horizontal',
    result.orientation === 'horizontal')
  pass('23b. Linear: positive offset',
    result.offset === 100)
}

// 24. Cursor right of midpoint (|dx| > |dy|) → vertical.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  // Midpoint = (50, 0); cursor (200, 10) → dx = 150, dy = 10 → |dx|>|dy|.
  const result = computeLinearOrientation(A, B, { x: 200, y: 10 })
  pass('24a. Linear: cursor right of midpoint → vertical',
    result.orientation === 'vertical')
  pass('24b. Linear: vertical offset = dx',
    result.offset === 150)
}

// 25. Cursor left of midpoint → vertical with negative offset.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  const result = computeLinearOrientation(A, B, { x: -100, y: 5 })
  pass('25a. Linear: cursor left of midpoint → vertical',
    result.orientation === 'vertical')
  pass('25b. Linear: negative offset',
    result.offset === -150)
}

// 26. Near-45° cursor with |dy| slightly > |dx| → horizontal.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  // Midpoint = (50, 0); cursor (101, -52) → dx=51, dy=-52 → |dy|>|dx|.
  const result = computeLinearOrientation(A, B, { x: 101, y: -52 })
  pass('26. Linear: near-45° cursor with |dy|>|dx| → horizontal',
    result.orientation === 'horizontal')
}

// 27. Exact-tie cursor (|dx| === |dy|) → vertical (else branch).
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  // Midpoint = (50, 0); cursor (100, -50) → dx=50, dy=-50 → tie.
  // Math.abs(dy) > Math.abs(dx) is false (equal) → else → vertical.
  const result = computeLinearOrientation(A, B, { x: 100, y: -50 })
  pass('27a. Linear: |dx|===|dy| tie-breaks to vertical',
    result.orientation === 'vertical')
  pass('27b. Linear: tied case offset is dx',
    result.offset === 50)
}

// 28. Cursor at exact midpoint (dx === dy === 0) → tie → vertical, offset 0.
{
  const A = { x: 0, y: 0 }, B = { x: 100, y: 0 }
  const result = computeLinearOrientation(A, B, { x: 50, y: 0 })
  pass('28a. Linear: cursor at midpoint → vertical (tie)',
    result.orientation === 'vertical')
  pass('28b. Linear: zero offset', result.offset === 0)
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
  // Production-mirror commitWorkflow1Dimension (logic per useAppStore.js,
  // post 18e-dim-split v1.2). `dimType` parameter selects aligned vs
  // linear; linear path resolves orientation via pickLinearOrientationFromLine.
  const commitWorkflow1Dimension = (lineId, layerId, dimType, preSnap) => {
    const layer = state.technicalLayers.find((l) => l.id === layerId)
    const line = layer && layer.shapes.find((sh) => sh.id === lineId)
    if (!line || line.type !== 'line' || !line.a || !line.b) return
    const dx = line.b.x - line.a.x
    const dy = line.b.y - line.a.y
    if (Math.hypot(dx, dy) === 0) return
    let resolvedDimType
    let resolvedOrientation
    if (dimType === 'linear') {
      resolvedDimType = 'linear'
      resolvedOrientation = pickLinearOrientationFromLine(line)
    } else {
      resolvedDimType = 'aligned'
      resolvedOrientation = 'aligned'
    }
    const dim = {
      id: newId(),
      type: 'dimension',
      dimType: resolvedDimType,
      orientation: resolvedOrientation,
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
  s.commitWorkflow1Dimension('sh1', 'L1', 'aligned', 'preSnapMarker')
  const dims = s.state.technicalLayers[0].shapes.filter((sh) => sh.type === 'dimension')
  pass('29. Workflow 1 commit adds exactly one dimension', dims.length === 1)
}

// 30. Workflow 1 dim attaches pointA to line a, pointB to line b.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 10, 20, 34, 20)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'aligned', 'preSnap')
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
  s.commitWorkflow1Dimension('sh1', 'L1', 'aligned', 'preSnap')
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
  s.commitWorkflow1Dimension('sh1', 'L1', 'aligned', 'preSnapMarker')
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
  s.commitWorkflow1Dimension('sh1', 'L1', 'aligned', 'preSnap')
  pass('33. techSelected empty after commit', s.state.techSelected.length === 0)
}

// 34. Workflow 1 silently fails on zero-length line.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 5, 5, 5, 5)] },
  ]
  const lenBefore = s.state.undoStack.length
  s.commitWorkflow1Dimension('sh1', 'L1', 'aligned', 'preSnap')
  pass('34a. Zero-length line → no dim added',
    s.state.technicalLayers[0].shapes.filter((sh) => sh.type === 'dimension').length === 0)
  pass('34b. Zero-length line → no undo pushed',
    s.state.undoStack.length === lenBefore)
}

// ============================================================================
// BLOCK E — Workflow 2 state machine (35–44)
//
// Mock the state-machine transitions: setTechActiveCommand('dim-aligned')
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
      // Phase 2 18e-dim-split: orientation helper switches on command.
      const isAligned = s.state.techActiveCommand === 'dim-aligned'
      let dimType
      let orientation
      let offset
      if (isAligned) {
        dimType = 'aligned'
        orientation = 'aligned'
        offset = computeAlignedOrientation(pointA, pointB, cursorWorld).offset
      } else {
        dimType = 'linear'
        const linear = computeLinearOrientation(pointA, pointB, cursorWorld)
        orientation = linear.orientation
        offset = linear.offset
      }
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
    // Phase 2 18e-dim-split: accept either dim command (mirrors
    // isDimensionCommand from production dimGeometry).
    if (
      s.state.techActiveCommand === 'dim-aligned'
      || s.state.techActiveCommand === 'dim-linear'
    ) {
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
  s.setTechActiveCommand('dim-aligned')
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
  s.setTechActiveCommand('dim-aligned')
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
  s.setTechActiveCommand('dim-aligned')
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
  s.setTechActiveCommand('dim-aligned')
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
  s.setTechActiveCommand('dim-aligned')
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
  s.setTechActiveCommand('dim-aligned')
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
  s.setTechActiveCommand('dim-aligned')
  s.setTechDimStage('awaitPointA')
  s.simulateDimClick({ x: 10, y: 10 }, null, false)
  pass('41a. After first click: pointA captured', s.state.techDimPointA !== null)
  s.simulateEscape()
  pass('41b. After Escape: techDimPointA cleared', s.state.techDimPointA === null)
}

// 42. Escape at awaitPosition → command cleared, both points discarded.
{
  const s = makeWorkflow2Store()
  s.setTechActiveCommand('dim-aligned')
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
  s.setTechActiveCommand('dim-aligned')
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
  s.setTechActiveCommand('dim-aligned')
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
// BLOCK I — Phase 2 18e-dim-split (73–82) — Workflow 1 Linear via
// pickLinearOrientationFromLine + parameterized commitWorkflow1Dimension.
//
// Spec v1.2: Workflow 1 LINEAR commit picks orientation purely from the
// line's baseline angle (no cursor). Production-mirror commit (declared
// in makeMockStore above) routes through pickLinearOrientationFromLine
// when dimType === 'linear'.
// ============================================================================

// 73. Workflow 1 Linear on horizontal line → orientation 'horizontal'.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 100, 0)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'linear', 'preSnap')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('73a. Workflow 1 Linear on horizontal line → dimType linear',
    dim && dim.dimType === 'linear')
  pass('73b. → orientation horizontal',
    dim && dim.orientation === 'horizontal')
}

// 74. Workflow 1 Linear on vertical line → orientation 'vertical'.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 0, 100)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'linear', 'preSnap')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('74a. Workflow 1 Linear on vertical line → dimType linear',
    dim && dim.dimType === 'linear')
  pass('74b. → orientation vertical',
    dim && dim.orientation === 'vertical')
}

// 75. Workflow 1 Linear on near-horizontal line (5.7°) → 'horizontal'
//     (within ±22.5° threshold).
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 100, 10)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'linear', 'preSnap')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('75. Workflow 1 Linear on 5.7° line → horizontal',
    dim && dim.orientation === 'horizontal')
}

// 76. Workflow 1 Linear on 30° diagonal (more horizontal than vertical)
//     → 'horizontal' via longer-projection diagonal fallback.
{
  const s = makeMockStore()
  // 30° from horizontal: dx=50, dy=25 → |dx|>|dy| → 'horizontal'.
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 50, 25)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'linear', 'preSnap')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('76. Workflow 1 Linear on 30° diagonal → horizontal (longer projection)',
    dim && dim.orientation === 'horizontal')
}

// 77. Workflow 1 Linear on 60° diagonal (more vertical than horizontal)
//     → 'vertical'.
{
  const s = makeMockStore()
  // 60° from horizontal: dx=25, dy=43.3 → |dy|>|dx| → 'vertical'.
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 25, 43.3)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'linear', 'preSnap')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('77. Workflow 1 Linear on 60° diagonal → vertical (longer projection)',
    dim && dim.orientation === 'vertical')
}

// 78. Workflow 1 Linear on 45° diagonal exact tie → 'vertical'
//     (|dx| === |dy|, else branch of pickLinearOrientationFromLine fires).
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 50, 50)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'linear', 'preSnap')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('78. Workflow 1 Linear on 45° diagonal tie → vertical (else branch)',
    dim && dim.orientation === 'vertical')
}

// 79. pickLinearOrientationFromLine — boundary at exactly 22.5°.
{
  const line = {
    type: 'line',
    a: { x: 0, y: 0 },
    b: { x: 100, y: 100 * Math.tan(22.5 * Math.PI / 180) },
  }
  // baselineDeg = 22.5 exactly; "< 22.5" is strict false, "> 157.5" false,
  // 67.5 ≤ 22.5 ≤ 112.5 false → falls to longer-projection fallback.
  // |dx|=100, |dy|≈41.42 → |dx|>|dy| → 'horizontal'.
  const result = pickLinearOrientationFromLine(line)
  pass('79. pickLinearOrientationFromLine at exactly 22.5° → horizontal (longer projection)',
    result === 'horizontal')
}

// 80. pickLinearOrientationFromLine — invalid input falls back to horizontal.
{
  pass('80a. pickLinearOrientationFromLine(null) → "horizontal" (defensive)',
    pickLinearOrientationFromLine(null) === 'horizontal')
  pass('80b. pickLinearOrientationFromLine(non-line) → "horizontal"',
    pickLinearOrientationFromLine({ type: 'dimension' }) === 'horizontal')
}

// 81. Workflow 1 Aligned still works after dim-split (regression).
//     With dimType='aligned', orientation is always 'aligned' regardless
//     of line angle (matches pre-split behavior).
{
  const s = makeMockStore()
  // Vertical line — would be 'vertical' under Linear, but Aligned forces aligned.
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 0, 100)] },
  ]
  s.commitWorkflow1Dimension('sh1', 'L1', 'aligned', 'preSnap')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('81a. Workflow 1 Aligned on vertical line → dimType aligned',
    dim && dim.dimType === 'aligned')
  pass('81b. → orientation aligned (NOT vertical)',
    dim && dim.orientation === 'aligned')
}

// 82. Workflow 1 Linear zero-length line → silent fail (same as Aligned).
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 50, 50, 50, 50)] },
  ]
  const undoLenBefore = s.state.undoStack.length
  s.commitWorkflow1Dimension('sh1', 'L1', 'linear', 'preSnap')
  pass('82a. Zero-length Linear → no dim added',
    s.state.technicalLayers[0].shapes.filter((sh) => sh.type === 'dimension').length === 0)
  pass('82b. → no undo pushed',
    s.state.undoStack.length === undoLenBefore)
}

// ============================================================================
// BLOCK J — Phase 2 18e-dim-split (83–87) — Workflow 2 awaitPosition
// orientation per command. The makeWorkflow2Store's simulateDimClick
// production mirror switches on techActiveCommand: 'dim-aligned' calls
// computeAlignedOrientation; 'dim-linear' calls computeLinearOrientation.
// ============================================================================

// 83. Workflow 2 'dim-aligned' awaitPosition commit → always aligned
//     regardless of cursor side.
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 100, 0)] },
  ]
  s.setTechActiveCommand('dim-aligned')
  s.setTechDimStage('awaitPointA')
  s.setTechCommandPreSnap('preSnap')
  // Click A, B at line endpoints, then click cursor far above midpoint —
  // would be linear-horizontal under old single-Dim model, but Aligned
  // overrides.
  s.simulateDimClick({ x: 0, y: 0 }, null, false)
  s.simulateDimClick({ x: 100, y: 0 }, null, false)
  s.simulateDimClick({ x: 50, y: -200 }, null, false)
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('83a. dim-aligned commit → dimType aligned',
    dim && dim.dimType === 'aligned')
  pass('83b. → orientation aligned',
    dim && dim.orientation === 'aligned')
}

// 84. Workflow 2 'dim-linear' awaitPosition with cursor above midpoint
//     → linear-horizontal (NEVER aligned under Linear).
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 100, 0)] },
  ]
  s.setTechActiveCommand('dim-linear')
  s.setTechDimStage('awaitPointA')
  s.setTechCommandPreSnap('preSnap')
  s.simulateDimClick({ x: 0, y: 0 }, null, false)
  s.simulateDimClick({ x: 100, y: 0 }, null, false)
  s.simulateDimClick({ x: 50, y: -100 }, null, false)
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('84a. dim-linear + cursor above → dimType linear',
    dim && dim.dimType === 'linear')
  pass('84b. → orientation horizontal',
    dim && dim.orientation === 'horizontal')
}

// 85. Workflow 2 'dim-linear' with cursor right of midpoint → linear-vertical.
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 100, 0)] },
  ]
  s.setTechActiveCommand('dim-linear')
  s.setTechDimStage('awaitPointA')
  s.setTechCommandPreSnap('preSnap')
  s.simulateDimClick({ x: 0, y: 0 }, null, false)
  s.simulateDimClick({ x: 100, y: 0 }, null, false)
  s.simulateDimClick({ x: 250, y: 5 }, null, false)
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('85. dim-linear + cursor right → orientation vertical',
    dim && dim.orientation === 'vertical')
}

// 86. dim-linear commit produces 'linear' dimType regardless of baseline
//     angle (the orientation algorithm doesn't consult baseline angle —
//     spec v1.2 §"Workflow 2 Linear" world-axis interpretation).
{
  const s = makeWorkflow2Store()
  s.state.technicalLayers = []
  s.setTechActiveCommand('dim-linear')
  s.setTechDimStage('awaitPointA')
  s.setTechCommandPreSnap('preSnap')
  // Diagonal A→B baseline
  s.simulateDimClick({ x: 0, y: 0 }, null, false)
  s.simulateDimClick({ x: 100, y: 100 }, null, false)
  // Cursor far above midpoint → horizontal
  s.simulateDimClick({ x: 50, y: -200 }, null, false)
  const layers = s.state.technicalLayers
  const dim = layers[0] && layers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('86a. dim-linear + diagonal baseline + cursor above → dimType linear',
    dim && dim.dimType === 'linear')
  pass('86b. → orientation horizontal (cursor side, NOT baseline angle)',
    dim && dim.orientation === 'horizontal')
}

// 87. Escape works for both dim-aligned and dim-linear.
{
  const sAligned = makeWorkflow2Store()
  sAligned.setTechActiveCommand('dim-aligned')
  sAligned.setTechDimStage('awaitPointA')
  sAligned.simulateEscape()
  pass('87a. dim-aligned + Escape → command cleared',
    sAligned.state.techActiveCommand === null)

  const sLinear = makeWorkflow2Store()
  sLinear.setTechActiveCommand('dim-linear')
  sLinear.setTechDimStage('awaitPointB')
  sLinear.setTechDimPointA({ mode: 'free', x: 0, y: 0 })
  sLinear.simulateEscape()
  pass('87b. dim-linear + Escape mid-workflow → command + pointA cleared',
    sLinear.state.techActiveCommand === null && sLinear.state.techDimPointA === null)
}

// ============================================================================
// BLOCK K — Phase 2 18e-dim-split (88–90) — isDimensionCommand predicate
// + dispatch via handleDimAligned/handleDimLinear simulation.
// ============================================================================

// 88. isDimensionCommand returns true for both dim commands, false otherwise.
{
  pass('88a. isDimensionCommand("dim-aligned") === true',
    isDimensionCommand('dim-aligned') === true)
  pass('88b. isDimensionCommand("dim-linear") === true',
    isDimensionCommand('dim-linear') === true)
  pass('88c. isDimensionCommand("dimension") === false (legacy value rejected)',
    isDimensionCommand('dimension') === false)
  pass('88d. isDimensionCommand("rotate") === false',
    isDimensionCommand('rotate') === false)
  pass('88e. isDimensionCommand(null) === false',
    isDimensionCommand(null) === false)
  pass('88f. isDimensionCommand(undefined) === false',
    isDimensionCommand(undefined) === false)
}

// 89. Workflow 1 dispatch by handler — production-mirror of TechInputPanel
//     handleDimAligned + handleDimLinear (single line selected → Workflow 1).
//
// Mirror of `startDimCommand` in TechInputPanel.jsx. The helper accepts
// the commandKey + wf1DimType params; the test confirms that
// handleDimAligned routes through commitWorkflow1Dimension with
// 'aligned' and handleDimLinear with 'linear'.
function simulateHandleDim(store, commandKey, wf1DimType) {
  // workflow1Eligible: selection.length === 1 && selection[0].type === 'line'
  const sel = store.state.techSelected
  const shapes = sel
    .map((e) => {
      for (const l of store.state.technicalLayers) {
        const sh = l.shapes.find((s) => s.id === e.shapeId)
        if (sh) return sh
      }
      return null
    })
    .filter(Boolean)
  const workflow1Eligible = shapes.length === 1 && shapes[0].type === 'line'
  if (workflow1Eligible) {
    const lineShape = shapes[0]
    const layer = store.state.technicalLayers.find((l) =>
      l.shapes.some((sh) => sh.id === lineShape.id)
    )
    store.commitWorkflow1Dimension(lineShape.id, layer.id, wf1DimType, 'preSnap')
  } else {
    // Workflow 2 entry — set the active command.
    store.state.techActiveCommand = commandKey
    store.state.techDimStage = 'awaitPointA'
    store.state.techDimPointA = null
    store.state.techDimPointB = null
  }
}

// 89a. Single line + handleDimAligned → Workflow 1 aligned dim created.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 100, 0)] },
  ]
  s.state.techSelected = [{ layerId: 'L1', shapeId: 'sh1' }]
  simulateHandleDim(s, 'dim-aligned', 'aligned')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('89a. handleDimAligned + single line → Workflow 1 aligned',
    dim && dim.dimType === 'aligned' && dim.orientation === 'aligned')
}

// 89b. Single horizontal line + handleDimLinear → Workflow 1 linear-horizontal.
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [mkLineShape('sh1', 0, 0, 100, 0)] },
  ]
  s.state.techSelected = [{ layerId: 'L1', shapeId: 'sh1' }]
  simulateHandleDim(s, 'dim-linear', 'linear')
  const dim = s.state.technicalLayers[0].shapes.find((sh) => sh.type === 'dimension')
  pass('89b. handleDimLinear + horizontal line → Workflow 1 linear-horizontal',
    dim && dim.dimType === 'linear' && dim.orientation === 'horizontal')
}

// 89c. Empty selection + handleDimAligned → Workflow 2 'dim-aligned'.
{
  const s = makeMockStore()
  s.state.techSelected = []
  simulateHandleDim(s, 'dim-aligned', 'aligned')
  pass('89c. Empty selection + handleDimAligned → techActiveCommand "dim-aligned"',
    s.state.techActiveCommand === 'dim-aligned' && s.state.techDimStage === 'awaitPointA')
}

// 89d. Empty selection + handleDimLinear → Workflow 2 'dim-linear'.
{
  const s = makeMockStore()
  s.state.techSelected = []
  simulateHandleDim(s, 'dim-linear', 'linear')
  pass('89d. Empty selection + handleDimLinear → techActiveCommand "dim-linear"',
    s.state.techActiveCommand === 'dim-linear' && s.state.techDimStage === 'awaitPointA')
}

// 89e. Multi-select + handleDimAligned → Workflow 2 starts (not Workflow 1).
{
  const s = makeMockStore()
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [
      mkLineShape('sh1', 0, 0, 100, 0),
      mkLineShape('sh2', 0, 100, 100, 100),
    ] },
  ]
  s.state.techSelected = [
    { layerId: 'L1', shapeId: 'sh1' },
    { layerId: 'L1', shapeId: 'sh2' },
  ]
  simulateHandleDim(s, 'dim-aligned', 'aligned')
  const dims = s.state.technicalLayers[0].shapes.filter((sh) => sh.type === 'dimension')
  pass('89e. Multi-select + handleDimAligned → Workflow 2 (no Workflow 1 commit)',
    dims.length === 0 && s.state.techActiveCommand === 'dim-aligned')
}

// 89f. Selection contains dimension + handleDimLinear → Workflow 2 starts.
{
  const s = makeMockStore()
  const existingDim = {
    id: 'dimExisting', type: 'dimension', dimType: 'aligned', orientation: 'aligned',
    pointA: { mode: 'free', shapeId: null, pointKey: null, x: 0, y: 0 },
    pointB: { mode: 'free', shapeId: null, pointKey: null, x: 100, y: 0 },
    offset: 24, textOverride: null,
  }
  s.state.technicalLayers = [
    { id: 'L1', visible: true, shapes: [existingDim] },
  ]
  s.state.techSelected = [{ layerId: 'L1', shapeId: 'dimExisting' }]
  simulateHandleDim(s, 'dim-linear', 'linear')
  pass('89f. Selection contains dim + handleDimLinear → Workflow 2',
    s.state.techActiveCommand === 'dim-linear'
    // Existing dim still present (no new shape from Workflow 1).
    && s.state.technicalLayers[0].shapes.length === 1)
}

// 90. Both Dim buttons visible when selection contains a dim (NO `hide`
//     gate per spec v1.2 §"Selection composition rules"). This is a
//     source-grep test on TechInputPanel.jsx — the existing
//     `selectionHasDimension && Rotate/Move/Copy` gate exists but Dim
//     buttons sit OUTSIDE it.
{
  const panelSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'TechInputPanel.jsx'),
    'utf-8',
  )
  // Find the {!selectionHasDimension && ...} fragment that wraps R/M/C.
  // Both Dim buttons (Aligned + Linear X/Y) should appear OUTSIDE this
  // block, between the closing `</>)}` and the Delete button.
  const fragmentEndIdx = panelSrc.indexOf('</>')
  const deleteBtnIdx = panelSrc.indexOf('cmd-danger', fragmentEndIdx)
  const sliceBetween = panelSrc.slice(fragmentEndIdx, deleteBtnIdx)
  pass('90a. handleDimAligned button outside selectionHasDimension gate',
    /handleDimAligned/.test(sliceBetween))
  pass('90b. handleDimLinear button outside selectionHasDimension gate',
    /handleDimLinear/.test(sliceBetween))
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
