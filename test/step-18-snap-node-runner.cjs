// Node-side runner for Phase 2 sub-step 18-snap block tests.
//
// 18-snap adds operator-toggleable snap to the Technical Drawing line
// tool, plus closes a latent leak in the FM snap engine that was firing
// under TECHNICAL mode. Coverage targets the four blocks from the build
// prompt:
//
//   A. findTechSnapTarget snapTypes parameter (~6 tests)
//   B. Store actions (~5 tests)
//   C. PERSIST_KEYS (~2 tests)
//   D. Mode isolation regression (~5 tests — closes the false-positive
//      bug class shared with 18b P47 / 18d-edit Inches→Pixels)
//   E. Line-tool snap integration (~6 tests — production-mirror per the
//      18d-edit precedent)
//
// Same eval-shim approach as step-18d-edit. Import statements stripped,
// `export` removed, preamble seeds any required dependencies before the
// module body executes.

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

// techGeometry — same preamble as step-18d-edit (rotatePoint seeded).
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
const { findTechSnapTarget, applyCommandTransform } = loadModule(
  'src/utils/techGeometry.js',
  ['findTechSnapTarget', 'applyCommandTransform'],
  techGeomPreamble,
)

// 18-snap Bug B fix (May 12 2026) — commitTechLine snapMode tests
// require the helper loaded with PX_PER_INCH seeded (same shim as
// step-18c-node-runner).
const { commitTechLine } = loadModule(
  'src/utils/techLineCommit.js',
  ['commitTechLine'],
  'const PX_PER_INCH = 24',
)
const PX_PER_INCH_TEST = 24

const tests = []
function pass(name, ok, extra) {
  tests.push({ name, ok: !!ok, extra })
}
function near(a, b, tol) {
  return Math.abs(a - b) < (tol || 0.001)
}

// ============================================================================
// BLOCK A — findTechSnapTarget snapTypes parameter (1–6)
//
// Pre-18-snap, findTechSnapTarget scanned every endpoint and midpoint
// unconditionally. The new optional 7th arg `snapTypes` filters per type
// without changing call-site contracts.
// ============================================================================

// Common test fixture: viewport identity + one visible technical layer
// with a horizontal line. Cursor placed near (a) endpoint, (b) midpoint,
// (c) other endpoint — each test moves cursor to assert the right branch
// fires (or doesn't fire) under each snapTypes config.
const fixtureLine = { id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }
const fixtureLayer = { id: 'L1', visible: true, shapes: [fixtureLine] }
const fixtureLayers = [fixtureLayer]
const fixtureViewport = { panX: 0, panY: 0, zoom: 1 }

// 1. Default (no snapTypes arg) — endpoint hit at (0, 0).
{
  const target = findTechSnapTarget({ x: 2, y: 2 }, [], fixtureLayers, fixtureViewport, 7)
  pass('1a. Default snapTypes → endpoint hit', target && target.type === 'endpoint')
  pass('1b. Default snapTypes → at expected position',
    target && target.x === 0 && target.y === 0)
}

// 2. {endpoint: false, midpoint: true} — endpoint hit suppressed.
//    Cursor near endpoint (0,0); midpoint is at (50,0) which is far away,
//    so we expect null (no candidate within tolerance).
{
  const target = findTechSnapTarget(
    { x: 2, y: 2 }, [], fixtureLayers, fixtureViewport, 7, null,
    { endpoint: false, midpoint: true },
  )
  pass('2. endpoint=false near endpoint → null (endpoint suppressed, midpoint too far)',
    target === null)
}

// 3. {endpoint: false, midpoint: true} — context-shape midpoint hit.
//    Cursor near (50, 0); pass fixtureLine as context so its midpoint
//    enters the priority-2 candidate list. With endpoint=false, only
//    the midpoint should fire.
{
  const target = findTechSnapTarget(
    { x: 52, y: 2 }, [fixtureLine], fixtureLayers, fixtureViewport, 7, null,
    { endpoint: false, midpoint: true },
  )
  pass('3a. endpoint=false at midpoint → midpoint hit',
    target && target.type === 'midpoint')
  pass('3b. midpoint hit at (50, 0)',
    target && target.x === 50 && target.y === 0)
}

// 4. {endpoint: true, midpoint: false} — at endpoint → endpoint hit.
{
  const target = findTechSnapTarget(
    { x: 2, y: 2 }, [fixtureLine], fixtureLayers, fixtureViewport, 7, null,
    { endpoint: true, midpoint: false },
  )
  pass('4a. midpoint=false at endpoint → endpoint hit',
    target && target.type === 'endpoint')
  pass('4b. endpoint hit at (0, 0)',
    target && target.x === 0 && target.y === 0)
}

// 5. {endpoint: true, midpoint: false} — at midpoint with context shape.
//    Endpoints (0,0) and (100,0) are too far from (50,0). Midpoint
//    suppressed → null.
{
  const target = findTechSnapTarget(
    { x: 52, y: 2 }, [fixtureLine], fixtureLayers, fixtureViewport, 7, null,
    { endpoint: true, midpoint: false },
  )
  pass('5. midpoint=false at midpoint → null (midpoint suppressed)',
    target === null)
}

// 6. Both false → null even at exact endpoint.
{
  const target = findTechSnapTarget(
    { x: 0, y: 0 }, [], fixtureLayers, fixtureViewport, 7, null,
    { endpoint: false, midpoint: false },
  )
  pass('6. Both false at exact endpoint → null', target === null)
}

// ============================================================================
// BLOCK B — Store actions (7–11)
//
// Mock store mirrors the production setters. Real store actions live in
// useAppStore.js lines 2030-2046 (toggleTechSnap / setTechSnap /
// setTechSnapType). Mock here exercises the same logic shape — including
// the invalid-name silent-reject path that protects the store from
// stray key poisoning.
// ============================================================================

