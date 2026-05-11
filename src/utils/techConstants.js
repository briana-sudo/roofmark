// ============================================================================
// techConstants.js — Phase 2 sub-step 18d-edit follow-on (May 11 2026)
//
// Shared Technical Drawing constants. Single source of truth so the
// inches↔pixels conversion factor doesn't drift across modules.
//
// Background: 18d-edit shipped Move/Copy/Grip-edit commands with a
// unit-mismatch bug (operator-reported on live build `ACDM_-uv`).
// parseMoveInput returned operator-typed INCHES, and the store commit
// actions added that delta directly to pixel-space shape coordinates
// without multiplying by PX_PER_INCH=24. Operator saw 1/24 of the
// expected motion. Pre-fix, PX_PER_INCH was defined inline in two
// places (useAppStore.js + techLineCommit.js); this module consolidates
// to one location so future call sites (commitMoveCommand,
// commitCopyCommand, commitTypedGripEdit, et al.) all import from
// here and the unit boundary stays explicit.
// ============================================================================

// Canvas pixels per inch at zoom 1.0. Used wherever operator-typed
// inches are converted to canvas-space pixel coordinates, OR vice versa
// (e.g., the length-label render computes lengthInches = distance / PX_PER_INCH).
//
// Per Kickoff Spec §21: "24px = 1 inch" defines the canvas-pixel ↔
// real-world-inch mapping for Technical Drawing.
export const PX_PER_INCH = 24
