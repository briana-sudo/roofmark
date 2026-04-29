/**
 * Multi-slot IndexedDB photo store for the canvas background.
 *
 * Section 7.A — dual-slot model:
 *   key 'cropped' — current cropped working photo (the one the canvas
 *                   renders). Set by the crop-modal Confirm action.
 *   key 'source'  — original uploaded photo, preserved so the operator
 *                   can re-crop without re-uploading.
 *   key 'background' — LEGACY (Step 8 single-slot). Read-only at startup
 *                   for migration into the new 'cropped' slot.
 *
 * Why IndexedDB and not localStorage?
 *   Spec §15 originally said "canvas background image is NOT saved to
 *   localStorage — too large." That was correct for localStorage's ~5 MB
 *   per-origin quota — a typical 4032×3024 inspection JPG base64-encoded
 *   easily exceeds that. IndexedDB has a much larger quota (gigabytes on
 *   most browsers) and is the right home for binary/heavy data.
 *
 * Step 12 partial-completion fix carried forward: this module is itself a
 * Component Catalog candidate (multi-slot IDB store for UI-only large
 * blobs) — flag for catalog write-up when a second project needs the
 * same shape.
 *
 * API:
 *   await savePhoto(dataURL, key='cropped')   — persist a data-URL
 *   await loadPhoto(key='cropped')             — read or null if absent
 *   await clearPhoto(key='cropped')            — remove the entry
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
const DEFAULT_KEY = 'cropped'

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

export async function savePhoto(dataURL, key = DEFAULT_KEY) {
  if (!isAvailable() || typeof dataURL !== 'string') return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(dataURL, key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function loadPhoto(key = DEFAULT_KEY) {
  if (!isAvailable()) return null
  let db
  try { db = await openDB() } catch { return null }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => { db.close(); resolve(req.result || null) }
    req.onerror = () => { db.close(); resolve(null) }
  })
}

export async function clearPhoto(key = DEFAULT_KEY) {
  if (!isAvailable()) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}
