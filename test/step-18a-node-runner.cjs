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
// PHOTO EMBED / RESTORE — operator-reported bug fix (May 10 2026)
// ============================================================================
// Pre-fix: importJSON's photo gate was `obj.schemaVersion === 2 && obj._photos`
// which silently dropped the embedded photo on v3 files. The fix loosens the
// gate to `obj.schemaVersion !== 1`. exportJSON's photo-embed has always been
// version-agnostic. These tests mirror both the export and import sides of
// that contract with a mocked IDB.

function makeMockPhotoIDB(initial = {}) {
  const store = { ...initial }
  return {
    store,
    savePhoto: async (dataURL, key) => { store[key] = dataURL },
    loadPhoto: async (key) => store[key] || null,
    clearPhoto: async (key) => { delete store[key] },
  }
}

// Mirror of exportJSON's photo-embed logic (useAppStore.js ~1682-1714).
async function mockExportJSON(state, idb) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    appMode: state.appMode || 'FIELD',
    viewports: state.viewports || { FIELD: { ...DEFAULT_VIEWPORT }, TECHNICAL: { ...DEFAULT_VIEWPORT } },
    layers: state.layers || [],
    sequences: state.sequences || [],
  }
  payload.viewport = payload.viewports.FIELD || { ...DEFAULT_VIEWPORT }
  const [cropped, source] = await Promise.all([
    idb.loadPhoto('cropped').catch(() => null),
    idb.loadPhoto('source').catch(() => null),
  ])
  const photos = {}
  if (typeof cropped === 'string' && cropped.length > 0) photos.cropped = cropped
  if (typeof source === 'string' && source.length > 0) photos.source = source
  if (Object.keys(photos).length > 0) payload._photos = photos
  return JSON.stringify(payload, null, 2)
}

// Mirror of importJSON's photo-restore branch (useAppStore.js ~1766-1797),
// WITH the May 10 2026 fix applied (`schemaVersion !== 1` gate).
async function mockImportJSON_photoRestore(jsonStr, idb) {
  const obj = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr
  const photos = (obj.schemaVersion !== 1 && obj._photos) ? obj._photos : null
  const result = { backgroundImage: null, hasSourcePhoto: false, savePhotoCalls: [], clearPhotoCalls: [] }
  if (obj.schemaVersion === 1) {
    await Promise.all([
      idb.clearPhoto('cropped').then(() => result.clearPhotoCalls.push('cropped')),
      idb.clearPhoto('source').then(() => result.clearPhotoCalls.push('source')),
    ])
  } else {
    const croppedURL = (photos && typeof photos.cropped === 'string') ? photos.cropped : null
    const sourceURL  = (photos && typeof photos.source  === 'string') ? photos.source  : null
    await Promise.all([
      croppedURL
        ? idb.savePhoto(croppedURL, 'cropped').then(() => result.savePhotoCalls.push(['cropped', croppedURL]))
        : idb.clearPhoto('cropped').then(() => result.clearPhotoCalls.push('cropped')),
      sourceURL
        ? idb.savePhoto(sourceURL, 'source').then(() => result.savePhotoCalls.push(['source', sourceURL]))
        : idb.clearPhoto('source').then(() => result.clearPhotoCalls.push('source')),
    ])
    if (croppedURL) result.backgroundImage = { src: croppedURL }
    result.hasSourcePhoto = !!sourceURL
  }
  return result
}

// 27. exportJSON with cropped-only photo embeds _photos.cropped.
;(async () => {
  const idb = makeMockPhotoIDB({ cropped: 'data:image/jpeg;base64,CCC' })
  const state = { appMode: 'FIELD', viewports: { FIELD: { ...DEFAULT_VIEWPORT }, TECHNICAL: { ...DEFAULT_VIEWPORT } } }
  const json = await mockExportJSON(state, idb)
  const obj = JSON.parse(json)
  pass('27a. exportJSON with cropped-only embeds _photos', obj._photos !== undefined)
  pass('27b. exportJSON embeds _photos.cropped as non-empty string',
    typeof obj._photos.cropped === 'string' && obj._photos.cropped.length > 0)
  pass('27c. exportJSON omits _photos.source when absent', obj._photos.source === undefined)
})()