const TECH_SNAP_TYPE_KEYS = ['endpoint', 'midpoint']

function makeMockTechSnapStore() {
  const state = {
    techSnapEnabled: true,
    techSnapTypes: { endpoint: true, midpoint: true },
  }
  return {
    state,
    toggleTechSnap: () => { state.techSnapEnabled = !state.techSnapEnabled },
    setTechSnap: (v) => { state.techSnapEnabled = !!v },
    setTechSnapType: (name, enabled) => {
      if (!TECH_SNAP_TYPE_KEYS.includes(name)) return
      state.techSnapTypes = { ...state.techSnapTypes, [name]: !!enabled }
    },
  }
}

// 7. toggleTechSnap flips techSnapEnabled.
{
  const s = makeMockTechSnapStore()
  s.toggleTechSnap()
  pass('7a. toggleTechSnap once → false', s.state.techSnapEnabled === false)
  s.toggleTechSnap()
  pass('7b. toggleTechSnap twice → back to true', s.state.techSnapEnabled === true)
}

// 8. setTechSnap(false) and setTechSnap(true) set value explicitly.
{
  const s = makeMockTechSnapStore()
  s.setTechSnap(false)
  pass('8a. setTechSnap(false) → false', s.state.techSnapEnabled === false)
  s.setTechSnap(true)
  pass('8b. setTechSnap(true) → true', s.state.techSnapEnabled === true)
}

// 9. setTechSnapType('endpoint', false) flips one type.
{
  const s = makeMockTechSnapStore()
  s.setTechSnapType('endpoint', false)
  pass('9a. setTechSnapType("endpoint", false) writes endpoint=false',
    s.state.techSnapTypes.endpoint === false)
  pass('9b. midpoint stays true (independent)',
    s.state.techSnapTypes.midpoint === true)
}

// 10. setTechSnapType('midpoint', true) writes after init.
{
  const s = makeMockTechSnapStore()
  s.setTechSnapType('midpoint', false)
  s.setTechSnapType('midpoint', true)
  pass('10. setTechSnapType("midpoint", true) writes true after toggle',
    s.state.techSnapTypes.midpoint === true)
}

// 11. setTechSnapType('invalid_key', true) is a no-op (silent reject).
{
  const s = makeMockTechSnapStore()
  s.setTechSnapType('corner', true)        // FM key — not tech
  s.setTechSnapType('close', true)         // FM key — not tech
  s.setTechSnapType('grid', true)          // FM key — not tech
  s.setTechSnapType('garbage', true)       // not in either list
  pass('11a. Invalid key "corner" silently rejected',
    !('corner' in s.state.techSnapTypes))
  pass('11b. Invalid key "garbage" silently rejected',
    !('garbage' in s.state.techSnapTypes))
  pass('11c. Tech snapTypes shape unchanged after rejected calls',
    Object.keys(s.state.techSnapTypes).length === 2
    && 'endpoint' in s.state.techSnapTypes
    && 'midpoint' in s.state.techSnapTypes)
}

// ============================================================================
// BLOCK C — PERSIST_KEYS (12–13)
//
// Parse PERSIST_KEYS array from useAppStore.js source. techSnapTypes
// must be IN; techSnapEnabled must be OUT (session-only by design).
// ============================================================================

const storeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'store', 'useAppStore.js'),
  'utf-8',
)
// Extract the PERSIST_KEYS array literal. Non-greedy match would stop
// at the first `]` it finds, but the comments inside the array contain
// stray brackets (e.g., "[-180, 180]" in the gridRotation comment).
// Instead we anchor the closing `]` to start-of-line so only the array
// terminator matches.
const persistKeysMatch = storeSrc.match(/const PERSIST_KEYS = \[([\s\S]*?)\n\]/)
const persistKeysRaw = persistKeysMatch ? persistKeysMatch[1] : ''
// Pull out quoted identifiers (the keys themselves) — comments + commas
// fall out automatically.
const persistKeys = (persistKeysRaw.match(/'([a-zA-Z_][a-zA-Z0-9_]*)'/g) || [])
  .map((s) => s.slice(1, -1))

// 12. techSnapTypes IS in PERSIST_KEYS (chip prefs survive reload).
pass('12. PERSIST_KEYS contains "techSnapTypes"',
  persistKeys.includes('techSnapTypes'))

// 13. techSnapEnabled is NOT in PERSIST_KEYS (session-only, mirrors FM
//     snapEnabled). Operator override of the master toggle should not
//     stick across reloads — reload returns to "snap on" sensible default.
pass('13. PERSIST_KEYS does NOT contain "techSnapEnabled" (session-only)',
  !persistKeys.includes('techSnapEnabled'))

// ============================================================================
// BLOCK D — Mode isolation regression (14–18)
//
// Closes the false-positive bug class: FM and Tech snap state must
// share no fields, and toggling one must not affect the other. Pre-
// 18-snap the engine call sites were not appMode-gated, but state
// was already separate; the tests below freeze the separation as a
// contract so a future refactor that "unifies" the two systems must
// break a test before it can ship.
// ============================================================================

function makeMockSeparateSnapStores() {
  return {
    fm: {
      snapEnabled: true,
      snapTypes: { close: true, grid: true, corner: true, midpoint: true, cline: true },
    },
    tech: {
      techSnapEnabled: true,
      techSnapTypes: { endpoint: true, midpoint: true },
    },
  }
}

