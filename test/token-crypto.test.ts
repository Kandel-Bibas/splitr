import { describe, expect, it } from 'vitest'
import { decryptToken, encryptToken } from '../worker/token-crypto'

const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const otherKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

describe('Plaid token encryption', () => {
  it('round-trips, and never stores the token in the clear', async () => {
    const stored = await encryptToken('access-sandbox-abc', 'item-1', key)
    expect(stored).not.toContain('access-sandbox-abc')
    expect(stored).toMatch(/^v1:/)
    expect(await decryptToken(stored, 'item-1', key)).toBe('access-sandbox-abc')
  })

  it('uses a fresh IV each time', async () => {
    expect(await encryptToken('t', 'item-1', key)).not.toBe(await encryptToken('t', 'item-1', key))
  })

  it("won't decrypt with another key, for another item, or after tampering", async () => {
    const stored = await encryptToken('access-sandbox-abc', 'item-1', key)
    await expect(decryptToken(stored, 'item-1', otherKey)).rejects.toThrow()
    await expect(decryptToken(stored, 'item-2', key)).rejects.toThrow()
    const [v, iv, ct] = stored.split(':')
    const flipped = atob(ct).split('')
    flipped[0] = String.fromCharCode(flipped[0].charCodeAt(0) ^ 1)
    await expect(decryptToken(`${v}:${iv}:${btoa(flipped.join(''))}`, 'item-1', key)).rejects.toThrow()
  })

  it('rejects plaintext tokens and bad keys loudly', async () => {
    await expect(decryptToken('access-sandbox-abc', 'item-1', key)).rejects.toThrow(/not a v1 ciphertext/)
    await expect(encryptToken('t', 'item-1', undefined)).rejects.toThrow(/PLAID_TOKEN_KEY is not set/)
    await expect(encryptToken('t', 'item-1', btoa('short'))).rejects.toThrow(/must be 32 bytes/)
  })
})
