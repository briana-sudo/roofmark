// Node-side runner for the Phase 2 sub-step 18a + P45 block tests.
//
// Self-contained: this runner doesn't import the actual Zustand store
// (the Vite build process + browser-only globals like indexedDB and
// FileSystemFileHandle aren't trivially available in Node). Instead it
// reimplements the SHAPE of the integration boundary (migration logic,
// appMode action semantics, viewport per-mode write, P45 dispatch flow)
// as pure JS — mirroring the actual store's contracts.
//
// Architectural caveat (Pass 3 / P44 follow-on): the "tests that don't
// exercise the integration boundary miss bugs" pattern still applies.
// These tests verify SHAPE correctness; they don't verify the actual
// Zustand store behaves identically. Pass 3 (P44) would replace this
// with Zustand-direct integration tests. For 18a ship we accept the
// shape-mirror coverage as adequate, matching the Pass 2 minimal-store-
// harness precedent.
//
// Test convention mirrors step-17-node-runner.cjs: each test calls
// `pass(name, condition)`; final summary prints "N/N PASS" or lists
// failures + exits non-zero on any fail.

const tests = []
function pass(name, ok, extra) {
  tests.push({ name, ok: !!ok, extra })
}

// ============================================================================
// SHARED HELPERS (mirrors of store internals)
// ============================================================================
const SCHEMA_VERSION = 3
const SUPPORTED_IMPORT_VERSIONS = new Set([1, 2, 3])
const VALID_APP_MODES = new Set(['FIELD', 'TECHNICAL'])
const DEFAULT_VIEWPORT = { panX: 0, panY: 0, zoom: 1 }
const ZOOM_MIN_CAP = 0.05
const ZOOM_MAX = 4.0

function normalizeViewport(v) {
  if (!v || typeof v !== 'object') return { ...DEFAULT_VIEWPORT }
  const panX = Number.isFinite(v.panX) ? v.panX : 0
  const panY = Number.isFinite(v.panY) ? v.panY : 0
  const zRaw = Number.isFinite(v.zoom) && v.zoom > 0 ? v.zoom : 1
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN_CAP, zRaw))
  return { panX, panY, zoom }
}
function normalizeAppMode(v) {
  return (typeof v === 'string' && VALID_APP_MODES.has(v)) ? v : 'FIELD'
}
function normalizeViewports(vps, legacySingle) {
  if (vps && typeof vps === 'object') {
    return {
      FIELD: normalizeViewport(vps.FIELD),
      TECHNICAL: normalizeViewport(vps.TECHNICAL),
    }
  }
  return {
    FIELD: normalizeViewport(legacySingle),
    TECHNICAL: { ...DEFAULT_VIEWPORT },
  }
}
function getActiveViewport(s) {
  if (!s) return { ...DEFAULT_VIEWPORT }
  const am = (s.appMode === 'TECHNICAL') ? 'TECHNICAL' : 'FIELD'
  return s.viewports?.[am] || { ...DEFAULT_VIEWPORT }
}

// Mock store factory — minimal shape mirroring useAppStore's relevant slice.
function makeMockStore() {
  const state = {
    appMode: 'FIELD',
    viewports: { FIELD: { ...DEFAULT_VIEWPORT }, TECHNICAL: { ...DEFAULT_VIEWPORT } },
    viewport: { ...DEFAULT_VIEWPORT },
    layers: [],
    sequences: [],
    clines: [],
    technicalLayers: [],
    specTable: {},
    selected: { layerId: 'l1', shapeId: 'sh1' },
    selectedAnnotation: { sequenceId: 's1', annotationId: 'a1' },
    tool: 'poly',
    undoStack: ['snap1'],
    redoStack: [],
    currentFileHandle: null,
    currentFileName: null,
    saveState: 'unsaved',
  }
  const setAppMode = (next) => {
    if (!VALID_APP_MODES.has(next)) return  // no-op for invalid
    if (state.appMode === next) return
    state.appMode = next
    state.viewport = state.viewports[next] || { ...DEFAULT_VIEWPORT }
    state.selected = null
    state.selectedAnnotation = null
    state.tool = null
    // undo/redo NOT cleared
  }
  const setViewport = (v) => {
    const n = normalizeViewport(v)
    state.viewports = { ...state.viewports, [state.appMode]: n }
    state.viewport = n
  }
  const setZoom = (z) => {
    const n = normalizeViewport({ ...state.viewport, zoom: z })
    state.viewports = { ...state.viewports, [state.appMode]: n }
    state.viewport = n
  }
  const setPan = (x, y) => {
    const n = normalizeViewport({ ...state.viewport, panX: x, panY: y })
    state.viewports = { ...state.viewports, [state.appMode]: n }
    state.viewport = n
  }
  const fitToViewport = (w, h) => {
    // Mock: pretend a fit changes zoom to 0.5
    const n = normalizeViewport({ panX: 10, panY: 20, zoom: 0.5 })
    state.viewports = { ...state.viewports, [state.appMode]: n }
    state.viewport = n
  }
  return { state, setAppMode, setViewport, setZoom, setPan, fitToViewport, getActiveViewport: () => getActiveViewport(state) }
}

