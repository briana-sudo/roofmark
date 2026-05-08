// ============================================================================
// slugify.js — Step 16 (May 8 2026)
//
// Lower-snake-with-dashes slug for use in PDF filenames. Pure function;
// no DOM deps. Matches Spec §13 amendment 13.4 — smart filename for the
// PDF auto-download:
//
//   roofmark-<language>-<job-address-slug>-YYYY-MM-DD.pdf
//
// Examples:
//   slugify("123 Maple St")         → "123-maple-st"
//   slugify("1234 Main St., Apt #5") → "1234-main-st-apt-5"
//   slugify("")                      → ""
//   slugify(null)                    → ""
//   slugify("   spaces  ")           → "spaces"
//
// Behavior:
//   - lowercase
//   - alphanumeric + dashes only (everything else → dash)
//   - collapse runs of dashes
//   - trim leading/trailing dashes
//   - cap at 40 characters (spec)
// ============================================================================
export function slugify(input) {
  if (input == null) return ''
  const s = String(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics (e.g. á → a)
    .replace(/[^a-z0-9]+/g, '-')        // anything non-alphanumeric → dash
    .replace(/^-+|-+$/g, '')            // trim leading/trailing dashes
    .replace(/-+/g, '-')                // collapse multiple dashes
  return s.slice(0, 40).replace(/-+$/g, '')   // hard cap + trim
}

// Format a Date as YYYY-MM-DD in the LOCAL timezone (operator's date for the
// filename matches the date on the operator's clock — not UTC midnight off
// by a day for late-evening exports).
export function formatLocalYMD(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Compose the smart filename per spec §13.4.
//   composeFilename({ language: 'english', jobAddress: '123 Maple St' })
//     → 'roofmark-english-123-maple-st-2026-05-08.pdf'
//   composeFilename({ language: 'spanish', jobAddress: '' })
//     → 'roofmark-spanish-2026-05-08.pdf'
//   composeFilename({ language: 'english' })  // missing jobAddress
//     → 'roofmark-english-2026-05-08.pdf'
export function composeFilename({ language, jobAddress, date }) {
  const lang = language === 'es' || language === 'spanish' ? 'spanish' : 'english'
  const slug = slugify(jobAddress)
  const ymd = formatLocalYMD(date instanceof Date ? date : new Date())
  const segments = ['roofmark', lang]
  if (slug) segments.push(slug)
  segments.push(ymd)
  return `${segments.join('-')}.pdf`
}
