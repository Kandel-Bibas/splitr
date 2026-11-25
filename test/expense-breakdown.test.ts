import { describe, it, expect } from 'vitest'
import { computeBreakdown, BreakdownExpense } from '@/lib/expense-breakdown'

const sum = (xs: { cents: number }[]) => xs.reduce((a, b) => a + b.cents, 0)

describe('computeBreakdown', () => {
  it('(a) itemized 2 items / 2 people: perPerson sums to totalCents AND owes excludes payer', () => {
    // item1 (1000 ¢) → personA only; item2 (500 ¢) → personB only; tax 150 ¢
    // totalCents = 1000 + 500 + 150 = 1650
    const expense: BreakdownExpense = {
      type: 'ITEMIZED',
      splitMethod: 'ITEMIZED',
      payerId: 'personA',
      taxCents: 150, tipFeesCents: 0, discountCents: 0, refundCents: 0,
      totalCents: 1650,
      items: [
        { id: 'item1', lineTotalCents: 1000, returned: false, assignments: [{ personId: 'personA' }] },
        { id: 'item2', lineTotalCents: 500, returned: false, assignments: [{ personId: 'personB' }] },
      ],
      participants: [],
    }
    const bd = computeBreakdown(expense)
    expect(sum(bd.perPerson)).toBe(1650)
    expect(bd.payerId).toBe('personA')
    expect(bd.owes.every(o => o.personId !== 'personA')).toBe(true)
    expect(bd.owes.length).toBe(1)
    expect(bd.owes[0].personId).toBe('personB')
  })

  it('(b) simple EVEN among 3: equal-ish split, owes has 2 entries (excludes payer)', () => {
    const expense: BreakdownExpense = {
      type: 'SIMPLE',
      splitMethod: 'EVEN',
      payerId: 'personA',
      taxCents: 0, tipFeesCents: 0, discountCents: 0, refundCents: 0,
      totalCents: 10000,
      items: [],
      participants: [
        { personId: 'personA', exactAmountCents: null },
        { personId: 'personB', exactAmountCents: null },
        { personId: 'personC', exactAmountCents: null },
      ],
    }
    const bd = computeBreakdown(expense)
    expect(sum(bd.perPerson)).toBe(10000)
    expect(bd.perPerson.length).toBe(3)
    expect(bd.owes.length).toBe(2)
    expect(bd.owes.every(o => o.personId !== 'personA')).toBe(true)
    // Each person gets ~3333–3334
    for (const share of bd.perPerson) {
      expect(share.cents).toBeGreaterThanOrEqual(3333)
      expect(share.cents).toBeLessThanOrEqual(3334)
    }
  })

  it('(c) simple EXACT that sums correctly', () => {
    const expense: BreakdownExpense = {
      type: 'SIMPLE',
      splitMethod: 'EXACT',
      payerId: 'personA',
      taxCents: 0, tipFeesCents: 0, discountCents: 0, refundCents: 0,
      totalCents: 5000,
      items: [],
      participants: [
        { personId: 'personA', exactAmountCents: 2000 },
        { personId: 'personB', exactAmountCents: 3000 },
      ],
    }
    const bd = computeBreakdown(expense)
    expect(sum(bd.perPerson)).toBe(5000)
    expect(bd.owes.length).toBe(1)
    expect(bd.owes[0]).toEqual({ personId: 'personB', cents: 3000 })
  })

  it('SIMPLE EXACT throws when a participant is missing an amount', () => {
    expect(() => computeBreakdown({
      type: 'SIMPLE', splitMethod: 'EXACT', payerId: 'A', taxCents: 0, tipFeesCents: 0, discountCents: 0, refundCents: 0, totalCents: 5000,
      items: [],
      participants: [
        { personId: 'A', exactAmountCents: 5000 },
        { personId: 'B', exactAmountCents: null },
      ],
    })).toThrow()
  })

  it('(d) simple EXACT that does NOT sum to totalCents → throws', () => {
    const expense: BreakdownExpense = {
      type: 'SIMPLE',
      splitMethod: 'EXACT',
      payerId: 'personA',
      taxCents: 0, tipFeesCents: 0, discountCents: 0, refundCents: 0,
      totalCents: 5000,
      items: [],
      participants: [
        { personId: 'personA', exactAmountCents: 2000 },
        { personId: 'personB', exactAmountCents: 2000 }, // 4000 ≠ 5000
      ],
    }
    expect(() => computeBreakdown(expense)).toThrow()
  })
})
