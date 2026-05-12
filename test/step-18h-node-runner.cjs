// Node-side runner for Phase 2 sub-step 18h block tests.
//
// 18h ships the Technical Drawing preview overlay + async PDF generation
// pipeline against kcc-shop-drawing.py v1.1. Tests cover:
//
//   A. kccProxy URL composition (5 tests)
//   B. specTableJSON payload shape (12 tests)
//   C. shopDrawingSvgMath (math helpers, no JSX) (15 tests)
//   D. pdfAsyncPipeline pure helpers (7 tests)
//   E. pdfAsyncPipeline runShopDrawingPdf with mock fetch (7 tests)
//   F. Store slice actions (8 tests)
//   G. Filename slugify edge cases (5 tests)
//   H. Reachability gates — source-grep on App.jsx + DrawingTools.jsx +
//      TechnicalPreview.jsx (8 tests)
//
// Same eval-shim approach as step-18e + step-18g runners. globalThis
// fetch + localStorage mocked for the pipeline tests.

const path = require('path')
const fs = require('fs')

function loadModule(relpath, returnNames, preamble) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', relpath),
    'utf-8'
  )
  const transformed = src
    // Strip multi-line `import { ... } from '...'` blocks
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    // Strip single-line imports (default + namespace)
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/export\s+function/g, 'function')
    .replace(/export\s+const/g, 'const')
    .replace(/export\s+async\s+function/g, 'async function')
    .replace(/^export\s+\{[^}]+\}\s*;?\s*$/gm, '')  // strip re-export blocks
  const body = (preamble || '') + '\n' + transformed
  const factory = new Function(`${body}\nreturn { ${returnNames.join(', ')} }`)
  return factory()
}

// kccProxy uses import.meta.env which evaluates differently in Node.
// Stub it at the preamble level.
const kccProxyPreamble = `
  const import_meta = { env: {} }
  // Replace 'import.meta' references with the local stub.
`

// Stub import.meta.env reference inside kccProxy by source replacement
// before eval — Node can't parse `import.meta` at module-level when
// not in a true ES module. We rewrite to a guarded ternary referring
// to globalThis.
function loadKccProxy() {
  let src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'utils', 'kccProxy.js'),
    'utf-8'
  )
  src = src
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/export\s+const/g, 'const')
  // Replace `import.meta.env.X` with a globalThis lookup so the shim
  // can swap the env at runtime via globalThis.__VITE_ENV.
  src = src.replace(/typeof import\.meta !== 'undefined'\s*&&\s*import\.meta\.env\s*&&\s*import\.meta\.env\.VITE_KCC_PROXY_BASE_URL/g,
    "(globalThis.__VITE_ENV && globalThis.__VITE_ENV.VITE_KCC_PROXY_BASE_URL)")
  const factory = new Function(`${src}\nreturn { PROXY_BASE_URL, ASYNC_SUBMIT_URL, ASYNC_STATUS_URL, ASYNC_FETCH_URL, SYNC_CLAUDE_URL }`)
  return factory()
}

// Load each module via the appropriate shim path.
const {
  rotateGeometry, computeBbox, computeFitTransform, makeTxPt,
  KCC_NAVY, KCC_ORANGE, DIM_AMBER, GRID_LIGHT,
} = loadModule(
  'src/utils/shopDrawingSvgMath.js',
  [
    'rotateGeometry', 'computeBbox', 'computeFitTransform', 'makeTxPt',
    'KCC_NAVY', 'KCC_ORANGE', 'DIM_AMBER', 'GRID_LIGHT',
  ],
)

// specTableValidation provides SPEC_TABLE_FIELDS — seed it for the
// specTableJSON shim load.
const {
  SPEC_TABLE_FIELDS, emptySpecTable,
} = loadModule(
  'src/utils/specTableValidation.js',
  ['SPEC_TABLE_FIELDS', 'emptySpecTable'],
)

const specTableJSONPreamble = `
  const SPEC_TABLE_FIELDS = ${JSON.stringify(SPEC_TABLE_FIELDS)}
`
const {
  buildShopDrawingPayload, slugify, shopDrawingFilename,
} = loadModule(
  'src/utils/specTableJSON.js',
  ['buildShopDrawingPayload', 'slugify', 'shopDrawingFilename'],
  specTableJSONPreamble,
)

// pdfAsyncPipeline depends on kccProxy. Seed kccProxy URL constants.
const pipelinePreamble = `
  const ASYNC_SUBMIT_URL = 'https://kcc-proxy.netlify.app/api/claude-async-submit'
  const ASYNC_STATUS_URL = 'https://kcc-proxy.netlify.app/api/claude-async-status'
  const ASYNC_FETCH_URL  = 'https://kcc-proxy.netlify.app/api/claude-async-fetch'
`
const {
  FF5B_START, FF5B_END,
  PDF_MODEL, PDF_MAX_TOKENS, PDF_BETA,
  POLL_BASE_MS, POLL_JITTER_MS, POLL_MAX, POLL_WARN_AT_SEC,
  buildPdfPrompt, buildSubmitPayload, pollDelay,
  runShopDrawingPdf,
} = loadModule(
  'src/utils/pdfAsyncPipeline.js',
  [
    'FF5B_START', 'FF5B_END',
    'PDF_MODEL', 'PDF_MAX_TOKENS', 'PDF_BETA',
    'POLL_BASE_MS', 'POLL_JITTER_MS', 'POLL_MAX', 'POLL_WARN_AT_SEC',
    'buildPdfPrompt', 'buildSubmitPayload', 'pollDelay',
    'runShopDrawingPdf',
  ],
  pipelinePreamble,
)

const tests = []
function pass(name, ok, extra) {
  tests.push({ name, ok: !!ok, extra })
}
function near(a, b, tol) {
  return Math.abs(a - b) < (tol || 0.001)
}

// ============================================================================
// BLOCK A — kccProxy URL composition (1-5)
// ============================================================================

