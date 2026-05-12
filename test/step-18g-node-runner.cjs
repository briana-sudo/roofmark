// Node-side runner for Phase 2 sub-step 18g block tests.
//
// 18g ships the right-drawer Spec Table panel: 9 fields per the locked
// `kcc-shop-drawing.py v1.0` template, mode-gated to Technical Drawing,
// with inline validation (3 required fields gate JSON export), drawnBy
// localStorage cross-project persistence, and date auto-populate on
// app start.
//
// Coverage blocks (per spec §"Test coverage requirements" + investigation §13):
//   A. State shape — 9-field default, normalizeSpecTable, setSpecTable merge
//   B. Field input — each field accepts text, SPEC_FIELD_MAX_LENGTHS table
//   C. Validation — computeIsSpecTableValid + isFieldRequiredAndEmpty
//   D. Date auto-populate — hydrateSpecTableDefaults + todayLongFormat
//   E. drawnBy localStorage — hydrate, write-back, project-wins, edge cases
//   F. Mode isolation — App.jsx grep regression
//   G. Undo — no-undo on setSpecTable/hydrate; focus→blur edit-session
//   H. Save/Load — dataSnapshot + importJSON round-trip
//
// Target: ~40 new tests. Total suite: 1149 (existing) + ~40 = ~1189.
//
// Same eval-shim pattern as step-18e-node-runner.cjs. localStorage is
// mocked at globalThis level so the eval-shim load of
// specTableValidation.js (which references it via the persistDrawnBy /
// loadDrawnByFromStorage helpers when re-imported in store-mirror tests)
// finds a real implementation.

const path = require('path')
const fs = require('fs')

// localStorage mock — Node has no global localStorage. Inline a simple
// in-memory implementation that mirrors the browser API surface used
// by the production helpers (getItem / setItem / removeItem / clear).
// Tests that exercise the storage path either reset between cases or
// inspect the mock's internal state via `_reset`.
globalThis.localStorage = (() => {
  let store = {}
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value) },
    removeItem: (key) => { delete store[key] },
    clear: () => { store = {} },
    _reset: () => { store = {} },
    _peek: () => ({ ...store }),
  }
})()

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

// specTableValidation — pure module, no upstream deps. Loads cleanly.
const {
  SPEC_TABLE_FIELDS,
  SPEC_TABLE_REQUIRED_FIELDS,
  SPEC_FIELD_MAX_LENGTHS,
  SPEC_FIELD_LABELS,
  emptySpecTable,
  normalizeSpecTable,
  computeIsSpecTableValid,
  isFieldRequiredAndEmpty,
  todayLongFormat,
  DRAWN_BY_STORAGE_KEY,
} = loadModule(
  'src/utils/specTableValidation.js',
  [
    'SPEC_TABLE_FIELDS', 'SPEC_TABLE_REQUIRED_FIELDS',
    'SPEC_FIELD_MAX_LENGTHS', 'SPEC_FIELD_LABELS',
    'emptySpecTable', 'normalizeSpecTable',
    'computeIsSpecTableValid', 'isFieldRequiredAndEmpty',
    'todayLongFormat', 'DRAWN_BY_STORAGE_KEY',
  ],
)

const tests = []
function pass(name, ok, extra) {
  tests.push({ name, ok: !!ok, extra })
}

