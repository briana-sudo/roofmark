import { create } from 'zustand'
import { loadPhoto } from './photoIDB'

// ============================================================================
// RoofMark application store — Step 2 of Kickoff Spec Section 16
//
// Carries:
//   LAYERS    (Spec §5)   — drawing layers with shapes, color, opacity, visibility
//   SHAPES    (Spec §6)   — nested under each layer
//   SEQUENCES (Spec §10)  — installation sequences with per-seq layer toggles
//                          and annotations (callout/dimline/note)
//   CLINES    (Spec §6.6) — construction lines (separate from layers)
//   APP STATE             — mode, tool, active selections, snap/grid, cursor
//   JOB CONTEXT           — jobId/address/scope/crew (Step 15 populates)
//   SAVE STATE            — saved/unsaved/saving + lastSavedAt
//   UNDO STACK            — 50-step (Spec §15) JSON snapshots of layers/
//                          sequences/clines (data only, not transient UI)
//
// Persistence: explicit 2-second-debounced autosave to localStorage on any
// data mutation (layers / sequences / clines / jobContext). Cursor moves and
// other transient UI mutations are NOT persisted (reference-equality guard
// in the subscribe listener).
//
// Dev console exposure: window.__appStore = useAppStore so console smoke
// tests can drive store actions directly via `__appStore.getState()` and
// `__appStore.subscribe(...)` (replaces /test/step-2-functional.html per
// April 29 2026 operator override on Rule 27).
// ============================================================================

const STORAGE_KEY = 'roofmark_project_v1'
const AUTOSAVE_DEBOUNCE_MS = 2000
const UNDO_LIMIT = 50

// ---- ID generators ---------------------------------------------------------
let _layerSeq = 0
let _shapeSeq = 0
let _seqSeq = 0
let _clineSeq = 0
let _annoSeq = 0
const newLayerId = () => `l${++_layerSeq}`
const newShapeId = () => `sh${++_shapeSeq}`
const newSeqId = () => `s${++_seqSeq}`
const newClineId = () => `cl${++_clineSeq}`
const newAnnoId = () => `a${++_annoSeq}`

// ---- Defaults --------------------------------------------------------------
// Spec §5: "+ Add Layer button — creates blank layer with name 'New Layer',
// color #ffffff". User picks the real color via the layer panel color picker.
const DEFAULT_LAYER_COLOR = '#ffffff'

const layerDefaults = () => ({
  id: newLayerId(),
  name: 'New Layer',
  color: DEFAULT_LAYER_COLOR,
  visible: true,
  fillOpacity: 0.25,
  strokeOpacity: 1.0,
  strokeWeight: 2,
  fillOn: true,
  strokeOn: true,
  shapes: [],
})

const sequenceDefaults = (n) => ({
  id: newSeqId(),
  title: `S${n} — New Sequence`,
  layers: {},
  annotations: [],
})

// ---- Persistence -----------------------------------------------------------
const PERSIST_KEYS = ['layers', 'sequences', 'clines', 'jobContext']

const loadFromStorage = () => {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const persist = (state) => {
  if (typeof localStorage === 'undefined') return
  const slice = {}
  for (const k of PERSIST_KEYS) slice[k] = state[k]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slice))
  } catch (e) {
    console.warn('roofmark autosave failed:', e)
  }
}

// Bump ID counters from a hydrated state so new IDs don't collide
const reseedCounters = (data) => {
  if (!data) return
  const bump = (s, ref) => {
    const n = parseInt(String(s).replace(/^[a-z]+/, ''), 10)
    if (!isNaN(n) && n > ref.value) ref.value = n
  }
  const refs = { l: { value: _layerSeq }, sh: { value: _shapeSeq }, s: { value: _seqSeq }, cl: { value: _clineSeq }, a: { value: _annoSeq } }
  for (const layer of data.layers || []) {
    bump(layer.id || 'l0', refs.l)
    for (const shape of layer.shapes || []) bump(shape.id || 'sh0', refs.sh)
  }
  for (const seq of data.sequences || []) {
    bump(seq.id || 's0', refs.s)
    for (const a of seq.annotations || []) bump(a.id || 'a0', refs.a)
  }
  for (const cl of data.clines || []) bump(cl.id || 'cl0', refs.cl)
  _layerSeq = refs.l.value
  _shapeSeq = refs.sh.value
  _seqSeq = refs.s.value
  _clineSeq = refs.cl.value
  _annoSeq = refs.a.value
}

