// Node-side runner for Phase 2 sub-step 18k block tests.
//
// 18k ships angular dimensions + leader-line callouts.
//
//   Block K — angular dim math + store actions + bridge (target ~25 tests)
//   Block L — callout commit helpers + store actions + bridge (target ~20 tests)
//   Block M — InlineTextEditor contract (source-grep) (target ~8 tests)
//   Block N — integration regressions: no break in 18h paths + bridge
//             still emits linear dims (target ~7 tests)
//
// Same eval-shim approach as the 18h runner.

const path = require('path')
const fs = require('fs')

function loadModule(relpath, returnNames, preamble) {
  const src = fs.readFileSync(path.join(__dirname, '..', relpath), 'utf-8')
  const transformed = src
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/export\s+function/g, 'function')
    .replace(/export\s+const/g, 'const')
    .replace(/export\s+async\s+function/g, 'async function')
    .replace(/^export\s+\{[^}]+\}\s*;?\s*$/gm, '')
  const body = (preamble || '') + '\n' + transformed
  const factory = new Function(`${body}\nreturn { ${returnNames.join(', ')} }`)
  return factory()
}

// Load angularDimMath first (no internal imports).
const {
  intersectLines, rayFromVertex, computeAngularOrientation,
  computeAngularGeometry, computeAngleDegrees, formatAngle,
} = loadModule(
  'src/utils/angularDimMath.js',
  ['intersectLines', 'rayFromVertex', 'computeAngularOrientation',
   'computeAngularGeometry', 'computeAngleDegrees', 'formatAngle'],
)

// Load techCalloutCommit.
const {
  beginCalloutPlacement, placeCalloutTip, placeCalloutTail,
  commitCallout, cancelCalloutDraft,
} = loadModule(
  'src/utils/techCalloutCommit.js',
  ['beginCalloutPlacement', 'placeCalloutTip', 'placeCalloutTail',
   'commitCallout', 'cancelCalloutDraft'],
)

// Load specTableValidation for SPEC_TABLE_FIELDS.
const { SPEC_TABLE_FIELDS } = loadModule(
  'src/utils/specTableValidation.js',
  ['SPEC_TABLE_FIELDS'],
)

// Load formatArchitecturalLength (specTableJSON's dep for linear dims).
const { formatArchitecturalLength } = loadModule(
  'src/utils/formatArchitecturalLength.js',
  ['formatArchitecturalLength'],
)

// Load specTableJSON with its deps stubbed via preamble.
const bridgePreamble = `
  const SPEC_TABLE_FIELDS = ${JSON.stringify(SPEC_TABLE_FIELDS)}
  ${formatArchitecturalLength.toString()}
  ${computeAngleDegrees.toString()}
  ${formatAngle.toString()}
  ${computeAngularGeometry.toString()}
`
const { buildShopDrawingPayload, slugify, shopDrawingFilename } = loadModule(
  'src/utils/specTableJSON.js',
  ['buildShopDrawingPayload', 'slugify', 'shopDrawingFilename'],
  bridgePreamble,
)

// ----------------------------------------------------------------------------
// Test harness
// ----------------------------------------------------------------------------
const tests = []
function pass(name, ok, extra) { tests.push({ name, ok: !!ok, extra }) }

// Mock store helpers
function mkStoreState(overrides = {}) {
  return {
    specTable: {
      partName: 'P', material: 'M', color: '', stockLength: '',
      jobId: '', jobAddress: '', drawnBy: '', date: '', drawingNo: 'D1',
    },
    technicalLayers: [],
    techCalloutDraft: null,
    techDimAngularDraft: null,
    ...overrides,
  }
}

// ============================================================================
// BLOCK K — Angular dim math + bridge (1-25)
// ============================================================================

// 1. intersectLines on perpendicular lines through origin
{
  const L1 = { a: { x: -10, y: 0 }, b: { x: 10, y: 0 } }
  const L2 = { a: { x: 0, y: -10 }, b: { x: 0, y: 10 } }
  const p = intersectLines(L1, L2)
  pass('1. intersectLines perpendicular → (0, 0)',
    p && Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9)
}

// 2. intersectLines parallel returns null
{
  const L1 = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }
  const L2 = { a: { x: 0, y: 5 }, b: { x: 10, y: 5 } }
  pass('2. intersectLines parallel → null',
    intersectLines(L1, L2) === null)
}

