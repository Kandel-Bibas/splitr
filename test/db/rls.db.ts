import postgres, { type TransactionSql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asUser } from '../../worker/db/as-user'

// Row security, exercised the way the Worker will run every request: one
// transaction as the signed-in user (asUser). The admin connection is the
// table owner, so it bypasses row security; it only creates users and links
// contacts, the two things the Worker's admin path will do.
//
// Alice owns everything below except Bob's own split. Her contact "Bea" is
// linked to Bob's account; "Carl" is linked to no one.

// One connection, so a request's settings would still be on it for the next one
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })

const as = <T>(userId: string, fn: (tx: TransactionSql) => Promise<T>) =>
  asUser(sql, { sub: userId, role: 'authenticated' }, fn)

async function newUser(email: string): Promise<string> {
  const [row] = await sql`insert into auth.users (id, email) values (gen_random_uuid(), ${email}) returning id`
  return row.id as string
}

/** Resolves to the Postgres error code the statement failed with. */
async function failsWith(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return (e as { code: string }).code
  }
  throw new Error('expected the statement to fail, it succeeded')
}

const PERMISSION_DENIED = '42501' // also the code for a row security violation
const FOREIGN_KEY_VIOLATION = '23503'

let alice: string
let bob: string
let carol: string
const ids: Record<string, string | number> = {}

beforeAll(async () => {
  alice = await newUser('alice@splitr.test')
  bob = await newUser('bob@splitr.test')
  carol = await newUser('carol@splitr.test')

  await as(alice, async (tx) => {
    const people = await tx`insert into splitr."Person" ("name", "isMe") values
      ('Alice', true), ('Bea', false), ('Carl', false) returning "id", "name"`
    for (const p of people) ids[p.name] = p.id

    const [item] = await tx`insert into splitr."PlaidItem" ("itemId", "accessToken")
      values ('item-alice', 'ciphertext') returning "id"`
    const [acct] = await tx`insert into splitr."Account" ("plaidAccountId", "itemId", "name", "type")
      values ('acct-alice', ${item.id}, 'Checking', 'depository') returning "id"`
    const [txn] = await tx`insert into splitr."Transaction" ("plaidTransactionId", "accountId", "date", "amount", "name")
      values ('txn-alice', ${acct.id}, '2026-10-18', 4200, 'WALMART') returning "id"`
    await tx`insert into splitr."BalanceSnapshot" ("accountId", "date", "currentBalance")
      values (${acct.id}, '2026-10-18', 100000)`
    const [tag] = await tx`insert into splitr."Tag" ("name") values ('groceries') returning "id"`
    Object.assign(ids, { plaidItem: item.id, account: acct.id, transaction: txn.id, tag: tag.id })

    // Shared with Bob: Bea is a participant
    const [shared] = await tx`insert into splitr."Expense"
      ("type", "description", "payerId", "totalCents", "splitMethod", "transactionId")
      values ('SIMPLE', 'Walmart run', ${ids.Alice}, 4200, 'EVEN', ${txn.id}) returning "id"`
    await tx`insert into splitr."ExpenseParticipant" ("expenseId", "personId") values
      (${shared.id}, ${ids.Alice}), (${shared.id}, ${ids.Bea})`
    await tx`insert into splitr."_ExpenseToTag" ("A", "B") values (${shared.id}, ${tag.id})`

    // Shared with Bob through an item only: Bea is assigned one item
    const [itemized] = await tx`insert into splitr."Expense"
      ("type", "payerId", "totalCents", "splitMethod")
      values ('ITEMIZED', ${ids.Alice}, 1200, 'ITEMIZED') returning "id"`
    const [milk] = await tx`insert into splitr."Item"
      ("expenseId", "name", "unitPriceCents", "lineTotalCents", "sortOrder")
      values (${itemized.id}, 'Milk', 1200, 1200, 0) returning "id"`
    await tx`insert into splitr."ItemAssignment" ("itemId", "personId") values (${milk.id}, ${ids.Bea})`

    // Not shared: only Alice and Carl
    const [privateSplit] = await tx`insert into splitr."Expense"
      ("type", "payerId", "totalCents", "splitMethod")
      values ('SIMPLE', ${ids.Alice}, 900, 'EVEN') returning "id"`
    await tx`insert into splitr."ExpenseParticipant" ("expenseId", "personId") values
      (${privateSplit.id}, ${ids.Alice}), (${privateSplit.id}, ${ids.Carl})`

    Object.assign(ids, { shared: shared.id, itemized: itemized.id, milk: milk.id, private: privateSplit.id })
  })

  await as(bob, async (tx) => {
    const [me] = await tx`insert into splitr."Person" ("name", "isMe") values ('Bob', true) returning "id"`
    const [own] = await tx`insert into splitr."Expense" ("type", "payerId", "totalCents", "splitMethod")
      values ('SIMPLE', ${me.id}, 500, 'EVEN') returning "id"`
    Object.assign(ids, { bobMe: me.id, bobSplit: own.id })
  })

  // Bob accepted Alice's invite: the Worker's admin path links her contact
  await sql`update splitr."Person" set "linkedUserId" = ${bob} where "id" = ${ids.Bea}`
})

