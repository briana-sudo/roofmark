import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves this app at https://briana-sudo.github.io/roofmark/
// — base must match the repo subpath so asset URLs resolve correctly.
export default defineConfig({
  plugins: [react()],
  base: '/roofmark/',
})
