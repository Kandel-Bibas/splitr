import { Hono } from 'hono'
import type { AppEnv } from '../app'
import { isPlaidConfigured } from '../plaid'

export const accounts = new Hono<AppEnv>()

// GET /api/accounts — linked banks and their accounts. Leaves out access
// tokens and sync cursors, which must never reach the browser.
accounts.get('/', async (c) => {
  const items = await c.var.db.query.plaidItem.findMany({
    where: (i, { eq }) => eq(i.ownerId, c.var.user.sub),
    orderBy: (i, { asc }) => [asc(i.createdAt)],
    columns: { id: true, institutionName: true, institutionLogo: true, institutionColor: true },
    with: {
      accounts: {
        orderBy: (a, { asc }) => [asc(a.name)],
        columns: { id: true, name: true, mask: true, type: true, subtype: true, currentBalance: true, updatedAt: true },
      },
    },
  })
  return c.json({ plaidConfigured: isPlaidConfigured(), items })
})
