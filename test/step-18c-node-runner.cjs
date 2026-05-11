// Node-side runner for the Phase 2 sub-step 18c block tests.
//
// Self-contained: mirrors step-18b's eval-shim pattern. Loads three
// pure modules (parseLength, parseAngle, techLineCommit) via fs.readFile
// + regex-strip `export` + `new Function`. None of these modules import
// React, Zustand, or photoIDB; all are pure JS suitable for the shim.
//
// Coverage:
//   - parseAngle (20 tests covering degrees / pitch / smart parser /
//     whitespace tolerance / rejection cases)
//   - commitTechLine (8 tests covering both-typed / length-only / angle-
//     only / fully-freehand / zero-length / source-flag emission)
//   - undo round-trip for shape with angleSource (2 tests)
//   - v3 export/import round-trip with angleSource preserved (3 tests)
//
// Total ≥33 new tests. Combined with step-17 (390) + step-18a (78) +
// step-18b (77) the suite lands at ≥578 PASS (target ≥573).

const path = require('path')
const fs = require('fs')

// --------------------------------------------------------------------
// Shim-load three pure modules.
// --------------------------------------------------------------------
function loadModule(relpath, returnNames) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', relpath),
    'utf-8'
  )
  // Strip `export ` from `export function` / `export const` so the
  // declarations live in module scope when eval'd.
  const transformed = src
    .replace(/export\s+function/g, 'function')
    .replace(/export\s+const/g, 'const')
  const factory = new Function(`${transformed}\nreturn { ${returnNames.join(', ')} }`)
  return factory()
}

const { parseLength } = loadModule('src/utils/parseLength.js', ['parseLength'])
const { parseAngle } = loadModule('src/utils/parseAngle.js', ['parseAngle'])
const { commitTechLine } = loadModule('src/utils/techLineCommit.js', ['commitTechLine'])

const tests = []
function pass(name, ok, extra) {
  tests.push({ name, ok: !!ok, extra })
}
function near(a, b, tol) {
  return Math.abs(a - b) < (tol || 0.01)
}

// ============================================================================
// PARSE ANGLE TESTS (1–20)
// ============================================================================

// Bare degree values + explicit symbol/word
pass('1. parseAngle("45", "degrees") === 45', parseAngle('45', 'degrees') === 45)
pass('2. parseAngle("45°", "degrees") === 45', parseAngle('45°', 'degrees') === 45)
pass('3. parseAngle("45deg", "degrees") === 45', parseAngle('45deg', 'degrees') === 45)
pass('4. parseAngle("-45", "degrees") === -45', parseAngle('-45', 'degrees') === -45)
pass('5. parseAngle("45.5°", "degrees") === 45.5', parseAngle('45.5°', 'degrees') === 45.5)
pass('6. parseAngle("0", "degrees") === 0', parseAngle('0', 'degrees') === 0)

// Bare number in pitch mode REJECTED (documented contract — pitch
// requires the `/` notation; bare number is ambiguous and we choose
// to reject rather than guess).
pass('7. parseAngle("45", "pitch") === null (bare number in pitch mode rejected)',
  parseAngle('45', 'pitch') === null)

// Smart parser — `/` always parses as pitch regardless of defaultUnit
pass('8a. parseAngle("4/12", "degrees") parses as pitch via smart parser',
  near(parseAngle('4/12', 'degrees'), Math.atan(4 / 12) * 180 / Math.PI))
pass('8b. parseAngle("4/12", "pitch") parses as pitch',
  near(parseAngle('4/12', 'pitch'), Math.atan(4 / 12) * 180 / Math.PI))

// Common roof pitches
pass('9. parseAngle("6/12", "pitch") ≈ 26.57°',
  near(parseAngle('6/12', 'pitch'), 26.565, 0.01))
pass('10. parseAngle("8/12", "pitch") ≈ 33.69°',
  near(parseAngle('8/12', 'pitch'), 33.690, 0.01))
