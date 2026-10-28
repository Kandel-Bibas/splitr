import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppEnv } from '../../worker/app'
import { requireUser } from '../../worker/auth'
import { person } from '../../worker/db/schema'
import { admin, call, callWith, env, newUser, startAuth, stopAuth, tokenFor } from './api'

// Build step 2's bar: any request without a valid login gets a 401, and a
// valid one only ever reaches its own user's rows.

let ann: string
let ben: string

beforeAll(async () => {
  await startAuth()
  ann = await newUser('ann@splitr.test')
  ben = await newUser('ben@splitr.test')
})

afterAll(stopAuth)

describe('without a valid login', () => {
  const cases: [string, () => Promise<string | undefined>][] = [
    ['no Authorization header', async () => undefined],
    ['a non-Bearer header', async () => 'Basic abc'],
    ['garbage', async () => 'Bearer not-a-jwt'],
    ['an expired token', async () => `Bearer ${await tokenFor(ann, { exp: Math.floor(Date.now() / 1000) - 60 })}`],
    ['another issuer', async () => `Bearer ${await tokenFor(ann, { iss: 'https://evil.example/auth/v1' })}`],
    ['another audience', async () => `Bearer ${await tokenFor(ann, { aud: 'anon' })}`],
    ['the anon role', async () => `Bearer ${await tokenFor(ann, { role: 'anon' })}`],
    ['a tampered signature', async () => `Bearer ${(await tokenFor(ann)).slice(0, -4)}AAAA`],
  ]

  for (const [name, auth] of cases) {
    it(`${name} gets a 401 and touches nothing`, async () => {
      const res = await callWith(await auth(), 'POST', '/api/people', { name: 'Intruder' })
      expect(res.status).toBe(401)
    })
  }

  it('wrote no rows', async () => {
    const [{ n }] = await admin`select count(*)::int as n from splitr."Person" where "name" = 'Intruder'`
    expect(n).toBe(0)
  })
})

describe('with a valid login', () => {
  it('reaches only its own rows', async () => {
    expect((await call(ann, 'POST', '/api/people', { name: 'Ann' })).status).toBe(201)
    expect((await call(ben, 'POST', '/api/people', { name: 'Ben' })).status).toBe(201)

    const annSees = await call(ann, 'GET', '/api/people')
    expect(annSees.status).toBe(200)
    expect((annSees.body as { name: string }[]).map((p) => p.name)).toEqual(['Ann'])

    const benSees = await call(ben, 'GET', '/api/people')
    expect((benSees.body as { name: string }[]).map((p) => p.name)).toEqual(['Ben'])
  })

  it('rows it creates belong to it', async () => {
    const [row] = await admin`select "ownerId" from splitr."Person" where "name" = 'Ann'`
    expect(row.ownerId).toBe(ann)
  })
})

describe('a request that fails partway', () => {
  it('rolls back what it wrote', async () => {
    const failing = new Hono<AppEnv>()
    failing.use('*', requireUser)
    failing.post('/', async (c) => {
      await c.var.db.insert(person).values({ name: 'Half-saved' })
      throw new Error('boom')
    })
    failing.onError((_, c) => c.json({ error: 'Something went wrong' }, 500))

    const res = await failing.request('/', { method: 'POST', headers: { Authorization: `Bearer ${await tokenFor(ann)}` } }, env())
    expect(res.status).toBe(500)
    const [{ n }] = await admin`select count(*)::int as n from splitr."Person" where "name" = 'Half-saved'`
    expect(n).toBe(0)
  })
})
