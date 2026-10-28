import type { Context } from 'hono'

/** The request's JSON body, or a 400 response to return if it isn't JSON. */
export async function readJson(c: Context): Promise<unknown | Response> {
  try {
    return await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a path id can be a split, person, item or tag id. Check before
 * querying: Postgres rejects a malformed uuid with an error, which would
 * abort the request's transaction, where "not found" is the right answer.
 */
export function isUuid(id: string): boolean {
  return UUID.test(id)
}
