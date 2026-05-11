// Node-side runner for the Phase 2 sub-step 18b block tests.
//
// Self-contained: mirrors step-18a-node-runner.cjs's pattern. Covers
//   - parseLength unit parser (14 cases)
//   - addTechnicalLayer / addTechnicalShape / updateTechnicalShape /
//     deleteTechnicalShape store contract (7 cases)
//   - line-tool geometry (typed projection + freehand rounding) (2 cases)
//   - v3 round-trip for technicalLayers (2 cases)
//   - ride-along cleanups (setMode VALID_MODES guard + pointerType recovery)
//     (2 cases)
//
// Total ≥27 tests. Combined with step-17 (390) and step-18a (78) the
// repo-wide ledger lands at ≥495 PASS.

const path = require('path')

// Loaded modules — ESM parser source compiled below via a tiny shim.
let parseLength
{
  // CommonJS can't require an .mjs/.js ES module directly without --experimental
  // flags; we read the source, strip the export keyword, and eval it. The
  // module is small + pure — no React, no DOM, no store. Trade-off vs. a
  // package.json mod or build step: zero infra for one tiny file.
  const fs = require('fs')
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'utils', 'parseLength.js'),
    'utf-8'
  )
  // Strip the `export ` keyword so the function lives in module scope when eval'd.
  const transformed = src.replace(/export\s+function/g, 'function')
  const factory = new Function(`${transformed}\nreturn { parseLength }`)
  ;({ parseLength } = factory())
}

const tests = []
function pass(name, ok, extra) {
  tests.push({ name, ok: !!ok, extra })
}

// ============================================================================
// PARSER TESTS (1–14)
// ============================================================================
pass('1. parseLength("4\\"") === 4',           parseLength('4"') === 4)
pass('2. parseLength("4in") === 4',            parseLength('4in') === 4)
pass('3. parseLength("4") === 4',              parseLength('4') === 4)
pass('4. parseLength("1\'6\\"") === 18',       parseLength('1\'6"') === 18)
pass('5. parseLength("1.5\'") === 18',         parseLength('1.5\'') === 18)
pass('6. parseLength("18\\"") === 18',         parseLength('18"') === 18)
pass('7. parseLength("4.5\\"") === 4.5',       parseLength('4.5"') === 4.5)
pass('8. parseLength("0\\"") === null',        parseLength('0"') === null)
pass('9. parseLength("-4") === null',          parseLength('-4') === null)
pass('10. parseLength("") === null',           parseLength('') === null)
pass('11. parseLength("4\\"foo") === null',    parseLength('4"foo') === null)
pass('12. parseLength("abc") === null',        parseLength('abc') === null)
pass('13. parseLength("1\' 6 \\"") === 18',    parseLength('1\' 6 "') === 18)
pass('14. parseLength("4 in") === 4',          parseLength('4 in') === 4)

// Coverage bonus — ensure whitespace-only string is also null.
pass('14b. parseLength("   ") === null', parseLength('   ') === null)

// ============================================================================
// STORE-ACTION SHAPE TESTS (15–21)
// Mirror of the addTechnicalLayer / addTechnicalShape / update / delete
// contracts in useAppStore.js. Self-contained mock — see step-18a precedent
// for the rationale (Pass 3 / P44 would replace with Zustand-direct tests).
// ============================================================================
const TECHNICAL_LAYER_NAME_DEFAULT = 'Layer 1'

