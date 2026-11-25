import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One dev server for both halves: the React app, and the Worker API running
// in Cloudflare's runtime, reaching Postgres through Hyperdrive's local
// connection string (see wrangler.jsonc).
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, '.') },
  },
})
