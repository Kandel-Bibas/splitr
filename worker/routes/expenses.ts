import { Hono } from 'hono'
import { type SQL, and, asc, count, eq, inArray, isNull, notInArray } from 'drizzle-orm'
import { type ExpenseInput, expenseFields, parseExpenseInput } from '@/lib/expense-input'
import { parseBulkAction } from '@/lib/bulk'
import { parseTags, unknownTags } from '@/lib/tags'
import type { AppEnv } from '../app'
import type { Db } from '../db'
import {
  expense,
  expenseParticipant,
  expenseToTag,
  item,
  itemAssignment,
  person,
  tag,
  transaction,
} from '../db/schema'
import { EXPENSE_WITH, breakdownOf, expenseJson, findExpense, isInt4 } from '../views'
import { isUuid, readJson } from '../http'

export const expenses = new Hono<AppEnv>()

/** Tag rows for these names; the caller reports any that don't exist. */
async function findTags(db: Db, ownerId: string, names: string[]) {
  if (names.length === 0) return []
  return db
    .select({ id: tag.id, name: tag.name })
    .from(tag)
    .where(and(eq(tag.ownerId, ownerId), inArray(tag.name, names)))
}

/**
 * Writes a split's items + assignments (receipts) or participants (quick
 * splits), plus its tag links. The request is one transaction, so a failure
 * here discards the split row too: a split with no people would make its
 * breakdown throw and break every page that lists it.
 */
async function writeChildren(db: Db, expenseId: string, input: ExpenseInput, tagIds: string[]) {
  if (input.type === 'ITEMIZED') {
    const rows = input.items.map((it, idx) => ({
      id: crypto.randomUUID(),
      expenseId,
      name: it.name,
      rawName: it.rawName ?? null,
      quantity: it.quantity,
      unitPriceCents: it.unitPriceCents,
      lineTotalCents: it.lineTotalCents,
      sortOrder: idx,
      returned: it.returned,
    }))
    await db.insert(item).values(rows)
    const assignments = input.items.flatMap((it, idx) =>
      it.assigneeIds.map((personId) => ({ itemId: rows[idx].id, personId })),
    )
    if (assignments.length > 0) await db.insert(itemAssignment).values(assignments)
  } else {
    await db.insert(expenseParticipant).values(
      input.participants.map((p) => ({ expenseId, personId: p.personId, exactAmountCents: p.exactAmountCents })),
    )
  }
  if (tagIds.length > 0) await db.insert(expenseToTag).values(tagIds.map((B) => ({ A: expenseId, B })))
}

/**
 * Values the split engine doesn't check but a Postgres column would reject,
 * which would fail the request with a 500; null if they all fit.
 */
function columnError(input: ExpenseInput): string | null {
  if (input.type === 'ITEMIZED') {
    if (input.store !== null && typeof input.store !== 'string') return 'store must be a string'
    for (const it of input.items) {
      if (typeof it.name !== 'string') return 'items[].name must be a string'
      if (it.rawName != null && typeof it.rawName !== 'string') return 'items[].rawName must be a string'
      if (typeof it.quantity !== 'number' || !Number.isFinite(it.quantity)) return 'items[].quantity must be a number'
      if (!isInt4(it.unitPriceCents) || !isInt4(it.lineTotalCents)) return 'items[] prices must be whole cents'
    }
    const amounts = [input.taxCents, input.tipFeesCents, input.discountCents, input.refundCents, input.totalCents]
    if (!amounts.every(isInt4)) return 'amounts must be whole cents'
  } else {
    if (!isInt4(input.totalCents)) return 'totalCents must be whole cents'
    if (input.participants.some((p) => p.exactAmountCents !== null && !isInt4(p.exactAmountCents))) {
      return 'participants[].exactAmountCents must be whole cents'
    }
  }
  return null
}

/** Whether the payer and everyone in the split are your own contacts. */
async function peopleAreMine(db: Db, ownerId: string, input: ExpenseInput) {
  const ids = [
    input.payerId,
    ...(input.type === 'ITEMIZED'
      ? input.items.flatMap((it) => it.assigneeIds)
      : input.participants.map((p) => p.personId)),
  ]
  if (!ids.every((id) => typeof id === 'string' && isUuid(id))) return false
  const unique = [...new Set(ids)]
  const found = await db
    .select({ id: person.id })
    .from(person)
    .where(and(eq(person.ownerId, ownerId), inArray(person.id, unique)))
  return found.length === unique.length
}

