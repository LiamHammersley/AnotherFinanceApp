import { q, uuid } from '../db.js'
import { refreshRecurring } from './recurring.js'
import { budgetBreaches } from './budgets.js'

async function upsertAlert(type, key, message) {
  await q('INSERT INTO alerts (id, type, message, dedupe_key) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING',
    [uuid(), type, message, key])
}

// Alerts are generated lazily when fetched — no background scheduler needed for a single user.
async function generateAlerts() {
  for (const a of await refreshRecurring()) await upsertAlert(a.type, a.key, a.message)

  const unmatched = await q(`
    SELECT id, payee, date FROM transactions
    WHERE type = 'transfer' AND linked_transaction_id IS NULL AND deleted_at IS NULL
      AND date < CURRENT_DATE - 7`)
  for (const t of unmatched.rows) {
    await upsertAlert('unmatched_transfer', `unmatched:${t.id}`, `Transfer leg "${t.payee}" has been unmatched for more than 7 days.`)
  }

  // One alert per category per month — passing a target again shouldn't re-nag
  const month = new Date().toISOString().slice(0, 7)
  for (const b of await budgetBreaches()) {
    const over = '$' + (b.over / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    await upsertAlert('over_budget', `budget:${b.id}:${month}`, `${b.name} is ${over} over its monthly budget.`)
  }

  const uncat = await q(`SELECT count(*)::int AS n FROM transactions
    WHERE category_id IS NULL AND type IN ('income','expense') AND deleted_at IS NULL`)
  if (uncat.rows[0].n > 10) {
    await upsertAlert('uncategorised_batch', 'uncategorised', `${uncat.rows[0].n} uncategorised transactions are awaiting review.`)
  } else {
    await q("DELETE FROM alerts WHERE dedupe_key = 'uncategorised' AND dismissed_at IS NULL")
  }
}

export default async function (app) {
  app.get('/alerts', async (req) => {
    await generateAlerts()
    const showDismissed = req.query.log === 'true'
    const r = await q(
      `SELECT * FROM alerts WHERE ${showDismissed ? 'TRUE' : 'dismissed_at IS NULL'} ORDER BY created_at DESC LIMIT 200`)
    return r.rows
  })

  app.post('/alerts/dismiss', async (req) => {
    if (req.body?.all) await q('UPDATE alerts SET dismissed_at = now() WHERE dismissed_at IS NULL')
    else await q('UPDATE alerts SET dismissed_at = now() WHERE id = $1', [req.body?.id])
    return { ok: true }
  })
}
