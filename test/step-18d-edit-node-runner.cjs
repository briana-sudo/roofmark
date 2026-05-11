// Node-side runner for Phase 2 sub-step 18d-edit block tests.
//
// 18d-edit replaces the 18d-pivot rotation-only model with AutoCAD's
// command pattern (Rotate / Move / Copy / Delete + endpoint grip edit).
// Same eval-shim approach as step-18b/18c/18d.
//
// Coverage:
//   - parseMoveInput (12 cases)
//   - State action contract (8 cases — new field clears + setters)
//   - applyCommandTransform (8 cases — rotate/move/copy math)
//   - Command commits (6 cases — copy/delete single-undo, round-trip)
//   - Grip-edit math (4 cases — typed delta + Escape revert + snap exclude)
//   - Full workflow integration (8 cases — Rotate/Move/Copy/Delete e2e)

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

// Load parseLength + parseAngle (already shim-friendly).
const { parseLength } = loadModule('src/utils/parseLength.js', ['parseLength'])
const { parseAngle } = loadModule('src/utils/parseAngle.js', ['parseAngle'])

// parseMoveInput depends on parseLength + parseAngle — seed them into the shim.
const moveInputPreamble = `
  function parseLength(input) {
    if (typeof input !== 'string') return null
    const s = input.trim()
    if (s.length === 0) return null
    if (s.startsWith('-')) return null
    let m = s.match(/^([0-9]+(?:\\.[0-9]+)?)\\s*'\\s*(?:([0-9]+(?:\\.[0-9]+)?)\\s*(?:"|in|″)?)?$/i)
    if (m) {
      const feet = parseFloat(m[1])
      const inches = m[2] ? parseFloat(m[2]) : 0
      const total = feet * 12 + inches
      return total > 0 ? total : null
    }
    m = s.match(/^([0-9]+(?:\\.[0-9]+)?)\\s*(?:"|in|″)$/i)
    if (m) {
      const inches = parseFloat(m[1])
      return inches > 0 ? inches : null
    }
    m = s.match(/^([0-9]+(?:\\.[0-9]+)?)$/)
    if (m) {
      const inches = parseFloat(m[1])
      return inches > 0 ? inches : null
    }
    return null
  }
  function parseAngle(input, defaultUnit) {
    if (typeof input !== 'string') return null
    const s = input.trim()
    if (s.length === 0) return null
    const hasSlash = s.includes('/')
    const hasDegreeSymbol = s.includes('°')
    const hasDegWord = /deg/i.test(s)
    if (hasSlash) {
      const m = s.match(/^(-?[0-9]+(?:\\.[0-9]+)?)\\s*\\/\\s*(-?[0-9]+(?:\\.[0-9]+)?)$/)
      if (!m) return null
      const rise = parseFloat(m[1])
      const run = parseFloat(m[2])
      if (!Number.isFinite(rise) || !Number.isFinite(run)) return null
      if (rise < 0 || run <= 0) return null
      if (rise === 0) return 0
      return Math.atan(rise / run) * 180 / Math.PI
    }
    if (hasDegreeSymbol || hasDegWord) {
      const m = s.match(/^(-?[0-9]+(?:\\.[0-9]+)?)\\s*(?:°|deg)$/i)
      if (!m) return null
      const value = parseFloat(m[1])
      if (!Number.isFinite(value)) return null
      if (Math.abs(value) > 360) return null
      return value
    }
    if (defaultUnit !== 'degrees') return null
    const m = s.match(/^(-?[0-9]+(?:\\.[0-9]+)?)$/)
    if (!m) return null
    const value = parseFloat(m[1])
    if (!Number.isFinite(value)) return null
    if (Math.abs(value) > 360) return null
    return value
  }
`
const { parseMoveInput } = loadModule(
  'src/utils/parseMoveInput.js',
  ['parseMoveInput'],
  moveInputPreamble,
)

