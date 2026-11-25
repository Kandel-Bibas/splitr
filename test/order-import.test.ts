// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  asCapture,
  importOrder,
  moneyToCents,
  OrderImportError,
  parseOrderDetails,
  type OrderCapture,
} from '@/lib/order-import'

type Json = Record<string, unknown>

function capture(url: string, overrides: Partial<OrderCapture> = {}): OrderCapture {
  return { url, title: 'Order', capturedAt: '2026-01-01T00:00:00.000Z', html: '', jsonScripts: [], windowState: {}, networkUrls: [], ...overrides }
}

// --- walmart.com fixtures ---------------------------------------------------------

function wItem(over: Json = {}, price = '$6.73'): Json {
  return {
    quantity: 1,
    quantityLabel: 'Qty',
    quantityString: '1',
    requestedWeight: null,
    productInfo: { name: 'Thing', usItemId: '100', salesUnitType: 'EACH', canonicalUrl: '/ip/thing/100' },
    priceInfo: { unitPrice: null, linePrice: { displayValue: price }, additionalLines: null },
    ...over,
  }
}

const amount = (displayValue: string, label?: string) => ({ displayValue, ...(label ? { label } : {}) })

function walmartOrder(over: { order?: Json; details?: Json; groups?: Json[]; page?: string } = {}): OrderCapture {
  const order = {
    id: '200001',
    displayId: '2000-0001',
    orderDate: '2026-03-05T14:30:00-06:00',
    title: 'March delivery',
    itemCount: 1,
    paymentMethods: [{ cardType: 'VISA', description: 'ending in 0000' }],
    priceDetails: {
      subTotal: { label: 'Subtotal', displayValue: '$6.73' },
      taxTotal: amount('$0.40'),
      grandTotal: amount('$7.13'),
      ...over.details,
    },
    groups: over.groups ?? [{ fulfillmentType: 'DELIVERY', status: { statusType: 'DELIVERED' }, items: [wItem()] }],
    ...over.order,
  }
  const page = over.page ?? '/orders/[orderId]'
  const data = { page, props: { pageProps: { initialData: { data: { order } } } } }
  return capture('https://www.walmart.com/orders/200001', {
    jsonScripts: [{ id: '__NEXT_DATA__', type: 'application/json', parsed: data, rawLength: 0 }],
  })
}

