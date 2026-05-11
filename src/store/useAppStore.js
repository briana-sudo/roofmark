import { create } from 'zustand'
import {
  loadPhoto, savePhoto, clearPhoto,
  saveFileHandle, loadFileHandle, clearFileHandle,
} from './photoIDB'
import { computeFitViewport } from './viewport'
import {
  reprojectShape,
  reprojectCline,
  reprojectAnnotation,
  reprojectPerspectiveCorners,
  countOutOfBounds,
} from '../utils/reprojectShapes'
import {
  isFileSystemAccessSupported,
  pickSaveFile,
  writeToHandle,
  verifyHandlePermission,
} from '../utils/fileSystemAccess'

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
// v3 (Phase 2 sub-step 18a, May 10 2026) — Technical Drawing mode
//                        skeleton. Adds `appMode` ('FIELD' | 'TECHNICAL'),
//                        `technicalLayers`, `specTable`, and replaces
//                        the single `viewport` field with a `viewports`
//                        object keyed by appMode. v1 + v2 imports migrate
//                        in memory to v3 shape via importJSON's set()
//                        block. TEMP v3 compat — exportJSON also writes
//                        the legacy top-level `viewport` field equal to
//                        viewports.FIELD so a future rollback can read
//                        v3 files in degraded mode. Remove after Phase 2
//                        ships.
const SCHEMA_VERSION = 3
const SUPPORTED_IMPORT_VERSIONS = new Set([1, 2, 3])

// ---- ID generators ---------------------------------------------------------
let _layerSeq = 0
let _shapeSeq = 0
// Phase 2 18b (May 10 2026) — Technical Drawing id counters. Kept in
// module scope alongside the Field Markup counters so reseedCounters
// can bump them at hydration / import time and prevent post-load id
// collisions. Format: `tech-layer-{n}` / `tech-shape-{n}` per Spec §21
// naming convention. Field Markup's `l{n}` / `sh{n}` ids stay disjoint.
let _techLayerSeq = 0
let _techShapeSeq = 0
let _seqSeq = 0
let _clineSeq = 0
let _annoSeq = 0
const newLayerId = () => `l${++_layerSeq}`
const newShapeId = () => `sh${++_shapeSeq}`
const newTechLayerId = () => `tech-layer-${++_techLayerSeq}`
const newTechShapeId = () => `tech-shape-${++_techShapeSeq}`
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

// P31 + P35 (May 7 2026) — global annotation rendering fallbacks.
// ANNO_COLOR_FALLBACK matches the pre-P31 hardcoded amber so sequences
// saved before P31 (no defaultAnnoColor field) render unchanged.
// Used by sequenceDefaults + the render-path 3-tier fallback chain
// (anno.<field> ?? seq.default<Field> ?? fallback).
const ANNO_COLOR_FALLBACK = '#f5a623'
const ANNO_FONT_SIZE_FALLBACK = 11
const ANNO_FONT_SIZE_MIN = 8
const ANNO_FONT_SIZE_MAX = 32

const sequenceDefaults = (n) => ({
  id: newSeqId(),
  title: `S${n} — New Sequence`,
  layers: {},
  annotations: [],
  // P31 + P35 — per-sequence annotation defaults. Per-annotation
  // overrides (anno.color / anno.fontSize) stick across sequence-
  // default changes; only ↺ reset clears the override (which sets
  // the field back to null/undefined).
  defaultAnnoColor: ANNO_COLOR_FALLBACK,
  defaultAnnoFontSize: ANNO_FONT_SIZE_FALLBACK,
})

// P31 + P35 — normalize a hydrated/imported sequence so it has the
// new default-* fields. Backfills missing fields with the global
// fallbacks; clamps fontSize to [8, 32]. Run at hydration + on
// importJSON so localStorage / Save JSON gets the migrated shape on
// next persist.
const normalizeSequence = (seq) => {
  if (!seq || typeof seq !== 'object') return seq
  const fontRaw = Number(seq.defaultAnnoFontSize)
  const fontOk = Number.isFinite(fontRaw)
  return {
    ...seq,
    defaultAnnoColor:
      typeof seq.defaultAnnoColor === 'string' && seq.defaultAnnoColor.length > 0
        ? seq.defaultAnnoColor
        : ANNO_COLOR_FALLBACK,
    defaultAnnoFontSize: fontOk
      ? Math.min(ANNO_FONT_SIZE_MAX, Math.max(ANNO_FONT_SIZE_MIN, Math.round(fontRaw)))
      : ANNO_FONT_SIZE_FALLBACK,
  }
}

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
  // Phase 2 18a (May 10 2026) — viewport storage moves from a single
  // top-level `viewport` field to a `viewports` object keyed by appMode
  // ('FIELD' | 'TECHNICAL'). Pan/zoom is per-mode so switching modes
  // restores each mode's prior position. The runtime `viewport` field
  // (state.viewport) is kept as a derived mirror of viewports[appMode]
  // so the 37+ existing read sites in CanvasStage continue to work
  // unchanged — only the persistence shape changed.
  'viewports', 'photoMeta', 'cropMeta',
  // P2 + P19 (May 7 2026) — per-snap-type gates + grid opacity persist
  // alongside other UI flags so operator settings survive reload.
  'snapTypes', 'gridOpacity',
  // Step 16 (May 8 2026) — PDF page orientation preference (auto / portrait
  // / landscape). Pre-Step-16 hydration falls back to 'auto'.
  'pdfOrientation',
  // P16 + P38 mini-step (May 8 2026) — perspective grid corners (null OR
  // 4 normalized points TL/TR/BR/BL) + single-angle grid rotation (degrees,
  // [-180, 180]). Pre-this-batch hydration falls back to null + 0.
  'gridRotation', 'perspectiveCorners',
  // Phase 2 18a (May 10 2026) — top-level app mode + Technical Drawing
  // mode's per-layer geometry + spec table. technicalLayers default [];
  // specTable default {}. Pre-Phase-2 v2 JSON files have neither field,
  // so importJSON migrates them in memory to v3 shape before set().
  'appMode', 'technicalLayers', 'specTable',
]
// Phase 2 18b (May 10 2026) — Field Markup `mode` slice valid values.
// Pre-18b the set also included 'TECHNICAL', a stale token left over from
// a pre-18a iteration where Technical was a Field Markup sub-mode. The
// appMode split (18a) made that semantically wrong but harmless because
// no caller passed it. Cleaned up in 18b — setMode rejects 'TECHNICAL'
// as an invalid Field Markup mode (appMode owns Technical Drawing now).
const VALID_MODES = new Set(['DRAW', 'EDIT', 'SEQUENCE'])

// Phase 2 18b — Technical Drawing internal scale. Kickoff Spec §21:
// "24px = 1 inch" defines the canvas-pixel ↔ real-world-inch mapping.
// Used by addTechnicalShape / parseLength / drawStatic at render time.
export const PX_PER_INCH = 24
// Phase 2 18b — default Technical layer name when auto-created on first
// shape commit. Operator can rename via the layer-panel UI in 18c+.
export const TECHNICAL_LAYER_NAME_DEFAULT = 'Layer 1'
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

// Phase 2 18a (May 10 2026) — top-level app mode. 'FIELD' = Phase 1 Field
// Markup behavior (DRAW/EDIT/SEQUENCE sub-modes live in `state.mode`).
// 'TECHNICAL' = Phase 2 Technical Drawing mode (sub-modes added in 18b+).
const VALID_APP_MODES = new Set(['FIELD', 'TECHNICAL'])
const normalizeAppMode = (v) =>
  (typeof v === 'string' && VALID_APP_MODES.has(v)) ? v : 'FIELD'

// Phase 2 18a — per-mode viewport storage. Both modes start at the default
// {panX:0, panY:0, zoom:1}; each mode's viewport is independently mutated
// by setViewport/setZoom/setPan/fitToViewport based on the active appMode.
// Migration from v2 (single top-level `viewport`) places that value at
// viewports.FIELD; viewports.TECHNICAL starts at default.
const normalizeViewports = (vps, legacySingle) => {
  if (vps && typeof vps === 'object') {
    return {
      FIELD: normalizeViewport(vps.FIELD),
      TECHNICAL: normalizeViewport(vps.TECHNICAL),
    }
  }
  // v1/v2 migration: legacy single `viewport` becomes FIELD; TECHNICAL = default
  return {
    FIELD: normalizeViewport(legacySingle),
    TECHNICAL: { ...DEFAULT_VIEWPORT },
  }
}

// Selector helper — returns the active viewport based on appMode. Public
// API for read sites in components; the runtime mirror at state.viewport
// is a back-compat shim for the 37+ existing CanvasStage read sites.
export const getActiveViewport = (s) => {
  if (!s) return { ...DEFAULT_VIEWPORT }
  const am = (s.appMode === 'TECHNICAL') ? 'TECHNICAL' : 'FIELD'
  return s.viewports?.[am] || { ...DEFAULT_VIEWPORT }
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

// P2 (May 7 2026) — per-snap-type gates. All five default true so
// existing snapEnabled-only behavior is preserved on first load.
// Hydration accepts a partial object and fills in missing keys with
// the default true (forward-compatible if new snap types are added).
const SNAP_TYPE_KEYS = ['close', 'grid', 'corner', 'midpoint', 'cline']
const normalizeSnapTypes = (st) => {
  const out = {}
  for (const k of SNAP_TYPE_KEYS) {
    out[k] = st && typeof st === 'object' && st[k] === false ? false : true
  }
  return out
}

// P19 (May 7 2026) — grid line opacity. Clamp to [0.05, 0.6] so
// operator can go subtler than the default or bolder, but can't
// vanish the grid entirely or drown the photo.
const GRID_OPACITY_MIN = 0.05
const GRID_OPACITY_MAX = 0.6
const GRID_OPACITY_DEFAULT = 0.16
const normalizeGridOpacity = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return GRID_OPACITY_DEFAULT
  return Math.min(GRID_OPACITY_MAX, Math.max(GRID_OPACITY_MIN, n))
}

// Step 16 (May 8 2026) — PDF page orientation preference. 'auto' picks
// landscape vs portrait per photo aspect ratio at export time; explicit
// 'portrait' / 'landscape' overrides auto-detect. Persisted in
// PERSIST_KEYS so the operator's preference survives reload. Pre-Step-16
// JSON files (no field) load as 'auto' via the hydration fallback.
const VALID_PDF_ORIENTATIONS = new Set(['auto', 'portrait', 'landscape'])
const normalizePdfOrientation = (v) =>
  (typeof v === 'string' && VALID_PDF_ORIENTATIONS.has(v)) ? v : 'auto'

// P38 (May 8 2026) — single-angle grid rotation. Degrees, clamped to
// [-180, 180]. Default 0 (axis-aligned, current behavior). Pre-P38 JSON
// files (no field) load as 0 via hydration fallback.
const GRID_ROTATION_MIN = -180
const GRID_ROTATION_MAX = 180
const normalizeGridRotation = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  // Wrap into [-180, 180] for round-trip stability (e.g., 270° → -90°).
  let r = ((n + 180) % 360 + 360) % 360 - 180
  if (r < GRID_ROTATION_MIN) r = GRID_ROTATION_MIN
  if (r > GRID_ROTATION_MAX) r = GRID_ROTATION_MAX
  return r
}

