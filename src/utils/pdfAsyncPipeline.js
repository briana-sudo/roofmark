// ============================================================================
// pdfAsyncPipeline.js — Phase 2 sub-step 18h (May 12 2026)
//
// Submit → poll → fetch async PDF generation pipeline against the KCC
// Netlify Proxy. Mirrors shingle-roof-condition's working runPdf() at
// index.html:1206-1372 — proven in production for ~5 months. Same poll
// cadence, jitter, cap, and warning thresholds.
//
// Locked decisions:
//   - D7: 4 s nominal poll, ±0.5 s jitter, 75-poll cap (~5 min)
//   - D7: retry-without-replay on transient poll errors (don't abort)
//   - D7: server-side 5-min deadman is independent of client cap
//   - D2: v1.1 script embedded in prompt via FF5B markers; proxy
//          extracts + uploads to Anthropic Files API at submit time
//
// Pure async function: no React, no DOM, no store. Caller (the
// useShopDrawingPdf hook) handles state machine + UI.
// ============================================================================

import {
  ASYNC_SUBMIT_URL,
  ASYNC_STATUS_URL,
  ASYNC_FETCH_URL,
} from './kccProxy'

// FF5B marker pair — must match exactly what the proxy looks for in
// claude-async-background.js extractFF5bScript (lines 47-48). Both
// markers MUST appear as Python comment lines inside the script body
// AND inside the ```python fenced block in the prompt.
export const FF5B_START = '# <<FF5B_TEMPLATE_START>>'
export const FF5B_END   = '# <<FF5B_TEMPLATE_END>>'

// Anthropic Messages API config
export const PDF_MODEL = 'claude-sonnet-4-20250514'
export const PDF_MAX_TOKENS = 8000
export const PDF_BETA = 'code-execution-2025-08-25'

// Poll cadence per shingle-roof-condition precedent
export const POLL_BASE_MS = 4000
export const POLL_JITTER_MS = 500
export const POLL_MAX = 75               // ~5 min total
export const POLL_WARN_AT_SEC = 90       // log + onProgress warn

/**
 * Compose the prompt body. Embeds the v1.1 script source between the
 * FF5B markers inside a ```python fenced block. The proxy's
 * extractFF5bScript will lift the script out, upload to Anthropic Files
 * API, and rewrite messages[0].content to use a container_upload
 * reference — keeping the AI's tool-call output to ~50 bytes.
 *
 * The JSON payload (RoofMark export) is embedded as a fenced ```json
 * block AFTER the Python script. The execution preamble instructs the
 * sandbox to read both and run.
 *
 * @param {string} scriptSource - the full v1.1 Python script source
 * @param {Object} data         - v1.1 JSON payload (specTable + layers + v1.1 fields)
 * @param {string} filename     - output filename for v1.1 (matches D8 pattern)
 * @returns {string} - prompt content for messages[0].content
 */
export function buildPdfPrompt(scriptSource, data, filename) {
  const jsonText = JSON.stringify(data, null, 2)
  // Wrap the script in the marker pair. The markers are comment lines
  // so they're harmless inside Python. The proxy locates them inside
  // the ```python fence and extracts the script body verbatim.
  const lines = [
    'Run the locked KCC shop drawing template against the RoofMark JSON',
    'export below. The Python script is uploaded via Anthropic Files API',
    '(container_upload). Save the JSON to $INPUT_DIR/data.json, then run',
    '`python3 $INPUT_DIR/gen.py data.json --out-dir $OUTPUT_DIR`. Return',
    'ONLY the produced PDF file. No commentary.',
    '',
    'CRITICAL: DO NOT MODIFY THE SCRIPT. It is the locked v1.1 template;',
    'any edit breaks brand fidelity + regression guarantees. Pass through',
    'verbatim and execute.',
    '',
    'Expected output: a single PDF written to $OUTPUT_DIR/' + filename + '.',
    '',
    '```python',
    FF5B_START,
    scriptSource,
    FF5B_END,
    '```',
    '',
    'JSON input (write this to $INPUT_DIR/data.json before running the script):',
    '',
    '```json',
    jsonText,
    '```',
  ]
  return lines.join('\n')
}

/**
 * Compose the submit-endpoint request body. Mirrors shingle's payload
 * shape exactly (model + max_tokens + tools + messages + filename).
 */
export function buildSubmitPayload(prompt, filename) {
  return {
    model: PDF_MODEL,
    max_tokens: PDF_MAX_TOKENS,
    tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
    messages: [{ role: 'user', content: prompt }],
    filename,
  }
}

/**
 * Compute jitter delay around POLL_BASE_MS within ±POLL_JITTER_MS.
 * Exported for test injection (caller can stub Math.random or wrap).
 */
export function pollDelay(base = POLL_BASE_MS, jitter = POLL_JITTER_MS, rand = Math.random) {
  return base - jitter + rand() * (2 * jitter)
}

/**
 * Sleep helper. Promise-based setTimeout, abortable via the optional
 * AbortSignal (not currently used but plumbed for future cancel UI).
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      }, { once: true })
    }
  })
}

/**
 * Submit a PDF-generation job. Returns the job_id.
 *
 * Caller's onProgress receives:
 *   { phase: 'submitting' }     — before fetch
 *   { phase: 'submitted', jobId } — on success
 */
