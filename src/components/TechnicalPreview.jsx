// ============================================================================
// TechnicalPreview.jsx — Phase 2 sub-step 18h (May 12 2026)
//
// Full-screen overlay shown when previewState.isOpen === true under
// appMode === 'TECHNICAL'. Three regions:
//
//   1. Top bar  — title + close button + keyboard-hint
//   2. Left panel — preview controls (orientation, rotation, fitMode,
//                   customScale) + Generate PDF button + progress/error
//   3. Center  — HTML/CSS page mockup of the v1.1 shop drawing layout
//                with the geometry rendered as SVG inside the drawing-
//                area div
//
// Locked-template philosophy: the v1.1 PDF is the source of truth for
// what fabricators receive. Preview replicates that look in HTML/CSS +
// SVG so the operator can review BEFORE kicking off the proxy run.
//
// Controls update store.previewState which feeds back into the SVG
// renderer + the PDF payload at generate time. Keyboard shortcuts at
// the App.jsx level dispatch the same actions for Rule 28 reachability.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { renderShopDrawingSVG } from '../utils/shopDrawingSvgRender'
import {
  buildShopDrawingPayload, shopDrawingFilename,
} from '../utils/specTableJSON'
import { computeIsSpecTableValid } from '../utils/specTableValidation'
import { useShopDrawingPdf } from '../hooks/useShopDrawingPdf'
// D2: Vite ?raw import — Python script source becomes a string constant
// in the JS bundle. v1.1 ships at ~31 KB raw text; minified+gzipped
// bundle delta ~8 kB per estimate.
import scriptSource from '../../tooling/kcc-shop-drawing.py?raw'

// Letter dimensions in CSS pixels for the page mockup. ~80 px per inch
// gives a readable preview at typical viewport sizes. v1.1 PDF is
// 8.5" × 11" — preview scales the mockup at 60% of those CSS pixels
// (display 8.5 × 60 = 510 px wide for letter portrait).
const PAGE_PX_PER_INCH = 56
const LETTER_LONG_PX  = 11 * PAGE_PX_PER_INCH   // 616 px
const LETTER_SHORT_PX = 8.5 * PAGE_PX_PER_INCH  // 476 px

// v1.1 layout proportions (mirrors kcc-shop-drawing.py constants).
// All are PT but get translated into preview-px via PT_PER_PAGE_PX.
const PT_PER_INCH = 72
const PAGE_PX_PER_PT = PAGE_PX_PER_INCH / PT_PER_INCH  // ≈ 0.778

const MARGIN_PT       = 25.2
const HEADER_H_PT     = 39.6
const ACCENT_H_PT     = 4.3
const FOOTER_H_PT     = 21.6
const SPEC_H_LAND_PT  = 75.6     // landscape
const SPEC_H_PORT_PT  = 138.0    // portrait
const ST_BAR_H_PT     = 12.96

// v1.1 color palette
const KCC_NAVY     = '#1A2F4A'
const KCC_ORANGE   = '#E8630A'
const GRID_LIGHT   = '#C8D8E8'
const SPEC_TABLE_BG = '#F5F6F8'
const LIGHT_GRAY_BG = '#ECEEF2'

// Spec table fields per v1.1 SPEC_FIELDS — display label + JSON key.
const LANDSCAPE_FIELDS = [
  ['PART NAME',     'partName'],
  ['MATERIAL',      'material'],
  ['COLOR',         'color'],
  ['STOCK LENGTH',  'stockLength'],
  ['JOB ID',        'jobId'],
  ['JOB ADDRESS',   'jobAddress'],
  ['DRAWN BY',      'drawnBy'],
  ['DATE',          'date'],
]
// Portrait uses the same fields in row-major 2-col × 4-row order.
const PORTRAIT_FIELDS = LANDSCAPE_FIELDS

