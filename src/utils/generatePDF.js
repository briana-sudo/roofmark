// ============================================================================
// generatePDF.js — Step 16 (May 8 2026)
//
// Generates a bilingual crew-instruction PDF from the operator's RoofMark
// project. One page per sequence. Photo + annotations + shapes render via
// shared helpers in canvasRender.js (single source of truth with the live
// canvas — no drift risk).
//
// Spec: Notion §13 amendment (May 7 2026). Two languages, one page per
// sequence, full-width photo, header bar (KCC navy + orange stripe),
// callouts numbered list below the photo, footer with materials row +
// metadata row.
//
// Public API:
//   await exportProjectPDF({ project, language, photoImage, orientationPref })
//     → triggers download with smart filename (auto-DL pattern)
//
// Private helpers exported for testing:
//   buildPdfPageDom, computePageOrientation, renderSequenceImage,
//   buildPdfFilename
// ============================================================================
// html2pdf.js is dynamically imported on first export so the ~700 KB
// library doesn't bloat the first-load JS for operators who never trigger
// a PDF export. Vite splits it into its own chunk; first export pays the
// load cost, subsequent exports reuse the cached module.
import {
  renderSequencePageToCanvas,
  computeContributingLayers,
} from './canvasRender'
import { composeFilename, formatLocalYMD } from './slugify'

// Print-resolution scaling. We render the offscreen canvas at the source
// photo's native resolution (no extra upscale beyond what the photo already
// has) — the photo's pixel density IS the print quality ceiling. Annotations
// + shapes are vector-friendly at any res so this is fine.
const PRINT_SCALE = 1

// Step 16 (May 8 2026) — KCC brand colors. Duplicated from spec §13 amendment
// (do not import from CSS — html2pdf renders by capturing element styles, so
// the PDF DOM needs literal color values that don't depend on CSS variables).
const KCC_NAVY = '#1a3a5c'
const KCC_ORANGE = '#e8531a'

// POST-VERIFICATION FIX (May 8 2026 — Checks 2/3 FAIL on initial deploy):
// PDF page renders at fixed pixel dimensions matching A4 at 96 DPI so the
// hidden DOM layout doesn't depend on the operator's actual viewport
// height (100vh was unreliable for off-screen / position:fixed elements).
// html2pdf scales these px to the PDF's mm format at output time.
//   A4 portrait  : 794 × 1123 px
//   A4 landscape : 1123 × 794 px
// Section heights chosen so they sum to exactly the page height with a
// flexible photo zone in the middle.
const PAGE_PORTRAIT_W  = 794
const PAGE_PORTRAIT_H  = 1123
const PAGE_LANDSCAPE_W = 1123
const PAGE_LANDSCAPE_H = 794
const HEADER_H   = 56
const CALLOUTS_H = 140
const FOOTER_H   = 60

// Per Spec §13.6 — auto-detect orientation from photo aspect ratio. Operator
// may force via the ⋮ Project menu (orientationPref).
//   'landscape'  → landscape regardless of photo
//   'portrait'   → portrait regardless of photo
//   'auto'       → landscape if photoMeta.width > photoMeta.height, else portrait
//   square photo → portrait (default per spec deliverable list)
export function computePageOrientation(orientationPref, photoMeta) {
  if (orientationPref === 'landscape') return 'landscape'
  if (orientationPref === 'portrait') return 'portrait'
  // 'auto' or anything else → derive
  if (!photoMeta) return 'portrait'
  const w = Number(photoMeta.width) || 0
  const h = Number(photoMeta.height) || 0
  if (w > h) return 'landscape'
  return 'portrait' // tie or invalid → portrait (spec)
}

// Render one sequence's photo+annotations to an offscreen canvas. Returns
// the canvas element itself (not a dataURL) so callers can embed it
// directly via <img src=canvas.toDataURL()>. We expose the canvas+dataURL
// pair so html2canvas captures a guaranteed-loaded image (the dataURL is
// embedded in the <img> AND the natural width/height match exactly).
//
// POST-VERIFICATION FIX (May 8 2026): the previous version returned only
// the dataURL string and the caller built the <img> from it. html2canvas
// occasionally captured the photo as 0×0 because the <img>'s natural-dim
// layout hadn't settled when html2canvas snapshotted. Attaching the
// canvas's dimensions explicitly + decoding sync solves that.
export function renderSequenceImage({
  sequence, layers, clines, photoImage, photoMeta, language, clinesVisible,
}) {
  if (!photoMeta) return null
  const W = Math.max(1, Math.round(photoMeta.width * PRINT_SCALE))
  const H = Math.max(1, Math.round(photoMeta.height * PRINT_SCALE))
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  renderSequencePageToCanvas({
    canvas,
    sequence,
    layers,
    clines,
    photoImage,
    photoMeta,
    language,
    clinesVisible,
  })
  return { canvas, dataURL: canvas.toDataURL('image/png'), width: W, height: H }
}

