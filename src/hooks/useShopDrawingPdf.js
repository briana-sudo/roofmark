// ============================================================================
// useShopDrawingPdf.js — Phase 2 sub-step 18h (May 12 2026)
//
// React hook wrapping the pure pdfAsyncPipeline. Exposes state machine,
// progress, error, and auto-download on success. Components consume
// this rather than calling runShopDrawingPdf directly so phase
// transitions trigger re-renders.
//
// State machine:
//   idle → submitting → polling → fetching → done | error
//
// On done: auto-download via URL.createObjectURL + temporary <a>. The
// blob is also kept in state so future re-download (without a fresh
// proxy call) is cheap. Caller can fire reset() to clear.
// ============================================================================

import { useRef, useState, useCallback } from 'react'
import { runShopDrawingPdf } from '../utils/pdfAsyncPipeline'

const INITIAL = {
  phase: 'idle',     // 'idle' | 'submitting' | 'polling' | 'fetching' | 'done' | 'error'
  jobId: null,
  attempt: 0,
  elapsedSec: 0,
  warning: false,    // set true when poll passes the 90s threshold
  error: null,
  blob: null,
  blobUrl: null,     // populated on done so re-download is cheap
  filename: null,
}

/**
 * Trigger a browser download for a Blob via a temporary anchor element.
 * Returns the object URL used (caller responsible for revoke when
 * fully done — we keep it alive so re-download works without a fresh
 * proxy call).
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a)
  }, 0)
  return url
}

export function useShopDrawingPdf() {
  const [state, setState] = useState(INITIAL)
  // Capture last params for retry without re-deriving from store.
  const lastParamsRef = useRef(null)
  // Persist objectURL across renders so we can revoke on reset/unmount.
  const blobUrlRef = useRef(null)

  const onProgress = useCallback((evt) => {
    setState((prev) => {
      if (evt.phase === 'submitting')      return { ...prev, phase: 'submitting' }
      if (evt.phase === 'submitted')       return { ...prev, phase: 'polling', jobId: evt.jobId }
      if (evt.phase === 'polling')         return {
        ...prev,
        phase: 'polling',
        attempt: evt.attempt,
        elapsedSec: evt.elapsedSec,
      }
      if (evt.phase === 'polling-warning') return { ...prev, warning: true }
      if (evt.phase === 'polling-error')   return prev   // log only — no UI state change per attempt
      if (evt.phase === 'fetching')        return { ...prev, phase: 'fetching' }
      return prev
    })
  }, [])

  const run = useCallback(async ({ data, scriptSource, filename }) => {
    // Revoke any prior blob URL — fresh run discards stale download
    if (blobUrlRef.current) {
      try { URL.revokeObjectURL(blobUrlRef.current) } catch (_) {}
      blobUrlRef.current = null
    }
    lastParamsRef.current = { data, scriptSource, filename }
    setState({ ...INITIAL, phase: 'submitting', filename })
    try {
      const blob = await runShopDrawingPdf({
        data, scriptSource, filename, onProgress,
      })
      const url = downloadBlob(blob, filename)
      blobUrlRef.current = url
      setState({
        ...INITIAL,
        phase: 'done',
        blob,
        blobUrl: url,
        filename,
      })
      return blob
    } catch (err) {
      setState((prev) => ({
        ...prev,
        phase: 'error',
        error: (err && err.message) || String(err),
      }))
      throw err
    }
  }, [onProgress])

  const retry = useCallback(() => {
    if (!lastParamsRef.current) return Promise.resolve(null)
    return run(lastParamsRef.current)
  }, [run])

  const redownload = useCallback(() => {
    if (!blobUrlRef.current || !state.filename) return
    const a = document.createElement('a')
    a.href = blobUrlRef.current
    a.download = state.filename
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a) }, 0)
  }, [state.filename])

  const reset = useCallback(() => {
    if (blobUrlRef.current) {
      try { URL.revokeObjectURL(blobUrlRef.current) } catch (_) {}
      blobUrlRef.current = null
    }
    lastParamsRef.current = null
    setState(INITIAL)
  }, [])

  return { state, run, retry, redownload, reset }
}