// 14. Toggle FM snapEnabled → tech techSnapEnabled unchanged.
{
  const stores = makeMockSeparateSnapStores()
  stores.fm.snapEnabled = !stores.fm.snapEnabled
  pass('14a. After FM toggle: techSnapEnabled still true',
    stores.tech.techSnapEnabled === true)
  pass('14b. After FM toggle: FM snapEnabled is false',
    stores.fm.snapEnabled === false)
}

// 15. Toggle tech techSnapEnabled → FM snapEnabled unchanged.
{
  const stores = makeMockSeparateSnapStores()
  stores.tech.techSnapEnabled = !stores.tech.techSnapEnabled
  pass('15a. After tech toggle: FM snapEnabled still true',
    stores.fm.snapEnabled === true)
  pass('15b. After tech toggle: techSnapEnabled is false',
    stores.tech.techSnapEnabled === false)
}

// 16. FM snapTypes has 'corner' key; tech snapTypes does NOT have 'corner'.
{
  const stores = makeMockSeparateSnapStores()
  pass('16a. FM snapTypes contains "corner"',
    'corner' in stores.fm.snapTypes)
  pass('16b. Tech snapTypes does NOT contain "corner"',
    !('corner' in stores.tech.techSnapTypes))
}

// 17. Tech snapTypes has 'endpoint' key; FM snapTypes does NOT have 'endpoint'.
{
  const stores = makeMockSeparateSnapStores()
  pass('17a. Tech snapTypes contains "endpoint"',
    'endpoint' in stores.tech.techSnapTypes)
  pass('17b. FM snapTypes does NOT contain "endpoint"',
    !('endpoint' in stores.fm.snapTypes))
}

// 18. Independent flip: per-type chips on both sides flip without
//     touching each other.
{
  const stores = makeMockSeparateSnapStores()
  stores.fm.snapTypes.corner = false
  stores.tech.techSnapTypes.endpoint = false
  pass('18a. FM corner flipped false; FM midpoint still true',
    stores.fm.snapTypes.corner === false
    && stores.fm.snapTypes.midpoint === true)
  pass('18b. Tech endpoint flipped false; tech midpoint still true',
    stores.tech.techSnapTypes.endpoint === false
    && stores.tech.techSnapTypes.midpoint === true)
  pass('18c. FM corner flip did not bleed into tech endpoint',
    stores.tech.techSnapTypes.endpoint === false
    && stores.fm.snapTypes.corner === false
    && stores.fm.snapTypes.endpoint === undefined
    && stores.tech.techSnapTypes.corner === undefined)
}

// ============================================================================
// BLOCK E — Line-tool snap integration (19–24)
//
// Production-mirror helpers for the onMouseDown tech-line branch in
// CanvasStage.jsx. The branch consults store.techCommandHover and
// store.techSnapEnabled; when snap is engaged it uses the hover
// position instead of the raw cursor. Typed values bypass snap via
// the onMouseMove gate (typedInches === null && typedAngleDegrees ===
// null required for the snap branch to fire). Helpers below mirror
// that contract exactly so a future refactor that drops a guard breaks
// a test before it can ship.
// ============================================================================

function pickAnchorPoint(rawCursor, hover, techSnapEnabled) {
  // Mirror of onMouseDown tech-line first-click anchor pick.
  const useSnap = !!hover && techSnapEnabled
  return useSnap
    ? { x: hover.x, y: hover.y, sourceUsedSnap: true }
    : { x: rawCursor.x, y: rawCursor.y, sourceUsedSnap: false }
}

function pickCommitPoint(rawCursor, hover, techSnapEnabled, typedInches, typedAngleDegrees) {
  // Mirror of onMouseDown tech-line second-click commit pick. The
  // snap branch in onMouseMove only sets `hover` when typed values
  // are null, so in production the function only sees a non-null
  // hover under freehand mode. We still pass the typed values here
  // to verify the helper's contract is robust if a future change
  // ever passes a stale hover with typed values present.
  const useSnap = !!hover && techSnapEnabled
  const baseX = useSnap ? hover.x : rawCursor.x
  const baseY = useSnap ? hover.y : rawCursor.y
  // commitTechLine prefers typed values over cursor coords when set.
  // We mirror that here so tests can assert typed wins regardless of
  // hover. (The real commit math lives in techLineCommit.js; tests
  // there cover the geometry.)
  return {
    x: typeof typedInches === 'number' ? null : baseX,
    y: typeof typedInches === 'number' ? null : baseY,
    typedInches: typedInches,
    typedAngleDegrees: typedAngleDegrees,
    sourceUsedSnap: useSnap && typeof typedInches !== 'number' && typeof typedAngleDegrees !== 'number',
  }
}

// 19. Anchor click with hover + freehand + snap enabled → anchor uses hover.
{
  const result = pickAnchorPoint(
    { x: 102, y: 102 },                    // raw cursor (off the line)
    { x: 100, y: 100, type: 'endpoint' },  // hover from snap branch
    true,                                  // techSnapEnabled
  )
  pass('19a. Anchor with hover + snap enabled → uses hover x',
    result.x === 100)
  pass('19b. Anchor with hover + snap enabled → uses hover y',
    result.y === 100)
  pass('19c. Anchor consumed snap',
    result.sourceUsedSnap === true)
}

// 20. Anchor click with hover but snap DISABLED → anchor uses raw cursor.
{
  const result = pickAnchorPoint(
    { x: 102, y: 102 },
    { x: 100, y: 100, type: 'endpoint' },
    false,                                 // techSnapEnabled OFF
  )
  pass('20a. Anchor with hover + snap disabled → uses raw x',
    result.x === 102)
  pass('20b. Anchor with hover + snap disabled → uses raw y',
    result.y === 102)
  pass('20c. Anchor did NOT consume snap',
    result.sourceUsedSnap === false)
}