const hydrated = loadFromStorage()
reseedCounters(hydrated)

const initialState = {
  // ---- data (persisted) ----
  layers: hydrated?.layers || [],
  sequences: hydrated?.sequences || [],
  clines: hydrated?.clines || [],
  jobContext: hydrated?.jobContext || null,

  // ---- UI / app (not persisted) ----
  mode: 'DRAW',           // 'DRAW' | 'EDIT' | 'SEQUENCE' | 'TECHNICAL'
  tool: null,
  activeLayerId: null,
  activeSeqId: null,

  snapEnabled: true,
  gridEnabled: false,
  gridSize: 20,
  snapTolerance: 12,      // 12 mouse / 22 touch (Spec §8 amendment)
  pointerType: 'mouse',

  cursorX: 0,
  cursorY: 0,
  snapType: null,
  // Spec §8 — best snap point for current cursor or null. Set by the snap
  // engine on every mousemove; read by drawDynamic + onMouseDown commit.
  snapPt: null,

  // Spec §9 — edit-mode selection. { layerId, shapeId } or null. Set by
  // hit-test on click in EDIT mode; cleared on click-empty / Escape /
  // mode change / shape delete.
  selected: null,

  rightDrawerOpen: false,

  // Spec §6.6 — single global show/hide for the entire CLINES set.
  // Per-cline visible flag still exists for future edit-mode toggling.
  // This flag is UI-only (not persisted alongside layers/sequences/clines).
  clinesVisible: true,

  // Spec §7 step 2 — photo/PDF background. Stored as the loaded
  // HTMLImageElement (or null). UI-only, not in PERSIST_KEYS — Spec §15
  // explicitly says canvas background is not saved (too large for
  // localStorage). User reloads on session resume.
  backgroundImage: null,

  saveState: 'saved',     // 'saved' | 'unsaved' | 'saving'
  lastSavedAt: null,

  undoStack: [],
  redoStack: [],
}

const dataSnapshot = (state) => JSON.stringify({
  layers: state.layers,
  sequences: state.sequences,
  clines: state.clines,
})