export default function TechnicalPreview() {
  const isOpen = useAppStore((s) => s.previewState.isOpen)
  const previewState = useAppStore((s) => s.previewState)
  const closePreview = useAppStore((s) => s.closePreview)
  const setPageOrientation = useAppStore((s) => s.setPageOrientation)
  const cycleRotation = useAppStore((s) => s.cycleRotation)
  const setFitMode = useAppStore((s) => s.setFitMode)
  const setCustomScale = useAppStore((s) => s.setCustomScale)
  const setPdfJob = useAppStore((s) => s.setPdfJob)
  const resetPdfJob = useAppStore((s) => s.resetPdfJob)

  // Read store data once per render — buildShopDrawingPayload is pure
  // and runs on every preview-control change anyway, so a fresh snapshot
  // is fine.
  const specTable = useAppStore((s) => s.specTable)
  const technicalLayers = useAppStore((s) => s.technicalLayers)

  // Hook drives the actual submit/poll/fetch + auto-download
  const { state: pdfState, run: runPdf, retry, redownload, reset: resetPdf } =
    useShopDrawingPdf()

  // Mirror hook state to store so DrawingTools / status bar / future
  // panels can read pdfJob without subscribing to the hook.
  useEffect(() => {
    setPdfJob({
      phase: pdfState.phase,
      error: pdfState.error,
      elapsedSec: pdfState.elapsedSec,
      warning: pdfState.warning,
      filename: pdfState.filename,
    })
  }, [pdfState.phase, pdfState.error, pdfState.elapsedSec, pdfState.warning, pdfState.filename, setPdfJob])

  // Validity gate: 3 required fields filled.
  const isValid = useMemo(() => computeIsSpecTableValid(specTable), [specTable])

  // Build the v1.1 payload AND derive the drawing-area dimensions for
  // the SVG. Both flow from previewState's orientation; recompute on
  // every change so the preview tracks the operator's choices live.
  const isPortrait = previewState.pageOrientation === 'portrait'
  const pageW = isPortrait ? LETTER_SHORT_PX : LETTER_LONG_PX
  const pageH = isPortrait ? LETTER_LONG_PX  : LETTER_SHORT_PX
  const specHeightPt = isPortrait ? SPEC_H_PORT_PT : SPEC_H_LAND_PT
  const specHeightPx = specHeightPt * PAGE_PX_PER_PT
  const sheetX0 = MARGIN_PT * PAGE_PX_PER_PT
  const sheetY0 = MARGIN_PT * PAGE_PX_PER_PT
  const sheetX1 = pageW - sheetX0
  const sheetY1 = pageH - sheetY0
  const headerH = HEADER_H_PT * PAGE_PX_PER_PT
  const accentH = ACCENT_H_PT * PAGE_PX_PER_PT
  const footerH = FOOTER_H_PT * PAGE_PX_PER_PT
  const drawAreaPadPx = 7.2 * PAGE_PX_PER_PT
  const drawX0 = sheetX0 + drawAreaPadPx
  const drawX1 = sheetX1 - drawAreaPadPx
  const drawY0 = sheetY0 + footerH + specHeightPx + drawAreaPadPx
  const drawY1 = sheetY1 - headerH - accentH - drawAreaPadPx
  const drawAreaW = drawX1 - drawX0
  const drawAreaH = drawY1 - drawY0

  const payload = useMemo(
    () => buildShopDrawingPayload({ specTable, technicalLayers }, previewState),
    [specTable, technicalLayers, previewState]
  )
  const { svg, overflow } = useMemo(
    () => renderShopDrawingSVG({
      data: payload,
      drawingAreaPx: { width: drawAreaW, height: drawAreaH },
      previewControls: previewState,
    }),
    [payload, drawAreaW, drawAreaH, previewState]
  )

  // Generate PDF handler — composes filename, kicks off the hook.
  const handleGenerate = async () => {
    if (!isValid) return
    const filename = shopDrawingFilename(specTable)
    try {
      await runPdf({ data: payload, scriptSource, filename })
    } catch (_err) {
      // Hook captures error into state; nothing more to do here.
    }
  }

  // Close + reset PDF state when leaving the preview to avoid stale
  // banners if operator re-enters.
  const handleClose = () => {
    closePreview()
    if (pdfState.phase === 'error') {
      resetPdf()
      resetPdfJob()
    }
  }

  if (!isOpen) return null

  // Spec table grid math (matches v1.1's _layout())
  const specCols = isPortrait ? 2 : 4
  const specRows = isPortrait ? 4 : 2
  const specBodyW = sheetX1 - sheetX0
  const specColW = specBodyW / specCols
  const stBarPx = ST_BAR_H_PT * PAGE_PX_PER_PT
  const specRowH = (specHeightPx - stBarPx) / specRows

  return (
    <div className="preview-overlay" data-testid="technical-preview">
      <div className="preview-topbar">
        <span className="preview-title">Technical Drawing Preview</span>
        <span className="preview-hint">[Esc] close</span>
        <button
          type="button"
          className="preview-close"
          onClick={handleClose}
          aria-label="Close preview"
          data-testid="preview-close-button"
        >
          ✕
        </button>
      </div>

      <div className="preview-body">
        <aside className="preview-controls" data-testid="preview-controls">
          <h3 className="preview-section-title">Page</h3>
          <div className="preview-group" role="group" aria-label="Page orientation">
            <button
              type="button"
              className={`preview-pill${!isPortrait ? ' active' : ''}`}
              onClick={() => setPageOrientation('landscape')}
              data-testid="preview-orient-landscape"
            >
              Landscape
            </button>
            <button
              type="button"
              className={`preview-pill${isPortrait ? ' active' : ''}`}
              onClick={() => setPageOrientation('portrait')}
              data-testid="preview-orient-portrait"
            >
              Portrait
            </button>
          </div>
          <div className="preview-hint-row">[O] cycle orientation</div>

          <h3 className="preview-section-title">Rotation</h3>
          <button
            type="button"
            className="preview-rotation"
            onClick={cycleRotation}
            data-testid="preview-rotation-cycle"
          >
            {previewState.geometryRotation}° (cycle)
          </button>
          <div className="preview-hint-row">[R] cycle 0 → 90 → 180 → 270</div>

          <h3 className="preview-section-title">Fit Mode</h3>
          <div className="preview-group" role="group" aria-label="Fit mode">
            {['auto', '1:1', 'custom'].map((m) => (
              <button
                key={m}
                type="button"
                className={`preview-pill${previewState.fitMode === m ? ' active' : ''}`}
                onClick={() => setFitMode(m)}
                data-testid={`preview-fit-${m}`}
              >
                {m === 'auto' ? 'Auto' : m === '1:1' ? '1:1' : 'Custom'}
              </button>
            ))}
          </div>
          <div className="preview-hint-row">[F] cycle fit mode</div>
          {previewState.fitMode === 'custom' && (
            <div className="preview-custom-scale">
              <label htmlFor="preview-custom-scale-input">customScale</label>
              <input
                id="preview-custom-scale-input"
                type="number"
                min="0.05"
                step="0.05"
                value={previewState.customScale}
                onChange={(e) => setCustomScale(e.target.value)}
                data-testid="preview-custom-scale-input"
              />
            </div>
          )}

          {overflow && (previewState.fitMode === '1:1' || previewState.fitMode === 'custom') && (
            <div className="preview-warning" data-testid="preview-overflow-warning">
              ⚠ Geometry overflows the drawing area at this scale.
              The preview shows clipping. PDF generation will fail with a
              ValueError — choose Auto or reduce customScale.
            </div>
          )}

          <h3 className="preview-section-title">Generate PDF</h3>
          {!isValid && (
            <div className="preview-validity-hint" data-testid="preview-validity-hint">
              Fill Part Name, Material, and Drawing No in the Spec Table to enable export.
            </div>
          )}
          <button
            type="button"
            className="preview-generate"
            onClick={handleGenerate}
            disabled={!isValid || pdfState.phase === 'submitting' || pdfState.phase === 'polling' || pdfState.phase === 'fetching'}
            data-testid="preview-generate-button"
          >
            {pdfState.phase === 'idle' && '📄 Generate PDF'}
            {pdfState.phase === 'submitting' && 'Submitting…'}
            {pdfState.phase === 'polling' && `Polling… ${Math.floor(pdfState.elapsedSec)}s`}
            {pdfState.phase === 'fetching' && 'Fetching PDF…'}
            {pdfState.phase === 'done' && '✓ Downloaded'}
            {pdfState.phase === 'error' && 'Retry'}
          </button>
          <div className="preview-hint-row">[G] or [Enter] generate</div>

          {pdfState.warning && pdfState.phase === 'polling' && (
            <div className="preview-warning-soft" data-testid="preview-poll-warning">
              Still polling at {Math.floor(pdfState.elapsedSec)}s — agent loop running long.
            </div>
          )}
          {pdfState.phase === 'error' && (
            <div className="preview-error" data-testid="preview-pdf-error">
              <strong>PDF generation failed.</strong>
              <div className="preview-error-detail">{pdfState.error}</div>
              <button type="button" className="preview-retry" onClick={retry}>
                Retry
              </button>
            </div>
          )}
          {pdfState.phase === 'done' && (
            <div className="preview-success" data-testid="preview-pdf-success">
              <strong>✓ PDF downloaded</strong>
              <button type="button" className="preview-redownload" onClick={redownload}>
                Re-download
              </button>
            </div>
          )}
        </aside>

        <main className="preview-stage">
          <div
            className="preview-page"
            style={{
              width: pageW,
              height: pageH,
              background: LIGHT_GRAY_BG,
            }}
            data-testid="preview-page-mockup"
          >
            {/* Sheet border */}
            <div
              className="preview-sheet-border"
              style={{
                position: 'absolute',
                left: sheetX0, top: sheetY0,
                width: sheetX1 - sheetX0, height: sheetY1 - sheetY0,
                border: `1px solid ${KCC_NAVY}`,
                boxSizing: 'border-box',
              }}
            />
            {/* Header bar */}
            <div
              className="preview-header"
              style={{
                position: 'absolute',
                left: sheetX0,
                top: sheetY0,
                width: sheetX1 - sheetX0,
                height: headerH,
                background: KCC_NAVY,
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: `0 ${14.4 * PAGE_PX_PER_PT}px`,
                boxSizing: 'border-box',
                fontFamily: 'Helvetica, Arial, sans-serif',
              }}
            >
              <div>
                <div style={{ fontSize: 13 * PAGE_PX_PER_PT, fontWeight: 700, lineHeight: 1.2 }}>
                  KOSAREK CONSTRUCTION CO.
                </div>
                <div style={{ fontSize: 7.5 * PAGE_PX_PER_PT, color: GRID_LIGHT }}>
                  Illinois Unlimited Roofing License | Engineered Roofing Precision
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 8 * PAGE_PX_PER_PT, fontWeight: 700, color: KCC_ORANGE }}>
                  SHOP DRAWING
                </div>
                <div style={{ fontSize: 15 * PAGE_PX_PER_PT, fontWeight: 700 }}>
                  {specTable.drawingNo || '(no drawing number)'}
                </div>
              </div>
            </div>
            {/* Orange accent stripe */}
            <div
              style={{
                position: 'absolute',
                left: sheetX0,
                top: sheetY0 + headerH,
                width: sheetX1 - sheetX0,
                height: accentH,
                background: KCC_ORANGE,
              }}
            />
            {/* Drawing area (SVG geometry goes here) */}
            <div
              className="preview-drawing-area"
              style={{
                position: 'absolute',
                left: drawX0,
                top: pageH - drawY1,
                width: drawAreaW,
                height: drawAreaH,
                background: 'white',
                border: `1px solid ${GRID_LIGHT}`,
                boxSizing: 'border-box',
                overflow: 'hidden',
              }}
              data-testid="preview-drawing-area"
            >
              {svg}
            </div>
            {/* Spec table */}
            <div
              className="preview-spec-table"
              style={{
                position: 'absolute',
                left: sheetX0,
                top: pageH - sheetY0 - footerH - specHeightPx,
                width: sheetX1 - sheetX0,
                height: specHeightPx,
                background: SPEC_TABLE_BG,
                border: `0.75px solid ${KCC_NAVY}`,
                boxSizing: 'border-box',
                fontFamily: 'Helvetica, Arial, sans-serif',
              }}
              data-testid="preview-spec-table"
            >
              {/* Spec table top stripe */}
              <div
                style={{
                  position: 'absolute', top: 0, left: 0,
                  width: '100%', height: stBarPx,
                  background: KCC_NAVY,
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: `0 ${14.4 * PAGE_PX_PER_PT}px`,
                  boxSizing: 'border-box',
                  fontSize: 8 * PAGE_PX_PER_PT,
                  fontWeight: 700,
                }}
              >
                <span>PART  &  JOB  SPECIFICATION</span>
                <span style={{ color: GRID_LIGHT, fontStyle: 'italic', fontWeight: 400, fontSize: 7 * PAGE_PX_PER_PT }}>
                  KCC RoofMark — Locked Title Block
                </span>
              </div>
              {/* Spec table cells grid */}
              {(isPortrait ? PORTRAIT_FIELDS : LANDSCAPE_FIELDS).map(([label, key], idx) => {
                const row = Math.floor(idx / specCols)
                const col = idx % specCols
                const cellX = col * specColW
                const cellY = stBarPx + row * specRowH
                const value = specTable[key] || '—'
                return (
                  <div
                    key={key}
                    style={{
                      position: 'absolute',
                      left: cellX, top: cellY,
                      width: specColW, height: specRowH,
                      borderRight: col < specCols - 1 ? `0.4px solid ${KCC_NAVY}` : 'none',
                      borderBottom: row < specRows - 1 ? `0.4px solid ${KCC_NAVY}` : 'none',
                      padding: `4px ${8 * PAGE_PX_PER_PT}px`,
                      boxSizing: 'border-box',
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{ color: KCC_ORANGE, fontSize: 7 * PAGE_PX_PER_PT, fontWeight: 700 }}>
                      {label}
                    </div>
                    <div style={{
                      color: KCC_NAVY,
                      fontSize: 9 * PAGE_PX_PER_PT,
                      marginTop: 2,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {value}
                    </div>
                  </div>
                )
              })}
            </div>
            {/* Footer bar */}
            <div
              style={{
                position: 'absolute',
                left: sheetX0,
                top: pageH - sheetY0 - footerH,
                width: sheetX1 - sheetX0,
                height: footerH,
                background: KCC_NAVY,
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: `0 ${14.4 * PAGE_PX_PER_PT}px`,
                boxSizing: 'border-box',
                fontFamily: 'Helvetica, Arial, sans-serif',
                fontSize: 7 * PAGE_PX_PER_PT,
              }}
            >
              <span style={{ fontWeight: 700 }}>
                KCC ROOFMARK  |  AEROSPACE-GRADE PROCESS DISCIPLINE FOR ROOFING
              </span>
              <span style={{ color: GRID_LIGHT }}>
                kcc-shop-drawing.py v1.1  |  internal scale 24 px / inch
              </span>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
