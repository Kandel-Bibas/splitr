import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { admin, call, newUser, startAuth, stopAuth } from './api'

// Tags, transactions and accounts: each user sees and changes only their own.

let ann: string
let ben: string

const created = async <T = { id: string }>(user: string, url: string, body: unknown) =>
  (await call(user, 'POST', url, body)).body as unknown as T

beforeAll(async () => {
  await startAuth()
  ann = await newUser('iso-ann@splitr.test')
  ben = await newUser('iso-ben@splitr.test')
})

afterAll(stopAuth)

beforeEach(async () => {
  await admin`delete from splitr."Expense" where "ownerId" in (${ann}, ${ben})`
  await admin`delete from splitr."Tag" where "ownerId" in (${ann}, ${ben})`
  await admin`delete from splitr."Transaction" where "ownerId" in (${ann}, ${ben})`
})

describe('tags', () => {
  it('are per user: lists, renames, deletes and names', async () => {
    const tag = await created<{ id: string }>(ann, '/api/tags', { name: 'Trip' })
    expect(tag).toMatchObject({ name: 'trip', expenseCount: 0 })

    expect((await call(ben, 'GET', '/api/tags')).body).toEqual([])
    expect((await call(ben, 'PATCH', `/api/tags/${tag.id}`, { name: 'mine' })).status).toBe(404)
    expect((await call(ben, 'DELETE', `/api/tags/${tag.id}`)).status).toBe(404)
    expect((await call(ann, 'GET', '/api/tags')).body).toEqual([{ id: tag.id, name: 'trip', expenseCount: 0 }])

    // Ben can use the same name for his own
    expect((await call(ben, 'POST', '/api/tags', { name: 'trip' })).status).toBe(201)
  })

  it('refuse a duplicate name, on create and on rename', async () => {
    await created(ann, '/api/tags', { name: 'a' })
    const b = await created(ann, '/api/tags', { name: 'b' })

    expect(await call(ann, 'POST', '/api/tags', { name: 'A' })).toEqual({ status: 409, body: { error: 'Tag "a" already exists' } })
    expect(await call(ann, 'PATCH', `/api/tags/${b.id}`, { name: ' A ' })).toEqual({ status: 409, body: { error: 'Tag "a" already exists' } })
    expect((await call(ann, 'PATCH', `/api/tags/${b.id}`, { name: 'b' })).status).toBe(200)
    expect((await call(ann, 'PATCH', `/api/tags/${b.id}`, { name: 'c' })).body).toEqual({ id: b.id, name: 'c', expenseCount: 0 })
    expect((await call(ann, 'PATCH', '/api/tags/00000000-0000-4000-8000-000000000000', { name: 'a' })).status).toBe(404)
    expect((await call(ann, 'GET', '/api/tags')).body).toHaveLength(2)
  })

  it('answer a malformed id with the not-found response', async () => {
    expect((await call(ann, 'PATCH', '/api/tags/nope', { name: 'x' })).status).toBe(404)
    expect((await call(ann, 'DELETE', '/api/tags/nope')).status).toBe(404)
  })

  it('count the expenses using them, and delete without deleting those', async () => {
    const me = (await created(ann, '/api/people', { name: 'Me' })).id
    const t = await created(ann, '/api/tags', { name: 'counted' })
    const exp = await created(ann, '/api/expenses', {
      type: 'SIMPLE', description: 'x', payerId: me, totalCents: 100, splitMethod: 'EVEN', participants: [{ personId: me }], tags: ['counted'],
    })
    expect(((await call(ann, 'GET', '/api/tags')).body as { name: string; expenseCount: number }[]).find((x) => x.name === 'counted')).toMatchObject({ expenseCount: 1 })
    expect((await call(ann, 'DELETE', `/api/tags/${t.id}`)).body).toEqual({ deleted: true })
    expect((await call(ann, 'GET', `/api/expenses/${exp.id}`)).body).toMatchObject({ tags: [] })
  })
})

