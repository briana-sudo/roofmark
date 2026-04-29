/**
 * Single-slot IndexedDB photo store for the canvas background.
 *
 * Why IndexedDB and not localStorage?
 *   Spec §15 originally said "canvas background image is NOT saved to
 *   localStorage — too large." That was correct for localStorage's ~5 MB
 *   per-origin quota — a typical 4032×3024 inspection JPG base64-encoded
 *   easily exceeds that. But the operator test on Step 8 surfaced that
 *   "no persistence at all" is unacceptable UX: refresh kills the photo
 *   while the layers/shapes drawn over it persist, leaving an orphan
 *   markup. IndexedDB has a much larger quota (gigabytes on most
 *   browsers; quota is per-origin and visible via navigator.storage)
 *   and is the right home for binary/heavy data.
 *
 * Why a hand-rolled module instead of the catalog's "IndexedDB Photo
 * Store" component (roof-inspector / flat-roof-inspector)?
 *   Per Rule 19 — the inspector catalog entry stores a KEYED COLLECTION
 *   of inspection photos per scope/index, structurally different from
 *   RoofMark's single canvas-background slot. Porting verbatim would
 *   require shoehorning RoofMark's "one slot, one photo at a time"
 *   model into a multi-key array model. ~40 lines hand-rolled here is
 *   simpler and matches RoofMark's actual storage semantics.
 *
 *   This module is itself a Component Catalog candidate (single-slot
 *   IDB store for a UI-only large blob) — flag for catalog write-up
 *   when a second project needs the same shape.
 *
 * API:
 *   await savePhoto(dataURL)   — persist a data-URL string under the
 *                                fixed key 'background'
 *   await loadPhoto()           — read the stored data-URL or null if
 *                                absent / IDB unavailable
 *   await clearPhoto()          — remove the stored entry
 *
 * All three resolve cleanly when IndexedDB is unavailable (Node, SSR,
 * older browsers) — savePhoto / clearPhoto become no-ops; loadPhoto
 * returns null. Failures (quota exceeded, transaction abort) reject;
 * callers should treat the photo as unsaved on reject and surface a
 * user-visible warning when appropriate.
 */

const DB_NAME = 'roofmark'
const DB_VERSION = 1
const STORE = 'blobs'
const KEY_BACKGROUND = 'background'

function isAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function savePhoto(dataURL) {
  if (!isAvailable() || typeof dataURL !== 'string') return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(dataURL, KEY_BACKGROUND)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function loadPhoto() {
  if (!isAvailable()) return null
  let db
  try { db = await openDB() } catch { return null }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(KEY_BACKGROUND)
    req.onsuccess = () => { db.close(); resolve(req.result || null) }
    req.onerror = () => { db.close(); resolve(null) }
  })
}

export async function clearPhoto() {
  if (!isAvailable()) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(KEY_BACKGROUND)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}
