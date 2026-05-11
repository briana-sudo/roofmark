// ============================================================================
// parseLength.js — Phase 2 sub-step 18b (May 10 2026)
//
// Pure parser for operator-typed length strings in the Technical Drawing
// length input (Kickoff Spec §21). Accepts a small set of unambiguous
// short forms that match how a roofer dictates a length on a job site:
//
//   `4"`      → 4         (inches, unit symbol)
//   `4in`     → 4         (inches, unit word)
//   `4`       → 4         (bare number, inches assumed)
//   `4.5"`    → 4.5       (fractional inches)
//   `1'6"`    → 18        (feet + inches)
//   `1' 6 "`  → 18        (whitespace tolerant)
//   `1.5'`    → 18        (fractional feet, no inches)
//   `18"`     → 18        (multi-digit inches)
//   `0"`      → null      (zero length not a valid shape)
//   `-4`      → null      (negative not allowed)
//   ``        → null      (empty)
//   `4"foo`   → null      (trailing junk)
//   `abc`     → null      (no number)
//
// Returns inches as a number (decimal), or null on parse failure / invalid
// input. Callers should treat null as "use freehand length, ignore typed
// value" — the live rubber-band stays at cursor distance, the input shows
// a red invalid-state border, no toast.
//
// Why three patterns instead of one mega-regex: readability. Feet+inches,
// inches-with-unit, and bare-number are visually distinct cases and each
// pattern's regex stays small enough to audit by eye. Trying them in
// order yields the unambiguous parse the spec asks for.
//
// Pure: no React, no store, no DOM. Imported by TechLengthInput.jsx and
// the test/step-18b-node-runner.cjs block tests.
// ============================================================================

export function parseLength(input) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s.length === 0) return null
  // Reject leading minus before pattern matching — every accepted form
  // begins with a digit. (Bare `-4` would still parse "4" via pattern C
  // without this guard, which would be wrong.)
  if (s.startsWith('-')) return null

  // Pattern A: feet + optional inches.
  //   `1'6"`, `1' 6 "`, `1.5'`, `1' 6 in`, `1'`
  //   18d-edit (May 11 2026): also accept `1'6` (inches without trailing
  //   unit symbol) — common when typing into a comma-form move delta
  //   like `1'6, 0`. Inches unit symbol is now fully optional after
  //   the feet apostrophe; the regex below makes the `"|in|″` group
  //   itself optional.
  let m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*'\s*(?:([0-9]+(?:\.[0-9]+)?)\s*(?:"|in|″)?)?$/i)
  if (m) {
    const feet = parseFloat(m[1])
    const inches = m[2] ? parseFloat(m[2]) : 0
    const total = feet * 12 + inches
    return total > 0 ? total : null
  }

  // Pattern B: inches with explicit unit (no feet).
  //   `4"`, `4 "`, `4in`, `4 in`, `4.5"`, `18"`
  m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:"|in|″)$/i)
  if (m) {
    const inches = parseFloat(m[1])
    return inches > 0 ? inches : null
  }

  // Pattern C: bare number (inches assumed).
  //   `4`, `4.5`
  m = s.match(/^([0-9]+(?:\.[0-9]+)?)$/)
  if (m) {
    const inches = parseFloat(m[1])
    return inches > 0 ? inches : null
  }

  return null
}
