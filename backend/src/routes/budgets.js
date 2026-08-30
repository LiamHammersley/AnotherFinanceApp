import { q, uuid, audit } from '../db.js'
import { PERIODS, elapsed, monthBounds, perMonth, status, windowFor, windowLabel } from '../services/budget.js'

// Budgets measure the same money the P&L does: transfers, adjustments, the
// 'excluded' type and excluded categories all stay out, so a target can never be
// blown by an internal transfer.
const COUNTS = `t.deleted_at IS NULL AND t.type IN ('income','expense','interest')
  AND NOT EXISTS (SELECT 1 FROM categories xc LEFT JOIN categories xp ON xp.id = xc.parent_id
                  WHERE xc.id = t.category_id AND (xc.excluded OR xp.excluded))`

const isMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '')

// The target in force for each category in the given month: the most recent row
// at or before it. A NULL amount is a deliberate "stop budgeting this".
async function effectiveTargets(monthStart) {
  const r = await q(
    `SELECT DISTINCT ON (category_id) category_id, period, amount_cents, effective_from
     FROM budgets WHERE effective_from <= $1
     ORDER BY category_id, effective_from DESC`, [monthStart])
  return new Map(r.rows.filter(b => b.amount_cents != null)
    .map(b => [b.category_id, { ...b, amount_cents: Number(b.amount_cents) }]))
}

