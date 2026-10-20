import type { Cents } from '@/lib/money'

// Reads a walmart.com or samsclub.com order-details capture (made by the
// Splitr extension) into a receipt. Runs in the browser: Sam's pages are read
// from their HTML with DOMParser. Throws OrderImportError when the capture
// is missing data, has an unfamiliar shape, or its numbers don't add up.
// All money is integer cents, parsed from display strings without floats.

export class OrderImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderImportError'
  }
}

/** What the extension captures on an order page. */
export interface OrderCapture {
  url: string
  title: string
  capturedAt: string
  html: string
  jsonScripts: { id: string | null; type: string | null; parsed: unknown; rawLength: number }[]
  windowState: Record<string, unknown>
  networkUrls: string[]
}

export type OrderSite = 'walmart' | 'samsclub'

/** One charged line on the order. Lines that were never charged (UNAVAILABLE) are left out. */
export interface ImportedItem {
  name: string
  /** Whole units; a weighed item counts as 1 */
  quantity: number
  lineTotalCents: Cents
  /** e.g. "2.13 lb" on weighed goods */
  weight: string | null
  /** Still in the subtotal at full price; the money back is in refundCents */
  returned: boolean
}

/** An order as a receipt. subtotal + tax + tipFees + discount + refund = total. */
export interface ImportedOrder {
  /** "walmart-<orderId>" or "samsclub-<orderId>"; one split per order */
  ref: string
  site: OrderSite
  orderId: string
  /** "Walmart" or "Sam's Club" */
  store: string
  /** YYYY-MM-DD */
  date: string | null
  items: ImportedItem[]
  subtotalCents: Cents
  taxCents: Cents
  /** Driver tip plus fees; >= 0 */
  tipFeesCents: Cents
  /** Order-level discounts and savings; <= 0 */
  discountCents: Cents
  /** Money back for returned items; <= 0 */
  refundCents: Cents
  totalCents: Cents
}

/** Everything read from the page, before it is reduced to a receipt. */
export interface OrderItemDetails {
  name: string
  itemId: string | null
  /** Sam's only: image asset code */
  productCode?: string | null
  url: string | null
  image: string | null
  categoryPath: string | null
  status: string | null
  quantity: number
  salesUnit: string | null
  unitPrice: string | null
  linePrice: Cents
  notes: Record<string, string>
}

export interface OrderGroupDetails {
  fulfillment: string | null
  description: string | null
  status: string | null
  store: string | null
  storeAddress: string | null
  items: OrderItemDetails[]
}

export interface OrderDetails {
  orderId: string | null
  displayId: string | null
  /** ISO date; Walmart includes the time and offset */
  date: string | null
  title: string | null
  payment: string[]
  subtotal: Cents
  subtotalLabel: string
  tax: Cents
  driverTip: Cents
  fees: Record<string, Cents>
  discounts: Record<string, Cents>
  refunds: Record<string, Cents>
  total: Cents
  groups: OrderGroupDetails[]
}

type Json = Record<string, unknown>
type Totals = Omit<OrderDetails, 'orderId' | 'displayId' | 'date' | 'title' | 'payment' | 'groups'>

const MONEY = /^(-?)\$([\d,]+(?:\.\d{2})?)(?![\d.])/
const MONEY_WHOLE = /^(-?)\$([\d,]+(?:\.\d{2})?)$/
// Categories whose items appear on the order but were never charged.
const UNCHARGED = new Set(['UNAVAILABLE'])
const SITES: Record<string, OrderSite> = { 'www.walmart.com': 'walmart', 'www.samsclub.com': 'samsclub' }
const STORE_NAMES: Record<OrderSite, string> = { walmart: 'Walmart', samsclub: "Sam's Club" }

const DATE_LINE = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/
const SAMS_IMAGE_CODE = /\/samsclub\/(\d+)_/
const SAMS_TAX_LABEL = 'Sales tax'
// Order-level savings; the page does not say which item they applied to.
const SAMS_SAVINGS_LABEL = 'Savings'
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// Same set Python's str.split() treats as whitespace.
const SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const SPACES = new RegExp(`[${SPACE}]+`)

