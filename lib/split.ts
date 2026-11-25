import { apportion, Cents, formatUSD } from '@/lib/money'

export interface PersonShare { personId: string; cents: Cents }
export interface SplitItem {
  id: string
  lineTotalCents: Cents
  assigneeIds: string[]
  /** Returned after purchase: still charged here, its money back is in refundCents */
  returned?: boolean
}
export interface ItemizedInput {
  items: SplitItem[]
  taxCents: Cents
  /** Driver tip plus fees (>= 0): split equally among everyone with an item */
  tipFeesCents?: Cents
  /** Order-level discounts (<= 0): follow each person's share of the items, like tax */
  discountCents?: Cents
  /** Money back (<= 0): to the people who shared returned items, by their share of them */
  refundCents?: Cents
}
export interface ItemizedResult {
  perPerson: PersonShare[]
  perItem: { itemId: string; effectiveCents: Cents }[]
  totalCents: Cents
}

function gcd(a: number, b: number): number { while (b) { [a, b] = [b, a % b] } return a }
function lcm(a: number, b: number): number { return (a / gcd(a, b)) * b }

/** Floor division for BigInt, which itself truncates toward zero. */
function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d
  return n % d !== 0n && (n < 0n) !== (d < 0n) ? q - 1n : q
}

function checkCents(name: string, value: Cents, sign: 'non-negative' | 'non-positive') {
  if (!Number.isInteger(value)) throw new Error(`${name} must be whole cents`)
  if (sign === 'non-negative' ? value < 0 : value > 0) throw new Error(`${name} must be ${sign}`)
}

export function splitItemized(input: ItemizedInput): ItemizedResult {
  const { items, taxCents, tipFeesCents = 0, discountCents = 0, refundCents = 0 } = input
  if (items.length === 0) throw new Error('splitItemized: no items')
  for (const it of items) {
    if (it.assigneeIds.length === 0) throw new Error(`splitItemized: item ${it.id} has no assignees`)
  }
  checkCents('tip and fees', tipFeesCents, 'non-negative')
  checkCents('discounts', discountCents, 'non-positive')
  checkCents('refunds', refundCents, 'non-positive')

  // 1. Prorate tax across items by line-total share; each item's effective (tax-inclusive) cost.
  const taxParts = apportion(taxCents, items.map(i => i.lineTotalCents))
  const perItem = items.map((it, idx) => ({ itemId: it.id, effectiveCents: it.lineTotalCents + taxParts[idx] }))
  const totalCents = perItem.reduce((a, b) => a + b.effectiveCents, 0) + tipFeesCents + discountCents + refundCents

  // 2. Each person's EXACT fractional share, kept integer by scaling with
  //    D = lcm of assignee counts: per person, the sum over their items of
  //    (cost * D / sharers), for tax-inclusive cost, bare price, and returned price.
  const D = items.reduce((acc, it) => lcm(acc, it.assigneeIds.length), 1)
  const scaled = new Map<string, { withTax: number; price: number; returned: number }>()
  items.forEach((it, idx) => {
    const k = D / it.assigneeIds.length // integer
    for (const pid of it.assigneeIds) {
      const s = scaled.get(pid) ?? { withTax: 0, price: 0, returned: 0 }
      s.withTax += perItem[idx].effectiveCents * k
      s.price += it.lineTotalCents * k
      if (it.returned) s.returned += it.lineTotalCents * k
      scaled.set(pid, s)
    }
  })
  const persons = [...scaled.keys()].sort()
  const subtotal = items.reduce((a, it) => a + it.lineTotalCents, 0)
  const returnedTotal = items.reduce((a, it) => a + (it.returned ? it.lineTotalCents : 0), 0)
  // Tip and fees go to people with something on the order, not just a $0 line
  const tipped = persons.filter(p => scaled.get(p)!.price > 0)

  if (discountCents !== 0 && subtotal <= 0) throw new Error('A discount needs items with a price to apply to.')
  if (tipFeesCents !== 0 && tipped.length === 0) throw new Error('Tip and fees need items with a price to split over.')
  if (refundCents !== 0 && returnedTotal <= 0) {
    throw new Error(`This order has a refund of ${formatUSD(-refundCents)} but no returned items, so there's no rule for who gets it.`)
  }

  // 3. The extra charges as exact fractions too, over one common denominator:
  //      discount * price_p / (D * subtotal)       tip / tipped    refund * returned_p / (D * returnedTotal)
  //    Factors for charges that are zero are left out, so with only items and
  //    tax this is the plain numerator over D, as before.
  const S = BigInt(discountCents !== 0 ? subtotal : 1)
  const R = BigInt(refundCents !== 0 ? returnedTotal : 1)
  const P = BigInt(tipFeesCents !== 0 ? tipped.length : 1)
  const bigD = BigInt(D)
  const den = bigD * S * R * P
  const numerator = (p: string) => {
    const s = scaled.get(p)!
    let n = BigInt(s.withTax) * S * R * P
    if (discountCents !== 0) n += BigInt(discountCents) * BigInt(s.price) * R * P
    if (tipFeesCents !== 0 && s.price > 0) n += BigInt(tipFeesCents) * bigD * S * R
    if (refundCents !== 0) n += BigInt(refundCents) * BigInt(s.returned) * S * P
    return n
  }

  // 4. One largest-remainder reconciliation at the PERSON level => fairest split that
  //    sums exactly to totalCents; deterministic tie-break by sorted personId.
  const nums = persons.map(numerator)
  const floors = nums.map(n => floorDiv(n, den))
  const leftover = totalCents - Number(floors.reduce((a, b) => a + b, 0n))
  const order = persons
    .map((_, i) => ({ i, rem: nums[i] - floors[i] * den }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1))
  const cents = floors.map(Number)
  for (let k = 0; k < leftover; k++) cents[order[k].i] += 1
  const perPerson = persons.map((personId, i) => ({ personId, cents: cents[i] }))
  return { perPerson, perItem, totalCents }
}

export function splitSimpleEven(totalCents: Cents, participantIds: string[]): PersonShare[] {
  if (participantIds.length === 0) throw new Error('splitSimpleEven: no participants')
  const parts = apportion(totalCents, participantIds.map(() => 1))
  return participantIds.map((personId, i) => ({ personId, cents: parts[i] }))
}

export function splitSimpleExact(totalCents: Cents, shares: PersonShare[]): PersonShare[] {
  const s = shares.reduce((a, b) => a + b.cents, 0)
  if (s !== totalCents) throw new Error('exact split must sum to total')
  return shares
}