// P16 (May 8 2026) — perspective grid corners (4 points in photo-norm
// 0..1, TL/TR/BR/BL order). null = no perspective set; grid renders
// axis-aligned (or rotated per P38). Pre-P16 JSON files (no field)
// load as null via hydration fallback.
const normalizePerspectiveCorners = (v) => {
  if (!Array.isArray(v) || v.length !== 4) return null
  const out = []
  for (const c of v) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null
    // Clamp slightly outside [0, 1] to allow drag overshoot tolerance.
    if (c.x < -0.001 || c.x > 1.001 || c.y < -0.001 || c.y > 1.001) return null
    out.push({ x: c.x, y: c.y })
  }
  return out
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
  // Phase 2 18b — bumpTech: id format is `tech-layer-{n}` / `tech-shape-{n}`
  // (multi-segment prefix). The Field Markup `bump` strips a single leading
  // alphabetic run; for technical ids it would parse the wrong number. Use
  // a regex anchored on the full pattern instead.
  const bumpTech = (s, ref) => {
    const m = String(s).match(/(\d+)$/)
    if (!m) return
    const n = parseInt(m[1], 10)
    if (!isNaN(n) && n > ref.value) ref.value = n
  }
  const refs = { l: { value: _layerSeq }, sh: { value: _shapeSeq }, s: { value: _seqSeq }, cl: { value: _clineSeq }, a: { value: _annoSeq }, tl: { value: _techLayerSeq }, tsh: { value: _techShapeSeq } }
  for (const layer of data.layers || []) {
    bump(layer.id || 'l0', refs.l)
    for (const shape of layer.shapes || []) bump(shape.id || 'sh0', refs.sh)
  }
  for (const seq of data.sequences || []) {
    bump(seq.id || 's0', refs.s)
    for (const a of seq.annotations || []) bump(a.id || 'a0', refs.a)
  }
  for (const cl of data.clines || []) bump(cl.id || 'cl0', refs.cl)
  // Phase 2 18b — technical layers/shapes.
  for (const tl of data.technicalLayers || []) {
    bumpTech(tl.id || '', refs.tl)
    for (const sh of tl.shapes || []) bumpTech(sh.id || '', refs.tsh)
  }
  _layerSeq = refs.l.value
  _shapeSeq = refs.sh.value
  _seqSeq = refs.s.value
  _clineSeq = refs.cl.value
  _annoSeq = refs.a.value
  _techLayerSeq = refs.tl.value
  _techShapeSeq = refs.tsh.value
}

const hydrated = loadFromStorage()
reseedCounters(hydrated)

// Phase 2 18a (May 10 2026) — viewports hydration:
//   - If hydrated.viewports exists (v3 saved state) → use it directly
//   - Else if hydrated.viewport exists (legacy v1/v2 saved state in
//     localStorage) → migrate: FIELD = legacy single, TECHNICAL = default
//   - Else → both modes default
const _hydratedViewports = normalizeViewports(hydrated?.viewports, hydrated?.viewport)
const _hydratedAppMode = normalizeAppMode(hydrated?.appMode)

const initialState = {
  // ---- data (persisted) ----
  layers: hydrated?.layers || [],
  sequences: (hydrated?.sequences || []).map(normalizeSequence),
  clines: hydrated?.clines || [],
  jobContext: hydrated?.jobContext || null,
  // Phase 2 18a — Technical Drawing mode's per-layer geometry array +
  // spec table. Schema for these objects is OUT OF SCOPE for 18a (18b+
  // builds the tools that populate them). Initial state is empty for
  // both; v1/v2 migration adds them via importJSON's set() block.
  technicalLayers: hydrated?.technicalLayers || [],
  specTable: hydrated?.specTable || {},

  // ---- UI / app ----
  // `mode` and `activeLayerId` are persisted (Step 10 partial-completion fix)
  // so refresh restores the operator's working context. Validate on hydration:
  // unknown modes fall back to DRAW; an activeLayerId pointing at a layer that
  // no longer exists falls back to null.
  mode: (hydrated?.mode && VALID_MODES.has(hydrated.mode)) ? hydrated.mode : 'DRAW',
  // Phase 2 18b — Tool ids are mode-namespaced: Field Markup uses
  // 'poly' | 'rect' | 'tri' | 'circ' | 'arc' | 'ellipse' | 'line' |
  // 'cline' | 'callout' | 'dimline' | 'note'; Technical Drawing uses
  // 'tech-line' (18b) plus future 'tech-rect' / 'tech-arc' / etc. in
  // 18c+. Convention-enforced, not type-checked at write time.
  // setAppMode (18a) clears tool on any FIELD ↔ TECHNICAL switch so
  // a Field tool never leaks into Technical dispatch and vice-versa.
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
  // P2 (May 7 2026) — per-snap-type gates. All five default true so
  // operators who don't open the Snap chevron see existing behavior.
  // Master snapEnabled stays as the global on/off; per-type gates are
  // independent (no master cascade — toggling Snap off then on doesn't
  // reset per-type state).
  snapTypes: normalizeSnapTypes(hydrated?.snapTypes),
  gridEnabled: false,
  // Step 10 / P12+P14 — grid spacing is operator-adjustable AND independently
  // sized on X and Y axes (rectangular grid for standing-seam panel layouts).
  // Default 20×20 px keeps the Step 7 square-grid behavior unchanged.
  gridSize: normalizeGridSize(hydrated?.gridSize),
  // P19 (May 7 2026) — operator-adjustable grid line opacity (0.05–0.6).
  // Default 0.16 matches the prior hardcoded value, so first-load
  // appearance is unchanged.
  gridOpacity: normalizeGridOpacity(hydrated?.gridOpacity),
  // Step 16 (May 8 2026) — PDF orientation preference. 'auto' = derive
  // from photo aspect ratio per-export; 'portrait' / 'landscape' force.
  // Pre-Step-16 JSON files have no field → fallback to 'auto'.
  pdfOrientation: normalizePdfOrientation(hydrated?.pdfOrientation),
  // P38 (May 8 2026) — grid rotation in degrees. 0 = axis-aligned (current
  // behavior). Pre-P38 JSON files have no field → fallback to 0.
  gridRotation: normalizeGridRotation(hydrated?.gridRotation),
  // P16 (May 8 2026) — perspective grid corners. null = no perspective set
  // (grid renders axis-aligned, or rotated per P38). Pre-P16 JSON files
  // have no field → fallback to null.
  perspectiveCorners: normalizePerspectiveCorners(hydrated?.perspectiveCorners),
  // P16 (May 8 2026) — transient UI flag for perspective-edit mode. NOT
  // in PERSIST_KEYS (operator's mid-edit state shouldn't survive reload —
  // they re-enter via the Perspective button).
  perspectiveEditMode: false,
  // Phase 2 18d (May 11 2026) — Technical Drawing multi-shape selection.
  // Transient. NOT in PERSIST_KEYS. Independent from Field Markup's
  // `selected` (which stays single-select-only for backward compat).
  // Each entry: { layerId, shapeId } identifying a shape in
  // technicalLayers. Cleared on appMode change, tool change away from
  // 'tech-select', clearAll, importJSON, and Escape when no rotation
  // drag is in progress.
  techSelected: [],
  // Phase 2 18d — operator's typed rotation value in degrees while
  // selection is active. null = no typed value (rubber-band-equivalent
  // for rotation = drag handle only). Transient.
  techRotationInput: null,
  // Phase 2 18d-pivot (May 11 2026) — operator-chosen rotation pivot,
  // mirrors AutoCAD's ROTATE base-point workflow. All three transient.
  // NOT in PERSIST_KEYS. NOT in dataSnapshot. The rotation MUTATIONS
  // to shape geometry persist via technicalLayers; the pivot itself is
  // UI state that resets to centroid after each commit per operator
  // decision (May 11 2026).
  //   techPivot: {x, y} | null   — locked pivot in TECHNICAL world coords.
  //                                null = use centroid (single-select)
  //                                or bbox centroid (multi-select).
  //   techPivotPickMode: boolean — true while operator is hovering canvas
  //                                to pick a pivot via "Set pivot" button.
  //                                Click locks the hovered pivot.
  //   techPivotHover: {x, y, type} | null
  //                              — current snap target under cursor while
  //                                in pick mode. type is 'endpoint' or
  //                                'midpoint'. Read by drawDynamic for
  //                                the diamond snap indicator.
  techPivot: null,
  techPivotPickMode: false,
  techPivotHover: null,
  // Phase 2 18d-pivot live-rotation (operator-reported May 11 2026 on
  // `76039e2`) — when pivot locks, capture every selected shape's
  // pre-rotation geometry + one undo snapshot. These let:
  //   - mousemove live-rotate from the originShapes baseline (so the
  //     line follows the cursor instead of accumulating per-tick
  //     rotation — operator sees a clean "where my cursor is = where
  //     the line points"),
  //   - Escape / Pivot ↺ revert shapes to pre-pivot orientation,
  //   - typed-Enter rotation use originShapes as the absolute baseline
  //     (so "Rotate 45°" always means 45° from the pre-pivot state).
  // null when no pivot is locked. Cleared at every existing pivot
  // clear site.
  techPivotOriginShapes: null,
  techPivotPreChangeSnap: null,
  // Phase 2 18b/18c — Technical Drawing line-tool draft state.
  // Transient. NOT in PERSIST_KEYS. null when no draft in progress.
  // Active shape:
  //   { a: { x, y },                        // anchor placed by first click
  //     typedInches: number | null,         // operator-typed length (null = freehand)
  //     typedAngleDegrees: number | null }  // operator-typed angle in degrees,
  //                                         // canvas-Y-down convention (null = freehand)
  // 18c (May 11 2026) added `typedAngleDegrees`. Each typed field is
  // independently lockable: typing only length keeps angle freehand
  // (line direction follows cursor), typing only angle keeps length
  // freehand (line length follows cursor distance to anchor), typing
  // both fully locks the line geometry. The end-point `b` is NOT
  // stored here — it's projected at commit/render time from `a` plus
  // the (typed-or-freehand) length + angle. Cleared on commit, cancel,
  // tool change, appMode change.
  techDraft: null,
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

  // Phase 2 18a (May 10 2026) — top-level app mode. 'FIELD' (Phase 1
  // Field Markup behavior) or 'TECHNICAL' (Phase 2 Technical Drawing
  // mode skeleton; sub-mode tools land in 18b+). Persisted across reload.
  appMode: _hydratedAppMode,
  // Section 7.A — viewport state (canvas-as-viewport-onto-photo). Phase 2
  // 18a — per-mode viewport storage. `viewports` is the source of truth;
  // `viewport` (below) is a runtime mirror of viewports[appMode] kept for
  // back-compat with 37+ existing read sites (CanvasStage / DrawingTools /
  // App.jsx). All setViewport/setZoom/setPan/fitToViewport updates write
  // to BOTH viewports[appMode] AND the viewport mirror in one atomic set.
  // PERSIST_KEYS persists viewports (not viewport) so the mirror is
  // automatically rebuilt from viewports[appMode] on hydration.
  viewports: _hydratedViewports,
  // viewport — DERIVED MIRROR of viewports[appMode]. NOT in PERSIST_KEYS.
  viewport: _hydratedViewports[_hydratedAppMode],
  // P37 (May 7 2026) — session-scoped flag that gates auto-fit on canvas
  // size changes (window resize, toolbar wrap). False by default;
  // markViewportTouched sets it true on user-initiated pan/zoom;
  // fitToViewport clears it back to false. When true, resizeAll's
  // auto-fit branch skips so the operator's manual viewport is
  // preserved across resizes. Not persisted (transient).
  viewportTouchedSinceFit: false,
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
  // (Phase B field `photoUndoSlotInitialized` retired — replaced by
  // embedded photo binaries inside undo snapshots; see
  // captureSnapWithLivePhoto + the undo handler.)
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

  // P45 (Phase 2 18a, May 10 2026) — File System Access API: persistent
  // FileSystemFileHandle to the operator's last Save target. NOT in
  // PERSIST_KEYS (the handle object is stored separately in IndexedDB
  // via photoIDB.saveFileHandle; the handle itself isn't JSON-
  // serializable). Loaded asynchronously after store creation via the
  // post-init bootstrap (see end of this file).
  //   currentFileHandle: FileSystemFileHandle | null
  //   currentFileName: string | null  (mirrors handle.name when handle is set;
  //                                    OR the filename used by the legacy
  //                                    download fallback path)
  currentFileHandle: null,
  currentFileName: null,

  undoStack: [],
  redoStack: [],
}