export default async function (app) {
  // GET /budgets?month=YYYY-MM — every non-archived, non-excluded category with its
  // target, what's been spent in that target's own window, and where the pace is.
  app.get('/budgets', async (req, reply) => {
    const month = isMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7)
    if (req.query.month && !isMonth(req.query.month))
      return reply.code(400).send({ error: 'month must be YYYY-MM' })
    const { from: monthFrom, to: monthTo } = monthBounds(month)
    const today = new Date().toISOString().slice(0, 10)

    const windows = Object.fromEntries(PERIODS.map(p => [p, windowFor(p, month)]))
    // The month before, so each row can say how it actually finished last time —
    // the context that stops a target being set blind
    const prevMonth = (() => {
      const [y, m] = month.split('-').map(Number)
      const d = new Date(y, m - 2, 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    })()
    const prevBounds = monthBounds(prevMonth)
    // How many complete months the "typical spend" average is taken over
    const AVG_MONTHS = 3
    const [cats, targets, prevTargets, prevSpend, spend, avg] = await Promise.all([
      q(`SELECT id, name, parent_id, is_income, colour, excluded FROM categories
         WHERE NOT archived ORDER BY parent_id NULLS FIRST, name`),
      effectiveTargets(monthFrom),
      effectiveTargets(prevBounds.from),
      q(`SELECT t.category_id, COALESCE(SUM(t.amount_cents), 0) AS cents
         FROM transactions t
         WHERE ${COUNTS} AND t.category_id IS NOT NULL AND t.date BETWEEN $1 AND $2
         GROUP BY t.category_id`, [prevBounds.from, prevBounds.to]),
      // One pass, three windows — a row can land in more than one
      q(`SELECT t.category_id,
                COALESCE(SUM(t.amount_cents) FILTER (WHERE t.date BETWEEN $1 AND $2), 0) AS monthly,
                COALESCE(SUM(t.amount_cents) FILTER (WHERE t.date BETWEEN $3 AND $4), 0) AS quarterly,
                COALESCE(SUM(t.amount_cents) FILTER (WHERE t.date BETWEEN $5 AND $6), 0) AS yearly
         FROM transactions t
         WHERE ${COUNTS} AND t.category_id IS NOT NULL
           AND t.date BETWEEN LEAST($1::date, $3::date, $5::date) AND GREATEST($2::date, $4::date, $6::date)
         GROUP BY t.category_id`,
        [windows.monthly.from, windows.monthly.to, windows.quarterly.from, windows.quarterly.to,
         windows.yearly.from, windows.yearly.to]),
      // What each category normally costs — the number a target is set against.
      // Complete months only; a part-month would drag every average down.
      q(`SELECT t.category_id, to_char(date_trunc('month', t.date), 'YYYY-MM') AS m,
                abs(SUM(t.amount_cents))::bigint AS cents
         FROM transactions t
         WHERE ${COUNTS} AND t.category_id IS NOT NULL
           AND t.date >= ($1::date - make_interval(months => $2)) AND t.date < $1::date
         GROUP BY 1, 2`, [monthFrom, AVG_MONTHS]),
    ])

    const spendBy = new Map(spend.rows.map(r => [r.category_id, r]))
    // Averaged over the months that actually have data, and labelled with them
    const avgBy = new Map()
    for (const r of avg.rows) {
      if (!avgBy.has(r.category_id)) avgBy.set(r.category_id, [])
      avgBy.get(r.category_id).push({ month: r.m, cents: Number(r.cents) })
    }
    const avgFor = id => {
      const rows = avgBy.get(id)
      if (!rows?.length) return { avg_per_month_cents: null, avg_window: null }
      return {
        avg_per_month_cents: Math.round(rows.reduce((n, r) => n + r.cents, 0) / rows.length),
        avg_window: windowLabel(rows.map(r => r.month)),
      }
    }
    const prevBy = new Map(prevSpend.rows.map(r => [r.category_id, Math.abs(Number(r.cents))]))
    // Spend is stored signed; a budget is a magnitude, so expenses come back positive
    const spentIn = (categoryId, period) => Math.abs(Number(spendBy.get(categoryId)?.[period] ?? 0))

    const groups = cats.rows.filter(c => !c.parent_id && !c.excluded)
    const subsOf = id => cats.rows.filter(c => c.parent_id === id && !c.excluded)

    const build = (cat, inheritedPeriod) => {
      const t = targets.get(cat.id)
      const period = t?.period ?? inheritedPeriod ?? 'monthly'
      const win = windows[period]
      const el = elapsed(win, today)
      const spent = spentIn(cat.id, period)
      return {
        id: cat.id, name: cat.name, colour: cat.colour, is_income: cat.is_income,
        period, window: win, elapsed: el,
        target_cents: t?.amount_cents ?? null,
        target_per_month_cents: perMonth(t?.amount_cents ?? null, period),
        spent_cents: spent,
        month_spent_cents: spentIn(cat.id, 'monthly'),
        remaining_cents: t ? t.amount_cents - spent : null,
        status: status(spent, t?.amount_cents ?? null, el, cat.is_income),
        ...avgFor(cat.id),
        last_month: { spent_cents: prevBy.get(cat.id) ?? 0, target_cents: prevTargets.get(cat.id)?.amount_cents ?? null },
      }
    }

    const rows = groups.map(g => {
      const subs = subsOf(g.id).map(s => build(s))
      const own = build(g)
      // A group's spend includes everything filed under its children
      const groupSpent = own.spent_cents + subs.reduce((n, s) => n + spentIn(s.id, own.period), 0)
      const monthSpent = own.month_spent_cents + subs.reduce((n, s) => n + s.month_spent_cents, 0)
      // What the children already claim, so over-allocating a group is visible
      const allocated = subs.reduce((n, s) => n + (s.target_per_month_cents ?? 0), 0)
      return {
        ...own,
        spent_cents: groupSpent,
        month_spent_cents: monthSpent,
        remaining_cents: own.target_cents == null ? null : own.target_cents - groupSpent,
        status: status(groupSpent, own.target_cents, own.elapsed, g.is_income),
        avg_per_month_cents: [own, ...subs].reduce((n, r) => n + (r.avg_per_month_cents ?? 0), 0) || null,
        avg_window: own.avg_window ?? subs.find(s => s.avg_window)?.avg_window ?? null,
        last_month: {
          spent_cents: (prevBy.get(g.id) ?? 0) + subs.reduce((n, s) => n + s.last_month.spent_cents, 0),
          target_cents: prevTargets.get(g.id)?.amount_cents ?? null,
        },
        allocated_per_month_cents: allocated,
        over_allocated: own.target_per_month_cents != null && allocated > own.target_per_month_cents,
        subs,
      }
    })

    const budgeted = [...rows, ...rows.flatMap(r => r.subs)].filter(r => r.target_cents != null)
    const expenses = rows.filter(g => !g.is_income)
    const income = rows.filter(g => g.is_income)
    // A group's own target covers everything under it; without one, only the
    // sub-categories that carry targets are covered.
    const groupTarget = g => g.target_per_month_cents
      ?? g.subs.reduce((m, s) => m + (s.target_per_month_cents ?? 0), 0)
    const budgetedSpend = g => g.target_cents != null
      ? g.month_spent_cents
      : g.subs.filter(s => s.target_cents != null).reduce((m, s) => m + s.month_spent_cents, 0)

    const totals = {
      // Headline is monthly-equivalent so a yearly target still contributes sensibly.
      // A group's own target is the authority for the whole group — sub-targets are
      // limits inside it — so the two are never added together. Only when a group has
      // no target of its own do its children's targets stand in for it.
      target_per_month_cents: expenses.reduce((n, g) => n + groupTarget(g), 0),
      income_target_per_month_cents: income.reduce((n, g) => n + groupTarget(g), 0),
      // Only spend that a target actually covers, or the headline compares this
      // month's whole outgoings against a partial budget and always looks broken.
      month_spent_cents: expenses.reduce((n, g) => n + budgetedSpend(g), 0),
      month_earned_cents: income.reduce((n, g) => n + budgetedSpend(g), 0),
      unbudgeted_spent_cents: expenses.reduce((n, g) => n + g.month_spent_cents - budgetedSpend(g), 0),
      budgeted_count: budgeted.length,
      over_count: budgeted.filter(r => r.status === 'over').length,
      ahead_count: budgeted.filter(r => r.status === 'ahead').length,
    }

    const [dy, dm] = month.split('-').map(Number)
    const daysInMonth = new Date(dy, dm, 0).getDate()
    const dayOfMonth = today.slice(0, 7) === month ? Number(today.slice(8, 10))
      : today > monthTo ? daysInMonth : 0
    return { month, monthFrom, monthTo, today, windows, rows, totals,
      pace: { dayOfMonth, daysInMonth, fraction: dayOfMonth / daysInMonth } }
  })

  // PUT /budgets — set (or clear, with amountCents null) a category's target from a
  // month onwards. Earlier months keep whatever was in force then.
  app.put('/budgets', async (req, reply) => {
    const b = req.body || {}
    const period = b.period || 'monthly'
    if (!b.categoryId) return reply.code(400).send({ error: 'categoryId required' })
    if (!PERIODS.includes(period)) return reply.code(400).send({ error: `period must be one of: ${PERIODS.join(', ')}` })
    if (b.amountCents != null && (!Number.isInteger(b.amountCents) || b.amountCents < 0))
      return reply.code(400).send({ error: 'amountCents must be a whole number of cents, or null to clear' })
    if (b.effectiveFrom && !isMonth(b.effectiveFrom)) return reply.code(400).send({ error: 'effectiveFrom must be YYYY-MM' })
    const cat = (await q('SELECT id, excluded FROM categories WHERE id = $1', [b.categoryId])).rows[0]
    if (!cat) return reply.code(404).send({ error: 'Unknown category' })
    if (cat.excluded) return reply.code(400).send({ error: 'That category is excluded from the P&L, so it can’t be budgeted' })

    const from = monthBounds(b.effectiveFrom || new Date().toISOString().slice(0, 7)).from
    const r = await q(
      `INSERT INTO budgets (id, category_id, period, amount_cents, effective_from)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (category_id, effective_from)
       DO UPDATE SET period = $3, amount_cents = $4 RETURNING *`,
      [uuid(), b.categoryId, period, b.amountCents ?? null, from])
    await audit('update', 'budget', r.rows[0].id, null, r.rows[0])
    return r.rows[0]
  })

  // Every dated target for one category, so the history is inspectable
  app.get('/budgets/history/:categoryId', async (req) => {
    const r = await q('SELECT * FROM budgets WHERE category_id = $1 ORDER BY effective_from DESC', [req.params.categoryId])
    return r.rows
  })

  // Removes a single dated entry — for undoing a change, not for stopping a budget
  // (to stop one, PUT amountCents null from the month it should end).
  app.delete('/budgets/:id', async (req) => {
    const prev = (await q('DELETE FROM budgets WHERE id = $1 RETURNING *', [req.params.id])).rows[0]
    if (prev) await audit('delete', 'budget', req.params.id, prev, null)
    return { ok: true }
  })

  // What you actually spend, so the first budget doesn't have to be guessed.
  // Median beats mean here — one $900 rego bill shouldn't set the grocery target.
  // Income is a floor, not a cap — filling it from an average would quietly turn
  // "earn at least this" into "don't earn more than this".
  app.get('/budgets/suggest', async (req) => {
    const months = Math.min(Math.max(+req.query.months || 3, 1), 24)
    const r = await q(
      `SELECT t.category_id, to_char(date_trunc('month', t.date), 'YYYY-MM') AS month,
              abs(SUM(t.amount_cents)) AS cents
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories pc ON pc.id = c.parent_id
       WHERE ${COUNTS} AND t.category_id IS NOT NULL
         AND NOT COALESCE(pc.is_income, c.is_income, FALSE)
         AND t.date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1)
         AND t.date < date_trunc('month', CURRENT_DATE)
       GROUP BY 1, 2`, [months])
    const byCat = new Map()
    for (const row of r.rows) {
      if (!byCat.has(row.category_id)) byCat.set(row.category_id, [])
      byCat.get(row.category_id).push(Number(row.cents))
    }
    return [...byCat.entries()].map(([categoryId, values]) => {
      const sorted = values.sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      return {
        categoryId, months_seen: sorted.length,
        median_cents: median,
        // Rounded up to the nearest $5 — a target of $317.43 invites false precision
        suggested_cents: Math.ceil(median / 500) * 500,
      }
    })
  })
}

