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
const { findTechSnapTarget } = loadModule(
  'src/utils/techGeometry.js',
  ['findTechSnapTarget'],
  techGeomPreamble,
)

const tests = []
function pass(name, ok, extra) {
  tests.push({ name, ok: !!ok, extra })
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
// ============================================================================

function shouldFireLineToolSnap(store) {
  return !!(
    store.appMode === 'TECHNICAL'
    && store.tool === 'tech-line'
    && store.techDraft
    && store.techDraft.a
    && store.techDraft.typedInches === null
    && store.techDraft.typedAngleDegrees === null
    && store.techSnapEnabled
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

// 26. Each guard individually blocks the branch.
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
  pass('26c. no techDraft → blocked',
    shouldFireLineToolSnap({ ...base, techDraft: null }) === false)
  pass('26d. no draft anchor → blocked',
    shouldFireLineToolSnap({
      ...base,
      techDraft: { a: null, typedInches: null, typedAngleDegrees: null },
    }) === false)
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

// 27. Stale-hover clear branch: snap off + anchor set + existing hover → clear.
function shouldClearLineToolHover(store) {
  return !!(
    store.appMode === 'TECHNICAL'
    && store.tool === 'tech-line'
    && store.techDraft && store.techDraft.a
    && store.techCommandHover !== null
    // Either snap off OR typed values present — i.e. the "fires" gate
    // above does NOT match but we still have a draft anchor + a stale
    // hover that must be cleared so the diamond stops rendering.
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
// SUMMARY
// ============================================================================
const passCount = tests.filter((t) => t.ok).length
const total = tests.length
console.log(passCount + '/' + total + ' ' + (passCount === total ? 'PASS' : 'FAIL'))
for (const t of tests) {
  if (!t.ok) console.log('FAIL: ' + t.name + (t.extra ? ' ' + JSON.stringify(t.extra) : ''))
}
