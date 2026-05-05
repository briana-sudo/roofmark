/**
 * Job Registry integration — Step 15 of Kickoff Spec §14.
 *
 * Reads the KCC Job Registry Google Sheet (read-only) and surfaces the
 * jobs as searchable picker options. Authentication is via Google
 * Identity Services (GIS) implicit token flow with the same client_id
 * used by roof-inspector / flat-roof-inspector, so signing in once
 * grants access across the KCC app suite (token persisted in
 * localStorage under `kcc_token` / `kcc_token_expiry`).
 *
 * Per Rule 18: client_id is fine in client code (it's NOT a secret;
 * GIS implicit flow doesn't use a client_secret).
 *
 * Per Rule 19 / Rule 24: this module reads the sheet's header row and
 * resolves canonical field names (jobId, address, owner, status,
 * scope, crew) via a lookup table of common aliases. NEVER hardcoded
 * column letters or indices. If a canonical field can't be resolved,
 * the picker degrades gracefully (operator sees missing data as `—`).
 *
 * Per Working Standards Rule 9 + Rule 10: this module READS only —
 * never writes to or replaces the registry sheet.
 */

const CLIENT_ID = '253782351183-8pgd31f0ttse239isq7d0velvd5gcknb.apps.googleusercontent.com'
const SHEETS_REGISTRY_ID = '1cElx3edOb_3dNeLYy6f-mLiyi6zghsWoCGnPLLWr3Rc'
const TAB_NAME = 'Job Registry'  // verified from roof-inspector index.html (the actual tab name; Brian's prompt called it "Registry")
const FETCH_RANGE = `${TAB_NAME}!A1:BJ`  // BJ matches roof-inspector's range; covers the full registry width
const SCOPE_READONLY = 'https://www.googleapis.com/auth/spreadsheets.readonly'

const TOKEN_KEY = 'kcc_token'
const TOKEN_EXPIRY_KEY = 'kcc_token_expiry'

const FIELD_ALIASES = {
  jobId:   ['Job ID', 'JobID', 'Job#', 'Job Number', 'ID'],
  address: ['Address', 'Street Address', 'Property Address', 'Site Address'],
  owner:   ['Owner', 'Client', 'Customer', 'Owner Name', 'Client Name'],
  status:  ['Status', 'Job Status', 'Stage'],
  scope:   ['Scope', 'Trade', 'Service', 'Job Scope', 'Scopes'],
  crew:    ['Crew', 'Crew Lead', 'Foreman', 'Lead Crew', 'Assigned Crew'],
}

// ---- Pure helpers (mirrored verbatim in test/step-15-functional.html, 32/32 PASS) ----

export function buildHeaderIndex(headerCells) {
  const map = new Map()
  ;(headerCells || []).forEach((cell, idx) => {
    if (typeof cell !== 'string') return
    const key = cell.trim().toLowerCase()
    if (key && !map.has(key)) map.set(key, idx)
  })
  return map
}

export function findHeaderRow(rows) {
  const probe = ['id', 'job', 'address', 'name', 'status', 'scope', 'crew', 'owner', 'client', 'foreman']
  let bestIdx = -1, bestScore = -1
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i] || []
    const nonEmpty = row.filter((c) => typeof c === 'string' && c.trim()).length
    if (nonEmpty < 3) continue
    const lc = row.map((c) => (typeof c === 'string' ? c.toLowerCase() : ''))
    const hits = probe.filter((p) => lc.some((c) => c.includes(p))).length
    const shortish = row.filter((c) => typeof c === 'string' && c.length > 0 && c.length < 40).length
    const score = hits * 10 + shortish
    if (score > bestScore) { bestScore = score; bestIdx = i }
  }
  return bestIdx
}

export function resolveCanonicalField(headerIndex, aliases) {
  for (const a of aliases) {
    const key = a.toLowerCase()
    if (headerIndex.has(key)) return headerIndex.get(key)
  }
  return -1
}

export function buildFieldMap(headerIndex) {
  const out = {}
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    out[canonical] = resolveCanonicalField(headerIndex, aliases)
  }
  return out
}

export function buildJobOptions(rows, headerRowIdx, fieldMap) {
  const cellOr = (row, idx, fallback = '') => (idx >= 0 && row[idx] != null) ? String(row[idx]).trim() : fallback
  const out = []
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] || []
    const jobId = cellOr(row, fieldMap.jobId)
    const address = cellOr(row, fieldMap.address)
    const owner = cellOr(row, fieldMap.owner)
    const status = cellOr(row, fieldMap.status)
    const scope = cellOr(row, fieldMap.scope)
    const crew = cellOr(row, fieldMap.crew)
    if (!jobId && !address) continue
    out.push({ jobId, address, owner, status, scope, crew, _rawRow: row })
  }
  return out
}

