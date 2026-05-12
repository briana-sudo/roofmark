// ============================================================================
// dimConstants.js — Phase 2 sub-step 18e (May 12 2026)
//
// Per RoofMark §21.18e canonical spec (Notion: 35eca70abea681d8bde3fe3a3a6522b4)
// section "Style constants". All values are canvas pixels at zoom 1 — the
// render path scales them with the viewport so dimensions stay visually
// consistent regardless of zoom.
//
// Constants are mirrored from AutoCAD DIMSTYLE convention:
//   DIMEXO — extension line offset from origin
//   DIMEXE — extension line extension past dim line
//   DIMASZ — arrowhead tick size
//   DIMTXT — text height
//   DIMGAP — gap between text and dim line
//
// 18e ships with the ARCHITECTURAL tick (45° slash) per industry research
// for arch / construction / shop-drawing work. Mechanical-arrow style
// can ship as a future toggle if real-job demand surfaces.
// ============================================================================

export const DIMEXO = 3              // extension line offset from origin (1/8" = 3 px)
export const DIMEXE = 3              // extension line extends beyond dim line (1/8" = 3 px)
export const DIMASZ = 6              // arrowhead tick length (1/4" = 6 px)
// Phase 2 18e style bump (May 12 2026) — DIMTXT raised from 10 → 14
// (40% larger, readable at typical zoom). DIM_COLOR bumped from
// '#1f2937' dark-gray (matched line color, blended visually) → KCC
// orange '#e8531a' (matches selected-line + selected-dim accent —
// operator-friendly "attention" color). Selected-line + dim now
// share orange; future operator-adjustable style (18e.3a) can
// re-separate if real-job use demands it.
export const DIMTXT = 14             // text height in px
export const DIMGAP = 2              // gap between text and dim line
export const DIM_COLOR = '#e8531a'   // KCC orange, distinct from unselected line gray
export const DIM_PRECISION = 8       // 1/8" precision (fractional eighths)
export const DIM_PRECISION_INCHES = 1 / 8

// Default perpendicular offset for Workflow 1 (1-click-on-line shortcut)
// AND for the initial preview offset in Workflow 2 before the operator
// drags. Per spec §"Default offset": 24 px = 1 inch. Far enough to read,
// not so far that it floats orphaned.
export const DEFAULT_DIM_OFFSET = 24