describe('walmart orders', () => {
  it('imports a regular order', () => {
    const order = importOrder(walmartOrder())
    expect(order).toEqual({
      ref: 'walmart-200001',
      site: 'walmart',
      orderId: '200001',
      store: 'Walmart',
      date: '2026-03-05',
      items: [{ name: 'Thing', quantity: 1, lineTotalCents: 673, weight: null, returned: false }],
      subtotalCents: 673,
      taxCents: 40,
      tipFeesCents: 0,
      discountCents: 0,
      refundCents: 0,
      totalCents: 713,
    })
  })

  it('keeps every parsed field in the details', () => {
    const details = parseOrderDetails(walmartOrder())
    expect(details).toMatchObject({
      orderId: '200001',
      displayId: '2000-0001',
      date: '2026-03-05T14:30:00-06:00',
      title: 'March delivery',
      payment: ['VISA ending in 0000'],
      subtotal: 673,
      subtotalLabel: 'Subtotal',
      tax: 40,
      total: 713,
    })
    expect(details.groups[0]).toMatchObject({ fulfillment: 'DELIVERY', status: 'DELIVERED' })
    expect(details.groups[0].items[0]).toMatchObject({
      name: 'Thing',
      itemId: '100',
      url: 'https://www.walmart.com/ip/thing/100',
      salesUnit: 'EACH',
      linePrice: 673,
    })
  })

  it('parses money with thousands separators and negatives exactly', () => {
    expect(moneyToCents('$1,234.56')).toBe(123456)
    expect(moneyToCents('-$3.00')).toBe(-300)
    expect(moneyToCents('$12')).toBe(1200)
    expect(moneyToCents('$0.29')).toBe(29)
    expect(moneyToCents('$19,999,999.99')).toBe(1999999999)
    expect(() => moneyToCents('12.00')).toThrow(/expected a dollar amount, got '12.00'/)
    expect(() => moneyToCents(null)).toThrow(OrderImportError)
  })

  it('counts an in-store weighed item as one with its weight noted', () => {
    const weighed = wItem({ quantity: 0.93, quantityLabel: 'Wt', quantityString: '0.93 lb', requestedWeight: 0.93 })
    const order = importOrder(walmartOrder({ groups: [{ items: [weighed] }] }))
    expect(order.items).toEqual([{ name: 'Thing', quantity: 1, lineTotalCents: 673, weight: '0.93 lb', returned: false }])
  })

  it('counts an online weighed item with a blank label as one', () => {
    const weighed = wItem({ quantity: 5.3, quantityLabel: '', quantityString: '', requestedWeight: 5.3 })
    const details = parseOrderDetails(walmartOrder({ groups: [{ items: [weighed] }] }))
    const item = details.groups[0].items[0]
    expect([item.quantity, item.notes, item.linePrice]).toEqual([1, { Weight: '5.3 lb' }, 673])
  })

  it('keeps additional price lines as notes', () => {
    const item = wItem()
    ;(item.priceInfo as Json).additionalLines = [{ name: 'Ordered price', value: '$8.92' }]
    const details = parseOrderDetails(walmartOrder({ groups: [{ items: [item] }] }))
    expect(details.groups[0].items[0].notes).toEqual({ 'Ordered price': '$8.92' })
  })

  it('rejects a fractional quantity that is not a weight', () => {
    const odd = wItem({ quantity: 2.5, quantityLabel: '' })
    expect(() => importOrder(walmartOrder({ groups: [{ items: [odd] }] }))).toThrow(/non-whole quantity 2.5/)
  })

  it('leaves UNAVAILABLE items out of the charged lines', () => {
    const order = walmartOrder({
      order: { itemCount: 2 },
      groups: [
        {
          categories: [
            { type: 'PICKED', items: [wItem()] },
            { type: 'UNAVAILABLE', items: [wItem({ productInfo: { name: 'Gone', usItemId: '101' } }, '$9.99')] },
          ],
        },
      ],
    })
    const imported = importOrder(order)
    expect(imported.items.map((i) => i.name)).toEqual(['Thing'])
    expect(imported.subtotalCents).toBe(673)
    expect(parseOrderDetails(order).groups[0].items.map((i) => i.status)).toEqual(['PICKED', 'UNAVAILABLE'])
  })

  it('keeps a RETURNED item in the subtotal and the refund separate', () => {
    const order = walmartOrder({
      order: { itemCount: 2 },
      details: {
        subTotal: { label: 'Subtotal', displayValue: '$16.73' },
        taxTotal: amount('$1.00'),
        refund: [amount('-$10.00', 'Refund')],
        grandTotal: amount('$7.73'),
      },
      groups: [
        {
          categories: [
            { type: 'DELIVERED', items: [wItem()] },
            { type: 'RETURNED', items: [wItem({ productInfo: { name: 'Sent back', usItemId: '102' } }, '$10.00')] },
          ],
        },
      ],
    })
    const imported = importOrder(order)
    expect(imported.items.map((i) => [i.name, i.returned])).toEqual([
      ['Thing', false],
      ['Sent back', true],
    ])
    expect(imported.subtotalCents).toBe(1673)
    expect(imported.refundCents).toBe(-1000)
    expect(imported.totalCents).toBe(773)
  })

  it('adds tip and fees together and sums discounts', () => {
    const order = walmartOrder({
      details: {
        subTotal: { label: 'Subtotal', displayValue: '$6.73' },
        taxTotal: amount('$0.40'),
        driverTip: amount('$5.00'),
        fees: [amount('$3.95', 'Delivery fee'), amount('$1.00')],
        discounts: [amount('-$2.00', 'Promo'), amount('-$0.50', 'Coupon')],
        grandTotalWithTips: amount('$14.58'),
        grandTotal: amount('$9.58'),
      },
    })
    const imported = importOrder(order)
    expect(imported.tipFeesCents).toBe(500 + 395 + 100)
    expect(imported.discountCents).toBe(-250)
    expect(imported.totalCents).toBe(1458)
    expect(parseOrderDetails(order).fees).toEqual({ 'Delivery fee': 395, fee: 100 })
  })

  it('rejects a fee row without an amount', () => {
    const order = walmartOrder({ details: { fees: [{ label: 'Mystery' }] } })
    expect(() => importOrder(order)).toThrow(/unfamiliar fee entry/)
  })

  it('rejects an order whose units differ from itemCount', () => {
    expect(() => importOrder(walmartOrder({ order: { itemCount: 3 } }))).toThrow(
      'item quantities sum to 1 but the order says 3 items',
    )
  })

  it('rejects charged lines that do not add up to the subtotal', () => {
    const order = walmartOrder({ details: { subTotal: { label: 'Subtotal', displayValue: '$7.00' }, grandTotal: amount('$7.40') } })
    expect(() => importOrder(order)).toThrow(
      "charged line prices sum to 6.73 but subtotal is 7.00 (item statuses seen: ['None'])",
    )
  })

  it('rejects a total that does not reconcile', () => {
    const order = walmartOrder({ details: { grandTotal: amount('$7.14') } })
    expect(() => importOrder(order)).toThrow(
      'subtotal + tax + tip + fees + discounts + refunds = 7.13 but total is 7.14',
    )
  })

  it('rejects page data for the homepage with the reload message', () => {
    const order = walmartOrder({ page: '/' })
    expect(() => importOrder(order)).toThrow(OrderImportError)
    expect(() => importOrder(order)).toThrow(
      "page data is for '/', not an order; reload the order page, then send it to Splitr again",
    )
  })

  it('rejects a capture without __NEXT_DATA__', () => {
    expect(() => importOrder(capture('https://www.walmart.com/orders/1'))).toThrow('no __NEXT_DATA__ in capture')
  })

  it('names a missing field instead of throwing a TypeError', () => {
    const broken = wItem()
    delete broken.priceInfo
    const run = () => importOrder(walmartOrder({ groups: [{ items: [broken] }] }))
    expect(run).toThrow(OrderImportError)
    expect(run).toThrow("missing field 'priceInfo'")
  })

  it('rejects an order without an id', () => {
    expect(() => importOrder(walmartOrder({ order: { id: null } }))).toThrow(OrderImportError)
    const noId = walmartOrder({ order: { id: undefined } })
    const order = (noId.jsonScripts[0].parsed as { props: { pageProps: { initialData: { data: { order: Json } } } } }).props
      .pageProps.initialData.data.order
    delete order.id
    expect(() => importOrder(noId)).toThrow("missing field 'id'")
  })

  it('rejects hosts it has no parser for', () => {
    expect(() => importOrder(capture('https://www.target.com/orders/1'))).toThrow('No parser for www.target.com')
  })
})

