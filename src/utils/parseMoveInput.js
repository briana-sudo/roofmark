// ============================================================================
// parseMoveInput.js — Phase 2 sub-step 18d-edit (May 11 2026)
//
// Pure parser for Move / Copy / grip-edit typed delta inputs. Composes
// parseLength (for distance values) and parseAngle (for angle values).
// No React, no store, no DOM. Test-runner-shim-compatible.
//
// Accepted formats:
//   "24, 0"        → {dx: 24, dy: 0}        (bare comma form)
//   "0, 12"        → {dx: 0, dy: 12}
//   "1'6, 0"       → {dx: 18, dy: 0}        (parseLength handles feet+inches)
//   "24 @ 45"      → {dx: cos(45°)*24, dy: sin(45°)*24}
//   "24 @ 4/12"    → distance 24 at pitch 4/12 (parseAngle smart-parser)
//   `1'6 @ 4/12`   → distance 18 at pitch 4/12
//
// Rejections (return null):
//   - empty / whitespace-only string
//   - non-string input
//   - malformed comma form (e.g., "24,") — both sides must parse
//   - malformed at form (e.g., "24 @ abc")
//   - bare number (e.g., "24") — no comma or @ present
//
// Whitespace tolerant on both sides of `,` and `@`.
//
// Precedence: `@` checked FIRST so "1'6 @ 4/12" doesn't match the
// comma rule via the embedded `/` (parseAngle's pitch path catches the
// `/`, not the comma rule). lastIndexOf used for both `,` and `@` so
// the right-side feet+inches forms (`1'6", 0`) don't fragment on the
// inches-symbol apostrophe.
// ============================================================================

import { parseLength } from './parseLength'
import { parseAngle } from './parseAngle'

// parseLength rejects negatives (lengths are non-negative by spec). But
// Move/Copy/grip-edit deltas legitimately need negative values to move
// left or up. Local wrapper strips an optional leading `-`, defers to
// parseLength, re-applies the sign. Distance part of the `@` form keeps
// the parseLength contract (distance is always non-negative; direction
// comes from the angle).
function parseSignedLength(s) {
  if (typeof s !== 'string') return null
  const trimmed = s.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('-')) {
    const positive = parseLength(trimmed.slice(1).trim())
    if (positive === null) return null
    return -positive
  }
  // Also accept "+24" gracefully — strip the prefix and defer.
  if (trimmed.startsWith('+')) {
    return parseLength(trimmed.slice(1).trim())
  }
  // Zero is valid for deltas (operator may want to move purely in one axis).
  if (trimmed === '0' || trimmed === '0.0' || /^0+$/.test(trimmed)) return 0
  return parseLength(trimmed)
}

export function parseMoveInput(input) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s.length === 0) return null

  // Pattern A: distance @ angle (check first — `@` is unambiguous).
  const atIdx = s.lastIndexOf('@')
  if (atIdx > 0) {
    const distStr = s.slice(0, atIdx).trim()
    const angleStr = s.slice(atIdx + 1).trim()
    // Distance for the @ form: positive only (direction is the angle's
    // job). parseLength's non-negative contract applies.
    const dist = parseLength(distStr)
    const angleDeg = parseAngle(angleStr, 'degrees')
    if (dist !== null && angleDeg !== null) {
      const rad = (angleDeg * Math.PI) / 180
      return { dx: Math.cos(rad) * dist, dy: Math.sin(rad) * dist }
    }
    return null
  }

  // Pattern B: comma form "dx, dy". lastIndexOf so `1'6", 0` splits at
  // the last comma rather than fragmenting on internal punctuation.
  // Sides accept negative values via parseSignedLength.
  const commaIdx = s.lastIndexOf(',')
  if (commaIdx > 0) {
    const dxStr = s.slice(0, commaIdx).trim()
    const dyStr = s.slice(commaIdx + 1).trim()
    const dx = parseSignedLength(dxStr)
    const dy = parseSignedLength(dyStr)
    if (dx !== null && dy !== null) return { dx, dy }
    return null
  }

  return null
}
