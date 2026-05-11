// ============================================================================
// techPanelKeyHandling.js — Phase 2 sub-step 18c fix (May 11 2026)
//
// Pure helpers for TechInputPanel's keyboard event handling. Lives in
// utils/ so the test runner's eval-shim can load it without dragging
// React along (the component itself imports + uses these).
//
// shouldStopHijackedKey(e): returns true when the panel's wrapper
//   capture-phase keydown listener must call e.stopPropagation() to
//   prevent CanvasStage's document-level zoom-shortcut hijack from
//   firing while focus is inside the panel. Returns false for everything
//   else (Enter, Escape, printable chars, Tab, arrows, modifiers) so
//   those keys flow through to the input's React onKeyDown handler.
//
// The set below mirrors CanvasStage.onKeyDown's zoom/space branches.
// Keep in sync if those shortcuts change.
//
// 18c Escape regression context (operator-reported on `af1f3c8`): the
// pre-fix implementation called stopPropagation() unconditionally for
// every key. That silently consumed Escape + Enter at the wrapper before
// they could reach the input's React onKeyDown handler. Typing characters
// still worked because text input uses a separate `input` event path,
// not blocked by keydown listeners. Making the stopper selective restores
// Escape/Enter while preserving the zoom-hijack guard.
// ============================================================================

const HIJACKED_KEYS = new Set(['+', '=', '-', '_', '0', '1', ' '])

export function shouldStopHijackedKey(e) {
  if (!e) return false
  if (HIJACKED_KEYS.has(e.key)) return true
  if (e.code === 'Space') return true
  return false
}
