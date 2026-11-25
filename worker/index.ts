import postgres from 'postgres'
import { app } from './app'
import { pingDatabase } from './keep-awake'

export default {
  fetch: app.fetch,
  // The cron trigger in wrangler.jsonc: keeps the Supabase project from
  // pausing (see keep-awake.ts)
  async scheduled(_controller, env) {
    const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false })
    try {
      const { at } = await pingDatabase(sql)
      console.log(`keep-awake: Postgres answered at ${at.toISOString()}`)
    } finally {
      await sql.end()
    }
  },
} satisfies ExportedHandler<CloudflareEnv>