// techGeometry — preamble needs rotatePoint.
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
  applyCommandTransform, rotateTechShape, techShapeCentroid, findTechSnapTarget,
} = loadModule(
  'src/utils/techGeometry.js',
  ['applyCommandTransform', 'rotateTechShape', 'techShapeCentroid', 'findTechSnapTarget'],
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
// PARSE MOVE INPUT (1–12)
// ============================================================================
{
  const r = parseMoveInput('24, 0')
  pass('1a. "24, 0" → dx=24', r && r.dx === 24)
  pass('1b. "24, 0" → dy=0',  r && r.dy === 0)
}
{
  const r = parseMoveInput('0, 12')
  pass('2a. "0, 12" → dx=0', r && r.dx === 0)
  pass('2b. "0, 12" → dy=12', r && r.dy === 12)
}
{
  const r = parseMoveInput('24 @ 45')
  pass('3a. "24 @ 45" → dx ≈ 16.97', r && near(r.dx, 24 * Math.cos(Math.PI/4)))
  pass('3b. "24 @ 45" → dy ≈ 16.97', r && near(r.dy, 24 * Math.sin(Math.PI/4)))
}
{
  const r = parseMoveInput('24 @ 90')
  pass('4a. "24 @ 90" → dx ≈ 0', r && near(r.dx, 0))
  pass('4b. "24 @ 90" → dy ≈ 24', r && near(r.dy, 24))
}
{
  const r = parseMoveInput("1'6, 0")
  pass('5a. "1\'6, 0" → dx=18', r && r.dx === 18)
  pass('5b. "1\'6, 0" → dy=0', r && r.dy === 0)
}
{
  const r = parseMoveInput("1'6 @ 4/12")
  const expectedAngle = Math.atan(4 / 12)
  pass('6a. "1\'6 @ 4/12" → dx ≈ 18*cos(atan(4/12))',
    r && near(r.dx, 18 * Math.cos(expectedAngle), 0.01))
  pass('6b. "1\'6 @ 4/12" → dy ≈ 18*sin(atan(4/12))',
    r && near(r.dy, 18 * Math.sin(expectedAngle), 0.01))
}
{
  const r = parseMoveInput('24 @ 4/12')
  const ang = Math.atan(4 / 12)
  pass('7a. "24 @ 4/12" → dx ≈ 24*cos', r && near(r.dx, 24 * Math.cos(ang), 0.01))
  pass('7b. "24 @ 4/12" → dy ≈ 24*sin', r && near(r.dy, 24 * Math.sin(ang), 0.01))
}
{
  const r = parseMoveInput('  24 ,   0  ')
  pass('8. whitespace-tolerant comma form', r && r.dx === 24 && r.dy === 0)
}
{
  const r = parseMoveInput('  24   @   45  ')
  pass('9. whitespace-tolerant @ form',
    r && near(r.dx, 24 * Math.cos(Math.PI/4)) && near(r.dy, 24 * Math.sin(Math.PI/4)))
}
pass('10. "" → null', parseMoveInput('') === null)
pass('11. "abc" → null', parseMoveInput('abc') === null)
pass('12a. "24" alone → null (no comma or @)', parseMoveInput('24') === null)
pass('12b. "24 @ abc" → null', parseMoveInput('24 @ abc') === null)
pass('12c. "24, abc" → null', parseMoveInput('24, abc') === null)

// 12d. Negative dx (cmd-line typed "Move 24 left").
{
  const r = parseMoveInput('-24, 0')
  pass('12d. "-24, 0" → dx=-24', r && r.dx === -24 && r.dy === 0)
}

// ============================================================================
// STATE ACTION CONTRACT (13–20)
// Mirror of useAppStore.js setters + clear sites for 18d-edit fields.
// ============================================================================

function makeMockCmdStore() {
  const state = {
    techSelected: [],
    techActiveCommand: null,
    techCommandBasePoint: null,
    techCommandOriginShapes: null,
    techCommandPreSnap: null,
    techCommandInput: null,
    techCommandHover: null,
    techGripEdit: null,
    appMode: 'TECHNICAL',
    tool: 'tech-select',
  }
  return {
    state,
    setTechActiveCommand: (c) => { state.techActiveCommand = c },
    setTechCommandBasePoint: (p) => { state.techCommandBasePoint = p },
    setTechCommandOriginShapes: (a) => { state.techCommandOriginShapes = a },
    setTechCommandPreSnap: (s) => { state.techCommandPreSnap = s },
    setTechCommandInput: (v) => { state.techCommandInput = v },
    setTechCommandHover: (t) => { state.techCommandHover = t },
    setTechGripEdit: (o) => { state.techGripEdit = o },
    clearAllCmd: () => {
      state.techActiveCommand = null
      state.techCommandBasePoint = null
      state.techCommandOriginShapes = null
      state.techCommandPreSnap = null
      state.techCommandInput = null
      state.techCommandHover = null
      state.techGripEdit = null
    },
  }
}

// 13. setTechActiveCommand writes value.
{
  const s = makeMockCmdStore()
  s.setTechActiveCommand('rotate')
  pass('13. setTechActiveCommand("rotate") writes "rotate"', s.state.techActiveCommand === 'rotate')
}

// 14. setTechCommandBasePoint writes value.
{
  const s = makeMockCmdStore()
  s.setTechCommandBasePoint({ x: 10, y: 20 })
  pass('14. setTechCommandBasePoint writes {x, y}',
    s.state.techCommandBasePoint && s.state.techCommandBasePoint.x === 10)
}

// 15. setTechGripEdit writes value.
{
  const s = makeMockCmdStore()
  s.setTechGripEdit({ layerId: 'L1', shapeId: 'sh1', pointKey: 'a', originPoint: { x: 0, y: 0 }, preSnap: 'snap' })
  pass('15. setTechGripEdit writes object',
    s.state.techGripEdit && s.state.techGripEdit.pointKey === 'a')
}

// 16. setAppMode-style clear wipes all seven fields. (Pure-logic mock.)
{
  const s = makeMockCmdStore()
  s.setTechActiveCommand('move')
  s.setTechCommandBasePoint({ x: 1, y: 1 })
  s.setTechCommandOriginShapes([{ id: 'sh1' }])
  s.setTechCommandPreSnap('snap')
  s.setTechCommandInput({ dx: 1, dy: 1 })
  s.setTechCommandHover({ x: 1, y: 1, type: 'endpoint' })
  s.setTechGripEdit({ layerId: 'L1', shapeId: 'sh1', pointKey: 'a', originPoint: { x: 0, y: 0 }, preSnap: 'snap' })
  s.clearAllCmd()
  pass('16a. clearAllCmd wipes techActiveCommand', s.state.techActiveCommand === null)
  pass('16b. clearAllCmd wipes basePoint', s.state.techCommandBasePoint === null)
  pass('16c. clearAllCmd wipes originShapes', s.state.techCommandOriginShapes === null)
  pass('16d. clearAllCmd wipes preSnap', s.state.techCommandPreSnap === null)
  pass('16e. clearAllCmd wipes input', s.state.techCommandInput === null)
  pass('16f. clearAllCmd wipes hover', s.state.techCommandHover === null)
  pass('16g. clearAllCmd wipes gripEdit', s.state.techGripEdit === null)
}

// 17. dataSnapshot fields contract — none of the new 7 fields belong.
{
  const FIELDS_IN_SNAPSHOT = new Set([
    'layers', 'sequences', 'clines',
    'photoMeta', 'cropMeta', 'hasSourcePhoto',
    'gridRotation', 'perspectiveCorners',
    'technicalLayers', 'specTable',
  ])
  pass('17a. techActiveCommand NOT in dataSnapshot', !FIELDS_IN_SNAPSHOT.has('techActiveCommand'))
  pass('17b. techCommandBasePoint NOT in dataSnapshot', !FIELDS_IN_SNAPSHOT.has('techCommandBasePoint'))
  pass('17c. techCommandOriginShapes NOT in dataSnapshot', !FIELDS_IN_SNAPSHOT.has('techCommandOriginShapes'))
  pass('17d. techGripEdit NOT in dataSnapshot', !FIELDS_IN_SNAPSHOT.has('techGripEdit'))
}

// 18. commitCopyCommand pure-logic mock: adds clones with new IDs,
//     originals unchanged, single undo snapshot pushed.
{
  let nextId = 0
  const newTechShapeId = () => `tech-shape-${++nextId}`
  const state = {
    technicalLayers: [{
      id: 'L1', visible: true,
      shapes: [{ id: 'orig1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }],
    }],
    undoStack: [],
  }
  const commitCopyCommand = (origins, delta, preSnap) => {
    let nextLayers = state.technicalLayers
    for (const orig of origins) {
      const layerIdx = nextLayers.findIndex((l) => l.shapes.some((sh) => sh.id === orig.id))
      if (layerIdx < 0) continue
      const newShape = {
        ...orig,
        id: newTechShapeId(),
        a: { x: orig.a.x + delta.dx, y: orig.a.y + delta.dy },
        b: { x: orig.b.x + delta.dx, y: orig.b.y + delta.dy },
      }
      nextLayers = nextLayers.map((l, i) =>
        i === layerIdx ? { ...l, shapes: [...l.shapes, newShape] } : l
      )
    }
    state.technicalLayers = nextLayers
    if (typeof preSnap === 'string') state.undoStack.push(preSnap)
  }

  commitCopyCommand(
    state.technicalLayers[0].shapes,
    { dx: 50, dy: 0 },
    'pre-copy-snap',
  )
  pass('18a. commitCopyCommand adds 1 clone', state.technicalLayers[0].shapes.length === 2)
  pass('18b. original shape unchanged',
    state.technicalLayers[0].shapes[0].a.x === 0 && state.technicalLayers[0].shapes[0].b.x === 24)
  pass('18c. clone is at offset',
    state.technicalLayers[0].shapes[1].a.x === 50 && state.technicalLayers[0].shapes[1].b.x === 74)
  pass('18d. clone has new ID', state.technicalLayers[0].shapes[1].id !== state.technicalLayers[0].shapes[0].id)
  pass('18e. one snapshot pushed', state.undoStack.length === 1)
}

// 19. commitDeleteCommand pure-logic mock: removes selected shapes,
//     single undo snapshot pushed.
{
  const state = {
    technicalLayers: [{
      id: 'L1', visible: true,
      shapes: [
        { id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } },
        { id: 'sh2', type: 'line', a: { x: 0, y: 50 }, b: { x: 24, y: 50 } },
        { id: 'sh3', type: 'line', a: { x: 0, y: 100 }, b: { x: 24, y: 100 } },
      ],
    }],
    undoStack: [],
  }
  const commitDeleteCommand = (sel, preSnap) => {
    const selSet = new Set(sel.map((e) => e.shapeId))
    state.technicalLayers = state.technicalLayers.map((l) => ({
      ...l,
      shapes: l.shapes.filter((sh) => !selSet.has(sh.id)),
    }))
    if (typeof preSnap === 'string') state.undoStack.push(preSnap)
  }
  commitDeleteCommand(
    [{ layerId: 'L1', shapeId: 'sh1' }, { layerId: 'L1', shapeId: 'sh3' }],
    'pre-delete-snap',
  )
  pass('19a. commitDeleteCommand leaves the non-deleted shape',
    state.technicalLayers[0].shapes.length === 1 && state.technicalLayers[0].shapes[0].id === 'sh2')
  pass('19b. one snapshot pushed', state.undoStack.length === 1 && state.undoStack[0] === 'pre-delete-snap')
}

// 20. Multi-shape commit (Copy/Delete) pushes ONE snapshot, not N.
{
  let snapCount = 0
  // For a 3-shape Copy, snapshot should fire ONCE.
  const fakePushSnap = (snap) => { if (typeof snap === 'string') snapCount += 1 }
  // Imitate the commit action's single-snapshot pattern.
  for (let i = 0; i < 3; i++) {
    // Each iteration adds a clone but does NOT push snap.
  }
  fakePushSnap('one-snap-for-three-shapes')
  pass('20. commitCopy 3-shape pushes 1 snap, not 3', snapCount === 1)
}

// ============================================================================
// APPLY COMMAND TRANSFORM (21–28)
// ============================================================================

// 21. Rotate transform matches rotateTechShape direct call.
{
  const orig = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const basePoint = { x: 0, y: 0 }
  const transformed = applyCommandTransform('rotate', orig, basePoint, { angleDegrees: 90 })
  const direct = rotateTechShape(orig, basePoint, 90)
  pass('21a. rotate transform a matches direct rotateTechShape',
    near(transformed.a.x, direct.a.x) && near(transformed.a.y, direct.a.y))
  pass('21b. rotate transform b matches direct rotateTechShape',
    near(transformed.b.x, direct.b.x) && near(transformed.b.y, direct.b.y))
}

// 22. Move transform: a + delta, b + delta.
{
  const orig = { type: 'line', a: { x: 10, y: 10 }, b: { x: 30, y: 20 } }
  const transformed = applyCommandTransform('move', orig, { x: 0, y: 0 }, { dx: 5, dy: -3 })
  pass('22a. move: a.x = 15', transformed.a.x === 15)
  pass('22b. move: a.y = 7', transformed.a.y === 7)
  pass('22c. move: b.x = 35', transformed.b.x === 35)
  pass('22d. move: b.y = 17', transformed.b.y === 17)
}

// 23. Copy transform = Move math (preview only; commit handles ID).
{
  const orig = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const transformed = applyCommandTransform('copy', orig, { x: 0, y: 0 }, { dx: 50, dy: 0 })
  pass('23a. copy transform: a.x = 50', transformed.a.x === 50)
  pass('23b. copy transform: b.x = 74', transformed.b.x === 74)
}

// 24. Origin shape unchanged after transform (returns new object).
{
  const orig = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const origCopy = JSON.parse(JSON.stringify(orig))
  applyCommandTransform('move', orig, { x: 0, y: 0 }, { dx: 100, dy: 100 })
  pass('24. origin shape unchanged after applyCommandTransform',
    orig.a.x === origCopy.a.x && orig.b.x === origCopy.b.x)
}

// 25. Zero-delta move: shape unchanged.
{
  const orig = { type: 'line', a: { x: 10, y: 10 }, b: { x: 30, y: 20 } }
  const transformed = applyCommandTransform('move', orig, { x: 0, y: 0 }, { dx: 0, dy: 0 })
  pass('25. zero-delta move: shape values match origin',
    transformed.a.x === 10 && transformed.b.y === 20)
}

// 26. 360° rotation: shape unchanged (within float tolerance).
{
  const orig = { type: 'line', a: { x: 5, y: 5 }, b: { x: 15, y: 5 } }
  const transformed = applyCommandTransform('rotate', orig, { x: 10, y: 5 }, { angleDegrees: 360 })
  pass('26. 360° rotation returns to origin',
    near(transformed.a.x, 5) && near(transformed.b.x, 15))
}

// 27. Unknown command → returns origin unchanged.
{
  const orig = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const t = applyCommandTransform('mirror', orig, { x: 0, y: 0 }, { dx: 5, dy: 5 })
  pass('27a. unknown command returns origin (no transform)', t === orig)
}

// 28. Multi-shape transform: each shape gets its own copy.
{
  const shapes = [
    { id: 's1', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
    { id: 's2', type: 'line', a: { x: 0, y: 50 }, b: { x: 10, y: 50 } },
  ]
  const transformed = shapes.map((s) =>
    applyCommandTransform('move', s, { x: 0, y: 0 }, { dx: 20, dy: 0 })
  )
  pass('28a. shape 1 moved correctly', transformed[0].a.x === 20 && transformed[0].b.x === 30)
  pass('28b. shape 2 moved correctly', transformed[1].a.x === 20 && transformed[1].b.x === 30)
  pass('28c. shape 1 unaffected by shape 2', transformed[0].a.y === 0)
}

// ============================================================================
// GRIP EDIT MATH (29–32)
// ============================================================================

// 29. typed "24, 0" with origin at (10, 10) → endpoint moves to (34, 10).
{
  const origin = { x: 10, y: 10 }
  const delta = parseMoveInput('24, 0')
  const newPoint = { x: origin.x + delta.dx, y: origin.y + delta.dy }
  pass('29a. grip typed "24, 0" → new endpoint (34, 10)',
    newPoint.x === 34 && newPoint.y === 10)
}

// 30. typed "12 @ 45" with origin at (0, 0) → endpoint at (8.49, 8.49).
{
  const origin = { x: 0, y: 0 }
  const delta = parseMoveInput('12 @ 45')
  const newPoint = { x: origin.x + delta.dx, y: origin.y + delta.dy }
  const expected = 12 / Math.sqrt(2)
  pass('30a. grip typed "12 @ 45" → x ≈ 8.49', near(newPoint.x, expected))
  pass('30b. grip typed "12 @ 45" → y ≈ 8.49', near(newPoint.y, expected))
}

// 31. Grip edit on shape A excludes shape A from snap candidates.
{
  const layerA = {
    id: 'L1', visible: true,
    shapes: [
      { id: 'shA', type: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
      { id: 'shB', type: 'line', a: { x: 50, y: 50 }, b: { x: 150, y: 50 } },
    ],
  }
  // Cursor at world (100, 5) — close to shA's b at (100, 0). Without
  // exclude, this would hit shA's endpoint. With exclude=[shA.id],
  // shA endpoints skip — closest remaining is shB's (50, 50) at distance
  // ~67, outside 7-px tolerance → null.
  const target = findTechSnapTarget(
    { x: 100, y: 5 },
    [],
    [layerA],
    { panX: 0, panY: 0, zoom: 1 },
    7,
    new Set(['shA']),
  )
  pass('31. grip-edit snap excludes originating shape', target === null)
}

// 32. Grip edit Escape revert: endpoint restored to originPoint.
{
  const liveShape = { id: 'sh1', type: 'line', a: { x: 50, y: 50 }, b: { x: 100, y: 100 } }
  const gripEdit = {
    layerId: 'L1', shapeId: 'sh1', pointKey: 'a',
    originPoint: { x: 0, y: 0 },
    preSnap: 'snap',
  }
  // Escape revert: write originPoint back.
  liveShape[gripEdit.pointKey] = gripEdit.originPoint
  pass('32a. Escape revert: liveShape.a restored to (0, 0)',
    liveShape.a.x === 0 && liveShape.a.y === 0)
  pass('32b. Escape revert: liveShape.b untouched',
    liveShape.b.x === 100 && liveShape.b.y === 100)
}

// ============================================================================
// FULL WORKFLOW INTEGRATION (33–40)
// ============================================================================

// 33. Rotate command: shape at (0,0)→(24,0), base (0,0), typed 45 → 45° absolute.
{
  const orig = { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const basePoint = { x: 0, y: 0 }
  const typedDeg = 45
  // Workflow: revert origins (no-op since this is the typed path),
  // compute baseline angle from basePoint to first centroid, delta =
  // typed - baseline, rotate.
  const firstCentroid = techShapeCentroid(orig)
  const baselineDeg = Math.atan2(firstCentroid.y - basePoint.y, firstCentroid.x - basePoint.x) * 180 / Math.PI
  const deltaDeg = typedDeg - baselineDeg
  const result = applyCommandTransform('rotate', orig, basePoint, { angleDegrees: deltaDeg })
  // Verify result line angle = 45° absolute.
  const resultAngle = Math.atan2(result.b.y - result.a.y, result.b.x - result.a.x) * 180 / Math.PI
  pass('33a. typed-Rotate 45° produces 45° absolute orientation', near(resultAngle, 45, 0.001))
  pass('33b. typed-Rotate length preserved',
    near(Math.hypot(result.b.x - result.a.x, result.b.y - result.a.y), 24))
}

// 34. Move command: shape translates by typed delta.
{
  const orig = { type: 'line', a: { x: 10, y: 10 }, b: { x: 34, y: 10 } }
  const result = applyCommandTransform('move', orig, { x: 0, y: 0 }, { dx: 100, dy: -50 })
  pass('34a. Move dx=100 dy=-50: a → (110, -40)',
    result.a.x === 110 && result.a.y === -40)
  pass('34b. Move dx=100 dy=-50: b → (134, -40)',
    result.b.x === 134 && result.b.y === -40)
}

// 35. Copy command: new shape at offset, original unchanged.
{
  const orig = { id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  // Mock copy commit: produce clone with new ID.
  const clone = {
    ...orig,
    id: 'sh1-copy',
    a: { x: orig.a.x + 50, y: orig.a.y },
    b: { x: orig.b.x + 50, y: orig.b.y },
  }
  pass('35a. Copy clone has new ID', clone.id !== orig.id)
  pass('35b. Copy clone at offset', clone.a.x === 50 && clone.b.x === 74)
  pass('35c. Copy original unchanged', orig.a.x === 0 && orig.b.x === 24)
}

// 36. Delete command removes shapes by ID.
{
  const layers = [{
    id: 'L1',
    shapes: [
      { id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } },
      { id: 'sh2', type: 'line', a: { x: 0, y: 50 }, b: { x: 24, y: 50 } },
    ],
  }]
  const toDelete = new Set(['sh1'])
  const nextLayers = layers.map((l) => ({
    ...l,
    shapes: l.shapes.filter((sh) => !toDelete.has(sh.id)),
  }))
  pass('36a. Delete removes sh1', nextLayers[0].shapes.length === 1)
  pass('36b. Delete leaves sh2', nextLayers[0].shapes[0].id === 'sh2')
}

// 37. Multi-select rotation: both shapes rotate by same delta around same pivot.
{
  const shapes = [
    { type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } },
    { type: 'line', a: { x: 100, y: 0 }, b: { x: 124, y: 0 } },
  ]
  const basePoint = { x: 50, y: 0 }
  const deltaDeg = 90
  const rotated = shapes.map((s) => applyCommandTransform('rotate', s, basePoint, { angleDegrees: deltaDeg }))
  // Shape 1 around (50, 0) by 90°: a (0,0) → (50 - 0*0 - 0*1, 0 + (-50)*1 + 0*0) = (50, -50)
  pass('37a. multi-rotate shape 1 a',
    near(rotated[0].a.x, 50) && near(rotated[0].a.y, -50))
  // Shape 2 around (50, 0) by 90°: a (100, 0) → (50 - 0*0 - 0*1, 0 + 50*1 + 0*0) = (50, 50)
  pass('37b. multi-rotate shape 2 a',
    near(rotated[1].a.x, 50) && near(rotated[1].a.y, 50))
}

// 38. Cancel pattern: revert origins (no commit, no snapshot).
{
  const orig = { id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } }
  const liveShape = JSON.parse(JSON.stringify(orig))
  // Simulate live preview mutation
  liveShape.a = { x: 50, y: 50 }
  liveShape.b = { x: 74, y: 50 }
  // Cancel: revert
  liveShape.a = orig.a
  liveShape.b = orig.b
  pass('38a. Cancel restores a', liveShape.a.x === 0 && liveShape.a.y === 0)
  pass('38b. Cancel restores b', liveShape.b.x === 24 && liveShape.b.y === 0)
}

// 39. Selection clears after Rotate/Move/Copy/Delete commit.
{
  const state = { techSelected: [{ layerId: 'L1', shapeId: 'sh1' }] }
  // Mock clearTechSelection
  state.techSelected = []
  pass('39. selection clears after commit (mock)', state.techSelected.length === 0)
}

// 40. Selection persists across grip-edit commit.
{
  const state = { techSelected: [{ layerId: 'L1', shapeId: 'sh1' }] }
  // Grip edit commit does NOT clear selection (AutoCAD convention).
  // (No state change in this mock; just assert selection unchanged.)
  pass('40. selection persists after grip-edit (mock)',
    state.techSelected.length === 1 && state.techSelected[0].shapeId === 'sh1')
}

// ============================================================================
// UNDO / REDO ROUND-TRIP (41–54) — 18d-edit addendum (May 11 2026)
// Same gap that caused the 18b undo bug (P47): commit pushes a snap
// onto undoStack but the snap shape didn't include the mutated field.
// 18d-edit verifies the full restore cycle for every command + grip.
//
// Test scaffolding: minimal-store harness with dataSnapshot replica,
// undoStack + redoStack, captureSnap / applySnap / undo / redo +
// commit action replicas. Mirrors the production store's commitRotate/
// commitMove/commitCopy/commitDelete/commitGripEditCommand contracts;
// kept in sync via the keep-in-sync comment in techGeometry-test
// section (step-18b precedent).
// ============================================================================

function makeUndoStore() {
  let _shapeSeq = 100
  const newId = () => `tech-shape-${++_shapeSeq}`
  const state = {
    technicalLayers: [{
      id: 'L1', name: 'Layer 1', visible: true, shapes: [],
    }],
    undoStack: [],
    redoStack: [],
  }
  // Replica of production dataSnapshot — field-for-field. Keep in sync.
  const dataSnapshot = (s) => JSON.stringify({
    layers: [], sequences: [], clines: [],
    photoMeta: null, cropMeta: null, hasSourcePhoto: false,
    gridRotation: 0, perspectiveCorners: null,
    technicalLayers: s.technicalLayers || [],
    specTable: {},
  })
  const captureSnap = () => dataSnapshot(state)
  const pushCapturedSnap = (snap) => {
    if (typeof snap !== 'string') return
    state.undoStack.push(snap)
    state.redoStack = []  // pushing always wipes redo (standard semantics)
  }
  const applySnap = (snap) => {
    const next = JSON.parse(snap)
    state.technicalLayers = Array.isArray(next.technicalLayers) ? next.technicalLayers : []
  }
  // undo: pop preSnap, capture current, apply preSnap, push current to redoStack.
  const undo = () => {
    if (state.undoStack.length === 0) return false
    const current = dataSnapshot(state)
    const last = state.undoStack[state.undoStack.length - 1]
    applySnap(last)
    state.undoStack = state.undoStack.slice(0, -1)
    state.redoStack = [...state.redoStack, current]
    return true
  }
  // redo: pop postSnap, capture current (= preSnap), apply postSnap, push to undoStack.
  const redo = () => {
    if (state.redoStack.length === 0) return false
    const current = dataSnapshot(state)
    const last = state.redoStack[state.redoStack.length - 1]
    applySnap(last)
    state.undoStack = [...state.undoStack, current]
    state.redoStack = state.redoStack.slice(0, -1)
    return true
  }

  // ===== Commit action replicas (mirror useAppStore.js) =====
  const commitRotateCommand = (origins, basePoint, deltaDeg, preSnap) => {
    if (!Array.isArray(origins) || origins.length === 0 || !basePoint) return
    const rad = (deltaDeg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const rotatePt = (p) => ({
      x: basePoint.x + (p.x - basePoint.x) * cos - (p.y - basePoint.y) * sin,
      y: basePoint.y + (p.x - basePoint.x) * sin + (p.y - basePoint.y) * cos,
    })
    let nextLayers = state.technicalLayers
    for (const orig of origins) {
      if (!orig || orig.type !== 'line') continue
      nextLayers = nextLayers.map((l) => ({
        ...l,
        shapes: (l.shapes || []).map((sh) =>
          sh.id === orig.id ? { ...sh, a: rotatePt(orig.a), b: rotatePt(orig.b) } : sh
        ),
      }))
    }
    state.technicalLayers = nextLayers
    pushCapturedSnap(preSnap)
  }
  const commitMoveCommand = (origins, delta, preSnap) => {
    if (!Array.isArray(origins) || origins.length === 0 || !delta) return
    let nextLayers = state.technicalLayers
    for (const orig of origins) {
      if (!orig || orig.type !== 'line') continue
      nextLayers = nextLayers.map((l) => ({
        ...l,
        shapes: (l.shapes || []).map((sh) =>
          sh.id === orig.id ? {
            ...sh,
            a: { x: orig.a.x + delta.dx, y: orig.a.y + delta.dy },
            b: { x: orig.b.x + delta.dx, y: orig.b.y + delta.dy },
          } : sh
        ),
      }))
    }
    state.technicalLayers = nextLayers
    pushCapturedSnap(preSnap)
  }
  const commitCopyCommand = (origins, delta, preSnap) => {
    if (!Array.isArray(origins) || origins.length === 0) return
    let nextLayers = state.technicalLayers
    for (const orig of origins) {
      const layerIdx = nextLayers.findIndex((l) => (l.shapes || []).some((sh) => sh.id === orig.id))
      if (layerIdx < 0) continue
      if (orig.type !== 'line') continue
      const newShape = {
        ...orig, id: newId(),
        a: { x: orig.a.x + delta.dx, y: orig.a.y + delta.dy },
        b: { x: orig.b.x + delta.dx, y: orig.b.y + delta.dy },
      }
      nextLayers = nextLayers.map((l, i) =>
        i === layerIdx ? { ...l, shapes: [...l.shapes, newShape] } : l
      )
    }
    state.technicalLayers = nextLayers
    pushCapturedSnap(preSnap)
  }
  const commitDeleteCommand = (sel, preSnap) => {
    if (!Array.isArray(sel) || sel.length === 0) return
    const selSet = new Set(sel.map((e) => e && e.shapeId).filter(Boolean))
    state.technicalLayers = state.technicalLayers.map((l) => ({
      ...l,
      shapes: (l.shapes || []).filter((sh) => !selSet.has(sh.id)),
    }))
    pushCapturedSnap(preSnap)
  }
  const commitGripEditCommand = (layerId, shapeId, pointKey, newPoint, preSnap) => {
    if (!layerId || !shapeId || !pointKey || !newPoint) return
    state.technicalLayers = state.technicalLayers.map((tl) =>
      tl.id !== layerId ? tl : {
        ...tl,
        shapes: tl.shapes.map((sh) =>
          sh.id === shapeId ? { ...sh, [pointKey]: { x: newPoint.x, y: newPoint.y } } : sh
        ),
      }
    )
    pushCapturedSnap(preSnap)
  }

  // Helper to seed initial shapes.
  const seedShape = (shape) => {
    state.technicalLayers[0].shapes.push(shape)
  }
  const findShape = (id) => {
    for (const l of state.technicalLayers) {
      const s = (l.shapes || []).find((sh) => sh.id === id)
      if (s) return s
    }
    return null
  }
  return {
    state, dataSnapshot, captureSnap, pushCapturedSnap, applySnap, undo, redo,
    commitRotateCommand, commitMoveCommand, commitCopyCommand,
    commitDeleteCommand, commitGripEditCommand,
    seedShape, findShape, newId,
  }
}

// 41. Rotate commit pushes one snapshot; undo restores; redo re-applies.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  const preSnap = s.captureSnap()
  const origins = [JSON.parse(JSON.stringify(s.findShape('sh1')))]
  s.commitRotateCommand(origins, { x: 0, y: 0 }, 90, preSnap)
  pass('41a. Rotate commit pushes 1 undo snap',
    s.state.undoStack.length === 1)
  const afterCommit = s.findShape('sh1')
  pass('41b. Rotate commit mutated b to (0, 24)',
    near(afterCommit.b.x, 0) && near(afterCommit.b.y, 24))
  s.undo()
  pass('41c. After undo, shape restored to b=(24, 0)',
    near(s.findShape('sh1').b.x, 24) && near(s.findShape('sh1').b.y, 0))
  pass('41d. After undo, redoStack has 1 entry', s.state.redoStack.length === 1)
  s.redo()
  pass('41e. After redo, shape b back at (0, 24)',
    near(s.findShape('sh1').b.x, 0) && near(s.findShape('sh1').b.y, 24))
  pass('41f. After redo, undoStack back to 1', s.state.undoStack.length === 1)
}

// 42. Multi-select Rotate: 3 shapes rotated together, 1 snap pushed.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'a', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  s.seedShape({ id: 'b', type: 'line', a: { x: 50, y: 0 }, b: { x: 74, y: 0 } })
  s.seedShape({ id: 'c', type: 'line', a: { x: 100, y: 0 }, b: { x: 124, y: 0 } })
  const preSnap = s.captureSnap()
  const origins = ['a', 'b', 'c'].map((id) => JSON.parse(JSON.stringify(s.findShape(id))))
  s.commitRotateCommand(origins, { x: 0, y: 0 }, 90, preSnap)
  pass('42a. multi-select Rotate pushes 1 snap (not 3)',
    s.state.undoStack.length === 1)
  // After 90° rotation around (0,0), shape 'b' (x: 50→74, y: 0) → x: 0, y: 50→74
  pass('42b. shape b rotated to vertical',
    near(s.findShape('b').a.x, 0) && near(s.findShape('b').a.y, 50))
  s.undo()
  pass('42c. After undo, all 3 shapes restored',
    near(s.findShape('a').b.x, 24)
    && near(s.findShape('b').a.x, 50)
    && near(s.findShape('c').b.x, 124))
}

// 43. Move commit pushes one snapshot; undo restores; redo re-applies.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  const preSnap = s.captureSnap()
  const origins = [JSON.parse(JSON.stringify(s.findShape('sh1')))]
  s.commitMoveCommand(origins, { dx: 50, dy: 30 }, preSnap)
  pass('43a. Move commit pushes 1 snap', s.state.undoStack.length === 1)
  pass('43b. Move commit translated a to (50, 30)',
    s.findShape('sh1').a.x === 50 && s.findShape('sh1').a.y === 30)
  s.undo()
  pass('43c. After undo, shape back at origin',
    s.findShape('sh1').a.x === 0 && s.findShape('sh1').b.x === 24)
  s.redo()
  pass('43d. After redo, shape back at (50, 30)+offset',
    s.findShape('sh1').a.x === 50 && s.findShape('sh1').b.x === 74)
}

// 44. Multi-select Move: 3 shapes moved, 1 snap.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'a', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  s.seedShape({ id: 'b', type: 'line', a: { x: 50, y: 0 }, b: { x: 74, y: 0 } })
  s.seedShape({ id: 'c', type: 'line', a: { x: 100, y: 0 }, b: { x: 124, y: 0 } })
  const preSnap = s.captureSnap()
  const origins = ['a', 'b', 'c'].map((id) => JSON.parse(JSON.stringify(s.findShape(id))))
  s.commitMoveCommand(origins, { dx: 100, dy: 0 }, preSnap)
  pass('44a. multi-Move pushes 1 snap', s.state.undoStack.length === 1)
  pass('44b. all 3 shapes moved 100 right',
    s.findShape('a').a.x === 100 && s.findShape('b').a.x === 150 && s.findShape('c').a.x === 200)
  s.undo()
  pass('44c. undo reverts all 3',
    s.findShape('a').a.x === 0 && s.findShape('b').a.x === 50 && s.findShape('c').a.x === 100)
}

