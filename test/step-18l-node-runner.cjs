// Node-side runner for Phase 2 sub-step 18l block tests.
//
// 18l ships:
//   - Callout render-style match against v1.3 Python (amber dot tip
//     + amber leader + "#N text" in box).
//   - calloutTextSize global control (6..20, default 8) persisted
//     via PERSIST_KEYS and emitted through the v1.1 payload contract.
//   - Angular dim snap support (vertex / p1 / p2 stages use the
//     existing 18-snap engine; awaitRadius stays grid-free per D2).
//
// Blocks:
//   K — composeCalloutText helper (unit tests)
//   L — calloutTextSize store wiring (source-grep)
//   M — snap wiring for tech-dim-angular (source-grep)
//   N — payload includes calloutTextSize (integration via shim load)
//   P — re-run of Block P from 18k (Rule 29 wiring gates)
//   Q — v1.3 visual-style assertions (8 tests per spec)
//   R — integration regressions

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

// Load techCalloutCommit to get composeCalloutText.
const {
  composeCalloutText,
} = loadModule(
  'src/utils/techCalloutCommit.js',
  ['composeCalloutText'],
)

// Load specTableJSON + deps for buildShopDrawingPayload tests.
const { SPEC_TABLE_FIELDS } = loadModule(
  'src/utils/specTableValidation.js',
  ['SPEC_TABLE_FIELDS'],
)
const { formatArchitecturalLength } = loadModule(
  'src/utils/formatArchitecturalLength.js',
  ['formatArchitecturalLength'],
)
const { computeAngleDegrees, formatAngle, computeAngularGeometry } = loadModule(
  'src/utils/angularDimMath.js',
  ['computeAngleDegrees', 'formatAngle', 'computeAngularGeometry'],
)
const bridgePreamble = `
  const SPEC_TABLE_FIELDS = ${JSON.stringify(SPEC_TABLE_FIELDS)}
  ${formatArchitecturalLength.toString()}
  ${computeAngleDegrees.toString()}
  ${formatAngle.toString()}
  ${computeAngularGeometry.toString()}
`
const { buildShopDrawingPayload } = loadModule(
  'src/utils/specTableJSON.js',
  ['buildShopDrawingPayload'],
  bridgePreamble,
)

const tests = []
function pass(name, ok, extra) { tests.push({ name, ok: !!ok, extra }) }

// ============================================================================
// BLOCK K — composeCalloutText helper (1-6)
// ============================================================================
pass('1. composeCalloutText(1, "X") → "#1 X"',
  composeCalloutText(1, 'X') === '#1 X')
pass('2. composeCalloutText(3, "TOP HEM") → "#3 TOP HEM"',
  composeCalloutText(3, 'TOP HEM') === '#3 TOP HEM')
pass('3. composeCalloutText(5, "") → "#5"',
  composeCalloutText(5, '') === '#5')
pass('4. composeCalloutText(0, "TEXT") → "TEXT"',
  composeCalloutText(0, 'TEXT') === 'TEXT')
pass('5. composeCalloutText(0, "") → ""',
  composeCalloutText(0, '') === '')
pass('6. composeCalloutText trims whitespace from textEN',
  composeCalloutText(1, '  PADDED  ') === '#1 PADDED')

