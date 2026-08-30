import { q, uuid, audit, tx } from '../db.js'
import { ruleSuggestion } from '../services/vendor.js'
import { conditionsSql, matchRule, validateConditions } from '../services/rules.js'

export { matchRule }

// Rules are matched in-process: callers load the (small) enabled rule set once
// per request instead of querying per transaction, in priority order.
export async function loadRules() {
  return (await q('SELECT * FROM rules WHERE enabled ORDER BY priority')).rows
}

// What a matched rule does to a transaction. Renaming sets the *vendor* — the
// display name — because the payee must stay as the bank wrote it.
export function ruleEffects(rule) {
  return {
    categoryId: rule.category_id ?? null,
    vendor: rule.rename_to || null,
    source: `rule:${rule.name || rule.id.slice(0, 8)}`,
  }
}

// The shorthand the Transactions "Create rule from this…" flow posts
const fromShorthand = b => [{ field: 'payee', op: 'contains', value: b.matchText }]
  .concat(b.minAmountCents != null && b.maxAmountCents != null
    ? [{ field: 'amount', op: 'between', value: +b.minAmountCents, value2: +b.maxAmountCents }]
    : b.minAmountCents != null ? [{ field: 'amount', op: 'gte', value: +b.minAmountCents }]
      : b.maxAmountCents != null ? [{ field: 'amount', op: 'lte', value: +b.maxAmountCents }] : [])
  .concat(b.accountId ? [{ field: 'account', op: 'is', value: b.accountId }] : [])

// Normalises either shape into { name, conditions, matchAll, categoryId, renameTo }
function readBody(b, prev) {
  const conditions = Array.isArray(b.conditions) ? b.conditions
    : b.matchText ? fromShorthand(b)
      : prev?.conditions
  return {
    name: (b.name ?? prev?.name ?? b.matchText ?? '').trim() || null,
    conditions,
    matchAll: b.matchAll ?? prev?.match_all ?? true,
    categoryId: 'categoryId' in b ? b.categoryId || null : prev?.category_id ?? null,
    renameTo: 'renameTo' in b ? (b.renameTo || '').trim() || null : prev?.rename_to ?? null,
    enabled: b.enabled ?? prev?.enabled ?? true,
  }
}

function validate(next) {
  const err = validateConditions(next.conditions)
  if (err) return err
  if (!next.categoryId && !next.renameTo) return 'A rule needs an action: assign a category, rename, or both'
  if (!next.name) return 'Give the rule a name'
  return null
}

