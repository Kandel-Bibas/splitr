import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptToken } from '../../worker/token-crypto'
import { TEST_TOKEN_KEY, admin, call, newUser, startAuth, stopAuth } from './api'

// The Plaid routes against real Postgres with a fake Plaid: tokens are
// encrypted at rest and decrypted only to call Plaid, and each user reaches
// only their own banks.

let ann: string
let ben: string
let itemId: number

/** The access tokens the fake Plaid was called with, by endpoint. */
let calls: { path: string; accessToken?: string }[]

beforeAll(async () => {
  await startAuth()
  ann = await newUser('plaid-ann@splitr.test')
  ben = await newUser('plaid-ben@splitr.test')
})

afterAll(stopAuth)

beforeEach(async () => {
  await admin`delete from splitr."PlaidItem" where "ownerId" in (${ann}, ${ben})`
  await admin`delete from splitr."Expense" where "ownerId" in (${ann}, ${ben})`
  calls = []
  vi.stubEnv('PLAID_CLIENT_ID', 'id')
  vi.stubEnv('PLAID_SECRET', 'secret')
  vi.stubEnv('PLAID_ENV', 'sandbox')
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('plaid.com')) return realFetch(input, init)
    const path = new URL(url).pathname
    const body = JSON.parse(String(init?.body))
    calls.push({ path, accessToken: body.access_token })
    switch (path) {
      case '/item/public_token/exchange':
        return Response.json({ access_token: 'access-sandbox-PLAINTEXT', item_id: 'plaid-api-item' })
      case '/item/get':
        return Response.json({ item: { institution_id: 'ins_1' } })
      case '/institutions/get_by_id':
        return Response.json({ institution: { name: 'Chase', logo: null, primary_color: '#117aca' } })
      case '/accounts/get':
        return Response.json({ accounts: [{ account_id: 'plaid-api-acc', name: 'Checking', official_name: null, mask: '0001', type: 'depository', subtype: 'checking', balances: { current: 10, available: 9, iso_currency_code: 'USD' } }] })
      case '/transactions/sync':
        return Response.json({ added: [], modified: [], removed: [], next_cursor: 'c1', has_more: false })
      case '/link/token/create':
        return Response.json({ link_token: 'link-sandbox-1' })
      default:
        return Response.json({})
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function link(user: string) {
  const res = await call(user, 'POST', '/api/plaid/exchange', { public_token: 'public-sandbox-1' })
  expect(res.status).toBe(200)
  return res.body.id as number
}

describe('linking a bank', () => {
  it('stores the access token encrypted and never returns it', async () => {
    const res = await call(ann, 'POST', '/api/plaid/exchange', { public_token: 'public-sandbox-1' })
    expect(res.body).toMatchObject({ institution_name: 'Chase', account_count: 1 })
    itemId = res.body.id as number
    expect(JSON.stringify(res.body)).not.toContain('PLAINTEXT')

    const [row] = await admin`select "ownerId", "itemId", "accessToken" from splitr."PlaidItem" where "id" = ${itemId}`
    expect(row.ownerId).toBe(ann)
    expect(row.accessToken).toMatch(/^v1:/)
    expect(row.accessToken).not.toContain('PLAINTEXT')
    expect(await decryptToken(row.accessToken, 'plaid-api-item', TEST_TOKEN_KEY)).toBe('access-sandbox-PLAINTEXT')

    const accounts = await call(ann, 'GET', '/api/accounts')
    expect(JSON.stringify(accounts.body)).not.toMatch(/PLAINTEXT|v1:|accessToken/)
  })

  it('refuses a missing public token', async () => {
    expect((await call(ann, 'POST', '/api/plaid/exchange', {})).status).toBe(400)
  })
})

describe('using a stored token', () => {
  it('decrypts it to open Link in update mode, sync, and unlink', async () => {
    itemId = await link(ann)
    calls = []

    expect((await call(ann, 'POST', `/api/plaid/link-token/${itemId}`)).body).toEqual({ link_token: 'link-sandbox-1' })
    const sync = await call(ann, 'POST', `/api/plaid/sync/${itemId}`)
    expect(sync.status).toBe(200)
    expect(sync.body.results).toMatchObject([{ itemId, institutionName: 'Chase' }])
    expect((await call(ann, 'POST', '/api/plaid/sync')).body.results).toHaveLength(1)
    expect(await call(ann, 'DELETE', `/api/plaid/items/${itemId}`)).toEqual({ status: 200, body: { ok: true } })

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.accessToken === undefined || c.accessToken === 'access-sandbox-PLAINTEXT')).toBe(true)
    expect(calls.map((c) => c.path)).toContain('/item/remove')
    expect(await admin`select * from splitr."PlaidItem" where "ownerId" = ${ann}`).toEqual([])
  })

  it('does not unlink a bank whose token will not decrypt', async () => {
    itemId = await link(ann)
    await admin`update splitr."PlaidItem" set "accessToken" = 'plain' where "id" = ${itemId}`
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect((await call(ann, 'DELETE', `/api/plaid/items/${itemId}`)).status).toBe(500)
    expect(await admin`select "id" from splitr."PlaidItem" where "ownerId" = ${ann}`).toHaveLength(1)
  })
})

describe("another user's bank", () => {
  beforeEach(async () => {
    itemId = await link(ann)
    calls = []
  })

  it('is not in Ben\'s list and cannot be reached by id', async () => {
    expect((await call(ben, 'GET', '/api/accounts')).body.items).toEqual([])
    expect((await call(ben, 'POST', `/api/plaid/link-token/${itemId}`)).status).toBe(404)
    expect((await call(ben, 'POST', `/api/plaid/sync/${itemId}`)).status).toBe(404)
    expect((await call(ben, 'DELETE', `/api/plaid/items/${itemId}`)).status).toBe(404)
    expect((await call(ben, 'POST', '/api/plaid/sync')).body.results).toEqual([])
    expect(calls).toEqual([])
    expect(await admin`select "id" from splitr."PlaidItem" where "id" = ${itemId}`).toHaveLength(1)
  })

  it('answers an id that is not an integer or too large with a 400', async () => {
    expect((await call(ann, 'POST', '/api/plaid/link-token/abc')).status).toBe(400)
    expect((await call(ann, 'POST', '/api/plaid/sync/99999999999')).status).toBe(400)
    expect((await call(ann, 'DELETE', '/api/plaid/items/1.5')).status).toBe(400)
  })
})