const UNKNOWN_PERSON = 'payerId, participants and assignees must be ids of your people'

const ORDER_REF = /^(walmart|samsclub)-\d+$/

/** An order charged once per shipment rarely needs more; bounds the request. */
const MAX_CHARGES = 20

/**
 * A split's charges as its page shows them: chosen columns, never the whole
 * row (the bank's row holds the Plaid access token), oldest first.
 */
const CHARGE_WITH = {
  columns: { id: true, date: true, amount: true, source: true, name: true, merchantName: true },
  with: {
    account: {
      columns: { name: true, mask: true },
      with: { item: { columns: { institutionName: true } } },
    },
  },
  orderBy: [asc(transaction.date), asc(transaction.id)] as SQL[],
} as const

function findByOrder(db: Db, ownerId: string, orderRef: string) {
  return db.query.expense.findFirst({
    where: (e, { and, eq }) => and(eq(e.orderRef, orderRef), eq(e.ownerId, ownerId)),
    columns: { id: true },
  })
}

/** The split's items and sharers, for its breakdown. */
function findForBreakdown(db: Db, ownerId: string, id: string) {
  return db.query.expense.findFirst({
    where: (e, { and, eq }) => and(eq(e.id, id), eq(e.ownerId, ownerId)),
    with: { items: { with: { assignments: true } }, participants: true },
  })
}

// ---------------------------------------------------------------------------
// POST /api/expenses
// ---------------------------------------------------------------------------
expenses.post('/', async (c) => {
  const db = c.var.db
  const uid = c.var.user.sub
  const body = await readJson(c)
  if (body instanceof Response) return body

  const parsed = parseExpenseInput(body)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const { input } = parsed
  const invalid = columnError(input)
  if (invalid) return c.json({ error: invalid }, 400)
  if (!(await peopleAreMine(db, uid, input))) return c.json({ error: UNKNOWN_PERSON }, 400)
  const tags = await findTags(db, uid, input.tags)
  const missing = unknownTags(input.tags, tags.map((t) => t.name))
  if (missing.length > 0) return c.json({ error: `unknown tag: ${missing.join(', ')}` }, 400)

  // Optional: the bank or hand-added transaction this split was made from
  const { transactionId } = (body ?? {}) as { transactionId?: unknown }
  if (transactionId !== undefined) {
    if (!isInt4(transactionId)) return c.json({ error: 'transactionId must be an integer' }, 400)
    // Locked until this request ends, so two splits can't both claim it
    const [source] = await db
      .select({ id: transaction.id, expenseId: transaction.expenseId })
      .from(transaction)
      .where(and(eq(transaction.id, transactionId), eq(transaction.ownerId, uid)))
      .for('update')
    if (!source) return c.json({ error: 'That transaction no longer exists' }, 400)
    if (source.expenseId) return c.json({ error: 'That transaction is already split' }, 409)
  }

  // Optional: the Walmart or Sam's Club order this split was imported from
  const { orderRef } = (body ?? {}) as { orderRef?: unknown }
  if (orderRef !== undefined) {
    if (input.type !== 'ITEMIZED') return c.json({ error: 'orderRef is only for itemized splits' }, 400)
    if (typeof orderRef !== 'string' || !ORDER_REF.test(orderRef)) {
      return c.json({ error: 'orderRef must look like walmart-<order id> or samsclub-<order id>' }, 400)
    }
    const existing = await findByOrder(db, uid, orderRef)
    if (existing) return c.json({ error: 'That order is already split', id: existing.id }, 409)
  }

  const id = crypto.randomUUID()
  const [inserted] = await db
    .insert(expense)
    .values({
      id,
      ...expenseFields(input),
      ...(orderRef !== undefined && { orderRef: orderRef as string }),
    })
    .onConflictDoNothing({ target: [expense.ownerId, expense.orderRef] })
    .returning({ id: expense.id })
  if (!inserted) {
    // Two saves of the same order at once: the unique index stops the second
    const existing = await findByOrder(db, uid, orderRef as string)
    return c.json({ error: 'That order is already split', id: existing?.id }, 409)
  }
  await writeChildren(db, id, input, tags.map((t) => t.id))
  if (transactionId !== undefined) {
    await db.update(transaction).set({ expenseId: id }).where(eq(transaction.id, transactionId as number))
  }

  const saved = (await findForBreakdown(db, uid, id))!
  return c.json({ id, breakdown: breakdownOf(saved) }, 201)
})

