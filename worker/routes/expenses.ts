import { Hono } from 'hono'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { type ExpenseInput, expenseFields, parseExpenseInput } from '@/lib/expense-input'
import { parseBulkAction } from '@/lib/bulk'
import { parseTags, unknownTags } from '@/lib/tags'
import type { AppEnv } from '../app'
import { type Db, getDb } from '../db'
import {
  expense,
  expenseParticipant,
  expenseToTag,
  item,
  itemAssignment,
  tag,
} from '../db/schema'
import { EXPENSE_WITH, breakdownOf, expenseJson, findExpense } from '../views'
import { isUniqueViolation, readJson } from '../http'

export const expenses = new Hono<AppEnv>()

/** Tag rows for these names; the caller reports any that don't exist. */
async function findTags(db: Db, names: string[]) {
  if (names.length === 0) return []
  return db.select({ id: tag.id, name: tag.name }).from(tag).where(inArray(tag.name, names))
}

/**
 * Inserts for a split's items + assignments (receipts) or participants
 * (quick splits), plus its tag links. Run in one batch with the split row so
 * a split is never saved half-written: a split with no people would make its
 * breakdown throw and break every page that lists it.
 */
function childWrites(db: Db, expenseId: string, input: ExpenseInput, tagIds: string[]) {
  const writes = []
  if (input.type === 'ITEMIZED') {
    input.items.forEach((it, idx) => {
      const itemId = crypto.randomUUID()
      writes.push(
        db.insert(item).values({
          id: itemId,
          expenseId,
          name: it.name,
          rawName: it.rawName ?? null,
          quantity: it.quantity,
          unitPriceCents: it.unitPriceCents,
          lineTotalCents: it.lineTotalCents,
          sortOrder: idx,
          returned: it.returned,
        }),
      )
      if (it.assigneeIds.length > 0) {
        writes.push(db.insert(itemAssignment).values(it.assigneeIds.map((personId) => ({ itemId, personId }))))
      }
    })
  } else {
    writes.push(
      db.insert(expenseParticipant).values(
        input.participants.map((p) => ({ expenseId, personId: p.personId, exactAmountCents: p.exactAmountCents })),
      ),
    )
  }
  if (tagIds.length > 0) writes.push(db.insert(expenseToTag).values(tagIds.map((B) => ({ A: expenseId, B }))))
  return writes
}

const ORDER_REF = /^(walmart|samsclub)-\d+$/

function findByOrder(db: Db, orderRef: string) {
  return db.query.expense.findFirst({ where: (e, { eq }) => eq(e.orderRef, orderRef), columns: { id: true } })
}

/** The split's items and sharers, for its breakdown. */
function findForBreakdown(db: Db, id: string) {
  return db.query.expense.findFirst({
    where: (e, { eq }) => eq(e.id, id),
    with: { items: { with: { assignments: true } }, participants: true },
  })
}

// ---------------------------------------------------------------------------
// POST /api/expenses
// ---------------------------------------------------------------------------
expenses.post('/', async (c) => {
  const db = getDb(c.env.DB)
  const body = await readJson(c)
  if (body instanceof Response) return body

  const parsed = parseExpenseInput(body)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const { input } = parsed
  const tags = await findTags(db, input.tags)
  const missing = unknownTags(input.tags, tags.map((t) => t.name))
  if (missing.length > 0) return c.json({ error: `unknown tag: ${missing.join(', ')}` }, 400)

  // Optional: the bank or hand-added transaction this split was made from
  const { transactionId } = (body ?? {}) as { transactionId?: unknown }
  if (transactionId !== undefined) {
    if (!Number.isInteger(transactionId)) return c.json({ error: 'transactionId must be an integer' }, 400)
    const source = await db.query.transaction.findFirst({
      where: (t, { eq }) => eq(t.id, transactionId as number),
      columns: { id: true },
      with: { expense: { columns: { id: true } } },
    })
    if (!source) return c.json({ error: 'That transaction no longer exists' }, 400)
    if (source.expense) return c.json({ error: 'That transaction is already split' }, 409)
  }

  // Optional: the Walmart or Sam's Club order this split was imported from
  const { orderRef } = (body ?? {}) as { orderRef?: unknown }
  if (orderRef !== undefined) {
    if (input.type !== 'ITEMIZED') return c.json({ error: 'orderRef is only for itemized splits' }, 400)
    if (typeof orderRef !== 'string' || !ORDER_REF.test(orderRef)) {
      return c.json({ error: 'orderRef must look like walmart-<order id> or samsclub-<order id>' }, 400)
    }
    const existing = await findByOrder(db, orderRef)
    if (existing) return c.json({ error: 'That order is already split', id: existing.id }, 409)
  }

  const id = crypto.randomUUID()
  try {
    await db.batch([
      db.insert(expense).values({
        id,
        ...expenseFields(input),
        ...(transactionId !== undefined && { transactionId: transactionId as number }),
        ...(orderRef !== undefined && { orderRef: orderRef as string }),
      }),
      ...childWrites(db, id, input, tags.map((t) => t.id)),
    ])
  } catch (e) {
    // Two saves of the same order at once: the unique index stops the second
    if (orderRef === undefined || !isUniqueViolation(e)) throw e
    const existing = await findByOrder(db, orderRef as string)
    return c.json({ error: 'That order is already split', id: existing?.id }, 409)
  }

  const saved = (await findForBreakdown(db, id))!
  return c.json({ id, breakdown: breakdownOf(saved) }, 201)
})