// Production-mirror of the store's specTable surface. Mirrors the exact
// setSpecTable + hydrateSpecTableDefaults logic from useAppStore.js so
// tests exercise the same code path as production without needing the
// full Zustand store.
function makeSpecTableStore() {
  const state = {
    specTable: emptySpecTable(),
    undoStack: [],
    redoStack: [],
  }
  // Mirror of persistDrawnBy / loadDrawnByFromStorage from store.
  const loadDrawnByFromStorage = () => {
    if (typeof localStorage === 'undefined') return null
    try { return localStorage.getItem(DRAWN_BY_STORAGE_KEY) || null }
    catch { return null }
  }
  const persistDrawnBy = (value) => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(DRAWN_BY_STORAGE_KEY, value || '') }
    catch { /* ignore */ }
  }
  // setSpecTable: partial merge + drawnBy persistence coupling.
  const setSpecTable = (patch) => {
    if (!patch || typeof patch !== 'object') return
    state.specTable = { ...state.specTable, ...patch }
    if (typeof patch.drawnBy === 'string') persistDrawnBy(patch.drawnBy)
  }
  // hydrateSpecTableDefaults: localStorage drawnBy + today's date.
  const hydrateSpecTableDefaults = () => {
    const patches = {}
    if (state.specTable.drawnBy === '') {
      const stored = loadDrawnByFromStorage()
      if (typeof stored === 'string' && stored.length > 0) {
        patches.drawnBy = stored
      }
    }
    if (state.specTable.date === '') {
      patches.date = todayLongFormat()
    }
    if (Object.keys(patches).length === 0) return
    state.specTable = { ...state.specTable, ...patches }
    // No undo push.
  }
  const isSpecTableValid = () => computeIsSpecTableValid(state.specTable)
  // Production-mirror captureUndoSnapshot / pushCapturedSnapshot.
  const captureUndoSnapshot = () => JSON.stringify({ specTable: state.specTable })
  const pushCapturedSnapshot = (snap) => {
    if (typeof snap === 'string') state.undoStack.push(snap)
  }
  return {
    state, setSpecTable, hydrateSpecTableDefaults,
    isSpecTableValid, captureUndoSnapshot, pushCapturedSnapshot,
    _loadDrawnByFromStorage: loadDrawnByFromStorage,
    _persistDrawnBy: persistDrawnBy,
  }
}

// ============================================================================
// BLOCK A — State shape (1–5)
//
// specTable has all 9 fields after store init (each defaults to '').
// normalizeSpecTable + emptySpecTable + setSpecTable shape contract.
// ============================================================================

// 1. emptySpecTable() has all 9 fields, each empty string.
{
  const e = emptySpecTable()
  pass('1a. emptySpecTable() has 9 keys',
    Object.keys(e).length === 9)
  pass('1b. SPEC_TABLE_FIELDS lists 9 fields',
    SPEC_TABLE_FIELDS.length === 9)
  pass('1c. Every SPEC_TABLE_FIELDS field present in emptySpecTable',
    SPEC_TABLE_FIELDS.every((f) => f in e))
  pass('1d. Every field defaults to empty string',
    SPEC_TABLE_FIELDS.every((f) => e[f] === ''))
}

// 2. normalizeSpecTable({}) returns 9-field object.
{
  const n = normalizeSpecTable({})
  pass('2a. normalizeSpecTable({}) → 9 keys',
    Object.keys(n).length === 9)
  pass('2b. → all fields empty strings',
    SPEC_TABLE_FIELDS.every((f) => n[f] === ''))
}

// 3. normalizeSpecTable preserves known fields, drops unknown fields.
{
  const n = normalizeSpecTable({
    partName: 'Eave Metal',
    material: '26ga Painted',
    rogueField: 'bar',           // unknown — should be dropped
    foo: 42,                     // unknown — should be dropped
    drawingNo: 'KCC-001',
  })
  pass('3a. Known field partName preserved', n.partName === 'Eave Metal')
  pass('3b. Known field material preserved', n.material === '26ga Painted')
  pass('3c. Known field drawingNo preserved', n.drawingNo === 'KCC-001')
  pass('3d. Unknown rogueField dropped', !('rogueField' in n))
  pass('3e. Unknown foo dropped', !('foo' in n))
  pass('3f. Missing fields filled with empty string',
    n.color === '' && n.stockLength === '' && n.jobId === ''
    && n.jobAddress === '' && n.drawnBy === '' && n.date === '')
}

// 4. normalizeSpecTable defensively handles null / undefined / non-string fields.
{
  const n1 = normalizeSpecTable(null)
  pass('4a. normalizeSpecTable(null) → empty 9-field object',
    Object.keys(n1).length === 9 && n1.partName === '')
  const n2 = normalizeSpecTable(undefined)
  pass('4b. normalizeSpecTable(undefined) → empty 9-field object',
    Object.keys(n2).length === 9)
  const n3 = normalizeSpecTable({ partName: 42, material: null })
  pass('4c. Non-string field values coerced to empty string',
    n3.partName === '' && n3.material === '')
}