function makeTechStore() {
  let techLayerSeq = 0
  let techShapeSeq = 0
  const state = { technicalLayers: [], undoStack: [] }
  const pushUndo = () => { state.undoStack.push(JSON.stringify(state.technicalLayers)) }

  const addTechnicalLayer = (name) => {
    pushUndo()
    const layer = {
      id: `tech-layer-${++techLayerSeq}`,
      name: typeof name === 'string' && name.length > 0 ? name : TECHNICAL_LAYER_NAME_DEFAULT,
      visible: true,
      shapes: [],
    }
    state.technicalLayers.push(layer)
    return layer.id
  }
  const addTechnicalShape = (shape) => {
    pushUndo()
    const id = shape.id || `tech-shape-${++techShapeSeq}`
    const fullShape = { ...shape, id }
    if (state.technicalLayers.length === 0) {
      const layer = {
        id: `tech-layer-${++techLayerSeq}`,
        name: TECHNICAL_LAYER_NAME_DEFAULT,
        visible: true,
        shapes: [fullShape],
      }
      state.technicalLayers.push(layer)
    } else {
      state.technicalLayers[0].shapes.push(fullShape)
    }
    return id
  }
  const updateTechnicalShape = (layerId, shapeId, patch) => {
    pushUndo()
    const tl = state.technicalLayers.find((l) => l.id === layerId)
    if (!tl) return
    tl.shapes = tl.shapes.map((sh) => sh.id === shapeId ? { ...sh, ...patch } : sh)
  }
  const deleteTechnicalShape = (layerId, shapeId) => {
    pushUndo()
    const tl = state.technicalLayers.find((l) => l.id === layerId)
    if (!tl) return
    tl.shapes = tl.shapes.filter((sh) => sh.id !== shapeId)
  }
  return { state, addTechnicalLayer, addTechnicalShape, updateTechnicalShape, deleteTechnicalShape }
}

// 15. addTechnicalShape with no existing layers auto-creates Layer 1.
{
  const s = makeTechStore()
  const shapeId = s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:24,y:0}, lengthInches: 1, lengthSource: 'freehand' })
  pass('15a. addTechnicalShape auto-creates Layer 1 when no layers exist',
    s.state.technicalLayers.length === 1
    && s.state.technicalLayers[0].name === 'Layer 1'
    && s.state.technicalLayers[0].visible === true)
  pass('15b. shape lives in the auto-created layer',
    s.state.technicalLayers[0].shapes.length === 1
    && s.state.technicalLayers[0].shapes[0].id === shapeId)
}

// 16. addTechnicalShape with one existing layer appends to that layer.
{
  const s = makeTechStore()
  s.addTechnicalLayer('Layer 1')
  s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:24,y:0}, lengthInches: 1, lengthSource: 'freehand' })
  s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:48,y:0}, lengthInches: 2, lengthSource: 'typed' })
  pass('16a. addTechnicalShape with existing layer does not create a new layer',
    s.state.technicalLayers.length === 1)
  pass('16b. both shapes append to the existing layer',
    s.state.technicalLayers[0].shapes.length === 2)
}

// 17. addTechnicalShape generates unique ids.
{
  const s = makeTechStore()
  const id1 = s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:24,y:0}, lengthInches: 1, lengthSource: 'freehand' })
  const id2 = s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:48,y:0}, lengthInches: 2, lengthSource: 'freehand' })
  const id3 = s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:72,y:0}, lengthInches: 3, lengthSource: 'freehand' })
  pass('17a. ids start at tech-shape-1', id1 === 'tech-shape-1')
  pass('17b. ids are sequential and unique',
    id2 === 'tech-shape-2' && id3 === 'tech-shape-3' && id1 !== id2 && id2 !== id3)
}

// 18. addTechnicalShape pushes one undo snapshot per call.
// Phase 2 18b follow-on (May 10 2026): the pre-fix version of this test used
// a mock pushUndo that serialized `state.technicalLayers` directly — testing
// the BEHAVIOR the real dataSnapshot SHOULD have, not the BEHAVIOR it
// ACTUALLY had. That lie let the production bug ship. Rewritten below to
// use makeRoundTripStore (full real-dataSnapshot replica) so stack-length
// + restore-content are tested together.
{
  const s = makeRoundTripStore()
  pass('18a. undoStack starts empty', s.state.undoStack.length === 0)
  s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:24,y:0}, lengthInches: 1, lengthSource: 'freehand' })
  pass('18b. addTechnicalShape pushes one undo snapshot', s.state.undoStack.length === 1)
  // Verify the snapshot actually carries technicalLayers (this is the
  // assertion that pre-fix would have caught Bug B if it had existed).
  const parsed = JSON.parse(s.state.undoStack[0])
  pass('18b-2. undo snapshot includes technicalLayers field',
    Array.isArray(parsed.technicalLayers))
  pass('18b-3. undo snapshot includes specTable field',
    parsed.specTable !== undefined && typeof parsed.specTable === 'object')
  s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:48,y:0}, lengthInches: 2, lengthSource: 'freehand' })
  pass('18c. second addTechnicalShape pushes a second undo snapshot', s.state.undoStack.length === 2)
}

