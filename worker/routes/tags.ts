import { Hono } from 'hono'
import { and, asc, count, eq, ne } from 'drizzle-orm'
import { normalizeTag } from '@/lib/tags'
import type { AppEnv } from '../app'
import type { Db } from '../db'
import { expenseToTag, tag } from '../db/schema'
import { isUuid, readJson } from '../http'

export const tags = new Hono<AppEnv>()

/** Tags with how many expenses use each, by name. */
function tagsWithCounts(db: Db, ownerId: string) {
  return db
    .select({ id: tag.id, name: tag.name, expenseCount: count(expenseToTag.A) })
    .from(tag)
    .leftJoin(expenseToTag, eq(expenseToTag.B, tag.id))
    .where(eq(tag.ownerId, ownerId))
    .groupBy(tag.id)
    .orderBy(asc(tag.name))
}

/** The body's tag name, cleaned; '' if missing. */
function tagName(body: unknown): string {
  const raw = (body as { name?: unknown } | null)?.name
  return typeof raw === 'string' ? normalizeTag(raw) : ''
}

// GET /api/tags  — every tag, with how many expenses use it
tags.get('/', async (c) => c.json(await tagsWithCounts(c.var.db, c.var.user.sub)))

// POST /api/tags  — { name }
tags.post('/', async (c) => {
  const db = c.var.db
  const body = await readJson(c)
  if (body instanceof Response) return body
  const name = tagName(body)
  if (!name) return c.json({ error: 'name is required' }, 400)

  const [created] = await db
    .insert(tag)
    .values({ name })
    .onConflictDoNothing({ target: [tag.ownerId, tag.name] })
    .returning()
  if (!created) return c.json({ error: `Tag "${name}" already exists` }, 409)
  return c.json({ id: created.id, name: created.name, expenseCount: 0 }, 201)
})

// PATCH /api/tags/:id  — rename: { name }. Expenses link to the tag, so
// every expense using it shows the new name.
tags.patch('/:id', async (c) => {
  const db = c.var.db
  const uid = c.var.user.sub
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Tag not found' }, 404)
  const body = await readJson(c)
  if (body instanceof Response) return body
  const name = tagName(body)
  if (!name) return c.json({ error: 'name is required' }, 400)

  const [existing] = await db.select({ id: tag.id }).from(tag).where(and(eq(tag.id, id), eq(tag.ownerId, uid)))
  if (!existing) return c.json({ error: 'Tag not found' }, 404)
  const [taken] = await db
    .select({ id: tag.id })
    .from(tag)
    .where(and(eq(tag.ownerId, uid), eq(tag.name, name), ne(tag.id, id)))
  if (taken) return c.json({ error: `Tag "${name}" already exists` }, 409)

  await db.update(tag).set({ name }).where(eq(tag.id, id))
  const row = (await tagsWithCounts(db, uid)).find((t) => t.id === id)!
  return c.json(row)
})

// DELETE /api/tags/:id  — the tag is removed from any expenses using it;
// the expenses themselves are kept.
tags.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Tag not found' }, 404)
  const deleted = await c.var.db
    .delete(tag)
    .where(and(eq(tag.id, id), eq(tag.ownerId, c.var.user.sub)))
    .returning({ id: tag.id })
  if (deleted.length === 0) return c.json({ error: 'Tag not found' }, 404)
  return c.json({ deleted: true })
})
