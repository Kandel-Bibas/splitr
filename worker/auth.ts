import { createMiddleware } from 'hono/factory'
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import postgres from 'postgres'
import type { AppEnv } from './app'
import { asUser, type UserClaims } from './db/as-user'

// Every /api request: verify the Supabase login, then run the handler inside
// one transaction as that user. Nothing reads Postgres any other way.

const jwksBySupabaseUrl = new Map<string, JWTVerifyGetKey>()

/** Supabase's public signing keys, fetched once per isolate and cached by jose. */
function jwks(supabaseUrl: string): JWTVerifyGetKey {
  let keys = jwksBySupabaseUrl.get(supabaseUrl)
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', supabaseUrl))
    jwksBySupabaseUrl.set(supabaseUrl, keys)
  }
  return keys
}

/** The verified claims of a Supabase access token, or null if it isn't one. */
export async function verifyAccessToken(token: string, supabaseUrl: string): Promise<UserClaims | null> {
  try {
    const { payload } = await jwtVerify(token, jwks(supabaseUrl), {
      issuer: new URL('/auth/v1', supabaseUrl).href,
      audience: 'authenticated',
      algorithms: ['ES256'],
    })
    if (payload.role !== 'authenticated' || typeof payload.sub !== 'string' || !payload.sub) return null
    return payload as UserClaims
  } catch (e) {
    // A bad, expired or foreign token is a 401; anything else (Supabase's key
    // endpoint unreachable, say) is a real failure and surfaces as a 500
    if (e instanceof errors.JOSEError && !(e instanceof errors.JWKSTimeout)) return null
    throw e
  }
}

const ROLLBACK = Symbol('rollback')

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  const claims = token ? await verifyAccessToken(token, c.env.SUPABASE_URL) : null
  if (!claims) return c.json({ error: 'Sign in to continue' }, 401)

  // One client per request: a Worker can't share a connection across requests.
  // Hyperdrive pools the real connections behind it.
  const sql = postgres(c.env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false })
  try {
    await asUser(sql, claims, async (db) => {
      c.set('user', claims)
      c.set('db', db)
      await next()
      // Hono turns a thrown handler error into the 500 response before control
      // returns here; roll its writes back rather than commit half a request
      if (c.error) throw ROLLBACK
    })
  } catch (e) {
    if (e !== ROLLBACK) throw e
  } finally {
    await sql.end()
  }
})