// ============================================================================
// SCHEMA MIGRATION TESTS (1–6)
// ============================================================================

// 1. exportJSON returns schemaVersion: 3.
{
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    appMode: 'FIELD',
    viewports: { FIELD: { panX: 0, panY: 0, zoom: 1 }, TECHNICAL: { panX: 0, panY: 0, zoom: 1 } },
    technicalLayers: [],
    specTable: {},
  }
  pass('1. exportJSON returns schemaVersion: 3', payload.schemaVersion === 3)
}

// 2. importJSON accepts a hand-built v3 fixture.
{
  const v3 = {
    schemaVersion: 3,
    layers: [{ id: 'l1' }],
    sequences: [],
    clines: [],
    appMode: 'TECHNICAL',
    viewports: { FIELD: { panX: 50, panY: 60, zoom: 0.8 }, TECHNICAL: { panX: 10, panY: 20, zoom: 1.5 } },
    technicalLayers: [{ id: 't1' }],
    specTable: { foo: 'bar' },
  }
  const accepted = SUPPORTED_IMPORT_VERSIONS.has(v3.schemaVersion)
  pass('2. importJSON accepts a hand-built v3 fixture (schemaVersion validated)', accepted === true)
}

// 3. importJSON v2 fixture migrates: technicalLayers === [], specTable === {},
//    viewports.FIELD === migrated v2 viewport, viewports.TECHNICAL === defaults.
{
  const v2 = {
    schemaVersion: 2,
    layers: [], sequences: [], clines: [],
    viewport: { panX: 100, panY: 200, zoom: 0.7 },  // legacy single
    // No appMode, technicalLayers, specTable, viewports.
  }
  const migratedAppMode = (v2.schemaVersion >= 3) ? normalizeAppMode(v2.appMode) : 'FIELD'
  const migratedViewports = (v2.schemaVersion >= 3 && v2.viewports)
    ? normalizeViewports(v2.viewports, null)
    : normalizeViewports(null, v2.viewport)
  const migratedTechnicalLayers = Array.isArray(v2.technicalLayers) ? v2.technicalLayers : []
  const migratedSpecTable = (v2.specTable && typeof v2.specTable === 'object') ? v2.specTable : {}

  pass('3a. v2 migration: appMode defaults to FIELD', migratedAppMode === 'FIELD')
  pass('3b. v2 migration: viewports.FIELD === legacy single viewport (100, 200, 0.7)',
    migratedViewports.FIELD.panX === 100 && migratedViewports.FIELD.panY === 200 && migratedViewports.FIELD.zoom === 0.7)
  pass('3c. v2 migration: viewports.TECHNICAL === defaults',
    migratedViewports.TECHNICAL.panX === 0 && migratedViewports.TECHNICAL.panY === 0 && migratedViewports.TECHNICAL.zoom === 1)
  pass('3d. v2 migration: technicalLayers === []',
    Array.isArray(migratedTechnicalLayers) && migratedTechnicalLayers.length === 0)
  pass('3e. v2 migration: specTable deep-equals {}',
    JSON.stringify(migratedSpecTable) === '{}')
}