// ============================================================================
// BLOCK L — calloutTextSize store wiring (7-12)
// ============================================================================
const storeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'store', 'useAppStore.js'),
  'utf-8',
)
pass('7. Store initial state declares calloutTextSize',
  /calloutTextSize:\s*\(/.test(storeSrc) || /calloutTextSize:\s*8/.test(storeSrc))
pass('8. Store has setCalloutTextSize action',
  /setCalloutTextSize:\s*\(size\)\s*=>/.test(storeSrc))
pass('9. setCalloutTextSize clamps to [6, 20]',
  /Math\.max\(6,\s*Math\.min\(20/.test(storeSrc))
pass('10. PERSIST_KEYS includes calloutTextSize',
  /'calloutTextSize'/.test(storeSrc))
pass('11. Import migration backfills calloutTextSize from hydrated',
  /hydrated\.calloutTextSize/.test(storeSrc))
pass('12. Import migration defaults to 8 when field missing',
  /calloutTextSize === 'number'[\s\S]{0,200}:\s*8/.test(storeSrc))

// ============================================================================
// BLOCK M — Angular dim snap wiring (13-16)
// ============================================================================
const canvasStageSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'CanvasStage.jsx'),
  'utf-8',
)
pass('13. CanvasStage mousemove snap-scan for tech-dim-angular (mid-draft)',
  /tool === 'tech-dim-angular'[\s\S]{0,600}findTechSnapTarget/.test(canvasStageSrc))
pass('14. CanvasStage mousemove snap-scan for tech-dim-angular (no draft yet)',
  /tool === 'tech-dim-angular'[\s\S]{0,600}!store\.techDimAngularDraft/.test(canvasStageSrc))
pass('15. CanvasStage onMouseDown consumes techCommandHover for angular dim',
  /tech-dim-angular[\s\S]{0,2000}snapHover[\s\S]{0,200}techCommandHover/.test(canvasStageSrc))
pass('16. awaitRadius stage skips snap (grid-only per D2)',
  /awaitRadius[\s\S]{0,400}!== 'awaitRadius'/.test(canvasStageSrc)
  || /stage !== 'awaitRadius'/.test(canvasStageSrc))

// ============================================================================
// BLOCK N — Payload contract includes calloutTextSize (17-19)
// ============================================================================
{
  const p = buildShopDrawingPayload({
    specTable: {},
    technicalLayers: [],
    calloutTextSize: 14,
  }, {})
  pass('17. Payload includes calloutTextSize field',
    typeof p.calloutTextSize === 'number')
  pass('18. Payload carries store value',
    p.calloutTextSize === 14)
}
{
  const p = buildShopDrawingPayload({ specTable: {}, technicalLayers: [] }, {})
  pass('19. Payload defaults calloutTextSize to 8 when absent',
    p.calloutTextSize === 8)
}

// ============================================================================
// BLOCK P — Re-run Rule 29 wiring gates (20-31)
// ============================================================================
const drawingToolsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'DrawingTools.jsx'),
  'utf-8',
)
const specTablePanelSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'SpecTablePanel.jsx'),
  'utf-8',
)
function extractFnBody(src, fnSig) {
  const idx = src.indexOf(fnSig)
  if (idx < 0) return ''
  return src.slice(idx, Math.min(idx + 60000, src.length))
}
const drawStaticBody = extractFnBody(canvasStageSrc, 'const drawStatic')
const drawDynamicBody = extractFnBody(canvasStageSrc, 'const drawDynamic')
const onMouseDownBody = extractFnBody(canvasStageSrc, 'const onMouseDown')

pass("20. P.1 drawStatic dispatches sh.type === 'callout'",
  drawStaticBody.includes("sh.type === 'callout'") && drawStaticBody.includes('renderCalloutCanvas'))
pass("21. P.2 drawStatic dispatches angular dims (sh.dimType === 'angular')",
  drawStaticBody.includes("sh.dimType === 'angular'") && drawStaticBody.includes('renderAngularDimCanvas'))
pass("22. P.3 drawDynamic references techCalloutDraft",
  drawDynamicBody.includes('techCalloutDraft'))
pass("23. P.4 drawDynamic references techDimAngularDraft",
  drawDynamicBody.includes('techDimAngularDraft'))

const TOOLS = ['tech-line', 'tech-select', 'tech-dim-angular', 'tech-callout']
for (const tool of TOOLS) {
  pass(`P.5 onMouseDown has branch for tool '${tool}'`,
    onMouseDownBody.includes(`=== '${tool}'`))
}

const SHAPE_TYPES = ['line', 'dimension', 'callout']
for (const t of SHAPE_TYPES) {
  pass(`P.6 drawStatic has branch for shape type '${t}'`,
    drawStaticBody.includes(`sh.type === '${t}'`))
}