async function submitJob(prompt, filename, onProgress, fetchImpl = fetch) {
  onProgress && onProgress({ phase: 'submitting' })
  const payload = buildSubmitPayload(prompt, filename)
  const res = await fetchImpl(ASYNC_SUBMIT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': PDF_BETA,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    let detail = ''
    try { const j = await res.json(); detail = (j && (j.error || j.detail)) || '' }
    catch (_) { detail = res.statusText }
    throw new Error(`Submit failed: HTTP ${res.status} ${detail}`.trim())
  }
  const body = await res.json()
  if (!body || typeof body.job_id !== 'string') {
    throw new Error('Submit response missing job_id')
  }
  onProgress && onProgress({ phase: 'submitted', jobId: body.job_id })
  return body.job_id
}

/**
 * Poll the status endpoint until the job is done or errored, or until
 * the poll cap is reached. Returns the final status entry.
 *
 * Caller's onProgress receives:
 *   { phase: 'polling', attempt, elapsedSec, status }  — per successful poll
 *   { phase: 'polling-warning', elapsedSec }            — once at 90s threshold
 *   { phase: 'polling-error', attempt, error }          — per failed poll (retries)
 */
async function pollJob(jobId, onProgress, fetchImpl = fetch, rand = Math.random) {
  const startTs = Date.now()
  let warned = false
  for (let attempt = 0; attempt < POLL_MAX; attempt++) {
    const delay = pollDelay(POLL_BASE_MS, POLL_JITTER_MS, rand)
    await sleep(delay)
    const elapsedSec = (Date.now() - startTs) / 1000
    if (!warned && elapsedSec >= POLL_WARN_AT_SEC) {
      warned = true
      onProgress && onProgress({ phase: 'polling-warning', elapsedSec })
    }
    let st
    try {
      const r = await fetchImpl(`${ASYNC_STATUS_URL}?id=${encodeURIComponent(jobId)}`)
      if (!r.ok) {
        onProgress && onProgress({
          phase: 'polling-error', attempt, error: `HTTP ${r.status}`,
        })
        continue
      }
      st = await r.json()
    } catch (e) {
      onProgress && onProgress({
        phase: 'polling-error', attempt, error: (e && e.message) || String(e),
      })
      continue
    }
    onProgress && onProgress({
      phase: 'polling',
      attempt: attempt + 1,
      elapsedSec,
      status: st && st.status,
    })
    if (st && (st.status === 'done' || st.status === 'error')) {
      return st
    }
    // status === 'pending' — keep polling
  }
  throw new Error(`Poll cap reached (${POLL_MAX} attempts, ~${POLL_MAX * POLL_BASE_MS / 1000}s)`)
}

/**
 * Fetch the produced PDF bytes. Returns a Blob.
 *
 * Caller's onProgress receives:
 *   { phase: 'fetching' }
 */
async function fetchJob(jobId, onProgress, fetchImpl = fetch) {
  onProgress && onProgress({ phase: 'fetching' })
  const r = await fetchImpl(`${ASYNC_FETCH_URL}?id=${encodeURIComponent(jobId)}`)
  if (!r.ok) {
    let detail = ''
    try { const j = await r.json(); detail = (j && j.error) || '' } catch (_) {}
    throw new Error(`Fetch failed: HTTP ${r.status} ${detail}`.trim())
  }
  const blob = await r.blob()
  if (!blob || blob.size === 0) {
    throw new Error('Fetch returned empty body')
  }
  return blob
}

/**
 * Run the full submit→poll→fetch pipeline. Resolves to the PDF Blob.
 *
 * @param {Object} params
 * @param {Object} params.data            - v1.1 JSON payload
 * @param {string} params.scriptSource    - v1.1 Python script source
 * @param {string} params.filename        - output filename
 * @param {Function} [params.onProgress]  - phase callback
 * @param {Function} [params.fetchImpl]   - injectable fetch for tests
 * @param {Function} [params.rand]        - injectable Math.random for tests
 * @returns {Promise<Blob>}
 */
export async function runShopDrawingPdf({
  data,
  scriptSource,
  filename,
  onProgress,
  fetchImpl = (typeof fetch !== 'undefined' ? fetch : null),
  rand = Math.random,
}) {
  if (!fetchImpl) throw new Error('No fetch implementation available')
  if (!data || typeof data !== 'object') throw new Error('Missing data')
  if (!scriptSource || typeof scriptSource !== 'string') {
    throw new Error('Missing scriptSource')
  }
  if (!filename || typeof filename !== 'string') throw new Error('Missing filename')

  const prompt = buildPdfPrompt(scriptSource, data, filename)
  const jobId  = await submitJob(prompt, filename, onProgress, fetchImpl)
  const final  = await pollJob(jobId, onProgress, fetchImpl, rand)

  if (final.status === 'error') {
    const detail = (final && final.error_detail) || '(no detail)'
    throw new Error(`PDF generation failed: ${detail}`)
  }
  if (final.status !== 'done') {
    throw new Error(`Unexpected final status: ${final && final.status}`)
  }
  return fetchJob(jobId, onProgress, fetchImpl)
}
