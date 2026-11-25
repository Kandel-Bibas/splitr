import { sql } from 'drizzle-orm'
import type { Sql } from 'postgres'
import { connect, type Db } from '.'

/** The verified Supabase JWT claims of the person making the request. */
export interface UserClaims {
  sub: string
  role: 'authenticated'
  [claim: string]: unknown
}

/**
 * Runs fn in one transaction as the signed-in user: role authenticated, with
 * their JWT claims set, so auth.uid() is them and row security applies to
 * every statement. Both settings are transaction-local, so they end with the
 * transaction and can't leak to the next request on a pooled connection.
 *
 * claims must come from a verified token; this function trusts them.
 */
export async function asUser<T>(client: Sql, claims: UserClaims, fn: (db: Db) => Promise<T>): Promise<T> {
  if (claims.role !== 'authenticated' || !claims.sub) {
    throw new Error(`asUser needs authenticated claims with a sub, got role=${String(claims.role)}`)
  }
  return connect(client).transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true),
                                set_config('role', 'authenticated', true)`)
    return fn(tx)
  })
}