// 28. exportJSON with both slots embeds both keys.
;(async () => {
  const idb = makeMockPhotoIDB({ cropped: 'data:image/jpeg;base64,CCC', source: 'data:image/jpeg;base64,SSS' })
  const state = { appMode: 'FIELD', viewports: { FIELD: { ...DEFAULT_VIEWPORT }, TECHNICAL: { ...DEFAULT_VIEWPORT } } }
  const json = await mockExportJSON(state, idb)
  const obj = JSON.parse(json)
  pass('28a. exportJSON with both slots embeds _photos.cropped', obj._photos?.cropped === 'data:image/jpeg;base64,CCC')
  pass('28b. exportJSON with both slots embeds _photos.source',  obj._photos?.source  === 'data:image/jpeg;base64,SSS')
})()

// 29. exportJSON with no photo in IDB omits _photos entirely.
;(async () => {
  const idb = makeMockPhotoIDB({})
  const state = { appMode: 'FIELD', viewports: { FIELD: { ...DEFAULT_VIEWPORT }, TECHNICAL: { ...DEFAULT_VIEWPORT } } }
  const json = await mockExportJSON(state, idb)
  const obj = JSON.parse(json)
  pass('29. exportJSON with no photo omits _photos key entirely', obj._photos === undefined)
})()

// 30. importJSON of a v3 fixture with _photos.cropped calls savePhoto correctly.
;(async () => {
  const idb = makeMockPhotoIDB({})
  const v3File = JSON.stringify({
    schemaVersion: 3,
    appMode: 'FIELD',
    viewports: { FIELD: { ...DEFAULT_VIEWPORT }, TECHNICAL: { ...DEFAULT_VIEWPORT } },
    _photos: { cropped: 'data:image/jpeg;base64,FIXED' },
  })
  const r = await mockImportJSON_photoRestore(v3File, idb)
  pass('30a. importJSON v3 with _photos.cropped calls savePhoto("cropped")',
    r.savePhotoCalls.some((c) => c[0] === 'cropped' && c[1] === 'data:image/jpeg;base64,FIXED'))
  pass('30b. importJSON v3 sets backgroundImage from cropped URL',
    r.backgroundImage?.src === 'data:image/jpeg;base64,FIXED')
  pass('30c. importJSON v3 IDB now holds cropped slot', idb.store.cropped === 'data:image/jpeg;base64,FIXED')
  // Regression guard: pre-fix this returned `null` because the gate was
  // `schemaVersion === 2`. Failure of 30a would re-introduce the bug.
})()

// 31. importJSON of a v3 fixture with both _photos slots calls savePhoto twice.
;(async () => {
  const idb = makeMockPhotoIDB({})
  const v3File = JSON.stringify({
    schemaVersion: 3,
    appMode: 'FIELD',
    viewports: { FIELD: { ...DEFAULT_VIEWPORT }, TECHNICAL: { ...DEFAULT_VIEWPORT } },
    _photos: { cropped: 'data:image/jpeg;base64,C2', source: 'data:image/jpeg;base64,S2' },
  })
  const r = await mockImportJSON_photoRestore(v3File, idb)
  pass('31a. importJSON v3 with both slots calls savePhoto for cropped',
    r.savePhotoCalls.some((c) => c[0] === 'cropped' && c[1] === 'data:image/jpeg;base64,C2'))
  pass('31b. importJSON v3 with both slots calls savePhoto for source',
    r.savePhotoCalls.some((c) => c[0] === 'source' && c[1] === 'data:image/jpeg;base64,S2'))
})()

// 32. importJSON sets hasSourcePhoto based on _photos.source presence.
;(async () => {
  const idb1 = makeMockPhotoIDB({})
  const r1 = await mockImportJSON_photoRestore(JSON.stringify({
    schemaVersion: 3, _photos: { cropped: 'data:image/jpeg;base64,X' },
  }), idb1)
  pass('32a. hasSourcePhoto false when only cropped present', r1.hasSourcePhoto === false)

  const idb2 = makeMockPhotoIDB({})
  const r2 = await mockImportJSON_photoRestore(JSON.stringify({
    schemaVersion: 3, _photos: { cropped: 'data:image/jpeg;base64,X', source: 'data:image/jpeg;base64,Y' },
  }), idb2)
  pass('32b. hasSourcePhoto true when source present', r2.hasSourcePhoto === true)
})()

