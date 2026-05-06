import { create } from 'zustand'
import { loadPhoto, savePhoto, clearPhoto } from './photoIDB'

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

// Step 17 — JSON export/import schema version. Bump when exportJSON's
// payload shape changes incompatibly. importJSON rejects mismatched
// versions rather than corrupting state.
//
// v1 (initial Step 17) — geometry-only payload. Photo blobs lived in
//                        IndexedDB and were NOT exported.
// v2 (Step 17 partial-completion fix, Failure 2) — embeds both photo
//                        slots ('cropped' + 'source') under `_photos`
//                        as data-URL strings so a project file is
//                        self-contained. v1 imports continue to work
//                        (photo absent — operator re-uploads via 📷).
const SCHEMA_VERSION = 2
const SUPPORTED_IMPORT_VERSIONS = new Set([1, 2])

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
// Step 10 added `gridSize` (now {x, y} per P12/P14) and `rightDrawerOpen`
// (drawer state survives refresh per Spec §5/§6 acceptance criteria).
// Step 10 partial-completion fix added `mode` and `activeLayerId` so refresh
// preserves the operator's working context — otherwise refresh reverts to
// "nominal state" (Properties panel empty, mode back to DRAW) even though
// the data itself survives.
// Section 7.A — viewport state (panX/panY/zoom) and cropMeta both persist so
// the operator returns to the same view they left. `photoMeta` (working-photo
// width/height) also persists; the photo image itself lives in IndexedDB.
const PERSIST_KEYS = [
  'layers', 'sequences', 'clines', 'jobContext',
  'gridSize', 'rightDrawerOpen', 'drawerTab',
  'mode', 'activeLayerId', 'activeSeqId',
  'viewport', 'photoMeta', 'cropMeta',
]
const VALID_MODES = new Set(['DRAW', 'EDIT', 'SEQUENCE', 'TECHNICAL'])
// Step 13 — third tab for the per-annotation editing panel. The tab button
// only renders in App.jsx when mode === 'SEQUENCE' and activeSeqId is set;
// `drawerTab === 'annotations'` outside that gate falls back to 'properties'
// for body rendering (the persisted tab choice is preserved for when the
// gate re-opens).
// Step 17 partial-completion #2 (Gap 1) — 'photo' tab promotes the
// background photo to first-class drawer status. Conditionally rendered
// in App.jsx when photoMeta is truthy (mirrors the Annotations gate).
const VALID_DRAWER_TABS = new Set(['properties', 'sequences', 'annotations', 'photo'])

// Default viewport when no photo (or before fit-to-viewport runs). Render
// math degenerates cleanly: shapeNormX * canvasW * 1 + 0 = shapeNormX * canvasW
// (the pre-Section-7.A behavior).
const DEFAULT_VIEWPORT = { panX: 0, panY: 0, zoom: 1 }
const ZOOM_MIN_CAP = 0.05  // safety floor; per-photo fit-to-viewport recomputes a tighter min
const ZOOM_MAX = 4.0       // §7.A.4 — 4× native pixels

const normalizeViewport = (v) => {
  if (!v || typeof v !== 'object') return { ...DEFAULT_VIEWPORT }
  const panX = Number.isFinite(v.panX) ? v.panX : 0
  const panY = Number.isFinite(v.panY) ? v.panY : 0
  const zRaw = Number.isFinite(v.zoom) && v.zoom > 0 ? v.zoom : 1
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN_CAP, zRaw))
  return { panX, panY, zoom }
}

const normalizePhotoMeta = (m) => {
  if (!m || typeof m !== 'object') return null
  const width = Math.round(Number(m.width))
  const height = Math.round(Number(m.height))
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null
  return { width, height }
}