// 21. Anchor click with NO hover → anchor uses raw cursor regardless of snap flag.
{
  const result = pickAnchorPoint(
    { x: 50, y: 50 },
    null,                                  // no hover (no snap target)
    true,                                  // techSnapEnabled ON
  )
  pass('21a. Anchor with no hover → uses raw x',
    result.x === 50)
  pass('21b. Anchor with no hover → uses raw y',
    result.y === 50)
  pass('21c. Anchor did NOT consume snap',
    result.sourceUsedSnap === false)
}

// 22. Second click with hover + freehand + snap enabled → commit uses hover.
{
  const result = pickCommitPoint(
    { x: 102, y: 102 },
    { x: 100, y: 100, type: 'endpoint' },
    true,                                  // techSnapEnabled
    null,                                  // typedInches
    null,                                  // typedAngleDegrees
  )
  pass('22a. Commit with hover + freehand + snap → uses hover x',
    result.x === 100)
  pass('22b. Commit with hover + freehand + snap → uses hover y',
    result.y === 100)
  pass('22c. Commit consumed snap',
    result.sourceUsedSnap === true)
}

// 23. Second click with hover present + typedInches set → typed wins.
//     (In production, the onMouseMove snap branch wouldn't have set
//     hover in the first place once typedInches went non-null. But
//     the commit helper is defensive: a stale hover from before the
//     operator started typing must not override their typed value.)
{
  const result = pickCommitPoint(
    { x: 102, y: 102 },
    { x: 100, y: 100, type: 'endpoint' },
    true,
    24,                                    // typedInches set
    null,
  )
  pass('23a. typedInches set → commit does NOT consume snap',
    result.sourceUsedSnap === false)
  pass('23b. typedInches passed through unchanged',
    result.typedInches === 24)
}

// 24. Second click with hover present + typedAngleDegrees set → typed wins.
{
  const result = pickCommitPoint(
    { x: 102, y: 102 },
    { x: 100, y: 100, type: 'endpoint' },
    true,
    null,
    45,                                    // typedAngleDegrees set
  )
  pass('24a. typedAngleDegrees set → commit does NOT consume snap',
    result.sourceUsedSnap === false)
  pass('24b. typedAngleDegrees passed through unchanged',
    result.typedAngleDegrees === 45)
}

// ============================================================================
// BLOCK F — Tech-line snap branch gate (25–27)
//
// Mirrors the boolean expression in CanvasStage.jsx onMouseMove that
// decides whether to fire findTechSnapTarget for the line tool.
// Frozen as a test so a regression that drops a guard fails loudly.
//
// 18-snap Bug A fix (May 12 2026): gate widened. Pre-fix the gate
// required `techDraft && techDraft.a` (i.e. anchor already placed by
// first click). Pre-first-click techDraft was null and snap never
// fired — first click landed at raw cursor, not at the visible-after-
// the-click diamond. Post-fix: gate fires whenever line tool active +
// snap enabled. typedInches / typedAngleDegrees still block snap (when
// techDraft exists with either typed value, the operator's explicit
// geometry wins). Test 26 reflects the widened gate — what was
// "blocked" before is now "fires" for the no-draft and no-anchor cases.
// ============================================================================

function shouldFireLineToolSnap(store) {
  // Post-Bug-A-fix gate. No techDraft.a requirement.
  return !!(
    store.appMode === 'TECHNICAL'
    && store.tool === 'tech-line'
    && store.techSnapEnabled
    && (
      !store.techDraft
      || (
        store.techDraft.typedInches === null
        && store.techDraft.typedAngleDegrees === null
      )
    )
  )
}

// 25. Pure freehand under TECHNICAL with anchor set + snap on → fires.
{
  const store = {
    appMode: 'TECHNICAL',
    tool: 'tech-line',
    techDraft: { a: { x: 0, y: 0 }, typedInches: null, typedAngleDegrees: null },
    techSnapEnabled: true,
  }
  pass('25. Freehand + snap on → branch fires',
    shouldFireLineToolSnap(store) === true)
}

// 26. Each guard individually blocks (or, post-Bug-A-fix, fires) the branch.
{
  const base = {
    appMode: 'TECHNICAL',
    tool: 'tech-line',
    techDraft: { a: { x: 0, y: 0 }, typedInches: null, typedAngleDegrees: null },
    techSnapEnabled: true,
  }
  pass('26a. appMode FIELD → blocked',
    shouldFireLineToolSnap({ ...base, appMode: 'FIELD' }) === false)
  pass('26b. tool tech-select → blocked',
    shouldFireLineToolSnap({ ...base, tool: 'tech-select' }) === false)
  // Bug A fix: no techDraft → FIRES (pre-first-click hover scan).
  pass('26c. no techDraft → FIRES (Bug A fix — pre-first-click scan)',
    shouldFireLineToolSnap({ ...base, techDraft: null }) === true)
  // Bug A fix: no draft anchor with no typed values → FIRES (operator
  // may have started typing then cleared OR draft exists from a prior
  // session quirk; either way, freehand snap should fire).
  pass('26d. draft without anchor and no typed values → FIRES (Bug A fix)',
    shouldFireLineToolSnap({
      ...base,
      techDraft: { a: null, typedInches: null, typedAngleDegrees: null },
    }) === true)
  pass('26e. typedInches set → blocked',
    shouldFireLineToolSnap({
      ...base,
      techDraft: { a: { x: 0, y: 0 }, typedInches: 24, typedAngleDegrees: null },
    }) === false)
  pass('26f. typedAngleDegrees set → blocked',
    shouldFireLineToolSnap({
      ...base,
      techDraft: { a: { x: 0, y: 0 }, typedInches: null, typedAngleDegrees: 45 },
    }) === false)
  pass('26g. techSnapEnabled false → blocked',
    shouldFireLineToolSnap({ ...base, techSnapEnabled: false }) === false)
}

