import { relations } from 'drizzle-orm'
import { customType, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Mirrors the tables in migrations/ (0001_init.sql was first created by
// Prisma); names and column types must keep matching them.

/**
 * DATETIME columns hold ISO text. Rows written by different tools use either
 * "…Z" or "…+00:00"; both read back as a Date, and a Date goes to JSON as
 * "…Z", which is the shape the API has always returned.
 */
const dateTime = customType<{ data: Date; driverData: string }>({
  dataType: () => 'DATETIME',
  toDriver: (d) => d.toISOString(),
  fromDriver: (v) => new Date(v),
})

const bool = (name: string) => integer(name, { mode: 'boolean' })
const newId = () => crypto.randomUUID()
const now = () => new Date()

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

export const person = sqliteTable('Person', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
  colorHex: text('colorHex').notNull().default('#64748b'),
  isDefault: bool('isDefault').notNull().default(false),
  // The person who owns the linked bank accounts; at most one
  isMe: bool('isMe').notNull().default(false),
  archived: bool('archived').notNull().default(false),
  createdAt: dateTime('createdAt').notNull().$defaultFn(now),
})

export const expense = sqliteTable('Expense', {
  id: text('id').primaryKey().$defaultFn(newId),
  type: text('type', { enum: ['ITEMIZED', 'SIMPLE'] }).notNull(),
  description: text('description').notNull().default(''),
  store: text('store'),
  purchasedAt: dateTime('purchasedAt'),
  payerId: text('payerId').notNull(),
  subtotalCents: integer('subtotalCents').notNull().default(0),
  taxCents: integer('taxCents').notNull().default(0),
  // Itemized only: driver tip + fees (>= 0), discounts (<= 0), refunds (<= 0)
  tipFeesCents: integer('tipFeesCents').notNull().default(0),
  discountCents: integer('discountCents').notNull().default(0),
  refundCents: integer('refundCents').notNull().default(0),
  totalCents: integer('totalCents').notNull(),
  splitMethod: text('splitMethod', { enum: ['EVEN', 'EXACT', 'ITEMIZED'] }).notNull(),
  loggedToSplitwise: bool('loggedToSplitwise').notNull().default(false),
  imagePath: text('imagePath'),
  createdAt: dateTime('createdAt').notNull().$defaultFn(now),
  // The bank or hand-added transaction this split was made from, if any
  transactionId: integer('transactionId'),
  // The online order it was imported from ("walmart-<id>"); unique
  orderRef: text('orderRef'),
})

export const tag = sqliteTable('Tag', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
})

/** Prisma's implicit many-to-many table: A = Expense.id, B = Tag.id */
export const expenseToTag = sqliteTable('_ExpenseToTag', {
  A: text('A').notNull(),
  B: text('B').notNull(),
})

export const item = sqliteTable('Item', {
  id: text('id').primaryKey().$defaultFn(newId),
  expenseId: text('expenseId').notNull(),
  rawName: text('rawName'),
  name: text('name').notNull(),
  quantity: real('quantity').notNull().default(1),
  unitPriceCents: integer('unitPriceCents').notNull(),
  lineTotalCents: integer('lineTotalCents').notNull(),
  sortOrder: integer('sortOrder').notNull(),
  returned: bool('returned').notNull().default(false),
})

export const itemAssignment = sqliteTable(
  'ItemAssignment',
  {
    itemId: text('itemId').notNull(),
    personId: text('personId').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.personId] })],
)

export const expenseParticipant = sqliteTable(
  'ExpenseParticipant',
  {
    expenseId: text('expenseId').notNull(),
    personId: text('personId').notNull(),
    exactAmountCents: integer('exactAmountCents'),
  },
  (t) => [primaryKey({ columns: [t.expenseId, t.personId] })],
)

// ---------------------------------------------------------------------------
// Money: linked banks and spending
// ---------------------------------------------------------------------------

export const plaidItem = sqliteTable('PlaidItem', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  itemId: text('itemId').notNull(),
  accessToken: text('accessToken').notNull(),
  institutionId: text('institutionId'),
  institutionName: text('institutionName'),
  institutionLogo: text('institutionLogo'),
  institutionColor: text('institutionColor'),
  cursor: text('cursor'),
  createdAt: dateTime('createdAt').notNull().$defaultFn(now),
})

export const account = sqliteTable('Account', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
  updatedAt: dateTime('updatedAt').notNull().$defaultFn(now),
})

export const transaction = sqliteTable('Transaction', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
  pending: bool('pending').notNull().default(false),
  isoCurrencyCode: text('isoCurrencyCode').notNull().default('USD'),
  createdAt: dateTime('createdAt').notNull().$defaultFn(now),
})

// One row per account per local day, written at each sync
export const balanceSnapshot = sqliteTable('BalanceSnapshot', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
