import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import postgres from 'postgres'
import { app } from '../../worker/app'

// Calls the real API (auth, row security and all) as real users. Logins are
// ES256 tokens like Supabase's, signed by a key this file serves from a
// stand-in for Supabase's JWKS endpoint, so the Worker verifies them exactly
// as it will in production.

export const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })

const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' }

let server: Server
let supabaseUrl: string

export async function startAuth() {
  server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }))
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  supabaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export async function stopAuth() {
  await new Promise((resolve) => server.close(resolve))
  await admin.end()
}

/** A signed Supabase-style access token; override claims to forge bad ones. */
export async function tokenFor(userId: string, over: { iss?: string; aud?: string; role?: string; exp?: number } = {}) {
  return new SignJWT({ role: over.role ?? 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(userId)
    .setIssuer(over.iss ?? `${supabaseUrl}/auth/v1`)
    .setAudience(over.aud ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '1h')
    .sign(privateKey)
}

export async function newUser(email: string): Promise<string> {
  const [row] = await admin`insert into auth.users (id, email) values (gen_random_uuid(), ${email}) returning id`
  return row.id as string
}

export const TEST_TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

export function env(): CloudflareEnv {
  return {
    HYPERDRIVE: { connectionString: process.env.DATABASE_URL! } as Hyperdrive,
    SUPABASE_URL: supabaseUrl as CloudflareEnv['SUPABASE_URL'],
    PLAID_TOKEN_KEY: TEST_TOKEN_KEY,
  } as CloudflareEnv
}

/** Calls the API with a raw Authorization header (or none). */
export async function callWith(authorization: string | undefined, method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authorization !== undefined) headers.Authorization = authorization
  const res = await app.request(
    url,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env(),
  )
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> & unknown[] }
}

/** Calls the API signed in as userId. */
export async function call(userId: string, method: string, url: string, body?: unknown) {
  return callWith(`Bearer ${await tokenFor(userId)}`, method, url, body)
}
