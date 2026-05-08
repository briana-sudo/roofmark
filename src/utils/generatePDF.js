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

// Render one sequence's photo+annotations to a dataURL via offscreen canvas.
// `photoImage` is the operator's working photo HTMLImageElement (loaded by
// caller before invoking exportProjectPDF). Returns a 'image/png' data URL.
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
  return canvas.toDataURL('image/png')
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
// sequence. Inline styles (no CSS reliance) so html2pdf's html2canvas pass
// captures everything correctly.
export function buildPdfPageDom({
  project, language, photoImage, photoMeta, layers, clines, sequences,
  jobAddress, generatedYMD,
}) {
  const root = document.createElement('div')
  root.className = 'rm-pdf-root'
  root.style.cssText = (
    'background:#ffffff;color:#0d1117;'
    + 'font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;'
  )

  const totalSeqs = sequences.length
  const langLabel = language === 'es' ? 'Español' : 'English'

  sequences.forEach((seq, idx) => {
    const page = document.createElement('section')
    page.className = 'rm-pdf-page'
    // page-break-before:always EXCEPT for the first page (Spec §13.5)
    page.style.cssText = (
      'box-sizing:border-box;'
      + 'width:100%;'
      + 'min-height:100vh;'
      + 'display:flex;flex-direction:column;'
      + 'padding:0;'
      + (idx > 0 ? 'page-break-before:always;break-before:page;' : '')
    )

    // Render the offscreen canvas at print resolution; embed as <img>
    const imgDataUrl = renderSequenceImage({
      sequence: seq,
      layers,
      clines,
      photoImage,
      photoMeta,
      language,
      clinesVisible: project?.clinesVisible !== false,
    })

    // Header bar (Spec §13.8)
    const seqTitle = esc(seq.title || `S${idx + 1}`)
    const headerHtml = (
      `<header class="rm-pdf-header" style="`
      + `background:${KCC_NAVY};color:#ffffff;`
      + `border-bottom:3px solid ${KCC_ORANGE};`
      + `padding:8px 16px 6px 16px;`
      + `display:flex;align-items:center;justify-content:space-between;gap:16px;`
      + `font-size:11px;line-height:1.2;`
      + `">`
        + `<div class="rm-pdf-brand" style="display:flex;flex-direction:column;min-width:0;">`
          + `<span style="font-size:14px;font-weight:800;letter-spacing:0.3px;">KCC</span>`
          + `<span style="font-size:9px;opacity:0.85;">Kosarek Construction Company</span>`
        + `</div>`
        + `<div class="rm-pdf-address" style="flex:1;text-align:center;font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">`
          + `${esc(jobAddress || '—')}`
        + `</div>`
        + `<div class="rm-pdf-meta" style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;min-width:0;">`
          + `<span style="font-weight:700;">${seqTitle}</span>`
          + `<span style="opacity:0.85;">Sequence ${idx + 1} of ${totalSeqs} · ${langLabel} · ${esc(generatedYMD)}</span>`
        + `</div>`
      + `</header>`
    )

    // Photo section. The img is sized to fill the available width while
    // preserving aspect ratio. Background fill in case the photo is missing.
    const photoHtml = (
      `<div class="rm-pdf-photo" style="`
      + `flex:1 1 auto;display:flex;align-items:center;justify-content:center;`
      + `background:#0d1117;padding:12px;`
      + `">`
        + (imgDataUrl
          ? `<img src="${imgDataUrl}" style="max-width:100%;max-height:100%;object-fit:contain;display:block;" alt="" />`
          : `<div style="color:#fff;font-size:14px;">No photo loaded.</div>`)
      + `</div>`
    )

    // Callouts list (Spec §13.7 step 3)
    const calloutsHtml = (
      `<div class="rm-pdf-callouts" style="`
      + `padding:8px 16px;font-size:10px;line-height:1.4;`
      + `border-top:1px solid #d0d4dc;`
      + `">`
        + buildCalloutsListHtml(seq, language)
      + `</div>`
    )

    // Footer (Spec §13.9): materials row on top, metadata row on bottom.
    const footerHtml = (
      `<footer class="rm-pdf-footer" style="`
      + `border-top:1px solid #d0d4dc;`
      + `font-size:9px;`
      + `">`
        + `<div style="padding:6px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">`
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

  // Add inline list style so html2canvas picks up the visual treatment.
  const styleTag = document.createElement('style')
  styleTag.textContent = (
    '.rm-callouts-list { margin: 0; padding-left: 18px; }'
    + ' .rm-callouts-list li { margin: 0 0 2px 0; padding: 0; }'
    + ' .rm-cn { font-weight: 700; margin-right: 4px; color: ' + KCC_NAVY + '; }'
    + ' .rm-cn-note { color: ' + KCC_ORANGE + '; }'
    + ' .rm-empty { color: #8a93a4; font-style: italic; }'
    + ' .rm-material-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px 1px 2px; border: 1px solid #d0d4dc; border-radius: 10px; }'
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
  })

  // Mount root off-screen but in the document so html2canvas can compute
  // styles + layout. Position fixed bottom-right with -9999 offset keeps it
  // out of the operator's view while preserving layout fidelity.
  root.style.position = 'fixed'
  root.style.left = '-99999px'
  root.style.top = '-99999px'
  root.style.width = orientation === 'landscape' ? '297mm' : '210mm'
  document.body.appendChild(root)

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
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation },
      pagebreak: { mode: ['css', 'legacy'], before: '.rm-pdf-page' },
    }
    await html2pdf().from(root).set(opt).save()
  } finally {
    if (root.parentNode) root.parentNode.removeChild(root)
  }
}