describe('transactions', () => {
  const manual = { name: 'Cash lunch', amountCents: 1500, date: '2026-10-10', categoryPrimary: 'FOOD_AND_DRINK' }

  it('are per user: lists, lookups, edits and deletes', async () => {
    const tx = await created<{ id: number }>(ann, '/api/transactions', manual)
    expect(tx).toMatchObject({ source: 'MANUAL', amount: 1500, name: 'Cash lunch' })

    expect((await call(ben, 'GET', '/api/transactions')).body).toEqual([])
    expect((await call(ben, 'GET', `/api/transactions/${tx.id}`)).status).toBe(404)
    expect((await call(ben, 'PATCH', `/api/transactions/${tx.id}`, { categoryPrimary: 'TRAVEL' })).status).toBe(404)
    expect((await call(ben, 'PATCH', `/api/transactions/${tx.id}`, manual)).status).toBe(404)
    expect((await call(ben, 'DELETE', `/api/transactions/${tx.id}`)).status).toBe(404)

    expect((await call(ann, 'GET', `/api/transactions/${tx.id}`)).body).toMatchObject({ categoryPrimary: 'FOOD_AND_DRINK', name: 'Cash lunch' })
    expect((await call(ann, 'GET', '/api/transactions')).body).toHaveLength(1)
  })

  it('can be edited, recategorized and deleted by their owner', async () => {
    const tx = await created<{ id: number }>(ann, '/api/transactions', manual)
    expect((await call(ann, 'PATCH', `/api/transactions/${tx.id}`, { ...manual, amountCents: 2000 })).body).toMatchObject({ amount: 2000 })
    expect((await call(ann, 'PATCH', `/api/transactions/${tx.id}`, { categoryPrimary: 'TRAVEL' })).body).toMatchObject({ categoryPrimary: 'TRAVEL' })
    expect(await call(ann, 'DELETE', `/api/transactions/${tx.id}`)).toEqual({ status: 200, body: { deleted: true } })
    expect((await call(ann, 'GET', `/api/transactions/${tx.id}`)).status).toBe(404)
  })

  it('recategorizes a bank transaction without touching the bank\'s own category', async () => {
    const [item] = await admin`insert into splitr."PlaidItem" ("ownerId", "itemId", "accessToken") values (${ann}, 'iso-item', 'v1:x:y') returning "id"`
    const [acc] = await admin`insert into splitr."Account" ("ownerId", "plaidAccountId", "itemId", "name", "type") values (${ann}, 'iso-acc', ${item.id}, 'Card', 'credit') returning "id"`
    const [bank] = await admin`insert into splitr."Transaction" ("ownerId", "plaidTransactionId", "accountId", "date", "amount", "name", "categoryPrimary")
      values (${ann}, 'iso-tx', ${acc.id}, '2026-10-10', 500, 'SHOP', 'GENERAL_MERCHANDISE') returning "id"`

    expect((await call(ann, 'PATCH', `/api/transactions/${bank.id}`, { categoryPrimary: 'TRAVEL' })).body).toMatchObject({ categoryPrimary: 'TRAVEL' })
    expect((await call(ann, 'PATCH', `/api/transactions/${bank.id}`, manual)).status).toBe(400)
    expect((await call(ann, 'DELETE', `/api/transactions/${bank.id}`)).status).toBe(400)
    expect((await call(ben, 'GET', `/api/transactions/${bank.id}`)).status).toBe(404)
    await admin`delete from splitr."PlaidItem" where "id" = ${item.id}`
  })

  it('answer an id that is not a whole number or too large with the not-found response', async () => {
    expect((await call(ann, 'GET', '/api/transactions/abc')).status).toBe(404)
    expect((await call(ann, 'GET', '/api/transactions/99999999999')).status).toBe(404)
    expect((await call(ann, 'DELETE', '/api/transactions/99999999999')).status).toBe(404)
  })

  it('refuse an amount too large for the column', async () => {
    expect(await call(ann, 'POST', '/api/transactions', { ...manual, amountCents: 3e9 })).toEqual({
      status: 400,
      body: { error: 'amountCents is too large' },
    })
  })
})

describe('accounts', () => {
  it('list only your own banks, and never their tokens', async () => {
    const [item] = await admin`insert into splitr."PlaidItem" ("ownerId", "itemId", "accessToken", "institutionName", "cursor")
      values (${ann}, 'iso-item-2', 'v1:secret:secret', 'Chase', 'cur') returning "id"`
    await admin`insert into splitr."Account" ("ownerId", "plaidAccountId", "itemId", "name", "type")
      values (${ann}, 'iso-acc-2', ${item.id}, 'Checking', 'depository')`

    const mine = await call(ann, 'GET', '/api/accounts')
    expect(mine.body).toMatchObject({ items: [{ id: item.id, institutionName: 'Chase', accounts: [{ name: 'Checking' }] }] })
    expect(JSON.stringify(mine.body)).not.toMatch(/secret|cursor|accessToken/)

    expect((await call(ben, 'GET', '/api/accounts')).body.items).toEqual([])
    await admin`delete from splitr."PlaidItem" where "id" = ${item.id}`
  })
})
