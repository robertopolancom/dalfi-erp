/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// El frontend y la API comparten origen en producción (el servicio de Render
// sirve el `dist/`). En desarrollo, Vite reenvía /api al servidor local para
// que el código no tenga que saber nada de puertos ni de CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env['API_LOCAL'] ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
})