// 1. Default base URL (no env override) — read by source-eval with empty env.
{
  globalThis.__VITE_ENV = {}
  const proxy = loadKccProxy()
  pass('1a. Default PROXY_BASE_URL is https://kcc-proxy.netlify.app',
    proxy.PROXY_BASE_URL === 'https://kcc-proxy.netlify.app')
  pass('1b. Default ASYNC_SUBMIT_URL composed correctly',
    proxy.ASYNC_SUBMIT_URL === 'https://kcc-proxy.netlify.app/api/claude-async-submit')
  pass('1c. Default ASYNC_STATUS_URL composed correctly',
    proxy.ASYNC_STATUS_URL === 'https://kcc-proxy.netlify.app/api/claude-async-status')
  pass('1d. Default ASYNC_FETCH_URL composed correctly',
    proxy.ASYNC_FETCH_URL === 'https://kcc-proxy.netlify.app/api/claude-async-fetch')
}

// 2. Env-var override — VITE_KCC_PROXY_BASE_URL changes all 4 URLs.
{
  globalThis.__VITE_ENV = { VITE_KCC_PROXY_BASE_URL: 'https://staging.example.com' }
  const proxy = loadKccProxy()
  pass('2a. Override changes PROXY_BASE_URL',
    proxy.PROXY_BASE_URL === 'https://staging.example.com')
  pass('2b. Override propagates to SUBMIT',
    proxy.ASYNC_SUBMIT_URL === 'https://staging.example.com/api/claude-async-submit')
  // Restore default for subsequent tests
  globalThis.__VITE_ENV = {}
}

// ============================================================================
// BLOCK B — specTableJSON payload shape (3-14)
// ============================================================================

function mkStoreState(overrides) {
  return Object.assign({
    specTable: { ...emptySpecTable(), partName: 'Test Part', material: 'Test', drawingNo: 'D-001' },
    technicalLayers: [],
  }, overrides || {})
}

// 3. Empty store → payload has 9 spec fields, empty layers, defaults.
{
  const p = buildShopDrawingPayload(mkStoreState(), {})
  pass('3a. payload.specTable has 9 fields',
    Object.keys(p.specTable).length === 9)
  pass('3b. payload.layers is array', Array.isArray(p.layers))
  pass('3c. drawingType defaults to profile', p.drawingType === 'profile')
  pass('3d. internalScale === 24', p.internalScale === 24)
  pass('3e. pageOrientation defaults to landscape', p.pageOrientation === 'landscape')
  pass('3f. geometryRotation defaults to 0', p.geometryRotation === 0)
  pass('3g. fitMode defaults to auto', p.fitMode === 'auto')
  pass('3h. customScale defaults to 1.0', p.customScale === 1.0)
}

// 4. Preview controls override defaults.
{
  const p = buildShopDrawingPayload(mkStoreState(), {
    pageOrientation: 'portrait',
    geometryRotation: 90,
    fitMode: 'custom',
    customScale: 0.5,
  })
  pass('4a. pageOrientation override applied', p.pageOrientation === 'portrait')
  pass('4b. geometryRotation override applied', p.geometryRotation === 90)
  pass('4c. fitMode override applied', p.fitMode === 'custom')
  pass('4d. customScale override applied', p.customScale === 0.5)
}

// 5. Invalid preview-control values fall back to defaults.
{
  const p = buildShopDrawingPayload(mkStoreState(), {
    pageOrientation: 'square',
    geometryRotation: 45,
    fitMode: 'auto-fit',
    customScale: -1,
  })
  pass('5a. Invalid orientation → landscape', p.pageOrientation === 'landscape')
  pass('5b. Invalid rotation → 0', p.geometryRotation === 0)
  pass('5c. Invalid fitMode → auto', p.fitMode === 'auto')
  pass('5d. Negative customScale → 1.0', p.customScale === 1.0)
}