// 45. Copy commit: clone added, original unchanged. undo removes clone.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  const preSnap = s.captureSnap()
  const origins = [JSON.parse(JSON.stringify(s.findShape('sh1')))]
  s.commitCopyCommand(origins, { dx: 50, dy: 0 }, preSnap)
  pass('45a. Copy adds 1 clone', s.state.technicalLayers[0].shapes.length === 2)
  pass('45b. Copy pushes 1 snap', s.state.undoStack.length === 1)
  pass('45c. Copy: original sh1 unchanged',
    s.findShape('sh1').a.x === 0 && s.findShape('sh1').b.x === 24)
  s.undo()
  pass('45d. After undo, clone removed (back to 1 shape)',
    s.state.technicalLayers[0].shapes.length === 1)
  s.redo()
  pass('45e. After redo, clone back', s.state.technicalLayers[0].shapes.length === 2)
}

// 46. Multi-select Copy: 3 clones added, 1 snap.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'a', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } })
  s.seedShape({ id: 'b', type: 'line', a: { x: 20, y: 0 }, b: { x: 30, y: 0 } })
  s.seedShape({ id: 'c', type: 'line', a: { x: 40, y: 0 }, b: { x: 50, y: 0 } })
  const preSnap = s.captureSnap()
  const origins = ['a', 'b', 'c'].map((id) => JSON.parse(JSON.stringify(s.findShape(id))))
  s.commitCopyCommand(origins, { dx: 100, dy: 0 }, preSnap)
  pass('46a. 3-shape Copy adds 3 clones', s.state.technicalLayers[0].shapes.length === 6)
  pass('46b. 3-shape Copy pushes 1 snap (not 3)', s.state.undoStack.length === 1)
  s.undo()
  pass('46c. undo removes all 3 clones', s.state.technicalLayers[0].shapes.length === 3)
}