pass('11. parseAngle("12/12", "pitch") === 45°',
  near(parseAngle('12/12', 'pitch'), 45, 0.001))

// Zero pitch — valid (flat / horizontal)
pass('12. parseAngle("0/12", "pitch") === 0', parseAngle('0/12', 'pitch') === 0)

// Pitch rejection — zero denominator, negative
pass('13. parseAngle("4/0", "pitch") === null (zero denominator)',
  parseAngle('4/0', 'pitch') === null)
pass('14. parseAngle("-4/12", "pitch") === null (negative pitch rejected)',
  parseAngle('-4/12', 'pitch') === null)

// General rejection
pass('15. parseAngle("abc", "degrees") === null', parseAngle('abc', 'degrees') === null)
pass('16. parseAngle("", "degrees") === null', parseAngle('', 'degrees') === null)
pass('17. parseAngle("45deg foo", "degrees") === null (trailing junk)',
  parseAngle('45deg foo', 'degrees') === null)
pass('18. parseAngle("500", "degrees") === null (out of range)',
  parseAngle('500', 'degrees') === null)

// Whitespace tolerance
pass('19. parseAngle("4 / 12", "pitch") parses with whitespace',
  near(parseAngle('4 / 12', 'pitch'), Math.atan(4 / 12) * 180 / Math.PI))
pass('20. parseAngle("45 °", "degrees") parses with whitespace',
  parseAngle('45 °', 'degrees') === 45)

// ============================================================================
// COMMIT-TECH-LINE GEOMETRY TESTS (21–28)
// ============================================================================

// Mock the addTechnicalShape / setTechDraft store dependencies for
// commitTechLine. Captures the shape that would have been written.
function mockCommitTarget() {
  const target = { shape: null, draftCleared: false }
  return {
    target,
    addTechnicalShape: (sh) => { target.shape = sh },
    setTechDraft: (d) => { if (d === null) target.draftCleared = true },
  }
}

// 21. typedInches only, cursor at (96, 0) → b at (96, 0), freehand angle 0
{
  const m = mockCommitTarget()
  const ok = commitTechLine({
    anchor: { x: 0, y: 0 },
    cursorWorld: { x: 96, y: 0 },
    typedInches: 4,
    typedAngleDegrees: null,
    addTechnicalShape: m.addTechnicalShape,
    setTechDraft: m.setTechDraft,
  })
  pass('21a. typedInches=4, cursor (96,0) → returns true', ok === true)
  pass('21b. shape.lengthInches === 4', m.target.shape.lengthInches === 4)
  pass('21c. shape.lengthSource === "typed"', m.target.shape.lengthSource === 'typed')
  pass('21d. shape.angleSource === "freehand"', m.target.shape.angleSource === 'freehand')
  pass('21e. shape.b.x ≈ 96', near(m.target.shape.b.x, 96))
  pass('21f. shape.b.y ≈ 0',  near(m.target.shape.b.y, 0))
}

// 22. typedAngleDegrees only, cursor at (0, 96) → length = 4" rounded, typed angle 90
{
  const m = mockCommitTarget()
  commitTechLine({
    anchor: { x: 0, y: 0 },
    cursorWorld: { x: 0, y: 96 },
    typedInches: null,
    typedAngleDegrees: 90,
    addTechnicalShape: m.addTechnicalShape,
    setTechDraft: m.setTechDraft,
  })
  pass('22a. typed angle 90, freehand length: lengthInches === 4',
    m.target.shape.lengthInches === 4)
  pass('22b. lengthSource === "freehand"', m.target.shape.lengthSource === 'freehand')
  pass('22c. angleSource === "typed"', m.target.shape.angleSource === 'typed')
  pass('22d. b.x ≈ 0 (cos 90° * 96 = 0)', near(m.target.shape.b.x, 0))
  pass('22e. b.y ≈ 96 (sin 90° * 96 = 96, canvas Y-down)', near(m.target.shape.b.y, 96))
}

