import { drizzle } from 'drizzle-orm/postgres-js'
import type { Sql } from 'postgres'
import * as schema from './schema'

/** A Drizzle client over a postgres.js connection; open a request with asUser. */
export function connect(client: Sql) {
  return drizzle(client, { schema })
}

/**
 * One request's transaction, as the signed-in user (see asUser). Every query
 * runs as them, so row security decides which rows it sees.
 *
 * The transaction commits when the handler returns and rolls back if it
 * throws. A failed statement leaves the transaction unusable, so expected
 * conflicts are written as ON CONFLICT DO NOTHING and checked, not caught.
 */
export type Db = Parameters<Parameters<ReturnType<typeof connect>['transaction']>[0]>[0]
export { schema }
