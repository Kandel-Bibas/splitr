import { apportion, type Cents } from './money'

// The transaction shape the API returns, shared by server and client.

export interface TxView {
  id: number
  source: 'PLAID' | 'MANUAL'
  date: string
  amount: number
  name: string
  merchantName: string | null
  categoryPrimary: string | null
  categoryDetailed: string | null
  pending: boolean
  accountId: number | null
  split: {
    expenseId: string
    /** How many people share it, the payer included */
    ways: number
    /**
     * This charge's part of what comes back to you (everyone's shares except
     * the payer's). With several charges on one split, see chargeShares.
     */
    owedBackCents: number
    /** How many charges pay for the split, this one included */
    chargeCount: number
    logged: boolean
  } | null
}

/**
 * A short, human name for a transaction. Bank descriptions are often long
 * codes ("ORIG CO NAME:ACME CO ENTRY DESCR:..."), so prefer the merchant.
 */
export function txLabel(tx: Pick<TxView, 'merchantName' | 'name'>): string {
  return tx.merchantName || tx.name
}

/**
 * Divides what comes back to you on a split across the charges that paid for
 * it, in proportion to their amounts, to the cent (largest remainder). A
 * refund or other money-in charge gets none. Keyed by charge id.
 */
export function chargeShares(owedBackCents: Cents, charges: { id: number; amount: Cents }[]): Map<number, Cents> {
  if (charges.length === 0) return new Map()
  const ordered = [...charges].sort((a, b) => a.id - b.id)
  const parts = apportion(owedBackCents, ordered.map((c) => Math.max(0, c.amount)))
  return new Map(ordered.map((c, i) => [c.id, parts[i]]))
}