// 6. Layer + shape stripping — IDs dropped, geometry kept.
{
  const store = mkStoreState({
    technicalLayers: [{
      id: 'L1', visible: true, name: 'Layer 1', color: '#1A2F4A', order: 0,
      shapes: [
        { id: 'sh1', type: 'line', a: { x: 0, y: 0 }, b: { x: 24, y: 0 } },
        { id: 'p1', type: 'poly', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
      ],
    }],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('6a. Layer.id stripped from output',
    !('id' in p.layers[0]))
  pass('6b. Layer.visible stripped', !('visible' in p.layers[0]))
  pass('6c. Layer.name preserved', p.layers[0].name === 'Layer 1')
  pass('6d. Layer.color preserved', p.layers[0].color === '#1A2F4A')
  // 18h Bug 1 fix (May 12 2026): stripShape now bridges the canonical
  // RoofMark tech-line {a, b} → v1.1 pts[] form, so the {a,b} line in
  // the fixture above DOES survive with a 2-point pts array. Block J
  // below exercises the bridge in isolation with a commitTechLine-shaped
  // fixture.
}

// 7. Invisible layers are filtered out.
{
  const store = mkStoreState({
    technicalLayers: [
      { id: 'L1', visible: true, name: 'A', shapes: [], dimensions: [], callouts: [] },
      { id: 'L2', visible: false, name: 'B', shapes: [], dimensions: [], callouts: [] },
    ],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('7. Invisible layer filtered',
    p.layers.length === 1 && p.layers[0].name === 'A')
}

// 8. Dimension shape converted to v1.1 dimension contract.
{
  const dim = {
    id: 'd1',
    type: 'dimension',
    dimType: 'aligned',
    orientation: 'aligned',
    pointA: { mode: 'free', x: 0,  y: 0,  shapeId: null, pointKey: null },
    pointB: { mode: 'free', x: 24, y: 0,  shapeId: null, pointKey: null },
    offset: 24,
  }
  const store = mkStoreState({
    technicalLayers: [{
      id: 'L1', visible: true, name: 'A', order: 0,
      shapes: [dim], dimensions: [], callouts: [],
    }],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('8a. Dimension lifted to layer.dimensions[]',
    p.layers[0].dimensions.length === 1)
  pass('8b. Dimension x1/y1/x2/y2 populated',
    p.layers[0].dimensions[0].x1 === 0 && p.layers[0].dimensions[0].x2 === 24)
  pass('8c. Dimension carries pxDist',
    p.layers[0].dimensions[0].pxDist === 24)
}

// ============================================================================
// BLOCK C — shopDrawingSvgMath (rotateGeometry, computeBbox, computeFitTransform)
// (9-23)
// ============================================================================

// 9. computeBbox on simple poly.
{
  const layers = [{
    shapes: [{ type: 'poly', pts: [{ x: 0, y: 0 }, { x: 100, y: 50 }] }],
    dimensions: [], callouts: [],
  }]
  const bbox = computeBbox(layers)
  pass('9. computeBbox simple poly: 0,0 → 100,50',
    bbox.minX === 0 && bbox.minY === 0 && bbox.maxX === 100 && bbox.maxY === 50)
}

// 10. computeBbox includes circles + their radius.
{
  const layers = [{
    shapes: [{ type: 'circ', cx: 50, cy: 50, r: 10 }],
    dimensions: [], callouts: [],
  }]
  const bbox = computeBbox(layers)
  pass('10. computeBbox includes circle radius extent',
    bbox.minX === 40 && bbox.minY === 40 && bbox.maxX === 60 && bbox.maxY === 60)
}

// 11. computeBbox includes dimensions + callouts.
{
  const layers = [{
    shapes: [],
    dimensions: [{ x1: 0, y1: 0, x2: 100, y2: 0 }],
    callouts: [{ tipX: -10, tipY: -10, tailX: 50, tailY: 50 }],
  }]
  const bbox = computeBbox(layers)
  pass('11. computeBbox spans dim + callout',
    bbox.minX === -10 && bbox.minY === -10 && bbox.maxX === 100 && bbox.maxY === 50)
}

// 12. computeBbox on empty → null.
{
  pass('12a. Empty layers → null', computeBbox([]) === null)
  pass('12b. Null layers → null', computeBbox(null) === null)
}

// 13. rotateGeometry 0° is a no-op.
{
  const layers = [{
    shapes: [{ type: 'poly', pts: [{ x: 1, y: 2 }] }],
    dimensions: [], callouts: [],
  }]
  const out = rotateGeometry(layers, 0)
  pass('13. rotateGeometry(0°) returns same layers',
    out === layers)
}

// 14. rotateGeometry 90° CW around bbox centroid.
{
  // Square 0..100 x 0..100, centroid (50, 50)
  const layers = [{
    shapes: [{ type: 'poly', pts: [
      { x: 0,   y: 0   },
      { x: 100, y: 0   },
      { x: 100, y: 100 },
      { x: 0,   y: 100 },
    ] }],
    dimensions: [], callouts: [],
  }]
  const out = rotateGeometry(layers, 90)
  // 90° CW: (x, y) → (cx + (y - cy), cy - (x - cx))
  //   (0,0)   → (50 + (-50), 50 - (-50)) = (0, 100)
  //   (100,0) → (50 + (-50), 50 - (50))  = (0, 0)
  //   (100,100)→ (50 + (50),  50 - (50)) = (100, 0)
  //   (0,100) → (50 + (50),  50 - (-50)) = (100, 100)
  const pts = out[0].shapes[0].pts
  pass('14a. 90°CW (0,0) → (0,100)',
    near(pts[0].x, 0) && near(pts[0].y, 100))
  pass('14b. 90°CW (100,0) → (0,0)',
    near(pts[1].x, 0) && near(pts[1].y, 0))
  pass('14c. 90°CW (100,100) → (100,0)',
    near(pts[2].x, 100) && near(pts[2].y, 0))
}

// 15. rotateGeometry 180° → (2cx - x, 2cy - y).
{
  const layers = [{
    shapes: [{ type: 'poly', pts: [
      { x: 0, y: 0 }, { x: 100, y: 100 },
    ] }],
    dimensions: [], callouts: [],
  }]
  const out = rotateGeometry(layers, 180)
  // bbox centroid (50,50); (0,0) → (100,100); (100,100) → (0,0)
  const pts = out[0].shapes[0].pts
  pass('15a. 180° flips diagonals',
    near(pts[0].x, 100) && near(pts[0].y, 100))
  pass('15b. 180° flips other diagonal',
    near(pts[1].x, 0) && near(pts[1].y, 0))
}

// 16. rotateGeometry 270° CW = 90° CCW.
{
  const layers = [{
    shapes: [{ type: 'poly', pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }],
    dimensions: [], callouts: [],
  }]
  const out = rotateGeometry(layers, 270)
  // 270° CW: (x, y) → (cx - (y - cy), cy + (x - cx))
  // centroid (50, 0); (0,0)→(50 - 0, 0 + (-50))=(50,-50); (100,0)→(50-0, 0+50)=(50,50)
  const pts = out[0].shapes[0].pts
  pass('16a. 270°CW (0,0) → (50,-50)',
    near(pts[0].x, 50) && near(pts[0].y, -50))
  pass('16b. 270°CW (100,0) → (50,50)',
    near(pts[1].x, 50) && near(pts[1].y, 50))
}

// 17. rotateGeometry rotates dimensions + callouts too.
{
  const layers = [{
    shapes: [],
    dimensions: [{ x1: 0, y1: 0, x2: 100, y2: 0 }],
    callouts: [{ tipX: 0, tipY: 0, tailX: 50, tailY: 0 }],
  }]
  const out = rotateGeometry(layers, 90)
  pass('17a. Dimension x1 rotated',
    typeof out[0].dimensions[0].x1 === 'number'
    && out[0].dimensions[0].x1 !== 0)
  pass('17b. Callout tipX rotated',
    typeof out[0].callouts[0].tipX === 'number'
    && out[0].callouts[0].tipX !== 0)
}

// 18. computeFitTransform auto mode fills the area.
{
  const bbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  const t = computeFitTransform(bbox, 500, 500, 'auto', 1)
  // 5% inset of min(500,500) = 25; fit area = 450x450; scale = 450/100 = 4.5
  pass('18a. auto scale ≈ 4.5',
    near(t.scale, 4.5))
  pass('18b. auto overflow false', t.overflow === false)
}

// 19. computeFitTransform 1:1 mode at scale 96/24 = 4.0.
{
  const bbox = { minX: 0, minY: 0, maxX: 24, maxY: 24 }
  const t = computeFitTransform(bbox, 500, 500, '1:1', 1)
  pass('19a. 1:1 scale === 4.0', t.scale === 4.0)
  pass('19b. 1:1 small geom doesn’t overflow', t.overflow === false)
}

// 20. computeFitTransform 1:1 overflow flag set when geom too big.
{
  const bbox = { minX: 0, minY: 0, maxX: 200, maxY: 200 }  // 200*4 = 800 > 450 fit area
  const t = computeFitTransform(bbox, 500, 500, '1:1', 1)
  pass('20. 1:1 overflow flag fires on oversize geom', t.overflow === true)
}

// 21. computeFitTransform custom scale.
{
  const bbox = { minX: 0, minY: 0, maxX: 24, maxY: 24 }
  const t = computeFitTransform(bbox, 500, 500, 'custom', 0.5)
  pass('21. custom scale = 4.0 * 0.5 = 2.0', t.scale === 2.0)
}

// 22. computeFitTransform null bbox returns identity scale, no overflow.
{
  const t = computeFitTransform(null, 500, 500, 'auto', 1)
  pass('22a. null bbox scale 1', t.scale === 1)
  pass('22b. null bbox no overflow', t.overflow === false)
}

// 23. makeTxPt y-flip baked in.
{
  const txPt = makeTxPt(2, 100, 200)
  // (x=10, y=20) → (100 + 10*2, 200 - 20*2) = (120, 160)
  const [sx, sy] = txPt(10, 20)
  pass('23a. txPt x = tx + x*scale', sx === 120)
  pass('23b. txPt y = ty - y*scale (y-flip)', sy === 160)
}

// ============================================================================
// BLOCK D — pdfAsyncPipeline pure helpers (24-30)
// ============================================================================

// 24. FF5B marker constants match the proxy contract.
pass('24a. FF5B_START matches proxy', FF5B_START === '# <<FF5B_TEMPLATE_START>>')
pass('24b. FF5B_END matches proxy',   FF5B_END   === '# <<FF5B_TEMPLATE_END>>')

// 25. PDF model + max_tokens + beta header constants.
pass('25a. PDF_MODEL === claude-sonnet-4-20250514', PDF_MODEL === 'claude-sonnet-4-20250514')
pass('25b. PDF_MAX_TOKENS === 8000', PDF_MAX_TOKENS === 8000)
pass('25c. PDF_BETA contains code-execution beta',
  PDF_BETA.includes('code-execution-2025-08-25'))

// 26. Poll constants.
pass('26a. POLL_BASE_MS === 4000', POLL_BASE_MS === 4000)
pass('26b. POLL_JITTER_MS === 500', POLL_JITTER_MS === 500)
pass('26c. POLL_MAX === 75', POLL_MAX === 75)
pass('26d. POLL_WARN_AT_SEC === 90', POLL_WARN_AT_SEC === 90)

// 27. buildPdfPrompt embeds script between FF5B markers in python fence.
{
  const prompt = buildPdfPrompt('# fake script\nprint("hi")', { a: 1 }, 'out.pdf')
  pass('27a. Prompt contains ```python fence', prompt.includes('```python'))
  pass('27b. Prompt contains FF5B_START', prompt.includes(FF5B_START))
  pass('27c. Prompt contains FF5B_END', prompt.includes(FF5B_END))
  pass('27d. Prompt contains script body', prompt.includes('# fake script'))
  pass('27e. Prompt contains JSON fence', prompt.includes('```json'))
  pass('27f. Prompt names filename', prompt.includes('out.pdf'))
}

// 28. buildSubmitPayload shape matches proxy contract.
{
  const p = buildSubmitPayload('prompt-text', 'out.pdf')
  pass('28a. payload.model set', p.model === PDF_MODEL)
  pass('28b. payload.max_tokens set', p.max_tokens === PDF_MAX_TOKENS)
  pass('28c. payload.tools includes code_execution_20250825',
    p.tools[0].type === 'code_execution_20250825')
  pass('28d. payload.messages[0].role === user', p.messages[0].role === 'user')
  pass('28e. payload.messages[0].content is the prompt',
    p.messages[0].content === 'prompt-text')
  pass('28f. payload.filename echoed back', p.filename === 'out.pdf')
}

// 29. pollDelay stays within ±jitter band.
{
  let allInRange = true
  for (let i = 0; i < 100; i++) {
    const d = pollDelay(4000, 500)
    if (d < 3500 || d > 4500) { allInRange = false; break }
  }
  pass('29. pollDelay always in [base-jitter, base+jitter]', allInRange)
}

// 30. pollDelay accepts injected rand for determinism.
{
  const d = pollDelay(4000, 500, () => 0)   // → base - jitter = 3500
  pass('30a. pollDelay(rand=0) === 3500', d === 3500)
  const d2 = pollDelay(4000, 500, () => 1)  // → base + jitter = 4500
  pass('30b. pollDelay(rand=1) === 4500', d2 === 4500)
}

// ============================================================================
// BLOCK E — runShopDrawingPdf integration (mock fetch) (31-37)
// ============================================================================

// Mock fetch helper. Sequence-driven: each call peels the next entry off
// the queue. Test fixture queues all 3 phases' responses upfront.
function mockFetch(queue) {
  return async (url, opts) => {
    const entry = queue.shift()
    if (!entry) throw new Error('mock fetch ran out of responses')
    if (entry.url && !url.includes(entry.url)) {
      throw new Error('mock fetch URL mismatch: expected ' + entry.url + ' got ' + url)
    }
    return {
      ok: entry.ok !== false,
      status: entry.status || 200,
      statusText: entry.statusText || 'OK',
      json: async () => entry.json,
      blob: async () => entry.blob,
      text: async () => entry.text || JSON.stringify(entry.json || {}),
    }
  }
}

// 31. Happy path: submit → poll (pending → done) → fetch → blob.
{
  const fakeBlob = { size: 1234, type: 'application/pdf' }
  const queue = [
    { url: 'claude-async-submit', json: { job_id: 'abc-123' } },
    { url: 'claude-async-status', json: { status: 'pending' } },
    { url: 'claude-async-status', json: { status: 'done', filename: 'out.pdf' } },
    { url: 'claude-async-fetch',  blob: fakeBlob },
  ]
  const progressEvents = []
  ;(async () => {
    try {
      const blob = await runShopDrawingPdf({
        data: { foo: 1 },
        scriptSource: '# script',
        filename: 'out.pdf',
        onProgress: (e) => progressEvents.push(e),
        fetchImpl: mockFetch(queue),
        rand: () => 0,  // delay = 3500 ms — but we wait via setTimeout
      })
      pass('31a. runShopDrawingPdf returns blob', blob === fakeBlob)
      pass('31b. progress: submitting fired',
        progressEvents.some((e) => e.phase === 'submitting'))
      pass('31c. progress: submitted fired with jobId',
        progressEvents.some((e) => e.phase === 'submitted' && e.jobId === 'abc-123'))
      pass('31d. progress: fetching fired',
        progressEvents.some((e) => e.phase === 'fetching'))
    } catch (e) {
      pass('31a. runShopDrawingPdf returns blob (failed: ' + e.message + ')', false)
    }
  })()
  // Note: top-level await isn't available in CommonJS. The test loop
  // runs after this async IIFE schedules; we wait via a sentinel below.
}

// 32. Submit-error path: 500 from proxy → throws.
{
  const queue = [{ url: 'claude-async-submit', ok: false, status: 500, json: { error: 'boom' } }]
  ;(async () => {
    try {
      await runShopDrawingPdf({
        data: {}, scriptSource: 's', filename: 'f.pdf',
        fetchImpl: mockFetch(queue),
      })
      pass('32. Submit 500 → throws', false)
    } catch (e) {
      pass('32. Submit 500 → throws',
        e.message.includes('Submit failed') && e.message.includes('500'))
    }
  })()
}

// 33. Status-error path: server returns status='error'.
{
  const queue = [
    { url: 'claude-async-submit', json: { job_id: 'x' } },
    { url: 'claude-async-status', json: { status: 'error', error_detail: 'fake detail' } },
  ]
  ;(async () => {
    try {
      await runShopDrawingPdf({
        data: {}, scriptSource: 's', filename: 'f.pdf',
        fetchImpl: mockFetch(queue),
        rand: () => 0,
      })
      pass('33. status=error → throws', false)
    } catch (e) {
      pass('33. status=error → throws with detail',
        e.message.includes('PDF generation failed') && e.message.includes('fake detail'))
    }
  })()
}

// 34. Missing data param → throws.
{
  ;(async () => {
    try {
      await runShopDrawingPdf({
        data: null, scriptSource: 's', filename: 'f.pdf', fetchImpl: () => {},
      })
      pass('34. missing data → throws', false)
    } catch (e) {
      pass('34. missing data → throws', e.message === 'Missing data')
    }
  })()
}

// 35. Missing scriptSource → throws.
{
  ;(async () => {
    try {
      await runShopDrawingPdf({
        data: {}, scriptSource: '', filename: 'f.pdf', fetchImpl: () => {},
      })
      pass('35. missing scriptSource → throws', false)
    } catch (e) {
      pass('35. missing scriptSource → throws', e.message === 'Missing scriptSource')
    }
  })()
}

// 36. Missing filename → throws.
{
  ;(async () => {
    try {
      await runShopDrawingPdf({
        data: {}, scriptSource: 's', filename: '', fetchImpl: () => {},
      })
      pass('36. missing filename → throws', false)
    } catch (e) {
      pass('36. missing filename → throws', e.message === 'Missing filename')
    }
  })()
}

// 37. Transient poll error retries (not abort).
{
  const fakeBlob = { size: 1, type: 'application/pdf' }
  const queue = [
    { url: 'claude-async-submit', json: { job_id: 'r-1' } },
    // First status poll: network error (fetch throws)
    { url: 'claude-async-status', json: null, _throwError: true },
    // Second status poll: HTTP 500
    { url: 'claude-async-status', ok: false, status: 500, json: { error: 'transient' } },
    // Third status poll: success
    { url: 'claude-async-status', json: { status: 'done', filename: 'f.pdf' } },
    { url: 'claude-async-fetch', blob: fakeBlob },
  ]
  const mockedFetch = async (url) => {
    const entry = queue.shift()
    if (!entry) throw new Error('out of responses')
    if (entry._throwError) throw new Error('network error')
    return {
      ok: entry.ok !== false,
      status: entry.status || 200,
      json: async () => entry.json,
      blob: async () => entry.blob,
      text: async () => JSON.stringify(entry.json || {}),
    }
  }
  ;(async () => {
    try {
      const blob = await runShopDrawingPdf({
        data: {}, scriptSource: 's', filename: 'f.pdf',
        fetchImpl: mockedFetch, rand: () => 0,
      })
      pass('37. Transient poll errors retried, eventual success',
        blob === fakeBlob)
    } catch (e) {
      pass('37. Transient poll errors retried (failed: ' + e.message + ')', false)
    }
  })()
}

// ============================================================================
// BLOCK F — Store slice actions (mirror via mock) (38-45)
// ============================================================================

function makeMockStore() {
  const state = {
    previewState: {
      isOpen: false,
      pageOrientation: 'landscape',
      geometryRotation: 0,
      fitMode: 'auto',
      customScale: 1.0,
    },
    pdfJob: { phase: 'idle', error: null, elapsedSec: 0, warning: false, filename: null },
  }
  return {
    state,
    openPreview: () => { state.previewState = { ...state.previewState, isOpen: true } },
    closePreview: () => { state.previewState = { ...state.previewState, isOpen: false } },
    setPageOrientation: (o) => {
      if (o !== 'landscape' && o !== 'portrait') return
      state.previewState = { ...state.previewState, pageOrientation: o }
    },
    cycleRotation: () => {
      const order = [0, 90, 180, 270]
      const idx = order.indexOf(state.previewState.geometryRotation)
      const next = order[(idx + 1) % order.length]
      state.previewState = { ...state.previewState, geometryRotation: next }
    },
    setFitMode: (m) => {
      if (m !== 'auto' && m !== '1:1' && m !== 'custom') return
      state.previewState = { ...state.previewState, fitMode: m }
    },
    setCustomScale: (n) => {
      const v = Number(n)
      if (!Number.isFinite(v) || v <= 0) return
      state.previewState = { ...state.previewState, customScale: v }
    },
    setPdfJob: (patch) => {
      if (!patch || typeof patch !== 'object') return
      state.pdfJob = { ...state.pdfJob, ...patch }
    },
    resetPdfJob: () => {
      state.pdfJob = { phase: 'idle', error: null, elapsedSec: 0, warning: false, filename: null }
    },
  }
}

// 38. openPreview / closePreview toggles isOpen.
{
  const s = makeMockStore()
  s.openPreview()
  pass('38a. openPreview → isOpen true', s.state.previewState.isOpen === true)
  s.closePreview()
  pass('38b. closePreview → isOpen false', s.state.previewState.isOpen === false)
}

// 39. setPageOrientation accepts only landscape / portrait.
{
  const s = makeMockStore()
  s.setPageOrientation('portrait')
  pass('39a. portrait accepted', s.state.previewState.pageOrientation === 'portrait')
  s.setPageOrientation('square')
  pass('39b. square rejected (still portrait)', s.state.previewState.pageOrientation === 'portrait')
}

// 40. cycleRotation goes 0 → 90 → 180 → 270 → 0.
{
  const s = makeMockStore()
  s.cycleRotation()
  pass('40a. 0 → 90', s.state.previewState.geometryRotation === 90)
  s.cycleRotation(); s.cycleRotation(); s.cycleRotation()
  pass('40b. 90 → 180 → 270 → 0 cycle complete',
    s.state.previewState.geometryRotation === 0)
}

// 41. setFitMode validates against locked set.
{
  const s = makeMockStore()
  s.setFitMode('1:1')
  pass('41a. 1:1 accepted', s.state.previewState.fitMode === '1:1')
  s.setFitMode('garbage')
  pass('41b. garbage rejected', s.state.previewState.fitMode === '1:1')
}

// 42. setCustomScale rejects non-positive or non-numeric.
{
  const s = makeMockStore()
  s.setCustomScale(2.5)
  pass('42a. 2.5 accepted', s.state.previewState.customScale === 2.5)
  s.setCustomScale(0)
  pass('42b. 0 rejected', s.state.previewState.customScale === 2.5)
  s.setCustomScale(-1)
  pass('42c. negative rejected', s.state.previewState.customScale === 2.5)
  s.setCustomScale('abc')
  pass('42d. non-numeric rejected', s.state.previewState.customScale === 2.5)
}

// 43. setPdfJob merges patch into pdfJob.
{
  const s = makeMockStore()
  s.setPdfJob({ phase: 'polling', elapsedSec: 12.3 })
  pass('43a. phase merged', s.state.pdfJob.phase === 'polling')
  pass('43b. elapsedSec merged', s.state.pdfJob.elapsedSec === 12.3)
  pass('43c. unchanged fields preserved', s.state.pdfJob.error === null)
}

// 44. resetPdfJob clears all fields.
{
  const s = makeMockStore()
  s.setPdfJob({ phase: 'error', error: 'oops' })
  s.resetPdfJob()
  pass('44. resetPdfJob clears to idle',
    s.state.pdfJob.phase === 'idle' && s.state.pdfJob.error === null)
}

// 45. preview state defaults match v1.1 Python defaults.
{
  const s = makeMockStore()
  pass('45a. default pageOrientation === landscape',
    s.state.previewState.pageOrientation === 'landscape')
  pass('45b. default geometryRotation === 0',
    s.state.previewState.geometryRotation === 0)
  pass('45c. default fitMode === auto',
    s.state.previewState.fitMode === 'auto')
  pass('45d. default customScale === 1.0',
    s.state.previewState.customScale === 1.0)
}

// ============================================================================
// BLOCK G — Filename slug edge cases (46-50)
// ============================================================================

// 46. Slug standard input.
pass('46. slugify("Gateway Top Transition") → "Gateway-Top-Transition"',
  slugify('Gateway Top Transition') === 'Gateway-Top-Transition')

// 47. Slug strips invalid chars.
pass('47. slugify("Foo/Bar*Baz") strips slashes/asterisks',
  slugify('Foo/Bar*Baz') === 'FooBarBaz')

// 48. Double hyphens collapsed.
pass('48. slugify("Foo--Bar") → "Foo-Bar"',
  slugify('Foo--Bar') === 'Foo-Bar')

// 49. Trim leading/trailing hyphens-underscores.
pass('49. slugify("-Foo-") → "Foo"', slugify('-Foo-') === 'Foo')

// 50. Empty / null / undefined → "untitled".
pass('50a. slugify("") → "untitled"', slugify('') === 'untitled')
pass('50b. slugify(null) → "untitled"', slugify(null) === 'untitled')
pass('50c. slugify(undefined) → "untitled"', slugify(undefined) === 'untitled')

// 51. shopDrawingFilename composes correctly.
pass('51. shopDrawingFilename uses [drawingNo]_[partName-slug].pdf',
  shopDrawingFilename({ drawingNo: 'KCC-001', partName: 'Eave Metal' })
    === 'KCC-001_Eave-Metal.pdf')

// ============================================================================
// BLOCK H — Reachability gates (Rule 28) — source-grep regressions (52-59)
// ============================================================================

const techPreviewSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'TechnicalPreview.jsx'),
  'utf-8',
)
const drawingToolsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'DrawingTools.jsx'),
  'utf-8',
)
const appJsxSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'App.jsx'),
  'utf-8',
)

// 52. Preview button exists in DrawingTools (UI access path).
pass('52a. DrawingTools has Preview button data-testid',
  drawingToolsSrc.includes('btn-tech-preview'))
pass('52b. Preview button is inside the TECHNICAL appMode gate',
  /appMode === 'TECHNICAL'[\s\S]*?btn-tech-preview/.test(drawingToolsSrc))
pass('52c. Preview button mentions keyboard shortcut in tooltip',
  /title="[^"]*\(P\)/.test(drawingToolsSrc))