// 5. setSpecTable merge: only patches the named fields, preserves rest.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  s.setSpecTable({ partName: 'X', material: 'Y' })
  pass('5a. partName merged', s.state.specTable.partName === 'X')
  pass('5b. material merged', s.state.specTable.material === 'Y')
  pass('5c. Other fields untouched',
    s.state.specTable.color === '' && s.state.specTable.drawingNo === '')
  pass('5d. setSpecTable(null) is a safe no-op',
    (() => { s.setSpecTable(null); return s.state.specTable.partName === 'X' })())
  pass('5e. setSpecTable("notobject") is a safe no-op',
    (() => { s.setSpecTable('not-an-object'); return s.state.specTable.partName === 'X' })())
}

// ============================================================================
// BLOCK B — Field input (6–14)
//
// Each of the 9 fields accepts a setSpecTable patch. SPEC_FIELD_MAX_LENGTHS
// contains all 9 fields with the spec-locked values.
// ============================================================================

// 6-14. setSpecTable round-trip on each field individually.
{
  const expectations = {
    partName: 'Eave Metal',
    material: '26ga Painted Steel',
    color: 'Royal Blue',
    stockLength: '10\'-6"',
    jobId: 'KCC-2026-003',
    jobAddress: '123 Main St, Springfield',
    drawnBy: 'Alice',
    date: 'May 12, 2026',
    drawingNo: 'KCC-2026-003-001',
  }
  let testNo = 6
  for (const field of SPEC_TABLE_FIELDS) {
    globalThis.localStorage._reset()
    const s = makeSpecTableStore()
    s.setSpecTable({ [field]: expectations[field] })
    pass(`${testNo}. setSpecTable({${field}}) round-trips`,
      s.state.specTable[field] === expectations[field])
    testNo += 1
  }
}

// 15. SPEC_FIELD_MAX_LENGTHS contains all 9 fields with spec values.
{
  pass('15a. partName=50', SPEC_FIELD_MAX_LENGTHS.partName === 50)
  pass('15b. material=50', SPEC_FIELD_MAX_LENGTHS.material === 50)
  pass('15c. color=50', SPEC_FIELD_MAX_LENGTHS.color === 50)
  pass('15d. stockLength=20', SPEC_FIELD_MAX_LENGTHS.stockLength === 20)
  pass('15e. jobId=30', SPEC_FIELD_MAX_LENGTHS.jobId === 30)
  pass('15f. jobAddress=100', SPEC_FIELD_MAX_LENGTHS.jobAddress === 100)
  pass('15g. drawnBy=50', SPEC_FIELD_MAX_LENGTHS.drawnBy === 50)
  pass('15h. date=30', SPEC_FIELD_MAX_LENGTHS.date === 30)
  pass('15i. drawingNo=30', SPEC_FIELD_MAX_LENGTHS.drawingNo === 30)
  pass('15j. All 9 fields have a maxLength',
    Object.keys(SPEC_FIELD_MAX_LENGTHS).length === 9)
}

// ============================================================================
// BLOCK C — Validation (16–21)
//
// computeIsSpecTableValid + isFieldRequiredAndEmpty per spec §"Validation".
// ============================================================================

// 16. SPEC_TABLE_REQUIRED_FIELDS lists exactly 3 fields per spec.
{
  pass('16a. 3 required fields', SPEC_TABLE_REQUIRED_FIELDS.length === 3)
  pass('16b. partName required',
    SPEC_TABLE_REQUIRED_FIELDS.includes('partName'))
  pass('16c. material required',
    SPEC_TABLE_REQUIRED_FIELDS.includes('material'))
  pass('16d. drawingNo required',
    SPEC_TABLE_REQUIRED_FIELDS.includes('drawingNo'))
}

// 17. computeIsSpecTableValid: empty spec table → false.
{
  pass('17. computeIsSpecTableValid(empty) === false',
    computeIsSpecTableValid(emptySpecTable()) === false)
}

// 18. computeIsSpecTableValid: all 3 required filled → true.
{
  const s = { ...emptySpecTable(), partName: 'X', material: 'Y', drawingNo: 'Z' }
  pass('18. All 3 required filled → valid',
    computeIsSpecTableValid(s) === true)
}