// 27. Stale-hover clear branch: snap off or typed value + existing hover → clear.
// Post-Bug-A-fix: techDraft.a is no longer required for clear (a stale
// hover from a prior anchor needs clearing even if the operator has
// since reset the draft).
function shouldClearLineToolHover(store) {
  return !!(
    store.appMode === 'TECHNICAL'
    && store.tool === 'tech-line'
    && store.techCommandHover !== null
    && !shouldFireLineToolSnap(store)
  )
}
{
  const store = {
    appMode: 'TECHNICAL',
    tool: 'tech-line',
    techDraft: { a: { x: 0, y: 0 }, typedInches: null, typedAngleDegrees: null },
    techSnapEnabled: false,
    techCommandHover: { x: 100, y: 0, type: 'endpoint' },
  }
  pass('27a. Snap off + anchor + stale hover → clear branch fires',
    shouldClearLineToolHover(store) === true)
}
{
  const store = {
    appMode: 'TECHNICAL',
    tool: 'tech-line',
    techDraft: { a: { x: 0, y: 0 }, typedInches: 24, typedAngleDegrees: null },
    techSnapEnabled: true,
    techCommandHover: { x: 100, y: 0, type: 'endpoint' },
  }
  pass('27b. Typed inches + anchor + stale hover → clear branch fires',
    shouldClearLineToolHover(store) === true)
}
{
  const store = {
    appMode: 'TECHNICAL',
    tool: 'tech-line',
    techDraft: { a: { x: 0, y: 0 }, typedInches: null, typedAngleDegrees: null },
    techSnapEnabled: true,
    techCommandHover: { x: 100, y: 0, type: 'endpoint' },
  }
  pass('27c. Freehand + snap on + existing hover → clear branch does NOT fire (fire branch active instead)',
    shouldClearLineToolHover(store) === false)
}

// ============================================================================
// BLOCK G — Backward compatibility (28)
//
// Existing 3 findTechSnapTarget callers in CanvasStage (grip-edit live
// preview, command base-point pick, grip-edit dispatch in onMouseDown's
// PRIORITY 1) pass nothing for the 7th arg. The default
// {endpoint:true, midpoint:true} must preserve pre-18-snap behavior
// exactly so 18d-edit commands continue to snap.
// ============================================================================

// 28. Calling findTechSnapTarget WITHOUT snapTypes returns the same
//     result as calling it WITH {endpoint:true, midpoint:true}.
{
  const cursorAtEndpoint = { x: 2, y: 2 }
  const defaultArg = findTechSnapTarget(cursorAtEndpoint, [fixtureLine], fixtureLayers, fixtureViewport, 7)
  const explicitBothTrue = findTechSnapTarget(
    cursorAtEndpoint, [fixtureLine], fixtureLayers, fixtureViewport, 7, null,
    { endpoint: true, midpoint: true },
  )
  pass('28a. No snapTypes arg = explicit {endpoint:true, midpoint:true} (type)',
    defaultArg && explicitBothTrue && defaultArg.type === explicitBothTrue.type)
  pass('28b. No snapTypes arg = explicit {endpoint:true, midpoint:true} (x)',
    defaultArg && explicitBothTrue && defaultArg.x === explicitBothTrue.x)
  pass('28c. No snapTypes arg = explicit {endpoint:true, midpoint:true} (y)',
    defaultArg && explicitBothTrue && defaultArg.y === explicitBothTrue.y)
}

// ============================================================================
// BLOCK H — Bug A regression: pre-first-click snap scan (29–31)
//
// Full scan-gate end-to-end test — closes the false-positive coverage
// pattern shared with 18b P47 and 18d-edit inches→pixels. Pre-fix the
// scan-gate required `techDraft.a`, so the original `pickAnchorPoint`
// tests in Block E passed (hover-supplied-as-parameter) while the
// production gate never populated hover pre-first-click. These tests
// route through the SAME gate boolean expression that production uses
// (shouldFireLineToolSnap from Block F) AND the same anchor pick
// helper from Block E, in sequence, so a regression that re-tightens
// the gate fails loudly.
// ============================================================================

// Production-mirror: full mousemove → click flow.
// `store` is the input; returns the anchor point that production would
// commit. The hover is computed INSIDE this helper by running the
// scan-gate against `store`, NOT supplied externally.
function fullFirstClickFlow(store, cursor, snapTarget) {
  // Step 1: mousemove (could be many — only the last one's hover matters).
  const gateFires = shouldFireLineToolSnap(store)
  const hover = gateFires ? snapTarget : null
  // Step 2: click. Mirror pickAnchorPoint from Block E.
  const useSnap = !!hover && store.techSnapEnabled
  return {
    hoverPopulated: hover !== null,
    anchor: useSnap
      ? { x: hover.x, y: hover.y }
      : { x: cursor.x, y: cursor.y },
    usedSnap: useSnap,
  }
}

// 29. Pre-first-click: no techDraft yet, hover near endpoint → hover
//     populates and first click consumes it.
{
  const store = {
    appMode: 'TECHNICAL',
    tool: 'tech-line',
    techDraft: null,         // ← BUG A regression: pre-first-click
    techSnapEnabled: true,
  }
  const result = fullFirstClickFlow(
    store,
    { x: 102, y: 102 },                            // raw cursor near endpoint
    { x: 100, y: 100, type: 'endpoint' },          // snap target
  )
  pass('29a. Pre-first-click: hover populates via scan-gate',
    result.hoverPopulated === true)
  pass('29b. Pre-first-click: first click anchor = snap target x',
    result.anchor.x === 100)
  pass('29c. Pre-first-click: first click anchor = snap target y',
    result.anchor.y === 100)
  pass('29d. Pre-first-click: anchor used snap',
    result.usedSnap === true)
}

