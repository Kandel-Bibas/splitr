import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import { app } from '../worker/app'

// The expenses API against a real local D1, with the real migrations.

const persistDir = mkdtempSync(path.join(tmpdir(), 'splitr-expenses-test-'))
const migrationsDir = path.join(import.meta.dirname, '../migrations')
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>
let db: D1Database

async function migrate(file: string) {
  const sql = readFileSync(path.join(migrationsDir, file), 'utf8')
  for (const stmt of sql.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run()
  }
}

async function call(method: string, url: string, body?: unknown) {
  const res = await app.request(
    url,
    { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
    { DB: db },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const order = (over: Record<string, unknown> = {}) => ({
  type: 'ITEMIZED',
  store: 'Walmart',
  purchasedAt: '2026-10-18',
  payerId: 'me',
  taxCents: 100,
  tipFeesCents: 400,
  discountCents: -200,
  refundCents: -880,
  orderRef: 'walmart-123',
  items: [
    { name: 'Eggs', quantity: 1, unitPriceCents: 800, lineTotalCents: 800, assigneeIds: ['me'], returned: true },
    { name: 'Milk', quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200, assigneeIds: ['me', 'sam'] },
  ],
  ...over,
})

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: persistDir } })
  db = proxy.env.DB
})

afterAll(async () => {
  await proxy?.dispose()
  rmSync(persistDir, { recursive: true, force: true })
})

async function freshTables(migrations: string[]) {
  const tables = ['_ExpenseToTag', 'ExpenseParticipant', 'ItemAssignment', 'Item', 'Expense', 'BalanceSnapshot',
    'Transaction', 'Account', 'PlaidItem', 'Tag', 'Person']
  for (const name of tables) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run()
  for (const file of migrations) await migrate(file)
  await db.batch([
    db.prepare(`INSERT INTO "Person" ("id", "name") VALUES ('me', 'Me')`),
    db.prepare(`INSERT INTO "Person" ("id", "name") VALUES ('sam', 'Sam')`),
  ])
}

describe('itemized splits with order charges', () => {
  beforeEach(() => freshTables(readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()))

  it('saves tip, fees, discounts, refunds and returned items, and splits by their rules', async () => {
    const created = await call('POST', '/api/expenses', order())
    expect(created.status).toBe(201)
    // Eggs (returned, me) 800 + Milk (both) 1200, tax 100, tip 400, discount -200, refund -880 = 1420
    // me:  eggs 800 + milk 600 + tax 40+30 + tip 200 + discount -140 + refund -880 = 650
    // sam: milk 600 + tax 30 + tip 200 + discount -60 = 770
    expect(created.body.breakdown).toMatchObject({
      perPerson: [{ personId: 'me', cents: 650 }, { personId: 'sam', cents: 770 }],
      owes: [{ personId: 'sam', cents: 770 }],
    })

    const saved = await call('GET', `/api/expenses/${created.body.id}`)
    expect(saved.body).toMatchObject({
      totalCents: 1420, subtotalCents: 2000, taxCents: 100,
      tipFeesCents: 400, discountCents: -200, refundCents: -880, orderRef: 'walmart-123',
    })
    expect((saved.body.items as { returned: boolean }[]).map((i) => i.returned)).toEqual([true, false])
  })

  it('finds a split by its order, and refuses to split the same order twice', async () => {
    const first = await call('POST', '/api/expenses', order())
    expect(await call('GET', '/api/expenses/by-order/walmart-123')).toEqual({ status: 200, body: { id: first.body.id } })
    expect((await call('GET', '/api/expenses/by-order/walmart-999')).status).toBe(404)

    const again = await call('POST', '/api/expenses', order())
    expect(again).toEqual({ status: 409, body: { error: 'That order is already split', id: first.body.id } })
  })

  it('an edit keeps the order link and replaces the charges', async () => {
    const { body } = await call('POST', '/api/expenses', order())
    const edited = order({ tipFeesCents: 0, discountCents: 0 })
    delete (edited as { orderRef?: string }).orderRef
    expect((await call('PUT', `/api/expenses/${body.id}`, edited)).status).toBe(200)

    const saved = await call('GET', `/api/expenses/${body.id}`)
    expect(saved.body).toMatchObject({ tipFeesCents: 0, discountCents: 0, refundCents: -880, orderRef: 'walmart-123', totalCents: 1220 })
    expect((saved.body.items as { returned: boolean }[])[0].returned).toBe(true)
  })

  it.each([
    [{ discountCents: 5 }, 'discounts must be non-positive'],
    [{ tipFeesCents: -1 }, 'tip and fees must be non-negative'],
    [{ refundCents: 1.5 }, 'refundCents must be whole cents'],
    [{ orderRef: 'target-1' }, 'orderRef must look like walmart-<order id> or samsclub-<order id>'],
    [{ items: [{ name: 'Milk', quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200, assigneeIds: ['me'], returned: 'yes' }] },
      'items[].returned must be a boolean'],
    [{ items: [{ name: 'Milk', quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200, assigneeIds: ['me'] }] },
      "This order has a refund of $8.80 but no returned items, so there's no rule for who gets it."],
  ])('rejects %j', async (over, error) => {
    expect(await call('POST', '/api/expenses', order(over))).toEqual({ status: 400, body: { error } })
  })
})

describe('migration 0002', () => {
  beforeEach(() => freshTables(['0001_init.sql']))

  it("leaves a split saved before it with the same amounts", async () => {
    // A receipt written the way the app saved them before 0002
    await db.batch([
      db.prepare(`INSERT INTO "Expense" ("id", "type", "store", "payerId", "subtotalCents", "taxCents", "totalCents", "splitMethod")
        VALUES ('old', 'ITEMIZED', 'Costco', 'me', 1000, 77, 1077, 'ITEMIZED')`),
      db.prepare(`INSERT INTO "Item" ("id", "expenseId", "name", "unitPriceCents", "lineTotalCents", "sortOrder")
        VALUES ('i1', 'old', 'Nuts', 700, 700, 0), ('i2', 'old', 'Gum', 300, 300, 1)`),
      db.prepare(`INSERT INTO "ItemAssignment" ("itemId", "personId") VALUES ('i1', 'me'), ('i1', 'sam'), ('i2', 'sam')`),
    ])
    await migrate('0002_order_charges.sql')

    const { body } = await call('GET', '/api/expenses/old')
    expect(body).toMatchObject({ tipFeesCents: 0, discountCents: 0, refundCents: 0, orderRef: null, totalCents: 1077 })
    // Tax 77 by item price: nuts 54, gum 23; nuts 754 split two ways, gum 323 to Sam
    expect(body.breakdown).toMatchObject({ perPerson: [{ personId: 'me', cents: 377 }, { personId: 'sam', cents: 700 }] })
  })
})