export function filterJobs(jobs, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return jobs
  return jobs.filter((j) => {
    const haystack = [j.jobId, j.address, j.owner].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(q)
  })
}

export function splitMultiValue(value) {
  if (!value) return []
  return String(value)
    .split(/[/,+&]| and /i)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---- Token storage (mirrors roof-inspector / flat-roof-inspector keys) ----

export function readStoredToken() {
  if (typeof localStorage === 'undefined') return null
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    const expiry = parseInt(localStorage.getItem(TOKEN_EXPIRY_KEY) || '0', 10)
    if (!token || !Number.isFinite(expiry)) return null
    // 60s buffer so we don't hand back a token about to expire
    if (Date.now() >= expiry - 60_000) return null
    return { accessToken: token, expiresAt: expiry }
  } catch { return null }
}

export function writeStoredToken(accessToken, expiresAt) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(TOKEN_KEY, accessToken)
    localStorage.setItem(TOKEN_EXPIRY_KEY, String(expiresAt))
  } catch { /* quota or private mode — token still works in memory */ }
}

export function clearStoredToken() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(TOKEN_EXPIRY_KEY)
  } catch { /* ignore */ }
}

// ---- Network helpers ----

export function fetchWithTimeout(url, options, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null
    const opts = Object.assign({}, options || {})
    if (ctrl) opts.signal = ctrl.signal
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (ctrl) { try { ctrl.abort() } catch { /* ignore */ } }
      const e = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)
      e.timeout = true; e.ms = timeoutMs
      reject(e)
    }, timeoutMs)
    fetch(url, opts).then((r) => {
      clearTimeout(timer)
      if (timedOut) return
      if (!r.ok) {
        return r.text().then((txt) => {
          const e = new Error(`HTTP ${r.status} ${r.statusText || ''}`)
          e.status = r.status; e.statusText = r.statusText || ''; e.bodyText = (txt || '').slice(0, 300)
          reject(e)
        }, () => {
          const e = new Error(`HTTP ${r.status}`)
          e.status = r.status; reject(e)
        })
      }
      resolve(r)
    }).catch((e) => {
      clearTimeout(timer)
      if (timedOut) return
      reject(e)
    })
  })
}

// ---- Auth + fetch ----

export function isGoogleLoaded() {
  return typeof window !== 'undefined' && typeof window.google !== 'undefined' && window.google.accounts
}

/**
 * Trigger the Google Identity Services token flow. Returns a promise
 * that resolves with `{ accessToken, expiresAt }` or rejects on user
 * dismissal / network error.
 */
export function requestAccessToken() {
  return new Promise((resolve, reject) => {
    if (!isGoogleLoaded()) {
      reject(new Error('Google Identity Services script not loaded yet — try again in a moment.'))
      return
    }
    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE_READONLY,
        callback: (response) => {
          if (response.error) {
            reject(new Error(`Sign in failed: ${response.error}`))
            return
          }
          const expiresAt = Date.now() + (response.expires_in * 1000)
          writeStoredToken(response.access_token, expiresAt)
          resolve({ accessToken: response.access_token, expiresAt })
        },
      })
      client.requestAccessToken()
    } catch (e) {
      reject(e)
    }
  })
}

/**
 * Fetch the registry tab and parse it into canonical job options.
 * Returns `{ headers, headerIndex, fieldMap, rows, jobs, headerRowIdx }`.
 */
export async function fetchRegistry(accessToken) {
  if (!accessToken) throw new Error('Not signed in')
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_REGISTRY_ID}/values/${encodeURIComponent(FETCH_RANGE)}`
  const resp = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 20_000)
  const data = await resp.json()
  const rows = data.values || []
  const headerRowIdx = findHeaderRow(rows)
  if (headerRowIdx < 0) {
    throw new Error('Could not locate header row in the registry sheet (first 5 rows scanned).')
  }
  const headers = rows[headerRowIdx]
  const headerIndex = buildHeaderIndex(headers)
  const fieldMap = buildFieldMap(headerIndex)
  // Diagnostic: log any unresolved canonical fields so the operator (or
  // Brian, watching console) can see immediately if a column rename is
  // needed.
  const unresolved = Object.entries(fieldMap).filter(([, idx]) => idx < 0).map(([k]) => k)
  if (unresolved.length) {
    console.warn('[registry] Unresolved canonical fields (no matching header alias):', unresolved,
      '— available headers:', headers)
  }
  const jobs = buildJobOptions(rows, headerRowIdx, fieldMap)
  return { headers, headerIndex, fieldMap, rows, jobs, headerRowIdx }
}

export const REGISTRY_CONSTANTS = {
  CLIENT_ID,
  SHEETS_REGISTRY_ID,
  TAB_NAME,
  FETCH_RANGE,
  SCOPE_READONLY,
  TOKEN_KEY,
  TOKEN_EXPIRY_KEY,
}