// ---------------------------------------------------------------------------
// GET /api/expenses
// ---------------------------------------------------------------------------
// Your own splits; row security also shows ones friends share with you
expenses.get('/', async (c) => {
  const rows = await c.var.db.query.expense.findMany({
    where: (e, { eq }) => eq(e.ownerId, c.var.user.sub),
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
// If any id is missing, nothing changes.
// ---------------------------------------------------------------------------
expenses.post('/bulk', async (c) => {
  const db = c.var.db
  const uid = c.var.user.sub
  const body = await readJson(c)
  if (body instanceof Response) return body

  const parsed = parseBulkAction(body)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const { ids, op } = parsed

  let tagId: string | undefined
  if (op.action === 'add-tag' || op.action === 'remove-tag') {
    tagId = (await findTags(db, uid, [op.tag]))[0]?.id
    if (!tagId) return c.json({ error: `unknown tag: ${op.tag}` }, 400)
  }

  if (!ids.every(isUuid)) return c.json({ error: 'Some expenses were not found' }, 404)
  const mine = and(inArray(expense.id, ids), eq(expense.ownerId, uid))
  const [{ found }] = await db.select({ found: count() }).from(expense).where(mine)
  if (found !== ids.length) return c.json({ error: 'Some expenses were not found' }, 404)

  if (op.action === 'set-logged') {
    await db.update(expense).set({ loggedToSplitwise: op.logged }).where(mine)
  } else if (op.action === 'delete') {
    await db.delete(expense).where(mine) // items and participants cascade
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
  const found = await findByOrder(c.var.db, c.var.user.sub, c.req.param('ref'))
  if (!found) return c.json({ error: 'No split for that order' }, 404)
  return c.json({ id: found.id })
})

// ---------------------------------------------------------------------------
// GET /api/expenses/:id
// ---------------------------------------------------------------------------
expenses.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Expense not found' }, 404)
  const row = await c.var.db.query.expense.findFirst({
    where: (e, { and, eq }) => and(eq(e.id, id), eq(e.ownerId, c.var.user.sub)),
    with: {
      ...EXPENSE_WITH,
      charges: CHARGE_WITH,
    },
  })
  if (!row) return c.json({ error: 'Expense not found' }, 404)

  const { charges, ...rest } = row
  const exp = expenseJson(rest)
  return c.json({ ...exp, charges, breakdown: breakdownOf(exp) })
})

// ---------------------------------------------------------------------------
// PUT /api/expenses/:id/charges  — { transactionIds: number[] }
// ---------------------------------------------------------------------------
// The card charges that paid for this split, as a whole set: charges left out
// are unlinked. A charge already on another split is refused, not moved.
expenses.put('/:id/charges', async (c) => {
  const db = c.var.db
  const uid = c.var.user.sub
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Expense not found' }, 404)
  const body = await readJson(c)
  if (body instanceof Response) return body
  const raw = (body as { transactionIds?: unknown } | null)?.transactionIds
  if (!Array.isArray(raw) || !raw.every(isInt4)) {
    return c.json({ error: 'transactionIds must be a list of transaction ids' }, 400)
  }
  const ids = [...new Set(raw as number[])]
  if (ids.length > MAX_CHARGES) return c.json({ error: `A split can have at most ${MAX_CHARGES} charges` }, 400)

  const [split] = await db
    .select({ id: expense.id })
    .from(expense)
    .where(and(eq(expense.id, id), eq(expense.ownerId, uid)))
  if (!split) return c.json({ error: 'Expense not found' }, 404)

  if (ids.length > 0) {
    // Locked until this request ends, so another split can't claim them meanwhile
    const chosen = await db
      .select({ id: transaction.id, expenseId: transaction.expenseId })
      .from(transaction)
      .where(and(inArray(transaction.id, ids), eq(transaction.ownerId, uid)))
      .for('update')
    if (chosen.length !== ids.length) return c.json({ error: 'One of those transactions no longer exists' }, 400)
    const taken = chosen.find((t) => t.expenseId !== null && t.expenseId !== id)
    if (taken) {
      return c.json({ error: 'That charge is already on another split', transactionId: taken.id, expenseId: taken.expenseId }, 409)
    }
  }

  await db
    .update(transaction)
    .set({ expenseId: null })
    .where(and(eq(transaction.expenseId, id), ...(ids.length > 0 ? [notInArray(transaction.id, ids)] : [])))
  if (ids.length > 0) {
    await db
      .update(transaction)
      .set({ expenseId: id })
      .where(and(inArray(transaction.id, ids), isNull(transaction.expenseId)))
  }

  const charges = await db.query.transaction.findMany({
    where: (t, { eq }) => eq(t.expenseId, id),
    ...CHARGE_WITH,
  })
  return c.json({ charges })
})

// ---------------------------------------------------------------------------
// PATCH /api/expenses/:id  — supports { loggedToSplitwise?: boolean, tags?: string[] }
// ---------------------------------------------------------------------------
expenses.patch('/:id', async (c) => {
  const db = c.var.db
  const uid = c.var.user.sub
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Expense not found' }, 404)
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
  const tags = tagNames ? await findTags(db, uid, tagNames) : []
  const missing = tagNames ? unknownTags(tagNames, tags.map((t) => t.name)) : []
  if (missing.length > 0) return c.json({ error: `unknown tag: ${missing.join(', ')}` }, 400)

  const exists = await db.query.expense.findFirst({
    where: (e, { and, eq }) => and(eq(e.id, id), eq(e.ownerId, uid)),
    columns: { id: true },
  })
  if (!exists) return c.json({ error: 'Expense not found' }, 404)

  if (loggedToSplitwise !== undefined) {
    await db.update(expense).set({ loggedToSplitwise }).where(eq(expense.id, id))
  }
  if (tagNames !== undefined) {
    // Replace the expense's tags with exactly this list
    await db.delete(expenseToTag).where(eq(expenseToTag.A, id))
    if (tags.length > 0) await db.insert(expenseToTag).values(tags.map((t) => ({ A: id, B: t.id })))
  }

  return c.json(expenseJson((await findExpense(db, uid, id))!))
})

// ---------------------------------------------------------------------------
// PUT /api/expenses/:id  — replace an expense with an edited version.
// Same body as POST /api/expenses; the type can't change. Clears
// loggedToSplitwise so the edit gets re-entered in Splitwise.
// ---------------------------------------------------------------------------
expenses.put('/:id', async (c) => {
  const db = c.var.db
  const uid = c.var.user.sub
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Expense not found' }, 404)
  const body = await readJson(c)
  if (body instanceof Response) return body

  const parsed = parseExpenseInput(body)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const { input } = parsed
  const invalid = columnError(input)
  if (invalid) return c.json({ error: invalid }, 400)
  if (!(await peopleAreMine(db, uid, input))) return c.json({ error: UNKNOWN_PERSON }, 400)
  const tags = await findTags(db, uid, input.tags)
  const missing = unknownTags(input.tags, tags.map((t) => t.name))
  if (missing.length > 0) return c.json({ error: `unknown tag: ${missing.join(', ')}` }, 400)

  const existing = await db.query.expense.findFirst({
    where: (e, { and, eq }) => and(eq(e.id, id), eq(e.ownerId, uid)),
    columns: { type: true },
  })
  if (!existing) return c.json({ error: 'Expense not found' }, 404)
  if (existing.type !== input.type) return c.json({ error: 'expense type cannot be changed' }, 400)

  // The request is one transaction: if any write fails, the split stays exactly as it was
  await db.delete(item).where(eq(item.expenseId, id)) // assignments cascade
  await db.delete(expenseParticipant).where(eq(expenseParticipant.expenseId, id))
  await db.delete(expenseToTag).where(eq(expenseToTag.A, id))
  await db.update(expense).set({ ...expenseFields(input), loggedToSplitwise: false }).where(eq(expense.id, id))
  await writeChildren(db, id, input, tags.map((t) => t.id))

  const saved = (await findForBreakdown(db, uid, id))!
  return c.json({ id, breakdown: breakdownOf(saved) })
})

// ---------------------------------------------------------------------------
// DELETE /api/expenses/:id
// ---------------------------------------------------------------------------
expenses.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Expense not found' }, 404)
  const deleted = await c.var.db
    .delete(expense)
    .where(and(eq(expense.id, id), eq(expense.ownerId, c.var.user.sub)))
    .returning({ id: expense.id })
  if (deleted.length === 0) return c.json({ error: 'Expense not found' }, 404)
  return c.json({ deleted: true })
})
