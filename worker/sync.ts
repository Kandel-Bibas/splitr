import { and, eq, sql } from 'drizzle-orm'
import { toCents } from '@/lib/money'
import { todayLocal } from '@/lib/spending'
import type { Db } from './db'
import { plaidItem } from './db/schema'
import { decryptToken } from './token-crypto'
import { PlaidApiError, PlaidConfigError, describeError, plaid, type PlaidAccount, type PlaidTransaction } from './plaid'

export interface SyncResult {
  itemId: number
  institutionName: string | null
  added: number
  modified: number
  removed: number
  /** This bank failed; the others still sync. login_required: reconnect it on Banks. */
  error?: 'login_required' | 'failed'
}

const cents = (v: number | null | undefined) => (v != null ? toCents(v) : null)

/** The Account columns that come from Plaid; shared by link and sync. */
export function accountFields(acct: PlaidAccount) {
  return {
    name: acct.name,
    officialName: acct.official_name ?? null,
    mask: acct.mask ?? null,
    type: acct.type,
    subtype: acct.subtype ?? null,
    currentBalance: cents(acct.balances.current),
    availableBalance: cents(acct.balances.available),
    isoCurrencyCode: acct.balances.iso_currency_code ?? 'USD',
  }
}

// Each statement below takes a whole list as one JSON parameter and reads it
// with jsonb_to_recordset (or jsonb_array_elements_text), so a sync is a
// handful of statements however many transactions it brings; a first sync
// can bring hundreds. They run as the signed-in user, so row security keeps
// them to that user's banks and the joins can only find their accounts.
//
// A statement may not touch the same row twice, so repeated ids in a list
// are collapsed first, the last one winning.

const lastById = <T>(rows: T[], id: (row: T) => string) => [...new Map(rows.map((r) => [id(r), r])).values()]

export async function upsertAccounts(db: Db, itemId: number, accounts: PlaidAccount[], updatedAt: string) {
  const rows = lastById(accounts, (a) => a.account_id).map((a) => ({ plaidAccountId: a.account_id, ...accountFields(a) }))
  await db.execute(sql`
    INSERT INTO splitr."Account" ("plaidAccountId", "itemId", "name", "officialName", "mask", "type", "subtype",
      "currentBalance", "availableBalance", "isoCurrencyCode", "updatedAt")
    SELECT j."plaidAccountId", ${itemId}::integer, j."name", j."officialName", j."mask", j."type", j."subtype",
      j."currentBalance", j."availableBalance", j."isoCurrencyCode", ${updatedAt}::timestamptz
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS j("plaidAccountId" text, "name" text,
      "officialName" text, "mask" text, "type" text, "subtype" text, "currentBalance" integer,
      "availableBalance" integer, "isoCurrencyCode" text)
    ON CONFLICT ("plaidAccountId") DO UPDATE SET
      "name" = excluded."name", "officialName" = excluded."officialName", "mask" = excluded."mask",
      "type" = excluded."type", "subtype" = excluded."subtype", "currentBalance" = excluded."currentBalance",
      "availableBalance" = excluded."availableBalance", "isoCurrencyCode" = excluded."isoCurrencyCode",
      "updatedAt" = excluded."updatedAt"`)
}

/** One balance per account per day; a repeat sync the same day keeps the latest. */
export async function upsertSnapshots(db: Db, accounts: PlaidAccount[], date: string) {
  const rows = lastById(accounts, (a) => a.account_id).map((a) => ({
    plaidAccountId: a.account_id,
    currentBalance: cents(a.balances.current),
    availableBalance: cents(a.balances.available),
  }))
  await db.execute(sql`
    INSERT INTO splitr."BalanceSnapshot" ("accountId", "date", "currentBalance", "availableBalance")
    SELECT a."id", ${date}::text, j."currentBalance", j."availableBalance"
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS j("plaidAccountId" text,
      "currentBalance" integer, "availableBalance" integer)
    JOIN splitr."Account" a ON a."plaidAccountId" = j."plaidAccountId"
    ON CONFLICT ("accountId", "date") DO UPDATE SET
      "currentBalance" = excluded."currentBalance", "availableBalance" = excluded."availableBalance"`)
}

/** Transactions on accounts we don't know are skipped by the JOIN. */
export async function upsertTransactions(db: Db, txs: PlaidTransaction[], createdAt: string) {
  const rows = lastById(txs, (tx) => tx.transaction_id).map((tx) => ({
    plaidTransactionId: tx.transaction_id,
    plaidAccountId: tx.account_id,
    date: tx.date,
    amount: toCents(tx.amount),
    name: tx.name,
    merchantName: tx.merchant_name ?? null,
    categoryPrimary: tx.personal_finance_category?.primary ?? null,
    categoryDetailed: tx.personal_finance_category?.detailed ?? null,
    pending: tx.pending,
    isoCurrencyCode: tx.iso_currency_code ?? 'USD',
  }))
  // Never touches userCategory, so your recategorizing survives syncs
  await db.execute(sql`
    INSERT INTO splitr."Transaction" ("source", "plaidTransactionId", "accountId", "date", "amount", "name",
      "merchantName", "categoryPrimary", "categoryDetailed", "pending", "isoCurrencyCode", "createdAt")
    SELECT 'PLAID', j."plaidTransactionId", a."id", j."date", j."amount", j."name", j."merchantName",
      j."categoryPrimary", j."categoryDetailed", j."pending", j."isoCurrencyCode", ${createdAt}::timestamptz
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS j("plaidTransactionId" text,
      "plaidAccountId" text, "date" text, "amount" integer, "name" text, "merchantName" text,
      "categoryPrimary" text, "categoryDetailed" text, "pending" boolean, "isoCurrencyCode" text)
    JOIN splitr."Account" a ON a."plaidAccountId" = j."plaidAccountId"
    ON CONFLICT ("plaidTransactionId") DO UPDATE SET
      "accountId" = excluded."accountId", "date" = excluded."date", "amount" = excluded."amount",
      "name" = excluded."name", "merchantName" = excluded."merchantName",
      "categoryPrimary" = excluded."categoryPrimary", "categoryDetailed" = excluded."categoryDetailed",
      "pending" = excluded."pending", "isoCurrencyCode" = excluded."isoCurrencyCode"`)
}