// ============================================================================
// STORE
// ============================================================================
export const useAppStore = create((set, get) => {
  const pushUndo = () => {
    const snap = dataSnapshot(get())
    set((s) => {
      const next = [...s.undoStack, snap]
      if (next.length > UNDO_LIMIT) next.shift()
      return { undoStack: next, redoStack: [] }
    })
  }

  return {
    ...initialState,

    // ============ Layer actions =============================================
    addLayer: (props = {}) => {
      pushUndo()
      const layer = { ...layerDefaults(), ...props }
      set((s) => ({ layers: [...s.layers, layer], activeLayerId: layer.id }))
      return layer.id
    },

    deleteLayer: (id) => {
      pushUndo()
      set((s) => {
        const layers = s.layers.filter((l) => l.id !== id)
        // Strip from each sequence's per-layer visibility map
        const sequences = s.sequences.map((seq) => {
          if (!seq.layers || !(id in seq.layers)) return seq
          const next = { ...seq.layers }
          delete next[id]
          return { ...seq, layers: next }
        })
        return {
          layers,
          sequences,
          activeLayerId: s.activeLayerId === id ? null : s.activeLayerId,
        }
      })
    },

    renameLayer: (id, name) =>
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, name } : l)),
      })),

    setLayerColor: (id, color) =>
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, color } : l)),
      })),

    toggleLayerVisibility: (id) =>
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id === id ? { ...l, visible: !l.visible } : l
        ),
      })),

    updateLayerProps: (id, partial) =>
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, ...partial } : l)),
      })),

    reorderLayers: (idsInOrder) =>
      set((s) => {
        const byId = new Map(s.layers.map((l) => [l.id, l]))
        const next = idsInOrder.map((id) => byId.get(id)).filter(Boolean)
        const seen = new Set(idsInOrder)
        for (const l of s.layers) if (!seen.has(l.id)) next.push(l)
        return { layers: next }
      }),

    setActiveLayer: (id) => set({ activeLayerId: id }),

    // ============ Shape actions =============================================
    addShape: (layerId, shape) => {
      pushUndo()
      const id = shape.id || newShapeId()
      const fullShape = { ...shape, id }
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id === layerId ? { ...l, shapes: [...l.shapes, fullShape] } : l
        ),
      }))
      return id
    },

    updateShape: (layerId, shapeId, partial) =>
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id !== layerId
            ? l
            : {
                ...l,
                shapes: l.shapes.map((sh) =>
                  sh.id === shapeId ? { ...sh, ...partial } : sh
                ),
              }
        ),
      })),

    deleteShape: (layerId, shapeId) => {
      pushUndo()
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id !== layerId
            ? l
            : { ...l, shapes: l.shapes.filter((sh) => sh.id !== shapeId) }
        ),
        // Clear selection if the deleted shape was selected
        selected: (s.selected && s.selected.layerId === layerId && s.selected.shapeId === shapeId)
          ? null : s.selected,
      }))
    },

    // Spec §9 — context-menu actions.
    duplicateShape: (layerId, shapeId, offsetCanvasPx = { x: 10, y: 10 }, canvasSize) => {
      pushUndo()
      const id = newShapeId()
      const cw = canvasSize?.cw || 1
      const ch = canvasSize?.ch || 1
      set((s) => ({
        layers: s.layers.map((l) => {
          if (l.id !== layerId) return l
          const orig = (l.shapes || []).find((sh) => sh.id === shapeId)
          if (!orig) return l
          const dxN = offsetCanvasPx.x / cw
          const dyN = offsetCanvasPx.y / ch
          let dup
          if (orig.type === 'circ') {
            dup = { ...orig, id, cx: orig.cx + dxN, cy: orig.cy + dyN }
          } else {
            dup = { ...orig, id, pts: orig.pts.map((p) => ({ x: p.x + dxN, y: p.y + dyN })) }
          }
          return { ...l, shapes: [...l.shapes, dup] }
        }),
        selected: { layerId, shapeId: id },
      }))
      return id
    },

    moveShapeToLayer: (fromLayerId, shapeId, toLayerId) => {
      if (fromLayerId === toLayerId) return
      pushUndo()
      set((s) => {
        const fromLayer = s.layers.find((l) => l.id === fromLayerId)
        const shape = fromLayer?.shapes?.find((sh) => sh.id === shapeId)
        if (!shape) return {}
        return {
          layers: s.layers.map((l) => {
            if (l.id === fromLayerId) return { ...l, shapes: l.shapes.filter((sh) => sh.id !== shapeId) }
            if (l.id === toLayerId)   return { ...l, shapes: [...(l.shapes || []), shape] }
            return l
          }),
          selected: { layerId: toLayerId, shapeId },
        }
      })
    },

    // ============ Sequence actions ==========================================
    addSequence: (props = {}) => {
      pushUndo()
      const n = get().sequences.length + 1
      const seq = { ...sequenceDefaults(n), ...props }
      set((s) => ({ sequences: [...s.sequences, seq], activeSeqId: seq.id }))
      return seq.id
    },

    deleteSequence: (id) => {
      pushUndo()
      set((s) => ({
        sequences: s.sequences.filter((seq) => seq.id !== id),
        activeSeqId: s.activeSeqId === id ? null : s.activeSeqId,
      }))
    },

    setSeqTitle: (id, title) =>
      set((s) => ({
        sequences: s.sequences.map((seq) =>
          seq.id === id ? { ...seq, title } : seq
        ),
      })),

    setSeqLayerVisibility: (seqId, layerId, visible) =>
      set((s) => ({
        sequences: s.sequences.map((seq) =>
          seq.id !== seqId
            ? seq
            : { ...seq, layers: { ...seq.layers, [layerId]: !!visible } }
        ),
      })),

    setActiveSequence: (id) => set({ activeSeqId: id }),

    // ============ Annotation actions ========================================
    addAnnotation: (seqId, annotation) => {
      pushUndo()
      const id = annotation.id || newAnnoId()
      const full = { ...annotation, id }
      set((s) => ({
        sequences: s.sequences.map((seq) =>
          seq.id !== seqId
            ? seq
            : { ...seq, annotations: [...(seq.annotations || []), full] }
        ),
      }))
      return id
    },

    updateAnnotation: (seqId, annoId, partial) =>
      set((s) => ({
        sequences: s.sequences.map((seq) =>
          seq.id !== seqId
            ? seq
            : {
                ...seq,
                annotations: (seq.annotations || []).map((a) =>
                  a.id === annoId ? { ...a, ...partial } : a
                ),
              }
        ),
      })),

    deleteAnnotation: (seqId, annoId) => {
      pushUndo()
      set((s) => ({
        sequences: s.sequences.map((seq) =>
          seq.id !== seqId
            ? seq
            : {
                ...seq,
                annotations: (seq.annotations || []).filter(
                  (a) => a.id !== annoId
                ),
              }
        ),
      }))
    },

    // ============ CLines actions ============================================
    addCline: (cline) => {
      pushUndo()
      const id = cline.id || newClineId()
      const full = { ...cline, id, visible: cline.visible !== false }
      set((s) => ({ clines: [...s.clines, full] }))
      return id
    },

    deleteCline: (id) => {
      pushUndo()
      set((s) => ({ clines: s.clines.filter((cl) => cl.id !== id) }))
    },

    toggleClineVisibility: (id) =>
      set((s) => ({
        clines: s.clines.map((cl) =>
          cl.id === id ? { ...cl, visible: !cl.visible } : cl
        ),
      })),

    // Global show/hide for the entire CLINES set (Spec §6.6 — toolbar
    // "👁 CLines" button). Distinct from per-cline visibility.
    toggleClinesVisibility: () =>
      set((s) => ({ clinesVisible: !s.clinesVisible })),

    // Spec §7 step 2 — photo background. Pass an HTMLImageElement (after
    // its `load` event fires) or null to clear. Static draw checks
    // `image.complete && image.naturalWidth > 0` before painting so a
    // not-yet-loaded image cleanly falls back to the dark grid.
    setBackgroundImage: (image) => set({ backgroundImage: image }),
    clearBackgroundImage: () => set({ backgroundImage: null }),

    // ============ Selection (Spec §9) =======================================
    setSelected: (sel) => set({ selected: sel }),
    clearSelection: () => set({ selected: null }),

    // ============ App state actions =========================================
    setMode: (mode) =>
      set((s) => ({
        mode,
        // Mode change clears selection (Spec §9 — DRAW and EDIT mutually
        // exclusive; selection only meaningful in EDIT)
        selected: mode === s.mode ? s.selected : null,
        // Mode change also clears any active tool — drawing tools don't
        // apply outside DRAW mode
        tool: mode === 'DRAW' || mode === 'TECHNICAL' ? s.tool : null,
      })),
    setTool: (tool) => set({ tool }),
    setCursor: (x, y) => set({ cursorX: x, cursorY: y }),
    setSnapType: (snapType) => set({ snapType }),
    // Spec §8 — full snap point setter (writes both snapPt and snapType in
    // one mutation so subscribers see a coherent snap result). Pass null to
    // clear the snap.
    setSnap: (snapPt) => set({
      snapPt,
      snapType: snapPt?.type ?? null,
    }),
    toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
    toggleGrid: () => set((s) => ({ gridEnabled: !s.gridEnabled })),
    setGridSize: (gridSize) => set({ gridSize }),
    setSnapTolerance: (snapTolerance) => set({ snapTolerance }),
    setPointerType: (pointerType) =>
      set({
        pointerType,
        snapTolerance: pointerType === 'touch' ? 22 : 12,
      }),
    toggleRightDrawer: () =>
      set((s) => ({ rightDrawerOpen: !s.rightDrawerOpen })),

    // ============ Job context (Step 15 populates) ===========================
    setJob: (jobContext) => set({ jobContext }),
    clearJob: () => set({ jobContext: null }),

    // ============ Save state ================================================
    setSaveState: (saveState) => set({ saveState }),
    saveNow: () => {
      persist(get())
      set({ saveState: 'saved', lastSavedAt: Date.now() })
    },

    // ============ Import / Export ===========================================
    exportJSON: () => {
      const s = get()
      return JSON.stringify(
        {
          version: 1,
          exportedAt: new Date().toISOString(),
          layers: s.layers,
          sequences: s.sequences,
          clines: s.clines,
          jobContext: s.jobContext,
        },
        null,
        2
      )
    },
    importJSON: (data) => {
      pushUndo()
      const obj = typeof data === 'string' ? JSON.parse(data) : data
      reseedCounters(obj)
      set({
        layers: obj.layers || [],
        sequences: obj.sequences || [],
        clines: obj.clines || [],
        jobContext: obj.jobContext || null,
        activeLayerId: null,
        activeSeqId: null,
      })
    },

    // ============ Undo / Redo ===============================================
    undo: () => {
      const { undoStack, redoStack } = get()
      if (undoStack.length === 0) return false
      const current = dataSnapshot(get())
      const last = undoStack[undoStack.length - 1]
      const next = JSON.parse(last)
      set({
        layers: next.layers,
        sequences: next.sequences,
        clines: next.clines,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, current],
      })
      return true
    },

    redo: () => {
      const { undoStack, redoStack } = get()
      if (redoStack.length === 0) return false
      const current = dataSnapshot(get())
      const last = redoStack[redoStack.length - 1]
      const next = JSON.parse(last)
      set({
        layers: next.layers,
        sequences: next.sequences,
        clines: next.clines,
        undoStack: [...undoStack, current],
        redoStack: redoStack.slice(0, -1),
      })
      return true
    },

    // ============ Reset =====================================================
    clearAll: () => {
      pushUndo()
      set({
        layers: [],
        sequences: [],
        clines: [],
        activeLayerId: null,
        activeSeqId: null,
      })
    },
  }
})

