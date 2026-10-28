// Plaid access tokens are encrypted before they reach Postgres, so a leaked
// database alone can't reach anyone's bank. AES-256-GCM with a key held only
// as the PLAID_TOKEN_KEY Worker secret (32 random bytes, base64):
//   openssl rand -base64 32 | npx wrangler secret put PLAID_TOKEN_KEY
//
// Each ciphertext is bound to its Plaid item id (as GCM additional data), so a
// token copied onto another bank's row fails to decrypt instead of being used.

const VERSION = 'v1'

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

async function importKey(base64Key: string | undefined): Promise<CryptoKey> {
  if (!base64Key) throw new Error('PLAID_TOKEN_KEY is not set')
  const raw = fromBase64(base64Key)
  if (raw.length !== 32) throw new Error(`PLAID_TOKEN_KEY must be 32 bytes of base64, got ${raw.length} bytes`)
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptToken(token: string, plaidItemId: string, base64Key: string | undefined): Promise<string> {
  const key = await importKey(base64Key)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(plaidItemId) },
    key,
    new TextEncoder().encode(token),
  )
  return `${VERSION}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`
}

/** Throws if the value is malformed, was encrypted with another key, or belongs to another item. */
export async function decryptToken(stored: string, plaidItemId: string, base64Key: string | undefined): Promise<string> {
  const [version, iv, ciphertext, ...rest] = stored.split(':')
  if (version !== VERSION || !iv || !ciphertext || rest.length > 0) {
    throw new Error(`Stored Plaid token for item ${plaidItemId} is not a ${VERSION} ciphertext`)
  }
  const key = await importKey(base64Key)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: new TextEncoder().encode(plaidItemId) },
    key,
    fromBase64(ciphertext),
  )
  return new TextDecoder().decode(plain)
}
