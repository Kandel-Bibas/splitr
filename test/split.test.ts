import { describe, it, expect } from 'vitest'
import { splitItemized, splitSimpleEven, splitSimpleExact } from '@/lib/split'
import { WALMART, SAMS } from './fixtures/receipts'

const sum = (xs: { cents: number }[]) => xs.reduce((a, b) => a + b.cents, 0)
const itemsFor = (fx: typeof WALMART, assign: (id: string) => string[]) =>
  fx.items.map(([id, c]) => ({ id, lineTotalCents: c, assigneeIds: assign(id) }))

describe('splitItemized — invariants', () => {
  it('everything shared by two people sums exactly to total (Sam\'s)', () => {
    const r = splitItemized({ items: itemsFor(SAMS, () => ['A', 'B']), taxCents: SAMS.taxCents })
    expect(sum(r.perPerson)).toBe(SAMS.totalCents)
    expect(r.perItem.reduce((a, b) => a + b.effectiveCents, 0)).toBe(SAMS.totalCents)
    // global LCM reconciliation: 8079 is odd, the single leftover cent goes to A (sorted first)
    const byId = Object.fromEntries(r.perPerson.map(p => [p.personId, p.cents]))
    expect([byId.A, byId.B].sort((a,b)=>b-a)).toEqual([4040, 4039])
  })
  it('mixed assignment still re-sums to total (Walmart)', () => {
    // chicken-like split: a couple of items to one person, rest shared
    const r = splitItemized({
      items: itemsFor(WALMART, id => id === 'apple' ? ['A'] : id === 'mango' ? ['B'] : ['A','B']),
      taxCents: WALMART.taxCents,
    })
    expect(sum(r.perPerson)).toBe(WALMART.totalCents)
    expect(r.perPerson.every(p => p.cents >= 0)).toBe(true)
  })
  it('3-way heterogeneous assignment reconciles (D=6 path)', () => {
    const r = splitItemized({
      items: [
        { id: 'x', lineTotalCents: 100, assigneeIds: ['A','B'] },
        { id: 'y', lineTotalCents: 100, assigneeIds: ['A','B','C'] },
      ],
      taxCents: 0,
    })
    expect(sum(r.perPerson)).toBe(200)
    expect(r.perPerson).toEqual([
      { personId: 'A', cents: 84 },
      { personId: 'B', cents: 83 },
      { personId: 'C', cents: 33 },
    ])
  })
  it('single assignee on every item -> that person owes the whole total', () => {
    const r = splitItemized({ items: itemsFor(SAMS, () => ['solo']), taxCents: SAMS.taxCents })
    expect(r.perPerson).toEqual([{ personId: 'solo', cents: SAMS.totalCents }])
  })
  it('is deterministic', () => {
    const mk = () => splitItemized({ items: itemsFor(WALMART, () => ['A','B','C']), taxCents: WALMART.taxCents })
    expect(mk()).toEqual(mk())
  })
  it('zero tax reconciles', () => {
    const r = splitItemized({ items: itemsFor(WALMART, () => ['A','B']), taxCents: 0 })
    expect(sum(r.perPerson)).toBe(WALMART.subtotalCents)
  })
  it('throws when an item has no assignees', () => {
    expect(() => splitItemized({ items: [{ id: 'x', lineTotalCents: 100, assigneeIds: [] }], taxCents: 0 }))
      .toThrow()
  })
  it('exact even halves when total is even (Walmart $58.02 shared by two)', () => {
    const r = splitItemized({ items: itemsFor(WALMART, () => ['A', 'B']), taxCents: WALMART.taxCents })
    expect(r.perPerson).toEqual([{ personId: 'A', cents: 2901 }, { personId: 'B', cents: 2901 }])
    expect(r.perItem.reduce((a, b) => a + b.effectiveCents, 0)).toBe(WALMART.totalCents)
  })
})