// --- samsclub.com fixtures --------------------------------------------------------

function samsTile(opts: { name: string; qty: string; dollars: string; cents: string; unit?: string; code?: string }): string {
  return (
    `<div data-testid="itemtile-stack">` +
    `<img data-testid="productTileImage" src="https://img.example/samsclub/${opts.code ?? '0012345'}_A.jpg">` +
    `<span data-testid="productName">${opts.name}</span>` +
    (opts.unit ? `<span data-testid="productDescription">${opts.unit}</span>` : '') +
    `<span class="x bill-item-quantity">${opts.qty}</span>` +
    `<span data-testid="line-price"><span>$</span><span>${opts.dollars}</span><span>${opts.cents}</span></span>` +
    `</div>`
  )
}

const SAMS_TILES = [
  samsTile({ name: 'Paper   Towels', qty: 'Qty 2', dollars: '12', cents: '50', unit: '$6.25/ea', code: '0099887' }),
  samsTile({ name: 'Bananas', qty: 'lb 2.13 lb', dollars: '1', cents: '28' }),
].join('')

function samsSummary(rows: [string, string][]): string {
  return rows.map(([label, value]) => `<div>${label}</div><div>${value}</div>`).join('')
}

function samsOrder(over: { rows?: [string, string][]; tiles?: string; count?: string; url?: string } = {}): OrderCapture {
  const rows: [string, string][] = over.rows ?? [
    ['Subtotal', '$13.78'],
    ['Sales tax', '$0.97'],
    ['Savings', '-$2.00'],
    ['Total', '$12.75'],
  ]
  const html =
    `<html><head><title>Orders</title></head><body>` +
    `<script>var junk = "$99.99";</script><style>.a{}</style>` +
    `<p>Mar 5, 2026</p><p>TC 1234 5678</p><p id="caption-1">Scan &amp; Go</p>` +
    `<p>Store location</p><p>Store 6279</p><p>1 Main St</p>` +
    (over.tiles ?? SAMS_TILES) +
    `<p>${over.count ?? '3 items'}</p>` +
    `<svg><text>$1.00</text></svg>` +
    `<div>Sales tax $0.97</div>` +
    samsSummary(rows) +
    `<p>Payment method</p><p>Visa 0000</p>` +
    `</body></html>`
  return capture(over.url ?? 'https://www.samsclub.com/orders/300001?storePurchase=true', { html })
}