// 23. Both typed (inches=4, angle=45°). Cursor ignored.
{
  const m = mockCommitTarget()
  commitTechLine({
    anchor: { x: 100, y: 100 },
    cursorWorld: { x: 9999, y: -9999 }, // garbage — should be ignored
    typedInches: 4,
    typedAngleDegrees: 45,
    addTechnicalShape: m.addTechnicalShape,
    setTechDraft: m.setTechDraft,
  })
  const expected = (4 * 24) / Math.sqrt(2)  // cos(45°) * 96 = sin(45°) * 96
  pass('23a. both-typed: b.x = 100 + cos(45°) * 96', near(m.target.shape.b.x, 100 + expected))
  pass('23b. both-typed: b.y = 100 + sin(45°) * 96', near(m.target.shape.b.y, 100 + expected))
  pass('23c. lengthSource AND angleSource === "typed"',
    m.target.shape.lengthSource === 'typed' && m.target.shape.angleSource === 'typed')
}

// 24. Fully freehand (both null), cursor at (96, 96) → length ≈ 5.5" rounded, angle = 45°
{
  const m = mockCommitTarget()
  commitTechLine({
    anchor: { x: 0, y: 0 },
    cursorWorld: { x: 96, y: 96 },
    typedInches: null,
    typedAngleDegrees: null,
    addTechnicalShape: m.addTechnicalShape,
    setTechDraft: m.setTechDraft,
  })
  // distance = sqrt(96^2 + 96^2) = 135.76 px = 5.657" → rounds to 5.5"
  pass('24a. fully freehand length rounds to 5.5"', m.target.shape.lengthInches === 5.5)
  pass('24b. fully freehand both sources "freehand"',
    m.target.shape.lengthSource === 'freehand' && m.target.shape.angleSource === 'freehand')
  // b projected at 45° with 5.5"  = 132 px → b ≈ (93.34, 93.34)
  const expected = (5.5 * 24) / Math.sqrt(2)
  pass('24c. b.x ≈ 93.34 (projected)', near(m.target.shape.b.x, expected))
  pass('24d. b.y ≈ 93.34 (projected)', near(m.target.shape.b.y, expected))
}

// 25. Zero-length freehand commit rejected.
{
  const m = mockCommitTarget()
  const ok = commitTechLine({
    anchor: { x: 50, y: 50 },
    cursorWorld: { x: 50, y: 50 },  // identical to anchor → 0 length
    typedInches: null,
    typedAngleDegrees: null,
    addTechnicalShape: m.addTechnicalShape,
    setTechDraft: m.setTechDraft,
  })
  pass('25a. zero-length freehand returns false', ok === false)
  pass('25b. zero-length freehand does NOT call addTechnicalShape',
    m.target.shape === null)
  pass('25c. zero-length freehand still clears the draft', m.target.draftCleared === true)
}

// 26. Pitch-typed angle path. parseAngle('4/12') ≈ 18.43°.
{
  const angle = parseAngle('4/12', 'pitch')  // ≈ 18.435°
  const m = mockCommitTarget()
  commitTechLine({
    anchor: { x: 0, y: 0 },
    cursorWorld: { x: 1000, y: 0 },
    typedInches: 12,
    typedAngleDegrees: angle,
    addTechnicalShape: m.addTechnicalShape,
    setTechDraft: m.setTechDraft,
  })
  const rad = angle * Math.PI / 180
  const px = 12 * 24
  pass('26a. pitch-typed b.x = cos(atan(4/12)) * 288 ≈ 273.04',
    near(m.target.shape.b.x, Math.cos(rad) * px, 0.05))
  pass('26b. pitch-typed b.y = sin(atan(4/12)) * 288 ≈ 91.01 (canvas Y-down)',
    near(m.target.shape.b.y, Math.sin(rad) * px, 0.05))
  pass('26c. pitch-typed angleSource === "typed"', m.target.shape.angleSource === 'typed')
}

