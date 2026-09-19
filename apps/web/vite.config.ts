import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Коренем сторінки на GitHub Pages є `/<назва-репо>/`, а не `/`: без цього
 * бандл шукає `/assets/…` у корені домену й отримує 404. Значення приходить із
 * workflow (`BASE_PATH`), у розробці й на власному домені лишається `/`.
 */
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