// ---------------------------------------------------------------------------
// GET /api/expenses
// ---------------------------------------------------------------------------
expenses.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.query.expense.findMany({
    orderBy: (e, { desc }) => [desc(e.createdAt)],
    with: EXPENSE_WITH,
  })
  return c.json(
    rows.map((row) => {
      const exp = expenseJson(row)
      return {
        id: exp.id,
        type: exp.type,
        description: exp.description,
        store: exp.store,
        purchasedAt: exp.purchasedAt,
        payerId: exp.payerId,
        payer: exp.payer,
        totalCents: exp.totalCents,
        splitMethod: exp.splitMethod,
        loggedToSplitwise: exp.loggedToSplitwise,
        createdAt: exp.createdAt,
        tags: exp.tags,
        itemNames: exp.items.map((i) => i.name),
        breakdown: { perPerson: breakdownOf(exp).perPerson },
      }
    }),
  )
})

// ---------------------------------------------------------------------------
// POST /api/expenses/bulk  — apply one action to several expenses at once:
//   { ids, action: 'add-tag' | 'remove-tag', tag }
//   { ids, action: 'set-logged', logged }
//   { ids, action: 'delete' }
// If any id is missing, nothing changes. Each action is one batch.
// ---------------------------------------------------------------------------
expenses.post('/bulk', async (c) => {
  const db = getDb(c.env.DB)
  const body = await readJson(c)
  if (body instanceof Response) return body

  const parsed = parseBulkAction(body)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const { ids, op } = parsed

  let tagId: string | undefined
  if (op.action === 'add-tag' || op.action === 'remove-tag') {
    tagId = (await findTags(db, [op.tag]))[0]?.id
    if (!tagId) return c.json({ error: `unknown tag: ${op.tag}` }, 400)
  }

  const [{ found }] = await db.select({ found: sql<number>`count(*)` }).from(expense).where(inArray(expense.id, ids))
  if (found !== ids.length) return c.json({ error: 'Some expenses were not found' }, 404)

  if (op.action === 'set-logged') {
    await db.update(expense).set({ loggedToSplitwise: op.logged }).where(inArray(expense.id, ids))
  } else if (op.action === 'delete') {
    await db.delete(expense).where(inArray(expense.id, ids)) // items and participants cascade
  } else if (op.action === 'add-tag') {
    await db
      .insert(expenseToTag)
      .values(ids.map((A) => ({ A, B: tagId! })))
      .onConflictDoNothing()
  } else {
    await db.delete(expenseToTag).where(and(inArray(expenseToTag.A, ids), eq(expenseToTag.B, tagId!)))
  }

  return c.json({ updated: ids.length })
})

// ---------------------------------------------------------------------------
// GET /api/expenses/by-order/:ref  — the split made from this order, if any
// ---------------------------------------------------------------------------
expenses.get('/by-order/:ref', async (c) => {
  const found = await findByOrder(getDb(c.env.DB), c.req.param('ref'))
  if (!found) return c.json({ error: 'No split for that order' }, 404)
  return c.json({ id: found.id })
})

