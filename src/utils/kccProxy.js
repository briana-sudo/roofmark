// ============================================================================
// kccProxy.js — Phase 2 sub-step 18h (May 12 2026)
//
// Single source of truth for KCC Netlify Proxy URLs. Every RoofMark
// network call that targets the proxy should pull its URL from here —
// avoids drift between modules and gives one place to override the
// base URL for local dev / staging.
//
// Default base matches the existing hardcoded pattern in
// translateAnnotations.js (`https://kcc-proxy.netlify.app`). Override
// via Vite env var `VITE_KCC_PROXY_BASE_URL` at build time (.env files
// or workflow injection) for any non-prod deployment.
//
// 18h consumes the three async endpoints (submit / status / fetch);
// the sync /api/claude endpoint is reserved for translateAnnotations'
// existing path and can migrate to this module in a future cleanup.
// ============================================================================

export const PROXY_BASE_URL =
  (typeof import.meta !== 'undefined'
    && import.meta.env
    && import.meta.env.VITE_KCC_PROXY_BASE_URL)
  || 'https://kcc-proxy.netlify.app'

export const ASYNC_SUBMIT_URL = `${PROXY_BASE_URL}/api/claude-async-submit`
export const ASYNC_STATUS_URL = `${PROXY_BASE_URL}/api/claude-async-status`
export const ASYNC_FETCH_URL  = `${PROXY_BASE_URL}/api/claude-async-fetch`

// Sync endpoint reserved for forward compatibility — not used by 18h.
export const SYNC_CLAUDE_URL  = `${PROXY_BASE_URL}/api/claude`