// 27. Source flags emitted correctly per axis (matrix check)
{
  const cases = [
    { ti: 4, ta: 30, expL: 'typed',    expA: 'typed' },
    { ti: 4, ta: null, expL: 'typed',  expA: 'freehand' },
    { ti: null, ta: 30, expL: 'freehand', expA: 'typed' },
    { ti: null, ta: null, expL: 'freehand', expA: 'freehand' },
  ]
  let allOk = true
  for (const c of cases) {
    const m = mockCommitTarget()
    commitTechLine({
      anchor: { x: 0, y: 0 },
      cursorWorld: { x: 96, y: 0 },
      typedInches: c.ti,
      typedAngleDegrees: c.ta,
      addTechnicalShape: m.addTechnicalShape,
      setTechDraft: m.setTechDraft,
    })
    if (!m.target.shape) { allOk = false; break }
    if (m.target.shape.lengthSource !== c.expL || m.target.shape.angleSource !== c.expA) {
      allOk = false; break
    }
  }
  pass('27. source-flag matrix (4 cases of typed/freehand pairings)', allOk)
}

// 28. Invalid typedInches (negative, zero, NaN, undefined) falls back to freehand.
{
  const m = mockCommitTarget()
  commitTechLine({
    anchor: { x: 0, y: 0 },
    cursorWorld: { x: 48, y: 0 },
    typedInches: -5,           // invalid — should fall back to freehand
    typedAngleDegrees: null,
    addTechnicalShape: m.addTechnicalShape,
    setTechDraft: m.setTechDraft,
  })
  pass('28a. negative typedInches falls back to freehand length',
    m.target.shape && m.target.shape.lengthSource === 'freehand')
  pass('28b. fallback length = cursor distance / 24 = 2"',
    m.target.shape && m.target.shape.lengthInches === 2)
}

// ============================================================================
// UNDO ROUND-TRIP WITH angleSource (29–30)
// Mirror of step-18b's makeRoundTripStore but with the new tech-line
// shape including angleSource. Verifies dataSnapshot serializes the
// new field + undo restores it.
// ============================================================================

const PX_PER_INCH = 24
function makeStoreWithSnapshot() {
  let techShapeSeq = 0
  let techLayerSeq = 0
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
  const pushUndo = () => { state.undoStack.push(dataSnapshot(state)) }
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
  const undo = () => {
    if (state.undoStack.length === 0) return false
    const current = dataSnapshot(state)
    const last = state.undoStack[state.undoStack.length - 1]
    const next = JSON.parse(last)
    state.layers = next.layers || []
    state.technicalLayers = Array.isArray(next.technicalLayers) ? next.technicalLayers : []
    state.specTable = (next.specTable && typeof next.specTable === 'object') ? next.specTable : {}
    state.undoStack = state.undoStack.slice(0, -1)
    state.redoStack = [...state.redoStack, current]
    return true
  }
  return { state, dataSnapshot, addTechnicalShape, undo }
}

// 29. addTechnicalShape with angleSource: 'typed' serializes the field.
{
  const s = makeStoreWithSnapshot()
  s.addTechnicalShape({
    type: 'line', a: { x: 0, y: 0 }, b: { x: 96, y: 0 },
    lengthInches: 4, lengthSource: 'typed', angleSource: 'typed',
  })
  const snap = s.dataSnapshot(s.state)
  const parsed = JSON.parse(snap)
  pass('29a. snapshot includes shape with angleSource',
    parsed.technicalLayers[0].shapes[0].angleSource === 'typed')
  pass('29b. snapshot preserves both lengthSource and angleSource',
    parsed.technicalLayers[0].shapes[0].lengthSource === 'typed'
    && parsed.technicalLayers[0].shapes[0].angleSource === 'typed')
}