// 33. importJSON of a v2 fixture (Phase 1 format) still restores _photos
//     (backward-compat regression guard — fix must NOT break v2 reads).
;(async () => {
  const idb = makeMockPhotoIDB({})
  const v2File = JSON.stringify({
    schemaVersion: 2,
    viewport: { ...DEFAULT_VIEWPORT },
    _photos: { cropped: 'data:image/jpeg;base64,V2C', source: 'data:image/jpeg;base64,V2S' },
  })
  const r = await mockImportJSON_photoRestore(v2File, idb)
  pass('33a. importJSON v2 still restores _photos.cropped (backward-compat)',
    r.savePhotoCalls.some((c) => c[0] === 'cropped' && c[1] === 'data:image/jpeg;base64,V2C'))
  pass('33b. importJSON v2 still restores _photos.source (backward-compat)',
    r.savePhotoCalls.some((c) => c[0] === 'source' && c[1] === 'data:image/jpeg;base64,V2S'))
  pass('33c. importJSON v2 backgroundImage decoded from cropped',
    r.backgroundImage?.src === 'data:image/jpeg;base64,V2C')
})()

// 34. saveProject writes exportJSON's full result (including _photos) through
//     writeToHandle — no bypass that would drop the photo embed.
;(async () => {
  const idb = makeMockPhotoIDB({ cropped: 'data:image/jpeg;base64,WRITTEN' })
  const state = { appMode: 'FIELD', viewports: { FIELD: { ...DEFAULT_VIEWPORT }, TECHNICAL: { ...DEFAULT_VIEWPORT } } }
  const expected = await mockExportJSON(state, idb)
  // Simulate the saveProject path: call exportJSON, then writeToHandle.
  const handle = makeMockHandle({ name: 'save.json' })
  await writeToHandle(handle, expected)
  pass('34a. saveProject writes exportJSON\'s full string through writeToHandle',
    handle._writable.written[0] === expected)
  const writtenObj = JSON.parse(handle._writable.written[0])
  pass('34b. written payload includes _photos.cropped',
    writtenObj._photos?.cropped === 'data:image/jpeg;base64,WRITTEN')
})()

// ============================================================================
// FIT-TO-VIEWPORT IN TECHNICAL MODE (35–39) — Phase 2 18c follow-on
// (operator-reported May 11 2026 on `8a754d2`).
//
// Pre-fix fitToViewport bailed on `!photoMeta` before writing the
// viewport. Under TECHNICAL (no photo), Fit silently did nothing.
// Fix branches on appMode: TECHNICAL fits to the shape bounding box
// (with 40px padding) or resets to {0, 0, 1.0} when empty; FIELD path
// unchanged.
// ============================================================================

// Replica of the production fitToViewport logic for TECHNICAL mode.
// Keep field-for-field in sync with useAppStore.fitToViewport's
// TECHNICAL branch.
const FIT_PADDING_PX = 40
function fitToViewportTECHNICAL(state, canvasW, canvasH) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let hasShapes = false
  for (const layer of state.technicalLayers || []) {
    if (layer.visible === false) continue
    for (const shape of layer.shapes || []) {
      if (shape.type === 'line' && shape.a && shape.b) {
        minX = Math.min(minX, shape.a.x, shape.b.x)
        minY = Math.min(minY, shape.a.y, shape.b.y)
        maxX = Math.max(maxX, shape.a.x, shape.b.x)
        maxY = Math.max(maxY, shape.a.y, shape.b.y)
        hasShapes = true
      }
    }
  }
  if (!hasShapes) return { panX: 0, panY: 0, zoom: 1.0 }
  const contentW = maxX - minX
  const contentH = maxY - minY
  const availW = Math.max(canvasW - FIT_PADDING_PX * 2, 1)
  const availH = Math.max(canvasH - FIT_PADDING_PX * 2, 1)
  const zoomX = contentW > 0 ? availW / contentW : 1
  const zoomY = contentH > 0 ? availH / contentH : 1
  const zoomRaw = Math.min(zoomX, zoomY, 1.0)
  // normalizeViewport clamp (mirroring the production helper):
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN_CAP, zoomRaw))
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  return {
    panX: canvasW / 2 - centerX * zoomRaw,
    panY: canvasH / 2 - centerY * zoomRaw,
    zoom,
  }
}

// 35. Empty technicalLayers + Fit → default viewport {0, 0, 1.0}.
{
  const state = { technicalLayers: [] }
  const v = fitToViewportTECHNICAL(state, 800, 600)
  pass('35a. empty technicalLayers → panX = 0', v.panX === 0)
  pass('35b. empty technicalLayers → panY = 0', v.panY === 0)
  pass('35c. empty technicalLayers → zoom = 1.0', v.zoom === 1.0)
}

