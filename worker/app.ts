import { Hono } from 'hono'
import { requireUser } from './auth'
import type { Db } from './db'
import type { UserClaims } from './db/as-user'
import { accounts } from './routes/accounts'
import { expenses } from './routes/expenses'
import { people } from './routes/people'
import { plaidRoutes } from './routes/plaid'
import { tags } from './routes/tags'
import { transactions } from './routes/transactions'

export type AppEnv = {
  Bindings: CloudflareEnv
  // Set by requireUser: the signed-in user, and the request's transaction as them
  Variables: { user: UserClaims; db: Db }
}

// Every route lives under /api. Everything else is the static React app,
// served by Cloudflare's asset handling without running this Worker.
export const app = new Hono<AppEnv>().basePath('/api')

// Every API call needs a Supabase login; without one it gets a 401
app.use('*', requireUser)

app.route('/expenses', expenses)
app.route('/people', people)
app.route('/tags', tags)
app.route('/transactions', transactions)
app.route('/accounts', accounts)
app.route('/plaid', plaidRoutes)

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Something went wrong' }, 500)
})
