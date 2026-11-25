import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pingDatabase } from '../../worker/keep-awake'

// The cron ping: a real query on an app table that reads nobody's rows.

// One connection, so a role left behind by the ping would show on the next query
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })

let ownerId: string

beforeAll(async () => {
  const [user] = await sql`insert into auth.users (id, email) values (gen_random_uuid(), 'keep-awake@splitr.test') returning id`
  ownerId = user.id as string
  await sql`insert into splitr."Person" ("ownerId", name) values (${ownerId}, 'Someone')`
})

afterAll(async () => {
  await sql`delete from splitr."Person" where "ownerId" = ${ownerId}`
  await sql`delete from auth.users where id = ${ownerId}`
  await sql.end()
})

describe('pingDatabase', () => {
  it("gets an answer from Postgres and sees no one's rows", async () => {
    const before = Date.now()
    const { at, visiblePeople } = await pingDatabase(sql)

    expect(at.getTime()).toBeGreaterThanOrEqual(before - 60_000)
    expect(visiblePeople).toBe(0)
    const [{ total }] = await sql`select count(*)::int as total from splitr."Person" where "ownerId" = ${ownerId}`
    expect(total).toBe(1)
  })

  it('leaves the connection on its own role', async () => {
    const [{ role: roleBefore }] = await sql`select current_user as role`
    await pingDatabase(sql)
    const [{ role: roleAfter }] = await sql`select current_user as role`
    expect(roleAfter).toBe(roleBefore)
  })
})