// Categories that have passed a monthly target this month, worst first. Feeds the
// dashboard card and the alert check — one definition, so they can't disagree.
export async function budgetBreaches() {
  const month = new Date().toISOString().slice(0, 7)
  const { from, to } = monthBounds(month)
  const targets = await effectiveTargets(from)
  if (!targets.size) return []
  const monthly = [...targets.entries()].filter(([, t]) => t.period === 'monthly' && t.amount_cents > 0)
  if (!monthly.length) return []
  const r = await q(
    `SELECT c.id, c.name, c.parent_id, c.is_income,
            COALESCE(abs(SUM(t.amount_cents)), 0) AS spent
     FROM categories c
     LEFT JOIN transactions t ON (t.category_id = c.id OR t.category_id IN (SELECT id FROM categories WHERE parent_id = c.id))
       AND ${COUNTS} AND t.date BETWEEN $1 AND $2
     WHERE c.id = ANY($3) GROUP BY c.id`, [from, to, monthly.map(([id]) => id)])
  return r.rows
    .filter(row => !row.is_income)
    .map(row => ({ ...row, spent: Number(row.spent), target: targets.get(row.id).amount_cents }))
    .filter(row => row.spent > row.target)
    .map(row => ({ ...row, over: row.spent - row.target }))
    .sort((a, b) => b.over - a.over)
}

// Monthly-equivalent target per category for the current month, so other views can
// draw a target on bars they already render.
export async function monthlyTargets() {
  const { from } = monthBounds(new Date().toISOString().slice(0, 7))
  const targets = await effectiveTargets(from)
  return new Map([...targets.entries()].map(([id, t]) => [id, perMonth(t.amount_cents, t.period)]))
}