// 19. computeIsSpecTableValid: any 1 required empty → false.
{
  const s1 = { ...emptySpecTable(), partName: '', material: 'Y', drawingNo: 'Z' }
  const s2 = { ...emptySpecTable(), partName: 'X', material: '', drawingNo: 'Z' }
  const s3 = { ...emptySpecTable(), partName: 'X', material: 'Y', drawingNo: '' }
  pass('19a. Empty partName → invalid',
    computeIsSpecTableValid(s1) === false)
  pass('19b. Empty material → invalid',
    computeIsSpecTableValid(s2) === false)
  pass('19c. Empty drawingNo → invalid',
    computeIsSpecTableValid(s3) === false)
}

// 20. Whitespace-only required field → invalid (trim).
{
  const s = { ...emptySpecTable(), partName: '   ', material: 'Y', drawingNo: 'Z' }
  pass('20a. Whitespace partName → invalid (trim)',
    computeIsSpecTableValid(s) === false)
  const s2 = { ...emptySpecTable(), partName: 'X', material: '\t\n', drawingNo: 'Z' }
  pass('20b. Tab+newline material → invalid (trim)',
    computeIsSpecTableValid(s2) === false)
}

// 21. isFieldRequiredAndEmpty per-field signal.
{
  pass('21a. required + empty → true',
    isFieldRequiredAndEmpty('partName', '') === true)
  pass('21b. required + whitespace → true',
    isFieldRequiredAndEmpty('drawingNo', '   ') === true)
  pass('21c. required + filled → false',
    isFieldRequiredAndEmpty('material', 'Steel') === false)
  pass('21d. optional + empty → false (optional fields never invalid)',
    isFieldRequiredAndEmpty('color', '') === false)
  pass('21e. optional + filled → false',
    isFieldRequiredAndEmpty('jobId', 'KCC-001') === false)
  // Optional fields ignored by validity even with whitespace
  pass('21f. optional + whitespace → false',
    isFieldRequiredAndEmpty('drawnBy', '   ') === false)
}

// 22. computeIsSpecTableValid handles null/non-object input.
{
  pass('22a. null → false', computeIsSpecTableValid(null) === false)
  pass('22b. undefined → false', computeIsSpecTableValid(undefined) === false)
  pass('22c. string → false', computeIsSpecTableValid('not-an-object') === false)
  // Optional fields don't affect validity even when present
  const sExtra = {
    ...emptySpecTable(),
    partName: 'X', material: 'Y', drawingNo: 'Z',
    color: '', stockLength: '', jobId: '', jobAddress: '', drawnBy: '', date: '',
  }
  pass('22d. Optional fields empty + required filled → still valid',
    computeIsSpecTableValid(sExtra) === true)
}

// ============================================================================
// BLOCK D — Date auto-populate (23–25)
//
// hydrateSpecTableDefaults + todayLongFormat per spec §"Date auto-population".
// ============================================================================

// 23. hydrateSpecTableDefaults: empty date → populate with today's date.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  s.hydrateSpecTableDefaults()
  // Long format regex: "Month D, YYYY" — month name, optional 1-2 digit day, 4-digit year.
  const longFormatRegex = /^[A-Z][a-z]+ \d{1,2}, \d{4}$/
  pass('23a. Empty date → populated with today',
    typeof s.state.specTable.date === 'string' && s.state.specTable.date.length > 0)
  pass('23b. Populated date matches long format regex',
    longFormatRegex.test(s.state.specTable.date))
}

// 24. hydrateSpecTableDefaults: non-empty date → unchanged.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  s.setSpecTable({ date: 'January 1, 2024' })
  s.hydrateSpecTableDefaults()
  pass('24. Non-empty date untouched by hydrate',
    s.state.specTable.date === 'January 1, 2024')
}

// 25. todayLongFormat() returns long format string.
{
  const t = todayLongFormat()
  pass('25a. todayLongFormat returns a string', typeof t === 'string')
  pass('25b. → matches "Month D, YYYY" pattern',
    /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(t))
  pass('25c. → contains current year',
    t.includes(String(new Date().getFullYear())))
}

// ============================================================================
// BLOCK E — drawnBy localStorage (26–30)
//
// Spec v1.1 §"Cross-project persistence" — `roofmark_drawnBy_v1` key.
// ============================================================================

// 26. localStorage value hydrates empty drawnBy.
{
  globalThis.localStorage._reset()
  globalThis.localStorage.setItem(DRAWN_BY_STORAGE_KEY, 'Alice')
  const s = makeSpecTableStore()
  s.hydrateSpecTableDefaults()
  pass('26. Empty drawnBy + localStorage value → hydrated',
    s.state.specTable.drawnBy === 'Alice')
}