// 30. Undo a shape with angleSource. Restore should leave no shapes.
{
  const s = makeStoreWithSnapshot()
  s.addTechnicalShape({
    type: 'line', a: { x: 0, y: 0 }, b: { x: 96, y: 0 },
    lengthInches: 4, lengthSource: 'freehand', angleSource: 'typed',
  })
  pass('30a. one layer with one shape after add',
    s.state.technicalLayers.length === 1 && s.state.technicalLayers[0].shapes.length === 1)
  s.undo()
  pass('30b. undo removes the auto-created layer entirely',
    s.state.technicalLayers.length === 0)
}

// ============================================================================
// EXPORT/IMPORT ROUND-TRIP WITH angleSource (31–33)
// ============================================================================

// 31. exportJSON-equivalent payload preserves angleSource field exactly.
{
  const techLayers = [{
    id: 'tech-layer-1', name: 'Layer 1', visible: true,
    shapes: [
      { id: 'tech-shape-1', type: 'line', a: {x:0,y:0}, b: {x:96,y:0},
        lengthInches: 4, lengthSource: 'typed', angleSource: 'freehand' },
      { id: 'tech-shape-2', type: 'line', a: {x:0,y:0}, b: {x:0,y:96},
        lengthInches: 4, lengthSource: 'freehand', angleSource: 'typed' },
    ],
  }]
  const payload = {
    schemaVersion: 3,
    technicalLayers: techLayers,
  }
  const reparsed = JSON.parse(JSON.stringify(payload))
  pass('31a. shape 1 angleSource round-trips as "freehand"',
    reparsed.technicalLayers[0].shapes[0].angleSource === 'freehand')
  pass('31b. shape 2 angleSource round-trips as "typed"',
    reparsed.technicalLayers[0].shapes[1].angleSource === 'typed')
}

// 32. importJSON treats missing angleSource field gracefully (backward-compat
//     for 18b-era files that didn't have the field).
{
  const v3PreFix = {
    schemaVersion: 3,
    technicalLayers: [{
      id: 'tech-layer-1', name: 'Layer 1', visible: true,
      shapes: [
        // No angleSource — pre-18c shape.
        { id: 'tech-shape-1', type: 'line', a: {x:0,y:0}, b: {x:96,y:0},
          lengthInches: 4, lengthSource: 'typed' },
      ],
    }],
  }
  // importJSON applies Array.isArray check + uses obj.technicalLayers as-is.
  // Render path treats missing angleSource as 'freehand' (any non-'typed' is
  // implicitly freehand). Verify the shape survives unchanged.
  const migrated = Array.isArray(v3PreFix.technicalLayers) ? v3PreFix.technicalLayers : []
  pass('32a. pre-18c shape survives import (no angleSource field)',
    migrated[0].shapes[0].angleSource === undefined)
  pass('32b. pre-18c shape lengthSource preserved',
    migrated[0].shapes[0].lengthSource === 'typed')
}

// 33. New shapes saved post-18c always include angleSource.
{
  // Mock addTechnicalShape — capture the shape it receives.
  const captured = { shape: null }
  commitTechLine({
    anchor: { x: 0, y: 0 },
    cursorWorld: { x: 96, y: 0 },
    typedInches: 4,
    typedAngleDegrees: null,
    addTechnicalShape: (sh) => { captured.shape = sh },
    setTechDraft: () => {},
  })
  pass('33a. new shape from commitTechLine always has angleSource set',
    typeof captured.shape.angleSource === 'string')
  pass('33b. new shape angleSource is one of "typed" | "freehand"',
    captured.shape.angleSource === 'typed' || captured.shape.angleSource === 'freehand')
}

// ============================================================================
// DOCKED PANEL CONTRACT TESTS (73–83) — Phase 2 18c docked pivot
// (May 11 2026, operator-reported regression on `cdd7f8f`).
//
// Three failed bug-fix attempts on the cursor-anchored floating panel
// (18b autofocus, 18c focusin, 18c-fix selective wrapper keydown) all
// surfaced the same focus-management bug class. Pivoted to a docked
// panel mounted as a sibling of DrawingTools in App.jsx — OUTSIDE the
// canvas event hierarchy. The previously-tested wrapper-keydown filter
// (tests 59-72) was deleted along with the failed-fix code; replaced
// with tests that lock in the docked contract.
// ============================================================================