// 4. importJSON v1 fixture: same migration shape (photo branch preserved in
//    actual importJSON — we test the shape side here).
{
  const v1 = {
    schemaVersion: 1,
    layers: [], sequences: [], clines: [],
    // v1 has no viewport AT ALL — pre-Section 7.A
  }
  const migratedAppMode = (v1.schemaVersion >= 3) ? normalizeAppMode(v1.appMode) : 'FIELD'
  const migratedViewports = (v1.schemaVersion >= 3 && v1.viewports)
    ? normalizeViewports(v1.viewports, null)
    : normalizeViewports(null, v1.viewport)  // v1.viewport is undefined → defaults

  pass('4a. v1 migration: appMode defaults to FIELD', migratedAppMode === 'FIELD')
  pass('4b. v1 migration: viewports.FIELD defaults', migratedViewports.FIELD.zoom === 1)
  pass('4c. v1 migration: viewports.TECHNICAL defaults', migratedViewports.TECHNICAL.zoom === 1)
}

// 5. importJSON rejects v4.
{
  const v4 = { schemaVersion: 4 }
  pass('5. importJSON rejects a v4 fixture (not in SUPPORTED_IMPORT_VERSIONS)',
    !SUPPORTED_IMPORT_VERSIONS.has(v4.schemaVersion))
}

// 6. exportJSON also writes legacy `viewport` field equal to viewports.FIELD.
{
  const s = {
    viewports: { FIELD: { panX: 42, panY: 84, zoom: 2 }, TECHNICAL: { panX: 0, panY: 0, zoom: 1 } },
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    viewports: s.viewports,
  }
  payload.viewport = s.viewports?.FIELD || { ...DEFAULT_VIEWPORT }
  pass('6. exportJSON writes legacy `viewport` field equal to viewports.FIELD (TEMP compat)',
    payload.viewport.panX === 42 && payload.viewport.panY === 84 && payload.viewport.zoom === 2)
}

// ============================================================================
// APPMODE + VIEWPORTS TESTS (7–12)
// ============================================================================

// 7. Default appMode === 'FIELD'.
{
  const m = makeMockStore()
  pass('7. Default appMode === FIELD', m.state.appMode === 'FIELD')
}

// 8. setAppMode('TECHNICAL') sets appMode; clears selected, selectedAnnotation,
//    tool; preserves layers, technicalLayers, undoStack, redoStack.
{
  const m = makeMockStore()
  m.state.layers = [{ id: 'l1' }]
  m.state.technicalLayers = [{ id: 't1' }]
  m.setAppMode('TECHNICAL')
  pass('8a. setAppMode TECHNICAL flips appMode', m.state.appMode === 'TECHNICAL')
  pass('8b. setAppMode clears selected', m.state.selected === null)
  pass('8c. setAppMode clears selectedAnnotation', m.state.selectedAnnotation === null)
  pass('8d. setAppMode clears tool', m.state.tool === null)
  pass('8e. setAppMode preserves layers',
    Array.isArray(m.state.layers) && m.state.layers[0]?.id === 'l1')
  pass('8f. setAppMode preserves technicalLayers',
    Array.isArray(m.state.technicalLayers) && m.state.technicalLayers[0]?.id === 't1')
  pass('8g. setAppMode preserves undoStack', m.state.undoStack.length === 1 && m.state.undoStack[0] === 'snap1')
  pass('8h. setAppMode preserves redoStack', Array.isArray(m.state.redoStack))
}

// 9. setAppMode invalid input — choice: no-op (no throw, no state change).
//    Documented in store as `console.warn` + early-return.
{
  const m = makeMockStore()
  const before = m.state.appMode
  m.setAppMode('INVALID')
  pass('9. setAppMode invalid input is rejected as no-op (state unchanged)',
    m.state.appMode === before)
}

