import type { Sql } from 'postgres'

// Supabase pauses a Free project after a week without enough database
// activity, and "a few requests to the database each day" is what its docs
// say keeps it running. The Worker's cron trigger (wrangler.jsonc) calls this
// a few times a day so a quiet week doesn't take the app offline.

/**
 * One query on an app table, sent all the way to Postgres. It runs as
 * authenticated with no JWT claims, so auth.uid() is null and row security
 * shows it no one's rows. now() makes the result uncacheable, so Hyperdrive
 * has to forward it instead of answering from its cache.
 *
 * Throws if Postgres can't be reached, so the cron run shows as failed.
 */
export async function pingDatabase(sql: Sql): Promise<{ at: Date; visiblePeople: number }> {
  const [row] = await sql.begin(async (tx) => {
    await tx`set local role authenticated`
    return tx`select now() as at, count(*)::int as "visiblePeople" from splitr."Person"`
  })
  return { at: row.at as Date, visiblePeople: row.visiblePeople as number }
}