// 27. localStorage empty → hydrate is no-op for drawnBy.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  s.hydrateSpecTableDefaults()
  pass('27. Empty drawnBy + no localStorage value → drawnBy stays empty',
    s.state.specTable.drawnBy === '')
}

// 28. setSpecTable({drawnBy}) writes to localStorage.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  s.setSpecTable({ drawnBy: 'Bob' })
  pass('28a. drawnBy in state', s.state.specTable.drawnBy === 'Bob')
  pass('28b. drawnBy mirrored to localStorage',
    globalThis.localStorage.getItem(DRAWN_BY_STORAGE_KEY) === 'Bob')
}

// 29. setSpecTable without drawnBy doesn't touch localStorage.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  s.setSpecTable({ partName: 'Just a part' })
  pass('29. setSpecTable({partName}) does NOT touch localStorage',
    globalThis.localStorage.getItem(DRAWN_BY_STORAGE_KEY) === null)
}

// 30. Non-empty drawnBy hydrate is no-op (project wins).
{
  globalThis.localStorage._reset()
  globalThis.localStorage.setItem(DRAWN_BY_STORAGE_KEY, 'Alice')
  const s = makeSpecTableStore()
  // Simulate a loaded project with a drawnBy value already set.
  s.state.specTable = { ...s.state.specTable, drawnBy: 'BobFromProject' }
  s.hydrateSpecTableDefaults()
  pass('30. Project drawnBy wins over localStorage value',
    s.state.specTable.drawnBy === 'BobFromProject')
}

// 31. localStorage throws on getItem → loadDrawnByFromStorage returns null (no crash).
{
  // Replace mock with a throw-on-getItem stand-in
  const real = globalThis.localStorage
  globalThis.localStorage = {
    getItem: () => { throw new Error('boom') },
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  }
  const s = makeSpecTableStore()
  let crashed = false
  try {
    s.hydrateSpecTableDefaults()
  } catch (e) {
    crashed = true
  }
  pass('31a. localStorage getItem throws → hydrate does NOT crash',
    !crashed)
  pass('31b. → drawnBy stays empty (graceful fallback)',
    s.state.specTable.drawnBy === '')
  // Restore real mock for downstream tests
  globalThis.localStorage = real
  globalThis.localStorage._reset()
}

// ============================================================================
// BLOCK F — Mode isolation (32–34)
//
// Spec v1.1 §"Mode isolation" — TECHNICAL aside hosts Spec Table only;
// FIELD aside does NOT host it. Source-grep regression on App.jsx.
// ============================================================================

const appJsxSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'App.jsx'),
  'utf-8',
)

// 32. TECHNICAL aside block exists and contains the spec-table tab testid.
//
// The TECHNICAL drawer is uniquely tagged with data-testid="drawer-technical".
// We slice the source around that anchor — App.jsx has multiple
// `appMode === 'TECHNICAL'` occurrences (TechInputPanel gate plus comment
// strings), so we anchor on the testid which only appears inside the
// drawer aside. The slice extends backward from the testid to the
// preceding `<aside` open tag and forward to the closing `</aside>`.
const techAnchorIdx = appJsxSrc.indexOf("data-testid=\"drawer-technical\"")
const fieldAsideIdx = appJsxSrc.indexOf("appMode === 'FIELD'")
// Start of TECHNICAL aside: backtrack from anchor to find the preceding
// `<aside` open tag.
const techAsideOpenIdx = appJsxSrc.lastIndexOf('<aside', techAnchorIdx)
const techCloseIdx = appJsxSrc.indexOf('</aside>', techAnchorIdx)
const techSlice = techAnchorIdx >= 0 && techCloseIdx >= 0
  ? appJsxSrc.slice(techAsideOpenIdx, techCloseIdx + 9)
  : ''
{
  pass('32a. App.jsx contains TECHNICAL aside with drawer-technical testid',
    techAnchorIdx >= 0)
  pass('32b. TECHNICAL aside contains drawer-tab-spec-table testid',
    techSlice.includes('drawer-tab-spec-table'))
  pass('32c. TECHNICAL aside contains SpecTablePanel mount',
    techSlice.includes('<SpecTablePanel />'))
}