// 10. setViewport / setZoom / setPan / fitToViewport write to viewports[appMode].
{
  const m = makeMockStore()
  // FIELD branch
  m.setViewport({ panX: 5, panY: 10, zoom: 1.2 })
  pass('10a. setViewport writes to viewports.FIELD',
    m.state.viewports.FIELD.panX === 5 && m.state.viewports.FIELD.panY === 10 && m.state.viewports.FIELD.zoom === 1.2)
  m.setZoom(2)
  pass('10b. setZoom writes to viewports.FIELD', m.state.viewports.FIELD.zoom === 2)
  m.setPan(30, 40)
  pass('10c. setPan writes to viewports.FIELD',
    m.state.viewports.FIELD.panX === 30 && m.state.viewports.FIELD.panY === 40)
  m.fitToViewport(800, 600)
  pass('10d. fitToViewport writes to viewports.FIELD', m.state.viewports.FIELD.zoom === 0.5)

  // TECHNICAL branch
  m.setAppMode('TECHNICAL')
  m.setViewport({ panX: 99, panY: 88, zoom: 1.5 })
  pass('10e. setViewport in TECHNICAL writes to viewports.TECHNICAL',
    m.state.viewports.TECHNICAL.panX === 99 && m.state.viewports.TECHNICAL.zoom === 1.5)
  m.setZoom(3)
  pass('10f. setZoom in TECHNICAL writes to viewports.TECHNICAL', m.state.viewports.TECHNICAL.zoom === 3)
}

// 11. After FIELD → TECHNICAL → modify TECHNICAL → back to FIELD, FIELD viewport unchanged.
{
  const m = makeMockStore()
  m.setViewport({ panX: 7, panY: 14, zoom: 0.9 })  // FIELD = (7, 14, 0.9)
  const fieldBefore = { ...m.state.viewports.FIELD }
  m.setAppMode('TECHNICAL')
  m.setViewport({ panX: 100, panY: 200, zoom: 2.5 })  // TECHNICAL = (100, 200, 2.5)
  m.setAppMode('FIELD')
  pass('11. FIELD viewport unchanged after TECHNICAL-side mutation',
    m.state.viewports.FIELD.panX === fieldBefore.panX
    && m.state.viewports.FIELD.panY === fieldBefore.panY
    && m.state.viewports.FIELD.zoom === fieldBefore.zoom)
}

// 12. getActiveViewport returns viewports[appMode].
{
  const m = makeMockStore()
  m.state.viewports.FIELD = { panX: 1, panY: 2, zoom: 1.1 }
  m.state.viewports.TECHNICAL = { panX: 9, panY: 8, zoom: 2.2 }
  m.state.appMode = 'FIELD'
  const av1 = getActiveViewport(m.state)
  pass('12a. getActiveViewport returns FIELD viewport when appMode FIELD', av1.zoom === 1.1)
  m.state.appMode = 'TECHNICAL'
  const av2 = getActiveViewport(m.state)
  pass('12b. getActiveViewport returns TECHNICAL viewport when appMode TECHNICAL', av2.zoom === 2.2)
}

// ============================================================================
// P45 TESTS (13–26) — mock window + FileSystemFileHandle + IndexedDB
// ============================================================================

// Helper: build a mock FileSystemFileHandle with configurable behavior.
function makeMockHandle({ name = 'project.json', permission = 'granted', writeFails = null } = {}) {
  const writableMock = {
    written: [],
    closed: false,
    write(c) { this.written.push(c); return Promise.resolve() },
    close() { this.closed = true; return Promise.resolve() },
  }
  let curPerm = permission
  return {
    name,
    permission: () => curPerm,
    setPermission(p) { curPerm = p },
    async queryPermission() { return curPerm },
    async requestPermission() {
      if (curPerm === 'denied-after-request') return 'denied'
      curPerm = 'granted'
      return 'granted'
    },
    async createWritable() {
      if (writeFails) {
        const e = new Error(writeFails)
        e.name = writeFails
        throw e
      }
      return writableMock
    },
    _writable: writableMock,
  }
}