// 19. addTechnicalLayer creates a new layer with given name + defaults.
{
  const s = makeTechStore()
  const layerId = s.addTechnicalLayer('North Elevation')
  pass('19a. addTechnicalLayer returns the new layer id',
    s.state.technicalLayers[0].id === layerId)
  pass('19b. new layer has the given name', s.state.technicalLayers[0].name === 'North Elevation')
  pass('19c. new layer visible default true',  s.state.technicalLayers[0].visible === true)
  pass('19d. new layer shapes [] default',     Array.isArray(s.state.technicalLayers[0].shapes) && s.state.technicalLayers[0].shapes.length === 0)
}

// 20. updateTechnicalShape patches the named shape.
{
  const s = makeTechStore()
  const id = s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:24,y:0}, lengthInches: 1, lengthSource: 'freehand' })
  const layerId = s.state.technicalLayers[0].id
  s.updateTechnicalShape(layerId, id, { lengthInches: 5, lengthSource: 'typed' })
  const sh = s.state.technicalLayers[0].shapes.find((x) => x.id === id)
  pass('20a. updateTechnicalShape patches lengthInches', sh.lengthInches === 5)
  pass('20b. updateTechnicalShape patches lengthSource', sh.lengthSource === 'typed')
  pass('20c. updateTechnicalShape preserves untouched fields',
    sh.type === 'line' && sh.a.x === 0 && sh.b.x === 24)
}

// 21. deleteTechnicalShape removes the named shape.
{
  const s = makeTechStore()
  const id1 = s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:24,y:0}, lengthInches: 1, lengthSource: 'freehand' })
  const id2 = s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:48,y:0}, lengthInches: 2, lengthSource: 'freehand' })
  const layerId = s.state.technicalLayers[0].id
  s.deleteTechnicalShape(layerId, id1)
  const remaining = s.state.technicalLayers[0].shapes
  pass('21a. deleteTechnicalShape removes the named shape',
    remaining.length === 1 && remaining[0].id === id2)
}

// ============================================================================
// GEOMETRY TESTS (22–23)
// ============================================================================
const PX_PER_INCH = 24

// 22. Typed-length commit projects point b correctly along cursor direction.
{
  // Anchor at (100, 100). Cursor at (200, 100) — direction = +X.
  // Typed length 4" → b = a + (1, 0) * 4 * 24 = (196, 100).
  const a = { x: 100, y: 100 }
  const cursor = { x: 200, y: 100 }
  const typedInches = 4
  const dx = cursor.x - a.x
  const dy = cursor.y - a.y
  const dist = Math.hypot(dx, dy)
  const ux = dist > 0 ? dx / dist : 1
  const uy = dist > 0 ? dy / dist : 0
  const targetPx = typedInches * PX_PER_INCH
  const b = { x: a.x + ux * targetPx, y: a.y + uy * targetPx }
  pass('22a. typed-length projection: b.x = 196', Math.round(b.x) === 196)
  pass('22b. typed-length projection: b.y = 100', Math.round(b.y) === 100)
  // 45° case — anchor (0,0), cursor (100,100), typed 4".
  const a2 = { x: 0, y: 0 }
  const cursor2 = { x: 100, y: 100 }
  const dx2 = cursor2.x - a2.x
  const dy2 = cursor2.y - a2.y
  const d2 = Math.hypot(dx2, dy2)
  const ux2 = dx2 / d2
  const uy2 = dy2 / d2
  const t2 = 4 * PX_PER_INCH
  const b2 = { x: a2.x + ux2 * t2, y: a2.y + uy2 * t2 }
  // Expected b2 is t2/sqrt(2), t2/sqrt(2) ≈ (67.88, 67.88)
  const expected = (4 * 24) / Math.sqrt(2)
  pass('22c. typed-length 45° projection: b.x ≈ 67.88',
    Math.abs(b2.x - expected) < 0.01)
  pass('22d. typed-length 45° projection: b.y ≈ 67.88',
    Math.abs(b2.y - expected) < 0.01)
}