afterAll(async () => {
  await sql.end()
})

describe('owner', () => {
  it('sees and edits their own rows', async () => {
    await as(alice, async (tx) => {
      expect(await tx`select 1 from splitr."Expense"`).toHaveLength(3)
      expect(await tx`select 1 from splitr."Person"`).toHaveLength(3)
      expect(await tx`select 1 from splitr."Transaction"`).toHaveLength(1)
      const updated = await tx`update splitr."Expense" set "description" = 'Walmart' where "id" = ${ids.shared} returning 1`
      expect(updated).toHaveLength(1)
    })
  })
})

describe('a user who shares nothing with the owner', () => {
  it('sees none of their rows', async () => {
    await as(carol, async (tx) => {
      for (const table of ['Person', 'Expense', 'Item', 'ItemAssignment', 'ExpenseParticipant', 'Tag',
        '_ExpenseToTag', 'PlaidItem', 'Account', 'Transaction', 'BalanceSnapshot']) {
        expect(await tx`select 1 from splitr.${tx(table)}`, table).toHaveLength(0)
      }
    })
  })

  it("can't change or delete them", async () => {
    await as(carol, async (tx) => {
      expect(await tx`update splitr."Expense" set "totalCents" = 1 returning 1`).toHaveLength(0)
      expect(await tx`delete from splitr."Expense" returning 1`).toHaveLength(0)
      expect(await tx`delete from splitr."PlaidItem" returning 1`).toHaveLength(0)
      expect(await tx`update splitr."Person" set "name" = 'x' returning 1`).toHaveLength(0)
    })
    const [row] = await sql`select "totalCents" from splitr."Expense" where "id" = ${ids.shared}`
    expect(row.totalCents).toBe(4200)
  })

  it("can't write a row in the owner's name", async () => {
    expect(await failsWith(as(carol, (tx) =>
      tx`insert into splitr."Tag" ("ownerId", "name") values (${alice}, 'planted')`,
    ))).toBe(PERMISSION_DENIED)
  })
})

describe('a linked friend', () => {
  it('sees the splits they are in, and only those', async () => {
    await as(bob, async (tx) => {
      const splits = await tx`select "id" from splitr."Expense" where "ownerId" = ${alice}`
      expect(splits.map((r) => r.id).sort()).toEqual([ids.shared, ids.itemized].sort())
      expect(await tx`select 1 from splitr."Item" where "ownerId" = ${alice}`).toHaveLength(1)
      expect(await tx`select 1 from splitr."ItemAssignment" where "ownerId" = ${alice}`).toHaveLength(1)
      // Both shares of the shared split; none of the private one's
      expect(await tx`select 1 from splitr."ExpenseParticipant" where "ownerId" = ${alice}`).toHaveLength(2)
    })
  })

  it('sees the people in those splits, not the rest of the contacts', async () => {
    await as(bob, async (tx) => {
      const people = await tx`select "name" from splitr."Person" where "ownerId" = ${alice}`
      expect(people.map((r) => r.name).sort()).toEqual(['Alice', 'Bea'])
    })
  })

  it("doesn't see the bank behind a shared split, or the owner's tags", async () => {
    await as(bob, async (tx) => {
      for (const table of ['PlaidItem', 'Account', 'Transaction', 'BalanceSnapshot', 'Tag', '_ExpenseToTag']) {
        expect(await tx`select 1 from splitr.${tx(table)} where "ownerId" = ${alice}`, table).toHaveLength(0)
      }
    })
  })

  it("can't change a shared split", async () => {
    await as(bob, async (tx) => {
      expect(await tx`update splitr."Expense" set "totalCents" = 1 where "id" = ${ids.shared} returning 1`).toHaveLength(0)
      expect(await tx`update splitr."Item" set "lineTotalCents" = 1 returning 1`).toHaveLength(0)
      expect(await tx`delete from splitr."ExpenseParticipant" where "expenseId" = ${ids.shared} returning 1`).toHaveLength(0)
      expect(await tx`delete from splitr."Expense" where "id" = ${ids.shared} returning 1`).toHaveLength(0)
    })
    // Adding to it fails: the new row is Bob's, and his rows can't point at Alice's split
    expect(await failsWith(as(bob, (tx) =>
      tx`insert into splitr."ExpenseParticipant" ("expenseId", "personId") values (${ids.shared}, ${ids.bobMe})`,
    ))).toBe(FOREIGN_KEY_VIOLATION)
    expect(await failsWith(as(bob, (tx) =>
      tx`insert into splitr."Item" ("expenseId", "name", "unitPriceCents", "lineTotalCents", "sortOrder")
         values (${ids.shared}, 'Planted', 1, 1, 9)`,
    ))).toBe(FOREIGN_KEY_VIOLATION)
  })

  it("can't take over the owner's contact for themselves", async () => {
    await as(bob, async (tx) => {
      expect(await tx`update splitr."Person" set "name" = 'x' where "id" = ${ids.Bea} returning 1`).toHaveLength(0)
    })
  })

  it('stops seeing the splits once unlinked', async () => {
    await sql`update splitr."Person" set "linkedUserId" = null where "id" = ${ids.Bea}`
    try {
      await as(bob, async (tx) => {
        expect(await tx`select 1 from splitr."Expense" where "ownerId" = ${alice}`).toHaveLength(0)
        expect(await tx`select 1 from splitr."Person" where "ownerId" = ${alice}`).toHaveLength(0)
      })
    } finally {
      await sql`update splitr."Person" set "linkedUserId" = ${bob} where "id" = ${ids.Bea}`
    }
  })
})

