import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { asUser } from '../../worker/db/as-user'
import { expense } from '../../worker/db/schema'
import { admin, call, newUser, startAuth, stopAuth } from './api'

// The expenses API against real Postgres, signed in as real users: the order
// charge rules, input validation, and that nobody reaches another user's splits.

let ann: string
let ben: string
let me: string
let sam: string

const post = async <T = { id: string }>(user: string, url: string, body: unknown) =>
  (await call(user, 'POST', url, body)).body as unknown as T
type Share = { personId: string; cents: number }
const byPerson = (a: Share, b: Share) => a.personId.localeCompare(b.personId)
/** A breakdown's per-person shares, in a fixed order. */
const perPerson = (breakdown: unknown) => (breakdown as { perPerson: Share[] }).perPerson.slice().sort(byPerson)
const idOf = (body: { id: string }) => body.id

const order = (over: Record<string, unknown> = {}) => ({
  type: 'ITEMIZED',
  store: 'Walmart',
  purchasedAt: '2026-10-18',
  payerId: me,
  taxCents: 100,
  tipFeesCents: 400,
  discountCents: -200,
  refundCents: -880,
  orderRef: 'walmart-123',
  items: [
    { name: 'Eggs', quantity: 1, unitPriceCents: 800, lineTotalCents: 800, assigneeIds: [me], returned: true },
    { name: 'Milk', quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200, assigneeIds: [me, sam] },
  ],
  ...over,
})

const quick = (over: Record<string, unknown> = {}) => ({
  type: 'SIMPLE',
  description: 'Dinner',
  payerId: me,
  totalCents: 3000,
  splitMethod: 'EVEN',
  participants: [{ personId: me }, { personId: sam }],
  ...over,
})

beforeAll(async () => {
  await startAuth()
  ann = await newUser('expenses-ann@splitr.test')
  ben = await newUser('expenses-ben@splitr.test')
  me = idOf(await post(ann, '/api/people', { name: 'Me' }))
  sam = idOf(await post(ann, '/api/people', { name: 'Sam' }))
})

afterAll(stopAuth)

beforeEach(async () => {
  await admin`delete from splitr."Expense" where "ownerId" in (${ann}, ${ben})`
  await admin`delete from splitr."Tag" where "ownerId" in (${ann}, ${ben})`
  await admin`delete from splitr."Transaction" where "ownerId" in (${ann}, ${ben})`
  await admin`update splitr."Person" set "linkedUserId" = null where "ownerId" = ${ann}`
  await admin`delete from splitr."Person" where "ownerId" = ${ben}`
})