// --- shared helpers -------------------------------------------------------------

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Python truthiness: null, false, 0, '', [] and {} are all falsy. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (isObject(v)) return Object.keys(v).length > 0
  return true
}

/** Python repr() for the values that show up in error messages. */
function repr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'"
    return q + v.replaceAll('\\', '\\\\').replaceAll(q, '\\' + q) + q
  }
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return String(v)
  return JSON.stringify(v) ?? 'None'
}

function str(v: unknown): string {
  return v === null || v === undefined ? 'None' : String(v)
}

function fail(message: string): never {
  throw new OrderImportError(message)
}

function toObject(v: unknown, where: string): Json {
  if (!isObject(v)) fail(`expected an object at ${where}, got ${repr(v)}`)
  return v
}

/** Required field: a missing key is an error, a null value is returned as is. */
function field(o: unknown, key: string): unknown {
  if (!isObject(o) || !Object.hasOwn(o, key)) fail(`missing field ${repr(key)}`)
  return o[key]
}

/** Optional field: missing reads as null, like Python's dict.get. */
function opt(o: unknown, key: string): unknown {
  if (o === null || o === undefined) return null
  if (!isObject(o)) fail(`expected an object holding ${repr(key)}, got ${repr(o)}`)
  return o[key] ?? null
}

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string') fail(`expected ${what} to be a string, got ${repr(v)}`)
  return v
}

function asStringOrNull(v: unknown, what: string): string | null {
  return v === null || v === undefined ? null : asString(v, what)
}

function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) fail(`expected ${what} to be a list, got ${repr(v)}`)
  return v
}

function sum(values: Iterable<number>): number {
  let total = 0
  for (const v of values) total += v
  return total
}

function record<V>(entries: Iterable<[string, V]>): Record<string, V> {
  return Object.fromEntries(entries)
}