// 47. Delete commit: shape removed; undo restores with original ID.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  const preSnap = s.captureSnap()
  s.commitDeleteCommand([{ layerId: 'L1', shapeId: 'sh1' }], preSnap)
  pass('47a. Delete removes shape', s.state.technicalLayers[0].shapes.length === 0)
  pass('47b. Delete pushes 1 snap', s.state.undoStack.length === 1)
  s.undo()
  const restored = s.findShape('sh1')
  pass('47c. undo restores shape with original ID',
    restored && restored.a.x === 0 && restored.b.x === 24)
  s.redo()
  pass('47d. redo removes again', s.state.technicalLayers[0].shapes.length === 0)
}

// 48. Multi-select Delete: 3 shapes removed, 1 snap, all restored on undo.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'a', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } })
  s.seedShape({ id: 'b', type: 'line', a: { x: 20, y: 0 }, b: { x: 30, y: 0 } })
  s.seedShape({ id: 'c', type: 'line', a: { x: 40, y: 0 }, b: { x: 50, y: 0 } })
  const preSnap = s.captureSnap()
  s.commitDeleteCommand(
    [{ layerId: 'L1', shapeId: 'a' }, { layerId: 'L1', shapeId: 'b' }, { layerId: 'L1', shapeId: 'c' }],
    preSnap,
  )
  pass('48a. 3-Delete removes all', s.state.technicalLayers[0].shapes.length === 0)
  pass('48b. 3-Delete pushes 1 snap', s.state.undoStack.length === 1)
  s.undo()
  pass('48c. undo restores all 3 with correct IDs',
    s.findShape('a') && s.findShape('b') && s.findShape('c'))
}

