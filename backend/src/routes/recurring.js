import { q, uuid, audit } from '../db.js'
import { vendorFrom } from '../services/vendor.js'

const FREQ_DAYS = { weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91, yearly: 365 }

function classifyInterval(days) {
  if (days >= 5 && days <= 9) return 'weekly'
  if (days >= 12 && days <= 17) return 'fortnightly'
  if (days >= 26 && days <= 35) return 'monthly'
  if (days >= 80 && days <= 100) return 'quarterly'
  if (days >= 330 && days <= 400) return 'yearly'
  return null
}

// ponytail: keyword heuristic for the subscription sub-type; swap for a category-based
// or AI signal if it misses too much.
const SUBSCRIPTION_RE = /netflix|spotify|disney|stan|binge|prime|apple|youtube|paramount|kayo|audible|patreon|subscription/i

export default async function (app) {
  // status=dismissed lists what was dismissed so it can be brought back
  app.get('/recurring', async (req) => {
    const status = req.query.status === 'dismissed' ? 'dismissed' : 'active'
    const r = await q(`SELECT r.*, c.name AS category_name FROM recurring r
      LEFT JOIN categories c ON c.id = r.category_id WHERE r.status = $1 ORDER BY r.next_due NULLS LAST`, [status])
    // `vendor` is only the suggested default when naming one — never stored
    return r.rows.map(x => ({ ...x, vendor: vendorFrom(x.payee) }))
  })

  app.delete('/recurring/:id', async (req) => {
    const prev = (await q('DELETE FROM recurring WHERE id = $1 RETURNING *', [req.params.id])).rows[0]
    if (prev) await audit('delete', 'recurring', req.params.id, prev, null)
    return { ok: true }
  })

  // Scan history: same payee, ≥3 occurrences, consistent interval, similar amount.
  app.post('/recurring/detect', async () => {
    const r = await q(`
      SELECT payee, array_agg(date ORDER BY date) AS dates, array_agg(amount_cents ORDER BY date) AS amounts,
             (array_agg(category_id ORDER BY date DESC))[1] AS category_id
      FROM transactions
      WHERE deleted_at IS NULL AND type IN ('expense','income')
        AND payee NOT IN (SELECT payee FROM recurring)
      GROUP BY payee HAVING count(*) >= 3`)
    const candidates = []
    for (const g of r.rows) {
      const dates = g.dates.map(d => new Date(d))
      const gaps = dates.slice(1).map((d, i) => Math.round((d - dates[i]) / 86400000))
      const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
      const frequency = classifyInterval(median)
      if (!frequency) continue
      if (!gaps.every(gap => classifyInterval(gap) === frequency)) continue
      const amounts = g.amounts.map(Number)
      const expected = amounts[amounts.length - 1]
      if (!amounts.every(a => Math.abs(a - expected) <= Math.abs(expected) * 0.2)) continue
      const lastSeen = g.dates[g.dates.length - 1]
      const nextDue = new Date(new Date(lastSeen).getTime() + FREQ_DAYS[frequency] * 86400000).toISOString().slice(0, 10)
      candidates.push({
        payee: g.payee, frequency, expected_amount_cents: expected, category_id: g.category_id,
        last_seen: lastSeen, next_due: nextDue, occurrences: g.dates.length,
        is_subscription: SUBSCRIPTION_RE.test(g.payee),
      })
    }
    return candidates
  })

  // Confirm a detected pattern, or create manually
  app.post('/recurring', async (req, reply) => {
    const b = req.body || {}
    if (!b.payee || !b.frequency || b.expectedAmountCents == null) return reply.code(400).send({ error: 'payee, frequency, expectedAmountCents required' })
    const id = uuid()
    const r = await q(
      `INSERT INTO recurring (id, payee, nickname, category_id, expected_amount_cents, frequency, last_seen, next_due, is_subscription)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, b.payee, (b.nickname || '').trim() || null, b.categoryId ?? null, b.expectedAmountCents, b.frequency,
       b.lastSeen ?? null, b.nextDue ?? null, b.isSubscription ?? SUBSCRIPTION_RE.test(b.payee)])
    await audit('create', 'recurring', id, null, r.rows[0])
    return r.rows[0]
  })

  app.patch('/recurring/:id', async (req, reply) => {
    const prev = (await q('SELECT * FROM recurring WHERE id = $1', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    const b = req.body || {}
    // Blank clears the nickname and falls back to the payee everywhere it's shown
    const nickname = 'nickname' in b ? (b.nickname || '').trim() || null : prev.nickname
    const r = await q(
      `UPDATE recurring SET expected_amount_cents=$1, frequency=$2, status=$3, is_subscription=$4, next_due=$5, nickname=$6
       WHERE id=$7 RETURNING *`,
      [b.expectedAmountCents ?? prev.expected_amount_cents, b.frequency ?? prev.frequency,
       b.status ?? prev.status, b.isSubscription ?? prev.is_subscription, b.nextDue ?? prev.next_due,
       nickname, req.params.id])
    await audit('update', 'recurring', req.params.id, prev, r.rows[0])
    return r.rows[0]
  })
}

// Called from the alerts check: advance last_seen/next_due from new matching transactions,
// and surface overdue / amount-change conditions.
export async function refreshRecurring() {
  const active = await q("SELECT * FROM recurring WHERE status = 'active'")
  const out = []
  for (const rec of active.rows) {
    const latest = await q(
      `SELECT date, amount_cents FROM transactions WHERE payee = $1 AND deleted_at IS NULL
       AND ($2::date IS NULL OR date > $2) ORDER BY date DESC LIMIT 1`, [rec.payee, rec.last_seen])
    if (latest.rows[0]) {
      const { date, amount_cents } = latest.rows[0]
      const nextDue = new Date(new Date(date).getTime() + FREQ_DAYS[rec.frequency] * 86400000).toISOString().slice(0, 10)
      await q('UPDATE recurring SET last_seen = $1, next_due = $2 WHERE id = $3', [date, nextDue, rec.id])
      const drift = Math.abs(Number(amount_cents) - Number(rec.expected_amount_cents))
      if (drift > Math.abs(Number(rec.expected_amount_cents)) * 0.05) {
        out.push({ type: 'amount_change', key: `amount:${rec.id}:${date.toISOString?.().slice(0, 10) ?? date}`,
          message: `${rec.nickname || rec.payee}: amount changed by more than 5% vs expected.` })
      }
    } else if (rec.next_due && (Date.now() - new Date(rec.next_due).getTime()) / 86400000 >= 3) {
      out.push({ type: 'overdue_recurring', key: `overdue:${rec.id}:${rec.next_due.toISOString?.().slice(0, 10) ?? rec.next_due}`,
        message: `${rec.nickname || rec.payee}: expected recurring transaction is 3+ days overdue.` })
    }
  }
  return out
}
