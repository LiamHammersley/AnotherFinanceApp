import { q, uuid, audit } from '../db.js'

export default async function (app) {
  app.get('/categories', async () => {
    const r = await q('SELECT * FROM categories ORDER BY is_income DESC, name')
    return r.rows
  })

  app.post('/categories', async (req, reply) => {
    const { name, parentId = null, isIncome = false } = req.body || {}
    if (!name) return reply.code(400).send({ error: 'name required' })
    const id = uuid()
    const r = await q('INSERT INTO categories (id, name, parent_id, is_income) VALUES ($1,$2,$3,$4) RETURNING *',
      [id, name, parentId, isIncome])
    await audit('create', 'category', id, null, r.rows[0])
    return r.rows[0]
  })

  app.patch('/categories/:id', async (req, reply) => {
    const prev = (await q('SELECT * FROM categories WHERE id = $1', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    const body = req.body || {}
    const { name = prev.name, archived = prev.archived, colour = prev.colour, excluded = prev.excluded } = body
    if (colour != null && !/^#[0-9a-f]{6}$/i.test(colour))
      return reply.code(400).send({ error: 'colour must be a hex value like #2563eb' })
    // Re-parenting: move a sub-category under a different heading, or promote it to
    // one of its own with parentId: null. Transactions carry their category_id, so
    // they follow the move without being touched.
    let parentId = prev.parent_id
    if (body.parentId !== undefined) {
      parentId = body.parentId || null
      if (parentId !== prev.parent_id) {
        if (parentId === req.params.id) return reply.code(400).send({ error: 'A category cannot sit inside itself' })
        // The model is two levels deep. Moving a category that has children under
        // another heading would make a third, so it has to be emptied first.
        const kids = await q('SELECT count(*)::int AS n FROM categories WHERE parent_id = $1', [req.params.id])
        if (kids.rows[0].n > 0)
          return reply.code(400).send({ error: `${prev.name} has sub-categories of its own — move those out first` })
        if (parentId) {
          const target = (await q('SELECT * FROM categories WHERE id = $1', [parentId])).rows[0]
          if (!target) return reply.code(400).send({ error: 'That category no longer exists' })
          if (target.parent_id) return reply.code(400).send({ error: `${target.name} is itself a sub-category` })
          if (target.archived) return reply.code(400).send({ error: `${target.name} is archived` })
          // Income and expense are different sides of the P&L. Letting an expense
          // slide under an income heading would silently move real money across it.
          if (target.is_income !== prev.is_income)
            return reply.code(400).send({
              error: `${prev.name} is ${prev.is_income ? 'income' : 'spending'} and ${target.name} is ${target.is_income ? 'income' : 'spending'}` })
        }
      }
    }

    const r = await q('UPDATE categories SET name = $1, archived = $2, colour = $3, excluded = $4, parent_id = $5 WHERE id = $6 RETURNING *',
      [name, archived, colour, !!excluded, parentId, req.params.id])
    if (archived !== prev.archived && !prev.parent_id) {
      // Archiving a group hides its sub-categories too (and restore brings them back)
      await q('UPDATE categories SET archived = $1 WHERE parent_id = $2', [archived, req.params.id])
    }
    await audit('update', 'category', req.params.id, prev, r.rows[0])
    return r.rows[0]
  })

  // Delete (and merge): transactions must move to another category first.
  app.delete('/categories/:id', async (req, reply) => {
    const { reassignTo } = req.query
    const prev = (await q('SELECT * FROM categories WHERE id = $1', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    const children = await q('SELECT count(*)::int AS n FROM categories WHERE parent_id = $1', [req.params.id])
    if (children.rows[0].n > 0) return reply.code(400).send({ error: 'Delete sub-categories first' })
    const used = await q('SELECT count(*)::int AS n FROM transactions WHERE category_id = $1', [req.params.id])
    if (used.rows[0].n > 0) {
      if (!reassignTo) return reply.code(400).send({ error: `${used.rows[0].n} transactions use this category — pass reassignTo`, count: used.rows[0].n })
      await q('UPDATE transactions SET category_id = $1 WHERE category_id = $2', [reassignTo, req.params.id])
      await q('UPDATE rules SET category_id = $1 WHERE category_id = $2', [reassignTo, req.params.id])
      await q('UPDATE recurring SET category_id = $1 WHERE category_id = $2', [reassignTo, req.params.id])
    }
    await q('DELETE FROM categories WHERE id = $1', [req.params.id])
    await audit('delete', 'category', req.params.id, prev, null)
    return { ok: true }
  })
}