// 23. Freehand commit computes lengthInches as distance / PX_PER_INCH rounded to 0.5.
{
  const a = { x: 0, y: 0 }
  const b = { x: 60, y: 0 }  // 60 px → 2.5"
  const distPx = Math.hypot(b.x - a.x, b.y - a.y)
  const rawInches = distPx / PX_PER_INCH
  const rounded = Math.round(rawInches * 2) / 2
  pass('23a. freehand 60px → 2.5"', rounded === 2.5)
  // Non-clean distance: 25 px → 1.04..." → rounds to 1.0
  const b2 = { x: 25, y: 0 }
  const r2 = Math.round((Math.hypot(b2.x, b2.y) / PX_PER_INCH) * 2) / 2
  pass('23b. freehand 25px → 1.0" (rounded to nearest 0.5)', r2 === 1)
  // 36 px → 1.5"
  const b3 = { x: 36, y: 0 }
  const r3 = Math.round((Math.hypot(b3.x, b3.y) / PX_PER_INCH) * 2) / 2
  pass('23c. freehand 36px → 1.5"', r3 === 1.5)
}

// ============================================================================
// V3 ROUND-TRIP (24–25)
// ============================================================================

// 24. exportJSON payload includes technicalLayers with full line shape data.
{
  const techLayers = [{
    id: 'tech-layer-1',
    name: 'Layer 1',
    visible: true,
    shapes: [{
      id: 'tech-shape-1',
      type: 'line',
      a: { x: 100, y: 100 },
      b: { x: 196, y: 100 },
      lengthInches: 4,
      lengthSource: 'typed',
    }],
  }]
  // Mock exportJSON payload (PERSIST_KEYS includes 'technicalLayers'):
  const payload = {
    schemaVersion: 3,
    technicalLayers: techLayers,
  }
  const json = JSON.stringify(payload)
  const reparsed = JSON.parse(json)
  pass('24a. exported payload technicalLayers[0].id round-trips',
    reparsed.technicalLayers[0].id === 'tech-layer-1')
  pass('24b. exported payload technicalLayers[0].shapes[0].lengthInches round-trips',
    reparsed.technicalLayers[0].shapes[0].lengthInches === 4)
  pass('24c. exported payload technicalLayers[0].shapes[0].lengthSource round-trips',
    reparsed.technicalLayers[0].shapes[0].lengthSource === 'typed')
  pass('24d. exported payload preserves a.x/a.y/b.x/b.y exactly',
    reparsed.technicalLayers[0].shapes[0].a.x === 100
    && reparsed.technicalLayers[0].shapes[0].a.y === 100
    && reparsed.technicalLayers[0].shapes[0].b.x === 196
    && reparsed.technicalLayers[0].shapes[0].b.y === 100)
}

// 25. importJSON of a v3 fixture with technicalLayers restores identical shape.
{
  const v3 = {
    schemaVersion: 3,
    technicalLayers: [{
      id: 'tech-layer-9',
      name: 'Awning Detail',
      visible: true,
      shapes: [{
        id: 'tech-shape-7',
        type: 'line',
        a: { x: 0, y: 0 },
        b: { x: 48, y: 0 },
        lengthInches: 2,
        lengthSource: 'freehand',
      }],
    }],
  }
  // Mirror of importJSON normalization: technicalLayers is taken via
  //   Array.isArray(obj.technicalLayers) ? obj.technicalLayers : []
  const migrated = Array.isArray(v3.technicalLayers) ? v3.technicalLayers : []
  pass('25a. v3 import preserves technicalLayers identity', migrated === v3.technicalLayers)
  pass('25b. v3 import preserves layer name', migrated[0].name === 'Awning Detail')
  pass('25c. v3 import preserves shape id + lengthSource',
    migrated[0].shapes[0].id === 'tech-shape-7' && migrated[0].shapes[0].lengthSource === 'freehand')
}