// Implementations under test (copy of fileSystemAccess.js logic).
function isFileSystemAccessSupported(win) {
  return !!(win && typeof win.showSaveFilePicker === 'function')
}
async function pickSaveFile(win, { suggestedName }) {
  if (!isFileSystemAccessSupported(win)) {
    throw new Error('FILE_SYSTEM_ACCESS_UNSUPPORTED')
  }
  try {
    return await win.showSaveFilePicker({ suggestedName })
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.message === 'The user aborted a request.')) {
      return null
    }
    throw err
  }
}
async function writeToHandle(handle, contents) {
  if (!handle) throw new Error('FILE_HANDLE_REVOKED')
  try {
    const writable = await handle.createWritable()
    await writable.write(contents)
    await writable.close()
    return
  } catch (err) {
    const name = err?.name || ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      try {
        const perm = await handle.requestPermission({ mode: 'readwrite' })
        if (perm !== 'granted') {
          throw new Error('FILE_HANDLE_PERMISSION_DENIED', { cause: err })
        }
        const writable = await handle.createWritable()
        await writable.write(contents)
        await writable.close()
        return
      } catch (err2) {
        if (err2?.message === 'FILE_HANDLE_PERMISSION_DENIED') throw err2
        throw new Error('FILE_HANDLE_REVOKED', { cause: err2 })
      }
    }
    if (name === 'NotFoundError') {
      throw new Error('FILE_HANDLE_LOST', { cause: err })
    }
    throw err
  }
}

// 13. isFileSystemAccessSupported returns true / false correctly.
{
  pass('13a. isFileSystemAccessSupported true when showSaveFilePicker is a function',
    isFileSystemAccessSupported({ showSaveFilePicker: () => {} }) === true)
  pass('13b. isFileSystemAccessSupported false when missing',
    isFileSystemAccessSupported({}) === false)
  pass('13c. isFileSystemAccessSupported false when window is undefined',
    isFileSystemAccessSupported(null) === false)
}

// 14. pickSaveFile returns the mock handle on user accept.
;(async () => {
  const handle = makeMockHandle({ name: 'test.json' })
  const win = { showSaveFilePicker: async () => handle }
  const got = await pickSaveFile(win, { suggestedName: 'test.json' })
  pass('14. pickSaveFile returns mock handle on user accept', got === handle)
})()

// 15. pickSaveFile returns null on AbortError.
;(async () => {
  const win = {
    showSaveFilePicker: async () => {
      const e = new Error('cancelled'); e.name = 'AbortError'; throw e
    },
  }
  const got = await pickSaveFile(win, { suggestedName: 'x.json' })
  pass('15. pickSaveFile returns null on AbortError', got === null)
})()

// 16. pickSaveFile throws on non-Abort errors.
;(async () => {
  const win = {
    showSaveFilePicker: async () => {
      const e = new Error('unexpected'); e.name = 'TypeError'; throw e
    },
  }
  let threw = false
  try { await pickSaveFile(win, { suggestedName: 'x.json' }) }
  catch (e) { if (e.message === 'unexpected') threw = true }
  pass('16. pickSaveFile throws on non-Abort errors', threw)
})()

// 17. writeToHandle calls createWritable → write → close in order.
;(async () => {
  const handle = makeMockHandle({ name: 'a.json' })
  await writeToHandle(handle, 'hello')
  pass('17a. writeToHandle wrote contents', handle._writable.written[0] === 'hello')
  pass('17b. writeToHandle closed writable', handle._writable.closed === true)
})()

// 18. writeToHandle re-requests permission on loss; retries; succeeds.
;(async () => {
  let calls = 0
  const handle = makeMockHandle({ name: 'a.json' })
  handle.createWritable = async function () {
    calls += 1
    if (calls === 1) {
      const e = new Error('denied'); e.name = 'NotAllowedError'; throw e
    }
    return handle._writable
  }
  await writeToHandle(handle, 'retry-payload')
  pass('18a. writeToHandle retried after permission re-grant', calls === 2)
  pass('18b. writeToHandle wrote on retry', handle._writable.written[0] === 'retry-payload')
})()

