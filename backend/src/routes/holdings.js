// Assets and liabilities that aren't bank accounts — super, property, vehicles,
// investments, private loans. Valued by hand, with a history so the net worth
// chart reflects what each thing was worth at the time.
import { q, uuid, audit } from '../db.js'

const SIDES = ['asset', 'liability']

export default async function (app) {
  app.get('/holdings', async (req) => {
    const includeArchived = req.query.archived === 'true'
    const r = await q(`
      SELECT h.*, v.value_cents, v.as_of,
             (SELECT count(*)::int FROM holding_values x WHERE x.holding_id = h.id) AS valuations
      FROM holdings h
      LEFT JOIN LATERAL (
        SELECT value_cents, as_of FROM holding_values
        WHERE holding_id = h.id ORDER BY as_of DESC LIMIT 1
      ) v ON TRUE
      ${includeArchived ? '' : 'WHERE NOT h.archived'}
      ORDER BY h.side, h.name`)
    return r.rows
  })

  app.get('/holdings/:id/values', async (req) => {
    const r = await q('SELECT id, as_of, value_cents FROM holding_values WHERE holding_id = $1 ORDER BY as_of DESC',
      [req.params.id])
    return r.rows
  })

  app.post('/holdings', async (req, reply) => {
    const { name, side, kind = 'other', notes = null, valueCents, asOf } = req.body || {}
    if (!name?.trim() || !SIDES.includes(side)) return reply.code(400).send({ error: 'name and side (asset|liability) required' })
    if (valueCents != null && !Number.isInteger(valueCents)) return reply.code(400).send({ error: 'valueCents must be whole cents' })
    const id = uuid()
    const r = await q('INSERT INTO holdings (id, name, side, kind, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [id, name.trim(), side, kind, notes])
    // An opening valuation is optional but almost always wanted
    if (valueCents != null) {
      await q('INSERT INTO holding_values (id, holding_id, as_of, value_cents) VALUES ($1,$2,$3,$4)',
        [uuid(), id, asOf || new Date().toISOString().slice(0, 10), Math.abs(valueCents)])
    }
    await audit('create', 'holding', id, null, r.rows[0])
    return r.rows[0]
  })

  app.patch('/holdings/:id', async (req, reply) => {
    const prev = (await q('SELECT * FROM holdings WHERE id = $1', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    const b = req.body || {}
    if ('side' in b && !SIDES.includes(b.side)) return reply.code(400).send({ error: 'side must be asset or liability' })
    const r = await q(
      'UPDATE holdings SET name=$1, side=$2, kind=$3, notes=$4, archived=$5 WHERE id=$6 RETURNING *',
      [(b.name ?? prev.name).trim(), b.side ?? prev.side, b.kind ?? prev.kind,
       'notes' in b ? b.notes : prev.notes, b.archived ?? prev.archived, req.params.id])
    await audit('update', 'holding', req.params.id, prev, r.rows[0])
    return r.rows[0]
  })

  // Record (or correct) a valuation. Same date twice overwrites, so fixing a typo
  // doesn't leave two values fighting for the same day.
  app.post('/holdings/:id/values', async (req, reply) => {
    const { valueCents, asOf } = req.body || {}
    if (!Number.isInteger(valueCents)) return reply.code(400).send({ error: 'valueCents must be whole cents' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf || '')) return reply.code(400).send({ error: 'asOf must be YYYY-MM-DD' })
    const holding = (await q('SELECT 1 FROM holdings WHERE id = $1', [req.params.id])).rows[0]
    if (!holding) return reply.code(404).send({ error: 'Not found' })
    const r = await q(
      `INSERT INTO holding_values (id, holding_id, as_of, value_cents) VALUES ($1,$2,$3,$4)
       ON CONFLICT (holding_id, as_of) DO UPDATE SET value_cents = $4 RETURNING *`,
      [uuid(), req.params.id, asOf, Math.abs(valueCents)])
    await audit('revalue', 'holding', req.params.id, null, r.rows[0])
    return r.rows[0]
  })

  app.delete('/holdings/:id', async (req) => {
    const prev = (await q('DELETE FROM holdings WHERE id = $1 RETURNING *', [req.params.id])).rows[0]
    if (prev) await audit('delete', 'holding', req.params.id, prev, null)
    return { ok: true }
  })
}