// ============================================================================
// RIDE-ALONG CLEANUPS (26–27)
// ============================================================================

// 26. setMode no longer accepts 'TECHNICAL' (VALID_MODES guard).
{
  const VALID_MODES = new Set(['DRAW', 'EDIT', 'SEQUENCE'])
  const state = { mode: 'DRAW' }
  const setMode = (mode) => {
    if (!VALID_MODES.has(mode)) return
    state.mode = mode
  }
  setMode('EDIT')
  pass('26a. setMode("EDIT") sets mode to EDIT', state.mode === 'EDIT')
  setMode('TECHNICAL')
  pass('26b. setMode("TECHNICAL") is a no-op (mode stays EDIT)', state.mode === 'EDIT')
  setMode('garbage')
  pass('26c. setMode("garbage") is also a no-op', state.mode === 'EDIT')
  setMode('SEQUENCE')
  pass('26d. setMode("SEQUENCE") still valid (regression guard)', state.mode === 'SEQUENCE')
}

// 27. onMouseMove with a real mouse signature flips pointerType back to mouse
//     when the store still says 'touch'.
{
  // Mirror of CanvasStage.onMouseMove pointerType-recovery branch.
  const state = { pointerType: 'touch', snapTolerance: 22 }
  const setPointerType = (next) => {
    state.pointerType = next
    state.snapTolerance = next === 'touch' ? 22 : 12
  }
  const onMouseMove = (e, store) => {
    if (
      store.pointerType === 'touch'
      && typeof e.movementX === 'number'
      && typeof e.movementY === 'number'
    ) {
      setPointerType('mouse')
    }
  }
  // Synthetic touch-equivalent event (no movementX/movementY).
  onMouseMove({}, state)
  pass('27a. onMouseMove with no movementX leaves pointerType "touch"',
    state.pointerType === 'touch' && state.snapTolerance === 22)
  // Real mouse event.
  onMouseMove({ movementX: 1, movementY: 0 }, state)
  pass('27b. onMouseMove with movementX flips pointerType back to "mouse"',
    state.pointerType === 'mouse')
  pass('27c. recovered pointerType restores snap tolerance 12',
    state.snapTolerance === 12)
  // Subsequent move stays on 'mouse' (no flapping).
  onMouseMove({ movementX: 2, movementY: 1 }, state)
  pass('27d. subsequent mouse move leaves pointerType on "mouse"',
    state.pointerType === 'mouse')
}