export default async function (app) {
  app.get('/rules', async () => {
    const r = await q(`SELECT r.*, c.name AS category_name, pc.name AS parent_category_name
      FROM rules r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN categories pc ON pc.id = c.parent_id
      ORDER BY r.priority`)
    return r.rows
  })

  // Starting point for a rule created from a transaction (a substring of its description)
  app.get('/rules/suggest', async (req, reply) => {
    const payee = req.query.payee || ''
    if (!payee) return reply.code(400).send({ error: 'payee required' })
    return { matchText: ruleSuggestion(payee) }
  })

  // What would this rule catch? Powers the live preview in the rule editor, so
  // conditions can be widened or narrowed before committing. Accepts the
  // conditions as a JSON query param since it's a GET.
  app.get('/rules/preview', async (req, reply) => {
    let conditions
    try {
      conditions = req.query.conditions ? JSON.parse(req.query.conditions)
        : req.query.matchText ? fromShorthand(req.query) : null
    } catch { return reply.code(400).send({ error: 'conditions must be JSON' }) }
    const err = validateConditions(conditions)
    if (err) return reply.code(400).send({ error: err })
    const params = []
    const sql = conditionsSql(params, conditions, req.query.matchAll !== 'false')
    const counts = await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE category_id IS NULL AND type IN ('income','expense'))::int AS uncategorised
       FROM transactions WHERE deleted_at IS NULL AND ${sql}`, params)
    const samples = await q(
      `SELECT payee, amount_cents, date FROM transactions
       WHERE deleted_at IS NULL AND ${sql} ORDER BY date DESC LIMIT 5`, params)
    return { ...counts.rows[0], samples: samples.rows }
  })

  // applyTo: 'uncategorised' also updates existing matches (undoable for 24h)
  app.post('/rules', async (req, reply) => {
    const b = req.body || {}
    const next = readBody(b, null)
    const err = validate(next)
    if (err) return reply.code(400).send({ error: err })
    const id = uuid()
    if (b.prepend) await q('UPDATE rules SET priority = priority + 1') // corrections go top (spec 7.3)
    const pr = b.prepend ? 0 : (await q('SELECT COALESCE(MAX(priority),0)+1 AS p FROM rules')).rows[0].p
    const r = await q(
      `INSERT INTO rules (id, priority, name, conditions, match_all, category_id, rename_to, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, pr, next.name, JSON.stringify(next.conditions), next.matchAll, next.categoryId, next.renameTo, next.enabled])
    await audit('create', 'rule', id, null, r.rows[0])
    if (b.applyTo !== 'uncategorised') return { ...r.rows[0], applied: 0 }
    return { ...r.rows[0], ...(await applyRule(r.rows[0])) }
  })

  app.patch('/rules/:id', async (req, reply) => {
    const prev = (await q('SELECT * FROM rules WHERE id = $1', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    const next = readBody(req.body || {}, prev)
    const err = validate(next)
    if (err) return reply.code(400).send({ error: err })
    const r = await q(
      `UPDATE rules SET name=$1, conditions=$2, match_all=$3, category_id=$4, rename_to=$5, enabled=$6
       WHERE id=$7 RETURNING *`,
      [next.name, JSON.stringify(next.conditions), next.matchAll, next.categoryId, next.renameTo,
       next.enabled, req.params.id])
    await audit('update', 'rule', req.params.id, prev, r.rows[0])
    return r.rows[0]
  })

  // Run an existing rule over everything it currently matches
  app.post('/rules/:id/apply', async (req, reply) => {
    const rule = (await q('SELECT * FROM rules WHERE id = $1', [req.params.id])).rows[0]
    if (!rule) return reply.code(404).send({ error: 'Not found' })
    return applyRule(rule)
  })

  // Drag reorder: client sends full ordered id list
  app.post('/rules/reorder', async (req, reply) => {
    const { ids } = req.body || {}
    if (!Array.isArray(ids)) return reply.code(400).send({ error: 'ids required' })
    await q(`UPDATE rules r SET priority = u.ord - 1
             FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, ord) WHERE r.id = u.id`, [ids])
    return { ok: true }
  })

  app.delete('/rules/:id', async (req) => {
    const prev = (await q('DELETE FROM rules WHERE id = $1 RETURNING *', [req.params.id])).rows[0]
    if (prev) await audit('delete', 'rule', req.params.id, prev, null)
    return { ok: true }
  })
}

// The two actions have different reach. Categorising only ever fills a blank, so a
// category you set by hand is never overwritten. Renaming is cosmetic — it applies
// to every match, including rows already categorised.
async function applyRule(rule) {
  const { categoryId, vendor, source } = ruleEffects(rule)
  const params = []
  const cond = conditionsSql(params, rule.conditions, rule.match_all)
  const all = (await q(
    `SELECT * FROM transactions WHERE deleted_at IS NULL AND type IN ('income','expense') AND ${cond}`, params)).rows
  // Only rows this rule would actually change are worth writing (and undoing)
  const targets = all.filter(t =>
    (categoryId && t.category_id == null) || (vendor && t.vendor !== vendor))
  if (!targets.length) return { applied: 0 }
  const undoId = uuid()
  const description = `Applied rule "${rule.name}" to ${targets.length} transaction${targets.length === 1 ? '' : 's'}`
  await tx(async (cq) => {
    await cq(
      `UPDATE transactions SET
         category_id   = CASE WHEN category_id IS NULL THEN COALESCE($1, category_id) ELSE category_id END,
         assign_source = CASE WHEN category_id IS NULL AND $1::uuid IS NOT NULL THEN $2 ELSE assign_source END,
         vendor        = COALESCE($3, vendor),
         updated_at    = now()
       WHERE id = ANY($4)`,
      [categoryId, source, vendor, targets.map(t => t.id)])
    await cq('INSERT INTO undo_history (id, action, description, payload) VALUES ($1,$2,$3,$4)',
      [undoId, 'apply_rule', description, JSON.stringify({ rows: targets })])
  })
  await audit('apply_rule', 'rule', rule.id, { ids: targets.map(t => t.id) }, { name: rule.name })
  return { applied: targets.length, undoId, description }
}
