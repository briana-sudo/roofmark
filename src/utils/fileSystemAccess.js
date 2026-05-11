// ============================================================================
// fileSystemAccess.js — P45 (Phase 2 sub-step 18a, May 10 2026)
//
// Thin wrapper around the File System Access API. Two paths:
//   1. Native (Chrome / Edge / desktop): window.showSaveFilePicker + the
//      FileSystemFileHandle.{createWritable, queryPermission, requestPermission}
//      flow. The handle is persistent across browser sessions when stored in
//      IndexedDB (see photoIDB.saveFileHandle).
//   2. Legacy (Safari / Firefox): falls back to the existing Blob +
//      <a download> click pattern (handled by the caller — useAppStore's
//      saveProjectAs action checks isFileSystemAccessSupported() first
//      and routes accordingly).
//
// Error contract (caller must handle):
//   pickSaveFile:
//     - returns null on user cancel (AbortError)
//     - throws 'FILE_SYSTEM_ACCESS_UNSUPPORTED' if API absent (caller
//       should check isFileSystemAccessSupported() before calling)
//     - re-throws on other errors
//   writeToHandle:
//     - throws 'FILE_HANDLE_REVOKED' if permission was revoked
//     - throws 'FILE_HANDLE_LOST' if file deleted/moved externally
//     - throws 'FILE_HANDLE_PERMISSION_DENIED' if re-request denied
//     - re-throws on other errors
//   verifyHandlePermission:
//     - returns true on 'granted' (cached) OR 'prompt' → 'granted' (re-request)
//     - returns false on 'denied' OR 'prompt' → still-denied
// ============================================================================

export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined'
    && typeof window.showSaveFilePicker === 'function'
}

export async function pickSaveFile({ suggestedName }) {
  if (!isFileSystemAccessSupported()) {
    throw new Error('FILE_SYSTEM_ACCESS_UNSUPPORTED')
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{
        description: 'RoofMark project',
        accept: { 'application/json': ['.json'] },
      }],
    })
    return handle
  } catch (err) {
    // User-initiated cancel — return null per spec contract.
    if (err && (err.name === 'AbortError' || err.message === 'The user aborted a request.')) {
      return null
    }
    throw err
  }
}

export async function writeToHandle(handle, contents) {
  if (!handle) throw new Error('FILE_HANDLE_REVOKED')
  // First try: write directly. If permission is still granted from a
  // prior session, this succeeds without prompting.
  try {
    const writable = await handle.createWritable()
    await writable.write(contents)
    await writable.close()
    return
  } catch (err) {
    // Permission lost — re-request and retry. Only retry once; on still-
    // denied we throw the permission error so the caller falls back to
    // Save As.
    const name = err?.name || ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      try {
        const perm = await handle.requestPermission({ mode: 'readwrite' })
        if (perm !== 'granted') {
          throw new Error('FILE_HANDLE_PERMISSION_DENIED', { cause: err })
        }
        // Retry write after re-grant
        const writable = await handle.createWritable()
        await writable.write(contents)
        await writable.close()
        return
      } catch (err2) {
        if (err2?.message === 'FILE_HANDLE_PERMISSION_DENIED') throw err2
        // Any other failure during re-request path treated as revoked.
        throw new Error('FILE_HANDLE_REVOKED', { cause: err2 })
      }
    }
    if (name === 'NotFoundError') {
      throw new Error('FILE_HANDLE_LOST', { cause: err })
    }
    // Unknown error — re-throw so caller surfaces it.
    throw err
  }
}

export async function verifyHandlePermission(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return false
  try {
    const cur = await handle.queryPermission({ mode: 'readwrite' })
    if (cur === 'granted') return true
    if (cur === 'denied') return false
    // 'prompt' — caller flow should re-request on first write. Per the
    // P45 boot bootstrap, we re-request here so the operator answers
    // the dialog once at session start instead of mid-save.
    if (typeof handle.requestPermission === 'function') {
      const next = await handle.requestPermission({ mode: 'readwrite' })
      return next === 'granted'
    }
    return false
  } catch {
    return false
  }
}