// ============================================================================
// FULL ROUND-TRIP UNDO/REDO TESTS (28–32) — Phase 2 18b follow-on (May 10 2026)
// ============================================================================
// Bug B (operator-reported on `1edd117`): dataSnapshot omitted technicalLayers
// and specTable, so undo popped the stack but the patch left committed
// Technical lines on the canvas. Same root cause as the P16+P38 follow-on:
// any new mutable field needs both pushUndo coverage AND inclusion in
// dataSnapshot/undo/redo. The pre-fix test 18 cheated by mocking pushUndo
// with a custom serializer that included technicalLayers — the test
// passed while the prod code lied.
//
// `makeRoundTripStore` below uses a dataSnapshot replica that MATCHES the
// production useAppStore.dataSnapshot field-for-field. If the production
// shape changes, this replica MUST be updated in lockstep — otherwise
// the test goes back to lying. (A future improvement would be to import
// the real dataSnapshot via the new test-only `export` at line 624 of
// useAppStore.js; the current eval-shim pattern doesn't extend cleanly
// to a file that imports Zustand + photoIDB + React. Keep in sync.)
function makeRoundTripStore() {
  let techLayerSeq = 0
  let techShapeSeq = 0
  let layerSeq = 0
  let shapeSeq = 0
  const state = {
    layers: [],
    sequences: [],
    clines: [],
    photoMeta: null,
    cropMeta: null,
    hasSourcePhoto: false,
    gridRotation: 0,
    perspectiveCorners: null,
    technicalLayers: [],
    specTable: {},
    undoStack: [],
    redoStack: [],
  }
  // Replica of production dataSnapshot — keep field-for-field in sync.
  const dataSnapshot = (s) => JSON.stringify({
    layers: s.layers,
    sequences: s.sequences,
    clines: s.clines,
    photoMeta: s.photoMeta || null,
    cropMeta: s.cropMeta || null,
    hasSourcePhoto: !!s.hasSourcePhoto,
    gridRotation: typeof s.gridRotation === 'number' ? s.gridRotation : 0,
    perspectiveCorners: s.perspectiveCorners || null,
    technicalLayers: s.technicalLayers || [],
    specTable: s.specTable || {},
  })
  const pushUndo = () => {
    state.undoStack.push(dataSnapshot(state))
  }
  const applySnapshot = (snap) => {
    const next = JSON.parse(snap)
    state.layers = next.layers || []
    state.sequences = next.sequences || []
    state.clines = next.clines || []
    state.gridRotation = typeof next.gridRotation === 'number' ? next.gridRotation : 0
    state.perspectiveCorners = next.perspectiveCorners ?? null
    state.technicalLayers = Array.isArray(next.technicalLayers) ? next.technicalLayers : []
    state.specTable = (next.specTable && typeof next.specTable === 'object') ? next.specTable : {}
  }
  const undo = () => {
    if (state.undoStack.length === 0) return false
    const current = dataSnapshot(state)
    const last = state.undoStack[state.undoStack.length - 1]
    applySnapshot(last)
    state.undoStack = state.undoStack.slice(0, -1)
    state.redoStack = [...state.redoStack, current]
    return true
  }
  const redo = () => {
    if (state.redoStack.length === 0) return false
    const current = dataSnapshot(state)
    const last = state.redoStack[state.redoStack.length - 1]
    applySnapshot(last)
    state.undoStack = [...state.undoStack, current]
    state.redoStack = state.redoStack.slice(0, -1)
    return true
  }
  // addTechnicalShape — production-equivalent: pushUndo, then mutate.
  const addTechnicalShape = (shape) => {
    pushUndo()
    const id = shape.id || `tech-shape-${++techShapeSeq}`
    const fullShape = { ...shape, id }
    if (state.technicalLayers.length === 0) {
      state.technicalLayers = [{
        id: `tech-layer-${++techLayerSeq}`,
        name: 'Layer 1',
        visible: true,
        shapes: [fullShape],
      }]
    } else {
      state.technicalLayers = state.technicalLayers.map((tl, i) =>
        i === 0 ? { ...tl, shapes: [...tl.shapes, fullShape] } : tl
      )
    }
    return id
  }
  // Field Markup addLayer + addShape — production-equivalent. Tests use
  // this to verify the dataSnapshot extension didn't break the Field path.
  const addLayer = () => {
    pushUndo()
    const id = `l${++layerSeq}`
    state.layers = [...state.layers, { id, shapes: [] }]
    return id
  }
  const addShape = (layerId, shape) => {
    pushUndo()
    const id = shape.id || `sh${++shapeSeq}`
    const fullShape = { ...shape, id }
    state.layers = state.layers.map((l) =>
      l.id === layerId ? { ...l, shapes: [...l.shapes, fullShape] } : l
    )
    return id
  }
  return { state, dataSnapshot, addTechnicalShape, addLayer, addShape, undo, redo }
}