// 33. FIELD aside (the original one) does NOT contain the spec-table tab.
//
// FIELD aside is uniquely anchored by drawer-tab-properties testid (only
// the FIELD aside renders Properties). Backtrack from that testid to the
// preceding `<aside` and forward to the closing `</aside>`.
{
  const fieldAnchorIdx = appJsxSrc.indexOf('drawer-tab-properties')
  const fieldAsideOpenIdx = appJsxSrc.lastIndexOf('<aside', fieldAnchorIdx)
  const fieldAsideCloseIdx = appJsxSrc.indexOf('</aside>', fieldAnchorIdx)
  const fieldSlice = fieldAnchorIdx >= 0
    ? appJsxSrc.slice(fieldAsideOpenIdx, fieldAsideCloseIdx + 9)
    : ''
  pass('33a. FIELD aside does NOT contain drawer-tab-spec-table',
    !fieldSlice.includes('drawer-tab-spec-table'))
  pass('33b. FIELD aside does NOT contain <SpecTablePanel />',
    !fieldSlice.includes('<SpecTablePanel />'))
}

// 34. TECHNICAL aside does NOT contain Field-only tab testids.
{
  pass('34a. TECHNICAL aside does NOT contain Properties tab testid',
    !techSlice.includes('drawer-tab-properties'))
  pass('34b. TECHNICAL aside does NOT contain Sequences tab testid',
    !techSlice.includes('drawer-tab-sequences'))
  pass('34c. TECHNICAL aside does NOT contain Annotations tab testid',
    !techSlice.includes('drawer-tab-annotations'))
  pass('34d. TECHNICAL aside does NOT contain Photo tab testid',
    !techSlice.includes('drawer-tab-photo'))
}

// ============================================================================
// BLOCK G — Undo coverage (35–38)
//
// setSpecTable does NOT auto-push undo (the focus→blur edit-session in
// SpecTablePanel handles it). hydrateSpecTableDefaults does NOT push
// undo per spec §"Undo / redo coverage".
// ============================================================================

// 35. setSpecTable does NOT push undo.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  const lenBefore = s.state.undoStack.length
  s.setSpecTable({ partName: 'X' })
  pass('35. setSpecTable does NOT push undo',
    s.state.undoStack.length === lenBefore)
}

// 36. hydrateSpecTableDefaults does NOT push undo.
{
  globalThis.localStorage._reset()
  globalThis.localStorage.setItem(DRAWN_BY_STORAGE_KEY, 'Alice')
  const s = makeSpecTableStore()
  const lenBefore = s.state.undoStack.length
  s.hydrateSpecTableDefaults()
  pass('36a. Hydrate (drawnBy + date) does NOT push undo',
    s.state.undoStack.length === lenBefore)
  pass('36b. → drawnBy populated', s.state.specTable.drawnBy === 'Alice')
  pass('36c. → date populated',
    /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(s.state.specTable.date))
}

// 37. Focus→blur edit-session: change detected → snap pushed.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  // Simulate focus: capture snapshot + original value
  const snap = s.captureUndoSnapshot()
  const originalValue = s.state.specTable.partName
  // Simulate typing
  s.setSpecTable({ partName: 'New Name' })
  // Simulate blur: value changed → push the captured snap
  const lenBefore = s.state.undoStack.length
  if (s.state.specTable.partName !== originalValue && typeof snap === 'string') {
    s.pushCapturedSnapshot(snap)
  }
  pass('37a. Value changed on blur → snap pushed',
    s.state.undoStack.length === lenBefore + 1)
  pass('37b. → pushed snap is the pre-edit one (rollback target)',
    JSON.parse(s.state.undoStack[s.state.undoStack.length - 1]).specTable.partName === '')
}

// 38. Focus→blur edit-session: no change → no snap pushed.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  const snap = s.captureUndoSnapshot()
  const originalValue = s.state.specTable.partName
  // No typing — value stays the same
  const lenBefore = s.state.undoStack.length
  if (s.state.specTable.partName !== originalValue && typeof snap === 'string') {
    s.pushCapturedSnapshot(snap)
  }
  pass('38. Value unchanged on blur → snap NOT pushed',
    s.state.undoStack.length === lenBefore)
}

