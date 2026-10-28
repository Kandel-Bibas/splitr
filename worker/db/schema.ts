import { relations, sql } from 'drizzle-orm'
import { boolean, doublePrecision, integer, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// Mirrors supabase/migrations; names and column types must keep matching them.
//
// "ownerId" is on every table but never written here: Postgres fills it from
// the signed-in user, and row security keeps each query to that user's rows
// (plus splits shared with them). See worker/db/as-user.ts.

const splitr = pgSchema('splitr')

const dateTime = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const ownerId = () => uuid('ownerId').notNull().default(sql`auth.uid()`)

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

export const person = splitr.table('Person', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: ownerId(),
  name: text('name').notNull(),
  colorHex: text('colorHex').notNull().default('#64748b'),
  isDefault: boolean('isDefault').notNull().default(false),
  // The person who owns the linked bank accounts; at most one
  isMe: boolean('isMe').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  // The Splitr user this contact is, once they accept an invite; only the
  // Worker's admin path sets it
  linkedUserId: uuid('linkedUserId'),
  createdAt: dateTime('createdAt').notNull().defaultNow(),
})

export const expense = splitr.table('Expense', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: ownerId(),
  type: text('type', { enum: ['ITEMIZED', 'SIMPLE'] }).notNull(),
  description: text('description').notNull().default(''),
  store: text('store'),
  purchasedAt: dateTime('purchasedAt'),
  payerId: uuid('payerId').notNull(),
  subtotalCents: integer('subtotalCents').notNull().default(0),
  taxCents: integer('taxCents').notNull().default(0),
  // Itemized only: driver tip + fees (>= 0), discounts (<= 0), refunds (<= 0)
  tipFeesCents: integer('tipFeesCents').notNull().default(0),
  discountCents: integer('discountCents').notNull().default(0),
  refundCents: integer('refundCents').notNull().default(0),
  totalCents: integer('totalCents').notNull(),
  splitMethod: text('splitMethod', { enum: ['EVEN', 'EXACT', 'ITEMIZED'] }).notNull(),
  loggedToSplitwise: boolean('loggedToSplitwise').notNull().default(false),
  imagePath: text('imagePath'),
  createdAt: dateTime('createdAt').notNull().defaultNow(),
  // The bank or hand-added transaction this split was made from, if any
  transactionId: integer('transactionId'),
  // The online order it was imported from ("walmart-<id>"); unique
  orderRef: text('orderRef'),
})

export const tag = splitr.table('Tag', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: ownerId(),
  name: text('name').notNull(),
})

/** A = Expense.id, B = Tag.id (the Prisma-era names) */
export const expenseToTag = splitr.table('_ExpenseToTag', {
  A: uuid('A').notNull(),
  B: uuid('B').notNull(),
  ownerId: ownerId(),
})

export const item = splitr.table('Item', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: ownerId(),
  expenseId: uuid('expenseId').notNull(),
  rawName: text('rawName'),
  name: text('name').notNull(),
  quantity: doublePrecision('quantity').notNull().default(1),
  unitPriceCents: integer('unitPriceCents').notNull(),
  lineTotalCents: integer('lineTotalCents').notNull(),
  sortOrder: integer('sortOrder').notNull(),
  returned: boolean('returned').notNull().default(false),
})

export const itemAssignment = splitr.table(
  'ItemAssignment',
  {
    itemId: uuid('itemId').notNull(),
    personId: uuid('personId').notNull(),
    ownerId: ownerId(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.personId] })],
)

export const expenseParticipant = splitr.table(
  'ExpenseParticipant',
  {
    expenseId: uuid('expenseId').notNull(),
    personId: uuid('personId').notNull(),
    ownerId: ownerId(),
    exactAmountCents: integer('exactAmountCents'),
  },
  (t) => [primaryKey({ columns: [t.expenseId, t.personId] })],
)

// ---------------------------------------------------------------------------
// Money: linked banks and spending
// ---------------------------------------------------------------------------

export const plaidItem = splitr.table('PlaidItem', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  ownerId: ownerId(),
  itemId: text('itemId').notNull(),
  // AES-GCM ciphertext (worker/token-crypto.ts), never the token itself
  accessToken: text('accessToken').notNull(),
  institutionId: text('institutionId'),
  institutionName: text('institutionName'),
  institutionLogo: text('institutionLogo'),
  institutionColor: text('institutionColor'),
  cursor: text('cursor'),
  createdAt: dateTime('createdAt').notNull().defaultNow(),
})

