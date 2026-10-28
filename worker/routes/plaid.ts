import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../app'
import type { Db } from '../db'
import { account, plaidItem } from '../db/schema'
import { readJson } from '../http'
import { PlaidConfigError, describeError, plaid, plaidRedirectUri } from '../plaid'
import { accountFields, syncAllItems, syncItem } from '../sync'
import { decryptToken, encryptToken } from '../token-crypto'
import { isInt4 } from '../views'

export const plaidRoutes = new Hono<AppEnv>()

/** 503 for missing Plaid keys, otherwise a 500 with a safe message. */
function plaidFailure(error: unknown, label: string, message: string) {
  if (error instanceof PlaidConfigError) return Response.json({ error: error.message }, { status: 503 })
  console.error(`[plaid] ${label} failed: ${describeError(error)}`, error)
  return Response.json({ error: message }, { status: 500 })
}

function findItem(db: Db, ownerId: string, id: number) {
  return db.query.plaidItem.findFirst({ where: (i, { and, eq }) => and(eq(i.id, id), eq(i.ownerId, ownerId)) })
}

plaidRoutes.post('/link-token', async (c) => {
  try {
    const { link_token } = await plaid.linkTokenCreate(plaidRedirectUri())
    return c.json({ link_token })
  } catch (error) {
    return plaidFailure(error, 'linkTokenCreate', 'Failed to create link token')
  }
})

// A link token in update mode, to sign back in to a bank whose login changed.
// The bank keeps its access token, so there is nothing to exchange afterwards.
plaidRoutes.post('/link-token/:itemId', async (c) => {
  const id = Number(c.req.param('itemId'))
  if (!isInt4(id)) return c.json({ error: 'Invalid item id' }, 400)
  const item = await findItem(c.var.db, c.var.user.sub, id)
  if (!item) return c.json({ error: 'Bank not found' }, 404)
  try {
    const accessToken = await decryptToken(item.accessToken, item.itemId, c.env.PLAID_TOKEN_KEY)
    const { link_token } = await plaid.linkTokenCreate(plaidRedirectUri(), accessToken)
    return c.json({ link_token })
  } catch (error) {
    return plaidFailure(error, `linkTokenCreate item ${id}`, 'Failed to create link token')
  }
})

plaidRoutes.post('/exchange', async (c) => {
  const db = c.var.db
  const body = await readJson(c)
  if (body instanceof Response) return body
  const publicToken = (body as { public_token?: string } | null)?.public_token
  if (!publicToken) return c.json({ error: 'Missing public_token' }, 400)

  try {
    const exchange = await plaid.publicTokenExchange(publicToken)
    const accessToken = exchange.access_token

    const itemInfo = await plaid.itemGet(accessToken)
    const institutionId = itemInfo.item.institution_id ?? null

    let institutionName: string | null = null
    let institutionLogo: string | null = null
    let institutionColor: string | null = null
    if (institutionId) {
      const { institution } = await plaid.institutionGetById(institutionId)
      institutionName = institution.name
      institutionLogo = institution.logo ?? null
      institutionColor = institution.primary_color ?? null
    }

    const { accounts } = await plaid.accountsGet(accessToken)

    const stored = await encryptToken(accessToken, exchange.item_id, c.env.PLAID_TOKEN_KEY)
    const [created] = await db
      .insert(plaidItem)
      .values({ itemId: exchange.item_id, accessToken: stored, institutionId, institutionName, institutionLogo, institutionColor })
      .returning({ id: plaidItem.id, institutionName: plaidItem.institutionName })
    if (accounts.length > 0) {
      await db
        .insert(account)
        .values(accounts.map((acct) => ({ plaidAccountId: acct.account_id, itemId: created.id, ...accountFields(acct) })))
    }

    return c.json({ id: created.id, institution_name: created.institutionName, account_count: accounts.length })
  } catch (error) {
    return plaidFailure(error, 'exchange', 'Failed to exchange public token')
  }
})

plaidRoutes.post('/sync', async (c) => {
  try {
    return c.json({ results: await syncAllItems(c.var.db, c.var.user.sub, c.env.PLAID_TOKEN_KEY) })
  } catch (error) {
    return plaidFailure(error, 'sync all', 'Sync failed')
  }
})

plaidRoutes.post('/sync/:itemId', async (c) => {
  const id = Number(c.req.param('itemId'))
  if (!isInt4(id)) return c.json({ error: 'Invalid item id' }, 400)
  if (!(await findItem(c.var.db, c.var.user.sub, id))) return c.json({ error: 'Bank not found' }, 404)
  try {
    return c.json({ results: [await syncItem(c.var.db, c.var.user.sub, id, c.env.PLAID_TOKEN_KEY)] })
  } catch (error) {
    return plaidFailure(error, `sync item ${id}`, 'Sync failed')
  }
})

// Unlink a bank at Plaid and drop its accounts and transactions. Splits made
// from them stay, unlinked.
plaidRoutes.delete('/items/:itemId', async (c) => {
  const db = c.var.db
  const uid = c.var.user.sub
  const id = Number(c.req.param('itemId'))
  if (!isInt4(id)) return c.json({ error: 'Invalid item id' }, 400)

  const item = await findItem(db, uid, id)
  if (!item) return c.json({ error: 'Bank not found' }, 404)

  // Outside the try below: a token that won't decrypt is a broken setup to
  // surface, not a Plaid hiccup to skip past on the way to deleting the row
  const accessToken = await decryptToken(item.accessToken, item.itemId, c.env.PLAID_TOKEN_KEY)
  try {
    await plaid.itemRemove(accessToken)
  } catch (error) {
    if (error instanceof PlaidConfigError) return c.json({ error: error.message }, 503)
    console.error(`[plaid] itemRemove ${id} failed: ${describeError(error)}`, error)
  }

  await db.delete(plaidItem).where(and(eq(plaidItem.id, id), eq(plaidItem.ownerId, uid)))
  return c.json({ ok: true })
})