describe('the owner', () => {
  it("can't link a contact to a user themselves", async () => {
    expect(await failsWith(as(alice, (tx) =>
      tx`update splitr."Person" set "linkedUserId" = ${carol} where "id" = ${ids.Carl}`,
    ))).toBe(PERMISSION_DENIED)
    expect(await failsWith(as(alice, (tx) =>
      tx`insert into splitr."Person" ("name", "linkedUserId") values ('Sneaky', ${carol})`,
    ))).toBe(PERMISSION_DENIED)
  })

  it("can't hand a row to another user", async () => {
    expect(await failsWith(as(alice, (tx) =>
      tx`update splitr."Expense" set "ownerId" = ${carol} where "id" = ${ids.private}`,
    ))).toBe(PERMISSION_DENIED)
  })

  it("can't put someone else's contact in their split", async () => {
    expect(await failsWith(as(alice, (tx) =>
      tx`insert into splitr."ExpenseParticipant" ("expenseId", "personId") values (${ids.private}, ${ids.bobMe})`,
    ))).toBe(FOREIGN_KEY_VIOLATION)
    expect(await failsWith(as(alice, (tx) =>
      tx`insert into splitr."Expense" ("type", "payerId", "totalCents", "splitMethod")
         values ('SIMPLE', ${ids.bobMe}, 1, 'EVEN')`,
    ))).toBe(FOREIGN_KEY_VIOLATION)
  })

  it("can't attach someone else's bank transaction to a split", async () => {
    const [bobTxn] = await as(bob, (tx) =>
      tx`insert into splitr."Transaction" ("source", "date", "amount", "name")
         values ('MANUAL', '2026-10-18', 100, 'Cash') returning "id"`)
    expect(await failsWith(as(alice, (tx) =>
      tx`update splitr."Expense" set "transactionId" = ${bobTxn.id} where "id" = ${ids.private}`,
    ))).toBe(FOREIGN_KEY_VIOLATION)
  })
})

describe('requests without a signed-in user', () => {
  it('asUser refuses claims without a user', async () => {
    await expect(asUser(sql, { sub: '', role: 'authenticated' }, async () => 1)).rejects.toThrow(/needs authenticated claims/)
  })

  it('the anon role has no access to the schema', async () => {
    expect(await failsWith(sql.begin(async (tx) => {
      await tx`set local role anon`
      await tx`select 1 from splitr."Expense"`
    }))).toBe(PERMISSION_DENIED)
  })

  it('settings end with the transaction', async () => {
    await as(alice, async () => {})
    const [row] = await sql`select current_user as role, auth.uid() as uid`
    expect(row).toEqual({ role: 'postgres', uid: null })
  })
})

describe('Data API exposure', () => {
  it('the splitr schema is not granted to anon', async () => {
    const [row] = await sql`select has_schema_privilege('anon', 'splitr', 'usage') as anon`
    expect(row.anon).toBe(false)
  })
})
