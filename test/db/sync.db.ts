import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../../worker/db'
import { asUser } from '../../worker/db/as-user'
import type { PlaidAccount, PlaidTransaction } from '../../worker/plaid'
import {
  deleteTransactions,
  moveSplitsToPosted,
  syncAllItems,
  syncItem,
  upsertAccounts,
  upsertSnapshots,
  upsertTransactions,
} from '../../worker/sync'
import { encryptToken } from '../../worker/token-crypto'
import { TEST_TOKEN_KEY, admin, newUser, startAuth, stopAuth } from './api'

// The sync's bulk SQL against real Postgres, run as a signed-in user the way a
// request runs it.

const NOW = '2026-10-10T00:00:00.000Z'

let ann: string
let ben: string
let itemId: number
let p1: string

const run = <T>(user: string, fn: (db: Db) => Promise<T>) => asUser(admin, { sub: user, role: 'authenticated' }, fn)

const acct = (id: string, current: number): PlaidAccount => ({
  account_id: id,
  name: `Card ${id}`,
  official_name: null,
  mask: '1004',
  type: 'credit',
  subtype: 'credit card',
  balances: { current, available: null, iso_currency_code: 'USD' },
})

const tx = (id: string, over: Partial<PlaidTransaction> = {}): PlaidTransaction => ({
  transaction_id: id,
  account_id: 'acc-1',
  date: '2026-10-10',
  amount: 12.34,
  name: `Shop ${id}`,
  merchant_name: `Shop ${id}`,
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' },
  pending: false,
  iso_currency_code: 'USD',
  ...over,
})

async function addItem(owner: string, plaidItemId: string, token: string, institutionName: string | null = null) {
  const stored = await encryptToken(token, plaidItemId, TEST_TOKEN_KEY)
  const [row] = await admin`insert into splitr."PlaidItem" ("ownerId", "itemId", "accessToken", "institutionName")
    values (${owner}, ${plaidItemId}, ${stored}, ${institutionName}) returning "id"`
  return row.id as number
}

/** Links a new split to the transaction with this Plaid id; returns the split's id. */
async function splitOn(plaidId: string): Promise<string> {
  const [e] = await admin`insert into splitr."Expense" ("ownerId", "type", "payerId", "totalCents", "splitMethod", "transactionId")
    select ${ann}, 'SIMPLE', ${p1}, 1234, 'EVEN', "id" from splitr."Transaction" where "plaidTransactionId" = ${plaidId}
    returning "id"`
  await admin`insert into splitr."ExpenseParticipant" ("ownerId", "expenseId", "personId") values (${ann}, ${e.id}, ${p1})`
  return e.id as string
}

beforeAll(async () => {
  await startAuth()
  ann = await newUser('sync-ann@splitr.test')
  ben = await newUser('sync-ben@splitr.test')
  const [p] = await admin`insert into splitr."Person" ("ownerId", "name") values (${ann}, 'Aditya') returning "id"`
  p1 = p.id
})

afterAll(stopAuth)

beforeEach(async () => {
  await admin`delete from splitr."Expense" where "ownerId" in (${ann}, ${ben})`
  await admin`delete from splitr."PlaidItem" where "ownerId" in (${ann}, ${ben})`
  itemId = await addItem(ann, 'sync-item-1', 'token-1')
  await run(ann, (db) => upsertAccounts(db, itemId, [acct('acc-1', 100)], NOW))
})