/**
 * When a pending charge posts, Plaid removes the pending transaction and adds
 * a new one pointing back at it. Moves any split to the posted one before the
 * pending row is deleted. A posted charge that already has a split keeps it.
 */
export async function moveSplitsToPosted(db: Db, pairs: { pending: string; posted: string }[]) {
  await db.execute(sql`
    UPDATE splitr."Transaction" po SET "expenseId" = pe."expenseId"
    FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS j("pending" text, "posted" text)
    JOIN splitr."Transaction" pe ON pe."plaidTransactionId" = j."pending"
    WHERE po."plaidTransactionId" = j."posted"
      AND pe."expenseId" IS NOT NULL
      AND po."expenseId" IS NULL`)
}

/** A split made from a removed transaction stays; its link is cleared. */
export async function deleteTransactions(db: Db, plaidIds: string[]) {
  await db.execute(sql`
    DELETE FROM splitr."Transaction"
    WHERE "plaidTransactionId" IN (SELECT jsonb_array_elements_text(${JSON.stringify(plaidIds)}::jsonb))`)
}

/** Syncs one of the user's banks. Its failure is logged and returned, so it doesn't stop the others. */
export async function syncItem(db: Db, userId: string, itemDbId: number, tokenKey: string): Promise<SyncResult> {
  const item = await db.query.plaidItem.findFirst({
    where: (i, { and, eq }) => and(eq(i.id, itemDbId), eq(i.ownerId, userId)),
  })
  if (!item) throw new Error(`Plaid item ${itemDbId} not found`)

  const base = { itemId: item.id, institutionName: item.institutionName }
  try {
    return { ...base, ...(await pullItem(db, item, tokenKey)) }
  } catch (error) {
    if (error instanceof PlaidConfigError) throw error
    console.error(`[plaid] sync ${item.institutionName ?? 'bank'} (item ${item.id}) failed: ${describeError(error)}`, error)
    const loginRequired = error instanceof PlaidApiError && error.code === 'ITEM_LOGIN_REQUIRED'
    return { ...base, added: 0, modified: 0, removed: 0, error: loginRequired ? 'login_required' : 'failed' }
  }
}

async function pullItem(db: Db, item: typeof plaidItem.$inferSelect, tokenKey: string) {
  const accessToken = await decryptToken(item.accessToken, item.itemId, tokenKey)
  const { accounts } = await plaid.accountsGet(accessToken)

  const added: PlaidTransaction[] = []
  const modified: PlaidTransaction[] = []
  const removed: { transaction_id: string }[] = []
  let cursor: string | undefined = item.cursor ?? undefined
  let hasMore = true
  let pages = 0
  while (hasMore) {
    let resp
    try {
      resp = await plaid.transactionsSync(accessToken, cursor)
    } catch (error) {
      // Right after linking Plaid is still pulling history and returns
      // PRODUCT_NOT_READY. Treat it as "no data yet"; the cursor is left
      // untouched so a later sync picks up where this one left off.
      if (error instanceof PlaidApiError && error.code === 'PRODUCT_NOT_READY') break
      throw error
    }
    added.push(...resp.added)
    modified.push(...resp.modified)
    removed.push(...resp.removed)
    cursor = resp.next_cursor
    hasMore = resp.has_more
    pages += 1
    if (pages > 50) break
  }

  // Everything for this bank is written in one savepoint: if any part fails,
  // nothing changes and the cursor stays put, so the next sync retries it all,
  // and the request's transaction stays usable for the other banks.
  const now = new Date().toISOString()
  const pendingPairs = added
    .filter((tx) => tx.pending_transaction_id)
    .map((tx) => ({ pending: tx.pending_transaction_id!, posted: tx.transaction_id }))
  const removedIds = removed.map((r) => r.transaction_id).filter(Boolean)
  const changed = [...added, ...modified]

  await db.transaction(async (tx) => {
    await upsertAccounts(tx, item.id, accounts, now)
    await upsertSnapshots(tx, accounts, todayLocal())
    if (changed.length > 0) await upsertTransactions(tx, changed, now)
    if (pendingPairs.length > 0) await moveSplitsToPosted(tx, pendingPairs)
    if (removedIds.length > 0) await deleteTransactions(tx, removedIds)
    await tx.update(plaidItem).set({ cursor: cursor ?? null }).where(and(eq(plaidItem.id, item.id), eq(plaidItem.ownerId, item.ownerId)))
  })

  return { added: added.length, modified: modified.length, removed: removed.length }
}

export async function syncAllItems(db: Db, userId: string, tokenKey: string): Promise<SyncResult[]> {
  const items = await db.select({ id: plaidItem.id }).from(plaidItem).where(eq(plaidItem.ownerId, userId)).orderBy(plaidItem.id)
  const results: SyncResult[] = []
  for (const item of items) results.push(await syncItem(db, userId, item.id, tokenKey))
  return results
}