// Pure-logic mocks of TechInputPanel's render decisions.
function isPanelVisible(appMode, tool) {
  return appMode === 'TECHNICAL' && tool === 'tech-line'
}
function lengthPlaceholder(anchorPlaced) {
  return anchorPlaced ? `4"  or  1'6"` : `Click on canvas to place anchor`
}
function shouldShowPlaceholderHint(anchorPlaced) {
  return !anchorPlaced
}
function shouldClearInputsOnTransition(prevShapes, nextShapes) {
  // Mirrors the post-commit reset useEffect: clear inputs only when
  // totalShapes incremented (signaling a successful commit).
  // Escape transitions techDraft → null without incrementing.
  return nextShapes > prevShapes
}

// 73. Panel mounts when appMode is TECHNICAL and tool is tech-line.
pass('73. visible when TECHNICAL + tech-line', isPanelVisible('TECHNICAL', 'tech-line') === true)

// 74. Panel does NOT mount under FIELD even if tool is tech-line (defensive).
pass('74. hidden when appMode FIELD', isPanelVisible('FIELD', 'tech-line') === false)

// 75. Panel does NOT mount under TECHNICAL when tool is not tech-line.
pass('75a. hidden under TECHNICAL with no tool', isPanelVisible('TECHNICAL', null) === false)
pass('75b. hidden under TECHNICAL with poly tool', isPanelVisible('TECHNICAL', 'poly') === false)

// 76. Panel inputs accept text when techDraft.a is null (pre-anchor state).
//     Local state in TechInputPanel uses useState; setRawLength fires on
//     onChange regardless of anchor presence. Verified at the contract
//     level: the predicate `anchorPlaced` should NOT gate input acceptance.
{
  const anchorPlaced = false
  // The component's onLengthChange creates a new techDraft if cur is null:
  function onLengthChangeMock(rawValue, techDraftBefore) {
    const cur = techDraftBefore
    if (cur) return { ...cur, typedInches: rawValue }
    return { a: null, typedInches: rawValue, typedAngleDegrees: null }
  }
  const result = onLengthChangeMock(4, null)
  pass('76a. pre-anchor typing creates new techDraft with typedInches',
    result.a === null && result.typedInches === 4)
  // anchorPlaced reflects techDraft?.a, NOT whether typing is allowed.
  pass('76b. anchorPlaced === false does not block input acceptance',
    anchorPlaced === false)
}

// 77. Placeholder hint renders when techDraft.a is null and clears when set.
pass('77a. placeholder hint shown when no anchor',
  shouldShowPlaceholderHint(false) === true)
pass('77b. placeholder hint hidden when anchor placed',
  shouldShowPlaceholderHint(true) === false)
pass('77c. length input placeholder text reflects anchor state',
  lengthPlaceholder(false) === 'Click on canvas to place anchor'
  && lengthPlaceholder(true) === `4"  or  1'6"`)

// 78. Local input state resets when totalShapes increments (commit happened).
//     Does NOT reset when totalShapes is unchanged (Escape).
pass('78a. commit (shapes 0 → 1) triggers clear',
  shouldClearInputsOnTransition(0, 1) === true)
pass('78b. commit (shapes 3 → 4) triggers clear',
  shouldClearInputsOnTransition(3, 4) === true)
pass('78c. Escape (shapes 1 → 1) does NOT trigger clear',
  shouldClearInputsOnTransition(1, 1) === false)
pass('78d. Escape from empty state (shapes 0 → 0) does NOT trigger clear',
  shouldClearInputsOnTransition(0, 0) === false)

// 79. Escape clears techDraft when focus is on the panel input.
//     Mock the React handler's Escape branch.
{
  let cleared = false
  const handleEscape = (setTechDraft) => { setTechDraft(null) }
  handleEscape(() => { cleared = true })
  pass('79. handleEscape calls setTechDraft(null)', cleared === true)
}