// 3. intersectLines off-origin: y=x and y=-x+10 cross at (5,5)
{
  const L1 = { a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }
  const L2 = { a: { x: 0, y: 10 }, b: { x: 10, y: 0 } }
  const p = intersectLines(L1, L2)
  pass('3. intersectLines y=x ∩ y=-x+10 = (5, 5)',
    p && Math.abs(p.x - 5) < 1e-6 && Math.abs(p.y - 5) < 1e-6)
}

// 4. rayFromVertex picks far endpoint
{
  const vertex = { x: 0, y: 0 }
  const line = { a: { x: 1, y: 0 }, b: { x: 100, y: 0 } }
  const far = rayFromVertex(vertex, line)
  pass('4. rayFromVertex picks far endpoint',
    far.x === 100 && far.y === 0)
}

// 5. rayFromVertex with vertex equal to one endpoint
{
  const vertex = { x: 1, y: 0 }
  const line = { a: { x: 1, y: 0 }, b: { x: 100, y: 0 } }
  const far = rayFromVertex(vertex, line)
  pass('5. rayFromVertex when vertex = line.a → picks line.b',
    far.x === 100 && far.y === 0)
}

// 6. computeAngularOrientation: 2 lines sharing endpoint at origin
{
  const L1 = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }
  const L2 = { a: { x: 0, y: 0 }, b: { x: 0, y: 100 } }
  const cursor = { x: 20, y: 20 }
  const o = computeAngularOrientation(L1, L2, cursor)
  pass('6a. computeAngularOrientation finds shared vertex (0,0)',
    o && Math.abs(o.vertex.x) < 0.5 && Math.abs(o.vertex.y) < 0.5)
  pass('6b. p1 is line1 far endpoint',
    o && o.p1.x === 100 && o.p1.y === 0)
  pass('6c. p2 is line2 far endpoint',
    o && o.p2.x === 0 && o.p2.y === 100)
  pass('6d. radius = cursor distance from vertex',
    o && Math.abs(o.radius - Math.hypot(20, 20)) < 1e-6)
}

// 7. computeAngularOrientation: 2 lines without shared endpoint (intersect)
{
  const L1 = { a: { x: -10, y: 0 }, b: { x: 10, y: 0 } }
  const L2 = { a: { x: 0, y: -10 }, b: { x: 0, y: 10 } }
  const cursor = { x: 5, y: 5 }
  const o = computeAngularOrientation(L1, L2, cursor)
  pass('7. computeAngularOrientation falls back to intersection',
    o && Math.abs(o.vertex.x) < 1e-6 && Math.abs(o.vertex.y) < 1e-6)
}

// 8. computeAngularOrientation: parallel lines + no shared endpoint → null
{
  const L1 = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }
  const L2 = { a: { x: 0, y: 5 }, b: { x: 10, y: 5 } }
  pass('8. computeAngularOrientation parallel + non-shared → null',
    computeAngularOrientation(L1, L2, { x: 0, y: 0 }) === null)
}

// 9. computeAngularGeometry: 90° right angle
{
  const dim = {
    vertex: { x: 0, y: 0 },
    p1: { x: 100, y: 0 },
    p2: { x: 0, y: 100 },
    radius: 30,
  }
  const g = computeAngularGeometry(dim)
  pass('9a. computeAngularGeometry sweep = ±π/2',
    g && Math.abs(Math.abs(g.sweep) - Math.PI / 2) < 1e-6)
  pass('9b. angleDegrees = 90',
    g && Math.abs(g.angleDegrees - 90) < 1e-6)
  pass('9c. arcCenter = vertex',
    g && g.arcCenter.x === 0 && g.arcCenter.y === 0)
}

// 10. computeAngularGeometry: 45° angle
{
  const dim = {
    vertex: { x: 0, y: 0 },
    p1: { x: 100, y: 0 },
    p2: { x: 100, y: 100 },
    radius: 30,
  }
  pass('10. computeAngularGeometry 45° → angleDegrees ≈ 45',
    Math.abs(computeAngleDegrees(dim) - 45) < 1e-6)
}

// 11. formatAngle degrees
pass('11a. formatAngle(45) → "45.0°"', formatAngle(45) === '45.0°')
pass('11b. formatAngle(90.5, "degrees", 1) → "90.5°"',
  formatAngle(90.5, 'degrees', 1) === '90.5°')
pass('11c. formatAngle(45, "degrees", 0) → "45°"',
  formatAngle(45, 'degrees', 0) === '45°')