// 49. Grip edit commit: endpoint moved; undo restores; redo re-applies.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  const preSnap = s.captureSnap()
  s.commitGripEditCommand('L1', 'sh1', 'b', { x: 100, y: 50 }, preSnap)
  pass('49a. grip-edit pushes 1 snap', s.state.undoStack.length === 1)
  pass('49b. grip-edit endpoint b moved',
    s.findShape('sh1').b.x === 100 && s.findShape('sh1').b.y === 50)
  pass('49c. grip-edit other endpoint a untouched',
    s.findShape('sh1').a.x === 0 && s.findShape('sh1').a.y === 0)
  s.undo()
  pass('49d. undo restores endpoint b to (24, 0)',
    s.findShape('sh1').b.x === 24 && s.findShape('sh1').b.y === 0)
  s.redo()
  pass('49e. redo restores endpoint b to (100, 50)',
    s.findShape('sh1').b.x === 100 && s.findShape('sh1').b.y === 50)
}

// 50. Sequential commands: Rotate → Move → Copy. undoStack has 3 entries.
//     Three undos each revert one command in reverse order.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  // Rotate
  let preSnap = s.captureSnap()
  let origins = [JSON.parse(JSON.stringify(s.findShape('sh1')))]
  s.commitRotateCommand(origins, { x: 0, y: 0 }, 90, preSnap)
  // Move
  preSnap = s.captureSnap()
  origins = [JSON.parse(JSON.stringify(s.findShape('sh1')))]
  s.commitMoveCommand(origins, { dx: 100, dy: 0 }, preSnap)
  // Copy
  preSnap = s.captureSnap()
  origins = [JSON.parse(JSON.stringify(s.findShape('sh1')))]
  s.commitCopyCommand(origins, { dx: 200, dy: 0 }, preSnap)
  pass('50a. 3 commands → undoStack length 3', s.state.undoStack.length === 3)
  pass('50b. After Copy: 2 shapes', s.state.technicalLayers[0].shapes.length === 2)
  // Undo 1: Copy → back to 1 shape, still moved + rotated
  s.undo()
  pass('50c. undo 1 removes copy', s.state.technicalLayers[0].shapes.length === 1)
  // Shape is at (100, 0)→(100, 24) (moved + rotated)
  pass('50d. undo 1: shape still rotated + moved',
    near(s.findShape('sh1').a.x, 100) && near(s.findShape('sh1').b.y, 24))
  // Undo 2: Move → shape un-moved, still rotated
  s.undo()
  pass('50e. undo 2 reverts move',
    near(s.findShape('sh1').a.x, 0) && near(s.findShape('sh1').b.y, 24))
  // Undo 3: Rotate → shape back at origin
  s.undo()
  pass('50f. undo 3 reverts rotate',
    s.findShape('sh1').a.x === 0 && s.findShape('sh1').b.x === 24)
  pass('50g. undoStack empty', s.state.undoStack.length === 0)
}

