import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

// Rebuilds the splitr schema from supabase/migrations before the run.
//
// Local database: Supabase's own Postgres image, which has the auth schema and
// the anon/authenticated roles. Its auth.uid() is older than the hosted one and
// only a superuser can replace it, so that is a one-time step:
//   docker run -d --name splitr-pg -p 54329:5432 -e POSTGRES_PASSWORD=postgres supabase/postgres:17.11.0.006
//   docker exec splitr-pg psql -U supabase_admin -d postgres -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$"
//   DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres npm run test:db
//
// Refuses to run against anything but localhost: it drops the schema.

const migrationsDir = path.join(import.meta.dirname, '../../supabase/migrations')

export default async function setup() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set; see test/db/setup.ts')
  const host = new URL(url).hostname
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`test:db drops the splitr schema; refusing to run against ${host}`)
  }

  const sql = postgres(url, { onnotice: () => {} })
  try {
    // asUser sets request.jwt.claims. The image's original auth.uid() ignores
    // it, so every user would read as null and every "can't see it" test would
    // pass for the wrong reason.
    const [{ uid }] = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001"}', true)`
      return tx`select auth.uid() as uid`
    })
    if (uid !== '00000000-0000-0000-0000-000000000001') {
      throw new Error("auth.uid() doesn't read request.jwt.claims like the hosted project; see test/db/setup.ts")
    }
    await sql.unsafe('drop schema if exists splitr cascade')
    await sql.unsafe(`delete from auth.users where email like '%@splitr.test'`)
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
      await sql.unsafe(readFileSync(path.join(migrationsDir, file), 'utf8'))
    }
  } finally {
    await sql.end()
  }
}
