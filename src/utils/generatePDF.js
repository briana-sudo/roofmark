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

// PDF page renders at fixed pixel dimensions matching A4 at 96 DPI so the
// DOM layout corresponds to physical PDF page size. html2pdf scales these
// px to the PDF's mm format at output time.
//
// POST-VERIFICATION FIX (May 8 2026 — blank-pages-between-content):
// Section height shaved 3 px below the exact A4-at-96-DPI conversion
// (1123 → 1120) so mm↔px rounding fuzz can NEVER overflow into a
// fragment page. Without this buffer, each section ended up producing
// a tiny fragment on a second PDF page — combined with the legacy
// pagebreak.before selector (now removed), this generated 8 pages for
// 3 sequences with content only on pages 2, 5, 8.
//
//   A4 portrait at 96 DPI: 793.7 × 1122.5 px (theoretical)
//   Our page dimensions  : 794 × 1120 px (3-px buffer)
//   A4 landscape         : 1120 × 794 px (same buffer rotated)
const PAGE_PORTRAIT_W  = 794
const PAGE_PORTRAIT_H  = 1120
const PAGE_LANDSCAPE_W = 1120
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
  if (!photoMeta) {
    dbgLog('renderSequenceImage: no photoMeta — returning null')
    return null
  }
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
  // Sample center pixel to verify the canvas actually has content
  const ctx = canvas.getContext('2d')
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2)
  const px = ctx.getImageData(cx, cy, 1, 1).data
  const dataURL = canvas.toDataURL('image/png')
  dbgLog(`renderSequenceImage seq=${sequence?.id} ${W}×${H}, center px rgba=[${px[0]},${px[1]},${px[2]},${px[3]}], dataURL.length=${dataURL.length}`)
  if (typeof window !== 'undefined' && window.__debugPDF) {
    window.__debugPDF.lastCanvas = canvas
    window.__debugPDF.lastCanvasDataURL = dataURL.substring(0, 100)
    window.__debugPDF.lastCanvasCenterPixel = [px[0], px[1], px[2], px[3]]
  }
  return { canvas, dataURL, width: W, height: H }
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