describe('splitItemized — tip, fees, discounts, refunds', () => {
  const byId = (r: { perPerson: { personId: string; cents: number }[] }) =>
    Object.fromEntries(r.perPerson.map(p => [p.personId, p.cents]))

  it('tip and fees are split equally among people with items', () => {
    const r = splitItemized({
      items: [
        { id: 'a', lineTotalCents: 3000, assigneeIds: ['A'] },
        { id: 'b', lineTotalCents: 1000, assigneeIds: ['B'] },
      ],
      taxCents: 0,
      tipFeesCents: 400,
    })
    expect(byId(r)).toEqual({ A: 3200, B: 1200 })
    expect(r.totalCents).toBe(4400)
  })
  it('a person with only $0 items gets no tip', () => {
    const r = splitItemized({
      items: [
        { id: 'a', lineTotalCents: 1000, assigneeIds: ['A'] },
        { id: 'bag', lineTotalCents: 0, assigneeIds: ['B'] },
      ],
      taxCents: 0,
      tipFeesCents: 300,
    })
    expect(byId(r)).toEqual({ A: 1300, B: 0 })
  })
  it('discounts follow each person\'s share of the items', () => {
    const r = splitItemized({
      items: [
        { id: 'a', lineTotalCents: 3000, assigneeIds: ['A'] },
        { id: 'b', lineTotalCents: 1000, assigneeIds: ['B'] },
      ],
      taxCents: 400,
      discountCents: -200,
    })
    expect(byId(r)).toEqual({ A: 3150, B: 1050 })
  })
  it('a refund goes to whoever shared the returned item', () => {
    const r = splitItemized({
      items: [
        { id: 'eggs', lineTotalCents: 800, assigneeIds: ['A'], returned: true },
        { id: 'milk', lineTotalCents: 200, assigneeIds: ['B'] },
      ],
      taxCents: 100,
      refundCents: -880,
    })
    expect(byId(r)).toEqual({ A: 0, B: 220 })
  })
  it('a refund is shared by the returned item\'s sharers, in proportion', () => {
    const r = splitItemized({
      items: [
        { id: 'tv', lineTotalCents: 900, assigneeIds: ['A', 'B', 'C'], returned: true },
        { id: 'cable', lineTotalCents: 300, assigneeIds: ['C'], returned: true },
      ],
      taxCents: 0,
      refundCents: -1200,
    })
    expect(byId(r)).toEqual({ A: 0, B: 0, C: 0 })
  })
  it('throws on a refund with no returned items', () => {
    expect(() => splitItemized({
      items: [{ id: 'a', lineTotalCents: 500, assigneeIds: ['A'] }],
      taxCents: 0,
      refundCents: -100,
    })).toThrow(/refund of \$1\.00 but no returned items/)
  })
  it('throws on charges with the wrong sign or fractional cents', () => {
    const items = [{ id: 'a', lineTotalCents: 500, assigneeIds: ['A'] }]
    expect(() => splitItemized({ items, taxCents: 0, tipFeesCents: -1 })).toThrow(/tip and fees/)
    expect(() => splitItemized({ items, taxCents: 0, discountCents: 1 })).toThrow(/discounts/)
    expect(() => splitItemized({ items, taxCents: 0, refundCents: 1 })).toThrow(/refunds/)
    expect(() => splitItemized({ items, taxCents: 0, tipFeesCents: 0.5 })).toThrow(/whole cents/)
  })
  it('no extra charges gives the same split as before (Walmart, mixed assignment)', () => {
    const items = itemsFor(WALMART, id => id === 'apple' ? ['A'] : id === 'mango' ? ['B'] : ['A', 'B', 'C'])
    const plain = splitItemized({ items, taxCents: WALMART.taxCents })
    const zeros = splitItemized({ items, taxCents: WALMART.taxCents, tipFeesCents: 0, discountCents: 0, refundCents: 0 })
    expect(zeros).toEqual(plain)
  })
  it('always sums exactly to the order total (seeded random orders)', () => {
    let seed = 7
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    const people = ['A', 'B', 'C', 'D', 'E']
    for (let run = 0; run < 500; run++) {
      const count = 1 + rand(15)
      const items = Array.from({ length: count }, (_, i) => {
        const sharers = people.filter(() => rand(2) === 0)
        return {
          id: String(i),
          lineTotalCents: 1 + rand(5000),
          assigneeIds: sharers.length ? sharers : ['A'],
          returned: rand(10) === 0,
        }
      })
      const refundCents = -items.filter(i => i.returned).reduce((a, i) => a + i.lineTotalCents, 0)
      const r = splitItemized({
        items,
        taxCents: rand(900),
        tipFeesCents: rand(800),
        discountCents: -rand(200),
        refundCents,
      })
      expect(sum(r.perPerson)).toBe(r.totalCents)
    }
  })
})

describe('splitSimple', () => {
  it('even split reconciles to total', () => {
    const r = splitSimpleEven(10000, ['A','B','C'])
    expect(sum(r)).toBe(10000)
    expect(r.map(p=>p.cents).sort((a,b)=>b-a)).toEqual([3334, 3333, 3333])
  })
  it('exact split passes when sums match, throws otherwise', () => {
    expect(splitSimpleExact(5000, [{personId:'A',cents:2000},{personId:'B',cents:3000}]))
      .toEqual([{personId:'A',cents:2000},{personId:'B',cents:3000}])
    expect(() => splitSimpleExact(5000, [{personId:'A',cents:2000},{personId:'B',cents:2000}]))
      .toThrow()
  })
})