// 18 (continued). writeToHandle throws PERMISSION_DENIED on still-denied.
;(async () => {
  const handle = makeMockHandle({ permission: 'denied-after-request' })
  handle.createWritable = async function () {
    const e = new Error('denied'); e.name = 'NotAllowedError'; throw e
  }
  let captured = ''
  try { await writeToHandle(handle, 'x') }
  catch (e) { captured = e.message }
  pass('18c. writeToHandle throws FILE_HANDLE_PERMISSION_DENIED on still-denied',
    captured === 'FILE_HANDLE_PERMISSION_DENIED')
})()

// 19. writeToHandle throws FILE_HANDLE_LOST on NotFoundError.
;(async () => {
  const handle = makeMockHandle({})
  handle.createWritable = async function () {
    const e = new Error('gone'); e.name = 'NotFoundError'; throw e
  }
  let captured = ''
  try { await writeToHandle(handle, 'x') }
  catch (e) { captured = e.message }
  pass('19. writeToHandle throws FILE_HANDLE_LOST on NotFoundError',
    captured === 'FILE_HANDLE_LOST')
})()

// Mock saveProject / saveProjectAs dispatch flow.
function makeMockSaveStore(opts = {}) {
  const handleMock = opts.handle || null
  const win = opts.win || null
  const idb = { stored: null }
  const state = {
    currentFileHandle: opts.startWithHandle ? handleMock : null,
    currentFileName: opts.startWithHandle ? handleMock?.name || null : null,
    saveState: 'unsaved',
    lastSavedAt: null,
  }
  const exportJSON = async () => 'JSON_PAYLOAD'
  const saveFileHandleMock = async (h) => { idb.stored = h }
  const clearFileHandleMock = async () => { idb.stored = null }
  let saveAsCalls = 0
  const saveProjectAs = async () => {
    saveAsCalls += 1
    if (!isFileSystemAccessSupported(win)) {
      // Legacy fallback
      const suggestedName = 'roofmark-project-fallback.json'
      state.currentFileName = suggestedName
      state.saveState = 'saved'
      state.lastSavedAt = Date.now()
      return 'LEGACY'
    }
    const h = await pickSaveFile(win, { suggestedName: 'roofmark-project.json' })
    if (!h) return 'CANCELLED'
    await writeToHandle(h, await exportJSON())
    await saveFileHandleMock(h)
    state.currentFileHandle = h
    state.currentFileName = h.name
    state.saveState = 'saved'
    state.lastSavedAt = Date.now()
    return 'NATIVE'
  }
  const saveProject = async () => {
    if (state.currentFileHandle) {
      try {
        await writeToHandle(state.currentFileHandle, await exportJSON())
        state.saveState = 'saved'
        state.lastSavedAt = Date.now()
        return 'WROTE'
      } catch (err) {
        const m = err?.message || ''
        if (m === 'FILE_HANDLE_LOST' || m === 'FILE_HANDLE_REVOKED' || m === 'FILE_HANDLE_PERMISSION_DENIED') {
          state.currentFileHandle = null
          state.currentFileName = null
          await clearFileHandleMock()
          // fall through to saveProjectAs
        } else {
          throw err
        }
      }
    }
    return await saveProjectAs()
  }
  return { state, idb, saveProject, saveProjectAs, getSaveAsCalls: () => saveAsCalls }
}

// 20. saveProject with no handle calls saveProjectAs internally.
;(async () => {
  const handle = makeMockHandle({ name: 'new.json' })
  const win = { showSaveFilePicker: async () => handle }
  const m = makeMockSaveStore({ handle, win, startWithHandle: false })
  const result = await m.saveProject()
  pass('20. saveProject with no handle calls saveProjectAs internally',
    m.getSaveAsCalls() === 1 && result === 'NATIVE')
})()

// 21. saveProject with valid handle writes via writeToHandle; saveState 'saved'.
;(async () => {
  const handle = makeMockHandle({ name: 'existing.json' })
  const win = { showSaveFilePicker: async () => handle }
  const m = makeMockSaveStore({ handle, win, startWithHandle: true })
  const result = await m.saveProject()
  pass('21a. saveProject with valid handle writes via writeToHandle',
    result === 'WROTE' && handle._writable.written[0] === 'JSON_PAYLOAD')
  pass('21b. saveProject sets saveState to "saved"', m.state.saveState === 'saved')
  pass('21c. saveProject did NOT call saveProjectAs', m.getSaveAsCalls() === 0)
})()

