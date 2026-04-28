import { create } from 'zustand'

// RoofMark app-wide store. Phase 1 Step 1 establishes the shape; later
// steps populate layers, sequences, clines, snap state, undo stack, etc.
export const useAppStore = create((set) => ({
  // Job context (populated by registry integration in Step 15)
  jobAddress: null,
  jobScope: null,
  jobCrew: null,

  // App mode — DRAW | EDIT | SEQUENCE | TECHNICAL
  mode: 'DRAW',

  // Right drawer (collapsed in Step 1; toggle wires up later)
  rightDrawerOpen: false,

  // Save state — saved | unsaved | saving
  saveState: 'saved',

  // Cursor/status state surfaced in the status bar
  activeTool: null,
  activeLayerId: null,
  cursorX: 0,
  cursorY: 0,
  snapType: null,

  // Geometry buckets — Phase 1 Step 2 will replace stubs with real shapes
  layers: [],
  sequences: [],
  clines: [],

  setMode: (mode) => set({ mode }),
  toggleRightDrawer: () => set((s) => ({ rightDrawerOpen: !s.rightDrawerOpen })),
}))