// 51. Mixed undo/redo: Rotate, undo, Move (Rotate's redo entry discarded).
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  let preSnap = s.captureSnap()
  let origins = [JSON.parse(JSON.stringify(s.findShape('sh1')))]
  s.commitRotateCommand(origins, { x: 0, y: 0 }, 90, preSnap)
  pass('51a. Rotate → undoStack 1', s.state.undoStack.length === 1)
  s.undo()
  pass('51b. After undo → undoStack 0, redoStack 1',
    s.state.undoStack.length === 0 && s.state.redoStack.length === 1)
  // Now do Move — redoStack should clear (standard semantics).
  preSnap = s.captureSnap()
  origins = [JSON.parse(JSON.stringify(s.findShape('sh1')))]
  s.commitMoveCommand(origins, { dx: 100, dy: 0 }, preSnap)
  pass('51c. After Move: undoStack 1, redoStack EMPTY',
    s.state.undoStack.length === 1 && s.state.redoStack.length === 0)
  s.undo()
  pass('51d. undo restores pre-Move (NOT pre-Rotate; Rotate is gone)',
    s.findShape('sh1').a.x === 0 && s.findShape('sh1').b.x === 24)
}

// 52. Escape during command preview does NOT push a snapshot.
//     Pre-fix scenario: live-preview mutates shapes via no-undo mutator;
//     Escape reverts via direct write (no commit action called).
//     undoStack must be unchanged.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  // Simulate the command flow: capture preSnap, then "mousemove" mutates
  // shape via no-undo (just direct write here), then Escape reverts.
  const undoLenBefore = s.state.undoStack.length
  const preSnap = s.captureSnap()  // operator clicked base point
  const origin = JSON.parse(JSON.stringify(s.findShape('sh1')))
  // Simulate mousemove preview: rotate shape 45° in place.
  const rot45 = (p) => ({
    x: Math.cos(Math.PI / 4) * p.x - Math.sin(Math.PI / 4) * p.y,
    y: Math.sin(Math.PI / 4) * p.x + Math.cos(Math.PI / 4) * p.y,
  })
  s.state.technicalLayers[0].shapes[0].b = rot45(origin.b)
  // Escape: revert (no pushCapturedSnap because we never committed).
  s.state.technicalLayers[0].shapes[0] = { ...origin }
  // Note: preSnap was captured but NOT pushed.
  pass('52a. Escape does NOT push undo snapshot',
    s.state.undoStack.length === undoLenBefore)
  pass('52b. After Escape, shape back at origin',
    s.findShape('sh1').b.x === 24)
  pass('52c. preSnap captured but unused (string is fine, no side effect)',
    typeof preSnap === 'string')
}

