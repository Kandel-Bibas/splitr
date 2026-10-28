# Splitr

Personal money tracker and bill splitter. Linked banks (through Plaid) and
hand-added expenses land in **Money**; any charge can be split with friends,
and your share comes off what you spent. Splits give clean per-person amounts
to copy into Splitwise.

Runs on Cloudflare Workers with Supabase for sign-in and Postgres. Invite
only: each person has their own banks, people and splits, and Postgres row
security keeps every query to the signed-in user's rows.

---

## How it's built

- **`src/`** — the React app (Vite + TanStack Router). It builds to static
  files that Cloudflare serves directly, without running any code.
- **`worker/`** — the API (Hono), the only code that runs on Cloudflare.
  Every route is under `/api`; `wrangler.jsonc` sends only those to the Worker.
  Each request must carry a Supabase login (`worker/auth.ts`) and runs as one
  Postgres transaction as that user (`worker/db/as-user.ts`).
- **`supabase/migrations/`** — the Postgres tables and row-security rules.
- **`worker/db/schema.ts`** — the same tables, described for Drizzle.
- **`lib/`** — shared logic with no framework in it: the split math, money,
  spending summaries, input validation. Covered by `npm test`.

---

## Develop locally

Requires Node.js 22+, and Docker for `npm run test:db`.

```bash
npm install
cp .env.example .dev.vars     # add your Plaid keys and PLAID_TOKEN_KEY
npm run dev                   # http://localhost:5173
```

`npm run dev` runs the React app and the API together, with the API inside
Cloudflare's runtime. Sign-in always goes through the hosted Supabase project,
so the API's database must be that project's too: the local Docker database
in `wrangler.jsonc` has none of its users, and writes there fail. Until that
is wired up, test API changes with `npm run test:db`. To try the production
build locally, run `npm run preview`.

### Changing the database

Write the change as a new SQL file in `supabase/migrations/`, then describe it
in `worker/db/schema.ts`. Test it against a local Postgres in Docker (one-time
setup in `test/db/setup.ts`):

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres npm run test:db
```

The whole request is one transaction: it commits when the handler returns and
rolls back if it throws. A statement that fails leaves the transaction
unusable, so expected conflicts are written as `ON CONFLICT DO NOTHING` and
checked, not caught.

---

## Deploy

Not yet set up for this fork: `wrangler.jsonc` still has a placeholder
Hyperdrive id and the original custom domain.

```bash
npm run deploy
```

Secrets are set once with `npx wrangler secret put <NAME>` for each key in
`.env.example`. `PLAID_TOKEN_KEY` encrypts stored Plaid tokens; changing it
means every bank has to be relinked.

### Where it's hosted

- **Cloudflare Workers** runs the API and serves the built React app as static
  assets. Free-plan limits: the Worker bundle (only `worker/`) must stay under
  3 MB compressed, each request gets 10 ms of CPU time, and only `/api/*`
  calls count toward the 100,000 Worker requests per day.
- **Supabase** signs people in (email links, invite only) and holds the
  Postgres database. The free plan pauses a project after 7 idle days.
- **Hyperdrive** pools the Worker's connections to Postgres.

---

## Usage

- **Money**: spending by month, where it went, and every transaction. **Sync**
  pulls new charges; **+ Add expense** logs cash. Tap **Split** on a charge to
  split it.
- **Splits**: every split; tick several to see who owes whom overall.
- **People**: who you split with. Mark yourself with **This is me** so splits
  from your charges start with you as the payer.
- **Banks**: link, sync, or unlink banks.

Spending leaves out money moving between your own accounts (transfers and
credit card payments), so a purchase isn't counted twice.

## How the math works

- All amounts are integer cents.
- Receipt tax is prorated across items by price.
- Per-person totals use a largest-remainder method so they add up to the total
  exactly.

## Tests

```bash
npm test                                   # logic and UI
DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres \
  npm run test:db                          # API, sign-in and row security on Postgres
```

## Tech stack

React 19 · Vite · TanStack Router · Tailwind CSS v4 · Hono · Drizzle ORM +
Supabase (Auth, Postgres) · Hyperdrive · Plaid (called with fetch) · Vitest