// Step 17 partial-completion #2 (Gap 2) — undo snapshot scope extended
// to include photo metadata. The snapshot is JSON-serializable so we
// can't include `backgroundImage` (HTMLImageElement). The actual photo
// binary lives in IDB and is restored separately via session-scoped
// `cropped_undo` + `source_undo` slots (see captureAndBackupPhoto +
// restorePhotoFromUndo below). Together they let undo recover from the
// most-recent photo wipe / replace / re-crop.
//
// Geometry-only undo (when the snapshot's photo state matches current)
// continues to take the fast sync path in the undo action.
// Export under test-only name as well so the block test runner can
// import the exact serialization shape and exercise the full undo
// round-trip without a parallel mock that might lie about what's
// actually persisted. Production callers continue to use the closure-
// internal pushUndo / dataSnapshot defined inside the store factory.
export const dataSnapshot = (state) => JSON.stringify({
  layers: state.layers,
  sequences: state.sequences,
  clines: state.clines,
  photoMeta: state.photoMeta || null,
  cropMeta: state.cropMeta || null,
  hasSourcePhoto: !!state.hasSourcePhoto,
  // P16 + P38 follow-on fix (May 8 2026 — operator verification surfaced
  // missing undo coverage for grid rotation + perspective corner drag):
  // both fields belong inside the undo snapshot so Cmd+Z can revert them.
  // Pre-this-fix the snapshot only carried layers/sequences/clines and
  // photo state; pushCapturedSnapshot in perspectiveDrag mouseup fired
  // correctly but the snapshot didn't carry corners, so undo restored
  // unrelated fields and left corners at their post-drag values.
  // Same gap as the Step 17 P34 latent shape-drag-undo bug — the lesson
  // is "any new state field that's mutable via UI needs both pushUndo
  // coverage AND inclusion in dataSnapshot."
  gridRotation: typeof state.gridRotation === 'number' ? state.gridRotation : 0,
  perspectiveCorners: state.perspectiveCorners || null,
  // Phase 2 18b follow-on (operator-reported May 10 2026 on `1edd117`).
  // Same bug class as the P16+P38 gridRotation/perspectiveCorners follow-
  // on May 8 2026: any new mutable field needs both pushUndo coverage
  // AND inclusion in dataSnapshot/undo/redo. 18b shipped the first half
  // only — addTechnicalShape called pushUndo but the snapshot omitted
  // technicalLayers, so undo restored geometry + photo + perspective
  // but left committed Technical lines on the canvas. specTable is
  // added pre-emptively for 18g (spec table panel) so the same gap
  // doesn't re-open when that lands.
  technicalLayers: state.technicalLayers || [],
  specTable: state.specTable || {},
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

  // ============ Photo undo helpers (Step 17 partial #5 — embedded) =======
  // The geometry undo stack is JSON snapshots. For photo-wipe actions
  // (commitCroppedPhoto / clearBackgroundImage) the snapshot of the
  // pre-wipe state EMBEDS the about-to-be-replaced photo binaries
  // directly as data-URL strings under `_croppedBin` + `_sourceBin`
  // keys. Each wipe gets its own embedded backup, so multi-step undo
  // (re-crop A→B then re-crop B→C, then undo twice) recovers each
  // prior photo correctly.
  //
  // This replaces the Phase B single-slot IDB backup approach
  // (`cropped_undo` / `source_undo`) which had a hard "backup-of-
  // backup" limit: only the MOST RECENT destruction was recoverable.
  // Operator verification on stacked re-crops surfaced that limit as
  // a real bug — second undo half-restored.
  //
  // Memory cost: each photo-wipe snapshot is ~5–10MB. Plain shape-
  // edit snapshots (pushed by addShape / addCline / addAnnotation /
  // etc. via vanilla pushUndo()) remain small (kB). Realistic
  // session: 1–5 photo wipes → 5–50MB. Worst-case 50 wipes:
  // 250–500MB. JS GC reclaims as snapshots evict past UNDO_LIMIT.
  // Snapshots are NOT persisted to localStorage (PERSIST_KEYS doesn't
  // include undoStack/redoStack) so the heap cost stays session-
  // scoped — Save/Load JSON also stays clean.
  //
  // captureSnapWithLivePhoto:
  //   reads current live cropped + source from IDB
  //   builds the dataSnapshot of current state
  //   embeds the binaries under _croppedBin / _sourceBin
  //   returns the JSON string ready to push onto undoStack
  //
  // Callers (commitCroppedPhoto, clearBackgroundImage) push the
  // returned snapshot manually with eviction-aware logic. Plain
  // pushUndo() (used by addShape / addLayer / etc.) does NOT embed
  // binaries — those snapshots stay small.
  const captureSnapWithLivePhoto = async () => {
    const baseObj = JSON.parse(dataSnapshot(get()))
    const [oldCropped, oldSource] = await Promise.all([
      loadPhoto('cropped').catch(() => null),
      loadPhoto('source').catch(() => null),
    ])
    if (typeof oldCropped === 'string' && oldCropped.length > 0) {
      baseObj._croppedBin = oldCropped
    }
    if (typeof oldSource === 'string' && oldSource.length > 0) {
      baseObj._sourceBin = oldSource
    }
    return JSON.stringify(baseObj)
  }

  // (Phase B's separate IDB-slot backup helpers — captureAndBackupPhoto,
  // backupLivePhotoToUndoSlots, restorePhotoFromUndo — were retired
  // when stacked re-crops surfaced the single-slot backup-of-backup
  // limit. Embedded snapshots above replace them.)

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

    // Pass 2 undo gap closure (May 10 2026) — toggleLayerVisibility is a
    // discrete operator action (single click on Eye/EyeOff icon). One
    // click = one undo entry. pushUndo() runs BEFORE the set so the
    // snapshot captures pre-toggle state.
    toggleLayerVisibility: (id) => {
      pushUndo()
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id === id ? { ...l, visible: !l.visible } : l
        ),
      }))
    },

    updateLayerProps: (id, partial) =>
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, ...partial } : l)),
      })),

    // Pass 2 undo gap closure (May 10 2026) — reorderLayers fires once
    // per drag-and-drop drop event (HTML5 D&D). One drop = one undo
    // entry regardless of intermediate drag-over positions.
    reorderLayers: (idsInOrder) => {
      pushUndo()
      set((s) => {
        const byId = new Map(s.layers.map((l) => [l.id, l]))
        const next = idsInOrder.map((id) => byId.get(id)).filter(Boolean)
        const seen = new Set(idsInOrder)
        for (const l of s.layers) if (!seen.has(l.id)) next.push(l)
        return { layers: next }
      })
    },

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

    // ============ Technical Drawing actions (Phase 2 18b, May 10 2026) ======
    // Per Kickoff Spec §21. technicalLayers[] holds Technical Drawing layers
    // (separate from Field Markup `layers`). Each technical layer:
    //   { id: 'tech-layer-{n}', name: string, visible: true, shapes: [] }
    // 18b/18c — line shape:
    //   { id: 'tech-shape-{n}', type: 'line', a: {x,y}, b: {x,y},
    //     lengthInches: number,
    //     lengthSource: 'typed' | 'freehand',
    //     angleSource:  'typed' | 'freehand' }  // ← added 18c
    // a / b are RAW canvas pixel coords in TECHNICAL viewport space (no
    // photo to normalize against). Pan/zoom is applied at render time.
    // angle is NOT stored on the shape — it's derivable at render time
    // from atan2(b.y - a.y, b.x - a.x). Only the SOURCE flag persists so
    // the operator's typed-vs-freehand intent round-trips through save.
    //
    // addTechnicalShape auto-creates 'Layer 1' on first commit so the
    // operator can start drawing without a layer-panel detour. 18c+ adds
    // a real layer-panel UI for Technical Drawing.
    addTechnicalLayer: (name) => {
      pushUndo()
      const layer = {
        id: newTechLayerId(),
        name: typeof name === 'string' && name.length > 0 ? name : TECHNICAL_LAYER_NAME_DEFAULT,
        visible: true,
        shapes: [],
      }
      set((s) => ({ technicalLayers: [...s.technicalLayers, layer] }))
      return layer.id
    },

    addTechnicalShape: (shape) => {
      pushUndo()
      const id = shape.id || newTechShapeId()
      const fullShape = { ...shape, id }
      set((s) => {
        // Auto-create Layer 1 if no technical layers exist yet. Operator
        // didn't visit a layer panel — Spec §21 says the first commit
        // implicitly creates the default working layer.
        if (s.technicalLayers.length === 0) {
          const layer = {
            id: newTechLayerId(),
            name: TECHNICAL_LAYER_NAME_DEFAULT,
            visible: true,
            shapes: [fullShape],
          }
          return { technicalLayers: [layer] }
        }
        // Append to the FIRST technical layer (the default working layer).
        // 18c+ may surface a notion of "active technical layer" for
        // multi-layer projects; for 18b the first-layer convention is fine.
        return {
          technicalLayers: s.technicalLayers.map((tl, i) =>
            i === 0 ? { ...tl, shapes: [...tl.shapes, fullShape] } : tl
          ),
        }
      })
      return id
    },

    // updateTechnicalShape / deleteTechnicalShape — included as stubs so
    // 18c+ can wire edit + delete UI without another store touch. Both
    // push undo so the operator's expectation ("Cmd+Z reverses my last
    // edit") holds when the UI lands.
    updateTechnicalShape: (layerId, shapeId, patch) => {
      pushUndo()
      set((s) => ({
        technicalLayers: s.technicalLayers.map((tl) =>
          tl.id !== layerId ? tl : {
            ...tl,
            shapes: tl.shapes.map((sh) => sh.id === shapeId ? { ...sh, ...patch } : sh),
          }
        ),
      }))
    },

    deleteTechnicalShape: (layerId, shapeId) => {
      pushUndo()
      set((s) => ({
        technicalLayers: s.technicalLayers.map((tl) =>
          tl.id !== layerId ? tl : { ...tl, shapes: tl.shapes.filter((sh) => sh.id !== shapeId) }
        ),
      }))
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

    // P31 + P35 (May 7 2026) — set per-sequence annotation defaults.
    // partial may have defaultAnnoColor and/or defaultAnnoFontSize. The
    // fontSize is clamped here so the operator can't drag the stepper
    // outside [8, 32]. Pure setter (no pushUndo) — caller is expected
    // to manage snapshots (focus→blur for stepper, capture+push for
    // swatch click) so the undo granularity matches the input mode.
    setSeqAnnoDefaults: (seqId, partial) => {
      if (!partial || typeof partial !== 'object') return
      const update = {}
      if (typeof partial.defaultAnnoColor === 'string' && partial.defaultAnnoColor.length > 0) {
        update.defaultAnnoColor = partial.defaultAnnoColor
      }
      if (partial.defaultAnnoFontSize != null) {
        const n = Number(partial.defaultAnnoFontSize)
        if (Number.isFinite(n)) {
          update.defaultAnnoFontSize = Math.min(
            ANNO_FONT_SIZE_MAX,
            Math.max(ANNO_FONT_SIZE_MIN, Math.round(n)),
          )
        }
      }
      if (Object.keys(update).length === 0) return
      set((s) => ({
        sequences: s.sequences.map((seq) =>
          seq.id === seqId ? { ...seq, ...update } : seq
        ),
      }))
    },

    // Pass 2 undo gap closure (May 10 2026) — setSeqLayerVisibility is a
    // discrete operator action (single ●/○ click). One click = one undo
    // entry.
    setSeqLayerVisibility: (seqId, layerId, visible) => {
      pushUndo()
      set((s) => ({
        sequences: s.sequences.map((seq) =>
          seq.id !== seqId
            ? seq
            : { ...seq, layers: { ...seq.layers, [layerId]: !!visible } }
        ),
      }))
    },

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
    // Pass 2 undo gap closure (May 10 2026) — same as reorderLayers: one
    // drop = one undo entry.
    reorderSequences: (idsInOrder) => {
      pushUndo()
      set((s) => {
        const byId = new Map(s.sequences.map((seq) => [seq.id, seq]))
        const next = idsInOrder.map((id) => byId.get(id)).filter(Boolean)
        const seen = new Set(idsInOrder)
        for (const seq of s.sequences) if (!seen.has(seq.id)) next.push(seq)
        return { sequences: next }
      })
    },

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

    // P30 (May 8 2026) — atomic batch update across all annotations of one
    // sequence. Used by AnnotationPanel's "Translate all" handler.
    //
    // POST-VERIFICATION FIX (May 8 2026 operator gate failure on Check 9):
    // bulkUpdateAnnotations is now a PURE SETTER. The caller is responsible
    // for capturing+pushing the undo snapshot via captureUndoSnapshot /
    // pushCapturedSnapshot. This mirrors the Step 17 textarea + P34 drag
    // patterns and dodges a timing issue where the internal pushUndo + set
    // pair across an async await boundary did not produce a working Cmd+Z
    // entry on the live URL.
    //
    // Caller pattern:
    //   const snap = useAppStore.getState().captureUndoSnapshot()
    //   try {
    //     const updates = await asyncWork(...)  // API call etc.
    //     useAppStore.getState().bulkUpdateAnnotations(seqId, updates)
    //     useAppStore.getState().pushCapturedSnapshot(snap)
    //   } catch (e) { /* don't push — failure leaves stack clean */ }
    bulkUpdateAnnotations: (seqId, updates) => {
      if (!updates) return
      const map = updates instanceof Map ? updates : new Map(Object.entries(updates))
      if (map.size === 0) return
      set((s) => ({
        sequences: s.sequences.map((seq) =>
          seq.id !== seqId
            ? seq
            : {
                ...seq,
                annotations: (seq.annotations || []).map((a) =>
                  map.has(a.id) ? { ...a, ...map.get(a.id) } : a
                ),
              }
        ),
      }))
    },

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
    // Step 17 partial #5 — clearBackgroundImage embeds the about-to-be-
    // wiped photo binaries directly into the snapshot pushed onto
    // undoStack. Multi-step undo (clear → upload → clear → undo twice)
    // recovers each prior photo correctly, regardless of how many
    // wipes happened in between. Callers must await.
    //
    // NOTE: clearAll (New Project) intentionally does NOT route through
    // here — it's a hard project boundary that wipes the entire undo
    // stack (Bug A fix).
    clearBackgroundImage: async () => {
      // 1. Capture pre-wipe snapshot WITH the live photo binaries
      //    embedded. This is what Cmd+Z reads to restore.
      const enrichedSnap = await captureSnapWithLivePhoto()
      set((s) => {
        const next = [...s.undoStack, enrichedSnap]
        while (next.length > UNDO_LIMIT) next.shift()
        return { undoStack: next, redoStack: [] }
      })
      // 2. Wipe live IDB. Legacy 'background' key cleared too.
      await Promise.all([
        clearPhoto('cropped').catch((err) => console.warn('Failed to clear cropped photo:', err)),
        clearPhoto('source').catch((err) => console.warn('Failed to clear source photo:', err)),
        clearPhoto('background').catch(() => {}),
      ])
      // 3. Apply state.
      set({
        backgroundImage: null,
        photoMeta: null,
        cropMeta: null,
        hasSourcePhoto: false,
        // Reset viewport so the next photo upload starts at fit-to-viewport.
        viewport: { ...DEFAULT_VIEWPORT },
      })
    },

    // Section 7.A — viewport mutators. Set the whole viewport in one shot
    // (e.g. fit-to-viewport calc), or update one field. Zoom always clamped
    // to [ZOOM_MIN_CAP, ZOOM_MAX]; pan clamped lazily by the renderer/
    // pan-handler since the constraint depends on canvas dimensions.
    //
    // P37 (May 7 2026) — these setters are pure (don't touch the
    // viewportTouchedSinceFit flag). User-initiated pan/zoom call sites
    // (CanvasStage wheel zoom / drag pan / pinch / keyboard +/-)
    // explicitly call markViewportTouched alongside their setViewport
    // call. Internal call sites (resize clamp, fit, undo restore)
    // don't, so the flag accurately tracks "did the operator do
    // something deliberate."
    // Phase 2 18a (May 10 2026) — viewport actions write to BOTH the
    // per-mode `viewports[appMode]` AND the `viewport` runtime mirror in
    // a single atomic set. The mirror lets the 37+ existing CanvasStage
    // read sites continue to work via `state.viewport`; the per-mode
    // storage gives the operator independent pan/zoom in FIELD vs
    // TECHNICAL modes.
    setViewport: (v) => set((s) => {
      const normalized = normalizeViewport(v)
      const am = s.appMode === 'TECHNICAL' ? 'TECHNICAL' : 'FIELD'
      return {
        viewports: { ...s.viewports, [am]: normalized },
        viewport: normalized,
      }
    }),
    setZoom: (zoom) => set((s) => {
      const normalized = normalizeViewport({ ...s.viewport, zoom })
      const am = s.appMode === 'TECHNICAL' ? 'TECHNICAL' : 'FIELD'
      return {
        viewports: { ...s.viewports, [am]: normalized },
        viewport: normalized,
      }
    }),
    setPan: (panX, panY) => set((s) => {
      const normalized = normalizeViewport({ ...s.viewport, panX, panY })
      const am = s.appMode === 'TECHNICAL' ? 'TECHNICAL' : 'FIELD'
      return {
        viewports: { ...s.viewports, [am]: normalized },
        viewport: normalized,
      }
    }),

    // P37 (May 7 2026) — flag lifecycle helpers.
    //
    // markViewportTouched: called from user-initiated pan/zoom handlers
    // in CanvasStage / DrawingTools so the flag reflects intentional
    // operator action. Subsequent canvas-size-change events (window
    // resize, toolbar wrap) read this flag and SKIP auto-fit so the
    // operator's chosen viewport is preserved.
    markViewportTouched: () => set({ viewportTouchedSinceFit: true }),
    // fitToViewport: computes fit + sets viewport + clears the flag in
    // one set. Used by:
    //   - manual Fit button (DrawingTools onFit)
    //   - keyboard 0 (CanvasStage fitViewport)
    //   - photo-load microtask in CanvasStage (backgroundImage change)
    //   - auto-fit branch in resizeAll (when flag was already false)
    //   - commitCroppedPhoto path (zoom=0 + flag=false in store, then
    //     CanvasStage microtask sees zoom <= 0 and calls fitToViewport)
    // Operator who has manually panned/zoomed gets a fresh fit when
    // they hit Fit; operator who hasn't keeps fit on canvas resize.
    fitToViewport: (canvasW, canvasH) => {
      const s = get()
      if (!canvasW || !canvasH) {
        // No canvas dims — just clear the flag and bail. Same for both
        // appModes; the fit math needs valid canvas size to compute pan.
        set({ viewportTouchedSinceFit: false })
        return
      }

      // Phase 2 18c follow-on (operator-reported May 11 2026 on `8a754d2`):
      // Technical Drawing has no photo, so the pre-fix `!photoMeta` guard
      // bailed before writing the viewport — Fit appeared dead under
      // TECHNICAL. Branch here on appMode: TECHNICAL fits to the shape
      // bounding box (or resets to default when no shapes); FIELD keeps
      // the photo-based fit unchanged below.
      if (s.appMode === 'TECHNICAL') {
        // Compute bounding box across all visible technical layers.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        let hasShapes = false
        for (const layer of s.technicalLayers || []) {
          if (layer.visible === false) continue
          for (const shape of layer.shapes || []) {
            // 18b ships only the line shape; future tech shape types
            // (rect, arc, circ in 18d+) extend this loop with their own
            // bounding-box contributors.
            if (shape.type === 'line' && shape.a && shape.b) {
              minX = Math.min(minX, shape.a.x, shape.b.x)
              minY = Math.min(minY, shape.a.y, shape.b.y)
              maxX = Math.max(maxX, shape.a.x, shape.b.x)
              maxY = Math.max(maxY, shape.a.y, shape.b.y)
              hasShapes = true
            }
          }
        }

        if (!hasShapes) {
          // Empty canvas — reset to a centered identity viewport so the
          // operator gets a predictable "fresh canvas" state.
          const defaultTech = normalizeViewport({ panX: 0, panY: 0, zoom: 1.0 })
          set({
            viewports: { ...s.viewports, TECHNICAL: defaultTech },
            viewport: defaultTech,
            viewportTouchedSinceFit: false,
          })
          return
        }

        // Fit-to-bounding-box with ~40 px breathing room on each side.
        // Zoom is capped at 1.0 (never magnify a single point), and
        // bounded by ZOOM_MIN_CAP via normalizeViewport. Pan centers the
        // box on the canvas at the chosen zoom.
        const PADDING_PX = 40
        const contentW = maxX - minX
        const contentH = maxY - minY
        const availW = Math.max(canvasW - PADDING_PX * 2, 1)
        const availH = Math.max(canvasH - PADDING_PX * 2, 1)
        const zoomX = contentW > 0 ? availW / contentW : 1
        const zoomY = contentH > 0 ? availH / contentH : 1
        const zoomRaw = Math.min(zoomX, zoomY, 1.0)
        const centerX = (minX + maxX) / 2
        const centerY = (minY + maxY) / 2
        const fitTech = normalizeViewport({
          panX: canvasW / 2 - centerX * zoomRaw,
          panY: canvasH / 2 - centerY * zoomRaw,
          zoom: zoomRaw,
        })
        set({
          viewports: { ...s.viewports, TECHNICAL: fitTech },
          viewport: fitTech,
          viewportTouchedSinceFit: false,
        })
        return
      }

      // FIELD path — unchanged from pre-18c-follow-on. Photo-anchored
      // fit using computeFitViewport.
      if (!s.photoMeta) {
        set({ viewportTouchedSinceFit: false })
        return
      }
      const fit = computeFitViewport(s.photoMeta, canvasW, canvasH)
      // Phase 2 18a — write to BOTH per-mode viewports[appMode] AND the
      // viewport runtime mirror in one atomic set.
      const normalized = normalizeViewport(fit)
      set({
        viewports: { ...s.viewports, FIELD: normalized },
        viewport: normalized,
        viewportTouchedSinceFit: false,
      })
    },

    // Phase 2 18a (May 10 2026) — top-level app mode setter. Validates
    // input (rejects unknown modes — no-op, no throw, log warning so a
    // bad call site surfaces without crashing the app). On switch:
    //   - clear transient selection state (selected, selectedAnnotation, tool)
    //   - DO NOT clear undo/redo (cross-mode undo stays unified)
    //   - DO NOT mutate layers or technicalLayers
    //   - update the `viewport` runtime mirror to point at the new mode's
    //     viewports[next] entry so CanvasStage read sites see the right
    //     viewport for the new mode immediately
    setAppMode: (next) => {
      if (!VALID_APP_MODES.has(next)) {
        console.warn('setAppMode: invalid mode', next)
        return
      }
      set((s) => {
        if (s.appMode === next) return {}  // no-op if already in this mode
        return {
          appMode: next,
          viewport: s.viewports?.[next] || { ...DEFAULT_VIEWPORT },
          selected: null,
          selectedAnnotation: null,
          tool: null,
          // Phase 2 18b — any half-drawn Technical Drawing line is
          // abandoned on appMode switch (operator left the mode while
          // mid-draft). Mirrors the `tool: null` clear above so a
          // returning operator picks the tool back up cleanly.
          techDraft: null,
          // Phase 2 18d — selection is mode-scoped; entering FIELD
          // shouldn't leave TECHNICAL shapes "selected" in the back-
          // ground. Same goes for the transient typed rotation value.
          techSelected: [],
          techRotationInput: null,
          // 18d-pivot — pivot state is selection-scoped; mode change
          // wipes all three (locked pivot, pick-mode flag, hover snap).
          techPivot: null,
          techPivotPickMode: false,
          techPivotHover: null,
          techPivotOriginShapes: null,
          techPivotPreChangeSnap: null,
        }
      })
    },

    // Section 7.A — the source + cropped photo lifecycle. Pure state
    // setter — kept for any existing callers; the awaitable photo-
    // commit pipeline is `commitCroppedPhoto` below.
    setCroppedPhoto: ({ image, width, height, cropMeta, hasSourcePhoto }) => set({
      backgroundImage: image,
      photoMeta: { width, height },
      cropMeta: cropMeta || null,
      hasSourcePhoto: !!hasSourcePhoto,
    }),

    // Step 17 partial-completion #2 (Gap 2) — single awaitable action
    // that replaces the component-side pattern of "setCroppedPhoto +
    // Promise.all([savePhoto, savePhoto])." Backs up the previous photo
    // to _undo slots, decodes the new cropped data-URL, writes new
    // cropped + source to live IDB, and applies state — all in one
    // place so Cmd+Z recovery works regardless of which component
    // initiates the photo commit.
    //
    // Step 17 partial-completion #4 (Bug C) — re-cropping now also
    // re-projects every existing shape / cline / annotation onto the
    // new crop so they stay locked to physical roof features. The
    // operator gets a confirm dialog if any coords would fall outside
    // the new crop bounds (off-canvas after re-projection persists —
    // re-cropping wider recovers).
    //
    // Returns Promise<boolean>:
    //   true  — committed (decode succeeded, state applied)
    //   false — operator cancelled the out-of-bounds confirm dialog;
    //           no IDB writes, no state mutation, modal stays open.
    //
    // Inputs:
    //   croppedDataURL, sourceDataURL — the new photo data-URLs
    //   width, height — the new cropped photo's output dimensions
    //   cropMeta — the new crop rect in source-px coords + rotation
    //   sourceWidth, sourceHeight — source-photo dims (for re-projection
    //                              fallback when oldCropMeta is null)
    //   isRecrop — true when this commit is a re-crop on the SAME
    //              source photo (PhotoPanel Re-crop button); false for
    //              first-time uploads or Replace flows where the source
    //              photo is brand new and re-projection has no
    //              geometric meaning.
    //
    // Decode + IDB writes run in parallel so total latency ≈ max of the
    // four async operations rather than the sum.
    commitCroppedPhoto: async ({
      croppedDataURL, sourceDataURL, width, height, cropMeta,
      sourceWidth, sourceHeight, isRecrop,
    }) => {
      const cur = get()

      // ---- Re-projection (re-crop only) -------------------------------
      // Pure-function compute of the re-projected geometry so the
      // confirm dialog can fire BEFORE any state mutation or IDB
      // backup. Cancellation here returns without any side effect.
      let reprojectedLayers = cur.layers
      let reprojectedClines = cur.clines
      let reprojectedSequences = cur.sequences
      // P16 (May 8 2026) — perspective corners re-project alongside
      // shapes/clines/annotations. If any of the 4 corners falls out of
      // bounds in the new crop, the perspective is unusable; folded into
      // the existing confirm dialog rather than a new one.
      let reprojectedPerspectiveCorners = cur.perspectiveCorners

      const hasAnyCoords =
        cur.layers.some((l) => (l.shapes || []).length > 0)
        || cur.clines.length > 0
        || cur.sequences.some((s) => (s.annotations || []).length > 0)
        || (Array.isArray(cur.perspectiveCorners) && cur.perspectiveCorners.length === 4)

      if (isRecrop && hasAnyCoords) {
        const sourceDims = {
          w: Number(sourceWidth) || 0,
          h: Number(sourceHeight) || 0,
        }
        reprojectedLayers = cur.layers.map((l) => ({
          ...l,
          shapes: (l.shapes || []).map((sh) =>
            reprojectShape(sh, cur.cropMeta, cropMeta, sourceDims),
          ),
        }))
        reprojectedClines = cur.clines.map((cl) =>
          reprojectCline(cl, cur.cropMeta, cropMeta, sourceDims),
        )
        reprojectedSequences = cur.sequences.map((s) => ({
          ...s,
          annotations: (s.annotations || []).map((a) =>
            reprojectAnnotation(a, cur.cropMeta, cropMeta, sourceDims),
          ),
        }))
        if (cur.perspectiveCorners) {
          reprojectedPerspectiveCorners = reprojectPerspectiveCorners(
            cur.perspectiveCorners, cur.cropMeta, cropMeta, sourceDims,
          )
        }

        const counts = countOutOfBounds(
          reprojectedLayers, reprojectedClines, reprojectedSequences,
          reprojectedPerspectiveCorners,
        )
        const total = counts.shapes + counts.clines + counts.annotations + counts.perspective
        if (total > 0) {
          const parts = []
          if (counts.shapes > 0) parts.push(`${counts.shapes} shape${counts.shapes === 1 ? '' : 's'}`)
          if (counts.clines > 0) parts.push(`${counts.clines} construction line${counts.clines === 1 ? '' : 's'}`)
          if (counts.annotations > 0) parts.push(`${counts.annotations} annotation${counts.annotations === 1 ? '' : 's'}`)
          if (counts.perspective > 0) parts.push('the perspective grid')
          const ok = window.confirm(
            `This crop will hide ${parts.join(', ')} (off-canvas after re-crop). They'll persist — re-crop wider to recover. Continue?`
          )
          if (!ok) {
            return false
          }
        }
        // If perspective went out of bounds, clear it — operator confirmed.
        if (counts.perspective > 0) {
          reprojectedPerspectiveCorners = null
        }
      }

      // ---- Capture snapshot WITH embedded live photo binaries ---------
      // Step 17 partial #5 — the snapshot pushed onto undoStack here
      // embeds the about-to-be-replaced photo's data-URL binaries
      // directly under _croppedBin / _sourceBin. Each commitCroppedPhoto
      // call gets its OWN embedded backup, so multi-step undo
      // (re-crop A→B→C, undo twice) recovers each prior photo
      // independently — no single-slot collision like Phase B had.
      // captureSnapWithLivePhoto reads live IDB internally, so it
      // captures the OLD live binaries at the moment of capture
      // (before this action's new IDB writes fire).
      const enrichedSnap = await captureSnapWithLivePhoto()
      set((s) => {
        const next = [...s.undoStack, enrichedSnap]
        while (next.length > UNDO_LIMIT) next.shift()
        return { undoStack: next, redoStack: [] }
      })

      // ---- Decode new image + write live IDB in parallel --------------
      const [img] = await Promise.all([
        new Promise((resolve, reject) => {
          const i = new Image()
          i.onload = () => resolve(i)
          i.onerror = () => reject(new Error('Failed to decode cropped photo'))
          i.src = croppedDataURL
        }),
        savePhoto(croppedDataURL, 'cropped').catch((err) => {
          console.warn('Failed to persist cropped photo to IndexedDB:', err)
        }),
        savePhoto(sourceDataURL, 'source').catch((err) => {
          console.warn('Failed to persist source photo to IndexedDB:', err)
        }),
      ])

      // ---- Single atomic apply ----------------------------------------
      // Re-projected coords (no-op if not re-crop) + new photo state.
      // P37 (May 7 2026): on photo-crop confirm, ALWAYS re-fit the
      // viewport. Set zoom=0 + clear the touched flag here; CanvasStage's
      // backgroundImage subscription microtask sees zoom <= 0 and calls
      // fitToViewport with the current canvas dims (which knows the
      // photo's new dimensions and the live canvas size). Keeps the
      // re-fit logic in the canvas layer where canvas dims live; the
      // store just signals "please re-fit" via the zoom=0 sentinel.
      set({
        layers: reprojectedLayers,
        sequences: reprojectedSequences,
        clines: reprojectedClines,
        // P16 (May 8 2026) — perspective corners follow the same
        // re-projection path. Cleared above if any of the 4 fell out of
        // bounds in the new crop (operator confirmed via the existing
        // dialog).
        perspectiveCorners: reprojectedPerspectiveCorners,
        backgroundImage: img,
        photoMeta: { width, height },
        cropMeta: cropMeta || null,
        hasSourcePhoto: true,
        viewport: { panX: 0, panY: 0, zoom: 0 },
        viewportTouchedSinceFit: false,
      })

      return true
    },

    // ============ Selection (Spec §9) =======================================
    // P17 (May 5 2026) — selecting a shape in EDIT mode also activates its
    // parent layer so a subsequent mode-switch to DRAW picks up where the
    // operator's attention left off. Skipped when sel is null (deselect)
    // or sel.shapeId is null/missing, and when mode isn't EDIT — those
    // cases were never the bug. Only EDIT-mode shape selection auto-
    // activates; explicit setActiveLayer calls remain authoritative if
    // the operator wants to keep their drawing layer separate.
    setSelected: (sel) =>
      set((s) => {
        const shouldActivate =
          sel
          && sel.shapeId != null
          && sel.layerId != null
          && s.mode === 'EDIT'
        if (shouldActivate) {
          return { selected: sel, activeLayerId: sel.layerId }
        }
        return { selected: sel }
      }),
    clearSelection: () => set({ selected: null }),

    // Step 13 — annotation panel selection. setSelectedAnnotation accepts
    // { sequenceId, annotationId } or null. Transient UI; not persisted.
    setSelectedAnnotation: (sel) => set({ selectedAnnotation: sel }),
    clearSelectedAnnotation: () => set({ selectedAnnotation: null }),

    // ============ App state actions =========================================
    setMode: (mode) => {
      // Phase 2 18b ride-along cleanup: VALID_MODES guard. Pre-18b setMode
      // accepted any string. Untyped callers that passed (e.g. the stale
      // 'TECHNICAL' literal) would silently corrupt the mode slice. With
      // 18a's appMode split, Technical Drawing is its own top-level mode;
      // the inner Field Markup mode is strictly DRAW/EDIT/SEQUENCE.
      if (!VALID_MODES.has(mode)) return
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
        // apply outside DRAW mode. (Ride-along: pre-18b this branch also
        // preserved tool when `mode === 'TECHNICAL'` — dead path since the
        // appMode split moved Technical Drawing out of the mode slice
        // entirely. Dropped in 18b.)
        tool: mode === 'DRAW' ? s.tool : null,
      }))
    },
    setTool: (tool) => set((s) => {
      // Phase 2 18d — switching away from 'tech-select' clears the
      // selection + typed rotation value. Selection is tool-scoped: a
      // returning operator picking 'tech-select' starts with a fresh
      // selection.
      if (s.tool === 'tech-select' && tool !== 'tech-select') {
        return {
          tool,
          techSelected: [],
          techRotationInput: null,
          // 18d-pivot — pivot state is tied to the Select tool;
          // switching away wipes it.
          techPivot: null,
          techPivotPickMode: false,
          techPivotHover: null,
          techPivotOriginShapes: null,
          techPivotPreChangeSnap: null,
        }
      }
      return { tool }
    }),
    // Phase 2 18b — setTechDraft writes the Technical Drawing line-tool
    // draft state. Called from CanvasStage onMouseDown (anchor capture)
    // + TechLengthInput onTypedChange (live projection update) + commit/
    // cancel paths. Pass null to clear. Subscribed by CanvasStage's
    // dirty-flag pipeline so changes trigger a dynamic-canvas repaint.
    setTechDraft: (techDraft) => set({ techDraft }),

    // ============ Phase 2 18d — Technical Drawing selection (May 11 2026) ====
    // Multi-shape selection lives in `techSelected` (transient). Validates
    // each {layerId, shapeId} entry against current technicalLayers; invalid
    // entries are silently dropped. Keeps the canvas + TechInputPanel from
    // ever pointing at a stale shape.
    setTechSelection: (arr) => set((s) => {
      if (!Array.isArray(arr)) return { techSelected: [] }
      const valid = arr.filter((entry) => {
        if (!entry || typeof entry !== 'object') return false
        if (!entry.layerId || !entry.shapeId) return false
        const layer = s.technicalLayers.find((tl) => tl.id === entry.layerId)
        if (!layer) return false
        return (layer.shapes || []).some((sh) => sh.id === entry.shapeId)
      })
      return { techSelected: valid }
    }),

    addToTechSelection: (entry) => set((s) => {
      if (!entry || !entry.layerId || !entry.shapeId) return {}
      const layer = s.technicalLayers.find((tl) => tl.id === entry.layerId)
      if (!layer) return {}
      const exists = (layer.shapes || []).some((sh) => sh.id === entry.shapeId)
      if (!exists) return {}
      const already = s.techSelected.some(
        (e) => e.layerId === entry.layerId && e.shapeId === entry.shapeId
      )
      if (already) return {}
      return { techSelected: [...s.techSelected, { layerId: entry.layerId, shapeId: entry.shapeId }] }
    }),

    removeFromTechSelection: (entry) => set((s) => {
      if (!entry) return {}
      return {
        techSelected: s.techSelected.filter(
          (e) => !(e.layerId === entry.layerId && e.shapeId === entry.shapeId)
        ),
      }
    }),

    toggleTechSelectionMember: (entry) => set((s) => {
      if (!entry || !entry.layerId || !entry.shapeId) return {}
      const layer = s.technicalLayers.find((tl) => tl.id === entry.layerId)
      if (!layer) return {}
      const exists = (layer.shapes || []).some((sh) => sh.id === entry.shapeId)
      if (!exists) return {}
      const idx = s.techSelected.findIndex(
        (e) => e.layerId === entry.layerId && e.shapeId === entry.shapeId
      )
      if (idx >= 0) {
        // Remove
        const next = s.techSelected.slice()
        next.splice(idx, 1)
        return { techSelected: next }
      }
      // Add
      return { techSelected: [...s.techSelected, { layerId: entry.layerId, shapeId: entry.shapeId }] }
    }),

    clearTechSelection: () => set({
      techSelected: [],
      // 18d-pivot — selection cleared means there's no shape to rotate
      // around. Reset all pivot state so a returning operator doesn't
      // inherit a stale pivot from a different selection.
      techPivot: null,
      techPivotPickMode: false,
      techPivotHover: null,
      techPivotOriginShapes: null,
      techPivotPreChangeSnap: null,
    }),

    // 18d — Transient typed rotation value. Cleared on selection clear,
    // on rotation commit, and on Escape.
    setTechRotationInput: (value) => set({ techRotationInput: value }),

    // 18d-pivot (May 11 2026) — operator-chosen rotation pivot. Three
    // setters mirror the state-field naming. No validation beyond shape
    // (the resolveTechPivot helper in techGeometry.js handles null
    // gracefully; the canvas dispatch / TechInputPanel call paths
    // ensure only well-formed values get written).
    setTechPivot: (point) => set({ techPivot: point }),
    setTechPivotPickMode: (active) => set({ techPivotPickMode: !!active }),
    setTechPivotHover: (target) => set({ techPivotHover: target }),
    // 18d-pivot live-rotation — origin-shape snapshot + pre-change undo snap.
    setTechPivotOriginShapes: (arr) => set({ techPivotOriginShapes: arr }),
    setTechPivotPreChangeSnap: (snap) => set({ techPivotPreChangeSnap: snap }),

    // 18d — Per-mousemove rotation drag mutator. Mirrors
    // updateTechnicalShape (same set() shape) but DOES NOT call pushUndo.
    // The drag captures one undo snapshot at mousedown via
    // captureUndoSnapshot and pushes it at mouseup if anything changed
    // (same pattern as Field Markup's editDrag at CanvasStage.jsx:2184).
    updateTechnicalShapeNoUndo: (layerId, shapeId, patch) => {
      set((s) => ({
        technicalLayers: s.technicalLayers.map((tl) =>
          tl.id !== layerId ? tl : {
            ...tl,
            shapes: tl.shapes.map((sh) => sh.id === shapeId ? { ...sh, ...patch } : sh),
          }
        ),
      }))
    },
    setCursor: (x, y) => set({ cursorX: x, cursorY: y }),
    // (Old setSnapType: (snapType) => set({ snapType }) was vestigial dead
    // code with no callers — setSnap below writes both snapPt + snapType
    // atomically. Removed May 7 2026 to free the name for P2's per-type
    // gate setter below.)
    // Spec §8 — full snap point setter (writes both snapPt and snapType in
    // one mutation so subscribers see a coherent snap result). Pass null to
    // clear the snap.
    setSnap: (snapPt) => set({
      snapPt,
      snapType: snapPt?.type ?? null,
    }),
    toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
    // P2 (May 7 2026) — per-snap-type toggle. Validates name against
    // SNAP_TYPE_KEYS so unknown types are silently rejected. Operator
    // calls this from the SnapMenu chip; computeSnap reads
    // s.snapTypes[name] before each branch. Master snapEnabled stays
    // independent — flipping it off bypasses all per-type gates.
    setSnapType: (name, enabled) => {
      if (!SNAP_TYPE_KEYS.includes(name)) return
      set((s) => ({ snapTypes: { ...s.snapTypes, [name]: !!enabled } }))
    },
    toggleGrid: () => set((s) => ({ gridEnabled: !s.gridEnabled })),
    // P19 (May 7 2026) — grid opacity slider (0.05–0.6). Clamped via
    // normalizeGridOpacity. Render path reads `gridOpacity` directly
    // from store (CanvasStage drawStatic).
    setGridOpacity: (v) => set({ gridOpacity: normalizeGridOpacity(v) }),
    // Step 16 (May 8 2026) — PDF orientation preference setter. Validates
    // the input via normalizePdfOrientation; invalid inputs fall back to
    // 'auto'. Pure setter (no pushUndo) — orientation is a UI preference,
    // not data state.
    setPdfOrientation: (v) => set({ pdfOrientation: normalizePdfOrientation(v) }),

    // P38 (May 8 2026) — single-angle grid rotation setter. Clamped to
    // [-180, 180] via normalizeGridRotation (with wraparound for stability
    // on out-of-range inputs). Pure setter — rotation is a UI preference.
    setGridRotation: (v) => set({ gridRotation: normalizeGridRotation(v) }),

    // P16 (May 8 2026) — perspective grid corner setters. setPerspectiveCorners
    // takes the full 4-point array (TL/TR/BR/BL); setPerspectiveCorner(idx, p)
    // updates a single corner during drag. Both validate via normalizer; an
    // invalid array falls back to null (clears perspective). Pure setters —
    // perspective state is geometry-adjacent but operators DO want Cmd+Z to
    // revert a drag (P34 captured-snapshot pattern from CanvasStage handles
    // the undo at the drag layer, same as shape/annotation drags).
    setPerspectiveCorners: (corners) => set({
      perspectiveCorners: normalizePerspectiveCorners(corners),
    }),
    setPerspectiveCorner: (idx, point) => {
      if (!Number.isInteger(idx) || idx < 0 || idx > 3) return
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return
      set((s) => {
        const cur = s.perspectiveCorners
          ? s.perspectiveCorners.map((c) => ({ ...c }))
          : [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
        // Clamp to [0, 1] with overshoot tolerance.
        const clamped = {
          x: Math.min(1, Math.max(0, point.x)),
          y: Math.min(1, Math.max(0, point.y)),
        }
        cur[idx] = clamped
        return { perspectiveCorners: cur }
      })
    },
    clearPerspectiveCorners: () => set({ perspectiveCorners: null }),

    // P16 (May 8 2026) — perspective-edit mode toggle. Operator clicks the
    // Perspective button in the snap-grid group; mode flag flips. While
    // active, CanvasStage paints corner handles + the dotted overlay, and
    // mousedown on a corner starts a perspectiveDrag. Mode is transient —
    // not persisted across reload (operator re-enters explicitly).
    setPerspectiveEditMode: (v) => set({ perspectiveEditMode: !!v }),
    togglePerspectiveEditMode: () => {
      // P16 + P38 follow-on fix (May 8 2026) — first-activation path is a
      // destructive state change (null → 4 default corners). Push a
      // snapshot BEFORE the set so Cmd+Z restores the no-perspective
      // state. Subsequent toggles just flip the edit-mode flag (no data
      // mutation, no undo entry needed).
      const cur = get()
      const willEnter = !cur.perspectiveEditMode
      const isFirstActivation = willEnter && !cur.perspectiveCorners
      if (isFirstActivation) {
        pushUndo()
        set({
          perspectiveEditMode: true,
          perspectiveCorners: [
            { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
          ],
        })
      } else {
        set({ perspectiveEditMode: willEnter })
      }
    },
    // P16 (May 8 2026) — clearPerspectiveCorners is also a destructive
    // state change (4 corners → null). Push a snapshot so Cmd+Z restores
    // the prior corner config.
    clearPerspectiveCornersWithUndo: () => {
      const cur = get()
      if (!cur.perspectiveCorners) return
      pushUndo()
      set({ perspectiveCorners: null })
    },
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

    // ============ P45 — File System Access API (May 10 2026) ================
    // Phase 2 18a — Save As Dialog via File System Access API. Persistent
    // FileSystemFileHandle lives in IndexedDB ('fileHandles' object store,
    // key 'projectSave'), loaded asynchronously at boot via the post-init
    // bootstrap at the bottom of this file. saveProject writes through the
    // handle (silent re-save, no picker); saveProjectAs always opens the
    // picker. On Safari / Firefox where the API is unavailable, both
    // actions fall back to the legacy Blob + <a download> path.
    //
    // Filename suggestion uses the existing Step 17 pattern:
    //   roofmark-project-YYYY-MM-DD-HHMM.json
    //
    // Error handling per spec:
    //   - User cancels picker → no state change, no throw
    //   - Permission lost mid-write → clear handle, fall through to Save As
    //   - File deleted externally → clear handle, fall through to Save As
    //   - Permission denied after re-request → friendly alert, no corrupt state
    saveProject: async () => {
      const s = get()
      if (s.currentFileHandle) {
        try {
          const json = await get().exportJSON()
          await writeToHandle(s.currentFileHandle, json)
          set({ saveState: 'saved', lastSavedAt: Date.now() })
          return
        } catch (err) {
          const msg = err?.message || ''
          if (msg === 'FILE_HANDLE_LOST'
            || msg === 'FILE_HANDLE_REVOKED'
            || msg === 'FILE_HANDLE_PERMISSION_DENIED') {
            // Handle is no longer usable — clear in-memory + IDB and
            // fall through to Save As. Operator picks a new save target.
            set({ currentFileHandle: null, currentFileName: null })
            clearFileHandle().catch(() => {})
            // Fall through to saveProjectAs below
          } else {
            // Unknown error — surface to operator + don't corrupt state.
            if (typeof window !== 'undefined') {
              window.alert(`Save failed: ${msg || String(err)}`)
            }
            return
          }
        }
      }
      // No handle (or fell through from lost handle): invoke Save As flow.
      return get().saveProjectAs()
    },

    saveProjectAs: async () => {
      // Build the standard filename suggestion. Same pattern as Step 17's
      // inline App.jsx filename composition (consolidated into the store
      // per P45 spec).
      const d = new Date()
      const pad2 = (n) => String(n).padStart(2, '0')
      const suggestedName = `roofmark-project-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`

      let json
      try {
        json = await get().exportJSON()
      } catch (err) {
        if (typeof window !== 'undefined') {
          window.alert(`Save failed (export): ${err?.message || String(err)}`)
        }
        return
      }

      if (!isFileSystemAccessSupported()) {
        // Legacy fallback — Blob + <a download> + revoke. Safari / Firefox
        // operators take this path. No persistent handle is captured,
        // so subsequent Save also takes the legacy path (each Save
        // re-downloads to the operator's default Downloads folder).
        try {
          const blob = new Blob([json], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = suggestedName
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          set({
            currentFileName: suggestedName,
            // currentFileHandle stays null — no native handle in legacy path
            saveState: 'saved',
            lastSavedAt: Date.now(),
          })
        } catch (err) {
          if (typeof window !== 'undefined') {
            window.alert(`Save failed: ${err?.message || String(err)}`)
          }
        }
        return
      }

      // Native picker path
      let handle
      try {
        handle = await pickSaveFile({ suggestedName })
      } catch (err) {
        if (typeof window !== 'undefined') {
          window.alert(`Save As failed: ${err?.message || String(err)}`)
        }
        return
      }
      if (!handle) return  // user cancelled — no state change

      try {
        await writeToHandle(handle, json)
        await saveFileHandle(handle).catch((e) => console.warn('Failed to persist file handle:', e))
        set({
          currentFileHandle: handle,
          currentFileName: handle.name || suggestedName,
          saveState: 'saved',
          lastSavedAt: Date.now(),
        })
      } catch (err) {
        if (typeof window !== 'undefined') {
          window.alert(`Save As failed (write): ${err?.message || String(err)}`)
        }
      }
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
      // TEMP v3 compat — also write the legacy top-level `viewport` field
      // equal to viewports.FIELD so a future rollback (Phase 2 → Phase 1
      // emergency revert) can degrade-read v3 files. Remove after Phase 2
      // ships and the rollback window closes. Tracked: see SCHEMA_VERSION
      // doc block above.
      payload.viewport = s.viewports?.FIELD || { ...DEFAULT_VIEWPORT }
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
        throw new Error(`Schema version mismatch: file is v${obj.schemaVersion}, app supports v1, v2, v3.`)
      }
      // Step 17 partial-completion #3 (Bug A) — capture pre-import
      // snapshot so Cmd+Z can undo the Load (operator-friendly: "I
      // didn't mean to overwrite my project"). The snapshot is the ONLY
      // entry on the post-import undoStack — prior history is dropped
      // so Cmd+Z chains can't walk back into the previous project's
      // shape/photo state. Inverse of clearAll which drops the stack
      // entirely; here one entry stays so the import itself is
      // reversible. Inserted into the set() below alongside imported
      // state.
      const preImportSnapshot = dataSnapshot(get())
      reseedCounters(obj)
      // Validate inbound fields the same way hydration does so a
      // hand-edited or older-version JSON file doesn't corrupt state.
      const layers = Array.isArray(obj.layers) ? obj.layers : []
      // P31 + P35 — normalize imported sequences so they pick up the
      // new default-* fields if the file predates the migration. The
      // existing fallback chain in the render path means missing fields
      // wouldn't visually break anything, but explicit normalization
      // makes localStorage / next Save JSON consistent with the schema.
      const sequences = (Array.isArray(obj.sequences) ? obj.sequences : []).map(normalizeSequence)
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

      // Photo restoration. v1 has no photo data; v2 and v3 may carry one
      // or both slots under `_photos`. Always reconcile IDB to the file's
      // intent (clear absent slots) so the imported project doesn't
      // inherit a stale photo from whatever was loaded before.
      //
      // Photo-bug fix (Phase 2 18a follow-on, May 10 2026):
      //   Pre-fix this line read `obj.schemaVersion === 2 && obj._photos`,
      //   which silently dropped the embedded photo on v3 files. Operator
      //   reported on live URL `01615d1` that Save As → Load Project
      //   restored everything BUT the photo. exportJSON has always written
      //   `_photos` regardless of schemaVersion; the gate was on the
      //   reader side only. Now reads from any non-v1 file.
      let backgroundImage = null
      let hasSourcePhoto = false
      const photos = (obj.schemaVersion !== 1 && obj._photos) ? obj._photos : null
      if (obj.schemaVersion === 1) {
        console.warn('RoofMark: importing v1 project file — no photo embedded. Use 📷 Photo to upload one.')
        await Promise.all([
          clearPhoto('cropped').catch(() => {}),
          clearPhoto('source').catch(() => {}),
          clearPhoto('background').catch(() => {}),
        ])
      } else {
        // v2 / v3 — write whatever slots are present, clear the rest.
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

      // Phase 2 18a (May 10 2026) — v1/v2/v3 → v3 migration in memory.
      // v1 and v2 files don't carry `appMode`, `technicalLayers`,
      // `specTable`, or `viewports` — apply defaults via the same
      // normalizers used at hydration. v3 files load their fields
      // directly. The migrated state is what gets written back on the
      // next exportJSON / autosave (so localStorage + next Save catch
      // up to v3 schema automatically without operator action).
      const migratedAppMode = (obj.schemaVersion >= 3)
        ? normalizeAppMode(obj.appMode) : 'FIELD'
      const migratedViewports = (obj.schemaVersion >= 3 && obj.viewports)
        ? normalizeViewports(obj.viewports, null)
        : normalizeViewports(null, obj.viewport)  // v1/v2: legacy single → FIELD
      const migratedTechnicalLayers = Array.isArray(obj.technicalLayers)
        ? obj.technicalLayers : []
      const migratedSpecTable = (obj.specTable && typeof obj.specTable === 'object')
        ? obj.specTable : {}

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
        // Phase 2 18a — viewports is the source of truth; viewport mirror
        // tracks viewports[appMode]. v1/v2 files migrate via the legacy
        // `obj.viewport` field; v3 files use `obj.viewports` directly.
        appMode: migratedAppMode,
        viewports: migratedViewports,
        viewport: migratedViewports[migratedAppMode],
        technicalLayers: migratedTechnicalLayers,
        specTable: migratedSpecTable,
        photoMeta: normalizePhotoMeta(obj.photoMeta),
        cropMeta: obj.cropMeta || null,
        backgroundImage,
        hasSourcePhoto,
        selected: null,
        selectedAnnotation: null,
        tool: null,
        // Pass 1 fix (May 8 2026 — operator-reported boundary bug):
        // pre-this-fix the importJSON set() block did NOT write
        // gridRotation, perspectiveCorners, perspectiveEditMode, OR
        // pdfOrientation. When loading a project, those fields kept
        // whatever values they had pre-Load (Project A's state). For
        // perspective corners specifically, this caused Project A's
        // perspective to bleed into the loaded project — and since
        // perspectiveActive=true dims the rotation input, the operator
        // saw the rotation input "permanently disabled" after Load.
        //
        // Apply each field using the same normalizers used at hydration
        // (lines 363, 366, 370 in initial state). exportJSON already
        // wrote these fields via PERSIST_KEYS iteration; importJSON
        // just wasn't reading them. perspectiveEditMode is intentionally
        // forced false on Load — it's a transient UI flag that should
        // never restore from a serialized file (operator re-enters
        // edit mode explicitly via the Persp button).
        gridRotation: normalizeGridRotation(obj.gridRotation),
        perspectiveCorners: normalizePerspectiveCorners(obj.perspectiveCorners),
        perspectiveEditMode: false,
        // Phase 2 18b — transient Technical Drawing draft never restores
        // from a file (same convention as perspectiveEditMode).
        techDraft: null,
        // Phase 2 18d — selection + typed rotation are session-scoped UI
        // state. Loaded projects start with no selection (operator picks
        // shapes again in the freshly-loaded canvas).
        techSelected: [],
        techRotationInput: null,
        // 18d-pivot — pivot is session-scoped UI state. Never persisted.
        techPivot: null,
        techPivotPickMode: false,
        techPivotHover: null,
        techPivotOriginShapes: null,
        techPivotPreChangeSnap: null,
        pdfOrientation: normalizePdfOrientation(obj.pdfOrientation),
        // P45 (Phase 2 18a, May 10 2026) — Load Project clears the
        // currentFileHandle + currentFileName so the loaded file is
        // read-only until the operator explicitly Save As. This matches
        // operator expectation: a loaded file is "someone else's save
        // target," not the operator's destination. Their next Save
        // opens the picker fresh.
        currentFileHandle: null,
        currentFileName: null,
        // Bug A — single-entry undoStack with the pre-import snapshot.
        // Cmd+Z restores pre-import state; second Cmd+Z is a no-op
        // (button disables). Prior history is intentionally dropped to
        // prevent cross-project bleed. Photo undo data lives embedded
        // in snapshots (Step 17 partial #5) so no separate flag reset
        // is needed here.
        undoStack: [preImportSnapshot],
        redoStack: [],
      })
      // Fire-and-forget IDB clear of the file handle entry. Mirrors
      // the photo IDB wipe pattern in clearAll.
      clearFileHandle().catch(() => {})
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
    // Step 17 partial-completion #2 (Gap 2) — undo is now async-aware
    // because crossing a photo wipe boundary requires async IDB ops to
    // restore the binary from _undo slots. Geometry-only undo (the
    // common case) still resolves in a single tick — the await on
    // restorePhotoFromUndo only fires when the popped snapshot's photo
    // state differs from current. Components fire-and-forget the
    // returned Promise (App.jsx handleUndo / Cmd+Z keyboard handler);
    // the Promise resolution is only useful for tests + future code.
    undo: async () => {
      const { undoStack, redoStack } = get()
      if (undoStack.length === 0) return false
      const current = dataSnapshot(get())
      const last = undoStack[undoStack.length - 1]
      const next = JSON.parse(last)

      // Detect photo-state boundary crossing.
      const cur = get()
      const nextPhotoMeta = next.photoMeta || null
      const nextCropMeta = next.cropMeta || null
      const nextHasSourcePhoto = !!next.hasSourcePhoto
      const photoChanged =
        JSON.stringify(cur.photoMeta || null) !== JSON.stringify(nextPhotoMeta)
        || JSON.stringify(cur.cropMeta || null) !== JSON.stringify(nextCropMeta)
        || (!!cur.hasSourcePhoto) !== nextHasSourcePhoto

      // Geometry always restores
      const patch = {
        layers: next.layers,
        sequences: next.sequences,
        clines: next.clines,
        // P16 + P38 follow-on fix (May 8 2026) — restore grid rotation +
        // perspective corners alongside the rest of the geometry. Falls
        // back to the existing default (0 / null) when an older snapshot
        // (pre-this-fix) doesn't carry the field — backward compat with
        // any in-flight session that pushed snapshots before the fix
        // landed.
        gridRotation: typeof next.gridRotation === 'number' ? next.gridRotation : 0,
        perspectiveCorners: next.perspectiveCorners ?? null,
        // Phase 2 18b follow-on (operator-reported May 10 2026 on
        // `1edd117`) — restore Technical Drawing geometry + spec table
        // alongside the rest. Pre-this-fix undo popped the stack but
        // never patched these fields, leaving committed Technical lines
        // on the canvas while the operator pressed Cmd+Z. Backward-
        // compat fallback to [] / {} for snapshots pushed pre-fix.
        technicalLayers: Array.isArray(next.technicalLayers) ? next.technicalLayers : [],
        specTable: (next.specTable && typeof next.specTable === 'object') ? next.specTable : {},
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, current],
      }

      if (photoChanged) {
        // Step 17 partial #5 — read embedded photo binaries from the
        // snapshot. Three branches:
        //   1. Snapshot says "no photo" (photoMeta === null): clear
        //      live IDB + apply null photo state.
        //   2. Snapshot has photoMeta + embedded _croppedBin: write
        //      binaries to live IDB + decode + apply photo state.
        //   3. Snapshot has photoMeta but no _croppedBin: this happens
        //      when the snapshot was pushed by a non-photo-wipe action
        //      (vanilla pushUndo from addShape/etc.) AND a photo state
        //      change has occurred since. In that case the geometry
        //      undo "doesn't cross a photo boundary" from the operator
        //      mental-model perspective — leave photo state as-is.
        if (nextPhotoMeta == null) {
          // Branch 1: snapshot says no photo.
          await Promise.all([
            clearPhoto('cropped').catch(() => {}),
            clearPhoto('source').catch(() => {}),
          ])
          patch.photoMeta = null
          patch.cropMeta = null
          patch.hasSourcePhoto = false
          patch.backgroundImage = null
          patch.viewport = { panX: 0, panY: 0, zoom: 0 }
        } else if (typeof next._croppedBin === 'string' && next._croppedBin.length > 0) {
          // Branch 2: snapshot has embedded photo binary.
          const croppedURL = next._croppedBin
          const sourceURL = (typeof next._sourceBin === 'string' && next._sourceBin.length > 0)
            ? next._sourceBin : null
          await Promise.all([
            savePhoto(croppedURL, 'cropped').catch(() => {}),
            sourceURL
              ? savePhoto(sourceURL, 'source').catch(() => {})
              : clearPhoto('source').catch(() => {}),
          ])
          const img = await new Promise((resolve) => {
            const i = new Image()
            i.onload = () => resolve(i)
            i.onerror = () => {
              console.warn('Failed to decode embedded photo backup')
              resolve(null)
            }
            i.src = croppedURL
          })
          patch.backgroundImage = img
          patch.photoMeta = nextPhotoMeta
          patch.cropMeta = nextCropMeta
          patch.hasSourcePhoto = !!sourceURL
          // Reset viewport so CanvasStage's backgroundImage subscription
          // re-fits the restored photo (zoom <= 0 triggers
          // computeFitViewport in the microtask).
          patch.viewport = { panX: 0, panY: 0, zoom: 0 }
        } else {
          // Branch 3: snapshot has photoMeta but no binary backup.
          // Geometry-only restore; photo state stays as-is.
          console.info('Photo undo backup unavailable — geometry restored, photo unchanged.')
        }
      }

      set(patch)
      return true
    },

    // Redo restores geometry but NOT photo state. Bidirectional photo
    // restore would need a parallel _redo slot pair; out of scope for
    // Phase B. If undo restored a photo from _undo, redo will geometry-
    // forward but the photo stays where the most recent undo put it.
    // Documented limit alongside backup-of-backup.
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
        // P16 + P38 follow-on fix (May 8 2026) — redo also reapplies
        // rotation + perspective corners so Cmd+Shift+Z restores the
        // post-action state symmetrically with undo.
        gridRotation: typeof next.gridRotation === 'number' ? next.gridRotation : 0,
        perspectiveCorners: next.perspectiveCorners ?? null,
        // Phase 2 18b follow-on (operator-reported May 10 2026) —
        // symmetric restore for Technical geometry + spec table so
        // Cmd+Shift+Z brings back what Cmd+Z undid. Backward-compat
        // fallback to [] / {} for pre-fix snapshots.
        technicalLayers: Array.isArray(next.technicalLayers) ? next.technicalLayers : [],
        specTable: (next.specTable && typeof next.specTable === 'object') ? next.specTable : {},
        // Photo fields intentionally NOT restored. See note above.
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
    // re-selecting the address.
    //
    // Step 17 partial-completion #3 (Bug A) — clearAll is now a HARD
    // boundary. The undo + redo stacks are wiped along with the rest
    // of project state, so Cmd+Z after New Project does nothing (the
    // ↩ Undo button auto-disables via the existing length===0 logic
    // in App.jsx:118-119). The previous behavior pushed a pre-clear
    // snapshot onto the stack so Cmd+Z could "undo the New Project
    // action," but in practice that bled the prior project's history
    // into the supposedly-fresh project — a Cmd+Z chain after New
    // Project would walk back through layers/shapes from the previous
    // job. The confirm dialog already warns operators that New Project
    // is destructive; making the boundary irrevocable matches that
    // contract. Operators who want to recover prior work use Save +
    // Load JSON instead.
    clearAll: () => {
      set((s) => ({
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
        // Phase 2 18a — reset both per-mode viewports + the viewport
        // mirror to defaults. appMode itself is NOT changed by New
        // Project (operator stays in whichever mode they were in).
        viewports: { FIELD: { ...DEFAULT_VIEWPORT }, TECHNICAL: { ...DEFAULT_VIEWPORT } },
        viewport: { ...DEFAULT_VIEWPORT },
        // Phase 2 18a — wipe Technical Drawing geometry + spec table
        // alongside Field Markup data. Both belong to the prior project.
        technicalLayers: [],
        specTable: {},
        // P16 + P38 mini-step (May 8 2026) — wipe perspective grid +
        // rotation alongside the rest of the project state. They're
        // photo-anchored geometry, so they don't survive a New Project.
        perspectiveCorners: null,
        perspectiveEditMode: false,
        gridRotation: 0,
        // Phase 2 18b — transient Technical Drawing draft also cleared on
        // New Project so a half-drawn line from the prior session doesn't
        // surface mid-input on the cleared canvas.
        techDraft: null,
        // Phase 2 18d — selection + typed rotation cleared on New Project
        // (same convention as `selected` for Field Markup above).
        techSelected: [],
        techRotationInput: null,
        // 18d-pivot — pivot cleared too.
        techPivot: null,
        techPivotPickMode: false,
        techPivotHover: null,
        techPivotOriginShapes: null,
        techPivotPreChangeSnap: null,
        // P45 (Phase 2 18a, May 10 2026) — New Project clears the
        // currentFileHandle + currentFileName so the operator's next
        // Save opens the picker fresh. Matches the Load Project
        // convention (the prior project's save target is no longer
        // meaningful for the new project).
        currentFileHandle: null,
        currentFileName: null,
        // HARD boundary — wipe undo/redo history so the prior project's
        // snapshots (and their embedded photo binaries) can't bleed
        // into the cleared project via Cmd+Z.
        undoStack: [],
        redoStack: [],
        // appMode intentionally NOT cleared — operator stays in the
        // mode they were working in. Reference s.appMode read above
        // so the shape stays consistent if a future field adds
        // dependencies on the prior appMode.
        appMode: s.appMode,
      }))
      // Wipe persisted photos from IndexedDB so refresh doesn't bring
      // them back. Fire-and-forget — the render pipeline already
      // reflects the in-memory clear. Also wipe _undo slots so a
      // stale backup from the prior project doesn't survive the boundary.
      // P45 — clear the file handle IDB entry too.
      if (typeof window !== 'undefined') {
        clearPhoto('cropped').catch(() => {})
        clearPhoto('source').catch(() => {})
        clearPhoto('background').catch(() => {})
        clearPhoto('cropped_undo').catch(() => {})
        clearPhoto('source_undo').catch(() => {})
        clearFileHandle().catch(() => {})
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
    // Phase 2 18a — `viewports` is the source of truth for persistence;
    // `viewport` mirror tracks it lockstep so subscribing to either
    // detects the same changes. Subscribing to `viewports` is the
    // canonical signal post-Phase-2.
    state.viewports !== prev.viewports ||
    state.viewport !== prev.viewport ||
    state.photoMeta !== prev.photoMeta ||
    state.cropMeta !== prev.cropMeta ||
    // P2 + P19 (May 7 2026) — per-snap-type gates + grid opacity persist
    // alongside the existing UI flags so operator settings survive reload.
    state.snapTypes !== prev.snapTypes ||
    state.gridOpacity !== prev.gridOpacity ||
    // Phase 2 18a — top-level app mode persists across reload.
    state.appMode !== prev.appMode ||
    // Phase 2 18a — Technical Drawing data persists (geometry + spec table).
    state.technicalLayers !== prev.technicalLayers ||
    state.specTable !== prev.specTable
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
// P45 POST-INIT BOOTSTRAP (Phase 2 18a, May 10 2026)
// Restore the persistent FileSystemFileHandle from IndexedDB on app boot.
// The handle is stored separately from PERSIST_KEYS (localStorage can't
// carry the handle object; IDB can via structured clone). If a handle is
// found AND permission is still granted, set it on the store so the next
// Save writes to the operator's prior save target silently. If permission
// is no longer granted OR no handle stored, the store stays with
// currentFileHandle: null and the next Save opens the picker fresh.
// Fire-and-forget; failures are silent (operator just gets the picker).
// ============================================================================
if (typeof window !== 'undefined') {
  loadFileHandle()
    .then(async (handle) => {
      if (!handle) return
      const ok = await verifyHandlePermission(handle)
      if (ok) {
        useAppStore.setState({
          currentFileHandle: handle,
          currentFileName: handle.name || null,
        })
      } else {
        // Permission was revoked between sessions — clear stale entry.
        await clearFileHandle().catch(() => {})
      }
    })
    .catch(() => {})
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
  // Step 17 partial-completion #2 (Gap 2) — clear session-scoped photo
  // undo backup slots on app load. Refresh-after-wipe = no recovery.
  // This is intentional: the _undo slots persist in IDB so a tab-crash
  // recovery would otherwise resurrect a backup the operator may not
  // expect to be there. Cleaner boundary: refresh wipes the backup; the
  // operator who wants to keep the backup just doesn't refresh.
  Promise.all([
    clearPhoto('cropped_undo').catch(() => {}),
    clearPhoto('source_undo').catch(() => {}),
  ])
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
