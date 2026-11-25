import { splitItemized, splitSimpleEven, splitSimpleExact, PersonShare } from '@/lib/split'

export interface BreakdownExpense {
  type: 'ITEMIZED' | 'SIMPLE'
  splitMethod: 'EVEN' | 'EXACT' | 'ITEMIZED'
  payerId: string
  taxCents: number
  /** Itemized only: tip + fees, discounts (<= 0), refunds (<= 0); see lib/split.ts */
  tipFeesCents: number
  discountCents: number
  refundCents: number
  totalCents: number
  items: { id: string; lineTotalCents: number; returned: boolean; assignments: { personId: string }[] }[]
  participants: { personId: string; exactAmountCents: number | null }[]
}

export interface Breakdown {
  payerId: string
  /** Everyone with a share, sorted by personId; sums to totalCents */
  perPerson: PersonShare[]
  /** perPerson EXCLUDING the payer — what each owes the payer */
  owes: { personId: string; cents: number }[]
}

export function computeBreakdown(e: BreakdownExpense): Breakdown {
  let perPerson: PersonShare[]

  if (e.type === 'ITEMIZED') {
    const result = splitItemized({
      items: e.items.map(i => ({
        id: i.id,
        lineTotalCents: i.lineTotalCents,
        assigneeIds: i.assignments.map(a => a.personId),
        returned: i.returned,
      })),
      taxCents: e.taxCents,
      tipFeesCents: e.tipFeesCents,
      discountCents: e.discountCents,
      refundCents: e.refundCents,
    })
    perPerson = result.perPerson
  } else if (e.splitMethod === 'EVEN') {
    perPerson = splitSimpleEven(e.totalCents, e.participants.map(p => p.personId))
  } else {
    // SIMPLE + EXACT
    perPerson = splitSimpleExact(
      e.totalCents,
      e.participants.map(p => {
        if (typeof p.exactAmountCents !== 'number') {
          throw new Error('exact split requires an amount for every participant')
        }
        return { personId: p.personId, cents: p.exactAmountCents }
      }),
    )
  }

  // Deterministic order by personId
  perPerson = [...perPerson].sort((a, b) => a.personId.localeCompare(b.personId))

  const owes = perPerson.filter(p => p.personId !== e.payerId)

  return { payerId: e.payerId, perPerson, owes }
}
