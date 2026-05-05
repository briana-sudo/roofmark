import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  readStoredToken, requestAccessToken, fetchRegistry,
  filterJobs, splitMultiValue, clearStoredToken, isGoogleLoaded,
} from '../store/registry'

/**
 * JobRegistryPicker — Step 15 of Kickoff Spec §14.
 *
 * Three-stage popover anchored below the persistent header:
 *   Stage 1 — JOB: search-as-you-type input + filtered result list.
 *             Filter matches against jobId / address / owner.
 *             Result row shows: Job ID + Address + Owner + Status.
 *   Stage 2 — SCOPE: dropdown of scopes available for the picked job.
 *             Derived by splitting the row's Scope column on common
 *             delimiters (/  ,  +  &  " and ").
 *   Stage 3 — CREW: dropdown of crews available for the picked job.
 *             Derived from the row's Crew column the same way.
 *
 * After Crew is picked, the picker writes `{ jobId, address, owner,
 * status, scope, crew }` into `jobContext` and closes. The picker can
 * be cancelled at any stage via Escape or click-outside.
 *
 * Auth: opens with a "Sign in to load Job Registry" call-to-action if
 * no valid Google token is present. Token persists in localStorage
 * under the same `kcc_token` / `kcc_token_expiry` keys used by the
 * inspector apps so signing in once carries across the KCC suite.
 *
 * Per Rule 28: every affordance here is a visible button or input —
 * no hidden gestures.
 */