// ============================================================================
// AUTOSAVE — debounced 2s after any data mutation (Spec §15)
// Reference-equality guard ensures cursor / tool / mode / snap mutations
// don't trigger the autosave or flip saveState to 'unsaved'.
// ============================================================================
let _saveTimer = null
useAppStore.subscribe((state, prev) => {
  if (
    state.layers === prev.layers &&
    state.sequences === prev.sequences &&
    state.clines === prev.clines &&
    state.jobContext === prev.jobContext
  ) {
    return
  }

  if (state.saveState !== 'unsaved') {
    queueMicrotask(() => useAppStore.setState({ saveState: 'unsaved' }))
  }

  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    persist(useAppStore.getState())
    useAppStore.setState({ saveState: 'saved', lastSavedAt: Date.now() })
  }, AUTOSAVE_DEBOUNCE_MS)
})

// ============================================================================
// DEV CONSOLE EXPOSURE
// Per April 29 2026 operator override on Rule 27 Step 2.a — pure state
// management is verified via inline console smoke instead of a standalone
// test file. Console smoke usage:
//   __appStore.getState().addLayer({ name: 'Roof' })
//   __appStore.getState().addShape('l1', { type: 'rect', pts: [...] })
//   __appStore.getState().toggleLayerVisibility('l1')
//   __appStore.getState().undo()
//   __appStore.getState().redo()
//   __appStore.getState()  // inspect current shape
//   __appStore.subscribe(s => console.log('state changed', s.saveState))
// ============================================================================
if (typeof window !== 'undefined') {
  window.__appStore = useAppStore
}

// ============================================================================
// PHOTO HYDRATION (post-Step-8 fix)
// Photo is too large for localStorage (Spec §15 originally said don't save
// at all) but fits IndexedDB easily. Operator-test on Step 8 surfaced that
// no-persistence is unacceptable UX. Module-level fire-and-forget read at
// startup; when the data-URL is decoded, set it on the store. Renderer
// falls back to dark grid until this resolves (typically <50 ms).
// ============================================================================
if (typeof window !== 'undefined') {
  loadPhoto()
    .then((dataURL) => {
      if (!dataURL) return
      const img = new Image()
      img.onload = () => useAppStore.getState().setBackgroundImage(img)
      img.onerror = () => {
        console.warn('Failed to decode persisted photo; ignoring.')
      }
      img.src = dataURL
    })
    .catch(() => {
      // IDB unavailable / quota / corruption — skip silently.
    })
}