describe("sam's club orders", () => {
  it('imports an order with counted and weighed tiles, tax and savings', () => {
    expect(importOrder(samsOrder())).toEqual({
      ref: 'samsclub-300001',
      site: 'samsclub',
      orderId: '300001',
      store: "Sam's Club",
      date: '2026-03-05',
      items: [
        { name: 'Paper Towels', quantity: 2, lineTotalCents: 1250, weight: null, returned: false },
        { name: 'Bananas', quantity: 1, lineTotalCents: 128, weight: '2.13 lb', returned: false },
      ],
      subtotalCents: 1378,
      taxCents: 97,
      tipFeesCents: 0,
      discountCents: -200,
      refundCents: 0,
      totalCents: 1275,
    })
  })

  it('reads the page details, skipping script, style and svg text', () => {
    const details = parseOrderDetails(samsOrder())
    expect(details).toMatchObject({
      orderId: '300001',
      displayId: '1234 5678',
      date: '2026-03-05',
      title: 'Mar 5, 2026 purchase',
      payment: ['Visa 0000'],
      subtotalLabel: 'Subtotal',
      discounts: { Savings: -200 },
    })
    expect(details.groups[0]).toMatchObject({
      fulfillment: 'IN_STORE',
      description: 'Scan & Go',
      store: 'Store 6279',
      storeAddress: '1 Main St',
    })
    expect(details.groups[0].items[0]).toMatchObject({
      productCode: '0099887',
      unitPrice: '$6.25/ea',
      salesUnit: 'EACH',
      image: 'https://img.example/samsclub/0099887_A.jpg',
    })
    expect(details.groups[0].items[1]).toMatchObject({ salesUnit: 'WEIGHT', unitPrice: null, notes: { Weight: '2.13 lb' } })
  })

  it('has no fulfillment when the page is not a store purchase', () => {
    const details = parseOrderDetails(samsOrder({ url: 'https://www.samsclub.com/orders/300001' }))
    expect(details.groups[0].fulfillment).toBeNull()
  })

  it('works without tax or savings rows', () => {
    const order = samsOrder({ rows: [['Subtotal', '$13.78'], ['Total', '$13.78']] })
    expect(importOrder(order)).toMatchObject({ taxCents: 0, discountCents: 0, totalCents: 1378 })
  })

  it('rejects an unfamiliar summary row', () => {
    const order = samsOrder({ rows: [['Subtotal', '$13.78'], ['Bag fee', '$0.10'], ['Total', '$13.88']] })
    expect(() => importOrder(order)).toThrow('unfamiliar summary rows: Bag fee = 0.10')
  })

  it('rejects positive savings', () => {
    const order = samsOrder({ rows: [['Subtotal', '$13.78'], ['Savings', '$2.00'], ['Total', '$15.78']] })
    expect(() => importOrder(order)).toThrow('expected Savings to be negative, got 2.00')
  })

  it('rejects unrecognised quantity text', () => {
    const order = samsOrder({ tiles: samsTile({ name: 'Odd', qty: '2 pk', dollars: '1', cents: '00' }), count: '1 item' })
    expect(() => importOrder(order)).toThrow("unrecognised quantity text '2 pk' for 'Odd'")
  })

  it('rejects a page without item tiles', () => {
    expect(() => importOrder(samsOrder({ tiles: '' }))).toThrow(/no itemtile-stack elements/)
  })

  it('rejects an item count that disagrees with the tiles', () => {
    expect(() => importOrder(samsOrder({ count: '5 items' }))).toThrow('item quantities sum to 3 but the order says 5 items')
  })

  it('rejects line prices that do not add up to the subtotal', () => {
    const order = samsOrder({ rows: [['Subtotal', '$14.00'], ['Total', '$14.00']] })
    expect(() => importOrder(order)).toThrow('charged line prices sum to 13.78 but subtotal is 14.00')
  })

  it('rejects a total that does not reconcile', () => {
    const order = samsOrder({ rows: [['Subtotal', '$13.78'], ['Total', '$20.00']] })
    expect(() => importOrder(order)).toThrow('but total is 20.00')
  })
})

// --- asCapture --------------------------------------------------------------------

describe('asCapture', () => {
  const valid = (): Json => ({ ...capture('https://www.walmart.com/orders/1') })

  it('passes a well-formed capture through', () => {
    const value = valid()
    expect(asCapture(value)).toEqual(value)
  })

  it.each([
    ['null', null, 'capture must be an object'],
    ['missing url', { ...valid(), url: undefined }, 'capture.url must be a string'],
    ['non-string html', { ...valid(), html: 5 }, 'capture.html must be a string'],
    ['jsonScripts not a list', { ...valid(), jsonScripts: {} }, 'capture.jsonScripts must be a list'],
    ['bad script entry', { ...valid(), jsonScripts: [{ id: 3, type: null, parsed: null, rawLength: 0 }] }, 'capture.jsonScripts[0].id must be a string or null'],
    ['windowState missing', { ...valid(), windowState: null }, 'capture.windowState must be an object'],
    ['networkUrls not strings', { ...valid(), networkUrls: [1] }, 'capture.networkUrls must be a list of strings'],
  ])('rejects %s', (_name, value, message) => {
    expect(() => asCapture(value)).toThrow(OrderImportError)
    expect(() => asCapture(value)).toThrow(message)
  })
})