export const account = splitr.table('Account', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  ownerId: ownerId(),
  plaidAccountId: text('plaidAccountId').notNull(),
  itemId: integer('itemId').notNull(),
  name: text('name').notNull(),
  officialName: text('officialName'),
  mask: text('mask'),
  type: text('type').notNull(),
  subtype: text('subtype'),
  // Integer cents
  currentBalance: integer('currentBalance'),
  availableBalance: integer('availableBalance'),
  isoCurrencyCode: text('isoCurrencyCode').notNull().default('USD'),
  updatedAt: dateTime('updatedAt').notNull().defaultNow(),
})

export const transaction = splitr.table('Transaction', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  ownerId: ownerId(),
  source: text('source', { enum: ['PLAID', 'MANUAL'] }).notNull().default('PLAID'),
  plaidTransactionId: text('plaidTransactionId'),
  // Null for hand-added (cash) transactions
  accountId: integer('accountId'),
  // YYYY-MM-DD, the local calendar day
  date: text('date').notNull(),
  // Integer cents, Plaid's sign: positive = money out, negative = money in
  amount: integer('amount').notNull(),
  name: text('name').notNull(),
  merchantName: text('merchantName'),
  categoryPrimary: text('categoryPrimary'),
  categoryDetailed: text('categoryDetailed'),
  // Your pick, which wins over the bank's category; sync never touches it
  userCategory: text('userCategory'),
  pending: boolean('pending').notNull().default(false),
  isoCurrencyCode: text('isoCurrencyCode').notNull().default('USD'),
  createdAt: dateTime('createdAt').notNull().defaultNow(),
})

// One row per account per local day, written at each sync
export const balanceSnapshot = splitr.table('BalanceSnapshot', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  ownerId: ownerId(),
  accountId: integer('accountId').notNull(),
  date: text('date').notNull(),
  currentBalance: integer('currentBalance'),
  availableBalance: integer('availableBalance'),
})

// ---------------------------------------------------------------------------
// Relations, for db.query.*.findMany({ with: ... })
// ---------------------------------------------------------------------------

export const personRelations = relations(person, ({ many }) => ({
  paidExpenses: many(expense),
}))

export const expenseRelations = relations(expense, ({ one, many }) => ({
  payer: one(person, { fields: [expense.payerId], references: [person.id] }),
  transaction: one(transaction, { fields: [expense.transactionId], references: [transaction.id] }),
  items: many(item),
  participants: many(expenseParticipant),
  tagLinks: many(expenseToTag),
}))

export const tagRelations = relations(tag, ({ many }) => ({
  expenseLinks: many(expenseToTag),
}))

export const expenseToTagRelations = relations(expenseToTag, ({ one }) => ({
  expense: one(expense, { fields: [expenseToTag.A], references: [expense.id] }),
  tag: one(tag, { fields: [expenseToTag.B], references: [tag.id] }),
}))

export const itemRelations = relations(item, ({ one, many }) => ({
  expense: one(expense, { fields: [item.expenseId], references: [expense.id] }),
  assignments: many(itemAssignment),
}))

export const itemAssignmentRelations = relations(itemAssignment, ({ one }) => ({
  item: one(item, { fields: [itemAssignment.itemId], references: [item.id] }),
}))

export const expenseParticipantRelations = relations(expenseParticipant, ({ one }) => ({
  expense: one(expense, { fields: [expenseParticipant.expenseId], references: [expense.id] }),
}))

export const plaidItemRelations = relations(plaidItem, ({ many }) => ({
  accounts: many(account),
}))

export const accountRelations = relations(account, ({ one, many }) => ({
  item: one(plaidItem, { fields: [account.itemId], references: [plaidItem.id] }),
  transactions: many(transaction),
}))

export const transactionRelations = relations(transaction, ({ one }) => ({
  account: one(account, { fields: [transaction.accountId], references: [account.id] }),
  expense: one(expense, { fields: [transaction.id], references: [expense.transactionId] }),
}))