export function formatCents(cents: Cents): string {
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** "$1,234.56" or "-$3.00" to integer cents, without floating point. */
export function moneyToCents(display: unknown): Cents {
  const m = MONEY.exec(typeof display === 'string' ? display.trim() : '')
  return centsFromMatch(m, display)
}

function centsFromMatch(m: RegExpExecArray | null, display: unknown): Cents {
  const digits = m ? m[2].replaceAll(',', '') : ''
  if (!m || !/^\d/.test(digits)) fail(`expected a dollar amount, got ${repr(display)}`)
  const [whole, frac = '00'] = digits.split('.')
  const cents = Number(whole) * 100 + Number(frac)
  if (!Number.isSafeInteger(cents)) fail(`dollar amount out of range: ${repr(display)}`)
  return m[1] === '-' && cents !== 0 ? -cents : cents
}

function wholeMoney(token: string): Cents | null {
  const m = MONEY_WHOLE.exec(token)
  return m ? centsFromMatch(m, token) : null
}

// --- site routing ---------------------------------------------------------------

function parseUrl(url: string): URL {
  try {
    return new URL(url)
  } catch {
    return fail(`capture url is not a valid URL: ${repr(url)}`)
  }
}

function siteOf(capture: OrderCapture): OrderSite {
  const host = parseUrl(capture.url).hostname
  const site = Object.hasOwn(SITES, host) ? SITES[host] : undefined
  if (!site) fail(`No parser for ${host}`)
  return site
}

// --- walmart.com: order JSON from __NEXT_DATA__ ---------------------------------

function nextData(capture: OrderCapture): Json {
  for (const script of capture.jsonScripts) {
    if (script.id === '__NEXT_DATA__' && truthy(script.parsed)) return toObject(script.parsed, '__NEXT_DATA__')
  }
  return fail('no __NEXT_DATA__ in capture')
}

function orderJson(capture: OrderCapture): Json {
  const data = nextData(capture)
  if (data.page !== '/orders/[orderId]') {
    fail(`page data is for ${repr(data.page)}, not an order; reload the order page, then send it to Splitr again`)
  }
  let node: unknown = data
  for (const key of ['props', 'pageProps', 'initialData', 'data', 'order']) {
    node = isObject(node) ? node[key] : undefined
  }
  if (!isObject(node)) fail('__NEXT_DATA__ has no props.pageProps.initialData.data.order')
  return node
}

function parseItem(item: unknown, status: string | null): OrderItemDetails {
  const product = field(item, 'productInfo')
  const price = field(item, 'priceInfo')
  const unit = opt(price, 'unitPrice')
  // e.g. {"Ordered price": "$8.92"} or {"Final weight": "1.0 lbs"} on weighed items
  const lines = truthy(opt(price, 'additionalLines')) ? asArray(opt(price, 'additionalLines'), 'additionalLines') : []
  const notes = record(
    lines.map((line): [string, string] => [
      asString(field(line, 'name'), 'additionalLines name'),
      asString(field(line, 'value'), 'additionalLines value'),
    ]),
  )
  let quantity = field(item, 'quantity')
  if (opt(item, 'quantityLabel') === 'Wt' || opt(item, 'requestedWeight') !== null) {
    // Weighed goods: quantity holds the weight (0.93) and counts as one item. In-store
    // produce is labelled "Wt"; online orders leave the label blank but set requestedWeight.
    const text = opt(item, 'quantityString')
    notes.Weight = truthy(text) ? String(text) : `${str(quantity)} lb`
    quantity = 1
  } else if (typeof quantity !== 'number' || !Number.isInteger(quantity)) {
    fail(
      `non-whole quantity ${repr(quantity)} (label ${repr(opt(item, 'quantityLabel'))}) ` +
        `for ${repr(field(product, 'name'))}`,
    )
  }
  const canonicalUrl = opt(product, 'canonicalUrl')
  return {
    name: asString(field(product, 'name'), 'product name'),
    itemId: asString(field(product, 'usItemId'), 'usItemId'),
    url: truthy(canonicalUrl) ? 'https://www.walmart.com' + asString(canonicalUrl, 'canonicalUrl') : null,
    image: asStringOrNull(opt(truthy(opt(product, 'imageInfo')) ? opt(product, 'imageInfo') : {}, 'thumbnailUrl'), 'thumbnailUrl'),
    categoryPath: asStringOrNull(opt(product, 'categoryPathId'), 'categoryPathId'),
    status,
    quantity: quantity as number,
    salesUnit: asStringOrNull(opt(product, 'salesUnitType'), 'salesUnitType'),
    unitPrice: truthy(unit) ? asString(field(unit, 'displayValue'), 'unitPrice displayValue') : null,
    linePrice: moneyToCents(field(field(price, 'linePrice'), 'displayValue')),
    notes,
  }
}

function parseGroup(group: unknown): OrderGroupDetails {
  const categories = opt(group, 'categories')
  const items = truthy(categories)
    ? asArray(categories, 'categories').flatMap((c) =>
        asArray(field(c, 'items'), 'category items').map((it) =>
          parseItem(it, asString(field(c, 'type'), 'category type')),
        ),
      )
    : asArray(field(group, 'items'), 'group items').map((it) => parseItem(it, null))
  const rawStore = opt(group, 'store')
  const store = truthy(rawStore) ? rawStore : {}
  const address = opt(store, 'address')
  const status = opt(group, 'status')
  return {
    fulfillment: asStringOrNull(opt(group, 'fulfillmentType'), 'fulfillmentType'),
    description: asStringOrNull(opt(group, 'deliveryMessage'), 'deliveryMessage'),
    status: asStringOrNull(opt(truthy(status) ? status : {}, 'statusType'), 'statusType'),
    store: asStringOrNull(opt(store, 'name'), 'store name'),
    storeAddress: asStringOrNull(opt(truthy(address) ? address : {}, 'addressString'), 'addressString'),
    items,
  }
}

function amountRows(rows: unknown[], kind: string): Record<string, Cents> {
  const out = new Map<string, Cents>()
  for (const row of rows) {
    if (!isObject(row) || !('displayValue' in row)) {
      fail(`unfamiliar ${kind} entry: ${(JSON.stringify(row) ?? 'null').slice(0, 200)}`)
    }
    const label = row.label
    out.set(truthy(label) ? String(label) : kind, moneyToCents(row.displayValue))
  }
  return record(out)
}

function listOf(v: unknown, what: string): unknown[] {
  return truthy(v) ? asArray(v, what) : []
}

function parseTotals(details: unknown): Totals {
  const tip = opt(details, 'driverTip')
  const tax = opt(details, 'taxTotal')
  const total = truthy(opt(details, 'grandTotalWithTips')) ? opt(details, 'grandTotalWithTips') : field(details, 'grandTotal')
  const subTotal = field(details, 'subTotal')
  return {
    subtotal: moneyToCents(field(subTotal, 'displayValue')),
    subtotalLabel: asString(field(subTotal, 'label'), 'subTotal label'),
    tax: truthy(tax) ? moneyToCents(field(tax, 'displayValue')) : 0,
    driverTip: truthy(tip) ? moneyToCents(field(tip, 'displayValue')) : 0,
    fees: amountRows(listOf(opt(details, 'fees'), 'fees'), 'fee'),
    discounts: amountRows(listOf(opt(details, 'discounts'), 'discounts'), 'discount'),
    // Returned items stay in the subtotal at full price; the money back is a negative row here.
    refunds: amountRows(listOf(opt(details, 'refund'), 'refund'), 'refund'),
    total: moneyToCents(field(total, 'displayValue')),
  }
}

/** Integrity checks: a mismatch means an item status or price component we don't model yet. */
function checkOrder(groups: OrderGroupDetails[], totals: Totals, itemCount: number): void {
  const items = groups.flatMap((g) => g.items)
  const units = sum(items.map((it) => it.quantity))
  if (units !== itemCount) fail(`item quantities sum to ${units} but the order says ${itemCount} items`)
  const charged = sum(items.filter((it) => !UNCHARGED.has(it.status as string)).map((it) => it.linePrice))
  if (charged !== totals.subtotal) {
    const statuses = [...new Set(items.map((it) => str(it.status)))].sort()
    fail(
      `charged line prices sum to ${formatCents(charged)} but subtotal is ${formatCents(totals.subtotal)} ` +
        `(item statuses seen: [${statuses.map(repr).join(', ')}])`,
    )
  }
  const expected =
    totals.subtotal +
    totals.tax +
    totals.driverTip +
    sum(Object.values(totals.fees)) +
    sum(Object.values(totals.discounts)) +
    sum(Object.values(totals.refunds))
  if (expected !== totals.total) {
    fail(
      `subtotal + tax + tip + fees + discounts + refunds = ${formatCents(expected)} ` +
        `but total is ${formatCents(totals.total)}`,
    )
  }
}

/** Python's datetime.fromisoformat(...).isoformat() for the forms Walmart sends. */
function isoDateTime(value: unknown): string {
  const text = asString(value, 'orderDate')
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(text)
  if (!m) fail(`unrecognised orderDate ${repr(text)}`)
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '', tz = ''] = m
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
  if (
    day.getUTCFullYear() !== Number(y) ||
    day.getUTCMonth() !== Number(mo) - 1 ||
    day.getUTCDate() !== Number(d) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(s) > 59
  ) {
    fail(`invalid orderDate ${repr(text)}`)
  }
  const micros = frac.slice(0, 6).padEnd(6, '0')
  let offset = ''
  if (tz === 'Z') offset = '+00:00'
  else if (tz) offset = `${tz.slice(0, 3)}:${tz.length > 3 ? tz.slice(-2) : '00'}`
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${Number(micros) ? '.' + micros : ''}${offset}`
}

function parseWalmartOrder(capture: OrderCapture): OrderDetails {
  const order = orderJson(capture)
  const groupKeys = Object.keys(order).filter((k) => k === 'groups' || k.startsWith('groups_'))
  if (groupKeys.length !== 1) fail(`expected one groups field on the order, found [${groupKeys.map(repr).join(', ')}]`)
  const groups = asArray(order[groupKeys[0]], groupKeys[0]).map(parseGroup)
  const totals = parseTotals(field(order, 'priceDetails'))
  const itemCount = field(order, 'itemCount')
  if (typeof itemCount !== 'number') fail(`expected itemCount to be a number, got ${repr(itemCount)}`)
  checkOrder(groups, totals, itemCount)

  const id = field(order, 'id')
  return {
    orderId: id === null ? null : String(id),
    displayId: order.displayId === null || order.displayId === undefined ? null : String(order.displayId),
    date: isoDateTime(field(order, 'orderDate')),
    title: asStringOrNull(order.title, 'title'),
    payment: listOf(order.paymentMethods, 'paymentMethods').map((p) => {
      const kind = truthy(opt(p, 'cardType')) ? opt(p, 'cardType') : opt(p, 'paymentType')
      return `${str(kind)} ${str(opt(p, 'description'))}`
    }),
    ...totals,
    groups,
  }
}

// --- samsclub.com: parsed from the rendered DOM ---------------------------------

function* walk(el: Element): Generator<Element> {
  yield el
  for (const child of Array.from(el.children)) yield* walk(child)
}

/** Text nodes in document order, trimmed and whitespace-collapsed; script, style and svg are skipped. */
function* texts(el: Element): Generator<string> {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 1) {
      const tag = (child as Element).localName
      if (tag !== 'script' && tag !== 'style' && tag !== 'svg') yield* texts(child as Element)
    } else if (child.nodeType === 3) {
      const collapsed = (child.nodeValue ?? '').split(SPACES).filter(Boolean).join(' ')
      if (collapsed) yield collapsed
    }
  }
}

function text(el: Element): string {
  return [...texts(el)].join(' ')
}

interface Query {
  testid?: string
  cls?: string
  tag?: string
}

function* findAll(root: Element, q: Query): Generator<Element> {
  for (const n of walk(root)) {
    if (q.testid && (n.getAttribute('data-testid') ?? '') !== q.testid) continue
    if (q.cls && !(n.getAttribute('class') ?? '').split(SPACES).includes(q.cls)) continue
    if (q.tag && n.localName !== q.tag) continue
    yield n
  }
}

function find(root: Element, q: Query): Element | null {
  for (const n of findAll(root, q)) return n
  return null
}

/** Sam's renders prices as separate '$', dollars and cents spans. */
function splitMoney(el: Element): Cents {
  const parts = [...texts(el)]
  if (parts.length !== 3 || parts[0] !== '$' || !/^\d[\d,]*$/.test(parts[1]) || !/^\d{2}$/.test(parts[2])) {
    fail(`unfamiliar line-price layout ${repr(parts)}`)
  }
  return centsFromMatch(MONEY.exec(`$${parts[1]}.${parts[2]}`), parts)
}

function parseSamsItem(tile: Element): OrderItemDetails {
  const nameEl = find(tile, { testid: 'productName' })
  const priceEl = find(tile, { testid: 'line-price' })
  const qtyEl = find(tile, { cls: 'bill-item-quantity' })
  if (!nameEl || !priceEl || !qtyEl) fail('item tile without productName, line-price or quantity')
  const name = text(nameEl)
  const qtyText = text(qtyEl)

  const notes: Record<string, string> = {}
  let quantity: number
  let m: RegExpExecArray | null
  if ((m = /^Qty (\d+)$/.exec(qtyText))) {
    quantity = Number(m[1])
  } else if ((m = /^lb ([\d.]+) lb$/.exec(qtyText))) {
    quantity = 1
    notes.Weight = `${m[1]} lb`
  } else {
    return fail(`unrecognised quantity text ${repr(qtyText)} for ${repr(name)}`)
  }

  const src = find(tile, { testid: 'productTileImage' })?.getAttribute('src') ?? null
  const code = SAMS_IMAGE_CODE.exec(src ?? '')
  const desc = find(tile, { testid: 'productDescription' })
  const descText = desc ? text(desc) : ''
  return {
    name,
    itemId: null,
    // Image asset code; for barcoded goods it reads as the UPC without its check digit.
    productCode: code ? code[1] : null,
    url: null,
    image: src,
    categoryPath: null,
    status: null,
    quantity,
    salesUnit: 'Weight' in notes ? 'WEIGHT' : 'EACH',
    unitPrice: descText || null,
    linePrice: splitMoney(priceEl),
    notes,
  }
}

/** First token after `label`, skipping repeats of the label (Sam's renders some twice). */
function tokenAfter(tokens: string[], label: string): string | null {
  const i = tokens.indexOf(label)
  if (i < 0) return null
  return tokens.slice(i + 1).find((t) => t !== label) ?? null
}

/** Rows between 'Subtotal' and 'Total'; unfamiliar rows are errors until modelled. */
function parseSamsTotals(tokens: string[]): Totals {
  const subIndex = tokens.indexOf('Subtotal')
  const totalIndex = subIndex < 0 ? -1 : tokens.indexOf('Total', subIndex)
  if (subIndex < 0 || totalIndex < 0) fail('no Subtotal/Total rows found')
  const rows = new Map<string, Cents>()
  let label: string | null = null
  for (const t of tokens.slice(subIndex + 2, totalIndex)) {
    const amount = wholeMoney(t)
    if (amount !== null) {
      if (label === null || rows.has(label)) fail(`unexpected amount ${t} in the order summary after ${repr(label)}`)
      rows.set(label, amount)
      continue
    }
    const last = t.split(SPACES).filter(Boolean).at(-1) ?? ''
    const cut = t.lastIndexOf(' ')
    if (MONEY.test(last) && (cut < 0 ? t : t.slice(0, cut)).trim() === SAMS_TAX_LABEL) {
      continue // screen-reader copy: "Sales tax $6.95"
    }
    label = t.trim()
  }
  const tax = rows.get(SAMS_TAX_LABEL) ?? 0
  rows.delete(SAMS_TAX_LABEL)
  const discounts: Record<string, Cents> = {}
  const savings = rows.get(SAMS_SAVINGS_LABEL)
  if (savings !== undefined) {
    rows.delete(SAMS_SAVINGS_LABEL)
    if (savings > 0) fail(`expected Savings to be negative, got ${formatCents(savings)}`)
    discounts[SAMS_SAVINGS_LABEL] = savings
  }
  if (rows.size) {
    fail(`unfamiliar summary rows: ${[...rows].map(([k, v]) => `${k} = ${formatCents(v)}`).join(', ')}`)
  }
  const amountAt = (i: number) => {
    if (i >= tokens.length) fail('order summary ends without an amount')
    return moneyToCents(tokens[i])
  }
  return {
    subtotal: amountAt(subIndex + 1),
    subtotalLabel: 'Subtotal',
    tax,
    driverTip: 0,
    fees: {},
    discounts,
    refunds: {},
    total: amountAt(totalIndex + 1),
  }
}

function monthDate(line: string): string {
  const [mon, day, year] = line.replace(',', '').split(' ')
  const month = MONTHS.indexOf(mon.toLowerCase())
  const probe = new Date(Date.UTC(Number(year), month, Number(day)))
  if (month < 0 || probe.getUTCMonth() !== month || probe.getUTCDate() !== Number(day)) {
    fail(`unrecognised order date ${repr(line)}`)
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${day.padStart(2, '0')}`
}

