import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(fileURLToPath(import.meta.url))

// Tests against a real Supabase Postgres (DATABASE_URL). Kept out of `npm test`
// because they need that database running; see test/db/setup.ts.
export default defineConfig({
  resolve: { alias: { '@': root } },
  test: {
    environment: 'node',
    include: ['test/db/**/*.db.ts'],
    globalSetup: ['test/db/setup.ts'],
    fileParallelism: false,
  },
})
