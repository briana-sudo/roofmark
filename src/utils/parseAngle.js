// ============================================================================
// parseAngle.js — Phase 2 sub-step 18c (May 11 2026)
//
// Pure parser for operator-typed angle strings in the Technical Drawing
// angle input. Companion to parseLength.js (Spec §21). Accepts two
// notations:
//
//   Degrees:
//     `45`     → 45        (bare number, when defaultUnit === 'degrees')
//     `45°`    → 45
//     `45deg`  → 45
//     `-45`    → -45       (negative valid — angle measured CW from horizontal)
//     `45.5°`  → 45.5
//     `0`      → 0         (zero is valid — horizontal line)
//
//   Pitch (rise/run, traditional roofing notation):
//     `4/12`   → atan(4/12) * 180/π ≈ 18.43
//     `6/12`   → 26.57
//     `8/12`   → 33.69
//     `12/12`  → 45
//     `0/12`   → 0         (zero pitch = flat / horizontal)
//     `4/0`    → null      (zero denominator — division by zero)
//     `-4/12`  → null      (negative pitch rejected; operator draws in the
//                           deflection direction instead)
//
// Smart-parser rule (resolves the bare-number ambiguity):
//   1. Input contains `/` → ALWAYS parse as pitch (defaultUnit ignored)
//   2. Input contains `°` or `deg` → ALWAYS parse as degrees
//   3. Otherwise → fall back to `defaultUnit`:
//        - defaultUnit === 'degrees' → parse as bare-number degrees
//        - defaultUnit === 'pitch'   → REJECT (pitch requires `/` notation)
//      The reject-in-pitch-mode rule eliminates the ambiguity of "what
//      does `45` mean when the operator is in pitch mode?" Forcing the
//      slash makes the operator's intent unambiguous.
//
// Rejections (return null):
//   - Empty / whitespace-only string
//   - Non-string input
//   - Trailing junk after the number (e.g., `45deg foo`)
//   - Non-numeric numerator or denominator in pitch
//   - Zero denominator in pitch
//   - Negative pitch
//   - Out-of-range degrees: |value| > 360 (sanity bound)
//
// Returns: angle in degrees (decimal Number), positive or negative
// (canvas Y-down convention — positive = clockwise from horizontal as
// the operator sees it). Or null on any of the rejections above.
//
// Pure: no React, no store, no DOM. Imported by TechInputPanel.jsx and
// the test/step-18c-node-runner.cjs block tests. No internal imports —
// the test-runner eval-shim can load this module the same way it loads
// parseLength.js.
// ============================================================================

const DEGREE_RANGE = 360

export function parseAngle(input, defaultUnit) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s.length === 0) return null

  const hasSlash = s.includes('/')
  const hasDegreeSymbol = s.includes('°')
  // Plain substring check — `\bdeg\b` would fail on `45deg` because
  // digits and letters are both word characters (no boundary between
  // `5` and `d`). The full regex below still validates the structure.
  const hasDegWord = /deg/i.test(s)

  // --------------------------------------------------------------
  // Pitch path — any input containing `/` is interpreted as rise/run.
  // --------------------------------------------------------------
  if (hasSlash) {
    // Whitespace tolerant: `4 / 12`, `4/ 12`, etc.
    const m = s.match(/^(-?[0-9]+(?:\.[0-9]+)?)\s*\/\s*(-?[0-9]+(?:\.[0-9]+)?)$/)
    if (!m) return null
    const rise = parseFloat(m[1])
    const run = parseFloat(m[2])
    if (!Number.isFinite(rise) || !Number.isFinite(run)) return null
    if (rise < 0 || run <= 0) return null  // zero run → div-by-zero; negative rise → reject
    if (rise === 0) return 0
    const rad = Math.atan(rise / run)
    return rad * 180 / Math.PI
  }

  // --------------------------------------------------------------
  // Degrees path — explicit `°` / `deg` suffix, or bare number with
  // defaultUnit === 'degrees'.
  // --------------------------------------------------------------
  if (hasDegreeSymbol || hasDegWord) {
    // Whitespace tolerant: `45 °`, `45 deg`, etc.
    const m = s.match(/^(-?[0-9]+(?:\.[0-9]+)?)\s*(?:°|deg)$/i)
    if (!m) return null
    const value = parseFloat(m[1])
    if (!Number.isFinite(value)) return null
    if (Math.abs(value) > DEGREE_RANGE) return null
    return value
  }

  // Bare number: depends on defaultUnit.
  // - 'degrees' → accept as degrees
  // - 'pitch'   → reject (pitch requires `/` notation — no ambiguity)
  if (defaultUnit !== 'degrees') return null

  const m = s.match(/^(-?[0-9]+(?:\.[0-9]+)?)$/)
  if (!m) return null
  const value = parseFloat(m[1])
  if (!Number.isFinite(value)) return null
  if (Math.abs(value) > DEGREE_RANGE) return null
  return value
}
