import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Step 12 partial-completion fix — operator-visible build marker so the
// status bar can confirm "I'm on build XYZ" matches the deployed version.
// Falls back to a timestamp if not in a git context.
function buildMarker() {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim()
    return sha
  } catch {
    return 'dev-' + String(Date.now()).slice(-6)
  }
}

// GitHub Pages serves this app at https://briana-sudo.github.io/roofmark/
// — base must match the repo subpath so asset URLs resolve correctly.
export default defineConfig({
  plugins: [react()],
  base: '/roofmark/',
  define: {
    __BUILD_SHA__: JSON.stringify(buildMarker()),
  },
})