function parseSamsOrder(capture: OrderCapture): OrderDetails {
  const doc = new DOMParser().parseFromString(capture.html, 'text/html')
  const body = doc.body ?? doc.documentElement
  const tiles = [...findAll(body, { testid: 'itemtile-stack' })]
  if (!tiles.length) fail('no itemtile-stack elements; not an order-details page or layout changed')
  const items = tiles.map(parseSamsItem)
  const tokens = [...texts(body)]

  const count = tokens.find((t) => /^\d+ items?$/.test(t))
  if (count === undefined) fail("no 'N items' line found")
  const totals = parseSamsTotals(tokens)
  const store = tokenAfter(tokens, 'Store location')
  // Purchase channel caption, e.g. "Scan & Go"
  const caption = [...walk(body)].find((n) => (n.getAttribute('id') ?? '').startsWith('caption-'))
  const url = parseUrl(capture.url)
  const storePurchase = url.searchParams.getAll('storePurchase')
  const groups: OrderGroupDetails[] = [
    {
      fulfillment: storePurchase.length === 1 && storePurchase[0] === 'true' ? 'IN_STORE' : null,
      description: caption ? text(caption) : null,
      status: null,
      store,
      storeAddress: store ? tokenAfter(tokens, store) : null,
      items,
    },
  ]
  checkOrder(groups, totals, Number(count.split(' ')[0]))

  const dateLine = tokens.find((t) => DATE_LINE.test(t))
  const tc = tokens.find((t) => t.startsWith('TC '))
  const card = tokenAfter(tokens, 'Payment method')
  const orderId = /\/orders\/(\d+)/.exec(capture.url)
  return {
    orderId: orderId ? orderId[1] : null,
    displayId: tc ? tc.slice(3) : null,
    date: dateLine ? monthDate(dateLine) : null,
    title: dateLine ? `${dateLine} purchase` : null,
    payment: card ? [card] : [],
    ...totals,
    groups,
  }
}