// 12. formatAngle pitch
pass('12a. formatAngle(45, "pitch") → "12/12"',
  formatAngle(45, 'pitch') === '12/12')
pass('12b. formatAngle(0, "pitch") → "0/12"',
  formatAngle(0, 'pitch') === '0/12')

// 13. formatAngle bad input
pass('13a. formatAngle(NaN) → ""', formatAngle(NaN) === '')
pass('13b. formatAngle("45") → ""', formatAngle('45') === '')

// 14. Angular dim bridge: emits correct payload
{
  const dim = {
    id: 'd1',
    type: 'dimension',
    dimType: 'angular',
    vertex: { mode: 'free', x: 0, y: 0 },
    p1: { x: 100, y: 0 },
    p2: { x: 0, y: 100 },
    radius: 30,
    textOverride: null,
  }
  const store = mkStoreState({
    technicalLayers: [{
      id: 'tl1', visible: true, name: 'L1', color: '#000', order: 0,
      shapes: [dim],
    }],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('14a. Angular dim emitted in dimensions[]',
    p.layers[0].dimensions.length === 1)
  pass('14b. type = angular',
    p.layers[0].dimensions[0].type === 'angular')
  pass('14c. vertex/p1/p2 carried through',
    p.layers[0].dimensions[0].vertex.x === 0
    && p.layers[0].dimensions[0].p1.x === 100
    && p.layers[0].dimensions[0].p2.y === 100)
  pass('14d. radius carried through',
    p.layers[0].dimensions[0].radius === 30)
  pass('14e. value computed = "90.0°"',
    p.layers[0].dimensions[0].value === '90.0°')
}

// 15. Angular dim bridge: textOverride wins
{
  const dim = {
    id: 'd1', type: 'dimension', dimType: 'angular',
    vertex: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, p2: { x: 0, y: 100 },
    radius: 30, textOverride: 'CUSTOM',
  }
  const store = mkStoreState({
    technicalLayers: [{
      id: 'tl1', visible: true, shapes: [dim], color: '#000',
    }],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('15. Angular dim textOverride wins → "CUSTOM"',
    p.layers[0].dimensions[0].value === 'CUSTOM')
}

// 16. Angular dim bridge: missing required field → null skipped
{
  const dim = {
    type: 'dimension', dimType: 'angular',
    vertex: { x: 0, y: 0 }, p1: null, p2: { x: 0, y: 100 },
    radius: 30,
  }
  const store = mkStoreState({
    technicalLayers: [{
      id: 'tl1', visible: true, shapes: [dim], color: '#000',
    }],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('16. Angular dim missing p1 silently dropped',
    p.layers[0].dimensions.length === 0)
}

// ============================================================================
// BLOCK L — Callout commit + store + bridge (17-33)
// ============================================================================

// Mock store actions for techCalloutCommit
function mkCalloutActions(initial = {}) {
  const state = { techCalloutDraft: null, callouts: [], ...initial }
  return {
    state,
    setTechCalloutDraft: (d) => { state.techCalloutDraft = d },
    addTechnicalCallout: ({ tip, tail, textEN, tipStyle }) => {
      const id = `tc-${state.callouts.length + 1}`
      state.callouts.push({ id, tip, tail, textEN, tipStyle })
      return id
    },
  }
}

// 17. beginCalloutPlacement sets draft
{
  const a = mkCalloutActions()
  beginCalloutPlacement(a)
  pass('17. beginCalloutPlacement → draft stage = awaitTip',
    a.state.techCalloutDraft && a.state.techCalloutDraft.stage === 'awaitTip')
}

// 18. placeCalloutTip transitions to awaitTail
{
  const a = mkCalloutActions({ techCalloutDraft: { stage: 'awaitTip', tip: null, tail: null } })
  const ok = placeCalloutTip(a.state.techCalloutDraft, 10, 20, a)
  pass('18a. placeCalloutTip returns true on valid call', ok === true)
  pass('18b. draft now awaitTail with tip',
    a.state.techCalloutDraft.stage === 'awaitTail'
    && a.state.techCalloutDraft.tip.x === 10
    && a.state.techCalloutDraft.tip.y === 20)
}

// 19. placeCalloutTail transitions to awaitText
{
  const a = mkCalloutActions({
    techCalloutDraft: { stage: 'awaitTail', tip: { x: 10, y: 20 }, tail: null },
  })
  const ok = placeCalloutTail(a.state.techCalloutDraft, 50, 60, a)
  pass('19a. placeCalloutTail returns true on valid call', ok === true)
  pass('19b. draft now awaitText with tail',
    a.state.techCalloutDraft.stage === 'awaitText'
    && a.state.techCalloutDraft.tail.x === 50)
}

// 20. placeCalloutTail rejects zero-distance leader
{
  const a = mkCalloutActions({
    techCalloutDraft: { stage: 'awaitTail', tip: { x: 10, y: 20 }, tail: null },
  })
  const ok = placeCalloutTail(a.state.techCalloutDraft, 10, 20, a)
  pass('20. placeCalloutTail rejects tip == tail', ok === false)
}

// 21. commitCallout creates shape via addTechnicalCallout
{
  const a = mkCalloutActions({
    techCalloutDraft: {
      stage: 'awaitText',
      tip: { x: 10, y: 20 }, tail: { x: 50, y: 60 },
    },
  })
  const id = commitCallout(a.state.techCalloutDraft, 'TEST', a)
  pass('21a. commitCallout returns new id', typeof id === 'string' && id.length > 0)
  pass('21b. one callout created', a.state.callouts.length === 1)
  pass('21c. callout has tip/tail/textEN/tipStyle',
    a.state.callouts[0].tip.x === 10
    && a.state.callouts[0].tail.x === 50
    && a.state.callouts[0].textEN === 'TEST'
    && a.state.callouts[0].tipStyle === 'numbered')
  pass('21d. draft cleared after commit', a.state.techCalloutDraft === null)
}

// 22. cancelCalloutDraft clears draft
{
  const a = mkCalloutActions({
    techCalloutDraft: { stage: 'awaitTip', tip: null, tail: null },
  })
  cancelCalloutDraft(a)
  pass('22. cancelCalloutDraft clears draft', a.state.techCalloutDraft === null)
}

// 23. Callout bridge: stripLayer emits callouts in payload.layers[].callouts[]
{
  const callout = {
    id: 'c1', type: 'callout',
    tip: { mode: 'free', x: 30, y: 40 },
    tail: { x: 60, y: 80 },
    num: 1, textEN: 'TEST CALLOUT', tipStyle: 'numbered',
  }
  const store = mkStoreState({
    technicalLayers: [{
      id: 'tl1', visible: true, name: 'L', color: '#000',
      shapes: [callout], nextCalloutNum: 2,
    }],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('23a. Callout emitted into layer.callouts[]',
    p.layers[0].callouts.length === 1)
  pass('23b. Callout has tipX/tipY/tailX/tailY',
    p.layers[0].callouts[0].tipX === 30
    && p.layers[0].callouts[0].tipY === 40
    && p.layers[0].callouts[0].tailX === 60
    && p.layers[0].callouts[0].tailY === 80)
  pass('23c. Callout carries num + textEN + tipStyle',
    p.layers[0].callouts[0].num === 1
    && p.layers[0].callouts[0].textEN === 'TEST CALLOUT'
    && p.layers[0].callouts[0].tipStyle === 'numbered')
}

// 24. Bridge ignores malformed callout
{
  const bad = { id: 'c2', type: 'callout', tip: null, tail: { x: 0, y: 0 } }
  const store = mkStoreState({
    technicalLayers: [{
      id: 'tl1', visible: true, shapes: [bad], color: '#000',
    }],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('24. Malformed callout dropped silently',
    p.layers[0].callouts.length === 0)
}

// 25. Bridge handles mixed shapes (line + dim + callout) in one layer
{
  const store = mkStoreState({
    technicalLayers: [{
      id: 'tl1', visible: true, name: 'L', color: '#000',
      shapes: [
        { id: 'L1', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
        { id: 'D1', type: 'dimension', dimType: 'aligned', orientation: 'aligned',
          pointA: { mode: 'free', x: 0, y: 0 }, pointB: { mode: 'free', x: 24, y: 0 } },
        { id: 'C1', type: 'callout',
          tip: { mode: 'free', x: 10, y: 10 },
          tail: { x: 30, y: 30 }, num: 1, textEN: 'X', tipStyle: 'numbered' },
      ],
    }],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('25a. Mixed-shape layer splits into shapes/dimensions/callouts',
    p.layers[0].shapes.length === 1
    && p.layers[0].dimensions.length === 1
    && p.layers[0].callouts.length === 1)
  pass('25b. Line carries pts (Bug 1 bridge unchanged)',
    p.layers[0].shapes[0].pts.length === 2)
  pass('25c. Linear dim carries x1/y1/x2/y2 with computed value',
    p.layers[0].dimensions[0].x1 === 0
    && p.layers[0].dimensions[0].value === '1"')
}

// ============================================================================
// BLOCK M — InlineTextEditor source contract (26-29)
// ============================================================================

const inlineEditorSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'InlineTextEditor.jsx'),
  'utf-8',
)

pass('26a. InlineTextEditor handles Enter key',
  /e\.key === 'Enter'/.test(inlineEditorSrc))
pass('26b. InlineTextEditor handles Escape key',
  /e\.key === 'Escape'/.test(inlineEditorSrc))
pass('26c. InlineTextEditor handles Tab key',
  /e\.key === 'Tab'/.test(inlineEditorSrc))
pass('27. InlineTextEditor auto-focuses on mount',
  /autoFocus[\s\S]{0,200}inputRef\.current\.focus\(\)/.test(inlineEditorSrc))
pass('28. InlineTextEditor commits on click-outside',
  /document\.addEventListener\('mousedown'[\s\S]{0,400}onCommit/.test(inlineEditorSrc))
pass('29. InlineTextEditor uses position: fixed',
  /position: 'fixed'/.test(inlineEditorSrc))

// ============================================================================
// BLOCK N — Integration regressions (30-36)
// ============================================================================

const appJsxSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'App.jsx'),
  'utf-8',
)
const drawingToolsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'DrawingTools.jsx'),
  'utf-8',
)

pass('30. App.jsx imports InlineTextEditor',
  /import\s+InlineTextEditor\s+from\s+['"]\.\/components\/InlineTextEditor['"]/.test(appJsxSrc))
pass('31. App.jsx mounts InlineTextEditorMount',
  /InlineTextEditorMount/.test(appJsxSrc))
pass('32a. App.jsx keyboard handler for A (angular)',
  /k === 'a'[\s\S]{0,200}setTool\('tech-dim-angular'\)/.test(appJsxSrc))
pass('32b. App.jsx keyboard handler for C (callout)',
  /k === 'c'[\s\S]{0,200}setTool\('tech-callout'\)/.test(appJsxSrc))
pass('32c. App.jsx keyboard handler for L (line)',
  /k === 'l'[\s\S]{0,200}setTool\('tech-line'\)/.test(appJsxSrc))
pass('32d. App.jsx keyboard handler for S (select)',
  /k === 's'[\s\S]{0,200}setTool\('tech-select'\)/.test(appJsxSrc))
pass('33a. DrawingTools has Dim ∠ button',
  /btn-tech-dim-angular/.test(drawingToolsSrc))
pass('33b. DrawingTools has Callout button',
  /btn-tech-callout/.test(drawingToolsSrc))
pass('34. Linear-dim bridge still produces "1\'-0\\"" for 12-inch dim',
  (() => {
    const store = mkStoreState({
      technicalLayers: [{
        id: 'tl1', visible: true, name: 'L', color: '#000',
        shapes: [{
          id: 'D1', type: 'dimension', dimType: 'aligned', orientation: 'aligned',
          pointA: { mode: 'free', x: 0, y: 0 }, pointB: { mode: 'free', x: 288, y: 0 },
        }],
      }],
    })
    const p = buildShopDrawingPayload(store, {})
    return p.layers[0].dimensions[0].value === "1'-0\""
  })())

// ============================================================================
// BLOCK O — Reachability for 18k tools (35-37)
// ============================================================================
pass('35. Dim ∠ button has keyboard hint in tooltip',
  /Angular[\s\S]{0,200}\(A\)/.test(drawingToolsSrc))
pass('36. Callout button has keyboard hint in tooltip',
  /Callout[\s\S]{0,200}\(C\)/.test(drawingToolsSrc))
pass('37. Line button has retro keyboard hint (L)',
  /Line[\s\S]{0,200}\(L\)/.test(drawingToolsSrc))

// ============================================================================
// SUMMARY
// ============================================================================
setTimeout(() => {
  const passCount = tests.filter((t) => t.ok).length
  const total = tests.length
  console.log(passCount + '/' + total + ' ' + (passCount === total ? 'PASS' : 'FAIL'))
  for (const t of tests) {
    if (!t.ok) console.log('FAIL: ' + t.name + (t.extra ? ' ' + JSON.stringify(t.extra) : ''))
  }
}, 50)