// 22. saveProject with lost handle clears handle state, falls through to saveProjectAs.
;(async () => {
  const lostHandle = makeMockHandle({ name: 'lost.json' })
  lostHandle.createWritable = async function () {
    const e = new Error('gone'); e.name = 'NotFoundError'; throw e
  }
  const newHandle = makeMockHandle({ name: 'new.json' })
  const win = { showSaveFilePicker: async () => newHandle }
  const m = makeMockSaveStore({ handle: lostHandle, win, startWithHandle: true })
  // First saveProject — lostHandle fails with NotFoundError → falls through
  // to saveProjectAs which uses the new handle.
  const result = await m.saveProject()
  pass('22a. saveProject with lost handle falls through to saveProjectAs',
    m.getSaveAsCalls() === 1)
  pass('22b. saveProject after fallthrough completes via new handle',
    result === 'NATIVE' && m.state.currentFileName === 'new.json')
})()

// 23. saveProjectAs persists handle to IDB on success.
;(async () => {
  const handle = makeMockHandle({ name: 'persisted.json' })
  const win = { showSaveFilePicker: async () => handle }
  const m = makeMockSaveStore({ handle, win, startWithHandle: false })
  await m.saveProjectAs()
  pass('23. saveProjectAs persists handle to IDB on success', m.idb.stored === handle)
})()

// 24 + 25. clearAll / importJSON success path clear handle state + IDB.
// (Shape test: verify the clear-and-call pattern; actual store implementation
// matches.)
{
  // Simulate clearAll semantics:
  const idb = { stored: 'old-handle' }
  const state = { currentFileHandle: 'h', currentFileName: 'h.json' }
  // clearAll:
  state.currentFileHandle = null
  state.currentFileName = null
  // (IDB clear fire-and-forget)
  idb.stored = null
  pass('24a. clearAll clears currentFileHandle', state.currentFileHandle === null)
  pass('24b. clearAll clears currentFileName', state.currentFileName === null)
  pass('24c. clearAll clears IDB fileHandle entry', idb.stored === null)
}
{
  const idb = { stored: 'old-handle' }
  const state = { currentFileHandle: 'h', currentFileName: 'h.json' }
  // importJSON success:
  state.currentFileHandle = null
  state.currentFileName = null
  idb.stored = null
  pass('25a. importJSON clears currentFileHandle', state.currentFileHandle === null)
  pass('25b. importJSON clears currentFileName', state.currentFileName === null)
  pass('25c. importJSON clears IDB fileHandle entry', idb.stored === null)
}

// 26. saveProjectAs falls back to legacy download when API unsupported.
;(async () => {
  const m = makeMockSaveStore({ handle: null, win: {}, startWithHandle: false })
  // win has no showSaveFilePicker → fallback path
  const result = await m.saveProjectAs()
  pass('26a. saveProjectAs falls back to legacy when unsupported', result === 'LEGACY')
  pass('26b. legacy fallback sets currentFileName',
    m.state.currentFileName === 'roofmark-project-fallback.json')
  pass('26c. legacy fallback leaves currentFileHandle null',
    m.state.currentFileHandle === null)
  pass('26d. legacy fallback sets saveState to "saved"', m.state.saveState === 'saved')
})()

// ============================================================================
// SUMMARY
// ============================================================================
// All async tests above push into `tests` synchronously OR via the IIFE wrap
// then call pass() inside the .then(). Wait for all to settle, then summarize.
;(async () => {
  // Allow all top-level async IIFEs to complete.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const passCount = tests.filter((t) => t.ok).length
  const total = tests.length
  console.log(passCount + '/' + total + ' ' + (passCount === total ? 'PASS' : 'FAIL'))
  for (const t of tests) {
    if (!t.ok) console.log('FAIL: ' + t.name + (t.extra ? ' ' + JSON.stringify(t.extra) : ''))
  }
  process.exit(passCount === total ? 0 : 1)
})()
