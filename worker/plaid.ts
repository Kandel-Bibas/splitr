// A small client for the Plaid endpoints this app uses, called with fetch.
// Plaid's own SDK covers hundreds of endpoints and is too large to ship in a
// Cloudflare Worker. Request and response shapes follow
// https://plaid.com/docs/api/ and only list the fields read here.

export class PlaidConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaidConfigError'
  }
}

/** A non-2xx response from Plaid; `code` is Plaid's error_code. */
export class PlaidApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'PlaidApiError'
  }
}

const HOSTS: Record<string, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new PlaidConfigError(`Missing ${name}. Add your Plaid keys (see .env.example).`)
  }
  return value
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const env = process.env.PLAID_ENV ?? 'sandbox'
  const host = HOSTS[env]
  if (!host) throw new PlaidConfigError(`PLAID_ENV must be sandbox or production, not "${env}"`)

  const res = await fetch(host + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': requireEnv('PLAID_CLIENT_ID'),
      'PLAID-SECRET': requireEnv('PLAID_SECRET'),
      'Plaid-Version': '2020-09-14',
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    throw new PlaidApiError(
      String(data?.error_code ?? 'UNKNOWN'),
      `Plaid ${path} failed: ${String(data?.error_message ?? res.statusText)}`,
      res.status,
    )
  }
  return data as T
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface PlaidAccount {
  account_id: string
  name: string
  official_name: string | null
  mask: string | null
  type: string
  subtype: string | null
  balances: {
    current: number | null
    available: number | null
    iso_currency_code: string | null
  }
}

export interface PlaidTransaction {
  transaction_id: string
  account_id: string
  /** YYYY-MM-DD */
  date: string
  /** Dollars; positive = money out */
  amount: number
  name: string
  merchant_name?: string | null
  personal_finance_category?: { primary: string; detailed: string } | null
  pending: boolean
  /** On a posted transaction, the pending one it replaces */
  pending_transaction_id?: string | null
  iso_currency_code: string | null
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

function listEnv(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback).split(',').map(v => v.trim())
}

export const plaid = {
  /** With an access token, Link opens in update mode to sign back in to that bank. */
  /** userId: the signed-in Supabase user, Plaid's stable id for the person linking. */
  linkTokenCreate: (userId: string, redirectUri?: string, accessToken?: string) =>
    call<{ link_token: string }>('/link/token/create', {
      client_name: 'Splitr',
      language: 'en',
      user: { client_user_id: userId },
      ...(accessToken
        ? { access_token: accessToken }
        : {
            products: listEnv('PLAID_PRODUCTS', 'transactions'),
            // Plaid's most history (24 months; it defaults to 90 days). Fixed
            // when a bank is linked: an already-linked bank must be relinked to get more
            transactions: { days_requested: 730 },
          }),
      country_codes: listEnv('PLAID_COUNTRY_CODES', 'US'),
      ...(redirectUri && { redirect_uri: redirectUri }),
    }),

  publicTokenExchange: (publicToken: string) =>
    call<{ access_token: string; item_id: string }>('/item/public_token/exchange', {
      public_token: publicToken,
    }),

  itemGet: (accessToken: string) =>
    call<{ item: { institution_id: string | null } }>('/item/get', { access_token: accessToken }),

  institutionGetById: (institutionId: string) =>
    call<{ institution: { name: string; logo?: string | null; primary_color?: string | null } }>(
      '/institutions/get_by_id',
      {
        institution_id: institutionId,
        country_codes: listEnv('PLAID_COUNTRY_CODES', 'US'),
        options: { include_optional_metadata: true },
      },
    ),

  accountsGet: (accessToken: string) =>
    call<{ accounts: PlaidAccount[] }>('/accounts/get', { access_token: accessToken }),

  transactionsSync: (accessToken: string, cursor?: string) =>
    call<{
      added: PlaidTransaction[]
      modified: PlaidTransaction[]
      removed: { transaction_id: string }[]
      next_cursor: string
      has_more: boolean
    }>('/transactions/sync', { access_token: accessToken, ...(cursor && { cursor }) }),

  itemRemove: (accessToken: string) => call<object>('/item/remove', { access_token: accessToken }),
}

/**
 * The reason, as one line of text. Workers Logs keeps only the stack of an
 * Error passed to console.error, not its message, so log lines carry this.
 */
export function describeError(error: unknown): string {
  if (error instanceof PlaidApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

export function plaidRedirectUri(): string | undefined {
  return process.env.PLAID_REDIRECT_URI?.trim() || undefined
}

export function isPlaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)
}