// Step 10 — accept either a number (legacy / square grid) or an {x, y}
// object (rectangular). Always normalize to {x, y} on the way in.
const normalizeGridSize = (g) => {
  if (typeof g === 'number' && isFinite(g) && g > 0) return { x: g, y: g }
  if (g && typeof g === 'object'
    && typeof g.x === 'number' && isFinite(g.x) && g.x > 0
    && typeof g.y === 'number' && isFinite(g.y) && g.y > 0) {
    return { x: g.x, y: g.y }
  }
  return { x: 20, y: 20 }
}

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

  // ---- UI / app ----
  // `mode` and `activeLayerId` are persisted (Step 10 partial-completion fix)
  // so refresh restores the operator's working context. Validate on hydration:
  // unknown modes fall back to DRAW; an activeLayerId pointing at a layer that
  // no longer exists falls back to null.
  mode: (hydrated?.mode && VALID_MODES.has(hydrated.mode)) ? hydrated.mode : 'DRAW',
  tool: null,
  activeLayerId: (
    hydrated?.activeLayerId
    && (hydrated?.layers || []).some((l) => l.id === hydrated.activeLayerId)
  ) ? hydrated.activeLayerId : null,
  // Step 11 — `activeSeqId` persisted alongside the sequences themselves so
  // refresh restores the operator's sequence context. Validate against the
  // hydrated sequences array; fall back to null if the persisted id no
  // longer exists.
  activeSeqId: (
    hydrated?.activeSeqId
    && (hydrated?.sequences || []).some((s) => s.id === hydrated.activeSeqId)
  ) ? hydrated.activeSeqId : null,

  snapEnabled: true,
  gridEnabled: false,
  // Step 10 / P12+P14 — grid spacing is operator-adjustable AND independently
  // sized on X and Y axes (rectangular grid for standing-seam panel layouts).
  // Default 20×20 px keeps the Step 7 square-grid behavior unchanged.
  gridSize: normalizeGridSize(hydrated?.gridSize),
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

  // Step 13 — annotation card selection in the right-drawer Annotations
  // tab. { sequenceId, annotationId } or null. Set when operator clicks
  // an annotation card; CanvasStage paints a small white highlight ring
  // around the corresponding canvas annotation. Transient UI (not
  // persisted). Cleared on mode change, sequence change, deletion of
  // the selected annotation.
  selectedAnnotation: null,

  // Section 7.A — viewport state (canvas-as-viewport-onto-photo). Persists
  // so refresh restores the operator's pan/zoom. Default zoom of 1.0 is
  // overridden by fit-to-viewport when a photo loads (deferred until after
  // canvas dimensions are known).
  viewport: normalizeViewport(hydrated?.viewport),
  // Working (cropped) photo dimensions in photo-px. Set when a photo
  // commits from the crop modal; cleared when photo is cleared. Used by
  // viewport math to translate normalized 0–1 shape coords to canvas px.
  photoMeta: normalizePhotoMeta(hydrated?.photoMeta),
  // Crop region in source-photo-px (preloaded into the re-crop modal so
  // operators can refine an existing crop without re-uploading).
  // { x, y, w, h, rotation: 0 | 90 | 180 | 270 }
  cropMeta: hydrated?.cropMeta ?? null,
  // Whether a separate source-photo blob is available in IndexedDB.
  // Migration: existing projects (pre-Section-7.A) only persisted the
  // displayed photo under key 'background', which we treat as the cropped
  // working photo. `hasSourcePhoto` stays false for those projects until
  // the operator re-uploads via the crop modal.
  hasSourcePhoto: false,
  rightDrawerOpen: hydrated?.rightDrawerOpen ?? false,
  // Step 11 — which view fills the right-drawer body. Two values:
  // 'properties' (per-layer color/fill/stroke) or 'sequences' (sequence
  // panel). Persisted so the drawer reopens to the same view.
  drawerTab: (hydrated?.drawerTab && VALID_DRAWER_TABS.has(hydrated.drawerTab))
    ? hydrated.drawerTab : 'properties',

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

    setActiveSequence: (id) => set((s) => ({
      activeSeqId: id,
      // Step 13 — sequence change clears the panel-driven annotation
      // selection (the previously-selected annotation belonged to a
      // different sequence and would otherwise outlive its scope).
      selectedAnnotation: id === s.activeSeqId ? s.selectedAnnotation : null,
    })),

    // Step 11 — sequence reorder, mirrors `reorderLayers`. Pass the full
    // ordered list of ids; missing ids are appended at the end so the call
    // can never silently drop a sequence.
    reorderSequences: (idsInOrder) =>
      set((s) => {
        const byId = new Map(s.sequences.map((seq) => [seq.id, seq]))
        const next = idsInOrder.map((id) => byId.get(id)).filter(Boolean)
        const seen = new Set(idsInOrder)
        for (const seq of s.sequences) if (!seen.has(seq.id)) next.push(seq)
        return { sequences: next }
      }),

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
        // Step 13 — clear the panel selection if the deleted annotation
        // was the selected one (otherwise the canvas highlight would
        // outlive its target).
        selectedAnnotation: (s.selectedAnnotation
          && s.selectedAnnotation.sequenceId === seqId
          && s.selectedAnnotation.annotationId === annoId)
          ? null : s.selectedAnnotation,
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
    // Section 7.A — when a cropped working photo lands, capture its
    // photo-px dimensions in `photoMeta`; clearing the image clears
    // photoMeta and cropMeta so re-crop has no stale boundary preload.
    setBackgroundImage: (image) => set((s) => {
      const dims = (image && image.naturalWidth > 0 && image.naturalHeight > 0)
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : null
      return {
        backgroundImage: image,
        photoMeta: dims || s.photoMeta,
      }
    }),
    clearBackgroundImage: () => set({
      backgroundImage: null,
      photoMeta: null,
      cropMeta: null,
      hasSourcePhoto: false,
      // Reset viewport so the next photo upload starts at fit-to-viewport.
      viewport: { ...DEFAULT_VIEWPORT },
    }),

    // Section 7.A — viewport mutators. Set the whole viewport in one shot
    // (e.g. fit-to-viewport calc), or update one field. Zoom always clamped
    // to [ZOOM_MIN_CAP, ZOOM_MAX]; pan clamped lazily by the renderer/
    // pan-handler since the constraint depends on canvas dimensions.
    setViewport: (v) => set({ viewport: normalizeViewport(v) }),
    setZoom: (zoom) => set((s) => ({
      viewport: normalizeViewport({ ...s.viewport, zoom }),
    })),
    setPan: (panX, panY) => set((s) => ({
      viewport: normalizeViewport({ ...s.viewport, panX, panY }),
    })),

    // Section 7.A — the source + cropped photo lifecycle. Crop modal
    // confirm calls this with the cropped data URL + photo dims +
    // crop-rect-in-source-coords. Source preserved separately in IDB.
    setCroppedPhoto: ({ image, width, height, cropMeta, hasSourcePhoto }) => set({
      backgroundImage: image,
      photoMeta: { width, height },
      cropMeta: cropMeta || null,
      hasSourcePhoto: !!hasSourcePhoto,
    }),

    // ============ Selection (Spec §9) =======================================
    setSelected: (sel) => set({ selected: sel }),
    clearSelection: () => set({ selected: null }),

    // Step 13 — annotation panel selection. setSelectedAnnotation accepts
    // { sequenceId, annotationId } or null. Transient UI; not persisted.
    setSelectedAnnotation: (sel) => set({ selectedAnnotation: sel }),
    clearSelectedAnnotation: () => set({ selectedAnnotation: null }),

    // ============ App state actions =========================================
    setMode: (mode) =>
      set((s) => ({
        mode,
        // Mode change clears selection (Spec §9 — DRAW and EDIT mutually
        // exclusive; selection only meaningful in EDIT)
        selected: mode === s.mode ? s.selected : null,
        // Step 13 — annotation card selection is SEQUENCE-mode-scoped;
        // any mode change drops the panel-driven highlight so the canvas
        // doesn't keep painting a halo for an annotation the operator
        // can no longer see in the (now-hidden) Annotations tab.
        selectedAnnotation: mode === s.mode ? s.selectedAnnotation : null,
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
    // Step 10 / P12+P14 — accept number (square) or {x, y} (rectangular).
    // Internal state always lives as {x, y}.
    setGridSize: (gridSize) => set({ gridSize: normalizeGridSize(gridSize) }),
    // Single-axis setter for the UI's two number inputs. Coerces to a
    // positive integer; ignores anything else so a transient empty input
    // value doesn't blow away the existing axis value.
    setGridSizeAxis: (axis, value) => {
      if (axis !== 'x' && axis !== 'y') return
      const n = Math.round(Number(value))
      if (!isFinite(n) || n <= 0) return
      set((s) => ({ gridSize: { ...s.gridSize, [axis]: n } }))
    },
    setSnapTolerance: (snapTolerance) => set({ snapTolerance }),
    setPointerType: (pointerType) =>
      set({
        pointerType,
        snapTolerance: pointerType === 'touch' ? 22 : 12,
      }),
    toggleRightDrawer: () =>
      set((s) => ({ rightDrawerOpen: !s.rightDrawerOpen })),
    // Step 11 — switch which tab fills the right-drawer body. Validates
    // input so an unknown tab silently no-ops rather than corrupting
    // state.
    setDrawerTab: (tab) => {
      if (!VALID_DRAWER_TABS.has(tab)) return
      set({ drawerTab: tab })
    },

    // ============ Job context (Step 15 populates) ===========================
    setJob: (jobContext) => set({ jobContext }),
    clearJob: () => set({ jobContext: null }),

    // ============ Save state ================================================
    setSaveState: (saveState) => set({ saveState }),
    saveNow: () => {
      persist(get())
      set({ saveState: 'saved', lastSavedAt: Date.now() })
    },

    // ============ Import / Export (Step 17, Spec §15) =======================
    // Step 17 — `exportJSON` returns a Promise<string> carrying the FULL
    // PERSIST_KEYS set + a schemaVersion + exportedAt timestamp + (in v2)
    // both photo slots embedded as data-URL strings under `_photos`.
    //
    // Why async (Step 17 partial-completion fix, Failure 2):
    //   Photo blobs live in IndexedDB; reading them is async. A project
    //   without its photo isn't a usable project for resuming work, so v2
    //   embeds them by default. Files become 5–9 MB typical (worst case
    //   12 MB for an iPhone source) — acceptable cost for self-contained
    //   project files.
    //
    // _photos shape:
    //   { cropped: 'data:image/jpeg;base64,...',
    //     source:  'data:image/jpeg;base64,...' }
    // Either or both may be absent. If both absent, the `_photos` key is
    // omitted entirely so v2 files for never-photo'd projects stay tiny.
    exportJSON: async () => {
      const s = get()
      const slice = {}
      for (const k of PERSIST_KEYS) slice[k] = s[k]
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        ...slice,
      }
      // Read both IDB slots in parallel; treat read failures as "no photo
      // available" rather than failing the whole export.
      const [croppedURL, sourceURL] = await Promise.all([
        loadPhoto('cropped').catch(() => null),
        loadPhoto('source').catch(() => null),
      ])
      const photos = {}
      if (typeof croppedURL === 'string' && croppedURL.length > 0) {
        photos.cropped = croppedURL
      }
      if (typeof sourceURL === 'string' && sourceURL.length > 0) {
        photos.source = sourceURL
      }
      if (Object.keys(photos).length > 0) {
        payload._photos = photos
      }
      return JSON.stringify(payload, null, 2)
    },
    // importJSON returns Promise<void>. v1 + v2 supported; v1 has no
    // embedded photo (warn + clear IDB so a stale photo from a previous
    // project doesn't render under the imported geometry); v2 may carry
    // either, both, or neither photo slot — restore what's present, clear
    // what isn't.
    importJSON: async (data) => {
      const obj = typeof data === 'string' ? JSON.parse(data) : data
      if (!obj || typeof obj !== 'object') {
        throw new Error('Imported file must be a JSON object.')
      }
      if (typeof obj.schemaVersion !== 'number') {
        throw new Error('Missing schemaVersion field — file is not a RoofMark export.')
      }
      if (!SUPPORTED_IMPORT_VERSIONS.has(obj.schemaVersion)) {
        throw new Error(`Schema version mismatch: file is v${obj.schemaVersion}, app supports v1, v2.`)
      }
      pushUndo()
      reseedCounters(obj)
      // Validate inbound fields the same way hydration does so a
      // hand-edited or older-version JSON file doesn't corrupt state.
      const layers = Array.isArray(obj.layers) ? obj.layers : []
      const sequences = Array.isArray(obj.sequences) ? obj.sequences : []
      const clines = Array.isArray(obj.clines) ? obj.clines : []
      const mode = (obj.mode && VALID_MODES.has(obj.mode)) ? obj.mode : 'DRAW'
      const drawerTab = (obj.drawerTab && VALID_DRAWER_TABS.has(obj.drawerTab))
        ? obj.drawerTab : 'properties'
      const activeLayerId = obj.activeLayerId
        && layers.some((l) => l.id === obj.activeLayerId)
        ? obj.activeLayerId : null
      const activeSeqId = obj.activeSeqId
        && sequences.some((s) => s.id === obj.activeSeqId)
        ? obj.activeSeqId : null

      // Photo restoration. v1 has no photo data; v2 may carry one or both
      // slots under `_photos`. Always reconcile IDB to the file's intent
      // (clear absent slots) so the imported project doesn't inherit a
      // stale photo from whatever was loaded before.
      let backgroundImage = null
      let hasSourcePhoto = false
      const photos = (obj.schemaVersion === 2 && obj._photos) ? obj._photos : null
      if (obj.schemaVersion === 1) {
        console.warn('RoofMark: importing v1 project file — no photo embedded. Use 📷 Photo to upload one.')
        await Promise.all([
          clearPhoto('cropped').catch(() => {}),
          clearPhoto('source').catch(() => {}),
          clearPhoto('background').catch(() => {}),
        ])
      } else {
        // v2 — write whatever slots are present, clear the rest.
        const croppedURL = (photos && typeof photos.cropped === 'string') ? photos.cropped : null
        const sourceURL  = (photos && typeof photos.source  === 'string') ? photos.source  : null
        await Promise.all([
          croppedURL ? savePhoto(croppedURL, 'cropped').catch(() => {})
                     : clearPhoto('cropped').catch(() => {}),
          sourceURL  ? savePhoto(sourceURL,  'source').catch(() => {})
                     : clearPhoto('source').catch(() => {}),
          // Legacy 'background' key — always cleared post-§7.A.
          clearPhoto('background').catch(() => {}),
        ])
        if (croppedURL) {
          backgroundImage = await new Promise((resolve) => {
            const img = new Image()
            img.onload = () => resolve(img)
            img.onerror = () => { console.warn('Failed to decode embedded photo; ignoring.'); resolve(null) }
            img.src = croppedURL
          })
        }
        hasSourcePhoto = !!sourceURL
      }

      set({
        layers,
        sequences,
        clines,
        jobContext: obj.jobContext || null,
        gridSize: normalizeGridSize(obj.gridSize),
        rightDrawerOpen: obj.rightDrawerOpen === true,
        drawerTab,
        mode,
        activeLayerId,
        activeSeqId,
        viewport: normalizeViewport(obj.viewport),
        photoMeta: normalizePhotoMeta(obj.photoMeta),
        cropMeta: obj.cropMeta || null,
        backgroundImage,
        hasSourcePhoto,
        selected: null,
        selectedAnnotation: null,
        tool: null,
      })
    },

    // ============ Caller-controlled undo snapshots (Step 17 partial fix) ====
    // Most actions that mutate data call the closure-private pushUndo() at
    // the top of the action (see addLayer/addShape/addAnnotation/etc).
    // That works for "one click = one logical edit" mutations, but it's
    // wrong for fast-flowing per-keystroke mutations: holding a key in an
    // annotation textarea would push 33 entries onto the 50-step stack
    // for a 33-char paste.
    //
    // Failure 1 of Step 17 operator verification surfaced this:
    // updateAnnotation has no pushUndo() (deliberately — same convention
    // as renameLayer / setLayerColor / updateLayerProps), but operators
    // expect Cmd+Z to reverse a typo. Instead of pushing per keystroke,
    // AnnotationPanel uses the focus→blur edit-session pattern:
    //
    //   onFocus: capture the current dataSnapshot string into a ref
    //   onBlur:  if value changed, push the captured snapshot
    //
    // That gives one undo entry per "edit session" — consistent with
    // "one logical action = one undo" elsewhere in the app.
    captureUndoSnapshot: () => dataSnapshot(get()),
    pushCapturedSnapshot: (snap) => {
      if (typeof snap !== 'string' || snap.length === 0) return
      set((s) => {
        const next = [...s.undoStack, snap]
        while (next.length > UNDO_LIMIT) next.shift()
        return { undoStack: next, redoStack: [] }
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
    // Step 14 — "New Project" semantics. Clears all project data
    // (layers / shapes / sequences / annotations / clines), the photo
    // (working + source) from both the store and IndexedDB, and resets
    // the viewport. Job context is intentionally preserved so the
    // operator can spin up a new markup pass for the same job without
    // re-selecting the address. Undo restores everything in one step
    // (the snapshot pushed before the reset includes all data fields).
    clearAll: () => {
      pushUndo()
      set({
        layers: [],
        sequences: [],
        clines: [],
        activeLayerId: null,
        activeSeqId: null,
        selected: null,
        selectedAnnotation: null,
        backgroundImage: null,
        photoMeta: null,
        cropMeta: null,
        hasSourcePhoto: false,
        viewport: { panX: 0, panY: 0, zoom: 1 },
      })
      // Wipe persisted photos from IndexedDB so refresh doesn't bring
      // them back. Fire-and-forget — the render pipeline already
      // reflects the in-memory clear.
      if (typeof window !== 'undefined') {
        clearPhoto('cropped').catch(() => {})
        clearPhoto('source').catch(() => {})
        clearPhoto('background').catch(() => {})
      }
    },
  }
})

// ============================================================================
// AUTOSAVE — debounced 2s after any persisted-key mutation (Spec §15)
// Reference-equality guard ensures cursor / tool / mode / snap mutations
// don't trigger the autosave or flip saveState to 'unsaved'.
//
// Step 10 added `gridSize` and `rightDrawerOpen` to PERSIST_KEYS — those
// are tiny UI flags so they don't deserve the saveState='unsaved' flicker
// that data mutations get, but they DO need to be re-persisted on change.
// Pattern: data changes flip saveState; UI-flag changes silently extend
// the persist timer.
// ============================================================================
let _saveTimer = null
let _pendingDataWrite = false
useAppStore.subscribe((state, prev) => {
  const dataChanged = (
    state.layers !== prev.layers ||
    state.sequences !== prev.sequences ||
    state.clines !== prev.clines ||
    state.jobContext !== prev.jobContext
  )
  const uiFlagChanged = (
    state.gridSize !== prev.gridSize ||
    state.rightDrawerOpen !== prev.rightDrawerOpen ||
    state.drawerTab !== prev.drawerTab ||
    state.mode !== prev.mode ||
    state.activeLayerId !== prev.activeLayerId ||
    state.activeSeqId !== prev.activeSeqId ||
    // Section 7.A — viewport / photo metadata persist alongside the
    // operator's working context.
    state.viewport !== prev.viewport ||
    state.photoMeta !== prev.photoMeta ||
    state.cropMeta !== prev.cropMeta
  )
  if (!dataChanged && !uiFlagChanged) return

  if (dataChanged) {
    _pendingDataWrite = true
    if (state.saveState !== 'unsaved') {
      queueMicrotask(() => useAppStore.setState({ saveState: 'unsaved' }))
    }
  }

  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    persist(useAppStore.getState())
    if (_pendingDataWrite) {
      _pendingDataWrite = false
      useAppStore.setState({ saveState: 'saved', lastSavedAt: Date.now() })
    }
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
// PHOTO HYDRATION (Step 8 + Section 7.A)
// Photo is too large for localStorage (Spec §15 originally said don't save
// at all) but fits IndexedDB easily. Operator-test on Step 8 surfaced that
// no-persistence is unacceptable UX. Module-level fire-and-forget read at
// startup; when the data-URL is decoded, set it on the store. Renderer
// falls back to dark grid until this resolves (typically <50 ms).
//
// Section 7.A — dual-slot model: 'source' = original uploaded photo (kept
// for re-crop), 'cropped' = working photo rendered to canvas. Migration:
// projects saved before §7.A only had 'background' (the displayed photo);
// load that as cropped if cropped is missing, and `hasSourcePhoto` stays
// false until the operator re-uploads via the crop modal.
// ============================================================================
if (typeof window !== 'undefined') {
  Promise.all([
    loadPhoto('cropped').catch(() => null),
    loadPhoto('source').catch(() => null),
    loadPhoto('background').catch(() => null), // legacy
  ]).then(([croppedURL, sourceURL, legacyURL]) => {
    const workingURL = croppedURL || legacyURL
    if (!workingURL) return
    const img = new Image()
    img.onload = () => {
      useAppStore.getState().setBackgroundImage(img)
      useAppStore.setState({ hasSourcePhoto: !!sourceURL })
    }
    img.onerror = () => {
      console.warn('Failed to decode persisted photo; ignoring.')
    }
    img.src = workingURL
    // One-time migration: if we read from legacy 'background', copy to
    // 'cropped' so future reads use the canonical key.
    if (!croppedURL && legacyURL) {
      savePhoto(legacyURL, 'cropped').catch(() => {})
    }
  })
}