// ---------------------------------------------------------------------------
// GET /api/expenses/:id
// ---------------------------------------------------------------------------
expenses.get('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const row = await db.query.expense.findFirst({
    where: (e, { eq }) => eq(e.id, c.req.param('id')),
    with: {
      ...EXPENSE_WITH,
      // columns, not the whole row: the bank row holds the Plaid access token
      transaction: {
        columns: { id: true, date: true, amount: true, source: true },
        with: {
          account: {
            columns: { name: true, mask: true },
            with: { item: { columns: { institutionName: true } } },
          },
        },
      },
    },
  })
  if (!row) return c.json({ error: 'Expense not found' }, 404)

  const { transaction: tx, ...rest } = row
  const exp = expenseJson(rest)
  return c.json({ ...exp, transaction: tx ?? null, breakdown: breakdownOf(exp) })
})

// ---------------------------------------------------------------------------
// PATCH /api/expenses/:id  — supports { loggedToSplitwise?: boolean, tags?: string[] }
// ---------------------------------------------------------------------------
expenses.patch('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const body = await readJson(c)
  if (body instanceof Response) return body

  const { loggedToSplitwise } = (body ?? {}) as { loggedToSplitwise?: unknown }
  if (loggedToSplitwise !== undefined && typeof loggedToSplitwise !== 'boolean') {
    return c.json({ error: 'loggedToSplitwise must be a boolean' }, 400)
  }
  const rawTags = (body as { tags?: unknown } | null)?.tags
  const tagNames = rawTags === undefined ? undefined : parseTags(rawTags)
  if (tagNames === null) return c.json({ error: 'tags must be an array of strings' }, 400)
  if (loggedToSplitwise === undefined && tagNames === undefined) {
    return c.json({ error: 'nothing to update' }, 400)
  }
  const tags = tagNames ? await findTags(db, tagNames) : []
  const missing = tagNames ? unknownTags(tagNames, tags.map((t) => t.name)) : []
  if (missing.length > 0) return c.json({ error: `unknown tag: ${missing.join(', ')}` }, 400)

  const exists = await db.query.expense.findFirst({ where: (e, { eq }) => eq(e.id, id), columns: { id: true } })
  if (!exists) return c.json({ error: 'Expense not found' }, 404)

  const writes = []
  if (loggedToSplitwise !== undefined) {
    writes.push(db.update(expense).set({ loggedToSplitwise }).where(eq(expense.id, id)))
  }
  if (tagNames !== undefined) {
    // Replace the expense's tags with exactly this list
    writes.push(db.delete(expenseToTag).where(eq(expenseToTag.A, id)))
    if (tags.length > 0) writes.push(db.insert(expenseToTag).values(tags.map((t) => ({ A: id, B: t.id }))))
  }
  await db.batch(writes as [(typeof writes)[number], ...typeof writes])

  return c.json(expenseJson((await findExpense(db, id))!))
})

// ---------------------------------------------------------------------------
// PUT /api/expenses/:id  — replace an expense with an edited version.
// Same body as POST /api/expenses; the type can't change. Clears
// loggedToSplitwise so the edit gets re-entered in Splitwise.
// ---------------------------------------------------------------------------
expenses.put('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const body = await readJson(c)
  if (body instanceof Response) return body

  const parsed = parseExpenseInput(body)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const { input } = parsed
  const tags = await findTags(db, input.tags)
  const missing = unknownTags(input.tags, tags.map((t) => t.name))
  if (missing.length > 0) return c.json({ error: `unknown tag: ${missing.join(', ')}` }, 400)

  const existing = await db.query.expense.findFirst({ where: (e, { eq }) => eq(e.id, id), columns: { type: true } })
  if (!existing) return c.json({ error: 'Expense not found' }, 404)
  if (existing.type !== input.type) return c.json({ error: 'expense type cannot be changed' }, 400)

  // One batch: if any write fails, the split stays exactly as it was
  await db.batch([
    db.delete(item).where(eq(item.expenseId, id)), // assignments cascade
    db.delete(expenseParticipant).where(eq(expenseParticipant.expenseId, id)),
    db.delete(expenseToTag).where(eq(expenseToTag.A, id)),
    db.update(expense).set({ ...expenseFields(input), loggedToSplitwise: false }).where(eq(expense.id, id)),
    ...childWrites(db, id, input, tags.map((t) => t.id)),
  ])

  const saved = (await findForBreakdown(db, id))!
  return c.json({ id, breakdown: breakdownOf(saved) })
})

// ---------------------------------------------------------------------------
// DELETE /api/expenses/:id
// ---------------------------------------------------------------------------
expenses.delete('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const deleted = await db.delete(expense).where(eq(expense.id, c.req.param('id'))).returning({ id: expense.id })
  if (deleted.length === 0) return c.json({ error: 'Expense not found' }, 404)
  return c.json({ deleted: true })
})