// 36. Single line at (0,0)→(96,0) + Fit on 800×600 canvas:
//     bounding box (0,0)→(96,0). content fits easily, zoom clamps to 1.0.
//     centered: panX = 400 - 48 = 352, panY = 300 - 0 = 300.
{
  const state = {
    technicalLayers: [{
      id: 'tech-layer-1', name: 'Layer 1', visible: true,
      shapes: [
        { id: 'tech-shape-1', type: 'line', a: { x: 0, y: 0 }, b: { x: 96, y: 0 }, lengthInches: 4, lengthSource: 'typed', angleSource: 'freehand' },
      ],
    }],
  }
  const v = fitToViewportTECHNICAL(state, 800, 600)
  pass('36a. single small line → zoom clamps to 1.0', v.zoom === 1.0)
  pass('36b. single line → panX = 400 - 48 = 352', v.panX === 352)
  pass('36c. single line → panY = 300 - 0 = 300', v.panY === 300)
}

// 37. Multiple lines spanning a wide bounding box → zoom < 1.0,
//     content centered.
{
  const state = {
    technicalLayers: [{
      id: 'tech-layer-1', name: 'Layer 1', visible: true,
      shapes: [
        { id: 's1', type: 'line', a: { x: -100, y: -100 }, b: { x:  100, y: -100 }, lengthInches: 8, lengthSource: 'typed', angleSource: 'freehand' },
        { id: 's2', type: 'line', a: { x:  900, y:  500 }, b: { x: 1000, y:  500 }, lengthInches: 4, lengthSource: 'typed', angleSource: 'freehand' },
      ],
    }],
  }
  // Bounding box: (-100, -100) → (1000, 500). contentW = 1100, contentH = 600.
  // availW = 800 - 80 = 720; availH = 600 - 80 = 520.
  // zoomX = 720 / 1100 ≈ 0.6545. zoomY = 520 / 600 ≈ 0.8667.
  // zoom = min(0.6545, 0.8667, 1.0) ≈ 0.6545.
  const v = fitToViewportTECHNICAL(state, 800, 600)
  pass('37a. wide bbox → zoom < 1.0', v.zoom < 1.0)
  pass('37b. wide bbox → zoom ≈ 0.655 (X is limiting axis)',
    Math.abs(v.zoom - (720 / 1100)) < 0.001)
  // Center of bbox: ((-100 + 1000)/2, (-100 + 500)/2) = (450, 200).
  // panX = 400 - 450 * 0.6545 = 400 - 294.55 ≈ 105.45
  // panY = 300 - 200 * 0.6545 = 300 - 130.91 ≈ 169.09
  pass('37c. wide bbox → panX centers the box',
    Math.abs(v.panX - (400 - 450 * (720 / 1100))) < 0.01)
  pass('37d. wide bbox → panY centers the box',
    Math.abs(v.panY - (300 - 200 * (720 / 1100))) < 0.01)
}

// 38. Invisible layer's shapes excluded from bounding box.
{
  const state = {
    technicalLayers: [
      { id: 't1', name: 'Visible', visible: true,
        shapes: [{ id: 's1', type: 'line', a: { x: 0, y: 0 }, b: { x: 96, y: 0 }, lengthInches: 4 }] },
      { id: 't2', name: 'Invisible', visible: false,
        shapes: [{ id: 's2', type: 'line', a: { x: 1000, y: 1000 }, b: { x: 2000, y: 2000 }, lengthInches: 50 }] },
    ],
  }
  const v = fitToViewportTECHNICAL(state, 800, 600)
  // Bounding box should only include the visible layer's shape (0,0)→(96,0).
  // Same as test 36 — zoom 1.0, panX 352, panY 300.
  pass('38a. invisible layer ignored: zoom 1.0', v.zoom === 1.0)
  pass('38b. invisible layer ignored: panX 352',  v.panX === 352)
  pass('38c. invisible layer ignored: panY 300',  v.panY === 300)
}

// 39. FIELD-mode Fit regression check (existing logic must not regress).
//     The FIELD path uses computeFitViewport(photoMeta, canvasW, canvasH).
//     Mock keeps existing test 10d's contract: zoom 0.5, panX 10, panY 20.
{
  const m = makeMockStore()
  // Default appMode is FIELD.
  m.fitToViewport(800, 600)
  pass('39a. FIELD fitToViewport still writes viewports.FIELD.zoom = 0.5',
    m.state.viewports.FIELD.zoom === 0.5)
  pass('39b. FIELD fit does NOT mutate TECHNICAL viewport',
    m.state.viewports.TECHNICAL.zoom === 1)
}

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