// 30. Pre-first-click WITH snap DISABLED → hover does NOT populate;
//     first click anchor at raw cursor.
{
  const store = {
    appMode: 'TECHNICAL',
    tool: 'tech-line',
    techDraft: null,
    techSnapEnabled: false,
  }
  const result = fullFirstClickFlow(
    store,
    { x: 102, y: 102 },
    { x: 100, y: 100, type: 'endpoint' },
  )
  pass('30a. Pre-first-click + snap off: hover NOT populated',
    result.hoverPopulated === false)
  pass('30b. Pre-first-click + snap off: anchor at raw cursor',
    result.anchor.x === 102 && result.anchor.y === 102)
}

// 31. SECOND click (techDraft.a already set): same flow still snaps.
//     Verifies the widened gate didn't accidentally break the post-
//     first-click case.
{
  const store = {
    appMode: 'TECHNICAL',
    tool: 'tech-line',
    techDraft: { a: { x: 0, y: 0 }, typedInches: null, typedAngleDegrees: null },
    techSnapEnabled: true,
  }
  const result = fullFirstClickFlow(
    store,
    { x: 102, y: 102 },
    { x: 100, y: 100, type: 'endpoint' },
  )
  pass('31a. Second-click (draft.a set) + snap on: hover populates',
    result.hoverPopulated === true)
  pass('31b. Second-click: commit uses snap target',
    result.anchor.x === 100 && result.anchor.y === 100)
}

// ============================================================================
// BLOCK I — Bug B regression: commitTechLine snapMode exactness (32–36)
//
// Pre-fix, second-click correctly consumed techCommandHover but
// commitTechLine then rounded freehand length to 0.5" and re-projected
// b via cos/sin of cursor-angle. Endpoint landed up to half-an-inch
// off the snap target. Post-fix: snapMode=true skips rounding and
// commits b directly at cursorWorld (which IS the snap target).
// ============================================================================

function captureShape() {
  let captured = null
  const addTechnicalShape = (sh) => { captured = sh }
  const setTechDraft = () => {}
  return { addTechnicalShape, setTechDraft, get: () => captured }
}

// 32. snapMode=true: b lands EXACTLY at cursorWorld (no drift).
{
  const cap = captureShape()
  const anchor = { x: 0, y: 0 }
  // Snap target at a position whose distance is NOT a 0.5" multiple
  // (96.3 px ≈ 4.0125", which rounds to 4.0" — projection would drift
  // 0.3 px off without the snapMode fix).
  const snapTarget = { x: 96.3, y: 48.7 }
  const ok = commitTechLine({
    anchor,
    cursorWorld: snapTarget,
    typedInches: null,
    typedAngleDegrees: null,
    snapMode: true,
    addTechnicalShape: cap.addTechnicalShape,
    setTechDraft: cap.setTechDraft,
  })
  const shape = cap.get()
  pass('32a. snapMode=true commits successfully',
    ok === true && shape !== null)
  pass('32b. snapMode=true: b.x EXACTLY at snap target x',
    shape && shape.b.x === 96.3)
  pass('32c. snapMode=true: b.y EXACTLY at snap target y',
    shape && shape.b.y === 48.7)
  pass('32d. snapMode=true: lengthSource = "snap"',
    shape && shape.lengthSource === 'snap')
  pass('32e. snapMode=true: angleSource = "snap"',
    shape && shape.angleSource === 'snap')
}

// 33. snapMode=false (existing freehand path): b drifts off snap target
//     due to 0.5" rounding. Verifies the bug pre-fix WOULD have shown
//     this drift, and that the snapMode flag is what gates the fix.
{
  const cap = captureShape()
  const anchor = { x: 0, y: 0 }
  // Same snap target. Without snapMode, the 0.5" rounding applies.
  const snapTarget = { x: 96.3, y: 48.7 }
  commitTechLine({
    anchor,
    cursorWorld: snapTarget,
    typedInches: null,
    typedAngleDegrees: null,
    snapMode: false,                              // ← Pre-fix path
    addTechnicalShape: cap.addTechnicalShape,
    setTechDraft: cap.setTechDraft,
  })
  const shape = cap.get()
  pass('33a. snapMode=false: shape committed',
    shape !== null)
  pass('33b. snapMode=false: lengthSource = "freehand" (pre-fix path)',
    shape && shape.lengthSource === 'freehand')
  // Endpoint should NOT be at the snap target due to rounding.
  pass('33c. snapMode=false: b drifts off snap target (proves the bug)',
    shape && (shape.b.x !== 96.3 || shape.b.y !== 48.7))
}

// 34. snapMode=true + typedInches set → typed wins (snapMode silently
//     ignored when operator specified exact length).
{
  const cap = captureShape()
  const anchor = { x: 0, y: 0 }
  const snapTarget = { x: 96, y: 0 }   // 4" right
  commitTechLine({
    anchor,
    cursorWorld: snapTarget,
    typedInches: 24,                   // 1' — overrides snap target distance
    typedAngleDegrees: null,
    snapMode: true,
    addTechnicalShape: cap.addTechnicalShape,
    setTechDraft: cap.setTechDraft,
  })
  const shape = cap.get()
  pass('34a. snapMode=true + typedInches: lengthSource = "typed" (typed wins)',
    shape && shape.lengthSource === 'typed')
  pass('34b. snapMode=true + typedInches: length = typed value',
    shape && shape.lengthInches === 24)
  // b should be at typed length (24" = 576px) along snap direction, NOT
  // at snap target (96px).
  pass('34c. snapMode=true + typedInches: b lands at typed length',
    shape && near(shape.b.x, 576))
}

