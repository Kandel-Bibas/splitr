import { describe, expect, it } from 'vitest'
import { chargeShares } from '../lib/transactions'

describe('chargeShares', () => {
  it('gives a lone charge everything that comes back', () => {
    expect(chargeShares(3000, [{ id: 7, amount: 10000 }])).toEqual(new Map([[7, 3000]]))
  })

  it('divides by the charges’ amounts', () => {
    // $30 back on a $100 order paid as $60 + $40
    expect(chargeShares(3000, [{ id: 1, amount: 6000 }, { id: 2, amount: 4000 }])).toEqual(
      new Map([[1, 1800], [2, 1200]]),
    )
  })

  it('adds up to the cent, whatever the order the charges come in', () => {
    const charges = [{ id: 9, amount: 3333 }, { id: 3, amount: 3333 }, { id: 5, amount: 3334 }]
    const shares = chargeShares(1001, charges)
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(1001)
    expect(chargeShares(1001, [...charges].reverse())).toEqual(shares)
  })

  it('gives a refund charge none of it', () => {
    expect(chargeShares(500, [{ id: 1, amount: 2000 }, { id: 2, amount: -880 }])).toEqual(
      new Map([[1, 500], [2, 0]]),
    )
  })

  it('has nothing to divide with no charges', () => {
    expect(chargeShares(500, [])).toEqual(new Map())
  })
})