// Escape HTML-bearing operator strings to prevent any < / > / & from breaking
// the PDF DOM (also closes the html2pdf.js XSS surface for operator-written
// text — only the operator can input these strings, so the risk is self-XSS
// rather than third-party, but defense in depth is cheap).
function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Build the per-sequence callouts numbered list. Spec §13.7 — compact
// reference index below the photo. Numbered by callout creation order
// (mirrors AnnotationPanel's "Callout #N" convention). Notes appear with
// a "Note:" prefix instead of a number; dimlines are skipped (they carry
// their own value labels on-canvas, not in the index).
function buildCalloutsListHtml(sequence, language) {
  if (!sequence || !Array.isArray(sequence.annotations)) return ''
  const items = []
  let calloutN = 0
  for (const a of sequence.annotations) {
    if (a.type === 'callout') {
      calloutN += 1
      const text = (language === 'es' ? a.textES : a.textEN) || ''
      items.push(
        `<li><span class="rm-cn">${calloutN}.</span> ${esc(text) || '<span class="rm-empty">—</span>'}</li>`,
      )
    } else if (a.type === 'note') {
      const text = (language === 'es' ? a.textES : a.textEN) || ''
      const label = language === 'es' ? 'Nota' : 'Note'
      items.push(
        `<li><span class="rm-cn rm-cn-note">${label}:</span> ${esc(text) || '<span class="rm-empty">—</span>'}</li>`,
      )
    }
  }
  if (items.length === 0) return ''
  return `<ol class="rm-callouts-list">${items.join('')}</ol>`
}

// Materials row in footer — one chip per layer that contributes shapes.
function buildMaterialsRowHtml(sequence, layers) {
  const contrib = computeContributingLayers(sequence, layers)
  if (contrib.length === 0) return '<div class="rm-materials"></div>'
  const chips = contrib.map((layer) => (
    `<span class="rm-material-chip">`
    + `<span class="rm-material-swatch" style="background:${esc(layer.color || '#888')}"></span>`
    + `<span class="rm-material-label">${esc(layer.name || 'Layer')}</span>`
    + '</span>'
  )).join('')
  return `<div class="rm-materials">${chips}</div>`
}