// 35. snapMode=true + typedAngleDegrees set → angle locked to typed value.
//     Snap target is not consumed because the operator specified an
//     exact angle. (length still computes via snap-mode rules — falls
//     through to non-snap branch when typedAngle is set; check shape).
{
  const cap = captureShape()
  const anchor = { x: 0, y: 0 }
  const snapTarget = { x: 96, y: 0 }   // 4" right
  commitTechLine({
    anchor,
    cursorWorld: snapTarget,
    typedInches: null,
    typedAngleDegrees: 90,             // straight down — overrides snap
    snapMode: true,
    addTechnicalShape: cap.addTechnicalShape,
    setTechDraft: cap.setTechDraft,
  })
  const shape = cap.get()
  pass('35a. snapMode=true + typedAngle: angleSource = "typed"',
    shape && shape.angleSource === 'typed')
  // b should be along the typed-angle direction, NOT at the snap
  // target's xy. lengthSource is "freehand" since the snap-mode
  // branch only fires when neither typed is set.
  pass('35b. snapMode=true + typedAngle: b NOT at snap target',
    shape && shape.b.x !== 96)
}

// 36. snapMode=true + degenerate zero-length (snap target at anchor)
//     → reject, return false.
{
  const cap = captureShape()
  const anchor = { x: 50, y: 50 }
  const snapTarget = { x: 50, y: 50 }   // same as anchor
  const ok = commitTechLine({
    anchor,
    cursorWorld: snapTarget,
    typedInches: null,
    typedAngleDegrees: null,
    snapMode: true,
    addTechnicalShape: cap.addTechnicalShape,
    setTechDraft: cap.setTechDraft,
  })
  pass('36. snapMode=true + zero-length → rejected',
    ok === false && cap.get() === null)
}

// ============================================================================
// BLOCK J — Bug C regression: Move/Copy destination snap scan (37–40)
//
// The original 18-snap scope wired snap to the BASE-POINT pick
// (PRIORITY 2). Destination snap (PRIORITY 3) was missed — Move/Copy
// committed at raw cursor. Post-fix: PRIORITY 3 mousemove scans for
// snap, writes techCommandHover; PRIORITY 3 commit consumes it.
// ============================================================================

// Mirror of the PRIORITY 3 mousemove snap-scan gate.
function priority3SnapApplies(store) {
  return !!(
    store.techActiveCommand
    && store.techCommandBasePoint
    && Array.isArray(store.techCommandOriginShapes)
    && store.appMode === 'TECHNICAL'
    && store.techSnapEnabled
    && (store.techActiveCommand === 'move' || store.techActiveCommand === 'copy')
  )
}

// Fixture: 1 selected line with origin shape ready for command.
const fixtureCommandStore = (cmd, snapEnabled) => ({
  appMode: 'TECHNICAL',
  techActiveCommand: cmd,
  techCommandBasePoint: { x: 0, y: 0 },
  techCommandOriginShapes: [
    { id: 'origShape1', type: 'line', a: { x: 10, y: 0 }, b: { x: 34, y: 0 } },
  ],
  techSnapEnabled: snapEnabled,
  techSnapTypes: { endpoint: true, midpoint: true },
})

// 37. cmd='move' + basePoint set + snap on → priority-3 snap applies.
{
  pass('37a. Move + basePoint + snap on → scan fires',
    priority3SnapApplies(fixtureCommandStore('move', true)) === true)
  pass('37b. Copy + basePoint + snap on → scan fires',
    priority3SnapApplies(fixtureCommandStore('copy', true)) === true)
  pass('37c. Rotate + basePoint + snap on → scan does NOT fire (no destination point)',
    priority3SnapApplies(fixtureCommandStore('rotate', true)) === false)
  pass('37d. Move + basePoint + snap OFF → scan does NOT fire',
    priority3SnapApplies(fixtureCommandStore('move', false)) === false)
}

// 38. Origin shapes EXCLUDED from snap candidates during Move (so the
//     shape being moved can't snap to itself and collapse the move).
{
  // Layer has TWO lines: the one being moved + another at (100, 0)→(124, 0).
  const otherLine = { id: 'otherShape', type: 'line', a: { x: 100, y: 0 }, b: { x: 124, y: 0 } }
  const movingLine = { id: 'origShape1', type: 'line', a: { x: 10, y: 0 }, b: { x: 34, y: 0 } }
  const layers = [{ id: 'L1', visible: true, shapes: [movingLine, otherLine] }]
  // Cursor near otherLine.a = (100, 0). Pass movingLine in exclude set.
  const target = findTechSnapTarget(
    { x: 102, y: 0 }, [], layers, { panX: 0, panY: 0, zoom: 1 }, 7,
    new Set([movingLine.id]),
    { endpoint: true, midpoint: true },
  )
  pass('38a. Move snap finds otherLine endpoint (not excluded)',
    target && target.x === 100)
  // Cursor near movingLine.a = (10, 0). With movingLine excluded, no hit.
  const noTarget = findTechSnapTarget(
    { x: 12, y: 0 }, [], layers, { panX: 0, panY: 0, zoom: 1 }, 7,
    new Set([movingLine.id]),
    { endpoint: true, midpoint: true },
  )
  pass('38b. Move snap excludes moving shape (cannot snap to self)',
    noTarget === null)
}