describe('sync SQL', () => {
  it('inserts new transactions and updates known ones without duplicating', async () => {
    await run(ann, (db) => upsertTransactions(db, [tx('t1'), tx('t2')], NOW))
    await admin`update splitr."Transaction" set "userCategory" = 'TRAVEL' where "plaidTransactionId" = 't1'`

    await run(ann, (db) => upsertTransactions(db, [tx('t1', { amount: 20, pending: true }), tx('t3')], NOW))

    const all = await admin`select * from splitr."Transaction" where "ownerId" = ${ann} order by "plaidTransactionId"`
    expect(all.map((t) => t.plaidTransactionId)).toEqual(['t1', 't2', 't3'])
    expect(all[0]).toMatchObject({ amount: 2000, pending: true, userCategory: 'TRAVEL', ownerId: ann, source: 'PLAID' })
    expect(new Date(all[0].createdAt)).toEqual(new Date(NOW))
    expect(all.every((t) => t.accountId !== null)).toBe(true)
  })

  it('keeps the last copy of a transaction that appears twice in one list', async () => {
    await run(ann, (db) => upsertTransactions(db, [tx('t1'), tx('t1', { amount: 20 })], NOW))
    expect(await admin`select "amount" from splitr."Transaction" where "ownerId" = ${ann}`).toMatchObject([{ amount: 2000 }])
  })

  it('skips transactions on accounts it does not know', async () => {
    await run(ann, (db) => upsertTransactions(db, [tx('t1', { account_id: 'stranger' })], NOW))
    expect(await admin`select * from splitr."Transaction" where "ownerId" = ${ann}`).toEqual([])
  })

  it('updates account balances and keeps one snapshot per day', async () => {
    const later = '2026-10-11T00:00:00.000Z'
    await run(ann, async (db) => {
      await upsertAccounts(db, itemId, [acct('acc-1', 250.5)], later)
      await upsertSnapshots(db, [acct('acc-1', 250.5)], '2026-10-10')
    })
    await run(ann, (db) => upsertSnapshots(db, [acct('acc-1', 300)], '2026-10-10'))

    const [account] = await admin`select "currentBalance", "updatedAt" from splitr."Account" where "ownerId" = ${ann}`
    expect(account.currentBalance).toBe(25050)
    expect(new Date(account.updatedAt)).toEqual(new Date(later))
    expect(await admin`select "date", "currentBalance", "ownerId" from splitr."BalanceSnapshot" where "ownerId" = ${ann}`).toMatchObject([
      { date: '2026-10-10', currentBalance: 30000, ownerId: ann },
    ])
  })

  it('moves a split from a pending charge to the posted one', async () => {
    await run(ann, (db) => upsertTransactions(db, [tx('pend', { pending: true })], NOW))
    const split = await splitOn('pend')

    // Plaid posts it: adds the posted transaction and removes the pending one
    await run(ann, async (db) => {
      await upsertTransactions(db, [tx('posted', { pending_transaction_id: 'pend' })], NOW)
      await moveSplitsToPosted(db, [{ pending: 'pend', posted: 'posted' }])
      await deleteTransactions(db, ['pend'])
    })

    const [row] = await admin`select t."plaidTransactionId" from splitr."Expense" e
      join splitr."Transaction" t on t."id" = e."transactionId" where e."id" = ${split}`
    expect(row?.plaidTransactionId).toBe('posted')
  })

  it('leaves a posted charge that is already split alone', async () => {
    await run(ann, (db) => upsertTransactions(db, [tx('pend', { pending: true }), tx('posted')], NOW))
    const onPending = await splitOn('pend')
    const onPosted = await splitOn('posted')

    await run(ann, async (db) => {
      await moveSplitsToPosted(db, [{ pending: 'pend', posted: 'posted' }])
      await deleteTransactions(db, ['pend'])
    })

    const linked = new Map((await admin`select "id", "transactionId" is not null as linked from splitr."Expense" where "ownerId" = ${ann}`).map((r) => [r.id, r.linked]))
    expect(linked.get(onPending)).toBe(false)
    expect(linked.get(onPosted)).toBe(true)
  })

  it('keeps a split when the bank removes its charge, just unlinked', async () => {
    await run(ann, (db) => upsertTransactions(db, [tx('t1')], NOW))
    const split = await splitOn('t1')

    await run(ann, (db) => deleteTransactions(db, ['t1']))

    expect(await admin`select "id", "transactionId" from splitr."Expense" where "ownerId" = ${ann}`).toEqual([{ id: split, transactionId: null }])
  })

  it('touches only the signed-in user\'s rows', async () => {
    await run(ann, (db) => upsertTransactions(db, [tx('t1')], NOW))
    await run(ben, async (db) => {
      await upsertTransactions(db, [tx('t1', { amount: 99 })], NOW)
      await deleteTransactions(db, ['t1'])
    })
    expect(await admin`select "amount" from splitr."Transaction" where "plaidTransactionId" = 't1'`).toMatchObject([{ amount: 1234 }])
  })
})