// 53. App.jsx keyboard shortcut for [P] opens preview.
pass('53a. App.jsx handles [P] key',
  /k === 'p'/.test(appJsxSrc))
pass('53b. [P] dispatches openPreview',
  /k === 'p'[\s\S]{0,400}openPreview\(\)/.test(appJsxSrc))

// 54. App.jsx [Esc] closes preview.
pass('54. App.jsx handles Escape → closePreview',
  /e\.key === 'Escape'[\s\S]{0,300}closePreview\(\)/.test(appJsxSrc))

// 55. App.jsx [O] cycles orientation.
pass('55a. App.jsx handles [O] key',
  /k === 'o'/.test(appJsxSrc))
pass('55b. [O] dispatches setPageOrientation',
  /k === 'o'[\s\S]{0,400}setPageOrientation/.test(appJsxSrc))

// 56. App.jsx [R] cycles rotation.
pass('56. App.jsx [R] dispatches cycleRotation',
  /k === 'r'[\s\S]{0,200}cycleRotation\(\)/.test(appJsxSrc))

// 57. App.jsx [F] cycles fit mode.
pass('57a. App.jsx handles [F] key', /k === 'f'/.test(appJsxSrc))
pass('57b. [F] dispatches setFitMode', /setFitMode\(/.test(appJsxSrc))

// 58. App.jsx [G] / [Enter] triggers generate.
pass('58a. App.jsx handles [G] or Enter',
  /k === 'g' \|\| e\.key === 'Enter'/.test(appJsxSrc))
pass('58b. Generate dispatch via button click',
  /preview-generate-button[\s\S]{0,100}click\(\)/.test(appJsxSrc))

// 59. TechnicalPreview mounts the SVG renderer.
pass('59a. TechnicalPreview imports renderShopDrawingSVG',
  /import\s+\{\s*renderShopDrawingSVG\s*\}\s+from\s+['"]\.\.\/utils\/shopDrawingSvgRender['"]/.test(techPreviewSrc))
pass('59b. TechnicalPreview imports useShopDrawingPdf',
  /useShopDrawingPdf/.test(techPreviewSrc))
pass('59c. TechnicalPreview imports scriptSource via ?raw',
  /tooling\/kcc-shop-drawing\.py\?raw/.test(techPreviewSrc))

// ============================================================================
// BLOCK I — Deploy-state gates (60-62)
// ============================================================================
// These tests catch failures the source-grep tests in Block H miss:
//   I.1 — work is committed (catches "uncommitted on local")
//   I.2 — production bundle contains 18h strings (catches "ran tests but
//          didn't rebuild")
//   I.3 — Pages-deployed SHA matches local HEAD (catches "built but
//          didn't deploy")
//
// Why these exist: §21.18h shipped with 127/127 source-grep PASS but the
// Preview button was invisible on the live URL because the 18h commit
// was never pushed. Block I makes ship-state a test concern, not a
// human-discipline concern.
//
// I.3 can be slow (HTTP fetch to GitHub Pages) and depends on the
// network, so the runner honors a CLI flag --skip-deploy-check that
// bypasses I.3. I.1 and I.2 always run; they're local-only and fast.
const { execSync } = require('child_process')
const SKIP_DEPLOY = process.argv.includes('--skip-deploy-check')

// 18h paths — must be clean (committed + tracked) for I.1 to PASS.
const PATHS_18H = [
  'src/App.css',
  'src/App.jsx',
  'src/components/DrawingTools.jsx',
  'src/components/TechnicalPreview.jsx',
  'src/hooks/useShopDrawingPdf.js',
  'src/store/useAppStore.js',
  'src/utils/kccProxy.js',
  'src/utils/pdfAsyncPipeline.js',
  'src/utils/shopDrawingSvgMath.js',
  'src/utils/shopDrawingSvgRender.jsx',
  'src/utils/specTableJSON.js',
  'src/utils/specTableValidation.js',
  'test/step-18h-node-runner.cjs',
  'tooling/kcc-shop-drawing.py',
]

const repoRoot = path.join(__dirname, '..')
const gitOpts = { cwd: repoRoot, encoding: 'utf-8' }

// I.1 — Build-state: all 18h paths committed + tracked.
let buildStateOk = true
let buildStateDetail = ''
try {
  // git status --porcelain returns lines like " M file" or "?? file".
  // We want zero output for any 18h path. (PATHS_18H is whitelisted —
  // if a 18h file shows up dirty/untracked, the test fails.)
  const status = execSync(
    'git status --porcelain -- ' + PATHS_18H.map((p) => '"' + p + '"').join(' '),
    gitOpts,
  )
  if (status.trim().length > 0) {
    buildStateOk = false
    buildStateDetail = status.trim()
  }
} catch (e) {
  buildStateOk = false
  buildStateDetail = 'git status failed: ' + (e && e.message)
}
pass('60. I.1 build-state — all 18h paths committed + tracked',
  buildStateOk, { detail: buildStateDetail })

// I.2 — Bundle-state: dist bundle contains 18h markers.
// Build is expensive (~5s); skip if SKIP_BUILD is set (CI hint).
let bundleStateOk = true
let bundleStateDetail = ''
const SKIP_BUILD = process.argv.includes('--skip-build')
if (SKIP_BUILD) {
  bundleStateDetail = 'skipped (--skip-build)'
} else {
  try {
    execSync('npm run build', { ...gitOpts, stdio: 'pipe' })
    const distDir = path.join(repoRoot, 'dist', 'assets')
    const bundles = fs.readdirSync(distDir).filter((f) => /^index-.*\.js$/.test(f))
    if (bundles.length !== 1) {
      bundleStateOk = false
      bundleStateDetail = 'expected 1 index-*.js bundle, found ' + bundles.length
    } else {
      const bundleSrc = fs.readFileSync(path.join(distDir, bundles[0]), 'utf-8')
      const markers = ['btn-tech-preview', 'openPreview', 'kcc-proxy.netlify.app']
      const missing = markers.filter((m) => !bundleSrc.includes(m))
      if (missing.length > 0) {
        bundleStateOk = false
        bundleStateDetail = 'missing in bundle: ' + missing.join(', ')
      }
    }
  } catch (e) {
    bundleStateOk = false
    bundleStateDetail = 'build failed: ' + (e && e.message ? e.message.slice(0, 200) : e)
  }
}
pass('61. I.2 bundle-state — dist/index-*.js contains 18h markers',
  bundleStateOk, { detail: bundleStateDetail })

// I.3 — Deploy-state: live Pages bundle's __BUILD_SHA__ matches local HEAD.
// Honors --skip-deploy-check for local dev / pre-deploy runs.
let deployStateOk = true
let deployStateDetail = ''
if (SKIP_DEPLOY) {
  deployStateDetail = 'skipped (--skip-deploy-check)'
} else {
  try {
    const localSha = execSync('git rev-parse --short=7 HEAD', gitOpts).trim()
    // Fetch the deployed index.html, then the linked bundle, then look
    // for the SHA marker Vite injects via __BUILD_SHA__ define.
    const idxHtml = execSync(
      'curl -fsSL https://briana-sudo.github.io/roofmark/',
      gitOpts,
    )
    const bundleMatch = idxHtml.match(/assets\/index-[A-Za-z0-9_-]+\.js/)
    if (!bundleMatch) {
      deployStateOk = false
      deployStateDetail = 'index.html missing bundle link'
    } else {
      const bundleUrl = 'https://briana-sudo.github.io/roofmark/' + bundleMatch[0]
      const bundle = execSync('curl -fsSL "' + bundleUrl + '"', gitOpts)
      // Bundle injects `__BUILD_SHA__` as a string literal. Vite minifies
      // the JSX `Build: {sha}` to e.g. ``Build: ${sha}`` — search for a
      // 7-char hex SHA following the "Build: " marker, allowing for
      // backtick / template-literal punctuation.
      const shaMatch = bundle.match(/Build:\s*[`"',\\\s]*([0-9a-f]{7})/)
      if (!shaMatch) {
        deployStateOk = false
        deployStateDetail = 'live bundle has no Build: SHA marker'
      } else {
        const deployedSha = shaMatch[1]
        if (deployedSha !== localSha) {
          deployStateOk = false
          deployStateDetail = 'local=' + localSha + ' deployed=' + deployedSha
        } else {
          deployStateDetail = 'sha=' + deployedSha
        }
      }
    }
  } catch (e) {
    deployStateOk = false
    deployStateDetail = 'deploy check failed: ' + (e && e.message ? e.message.slice(0, 200) : e)
  }
}
pass('62. I.3 deploy-state — live bundle __BUILD_SHA__ matches local HEAD',
  deployStateOk, { detail: deployStateDetail })

// ============================================================================
// BLOCK J — Operator-flow regressions (63-64)
// ============================================================================
// Bug-class tests for issues discovered during live operator integration
// (May 12 2026). Each test maps to a specific operator-observable failure
// the source-grep + synthetic-fixture tests didn't catch.

// 63. Bug 1 regression — RoofMark stores tech-lines as {type:'line',
// a:{x,y}, b:{x,y}, lengthInches, lengthSource, angleSource} per
// techLineCommit.js:132-139. specTableJSON.stripShape must bridge that
// to the v1.1 pts:[a, b] form or the SVG renderer + Python script both
// silently drop the geometry. Operator-visible symptom: preview shows
// dimensions only, no shape lines.
{
  const techLineShape = {
    id: 'tech-shape-1',
    type: 'line',
    a: { x: 100, y: 200 },
    b: { x: 124, y: 200 },
    lengthInches: 1.0,
    lengthSource: 'freehand',
    angleSource: 'freehand',
  }
  const store = mkStoreState({
    technicalLayers: [{
      id: 'tech-layer-1', visible: true, name: 'Layer 1',
      color: '#1A2F4A', order: 0,
      shapes: [techLineShape],
    }],
  })
  const p = buildShopDrawingPayload(store, {})
  pass('63a. tech-line {a, b} input produces v1.1-compatible pts array',
    Array.isArray(p.layers[0].shapes[0].pts)
    && p.layers[0].shapes[0].pts.length === 2)
  pass('63b. bridged pts[0] carries numeric x/y from shape.a',
    typeof p.layers[0].shapes[0].pts[0].x === 'number'
    && typeof p.layers[0].shapes[0].pts[0].y === 'number'
    && p.layers[0].shapes[0].pts[0].x === 100
    && p.layers[0].shapes[0].pts[0].y === 200)
  pass('63c. bridged pts[1] carries numeric x/y from shape.b',
    typeof p.layers[0].shapes[0].pts[1].x === 'number'
    && typeof p.layers[0].shapes[0].pts[1].y === 'number'
    && p.layers[0].shapes[0].pts[1].x === 124
    && p.layers[0].shapes[0].pts[1].y === 200)
  pass('63d. internal fields (id, lengthSource) stripped from v1.1 output',
    !('id' in p.layers[0].shapes[0])
    && !('lengthSource' in p.layers[0].shapes[0])
    && !('angleSource' in p.layers[0].shapes[0]))
}

// 64. Bug 2 regression — PDF_BETA must include both Anthropic betas.
// Source-grep against pdfAsyncPipeline.js so a future drift back to
// single-beta is caught at test time, not at the operator's PDF retry.
// Anthropic's /v1/files/{id}/content endpoint requires files-api-
// 2025-04-14; the proxy forwards the client beta verbatim on that
// retrieval call. Single-beta → 404 even though the sandbox produced
// a valid file_id.
{
  const pipelineSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'utils', 'pdfAsyncPipeline.js'),
    'utf-8',
  )
  const pdfBetaMatch = pipelineSrc.match(/export\s+const\s+PDF_BETA\s*=\s*['"]([^'"]+)['"]/)
  pass('64a. PDF_BETA declaration present in pdfAsyncPipeline.js',
    !!pdfBetaMatch)
  if (pdfBetaMatch) {
    const betaStr = pdfBetaMatch[1]
    pass('64b. PDF_BETA includes code-execution-2025-08-25',
      betaStr.includes('code-execution-2025-08-25'))
    pass('64c. PDF_BETA includes files-api-2025-04-14 (Bug 2 regression)',
      betaStr.includes('files-api-2025-04-14'))
  } else {
    pass('64b. PDF_BETA includes code-execution-2025-08-25', false)
    pass('64c. PDF_BETA includes files-api-2025-04-14 (Bug 2 regression)', false)
  }
}

// ============================================================================
// SUMMARY
// ============================================================================
// Block E tests use async fetch mocks. Need to wait for the microtask
// queue to drain. setImmediate-equivalent: a 50ms timeout suffices for
// our mock-only flows (no real network).
setTimeout(() => {
  const passCount = tests.filter((t) => t.ok).length
  const total = tests.length
  console.log(passCount + '/' + total + ' ' + (passCount === total ? 'PASS' : 'FAIL'))
  for (const t of tests) {
    if (!t.ok) console.log('FAIL: ' + t.name + (t.extra ? ' ' + JSON.stringify(t.extra) : ''))
  }
}, 50)