// --- public API -----------------------------------------------------------------

/** Parses the capture, keeping every field the page shows. Money is integer cents. */
export function parseOrderDetails(capture: OrderCapture): OrderDetails {
  return siteOf(capture) === 'walmart' ? parseWalmartOrder(capture) : parseSamsOrder(capture)
}

/** Checks that a value from the extension has the capture shape. */
export function asCapture(value: unknown): OrderCapture {
  if (!isObject(value)) fail(`capture must be an object, got ${repr(value)}`)
  for (const key of ['url', 'title', 'capturedAt', 'html'] as const) {
    if (typeof value[key] !== 'string') fail(`capture.${key} must be a string`)
  }
  if (!Array.isArray(value.jsonScripts)) fail('capture.jsonScripts must be a list')
  value.jsonScripts.forEach((s: unknown, i: number) => {
    const where = `capture.jsonScripts[${i}]`
    if (!isObject(s)) fail(`${where} must be an object`)
    if (s.id !== null && typeof s.id !== 'string') fail(`${where}.id must be a string or null`)
    if (s.type !== null && typeof s.type !== 'string') fail(`${where}.type must be a string or null`)
    if (!('parsed' in s)) fail(`${where}.parsed is missing`)
    if (typeof s.rawLength !== 'number') fail(`${where}.rawLength must be a number`)
  })
  if (!isObject(value.windowState)) fail('capture.windowState must be an object')
  if (!Array.isArray(value.networkUrls) || value.networkUrls.some((u: unknown) => typeof u !== 'string')) {
    fail('capture.networkUrls must be a list of strings')
  }
  return value as unknown as OrderCapture
}