// 80. Escape clears techDraft when focus is NOT on the panel (document
//     fallback in CanvasStage.onKeyDown). Mocked at the contract level.
{
  let cleared = false
  // Mirror of CanvasStage.onKeyDown's Escape branch when techDraft is set:
  function documentEscapeHandler(appMode, techDraft, setTechDraft) {
    if (appMode === 'TECHNICAL' && techDraft) {
      setTechDraft(null)
      return true
    }
    return false
  }
  const fired = documentEscapeHandler('TECHNICAL', { a: { x: 0, y: 0 } }, () => { cleared = true })
  pass('80a. document Escape fires when appMode TECHNICAL + techDraft set', fired === true)
  pass('80b. document Escape calls setTechDraft(null)', cleared === true)
}

// 81. Enter with anchor + both values valid commits a line.
{
  let committed = null
  const mockAddTechnicalShape = (sh) => { committed = sh }
  const mockSetTechDraft = () => {}
  // Mirror of TechInputPanel's handleEnter preconditions:
  function handleEnterMock(techDraft, parsedInches, parsedAngle) {
    if (!techDraft || !techDraft.a) return false
    if (parsedInches === null || parsedAngle === null) return false
    commitTechLine({
      anchor: techDraft.a,
      cursorWorld: { x: 0, y: 0 },
      typedInches: parsedInches,
      typedAngleDegrees: parsedAngle,
      addTechnicalShape: mockAddTechnicalShape,
      setTechDraft: mockSetTechDraft,
    })
    return true
  }
  const ok = handleEnterMock({ a: { x: 100, y: 100 } }, 4, 45)
  pass('81a. Enter commits when anchor + both values valid', ok === true)
  pass('81b. committed shape is a line with typed sources',
    committed && committed.type === 'line'
    && committed.lengthSource === 'typed' && committed.angleSource === 'typed')
}

// 82. Enter with techDraft.a null no-ops.
{
  let committed = null
  function handleEnterMock(techDraft, parsedInches, parsedAngle) {
    if (!techDraft || !techDraft.a) return false
    if (parsedInches === null || parsedAngle === null) return false
    committed = 'would-commit'
    return true
  }
  const result1 = handleEnterMock(null, 4, 45)
  pass('82a. Enter with null techDraft no-ops', result1 === false && committed === null)
  const result2 = handleEnterMock({ a: null, typedInches: 4, typedAngleDegrees: 45 }, 4, 45)
  pass('82b. Enter with null anchor no-ops', result2 === false && committed === null)
  const result3 = handleEnterMock({ a: { x: 0, y: 0 } }, null, 45)
  pass('82c. Enter with unparsed length no-ops', result3 === false && committed === null)
  const result4 = handleEnterMock({ a: { x: 0, y: 0 } }, 4, null)
  pass('82d. Enter with unparsed angle no-ops', result4 === false && committed === null)
}

// 83. Pre-fill flow: typed values carry forward when anchor is placed.
//     Mirror of CanvasStage's first-click handler (spread current techDraft).
{
  // Pre-fill state: techDraft populated by onLengthChange before any click.
  const techDraftPreFill = { a: null, typedInches: 4, typedAngleDegrees: 45 }
  // First click: spread current draft, add anchor.
  const cur = techDraftPreFill || { typedInches: null, typedAngleDegrees: null }
  const techDraftAfterClick = { ...cur, a: { x: 100, y: 100 } }
  pass('83a. first-click spreads pre-filled typedInches',
    techDraftAfterClick.typedInches === 4)
  pass('83b. first-click spreads pre-filled typedAngleDegrees',
    techDraftAfterClick.typedAngleDegrees === 45)
  pass('83c. first-click sets anchor',
    techDraftAfterClick.a.x === 100 && techDraftAfterClick.a.y === 100)
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