export default function JobRegistryPicker() {
  const registry = useAppStore((s) => s.registry)
  const closeJobPicker = useAppStore((s) => s.closeJobPicker)
  const setPickerStage = useAppStore((s) => s.setPickerStage)
  const setPendingPick = useAppStore((s) => s.setPendingPick)
  const patchRegistry = useAppStore((s) => s.patchRegistry)
  const setRegistryAuth = useAppStore((s) => s.setRegistryAuth)
  const clearRegistryAuth = useAppStore((s) => s.clearRegistryAuth)
  const setJob = useAppStore((s) => s.setJob)

  const wrapRef = useRef(null)
  const searchInputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [busyMsg, setBusyMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  // Click-outside / Escape closes the picker. Defer the document
  // listener via setTimeout(0) so the same click that opens the menu
  // doesn't immediately close it (Step 9 ContextMenu pattern).
  useEffect(() => {
    if (!registry.pickerOpen) return
    const onDocMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) closeJobPicker()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') closeJobPicker()
    }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDown, true)
      document.addEventListener('keydown', onKey, true)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDocMouseDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [registry.pickerOpen, closeJobPicker])

  // On open, hydrate token from localStorage if present, then load
  // registry if we have a valid token + no jobs cached yet.
  useEffect(() => {
    if (!registry.pickerOpen) return
    const stored = readStoredToken()
    if (stored && stored.accessToken !== registry.accessToken) {
      setRegistryAuth(stored.accessToken, stored.expiresAt)
    }
  }, [registry.pickerOpen, registry.accessToken, setRegistryAuth])

  useEffect(() => {
    if (!registry.pickerOpen) return
    if (!registry.accessToken) return
    if (registry.jobs.length > 0) return // already loaded
    if (registry.loadingState === 'fetching') return
    let cancelled = false
    patchRegistry({ loadingState: 'fetching', error: null })
    fetchRegistry(registry.accessToken).then((res) => {
      if (cancelled) return
      patchRegistry({
        headers: res.headers,
        headerIndex: res.headerIndex,
        fieldMap: res.fieldMap,
        rows: res.rows,
        jobs: res.jobs,
        loadingState: 'ready',
        error: null,
        fetchedAt: Date.now(),
      })
    }).catch((e) => {
      if (cancelled) return
      // If the token is rejected by Google (401), clear it so the operator
      // can re-sign-in.
      if (e.status === 401 || /unauthorized|401/i.test(String(e.message))) {
        clearStoredToken()
        clearRegistryAuth()
      }
      patchRegistry({ loadingState: 'error', error: e.message || String(e) })
      setErrorMsg(e.message || String(e))
    })
    return () => { cancelled = true }
  }, [registry.pickerOpen, registry.accessToken, registry.jobs.length, registry.loadingState, patchRegistry, clearRegistryAuth])

  // Autofocus the search input when the picker opens at the Job stage.
  useEffect(() => {
    if (registry.pickerOpen && registry.pickerStage === 'job' && registry.loadingState === 'ready') {
      searchInputRef.current?.focus()
    }
  }, [registry.pickerOpen, registry.pickerStage, registry.loadingState])

  const filteredJobs = useMemo(
    () => filterJobs(registry.jobs, query),
    [registry.jobs, query]
  )

  // Hooks must run unconditionally before any early return — keep
  // useMemo calls for scopeOptions / crewOptions here, ABOVE the
  // pickerOpen guard, so React's hook order stays stable across renders.
  const scopeOptions = useMemo(() => {
    if (!registry.pendingPick?.job) return []
    const opts = splitMultiValue(registry.pendingPick.job.scope)
    return opts.length ? opts : ['(no scope set)']
  }, [registry.pendingPick])

  const crewOptions = useMemo(() => {
    if (!registry.pendingPick?.job) return []
    const opts = splitMultiValue(registry.pendingPick.job.crew)
    return opts.length ? opts : ['(no crew set)']
  }, [registry.pendingPick])

  if (!registry.pickerOpen) return null

  const onSignIn = async () => {
    setBusyMsg('Opening Google sign-in…')
    setErrorMsg('')
    try {
      if (!isGoogleLoaded()) {
        setErrorMsg('Google sign-in script is still loading. Try again in a moment.')
        setBusyMsg('')
        return
      }
      const { accessToken, expiresAt } = await requestAccessToken()
      setRegistryAuth(accessToken, expiresAt)
      setBusyMsg('')
    } catch (e) {
      setBusyMsg('')
      setErrorMsg(e.message || String(e))
    }
  }

  const onSignOut = () => {
    clearStoredToken()
    clearRegistryAuth()
    patchRegistry({ headers: null, headerIndex: null, fieldMap: null, rows: [], jobs: [], loadingState: 'idle', error: null })
  }

  const onPickJob = (job) => {
    setPendingPick({ job })
    setPickerStage('scope')
  }

  const onPickScope = (scope) => {
    setPendingPick({ ...registry.pendingPick, scope })
    setPickerStage('crew')
  }

  const onPickCrew = (crew) => {
    const job = registry.pendingPick?.job
    if (!job) return
    const isPlaceholderScope = registry.pendingPick.scope?.startsWith?.('(no scope')
    const isPlaceholderCrew = crew?.startsWith?.('(no crew')
    setJob({
      jobId: job.jobId,
      address: job.address,
      owner: job.owner,
      status: job.status,
      scope: isPlaceholderScope ? '' : registry.pendingPick.scope,
      crew: isPlaceholderCrew ? '' : crew,
    })
    closeJobPicker()
  }

  const onBack = () => {
    if (registry.pickerStage === 'scope') setPickerStage('job')
    else if (registry.pickerStage === 'crew') setPickerStage('scope')
  }

  // ---- Render ----
  return (
    <div className="job-picker" ref={wrapRef} role="dialog" aria-label="Job Registry picker" data-testid="job-picker">
      <div className="job-picker-header">
        <span className="job-picker-title">
          {registry.pickerStage === 'job' && 'Select a job'}
          {registry.pickerStage === 'scope' && `Scope for ${registry.pendingPick?.job?.jobId || ''}`}
          {registry.pickerStage === 'crew' && `Crew for ${registry.pendingPick?.scope || ''}`}
        </span>
        {registry.pickerStage !== 'job' && (
          <button type="button" className="btn-panel-action" onClick={onBack} data-testid="job-picker-back">
            ← Back
          </button>
        )}
        <button type="button" className="btn-panel-action" onClick={closeJobPicker} data-testid="job-picker-close" title="Close (Esc)">
          ✕
        </button>
      </div>

      {!registry.accessToken && (
        <div className="job-picker-body job-picker-empty">
          <div style={{ marginBottom: 10 }}>
            Sign in with your KCC Google account to load the Job Registry.
            <br /><span style={{ fontSize: 11, color: 'var(--rm-fg-dim)' }}>
              Reuses the same sign-in as the inspection apps; read-only access.
            </span>
          </div>
          <button
            type="button"
            className="btn-panel-action btn-add"
            onClick={onSignIn}
            data-testid="job-picker-signin"
          >
            {busyMsg || 'Sign in with Google'}
          </button>
          {errorMsg && <div className="job-picker-error" role="alert">{errorMsg}</div>}
        </div>
      )}

      {registry.accessToken && registry.loadingState === 'fetching' && (
        <div className="job-picker-body job-picker-empty">
          Loading Job Registry…
        </div>
      )}

      {registry.accessToken && registry.loadingState === 'error' && (
        <div className="job-picker-body job-picker-empty">
          <div className="job-picker-error" role="alert">{registry.error}</div>
          <button
            type="button"
            className="btn-panel-action"
            onClick={() => patchRegistry({ jobs: [], loadingState: 'idle', error: null })}
            data-testid="job-picker-retry"
            style={{ marginTop: 8 }}
          >
            Retry
          </button>
        </div>
      )}

      {registry.pickerStage === 'job' && registry.loadingState === 'ready' && (
        <>
          <div className="job-picker-search-row">
            <input
              ref={searchInputRef}
              type="text"
              className="job-picker-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Job ID, address, owner…"
              spellCheck={false}
              autoComplete="off"
              data-testid="job-picker-search"
            />
            <button
              type="button"
              className="btn-panel-action job-picker-signout"
              onClick={onSignOut}
              title="Sign out (clears stored token)"
              data-testid="job-picker-signout"
            >
              Sign out
            </button>
          </div>
          <ul className="job-picker-list" role="listbox" data-testid="job-picker-list">
            {filteredJobs.length === 0 && (
              <li className="job-picker-empty">
                {query ? `No jobs match "${query}".` : 'No jobs in the registry.'}
              </li>
            )}
            {filteredJobs.slice(0, 200).map((j) => (
              <li
                key={j.jobId || j.address}
                className="job-picker-row"
                onMouseDown={(e) => { e.preventDefault(); onPickJob(j) }}
                data-job-id={j.jobId}
              >
                <span className="job-picker-row-id">{j.jobId || '—'}</span>
                <span className="job-picker-row-addr">{j.address || '—'}</span>
                <span className="job-picker-row-owner">{j.owner || ''}</span>
                <span className={`job-picker-row-status status-${(j.status || '').toLowerCase().replace(/\s+/g, '-')}`}>
                  {j.status || ''}
                </span>
              </li>
            ))}
            {filteredJobs.length > 200 && (
              <li className="job-picker-empty">
                Showing first 200 of {filteredJobs.length} matches — refine search to narrow.
              </li>
            )}
          </ul>
        </>
      )}

      {registry.pickerStage === 'scope' && (
        <ul className="job-picker-list job-picker-stage-list" role="listbox" data-testid="job-picker-scope-list">
          {scopeOptions.map((s) => (
            <li
              key={s}
              className="job-picker-row job-picker-stage-row"
              onMouseDown={(e) => { e.preventDefault(); onPickScope(s) }}
              data-scope={s}
            >
              {s}
            </li>
          ))}
        </ul>
      )}

      {registry.pickerStage === 'crew' && (
        <ul className="job-picker-list job-picker-stage-list" role="listbox" data-testid="job-picker-crew-list">
          {crewOptions.map((c) => (
            <li
              key={c}
              className="job-picker-row job-picker-stage-row"
              onMouseDown={(e) => { e.preventDefault(); onPickCrew(c) }}
              data-crew={c}
            >
              {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