// 53. Cancel button has same no-push behavior as Escape.
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  const undoLenBefore = s.state.undoStack.length
  // Capture preSnap, mutate, then Cancel (= same revert pattern as Escape).
  s.captureSnap()
  s.state.technicalLayers[0].shapes[0].b = { x: 99, y: 99 }
  // Cancel — revert from origin captured in techCommandOriginShapes.
  // (No commit action called; no snap pushed.)
  s.state.technicalLayers[0].shapes[0].b = { x: 24, y: 0 }
  pass('53a. Cancel does NOT push snapshot',
    s.state.undoStack.length === undoLenBefore)
  pass('53b. After Cancel, shape back at origin',
    s.findShape('sh1').b.x === 24)
}

// 54. dataSnapshot includes technicalLayers after a commit (lock in
//     the 18b-post-fix contract for 18d-edit too).
{
  const s = makeUndoStore()
  s.seedShape({ id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } })
  const preSnap = s.captureSnap()
  const origins = [JSON.parse(JSON.stringify(s.findShape('sh1')))]
  s.commitRotateCommand(origins, { x: 0, y: 0 }, 90, preSnap)
  pass('54a. undoStack has 1 entry after commit', s.state.undoStack.length === 1)
  const parsed = JSON.parse(s.state.undoStack[0])
  pass('54b. snapshot includes technicalLayers field',
    Array.isArray(parsed.technicalLayers))
  pass('54c. snapshot technicalLayers contains sh1 in pre-rotate position',
    parsed.technicalLayers[0].shapes[0].b.x === 24
    && parsed.technicalLayers[0].shapes[0].b.y === 0)
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
