import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { parseManualTx } from '@/lib/manual-tx'
import type { AppEnv } from '../app'
import { transaction } from '../db/schema'
import { readJson } from '../http'
import { TX_WITH, findTx, isInt4, txView } from '../views'

export const transactions = new Hono<AppEnv>()

/** The :id param as a transaction id, or null if it can't be one. */
function txId(raw: string): number | null {
  const id = Number(raw)
  return isInt4(id) ? id : null
}

/** parseManualTx, plus the amount fitting its column. */
function parseManual(body: unknown) {
  const parsed = parseManualTx(body)
  if ('error' in parsed) return parsed
  if (!isInt4(parsed.fields.amount)) return { error: 'amountCents is too large' }
  return parsed
}

// GET /api/transactions — every transaction, newest first
transactions.get('/', async (c) => {
  const rows = await c.var.db.query.transaction.findMany({
    where: (t, { eq }) => eq(t.ownerId, c.var.user.sub),
    orderBy: (t, { desc }) => [desc(t.date), desc(t.id)],
    with: TX_WITH,
  })
  return c.json(rows.map(txView))
})

// POST /api/transactions — add an expense by hand (cash, Venmo, etc.)
transactions.post('/', async (c) => {
  const db = c.var.db
  const body = await readJson(c)
  if (body instanceof Response) return body
  const parsed = parseManual(body)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)

  const [created] = await db
    .insert(transaction)
    .values({ source: 'MANUAL', ...parsed.fields })
    .returning({ id: transaction.id })
  return c.json(txView((await findTx(db, c.var.user.sub, created.id))!), 201)
})

// GET /api/transactions/:id
transactions.get('/:id', async (c) => {
  const id = txId(c.req.param('id'))
  const tx = id === null ? undefined : await findTx(c.var.db, c.var.user.sub, id)
  if (!tx) return c.json({ error: 'Transaction not found' }, 404)
  return c.json(txView(tx))
})

// PATCH /api/transactions/:id
// Any transaction: { categoryPrimary }. Hand-added ones: the full form body.
// Bank transactions are otherwise owned by Plaid and overwritten on sync.
transactions.patch('/:id', async (c) => {
  const db = c.var.db
  const uid = c.var.user.sub
  const id = txId(c.req.param('id'))
  const tx = id === null ? undefined : await findTx(db, uid, id)
  if (!tx) return c.json({ error: 'Transaction not found' }, 404)

  const body = await readJson(c)
  if (body instanceof Response) return body
  const fields = (body ?? {}) as Record<string, unknown>

  let data: Partial<typeof transaction.$inferInsert>
  if (Object.keys(fields).length === 1 && 'categoryPrimary' in fields) {
    if (typeof fields.categoryPrimary !== 'string' || !fields.categoryPrimary) {
      return c.json({ error: 'categoryPrimary must be a string' }, 400)
    }
    data =
      tx.source === 'MANUAL'
        ? { categoryPrimary: fields.categoryPrimary }
        : { userCategory: fields.categoryPrimary }
  } else {
    if (tx.source !== 'MANUAL') {
      return c.json({ error: 'Bank transactions can only be recategorized' }, 400)
    }
    const parsed = parseManual(body)
    if ('error' in parsed) return c.json({ error: parsed.error }, 400)
    data = parsed.fields
  }

  await db.update(transaction).set(data).where(and(eq(transaction.id, tx.id), eq(transaction.ownerId, uid)))
  return c.json(txView((await findTx(db, uid, tx.id))!))
})

// DELETE /api/transactions/:id — hand-added only; a split made from it stays
transactions.delete('/:id', async (c) => {
  const db = c.var.db
  const uid = c.var.user.sub
  const id = txId(c.req.param('id'))
  const tx = id === null ? undefined : await findTx(db, uid, id)
  if (!tx) return c.json({ error: 'Transaction not found' }, 404)
  if (tx.source !== 'MANUAL') {
    return c.json({ error: 'Bank transactions come from your bank and can’t be deleted' }, 400)
  }
  await db.delete(transaction).where(and(eq(transaction.id, tx.id), eq(transaction.ownerId, uid)))
  return c.json({ deleted: true })
})