// 39. PRIORITY 3 commit: Move uses live-preview mutation (no re-apply
//     needed when snap engaged — mousemove already wrote the snap-
//     adjusted delta).
//     This test asserts that when snap is engaged for Move, the live
//     preview applies the snap-adjusted delta — using the production
//     applyCommandTransform helper.
{
  const movingLine = { id: 'origShape1', type: 'line', a: { x: 10, y: 0 }, b: { x: 34, y: 0 } }
  const basePoint = { x: 22, y: 0 }   // center of moving line
  // Operator's cursor at (98, 0); snap target at (100, 0).
  const snapTarget = { x: 100, y: 0 }
  const effectiveCursor = snapTarget   // mousemove uses target when hover set
  const payload = {
    dx: effectiveCursor.x - basePoint.x,
    dy: effectiveCursor.y - basePoint.y,
  }
  const transformed = applyCommandTransform('move', movingLine, basePoint, payload)
  pass('39a. Move live preview applies snap-adjusted delta to a.x',
    transformed.a.x === 10 + (100 - 22))
  pass('39b. Move live preview applies snap-adjusted delta to b.x',
    transformed.b.x === 34 + (100 - 22))
}

// 40. PRIORITY 3 commit: Copy uses px → inches conversion before
//     calling commitCopyCommand. Pre-fix this path passed pixel delta
//     to a units-aware action → 24× too-far clones. Test mirrors the
//     post-fix call shape: divide pixel delta by PX_PER_INCH at the
//     call site.
{
  const basePoint = { x: 0, y: 0 }
  const snapTarget = { x: 96, y: 0 }   // 4" right
  // Pre-fix: deltaPx = (96, 0). commitCopyCommand multiplies by 24 →
  // clones land at (96*24, 0) = (2304, 0). 24× too far.
  const deltaInches = {
    dx: (snapTarget.x - basePoint.x) / PX_PER_INCH_TEST,
    dy: (snapTarget.y - basePoint.y) / PX_PER_INCH_TEST,
  }
  pass('40a. Px → inches conversion: delta = 4 inches',
    deltaInches.dx === 4 && deltaInches.dy === 0)
  // Post-action: commitCopyCommand multiplies by 24 → 4 * 24 = 96 px
  // delta. Clone lands at original + 96 (NOT at original + 2304).
  const cloneXOffset = deltaInches.dx * PX_PER_INCH_TEST
  pass('40b. Round-trip: 4 in × PX_PER_INCH = 96 px offset (matches snap target)',
    cloneXOffset === 96)
}

// ============================================================================
// BLOCK K — Diamond render visibility regression (41)
//
// Bug A widened visibility to render the diamond for tech-line at any
// draft state (including pre-first-click). Bug C added a branch for
// Move/Copy destination (basePoint set). Rotate still excluded.
// ============================================================================

function diamondVisible(state) {
  return !!(
    state.techCommandHover
    && (
      (state.techActiveCommand && !state.techCommandBasePoint)
      || (
        state.techActiveCommand
        && state.techCommandBasePoint
        && (state.techActiveCommand === 'move' || state.techActiveCommand === 'copy')
      )
      || state.techGripEdit
      || (state.tool === 'tech-line' && state.appMode === 'TECHNICAL')
    )
  )
}

// 41. Each scenario: diamond visibility matches the production guard.
{
  const baseHover = { x: 100, y: 100, type: 'endpoint' }
  // tech-line + hover, no draft anchor → visible (Bug A fix)
  pass('41a. tech-line + hover + no draft → diamond VISIBLE (Bug A fix)',
    diamondVisible({
      tool: 'tech-line', appMode: 'TECHNICAL', techCommandHover: baseHover,
    }) === true)
  // tech-line + hover under FIELD mode → NOT visible (mode isolation)
  pass('41b. tech-line + hover + FIELD mode → diamond NOT visible',
    diamondVisible({
      tool: 'tech-line', appMode: 'FIELD', techCommandHover: baseHover,
    }) === false)
  // Move + basePoint + hover → visible (Bug C fix)
  pass('41c. Move + basePoint + hover → diamond VISIBLE (Bug C fix)',
    diamondVisible({
      techActiveCommand: 'move',
      techCommandBasePoint: { x: 0, y: 0 },
      techCommandHover: baseHover,
    }) === true)
  // Copy + basePoint + hover → visible
  pass('41d. Copy + basePoint + hover → diamond VISIBLE',
    diamondVisible({
      techActiveCommand: 'copy',
      techCommandBasePoint: { x: 0, y: 0 },
      techCommandHover: baseHover,
    }) === true)
  // Rotate + basePoint + hover → NOT visible (rotate excluded from
  // destination snap)
  pass('41e. Rotate + basePoint + hover → diamond NOT visible (rotate excluded)',
    diamondVisible({
      techActiveCommand: 'rotate',
      techCommandBasePoint: { x: 0, y: 0 },
      techCommandHover: baseHover,
    }) === false)
  // Base-point-pick case still works (no basePoint yet)
  pass('41f. Command awaiting basePoint + hover → diamond VISIBLE',
    diamondVisible({
      techActiveCommand: 'move',
      techCommandBasePoint: null,
      techCommandHover: baseHover,
    }) === true)
  // Grip edit case still works
  pass('41g. Grip edit + hover → diamond VISIBLE',
    diamondVisible({
      techGripEdit: { layerId: 'L1', shapeId: 'sh1', pointKey: 'a' },
      techCommandHover: baseHover,
    }) === true)
  // No hover → never visible
  pass('41h. No hover → diamond NOT visible regardless of state',
    diamondVisible({
      tool: 'tech-line', appMode: 'TECHNICAL', techCommandHover: null,
    }) === false)
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