// ============================================================================
// BLOCK H — Save/Load round-trip (39–41)
//
// Verifies that PERSIST_KEYS + dataSnapshot + importJSON normalization
// preserve all 9 fields. Source-grep on store for the normalizer call.
// ============================================================================

const storeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'store', 'useAppStore.js'),
  'utf-8',
)

// 39. PERSIST_KEYS still contains specTable (existing 18a contract).
{
  const persistKeysMatch = storeSrc.match(/const PERSIST_KEYS = \[([\s\S]*?)\n\]/)
  const persistKeysRaw = persistKeysMatch ? persistKeysMatch[1] : ''
  const persistKeys = (persistKeysRaw.match(/'([a-zA-Z_][a-zA-Z0-9_]*)'/g) || [])
    .map((s) => s.slice(1, -1))
  pass('39. PERSIST_KEYS still contains "specTable"',
    persistKeys.includes('specTable'))
}

// 40. dataSnapshot still includes specTable (existing 18a contract).
{
  pass('40. dataSnapshot includes specTable read',
    /specTable:\s*state\.specTable/.test(storeSrc))
}

// 41. importJSON uses normalizeSpecTable on migrated input (18g contract).
{
  pass('41a. Store imports normalizeSpecTable from specTableValidation',
    /from\s+['"]\.\.\/utils\/specTableValidation['"]/.test(storeSrc))
  pass('41b. importJSON calls normalizeSpecTable(obj.specTable)',
    /normalizeSpecTable\(obj\.specTable\)/.test(storeSrc))
  pass('41c. Initial state uses normalizeSpecTable',
    /normalizeSpecTable\(hydrated\?\.specTable\)/.test(storeSrc))
}

// 42. clearAll uses emptySpecTable (18g contract).
{
  pass('42. clearAll uses emptySpecTable()',
    /specTable:\s*emptySpecTable\(\)/.test(storeSrc))
}

// ============================================================================
// BLOCK I — Round-trip integration (43–45)
//
// End-to-end: hydrate → setSpecTable → simulated reload → values survive.
// ============================================================================

// 43. End-to-end Workflow: hydrate sets defaults, edits round-trip via
//     normalizeSpecTable.
{
  globalThis.localStorage._reset()
  globalThis.localStorage.setItem(DRAWN_BY_STORAGE_KEY, 'Charlie')
  const s = makeSpecTableStore()
  s.hydrateSpecTableDefaults()
  s.setSpecTable({ partName: 'Foo', material: 'Bar', drawingNo: 'D001' })
  // Simulate save → JSON serialize → load → normalize
  const saved = JSON.stringify(s.state.specTable)
  const reloaded = normalizeSpecTable(JSON.parse(saved))
  pass('43a. Round-trip: partName preserved', reloaded.partName === 'Foo')
  pass('43b. → material preserved', reloaded.material === 'Bar')
  pass('43c. → drawingNo preserved', reloaded.drawingNo === 'D001')
  pass('43d. → drawnBy preserved (from hydrate)', reloaded.drawnBy === 'Charlie')
  pass('43e. → date preserved (from hydrate)',
    /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(reloaded.date))
}

// 44. computeIsSpecTableValid integration after hydrate + edits.
{
  globalThis.localStorage._reset()
  const s = makeSpecTableStore()
  s.hydrateSpecTableDefaults()
  pass('44a. After hydrate alone → still invalid (3 required empty)',
    computeIsSpecTableValid(s.state.specTable) === false)
  s.setSpecTable({ partName: 'X', material: 'Y', drawingNo: 'Z' })
  pass('44b. After 3 required filled → valid',
    computeIsSpecTableValid(s.state.specTable) === true)
}

// 45. SPEC_FIELD_LABELS has all 9 fields with human-readable labels.
{
  pass('45a. SPEC_FIELD_LABELS has 9 keys',
    Object.keys(SPEC_FIELD_LABELS).length === 9)
  pass('45b. Every field has a non-empty label',
    SPEC_TABLE_FIELDS.every((f) => typeof SPEC_FIELD_LABELS[f] === 'string'
      && SPEC_FIELD_LABELS[f].length > 0))
  pass('45c. drawingNo label is "Drawing No"',
    SPEC_FIELD_LABELS.drawingNo === 'Drawing No')
  pass('45d. partName label is "Part Name"',
    SPEC_FIELD_LABELS.partName === 'Part Name')
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