describe('itemized splits with order charges', () => {
  it('saves tip, fees, discounts, refunds and returned items, and splits by their rules', async () => {
    const created = await call(ann, 'POST', '/api/expenses', order())
    expect(created.status).toBe(201)
    // Eggs (returned, me) 800 + Milk (both) 1200, tax 100, tip 400, discount -200, refund -880 = 1420
    // me:  eggs 800 + milk 600 + tax 40+30 + tip 200 + discount -140 + refund -880 = 650
    // sam: milk 600 + tax 30 + tip 200 + discount -60 = 770
    expect(created.body.breakdown).toMatchObject({ owes: [{ personId: sam, cents: 770 }] })
    expect(perPerson(created.body.breakdown)).toEqual([{ personId: me, cents: 650 }, { personId: sam, cents: 770 }].sort(byPerson))

    const saved = await call(ann, 'GET', `/api/expenses/${created.body.id}`)
    expect(saved.body).toMatchObject({
      totalCents: 1420, subtotalCents: 2000, taxCents: 100,
      tipFeesCents: 400, discountCents: -200, refundCents: -880, orderRef: 'walmart-123', ownerId: ann,
    })
    expect((saved.body.items as { returned: boolean }[]).map((i) => i.returned)).toEqual([true, false])
  })

  it('finds a split by its order, and refuses to split the same order twice', async () => {
    const first = await call(ann, 'POST', '/api/expenses', order())
    expect(await call(ann, 'GET', '/api/expenses/by-order/walmart-123')).toEqual({ status: 200, body: { id: first.body.id } })
    expect((await call(ann, 'GET', '/api/expenses/by-order/walmart-999')).status).toBe(404)

    const again = await call(ann, 'POST', '/api/expenses', order())
    expect(again).toEqual({ status: 409, body: { error: 'That order is already split', id: first.body.id } })
    const [{ n }] = await admin`select count(*)::int as n from splitr."Expense" where "ownerId" = ${ann}`
    expect(n).toBe(1)
  })

  it('refuses the same order saved twice at once, keeping one split with all its items', async () => {
    const results = await Promise.all([
      call(ann, 'POST', '/api/expenses', order()),
      call(ann, 'POST', '/api/expenses', order()),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    const [{ n }] = await admin`select count(*)::int as n from splitr."Item" where "ownerId" = ${ann}`
    expect(n).toBe(2)
  })

  it('lets two users split the same order', async () => {
    const benMe = idOf(await post(ben, '/api/people', { name: 'Me' }))
    const theirs = order({
      payerId: benMe,
      items: [{ name: 'Milk', quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200, assigneeIds: [benMe] }],
      refundCents: 0,
    })
    expect((await call(ann, 'POST', '/api/expenses', order())).status).toBe(201)
    expect((await call(ben, 'POST', '/api/expenses', theirs)).status).toBe(201)
  })

  it('an edit keeps the order link and replaces the charges', async () => {
    const { body } = await call(ann, 'POST', '/api/expenses', order())
    const edited = order({ tipFeesCents: 0, discountCents: 0 })
    delete (edited as { orderRef?: string }).orderRef
    expect((await call(ann, 'PUT', `/api/expenses/${body.id}`, edited)).status).toBe(200)

    const saved = await call(ann, 'GET', `/api/expenses/${body.id}`)
    expect(saved.body).toMatchObject({ tipFeesCents: 0, discountCents: 0, refundCents: -880, orderRef: 'walmart-123', totalCents: 1220 })
    expect((saved.body.items as { returned: boolean }[])[0].returned).toBe(true)
  })

  it('reads a split saved without order charges as having none', async () => {
    const [exp] = await admin`insert into splitr."Expense" ("ownerId", "type", "store", "payerId", "subtotalCents", "taxCents", "totalCents", "splitMethod")
      values (${ann}, 'ITEMIZED', 'Costco', ${me}, 1000, 77, 1077, 'ITEMIZED') returning "id"`
    const [nuts, gum] = await admin`insert into splitr."Item" ("ownerId", "expenseId", "name", "unitPriceCents", "lineTotalCents", "sortOrder")
      values (${ann}, ${exp.id}, 'Nuts', 700, 700, 0), (${ann}, ${exp.id}, 'Gum', 300, 300, 1) returning "id"`
    await admin`insert into splitr."ItemAssignment" ("ownerId", "itemId", "personId")
      values (${ann}, ${nuts.id}, ${me}), (${ann}, ${nuts.id}, ${sam}), (${ann}, ${gum.id}, ${sam})`

    const { body } = await call(ann, 'GET', `/api/expenses/${exp.id}`)
    expect(body).toMatchObject({ tipFeesCents: 0, discountCents: 0, refundCents: 0, orderRef: null, totalCents: 1077 })
    // Tax 77 by item price: nuts 54, gum 23; nuts 754 split two ways, gum 323 to Sam
    expect(perPerson(body.breakdown)).toEqual([{ personId: me, cents: 377 }, { personId: sam, cents: 700 }].sort(byPerson))
  })

  it.each([
    [{ discountCents: 5 }, 'discounts must be non-positive'],
    [{ tipFeesCents: -1 }, 'tip and fees must be non-negative'],
    [{ refundCents: 1.5 }, 'refundCents must be whole cents'],
    [{ orderRef: 'target-1' }, 'orderRef must look like walmart-<order id> or samsclub-<order id>'],
    [{ items: [{ name: 'Milk', quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200, assigneeIds: ['x'], returned: 'yes' }] },
      'items[].returned must be a boolean'],
    [{ items: [{ name: 'Milk', quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200, assigneeIds: ['x'] }] },
      "This order has a refund of $8.80 but no returned items, so there's no rule for who gets it."],
  ])('rejects %j', async (over, error) => {
    // The people exist only after beforeAll, so the cases name them "x"
    const bad = JSON.parse(JSON.stringify(order(over)).replaceAll('"x"', JSON.stringify(me)))
    expect(await call(ann, 'POST', '/api/expenses', bad)).toEqual({ status: 400, body: { error } })
  })
})

describe('values a Postgres column would reject', () => {
  const item = { name: 'Milk', quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200 }
  const noCharges = { tipFeesCents: 0, discountCents: 0, refundCents: 0, orderRef: undefined }

  it.each([
    ['a payer that is not a uuid', () => ({ payerId: 'me' }), 'payerId, participants and assignees must be ids of your people'],
    ['an assignee that is not a uuid', () => ({ items: [{ ...item, assigneeIds: ['sam'] }], ...noCharges }), 'payerId, participants and assignees must be ids of your people'],
    ['a payer who is not yours', () => ({ payerId: '00000000-0000-4000-8000-000000000000' }), 'payerId, participants and assignees must be ids of your people'],
    ['fractional tax', () => ({ taxCents: 1.5, items: [{ ...item, assigneeIds: [me] }], ...noCharges }), 'amounts must be whole cents'],
    ['tax past the integer range', () => ({ taxCents: 3e9, items: [{ ...item, assigneeIds: [me] }], ...noCharges }), 'amounts must be whole cents'],
    ['a fractional item price', () => ({ items: [{ ...item, unitPriceCents: 1.5, assigneeIds: [me] }], ...noCharges }), 'items[] prices must be whole cents'],
    ['a text quantity', () => ({ items: [{ ...item, quantity: 'two', assigneeIds: [me] }], ...noCharges }), 'items[].quantity must be a number'],
    ['a numeric item name', () => ({ items: [{ ...item, name: 7, assigneeIds: [me] }], ...noCharges }), 'items[].name must be a string'],
    ['a numeric store', () => ({ store: 5, items: [{ ...item, assigneeIds: [me] }], ...noCharges }), 'store must be a string'],
    ['a transactionId past the integer range', () => ({ transactionId: 3e9, items: [{ ...item, assigneeIds: [me] }], ...noCharges }), 'transactionId must be an integer'],
  ])('rejects %s with a 400', async (_name, over, error) => {
    expect(await call(ann, 'POST', '/api/expenses', order(over()))).toEqual({ status: 400, body: { error } })
  })

  it.each([
    ['a participant that is not a uuid', () => ({ participants: [{ personId: 'sam' }] }), 'payerId, participants and assignees must be ids of your people'],
    ['fractional exact amounts', () => ({ splitMethod: 'EXACT', totalCents: 3000, participants: [{ personId: me, exactAmountCents: 1500.5 }, { personId: sam, exactAmountCents: 1499.5 }] }), 'participants[].exactAmountCents must be whole cents'],
    ['a fractional total', () => ({ totalCents: 30.5 }), 'totalCents must be whole cents'],
  ])('rejects a quick split with %s', async (_name, over, error) => {
    expect(await call(ann, 'POST', '/api/expenses', quick(over()))).toEqual({ status: 400, body: { error } })
  })

  it('rejects the same on an edit', async () => {
    const { body } = await call(ann, 'POST', '/api/expenses', quick())
    const res = await call(ann, 'PUT', `/api/expenses/${body.id}`, quick({ payerId: 'me' }))
    expect(res.status).toBe(400)
  })

  it('answers a malformed id with the not-found response', async () => {
    expect((await call(ann, 'GET', '/api/expenses/nope')).status).toBe(404)
    expect((await call(ann, 'PATCH', '/api/expenses/nope', { loggedToSplitwise: true })).status).toBe(404)
    expect((await call(ann, 'PUT', '/api/expenses/nope', quick())).status).toBe(404)
    expect((await call(ann, 'DELETE', '/api/expenses/nope')).status).toBe(404)
    expect(await call(ann, 'POST', '/api/expenses/bulk', { ids: ['nope'], action: 'delete' })).toEqual({
      status: 404,
      body: { error: 'Some expenses were not found' },
    })
  })
})

describe('quick splits, tags and bulk actions', () => {
  it('lists, edits, tags and deletes a quick split', async () => {
    await post(ann, '/api/tags', { name: 'Trip' })
    const created = await call(ann, 'POST', '/api/expenses', quick({ tags: ['trip'] }))
    expect(created.status).toBe(201)
    const id = created.body.id as string

    const list = await call(ann, 'GET', '/api/expenses')
    expect(list.body).toMatchObject([{ id, description: 'Dinner', tags: ['trip'], payer: { id: me, name: 'Me' } }])

    const patched = await call(ann, 'PATCH', `/api/expenses/${id}`, { loggedToSplitwise: true, tags: [] })
    expect(patched.body).toMatchObject({ loggedToSplitwise: true, tags: [] })
    expect((await call(ann, 'PATCH', `/api/expenses/${id}`, { tags: ['nope'] })).body).toEqual({ error: 'unknown tag: nope' })

    const put = await call(ann, 'PUT', `/api/expenses/${id}`, quick({ totalCents: 4000 }))
    expect(put.status).toBe(200)
    expect((await call(ann, 'GET', `/api/expenses/${id}`)).body).toMatchObject({ totalCents: 4000, loggedToSplitwise: false })

    expect(await call(ann, 'DELETE', `/api/expenses/${id}`)).toEqual({ status: 200, body: { deleted: true } })
    expect((await call(ann, 'GET', `/api/expenses/${id}`)).status).toBe(404)
  })

  it('applies a bulk action to all of the ids, or to none', async () => {
    await post(ann, '/api/tags', { name: 'trip' })
    const a = idOf(await post(ann, '/api/expenses', quick()))
    const b = idOf(await post(ann, '/api/expenses', quick()))
    const gone = '00000000-0000-4000-8000-000000000000'

    expect((await call(ann, 'POST', '/api/expenses/bulk', { ids: [a, gone], action: 'set-logged', logged: true })).status).toBe(404)
    expect((await call(ann, 'GET', `/api/expenses/${a}`)).body.loggedToSplitwise).toBe(false)

    expect(await call(ann, 'POST', '/api/expenses/bulk', { ids: [a, b], action: 'add-tag', tag: 'trip' })).toEqual({ status: 200, body: { updated: 2 } })
    expect(((await call(ann, 'GET', '/api/expenses')).body as { tags: string[] }[]).map((e) => e.tags)).toEqual([['trip'], ['trip']])
    await call(ann, 'POST', '/api/expenses/bulk', { ids: [a], action: 'remove-tag', tag: 'trip' })
    await call(ann, 'POST', '/api/expenses/bulk', { ids: [b], action: 'delete' })
    expect(((await call(ann, 'GET', '/api/expenses')).body as { id: string; tags: string[] }[]).map((e) => [e.id, e.tags])).toEqual([[a, []]])
  })

  it('splits a transaction once', async () => {
    const tx = (await post<{ id: number }>(ann, '/api/transactions', { name: 'Pizza', amountCents: 3000, date: '2026-10-10', categoryPrimary: 'FOOD_AND_DRINK' })).id
    expect((await call(ann, 'POST', '/api/expenses', quick({ transactionId: tx }))).status).toBe(201)
    expect((await call(ann, 'POST', '/api/expenses', quick({ transactionId: tx }))).status).toBe(409)
    expect((await call(ann, 'POST', '/api/expenses', quick({ transactionId: tx + 1000 }))).status).toBe(400)
  })
})

describe("another user's splits", () => {
  let id: string
  let tagId: string
  let txId: number
  let benMe: string

  beforeEach(async () => {
    tagId = idOf(await post(ann, '/api/tags', { name: 'private' }))
    txId = (await post<{ id: number }>(ann, '/api/transactions', { name: 'Pizza', amountCents: 3000, date: '2026-10-10', categoryPrimary: 'FOOD_AND_DRINK' })).id
    id = idOf(await post(ann, '/api/expenses', order({ tags: ['private'] })))
    benMe = idOf(await post(ben, '/api/people', { name: 'Ben' }))
  })

  it('are not in Ben\'s list, lookups or order search', async () => {
    expect((await call(ben, 'GET', '/api/expenses')).body).toEqual([])
    expect((await call(ben, 'GET', `/api/expenses/${id}`)).status).toBe(404)
    expect((await call(ben, 'GET', '/api/expenses/by-order/walmart-123')).status).toBe(404)
  })

  it('cannot be changed or deleted by Ben', async () => {
    expect((await call(ben, 'PATCH', `/api/expenses/${id}`, { loggedToSplitwise: true })).status).toBe(404)
    expect((await call(ben, 'PUT', `/api/expenses/${id}`, order({ payerId: benMe, items: [{ name: 'Milk', quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200, assigneeIds: [benMe] }], refundCents: 0 }))).status).toBe(404)
    expect((await call(ben, 'DELETE', `/api/expenses/${id}`)).status).toBe(404)
    expect((await call(ben, 'POST', '/api/expenses/bulk', { ids: [id], action: 'delete' })).status).toBe(404)
    expect((await call(ben, 'POST', '/api/expenses/bulk', { ids: [id], action: 'set-logged', logged: true })).status).toBe(404)

    const saved = await call(ann, 'GET', `/api/expenses/${id}`)
    expect(saved.body).toMatchObject({ loggedToSplitwise: false, store: 'Walmart', tags: ['private'] })
    expect(saved.body.items).toHaveLength(2)
  })

  it("cannot build a split from Ann's people, tags or transaction", async () => {
    const mine = { payerId: benMe, participants: [{ personId: benMe }] }
    expect((await call(ben, 'POST', '/api/expenses', quick({ ...mine, payerId: me }))).status).toBe(400)
    expect((await call(ben, 'POST', '/api/expenses', quick({ ...mine, participants: [{ personId: sam }] }))).status).toBe(400)
    expect(await call(ben, 'POST', '/api/expenses', quick({ ...mine, tags: ['private'] }))).toEqual({ status: 400, body: { error: 'unknown tag: private' } })
    expect((await call(ben, 'POST', '/api/expenses', quick({ ...mine, transactionId: txId }))).status).toBe(400)
    expect(tagId).toBeTruthy()
  })

  it('stay out of Ben\'s lists once Ann shares one with him', async () => {
    const shared = idOf(await post(ann, '/api/expenses', quick({ participants: [{ personId: me }, { personId: sam }] })))
    await admin`update splitr."Person" set "linkedUserId" = ${ben} where "id" = ${sam}`

    // Row security does show Ben the shared split and the people on it
    const sees = await asUser(admin, { sub: ben, role: 'authenticated' }, (db) =>
      db.select({ id: expense.id }).from(expense))
    expect(sees.map((e) => e.id)).toContain(shared)

    expect((await call(ben, 'GET', '/api/expenses')).body).toEqual([])
    expect((await call(ben, 'GET', `/api/expenses/${shared}`)).status).toBe(404)
    expect(((await call(ben, 'GET', '/api/people')).body as { name: string }[]).map((p) => p.name)).toEqual(['Ben'])
  })
})
