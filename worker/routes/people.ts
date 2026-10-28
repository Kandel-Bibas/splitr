import { Hono } from 'hono'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import type { AppEnv } from '../app'
import { person } from '../db/schema'
import { isUuid, readJson } from '../http'

export const people = new Hono<AppEnv>()

// Your contacts. Row security also shows the people in splits friends share
// with you; those aren't yours to list or pick from.
people.get('/', async (c) => {
  const rows = await c.var.db
    .select()
    .from(person)
    .where(and(eq(person.ownerId, c.var.user.sub), eq(person.archived, false)))
    .orderBy(desc(person.isDefault), asc(person.name))
  return c.json(rows)
})

people.post('/', async (c) => {
  const db = c.var.db
  const body = await readJson(c)
  if (body instanceof Response) return body
  const { name, colorHex, isDefault } = (body ?? {}) as Record<string, unknown>

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return c.json({ error: 'name is required and must be a non-empty string' }, 400)
  }

  const [created] = await db
    .insert(person)
    .values({
      name: name.trim(),
      ...(colorHex !== undefined && { colorHex: colorHex as string }),
      ...(isDefault !== undefined && { isDefault: isDefault as boolean }),
    })
    .returning()
  return c.json(created, 201)
})

people.patch('/:id', async (c) => {
  const db = c.var.db
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Person not found' }, 404)
  const body = await readJson(c)
  if (body instanceof Response) return body
  const { name, colorHex, isDefault, isMe, archived } = (body ?? {}) as Record<string, unknown>

  const data: Partial<typeof person.$inferInsert> = {}
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '') {
      return c.json({ error: 'Name must be a non-empty string' }, 400)
    }
    data.name = name.trim()
  }
  if (colorHex !== undefined) data.colorHex = colorHex as string
  if (isDefault !== undefined) data.isDefault = isDefault as boolean
  if (archived !== undefined) data.archived = archived as boolean
  if (isMe !== undefined) {
    if (typeof isMe !== 'boolean') return c.json({ error: 'isMe must be a boolean' }, 400)
    data.isMe = isMe
  }

  // Update this person first, so a bad id fails before anyone else changes
  const [updated] =
    Object.keys(data).length > 0
      ? await db.update(person).set(data).where(eq(person.id, id)).returning()
      : await db.select().from(person).where(and(eq(person.id, id), eq(person.ownerId, c.var.user.sub)))
  if (!updated) return c.json({ error: 'Person not found' }, 404)
  // Only one person can be you
  if (isMe === true) await db.update(person).set({ isMe: false }).where(and(ne(person.id, id), eq(person.isMe, true)))
  return c.json(updated)
})

// Archive, not delete: past splits still name this person
people.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Person not found' }, 404)
  const [archivedRow] = await c.var.db
    .update(person)
    .set({ archived: true })
    .where(eq(person.id, id))
    .returning()
  if (!archivedRow) return c.json({ error: 'Person not found' }, 404)
  return c.json(archivedRow)
})
