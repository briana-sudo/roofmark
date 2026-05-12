// ============================================================================
// formatArchitecturalLength.js — Phase 2 sub-step 18e (May 12 2026)
//
// Pure function: convert inches → architectural feet-inches string with
// 1/8" precision (DIMRND = 0.125). Per RoofMark §21.18e canonical spec
// section "Text format".
//
// Examples (verified by step-18e block-test runner):
//   0      → '0"'
//   0.125  → '1/8"'
//   0.5    → '1/2"'
//   6      → '6"'
//   12     → '1\'-0"'
//   15.5   → '1\'-3 1/2"'
//   18.375 → '1\'-6 3/8"'
//   18.4375 → '1\'-6 1/2"'  (rounds up at the 1/2 boundary)
//   96     → '8\'-0"'
//   -6     → '-6"'
//
// Pure: no React, no DOM, no store. Test-shim-compatible.
// ============================================================================

/**
 * Format inches as an architectural feet-inches string.
 *
 * @param {number} inches - signed inches (negative supported)
 * @returns {string | null} formatted string, or null on invalid input
 */
export function formatArchitecturalLength(inches) {
  if (typeof inches !== 'number' || !Number.isFinite(inches)) return null

  const sign = inches < 0 ? '-' : ''
  const abs = Math.abs(inches)

  // Round to nearest 1/8" (DIMRND = 0.125). Math.round() handles the
  // .5 boundary via banker-free round-half-away-from-zero in JS, but
  // that's fine for our spec: 18.4375 × 8 = 147.5 → round → 148 →
  // ÷ 8 → 18.5 (= 1'-6 1/2"). Spec test 18.4375 expects exactly that.
  const eighthsTotal = Math.round(abs * 8)
  const totalInches = eighthsTotal / 8
  const feet = Math.floor(totalInches / 12)
  const remainInches = totalInches - feet * 12

  // Split the remaining inches into whole + fractional 1/8" parts.
  // Math.round around the multiplication-then-modulo defends against
  // float jitter (e.g., 0.375 * 8 producing 2.9999...).
  const wholeInches = Math.floor(remainInches)
  const fractionalEighths = Math.round((remainInches - wholeInches) * 8)

  // Reduce the fraction n/8 to lowest terms by halving while even.
  // Maps:
  //   1/8 → 1/8
  //   2/8 → 1/4
  //   3/8 → 3/8
  //   4/8 → 1/2
  //   5/8 → 5/8
  //   6/8 → 3/4
  //   7/8 → 7/8
  let fractionStr = ''
  if (fractionalEighths > 0) {
    let num = fractionalEighths
    let den = 8
    while (den > 1 && num % 2 === 0) {
      num /= 2
      den /= 2
    }
    fractionStr = `${num}/${den}`
  }

  // ---- Compose output ----
  // Zero: simple constant string (avoids edge cases below).
  if (feet === 0 && wholeInches === 0 && fractionalEighths === 0) return '0"'

  if (feet === 0) {
    // Inches-only output.
    if (wholeInches === 0) return `${sign}${fractionStr}"`
    if (fractionalEighths === 0) return `${sign}${wholeInches}"`
    return `${sign}${wholeInches} ${fractionStr}"`
  }

  // Feet-inches output. Compose the inch part separately so the
  // formatter doesn't have to special-case the 0 / fraction / whole
  // / mixed permutations at the outer level.
  let inchPart
  if (wholeInches === 0 && fractionalEighths === 0) inchPart = '0"'
  else if (fractionalEighths === 0) inchPart = `${wholeInches}"`
  else if (wholeInches === 0) inchPart = `${fractionStr}"`
  else inchPart = `${wholeInches} ${fractionStr}"`

  return `${sign}${feet}'-${inchPart}`
}