// Build the complete DOM for html2pdf — one .rm-pdf-page section per
// sequence.
//
// POST-DIAGNOSTIC FIX (May 8 2026, third attempt):
// Operator instrumentation confirmed html2canvas does NOT reliably
// capture absolutely-positioned content — even when in-viewport. The
// minimal repro (root with `position: absolute; left: 0; top: 0`)
// also produced blank PDFs.
//
// New strategy: NORMAL DOCUMENT FLOW. No positioning trickery at all.
// - Root: plain block, width set
// - Each .rm-pdf-page: flexbox column with explicit width + height
// - Each section (header / photo / callouts / footer): explicit height
//   + flex-shrink: 0 so the column doesn't compress
// - Page breaks via `page-break-after: always` + `break-after: page`
// - Root mounted to body in natural flow (accepts brief visual flash
//   during capture — that's the documented html2pdf.js usage pattern)
//
// Page dimensions: 794×1123 portrait / 1123×794 landscape (A4 @ 96 DPI).
export function buildPdfPageDom({
  project, language, photoImage, photoMeta, layers, clines, sequences,
  jobAddress, generatedYMD, orientation,
}) {
  const pageW = orientation === 'landscape' ? PAGE_LANDSCAPE_W : PAGE_PORTRAIT_W
  const pageH = orientation === 'landscape' ? PAGE_LANDSCAPE_H : PAGE_PORTRAIT_H
  const photoH = pageH - HEADER_H - CALLOUTS_H - FOOTER_H

  // Root is plain document flow — no positioning. Width fixed; height
  // grows naturally as pages stack.
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
    // Each page: flex column with explicit width + height. No positioning.
    // Children stack top-to-bottom via flex-direction. Each child has
    // explicit height + flex-shrink:0 so the column doesn't compress.
    const page = document.createElement('section')
    page.className = 'rm-pdf-page'
    page.style.cssText = (
      `width:${pageW}px;`
      + `height:${pageH}px;`
      + `display:flex;`
      + `flex-direction:column;`
      + `box-sizing:border-box;`
      + `background:#ffffff;`
      + `overflow:hidden;`
      + (idx < totalSeqs - 1
        ? 'page-break-after:always;break-after:page;'
        : '')
    )

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

    // Header bar — fixed height, no positioning.
    const headerHtml = (
      `<header style="`
      + `width:${pageW}px;height:${HEADER_H}px;flex-shrink:0;`
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

    // Photo section — fixed height, flex container for centering the img.
    let photoInner = '<div style="color:#fff;">No photo loaded.</div>'
    if (rendered) {
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
      + `width:${pageW}px;height:${photoH}px;flex-shrink:0;`
      + `background:#0d1117;`
      + `display:flex;align-items:center;justify-content:center;`
      + `overflow:hidden;`
      + `">`
        + photoInner
      + `</div>`
    )

    // Callouts list (Spec §13.7 step 3) — fixed height.
    const calloutsHtml = (
      `<div style="`
      + `width:${pageW}px;height:${CALLOUTS_H}px;flex-shrink:0;`
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
      + `width:${pageW}px;height:${FOOTER_H}px;flex-shrink:0;`
      + `box-sizing:border-box;`
      + `border-top:1px solid #d0d4dc;`
      + `font-size:9px;`
      + `display:flex;flex-direction:column;`
      + `">`
        + `<div style="padding:6px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;height:30px;flex-shrink:0;overflow:hidden;">`
          + buildMaterialsRowHtml(seq, layers)
        + `</div>`
        + `<div style="padding:6px 16px;display:flex;justify-content:space-between;border-top:1px solid #e5e8ee;color:#5b6478;flex-shrink:0;">`
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

// ----------------------------------------------------------------------------
// DIAGNOSTIC INSTRUMENTATION (May 8 2026 — Step 16 blank-PDF investigation).
// Set window.__debugPDF.verbose = true OR pass `debug: true` in options to
// emit console logs at every pipeline stage AND retain the rendered DOM
// after export so the operator can inspect it in the Elements panel.
//
// Operator workflow:
//   1. Open DevTools → Console.
//   2. Run: window.__debugPDF.verbose = true
//   3. Click ⋮ → Export English PDF as usual.
//   4. Read the console — every stage logs `[PDF] <stage>` + relevant data.
//   5. After the export completes (or fails), inspect:
//        window.__debugPDF.lastCanvas       — offscreen canvas (in memory)
//        window.__debugPDF.lastCanvasDataURL — first 100 chars of dataURL
//        window.__debugPDF.lastRoot         — root DOM element (still in document if keepDOM=true)
//        window.__debugPDF.lastRootRect     — bounding rect at snapshot time
//        window.__debugPDF.lastImg          — first <img> in the rendered page
//        window.__debugPDF.lastImgRect      — bounding rect of that <img>
//
// Minimal-repro path:
//   await window.__debugPDF.runMinimalRepro()
//     → hardcodes a 100×60 red square canvas, builds a 200x140 page DOM
//       with just the image, runs html2pdf. If THAT comes out blank, the
//       bug is in html2pdf integration, not in the photo render or
//       full-page DOM structure.
// ----------------------------------------------------------------------------
if (typeof window !== 'undefined' && !window.__debugPDF) {
  window.__debugPDF = {
    verbose: false,
    keepDOM: false,
    lastCanvas: null,
    lastCanvasDataURL: '',
    lastRoot: null,
    lastRootRect: null,
    lastImg: null,
    lastImgRect: null,
    lastError: null,
  }
}
function dbgLog(...args) {
  if (typeof window !== 'undefined' && window.__debugPDF?.verbose) {
    console.log('[PDF]', ...args)
  }
}

// Minimal repro — bypasses full pipeline. If THIS produces a blank PDF, the
// bug is in html2pdf integration. If this works, the bug is somewhere in
// the full-page-DOM orchestration.
async function runMinimalRepro() {
  console.log('[PDF-minimal-repro] start')
  // 1. Build a tiny 100×60 canvas with a red square + black text.
  const canvas = document.createElement('canvas')
  canvas.width = 200
  canvas.height = 120
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#dc2626'
  ctx.fillRect(0, 0, 200, 120)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 24px sans-serif'
  ctx.fillText('REPRO TEST', 24, 70)
  const dataURL = canvas.toDataURL('image/png')
  console.log('[PDF-minimal-repro] canvas dataURL length:', dataURL.length)
  console.log('[PDF-minimal-repro] canvas dataURL preview:', dataURL.substring(0, 80))

  // 2. Build the smallest possible DOM tree: a div with the image inside.
  const root = document.createElement('div')
  root.style.cssText = 'width:300px;height:200px;background:#ffffff;padding:20px;'
  root.innerHTML = (
    `<h2 style="font-family:sans-serif;color:#1a3a5c;">Minimal repro</h2>`
    + `<img src="${dataURL}" width="200" height="120" style="display:block;border:2px solid #1a3a5c;" alt="" />`
    + `<p style="font-family:sans-serif;color:#0d1117;">If you see this text + the red REPRO TEST image, the html2pdf integration works.</p>`
  )
  // Mount to document body, top-left, fully visible (operator can see briefly).
  root.style.position = 'absolute'
  root.style.left = '0'
  root.style.top = '0'
  root.style.zIndex = '99999'
  document.body.appendChild(root)
  console.log('[PDF-minimal-repro] DOM mounted, rect:', root.getBoundingClientRect())

  // 3. Wait two rAFs for layout, then run html2pdf.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  console.log('[PDF-minimal-repro] post-rAF rect:', root.getBoundingClientRect())

  // 4. html2pdf with minimal options.
  try {
    const html2pdfModule = await import('html2pdf.js')
    const html2pdf = html2pdfModule.default || html2pdfModule
    console.log('[PDF-minimal-repro] html2pdf loaded:', typeof html2pdf)
    await html2pdf()
      .from(root)
      .set({
        margin: 10,
        filename: 'roofmark-minimal-repro.pdf',
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: { scale: 2, logging: true, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a5', orientation: 'portrait' },
      })
      .save()
    console.log('[PDF-minimal-repro] success — file should have downloaded')
  } catch (err) {
    console.error('[PDF-minimal-repro] FAILED:', err)
  } finally {
    if (root.parentNode) root.parentNode.removeChild(root)
  }
}
if (typeof window !== 'undefined' && window.__debugPDF) {
  window.__debugPDF.runMinimalRepro = runMinimalRepro
}

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
  dbgLog('exportProjectPDF — start', {
    language, orientation, generatedYMD, jobAddress,
    sequenceCount: sequences.length,
    photoMeta,
    photoImageReady: !!(photoImage && photoImage.complete && photoImage.naturalWidth > 0),
  })

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
  dbgLog('exportProjectPDF — root built, child count:', root.children.length)
  // Capture diagnostic state for window.__debugPDF.
  if (typeof window !== 'undefined' && window.__debugPDF) {
    window.__debugPDF.lastRoot = root
    // Find the first canvas dataURL <img> embedded inside (sequence 1's photo)
    const firstImg = root.querySelector('img')
    window.__debugPDF.lastImg = firstImg
    if (firstImg) {
      const src = firstImg.getAttribute('src') || ''
      window.__debugPDF.lastCanvasDataURL = src.substring(0, 100)
      dbgLog('first <img> src length:', src.length, 'starts with:', src.substring(0, 80))
    } else {
      dbgLog('NO <img> found in root — photo render returned null')
    }
  }

  // POST-DIAGNOSTIC FIX (May 8 2026, third attempt):
  // Operator instrumentation confirmed html2canvas blanks ALL absolutely-
  // positioned content — both at off-screen and in-viewport positions.
  // Even the minimal repro (position:absolute; left:0; top:0; z-index:99999)
  // produced a blank PDF. The bug is the absolute positioning itself, not
  // its location.
  //
  // New strategy: NORMAL DOCUMENT FLOW. Append root to body without any
  // positioning manipulation. html2pdf.js documentation shows this exact
  // pattern as the canonical usage. Operator briefly sees the rendered
  // pages flash at the bottom of the page during capture (~100-300ms);
  // the DOM is removed immediately after html2pdf.save() resolves.
  //
  // No opacity, no visibility manipulation, no positioning — these all
  // had problems with html2canvas's clone+render pass.
  document.body.appendChild(root)
  dbgLog('root mounted in normal flow, rect:', root.getBoundingClientRect())

  // Wait two animation frames so the browser has computed layout for the
  // newly-inserted DOM (image natural-dim resolution + flex/abs-pos
  // calculations) before html2canvas snapshots.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  dbgLog('post-rAF, rect:', root.getBoundingClientRect())

  // Force ALL embedded <img> elements to fully decode before html2pdf
  // snapshot. img.decode() is the modern way to await image-ready state
  // (more reliable than the onload event for dataURL <img>s).
  const imgs = Array.from(root.querySelectorAll('img'))
  dbgLog(`waiting for ${imgs.length} <img> elements to decode...`)
  await Promise.all(imgs.map(async (img, i) => {
    try {
      if (typeof img.decode === 'function') {
        await img.decode()
        dbgLog(`  img[${i}] decoded — natural ${img.naturalWidth}×${img.naturalHeight}, complete=${img.complete}`)
      } else if (!img.complete) {
        // Fallback for old browsers
        await new Promise((res) => { img.onload = res; img.onerror = res })
      }
    } catch (e) {
      dbgLog(`  img[${i}] decode failed:`, e?.message)
    }
  }))

  // Capture final state for diagnostic inspection
  if (typeof window !== 'undefined' && window.__debugPDF) {
    window.__debugPDF.lastRootRect = root.getBoundingClientRect()
    const firstImg = imgs[0]
    if (firstImg) {
      window.__debugPDF.lastImgRect = firstImg.getBoundingClientRect()
      dbgLog('first img rect after decode:', window.__debugPDF.lastImgRect)
    }
  }

  const filename = composeFilename({
    language,
    jobAddress,
    date: new Date(),
  })

  // DIAGNOSTIC: optionally run html2canvas DIRECTLY on the root before
  // letting html2pdf orchestrate it. This isolates whether html2canvas
  // captures content or returns blank. Operator can inspect the captured
  // canvas via window.__debugPDF.lastHtml2canvasOutput.
  if (typeof window !== 'undefined' && window.__debugPDF?.verbose) {
    try {
      const html2pdfMod = await import('html2pdf.js')
      // html2canvas is bundled with html2pdf.js — access via window
      // (html2pdf attaches it on import).
      const _h2c = (typeof window.html2canvas === 'function') ? window.html2canvas : null
      if (_h2c) {
        dbgLog('running html2canvas directly to inspect snapshot...')
        const captured = await _h2c(root, { scale: 1, useCORS: true, backgroundColor: '#ffffff', logging: true })
        window.__debugPDF.lastHtml2canvasOutput = captured
        dbgLog(`html2canvas direct: ${captured.width}×${captured.height}`)
        // Sample center-pixel color to detect "all white" / "all transparent"
        const cctx = captured.getContext('2d')
        const px = cctx.getImageData(Math.floor(captured.width / 2), Math.floor(captured.height / 2), 1, 1).data
        dbgLog(`center pixel rgba: [${px[0]}, ${px[1]}, ${px[2]}, ${px[3]}]`)
      } else {
        dbgLog('html2canvas not exposed on window — relying on html2pdf only')
      }
      void html2pdfMod
    } catch (e) {
      dbgLog('html2canvas direct probe failed:', e?.message)
    }
  }

  try {
    // Lazy-load html2pdf.js on first export so the ~700 KB library lives
    // in its own Vite chunk instead of the main bundle.
    const html2pdfModule = await import('html2pdf.js')
    const html2pdf = html2pdfModule.default || html2pdfModule
    dbgLog('html2pdf loaded, beginning save flow')
    const opt = {
      margin: 0,
      filename,
      image: { type: 'jpeg', quality: 0.92 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: !!(typeof window !== 'undefined' && window.__debugPDF?.verbose),
        // Drop the explicit width — html2canvas may use it to clip to
        // viewport rather than capturing the full element. Let html2canvas
        // read element width from getBoundingClientRect.
      },
      jsPDF: { unit: 'mm', format: 'a4', orientation },
      // POST-VERIFICATION FIX (May 8 2026 — blank-pages-between-content):
      // Drop the legacy `before: '.rm-pdf-page'` selector. It was inserting
      // a forced page break BEFORE every section — including section 1,
      // producing a leading blank page. Combined with the per-section
      // page-break-after CSS rule, this caused 1 leading blank + 2 trailing
      // blanks per section between content pages.
      // New config: CSS mode only (respects `page-break-after: always`
      // already present on each section but the last) + `avoid:
      // '.rm-pdf-page'` to keep html2pdf from splitting a single section
      // across multiple PDF pages mid-content.
      pagebreak: { mode: ['css'], avoid: '.rm-pdf-page' },
    }
    await html2pdf().from(root).set(opt).save()
    dbgLog('html2pdf save complete')
  } catch (err) {
    dbgLog('html2pdf save FAILED:', err)
    if (typeof window !== 'undefined' && window.__debugPDF) {
      window.__debugPDF.lastError = err
    }
    throw err
  } finally {
    // Retain DOM in document if debug.keepDOM is true so operator can
    // inspect via Elements panel. Default behavior: remove after export.
    const keepDOM = typeof window !== 'undefined' && window.__debugPDF?.keepDOM
    if (root.parentNode && !keepDOM) {
      root.parentNode.removeChild(root)
    } else if (keepDOM) {
      dbgLog('keepDOM=true — root retained in document.body for inspection')
      // Move it back to the top-left visibly so operator can see it
      root.style.left = '0'
      root.style.zIndex = '99999'
    }
  }
}
