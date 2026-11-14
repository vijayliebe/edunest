import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In dev, API calls go to the FastAPI backend (EDUNEST_API, default port 18777).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: { '/api': process.env.EDUNEST_API ?? 'http://127.0.0.1:18777' },
  },
})