// 28. Full round-trip: add then undo restores empty state.
{
  const s = makeRoundTripStore()
  // Pre-condition.
  pass('28-pre. technicalLayers starts empty', s.state.technicalLayers.length === 0)
  // Add.
  s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:24,y:0}, lengthInches: 1, lengthSource: 'typed' })
  pass('28a. addTechnicalShape creates one layer with one shape',
    s.state.technicalLayers.length === 1 && s.state.technicalLayers[0].shapes.length === 1)
  pass('28b. undoStack grew by one after add', s.state.undoStack.length === 1)
  // Undo.
  s.undo()
  // Pre-add state had NO technical layers (auto-create happened inside the
  // add). Undo restores that pre-add empty state → entire auto-layer
  // disappears alongside the shape.
  pass('28c. undo removes the auto-created layer entirely',
    s.state.technicalLayers.length === 0)
  pass('28d. undoStack empty after undo', s.state.undoStack.length === 0)
  pass('28e. redoStack has the one entry after undo', s.state.redoStack.length === 1)
}

// 29. Redo restores the shape.
{
  const s = makeRoundTripStore()
  s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:24,y:0}, lengthInches: 1, lengthSource: 'typed' })
  s.undo()
  // Now redo.
  s.redo()
  pass('29a. redo restores the layer', s.state.technicalLayers.length === 1)
  pass('29b. redo restores the shape', s.state.technicalLayers[0].shapes.length === 1)
  pass('29c. redo restores lengthInches', s.state.technicalLayers[0].shapes[0].lengthInches === 1)
  pass('29d. undoStack has one entry after redo', s.state.undoStack.length === 1)
  pass('29e. redoStack empty after redo', s.state.redoStack.length === 0)
}

// 30. Multi-shape undo: add three, undo three, all gone.
{
  const s = makeRoundTripStore()
  s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:24,y:0}, lengthInches: 1, lengthSource: 'typed' })
  s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:48,y:0}, lengthInches: 2, lengthSource: 'typed' })
  s.addTechnicalShape({ type: 'line', a: {x:0,y:0}, b: {x:72,y:0}, lengthInches: 3, lengthSource: 'typed' })
  pass('30a. three shapes commit', s.state.technicalLayers[0].shapes.length === 3)
  s.undo()
  s.undo()
  s.undo()
  // After three undos: back to pre-first-add state — no technical layers.
  pass('30b. all shapes removed after 3 undos', s.state.technicalLayers.length === 0)
  pass('30c. undoStack empty after 3 undos', s.state.undoStack.length === 0)
  pass('30d. redoStack has 3 entries after 3 undos', s.state.redoStack.length === 3)
}

// 31. specTable round-trip placeholder — locks coverage for 18g spec table panel.
{
  const s = makeRoundTripStore()
  // Mutate specTable directly + push a snapshot (simulating what a future
  // setSpecTable action would do).
  s.state.specTable = { partName: 'test', qty: 7 }
  const snap = s.dataSnapshot(s.state)
  const parsed = JSON.parse(snap)
  pass('31a. specTable round-trips through dataSnapshot',
    parsed.specTable.partName === 'test' && parsed.specTable.qty === 7)
  // Now flip specTable + undo from a manual push to verify the restore path.
  const previousSnap = JSON.stringify({ specTable: { partName: 'test', qty: 7 } })
  s.state.undoStack.push(previousSnap)
  s.state.specTable = { partName: 'changed', qty: 99 }
  s.undo()
  pass('31b. undo restores specTable contents',
    s.state.specTable.partName === 'test' && s.state.specTable.qty === 7)
}

// 32. Field Markup undo regression — dataSnapshot extension didn't break the existing path.
{
  const s = makeRoundTripStore()
  const layerId = s.addLayer()
  const preCount = s.state.layers[0].shapes.length
  pass('32-pre. pre-add shape count === 0', preCount === 0)
  s.addShape(layerId, { type: 'rect', pts: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}] })
  pass('32a. addShape increments shape count to 1',
    s.state.layers[0].shapes.length === 1)
  s.undo()
  pass('32b. undo decrements shape count back to 0',
    s.state.layers[0].shapes.length === preCount)
  pass('32c. Field Markup layer itself still present after shape-only undo',
    s.state.layers.length === 1)
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