pass("P.7 SpecTablePanel iterates callouts",
  /callout/i.test(specTablePanelSrc) && /\.map\(/.test(specTablePanelSrc))

// ============================================================================
// BLOCK Q — v1.3 visual-style assertions (32-39)
// ============================================================================
const calloutSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'utils', 'techCalloutCommit.js'),
  'utf-8',
)
const svgRenderSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'utils', 'shopDrawingSvgRender.jsx'),
  'utf-8',
)
const renderCalloutCanvasBody = (() => {
  const idx = calloutSrc.indexOf('function renderCalloutCanvas')
  return idx < 0 ? '' : calloutSrc.slice(idx, calloutSrc.length)
})()
const renderCalloutSvgBody = (() => {
  const idx = svgRenderSrc.indexOf('function renderCallout(')
  return idx < 0 ? '' : svgRenderSrc.slice(idx, idx + 5000)
})()

pass("32. Q.1 renderCalloutCanvas uses #B8860B (DIM_AMBER)",
  renderCalloutCanvasBody.includes("'#B8860B'") || renderCalloutCanvasBody.includes('"#B8860B"'))
pass("33. Q.2 renderCalloutCanvas tip is fill-only (no stroke after arc)",
  // ctx.arc → ctx.fill (no ctx.stroke between them for the tip dot)
  /ctx\.arc\(tip\.x, tip\.y, 3,[\s\S]{0,200}ctx\.fill\(\)[\s\S]{0,200}ctx\.restore/.test(renderCalloutCanvasBody)
  && !/ctx\.arc\(tip\.x, tip\.y, 3,[\s\S]{0,200}ctx\.stroke\(\)/.test(renderCalloutCanvasBody))
pass("34. Q.3 composeCalloutText uses '#${num}' template",
  /`#\$\{n\}`/.test(calloutSrc) || /`#\$\{n\} \$\{t\}`/.test(calloutSrc))
pass("35. Q.4 SVG renderCallout uses DIM_AMBER for leader stroke",
  /stroke=\{DIM_AMBER\}/.test(renderCalloutSvgBody))
pass("36. Q.5 SVG renderCallout tip radius is 3 (small amber dot)",
  /TIP_R = 3/.test(renderCalloutSvgBody)
  || /r=\{3\}/.test(renderCalloutSvgBody)
  || /r=\{TIP_R\}/.test(renderCalloutSvgBody) && /TIP_R = 3/.test(svgRenderSrc))
pass("37. Q.6 CanvasStage tech-dim-angular uses snap helper",
  /tech-dim-angular[\s\S]{0,3000}findTechSnapTarget/.test(canvasStageSrc))

const specTableJsonSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'utils', 'specTableJSON.js'),
  'utf-8',
)
pass("38. Q.7 buildShopDrawingPayload returns calloutTextSize",
  /calloutTextSize/.test(specTableJsonSrc)
  && /return\s*\{[\s\S]*calloutTextSize/.test(specTableJsonSrc))
pass("39. Q.8 SpecTablePanel renders calloutTextSize input",
  /calloutTextSize/.test(specTablePanelSrc)
  && /type="number"/.test(specTablePanelSrc)
  && /setCalloutTextSize/.test(specTablePanelSrc))

// ============================================================================
// BLOCK R — Integration regressions (40-43)
// ============================================================================
// v1.3 Python bundled via Vite ?raw. Marker check on the source file.
const v13ScriptSrc = fs.readFileSync(
  path.join(__dirname, '..', 'tooling', 'kcc-shop-drawing.py'),
  'utf-8',
)
pass("40. v1.3 Python script at HEAD",
  /v1\.3/.test(v13ScriptSrc) && v13ScriptSrc.includes('CALLOUT_TIP_DOT_R'))
pass("41. v1.3 Python references calloutTextSize",
  /calloutTextSize/.test(v13ScriptSrc))
pass("42. Callouts section uses bold text in box per v1.3 style",
  /fontWeight="bold"/.test(renderCalloutSvgBody)
  || /bold/.test(renderCalloutSvgBody))
pass("43. Legacy v1.2 callout style (KCC_NAVY leader) gone",
  // v1.2 leader was navy — v1.3 must not use KCC_NAVY for the leader stroke
  !/CALLOUT_LEADER_COLOR\s*=\s*KCC_NAVY/.test(v13ScriptSrc))

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
