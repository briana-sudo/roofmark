// Node-side runner for the Step 17 block test pure-JS body. Extracts
// the <script> block from step-17-functional.html, replaces the
// DOM-render epilogue with a console summary, and exits 0 on full PASS.
const fs = require('fs')
const path = require('path')

const html = fs.readFileSync(path.join(__dirname, 'step-17-functional.html'), 'utf8')
const m = html.match(/<script>([\s\S]*?)<\/script>/)
if (!m) { console.error('No <script> block'); process.exit(1) }
let body = m[1]

// Replace the DOM render block.
body = body.replace(/\/\/ ---- Render summary ----[\s\S]*$/, `
const passCount = tests.filter(t => t.ok).length
const total = tests.length
console.log(passCount + '/' + total + ' ' + (passCount === total ? 'PASS' : 'FAIL'))
for (const t of tests) {
  if (!t.ok) console.log('FAIL: ' + t.name + (t.extra ? ' ' + JSON.stringify(t.extra) : ''))
}
process.exit(passCount === total ? 0 : 1)
`)

eval(body)