export function importOrder(capture: OrderCapture): ImportedOrder {
  const site = siteOf(capture)
  const details = parseOrderDetails(capture)
  if (!details.orderId) fail('capture has no order id')

  const items: ImportedItem[] = details.groups
    .flatMap((g) => g.items)
    .filter((it) => !UNCHARGED.has(it.status as string))
    .map((it) => ({
      name: it.name,
      quantity: it.quantity,
      lineTotalCents: it.linePrice,
      weight: it.notes.Weight ?? null,
      returned: it.status === 'RETURNED',
    }))
  const order: ImportedOrder = {
    ref: `${site}-${details.orderId}`,
    site,
    orderId: details.orderId,
    store: STORE_NAMES[site],
    date: details.date ? details.date.slice(0, 10) : null,
    items,
    subtotalCents: details.subtotal,
    taxCents: details.tax,
    tipFeesCents: details.driverTip + sum(Object.values(details.fees)),
    discountCents: sum(Object.values(details.discounts)),
    refundCents: sum(Object.values(details.refunds)),
    totalCents: details.total,
  }

  if (sum(items.map((it) => it.lineTotalCents)) !== order.subtotalCents) {
    fail('imported item totals do not add up to the subtotal')
  }
  const parts = order.subtotalCents + order.taxCents + order.tipFeesCents + order.discountCents + order.refundCents
  if (parts !== order.totalCents) {
    fail(`subtotal + tax + tip and fees + discounts + refunds = ${formatCents(parts)} but total is ${formatCents(order.totalCents)}`)
  }
  if (order.tipFeesCents < 0) fail(`tip and fees add up to ${formatCents(order.tipFeesCents)}, expected zero or more`)
  if (order.discountCents > 0) fail(`discounts add up to ${formatCents(order.discountCents)}, expected zero or less`)
  if (order.refundCents > 0) fail(`refunds add up to ${formatCents(order.refundCents)}, expected zero or less`)
  return order
}