describe('syncAllItems', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** A fake Plaid. Anything that isn't Plaid goes to the real fetch. */
  function fakePlaid(respond: (url: string, accessToken: string) => Response) {
    vi.stubEnv('PLAID_CLIENT_ID', 'id')
    vi.stubEnv('PLAID_SECRET', 'secret')
    vi.stubEnv('PLAID_ENV', 'sandbox')
    const realFetch = globalThis.fetch
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.includes('plaid.com')) return realFetch(input, init)
      const { access_token } = JSON.parse(String(init?.body))
      seen.push(access_token)
      return respond(url, access_token)
    })
    return seen
  }

  const goodPlaid = (url: string) =>
    url.endsWith('/accounts/get')
      ? Response.json({ accounts: [acct('acc-1', 250)] })
      : Response.json({ added: [tx('t1')], modified: [], removed: [], next_cursor: 'c1', has_more: false })

  it('syncs the other banks when one needs a login, and says which', async () => {
    const chase = await addItem(ann, 'sync-item-2', 'broken', 'Chase')
    const seen = fakePlaid((url, token) =>
      token === 'broken'
        ? Response.json({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' }, { status: 400 })
        : goodPlaid(url),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const results = await run(ann, (db) => syncAllItems(db, ann, TEST_TOKEN_KEY))

    expect(results).toEqual([
      { itemId, institutionName: null, added: 1, modified: 0, removed: 0 },
      { itemId: chase, institutionName: 'Chase', added: 0, modified: 0, removed: 0, error: 'login_required' },
    ])
    // Plaid is called with the decrypted token, never the stored ciphertext
    expect(new Set(seen)).toEqual(new Set(['token-1', 'broken']))
    expect(await admin`select "plaidTransactionId" from splitr."Transaction" where "ownerId" = ${ann}`).toEqual([{ plaidTransactionId: 't1' }])
    expect(await admin`select "cursor" from splitr."PlaidItem" where "ownerId" = ${ann} order by "id"`).toEqual([{ cursor: 'c1' }, { cursor: null }])
    expect(logged.mock.calls[0][0]).toBe(
      `[plaid] sync Chase (item ${chase}) failed: ITEM_LOGIN_REQUIRED: Plaid /accounts/get failed: login required`,
    )
  })

  it('writes nothing for a bank whose write fails, and still syncs the others', async () => {
    await addItem(ann, 'sync-item-2', 'overflow', 'Chase')
    fakePlaid((url, token) =>
      token === 'overflow' && url.endsWith('/transactions/sync')
        ? Response.json({ added: [tx('big', { account_id: 'acc-2', amount: 1e10 })], modified: [], removed: [], next_cursor: 'c2', has_more: false })
        : token === 'overflow'
          ? Response.json({ accounts: [acct('acc-2', 5)] })
          : goodPlaid(url),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const results = await run(ann, (db) => syncAllItems(db, ann, TEST_TOKEN_KEY))

    expect(results.map((r) => r.error)).toEqual([undefined, 'failed'])
    // Chase's account, transaction and cursor were all rolled back; the first bank's stayed
    expect(await admin`select "plaidAccountId" from splitr."Account" where "ownerId" = ${ann}`).toEqual([{ plaidAccountId: 'acc-1' }])
    expect(await admin`select "plaidTransactionId" from splitr."Transaction" where "ownerId" = ${ann}`).toEqual([{ plaidTransactionId: 't1' }])
    expect(await admin`select "cursor" from splitr."PlaidItem" where "ownerId" = ${ann} order by "id"`).toEqual([{ cursor: 'c1' }, { cursor: null }])
  })

  it('reports a bank whose stored token is not a ciphertext as failed', async () => {
    await admin`update splitr."PlaidItem" set "accessToken" = 'plain-token' where "id" = ${itemId}`
    fakePlaid(goodPlaid)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const results = await run(ann, (db) => syncAllItems(db, ann, TEST_TOKEN_KEY))

    expect(results).toMatchObject([{ itemId, error: 'failed' }])
    expect(await admin`select * from splitr."Transaction" where "ownerId" = ${ann}`).toEqual([])
  })

  it("never syncs another user's banks", async () => {
    const seen = fakePlaid(goodPlaid)

    expect(await run(ben, (db) => syncAllItems(db, ben, TEST_TOKEN_KEY))).toEqual([])
    await expect(run(ben, (db) => syncItem(db, ben, itemId, TEST_TOKEN_KEY))).rejects.toThrow(`Plaid item ${itemId} not found`)
    expect(seen).toEqual([])
  })
})