// Build the complete hidden DOM for html2pdf — one .rm-pdf-page section per
// sequence. POST-VERIFICATION FIX: each page is laid out at FIXED PIXEL
// dimensions matching A4 at 96 DPI, with absolutely-positioned sections
// so the layout doesn't depend on viewport height or flex calculations
// that html2canvas can mis-capture for off-screen elements.
//
// Page sections (top to bottom in absolute positioning):
//   header   — 0..HEADER_H px (KCC navy bar with orange accent stripe)
//   photo    — HEADER_H..(pageH - CALLOUTS_H - FOOTER_H) px
//   callouts — bottom-of-photo..(pageH - FOOTER_H) px
//   footer   — (pageH - FOOTER_H)..pageH px (materials + metadata)
export function buildPdfPageDom({
  project, language, photoImage, photoMeta, layers, clines, sequences,
  jobAddress, generatedYMD, orientation,
}) {
  const pageW = orientation === 'landscape' ? PAGE_LANDSCAPE_W : PAGE_PORTRAIT_W
  const pageH = orientation === 'landscape' ? PAGE_LANDSCAPE_H : PAGE_PORTRAIT_H
  const photoTop = HEADER_H
  const photoH   = pageH - HEADER_H - CALLOUTS_H - FOOTER_H
  const calloutsTop = pageH - CALLOUTS_H - FOOTER_H
  const footerTop = pageH - FOOTER_H

  const root = document.createElement('div')
  root.className = 'rm-pdf-root'
  root.style.cssText = (
    `width:${pageW}px;`
    + `background:#ffffff;color:#0d1117;`
    + `font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;`
  )

  const totalSeqs = sequences.length
  const langLabel = language === 'es' ? 'Español' : 'English'

  sequences.forEach((seq, idx) => {
    const page = document.createElement('section')
    page.className = 'rm-pdf-page'
    page.style.cssText = (
      `position:relative;`
      + `box-sizing:border-box;`
      + `width:${pageW}px;`
      + `height:${pageH}px;`
      + `overflow:hidden;`
      + `background:#ffffff;`
      + (idx > 0 ? 'page-break-before:always;break-before:page;' : '')
    )

    // Render the offscreen canvas at print resolution. We get back the
    // canvas, dataURL, and natural pixel dims so the embedded <img> has
    // explicit width/height attributes (forces synchronous layout — no
    // race with html2canvas's snapshot pass).
    const rendered = renderSequenceImage({
      sequence: seq,
      layers,
      clines,
      photoImage,
      photoMeta,
      language,
      clinesVisible: project?.clinesVisible !== false,
    })
    const seqTitle = esc(seq.title || `S${idx + 1}`)

    // Header bar (Spec §13.8) — absolutely positioned at top of page.
    const headerHtml = (
      `<header style="`
      + `position:absolute;left:0;top:0;width:${pageW}px;height:${HEADER_H}px;`
      + `background:${KCC_NAVY};color:#ffffff;`
      + `border-bottom:3px solid ${KCC_ORANGE};`
      + `box-sizing:border-box;`
      + `padding:8px 16px;`
      + `display:flex;align-items:center;justify-content:space-between;gap:16px;`
      + `font-size:11px;line-height:1.2;`
      + `">`
        + `<div style="display:flex;flex-direction:column;min-width:0;">`
          + `<span style="font-size:16px;font-weight:800;letter-spacing:0.5px;">KCC</span>`
          + `<span style="font-size:9px;opacity:0.85;">Kosarek Construction Company</span>`
        + `</div>`
        + `<div style="flex:1;text-align:center;font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">`
          + `${esc(jobAddress || '—')}`
        + `</div>`
        + `<div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;min-width:0;">`
          + `<span style="font-weight:700;">${seqTitle}</span>`
          + `<span style="opacity:0.85;">Sequence ${idx + 1} of ${totalSeqs} · ${langLabel} · ${esc(generatedYMD)}</span>`
        + `</div>`
      + `</header>`
    )

    // Photo section — absolutely positioned. <img> has explicit
    // width/height attributes so the layout settles before html2canvas
    // captures (the previous version relied on natural-dim resolution
    // which sometimes captured as 0×0).
    let photoInner = '<div style="color:#fff;">No photo loaded.</div>'
    if (rendered) {
      // Compute object-fit-contain dims for the natural canvas dataURL.
      const containerRatio = pageW / photoH
      const photoRatio = rendered.width / rendered.height
      let drawW, drawH
      if (photoRatio > containerRatio) {
        drawW = pageW
        drawH = Math.round(pageW / photoRatio)
      } else {
        drawH = photoH
        drawW = Math.round(photoH * photoRatio)
      }
      photoInner = (
        `<img src="${rendered.dataURL}" `
        + `width="${drawW}" height="${drawH}" `
        + `style="display:block;width:${drawW}px;height:${drawH}px;" `
        + `alt="" />`
      )
    }
    const photoHtml = (
      `<div style="`
      + `position:absolute;left:0;top:${photoTop}px;width:${pageW}px;height:${photoH}px;`
      + `background:#0d1117;`
      + `display:flex;align-items:center;justify-content:center;`
      + `overflow:hidden;`
      + `">`
        + photoInner
      + `</div>`
    )

    // Callouts list (Spec §13.7 step 3)
    const calloutsHtml = (
      `<div style="`
      + `position:absolute;left:0;top:${calloutsTop}px;width:${pageW}px;height:${CALLOUTS_H}px;`
      + `box-sizing:border-box;`
      + `padding:8px 16px;font-size:10px;line-height:1.4;`
      + `border-top:1px solid #d0d4dc;`
      + `overflow:hidden;`
      + `">`
        + buildCalloutsListHtml(seq, language)
      + `</div>`
    )

    // Footer (Spec §13.9): materials row on top, metadata row on bottom.
    const footerHtml = (
      `<footer style="`
      + `position:absolute;left:0;top:${footerTop}px;width:${pageW}px;height:${FOOTER_H}px;`
      + `box-sizing:border-box;`
      + `border-top:1px solid #d0d4dc;`
      + `font-size:9px;`
      + `">`
        + `<div style="padding:6px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;height:30px;overflow:hidden;">`
          + buildMaterialsRowHtml(seq, layers)
        + `</div>`
        + `<div style="padding:6px 16px;display:flex;justify-content:space-between;border-top:1px solid #e5e8ee;color:#5b6478;">`
          + `<span>${esc(jobAddress || '—')}</span>`
          + `<span>${esc(generatedYMD)}</span>`
        + `</div>`
      + `</footer>`
    )

    page.innerHTML = headerHtml + photoHtml + calloutsHtml + footerHtml
    root.appendChild(page)
  })

  // Inline styles applied directly to elements above; the only class-based
  // styling left is the callouts list + materials chip. Keep that as a
  // dedicated <style> tag so the small number of class rules don't clutter
  // every per-element style attribute.
  const styleTag = document.createElement('style')
  styleTag.textContent = (
    '.rm-callouts-list { margin: 0; padding-left: 18px; list-style: decimal; }'
    + ' .rm-callouts-list li { margin: 0 0 2px 0; padding: 0; }'
    + ' .rm-cn { font-weight: 700; margin-right: 4px; color: ' + KCC_NAVY + '; }'
    + ' .rm-cn-note { color: ' + KCC_ORANGE + '; }'
    + ' .rm-empty { color: #8a93a4; font-style: italic; }'
    + ' .rm-material-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px 1px 2px; border: 1px solid #d0d4dc; border-radius: 10px; background: #ffffff; }'
    + ' .rm-material-swatch { width: 10px; height: 10px; border-radius: 2px; border: 1px solid #999; display: inline-block; }'
    + ' .rm-material-label { font-size: 9px; color: #1a3a5c; }'
  )
  root.insertBefore(styleTag, root.firstChild)
  return root
}

