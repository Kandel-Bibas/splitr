import { asc } from 'drizzle-orm'
import { computeBreakdown, type Breakdown } from '@/lib/expense-breakdown'
import type { TxView } from '@/lib/transactions'
import type { Db } from './db'
import { item } from './db/schema'

// Row loading and JSON shapes shared by the API routes. The shapes match what
// the API returned when it ran on Prisma, which the pages depend on.

const INT4_MAX = 2_147_483_647

/** Whether a request value fits a Postgres integer column; anything else would fail the statement. */
export function isInt4(value: unknown): value is number {
  return Number.isInteger(value) && Math.abs(value as number) <= INT4_MAX
}

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

/** Everything a split's JSON needs: items with their people, sharers, payer, tags. */
export const EXPENSE_WITH = {
  items: { with: { assignments: true }, orderBy: asc(item.sortOrder) },
  participants: true,
  payer: true,
  tagLinks: { with: { tag: true } },
} as const

type ExpenseRow = NonNullable<Awaited<ReturnType<typeof findExpense>>>

export function findExpense(db: Db, ownerId: string, id: string) {
  return db.query.expense.findFirst({
    where: (e, { and, eq }) => and(eq(e.id, id), eq(e.ownerId, ownerId)),
    with: EXPENSE_WITH,
  })
}

/** A split with its tags as sorted names, in place of the link rows. */
export function expenseJson({ tagLinks, ...e }: ExpenseRow) {
  return { ...e, tags: tagLinks.map((l) => l.tag.name).sort() }
}

type BreakdownSource = {
  type: 'ITEMIZED' | 'SIMPLE'
  splitMethod: 'EVEN' | 'EXACT' | 'ITEMIZED'
  payerId: string
  taxCents: number
  tipFeesCents: number
  discountCents: number
  refundCents: number
  totalCents: number
  items: { id: string; lineTotalCents: number; returned: boolean; assignments: { personId: string }[] }[]
  participants: { personId: string; exactAmountCents: number | null }[]
}

export function breakdownOf(e: BreakdownSource): Breakdown {
  return computeBreakdown({
    type: e.type,
    splitMethod: e.splitMethod,
    payerId: e.payerId,
    taxCents: e.taxCents,
    tipFeesCents: e.tipFeesCents,
    discountCents: e.discountCents,
    refundCents: e.refundCents,
    totalCents: e.totalCents,
    items: e.items.map((i) => ({
      id: i.id,
      lineTotalCents: i.lineTotalCents,
      returned: i.returned,
      assignments: i.assignments.map((a) => ({ personId: a.personId })),
    })),
    participants: e.participants.map((p) => ({ personId: p.personId, exactAmountCents: p.exactAmountCents })),
  })
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** What txView needs to describe a linked split. */
export const TX_WITH = {
  expense: { with: { items: { with: { assignments: true } }, participants: true } },
} as const

type TxRow = NonNullable<Awaited<ReturnType<typeof findTx>>>

export function findTx(db: Db, ownerId: string, id: number) {
  return db.query.transaction.findFirst({
    where: (t, { and, eq }) => and(eq(t.id, id), eq(t.ownerId, ownerId)),
    with: TX_WITH,
  })
}

/** A transaction as the client sees it; never includes Plaid tokens. */
export function txView(tx: TxRow): TxView {
  let split: TxView['split'] = null
  if (tx.expense) {
    const breakdown = breakdownOf(tx.expense)
    split = {
      expenseId: tx.expense.id,
      ways: breakdown.perPerson.length,
      owedBackCents: breakdown.owes.reduce((s, o) => s + o.cents, 0),
      logged: tx.expense.loggedToSplitwise,
    }
  }
  return {
    id: tx.id,
    source: tx.source,
    date: tx.date,
    amount: tx.amount,
    name: tx.name,
    merchantName: tx.merchantName,
    categoryPrimary: tx.userCategory ?? tx.categoryPrimary,
    // The bank's detailed category no longer applies once you've recategorized
    categoryDetailed: tx.userCategory ? null : tx.categoryDetailed,
    pending: tx.pending,
    accountId: tx.accountId,
    split,
  }
}
