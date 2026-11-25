// @vitest-environment happy-dom
// Local parity check: the TypeScript parser must match the Python parser's output on
// the real captures. Run with `npm run check:orders`; not part of `npm test`.
// The captures hold personal data, so failures name order keys and fields, never values.
import { readdirSync, readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { asCapture, importOrder, OrderImportError, parseOrderDetails, type OrderDetails } from '@/lib/order-import'

const HOME = process.env.HOME ?? ''
const DB_PATH = process.env.ORDERS_DB ?? `${HOME}/homelab/walmart-orders/data/orders.db`
const FAILED_DIR = process.env.ORDERS_FAILED_DIR ?? `${HOME}/homelab/walmart-orders/data/failed`
const HOMEPAGE_CAPTURES = (
  process.env.ORDERS_HOMEPAGE_CAPTURES ??
  `${HOME}/Downloads/walmart18items.json,${HOME}/Downloads/walmart-order-65004630428338645847-2026-09-26T17-52-48-296Z.json`
).split(',')

interface Row {
  key: string
  site: string
  parsed_json: string
  raw_capture: Uint8Array
}
interface Database {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}

async function loadRows(): Promise<Row[]> {
  const specifier = 'node:sqlite'
  const { DatabaseSync } = (await import(/* @vite-ignore */ specifier)) as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    return db.prepare('SELECT key, site, parsed_json, raw_capture FROM orders ORDER BY key').all() as Row[]
  } finally {
    db.close()
  }
}

function readCapture(path: string) {
  return asCapture(JSON.parse(readFileSync(path, 'utf8')))
}

/** Exact decimal string ("49.62", "-3", "0") to integer cents. */
function decimalToCents(value: unknown): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value))
  if (!m) throw new Error(`not a decimal amount: ${String(value)}`)
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] && cents ? -cents : cents
}

type Py = Record<string, unknown>

function centsMap(map: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(map as Py).map(([k, v]) => [k, decimalToCents(v)]))
}

function pyItem(it: Py) {
  return {
    name: it.name,
    itemId: it.item_id,
    ...('product_code' in it ? { productCode: it.product_code } : {}),
    url: it.url,
    image: it.image,
    categoryPath: it.category_path,
    status: it.status,
    quantity: it.quantity,
    salesUnit: it.sales_unit,
    unitPrice: it.unit_price,
    linePrice: decimalToCents(it.line_price),
    notes: it.notes,
  }
}

function pyToDetails(p: Py): OrderDetails {
  return {
    orderId: p.order_id,
    displayId: p.display_id,
    date: p.date,
    title: p.title,
    payment: p.payment,
    subtotal: decimalToCents(p.subtotal),
    subtotalLabel: p.subtotal_label,
    tax: decimalToCents(p.tax),
    driverTip: decimalToCents(p.driver_tip),
    fees: centsMap(p.fees),
    discounts: centsMap(p.discounts),
    refunds: centsMap(p.refunds),
    total: decimalToCents(p.total),
    groups: (p.groups as Py[]).map((g) => ({
      fulfillment: g.fulfillment,
      description: g.description,
      status: g.status,
      store: g.store,
      storeAddress: g.store_address,
      items: (g.items as Py[]).map(pyItem),
    })),
  } as OrderDetails
}

/** Paths of every differing field; values are never reported. */
function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (a === undefined) a = null
  if (b === undefined) b = null
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = a.length === b.length ? [] : [`${path}.length`]
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...diffPaths(a[i], b[i], `${path}[${i}]`))
    return out
  }
  if (typeof a === 'object' && typeof b === 'object' && a && b && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Py
    const bo = b as Py
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
    return [...keys].flatMap((k) => diffPaths(ao[k], bo[k], path ? `${path}.${k}` : k))
  }
  return Object.is(a, b) ? [] : [path || '(root)']
}

const rows = await loadRows()

describe('orders.db captures match the Python parser', () => {
  it('has orders to compare', () => {
    expect(rows.length).toBeGreaterThan(0)
  })

  it.each(rows.map((r) => [r.key, r] as const))('%s', (_key, row) => {
    const capture = asCapture(JSON.parse(inflateSync(row.raw_capture).toString('utf8')))
    const actual = parseOrderDetails(capture)
    const expected = pyToDetails(JSON.parse(row.parsed_json))
    expect(diffPaths(actual, expected), 'fields that differ').toEqual([])
    const order = importOrder(capture)
    expect(order.ref).toBe(row.key)
  })
})

describe('captures the Python parser accepts', () => {
  const files = readdirSync(FAILED_DIR).filter((f) => f.endsWith('.json'))
  it('exist', () => {
    expect(files.length).toBeGreaterThan(0)
  })
  it.each(files)('%s parses', (file) => {
    const capture = readCapture(`${FAILED_DIR}/${file}`)
    expect(() => parseOrderDetails(capture)).not.toThrow()
    expect(() => importOrder(capture)).not.toThrow()
  })
})

describe('homepage captures are rejected', () => {
  it.each(HOMEPAGE_CAPTURES.map((p) => [p.split('/').pop(), p] as const))('%s', (_name, path) => {
    const capture = readCapture(path)
    expect(() => importOrder(capture)).toThrow(OrderImportError)
    expect(() => importOrder(capture)).toThrow(/reload the order page/)
  })
})