// Smart filename composition. Re-exports composeFilename under the spec's
// canonical name for caller readability.
export const buildPdfFilename = composeFilename

// Public entry point — renders + downloads a PDF for the active project.
//
//   options:
//     project          { layers, sequences, clines, jobContext, photoMeta }
//     language         'en' | 'es'
//     orientationPref  'auto' | 'portrait' | 'landscape'
//     photoImage       HTMLImageElement (already loaded; caller awaits)
//
// Returns: the html2pdf worker promise (resolves when download triggered).
export async function exportProjectPDF({ project, language, orientationPref = 'auto', photoImage }) {
  if (!project) throw new Error('No project to export')
  const { layers = [], sequences = [], clines = [], jobContext, photoMeta } = project
  if (sequences.length === 0) throw new Error('Add at least one sequence to export.')
  if (!photoMeta) throw new Error('Load a photo before exporting.')

  const orientation = computePageOrientation(orientationPref, photoMeta)
  const generatedYMD = formatLocalYMD(new Date())
  const jobAddress = jobContext?.address || ''

  const root = buildPdfPageDom({
    project,
    language,
    photoImage,
    photoMeta,
    layers,
    clines,
    sequences,
    jobAddress,
    generatedYMD,
    orientation,
  })

  // POST-VERIFICATION FIX (May 8 2026 — Checks 2/3 FAIL on initial deploy):
  // Mount root in the document at top-left position 0,0 with absolute
  // positioning + opacity 0 so html2canvas can capture the layout
  // correctly. Previous version used `position:fixed` + `left:-99999px`
  // which html2canvas occasionally captured as blank because off-viewport
  // fixed elements have unreliable layout calculation.
  //
  // Top-left absolute + opacity 0 keeps the element invisible while in
  // normal document flow (html2canvas reads layout from there). z-index
  // -1 + pointer-events: none ensures it can't intercept clicks even
  // briefly during the snapshot pass.
  root.style.position = 'absolute'
  root.style.left = '0'
  root.style.top = '0'
  root.style.opacity = '0'
  root.style.pointerEvents = 'none'
  root.style.zIndex = '-1'
  document.body.appendChild(root)

  // Wait two animation frames so the browser has computed layout for the
  // newly-inserted DOM (image natural-dim resolution + flex/abs-pos
  // calculations) before html2canvas snapshots. Single rAF can fire
  // before the second layout pass on some browsers; double rAF is the
  // standard pattern for "DOM is fully painted".
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  const filename = composeFilename({
    language,
    jobAddress,
    date: new Date(),
  })

  try {
    // Lazy-load html2pdf.js on first export so the ~700 KB library lives
    // in its own Vite chunk instead of the main bundle.
    const html2pdfModule = await import('html2pdf.js')
    const html2pdf = html2pdfModule.default || html2pdfModule
    const opt = {
      margin: 0,
      filename,
      image: { type: 'jpeg', quality: 0.92 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        // POST-VERIFICATION FIX: tell html2canvas the explicit width/height
        // of the source element (matches the DOM's fixed-px page size) so
        // it doesn't fall back to viewport dims. logging:false silences the
        // library's verbose console output during normal exports.
        logging: false,
        width: orientation === 'landscape' ? PAGE_LANDSCAPE_W : PAGE_PORTRAIT_W,
        // height is derived from the captured element's bounding rect
        // (multi-page document — html2canvas handles the full element).
      },
      jsPDF: { unit: 'mm', format: 'a4', orientation },
      pagebreak: { mode: ['css', 'legacy'], before: '.rm-pdf-page' },
    }
    await html2pdf().from(root).set(opt).save()
  } finally {
    if (root.parentNode) root.parentNode.removeChild(root)
  }
}
