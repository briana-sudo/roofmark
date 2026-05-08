// ============================================================================
// translateAnnotations.js — P30 (May 8 2026)
//
// First Anthropic API integration in RoofMark. All Anthropic calls route
// through the KCC Netlify Proxy per Rule 18 (`netlify-proxy` project) —
// the API key lives only in Netlify environment variables, never in any
// KCC app or repo.
//
// API contract (Anthropic Messages API pass-through, see
// `C:\KCC_Local\netlify-proxy\netlify\functions\claude-proxy.js`):
//   POST https://kcc-proxy.netlify.app/api/claude
//   body: { model, max_tokens, system?, messages }
//   response: standard Anthropic Messages API JSON
//
// Strategy: single batched call. Send all annotations' EN texts numbered;
// Claude returns a JSON object {"translations": ["…", "…", …]} in same
// order. Single round-trip ≈ 2s vs 10s sequential for a 10-annotation
// sequence. Robustness via:
//   - explicit JSON-only system prompt
//   - array-length validation on response
//   - clear error + retry-button UI on failure (caller responsibility)
// ============================================================================

const PROXY_URL = 'https://kcc-proxy.netlify.app/api/claude'
const MODEL = 'claude-haiku-4-5'   // matches proxy doc example; fastest tier
const MAX_TOKENS = 1024
const TIMEOUT_MS = 30_000

// Annotations eligible for translation: callout + note (have textEN).
// Dimlines are unit-bearing (`12'-6"`, `4/12`) — language-agnostic, skipped.
function isTranslatable(anno) {
  if (!anno) return false
  if (anno.type !== 'callout' && anno.type !== 'note') return false
  return typeof anno.textEN === 'string' && anno.textEN.trim().length > 0
}

// Build the prompt body. Each translatable annotation is numbered in the
// order it appears in the input so the response array maps 1:1.
function buildPrompt(annotations) {
  const eligible = annotations.filter(isTranslatable)
  if (eligible.length === 0) return null
  const lines = eligible.map((a, i) => `${i + 1}. ${a.textEN.trim()}`)
  const body = (
`Translate each of the following English texts to Spanish for a US roofing crew. Use plain everyday Spanish a US-based crew would understand.

Return ONLY a JSON object with the shape:
{"translations": ["...", "...", ...]}

The "translations" array must contain exactly ${eligible.length} string(s), in the same order as the input. No extra commentary, no markdown fences, no surrounding prose — just the JSON object.

Texts:
${lines.join('\n')}`
  )
  return { eligible, prompt: body }
}

// Parse Claude's response. Anthropic response shape:
//   { content: [{ type: 'text', text: '...' }, ...], ... }
// We expect the assistant's first text block to be a JSON object. Some
// models occasionally wrap output in ```json fences despite instructions
// — strip those defensively.
export function parseTranslateResponse(responseJson, expectedLength) {
  if (!responseJson || !Array.isArray(responseJson.content)) {
    throw new Error('Unexpected response shape: missing content array')
  }
  const textBlock = responseJson.content.find((b) => b && b.type === 'text')
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error('Response missing text block')
  }
  let raw = textBlock.text.trim()
  // Strip ```json fences if present
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Response is not valid JSON')
  }
  if (!parsed || !Array.isArray(parsed.translations)) {
    throw new Error('Response missing translations array')
  }
  if (parsed.translations.length !== expectedLength) {
    throw new Error(
      `Translation count mismatch: expected ${expectedLength}, got ${parsed.translations.length}`,
    )
  }
  for (const t of parsed.translations) {
    if (typeof t !== 'string') {
      throw new Error('Translation array contains non-string entries')
    }
  }
  return parsed.translations
}

// fetch wrapper with timeout (matches roof-inspector's fetchWithTimeout
// pattern). Returns the parsed JSON body on success; throws on network
// failure, timeout, or non-2xx response.
async function postWithTimeout(url, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { /* ignore */ }
      throw new Error(
        `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      )
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Public entry point. Translates all eligible annotations in `annotations`
// (a sequence's annotations array). Returns a Map<annoId, textES>.
//
//   - empty / no-eligible-annotations → returns empty Map (caller can
//     short-circuit before hitting the API)
//   - API failure throws Error with a user-readable message that the
//     caller surfaces inline with a retry button
//   - parse failure also throws
export async function translateAnnotations(annotations) {
  const built = buildPrompt(annotations)
  if (!built) return new Map()
  const { eligible, prompt } = built

  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  }

  const responseJson = await postWithTimeout(PROXY_URL, payload, TIMEOUT_MS)
  const translations = parseTranslateResponse(responseJson, eligible.length)

  const out = new Map()
  eligible.forEach((a, i) => {
    out.set(a.id, translations[i])
  })
  return out
}
