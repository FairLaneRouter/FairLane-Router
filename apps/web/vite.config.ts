import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * On GitHub Pages the app lives under `/<repo-name>/app/`, below the landing
 * page at the site root; without the prefix the bundle asks for `/assets/…` at
 * the domain root and gets 404. The value comes from the workflow
 * (`BASE_PATH`); in development it stays `/`.
 */
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
