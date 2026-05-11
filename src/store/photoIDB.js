/**
 * Multi-slot IndexedDB store for the canvas background AND (Phase 2 18a)
 * the persistent FileSystemFileHandle for P45 Save / Save As.
 *
 * Section 7.A — dual-slot photo model:
 *   key 'cropped' — current cropped working photo (the one the canvas
 *                   renders). Set by the crop-modal Confirm action.
 *   key 'source'  — original uploaded photo, preserved so the operator
 *                   can re-crop without re-uploading.
 *   key 'background' — LEGACY (Step 8 single-slot). Read-only at startup
 *                   for migration into the new 'cropped' slot.
 *
 * Phase 2 18a (May 10 2026) — new 'fileHandles' store added alongside
 * the 'blobs' store. Single key 'projectSave' holds the operator's
 * persistent FileSystemFileHandle so Save can write silently to the
 * same target across browser sessions. DB_VERSION bumped 1 → 2.
 *
 * Why IndexedDB and not localStorage?
 *   Spec §15 originally said "canvas background image is NOT saved to
 *   localStorage — too large." That was correct for localStorage's ~5 MB
 *   per-origin quota — a typical 4032×3024 inspection JPG base64-encoded
 *   easily exceeds that. IndexedDB has a much larger quota (gigabytes on
 *   most browsers) and is the right home for binary/heavy data.
 *   File handles aren't large but they're non-JSON-serializable native
 *   browser objects — IDB's structured-clone storage handles them; JSON
 *   does not.
 *
 * Step 12 partial-completion fix carried forward: this module is itself a
 * Component Catalog candidate (multi-slot IDB store for UI-only large
 * blobs) — flag for catalog write-up when a second project needs the
 * same shape.
 *
 * Photo API:
 *   await savePhoto(dataURL, key='cropped')   — persist a data-URL
 *   await loadPhoto(key='cropped')             — read or null if absent
 *   await clearPhoto(key='cropped')            — remove the entry
 *
 * File handle API (Phase 2 18a):
 *   await saveFileHandle(handle)               — persist a FileSystemFileHandle
 *   await loadFileHandle()                     — read or null if absent
 *   await clearFileHandle()                    — remove the entry
 *
 * All resolve cleanly when IndexedDB is unavailable (Node, SSR, older
 * browsers) — saves / clears become no-ops; loads return null. Failures
 * (quota exceeded, transaction abort) reject; callers should treat the
 * data as unsaved on reject and surface a user-visible warning when
 * appropriate.
 */

const DB_NAME = 'roofmark'
const DB_VERSION = 2  // Phase 2 18a — bumped from 1 to add 'fileHandles' store
const STORE = 'blobs'
const FILE_HANDLE_STORE = 'fileHandles'
const FILE_HANDLE_KEY = 'projectSave'
const DEFAULT_KEY = 'cropped'

function isAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Existing 'blobs' store — preserved across DB upgrade from v1 → v2.
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      // Phase 2 18a — new 'fileHandles' store. Created during the v1 → v2
      // upgrade for operators with existing roofmark IDBs; created during
      // the initial v2 install for new operators.
      if (!db.objectStoreNames.contains(FILE_HANDLE_STORE)) {
        db.createObjectStore(FILE_HANDLE_STORE)
      }
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

// ============================================================================
// P45 file handle API (Phase 2 18a, May 10 2026) — persistent
// FileSystemFileHandle storage. IDB supports structured-clone serialization
// of FileSystemFileHandle objects natively; the handle survives across
// browser sessions as long as the operator hasn't explicitly revoked
// permission. On boot, useAppStore loads the handle + calls
// verifyHandlePermission to confirm it's still usable.
// ============================================================================
export async function saveFileHandle(handle) {
  if (!isAvailable() || !handle) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_HANDLE_STORE, 'readwrite')
    tx.objectStore(FILE_HANDLE_STORE).put(handle, FILE_HANDLE_KEY)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function loadFileHandle() {
  if (!isAvailable()) return null
  let db
  try { db = await openDB() } catch { return null }
  return new Promise((resolve) => {
    const tx = db.transaction(FILE_HANDLE_STORE, 'readonly')
    const req = tx.objectStore(FILE_HANDLE_STORE).get(FILE_HANDLE_KEY)
    req.onsuccess = () => { db.close(); resolve(req.result || null) }
    req.onerror = () => { db.close(); resolve(null) }
  })
}

export async function clearFileHandle() {
  if (!isAvailable()) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_HANDLE_STORE, 'readwrite')
    tx.objectStore(FILE_HANDLE_STORE).delete(FILE_HANDLE_KEY)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}
