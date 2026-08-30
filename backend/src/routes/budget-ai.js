import { q, uuid, audit } from '../db.js'
import { aiConfig, callClaude, extractJson } from '../services/ai.js'
import { goalNeedPerMonth, monthBounds } from '../services/budget.js'
import { BALANCE_SQL, accountFloors } from './accounts.js'
import { commitmentConflicts, planResponse, planTotals, validateProposals } from '../services/budget-plan.js'

// The planner is given the same money the P&L and budgets see, so its numbers can
// be reconciled against the app rather than being a second opinion on a different set.
const COUNTS = `t.deleted_at IS NULL AND t.type IN ('income','expense','interest')
  AND NOT EXISTS (SELECT 1 FROM categories xc LEFT JOIN categories xp ON xp.id = xc.parent_id
                  WHERE xc.id = t.category_id AND (xc.excluded OR xp.excluded))`

const isMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '')

// How far back the "money that never gets spent" floor is measured
const FLOOR_MONTHS = 3

const SYSTEM = `You are a careful personal budgeting adviser for a single Australian household.
All money is AUD DOLLARS. Expenses are given as positive amounts.

Write every figure in your prose as dollars — "$520 a month", "about $1,000". Never write a
raw cent value, never write the word "cents", and never quote the underlying numbers in
parentheses. The household reads this text; it is not a data dump.

You are given: monthly spend history per category, the targets currently in force,
monthly income, known recurring commitments, and the household's own goals in their words.
A goal may already be part funded (alreadySaved, held in the named account) — plan against
stillNeeded, and say so rather than treating the whole target as outstanding.

Produce a budget that is ACHIEVABLE, not aspirational. Rules you must follow:
- Never propose a target for a category id you were not given.
- Ground every number in the history you were given. Do not invent transactions.
- Do not cut a category to less than its recurring committed amount; those bills are contractual.
- Prefer a small number of meaningful changes over trimming everything by 5%.
- Leave essentials (housing, utilities, insurance, health, debt repayment) alone unless a
  goal explicitly targets them, and say so when you do.
- Discretionary categories (eating out, takeaway, entertainment, subscriptions, shopping)
  are where real change happens — be specific about how much and why it is realistic.
- If a goal cannot be met without an implausible cut, say so plainly in goalOutlook
  rather than proposing a number nobody will hit.
- A category with no history and no current target should usually be left alone.
- If you are given a previousPlan and feedback on it, treat the feedback as binding:
  produce a REVISED full plan that honours it, not a diff, and say in the summary
  what you changed and why. Keep anything the feedback didn't object to.

Return ONLY JSON in this exact shape:
{
  "summary": "<3-4 sentences reconciling the plan against what the goals need per month. If the goals outrun what the plan can free, SAY SO with the shortfall and the cheapest fix — move a date, or trim a target. Never imply numbers work when they do not. Do not state totals; they are computed and shown beside your text.>",
  "goalOutlook": [{
    "goal": "<echo the goal text>",
    "verdict": "on_track" | "tight" | "unrealistic",
    "detail": "<2 sentences: what the plan does for this goal, with the numbers>"
  }],
  "proposals": [{
    "categoryId": "<id exactly as given>",
    "proposedDollars": <number, the target for one period, in dollars>,
    "period": "monthly" | "quarterly" | "yearly",
    "reason": "<one sentence, why this number>",
    "confidence": "high" | "medium" | "low"
  }],
  "warnings": ["<anything the household should know before accepting, or omit if none>"]
}
Do not include totals or savings arithmetic in the JSON — those are computed from your
proposals and shown alongside, so a mismatch would be visible.`

export default async function (app) {
  // ---- Goals -------------------------------------------------------------
  // A goal linked to an account carries that account's balance as progress, so the
  // monthly figure solves for what's left. Everything here is derived, never stored —
  // the balance moves with every transaction and the date moves closer every month.
  app.get('/budget-goals', async (req) => {
    const all = req.query.all === 'true'
    const r = await q(
      `SELECT g.*, a.name AS account_name, a.type AS account_type,
              CASE WHEN a.id IS NULL THEN NULL ELSE (${BALANCE_SQL.replace(' AS balance_cents', '')}) END AS account_balance_cents
       FROM budget_goals g LEFT JOIN accounts a ON a.id = g.account_id
       ${all ? '' : "WHERE g.status = 'active'"} ORDER BY g.created_at`)
    // Progress counts the FLOOR of the linked account, not today's balance: a
    // working account swings with the billing cycle, and a goal that reads 101%
    // funded one week and 59% the next is measuring the cycle, not your savings.
    const floors = await accountFloors([...new Set(r.rows.map(g => g.account_id).filter(Boolean))], FLOOR_MONTHS)
    return r.rows.map(g => {
      const balance = g.account_id ? Math.max(0, Number(g.account_balance_cents ?? 0)) : null
      const current = g.account_id ? Math.max(0, floors.get(g.account_id) ?? balance ?? 0) : null
      const target = g.target_cents == null ? null : Number(g.target_cents)
      return {
        ...g,
        current_cents: current,
        account_balance_cents: balance,
        counted_from: g.account_id ? `lowest balance over ${FLOOR_MONTHS} months` : null,
        remaining_cents: target == null ? null : Math.max(0, target - (current ?? 0)),
        progress: target && g.account_id ? Math.min(1, current / target) : null,
        needs_per_month_cents: goalNeedPerMonth(g, undefined, current ?? 0),
      }
    })
  })

  app.post('/budget-goals', async (req, reply) => {
    const { text, targetCents = null, byDate = null, accountId = null } = req.body || {}
    if (!String(text || '').trim()) return reply.code(400).send({ error: 'Describe the goal in your own words' })
    if (targetCents != null && (!Number.isInteger(targetCents) || targetCents < 0))
      return reply.code(400).send({ error: 'targetCents must be a whole number of cents' })
    if (byDate && !/^\d{4}-\d{2}-\d{2}$/.test(byDate)) return reply.code(400).send({ error: 'byDate must be YYYY-MM-DD' })
    if (accountId && !(await q('SELECT 1 FROM accounts WHERE id = $1', [accountId])).rows.length)
      return reply.code(400).send({ error: 'Unknown account' })
    const id = uuid()
    const r = await q(
      'INSERT INTO budget_goals (id, text, target_cents, by_date, account_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [id, String(text).trim(), targetCents, byDate, accountId])
    await audit('create', 'budget_goal', id, null, r.rows[0])
    return r.rows[0]
  })

  app.patch('/budget-goals/:id', async (req, reply) => {
    const prev = (await q('SELECT * FROM budget_goals WHERE id = $1', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    const b = req.body || {}
    if (b.status && !['active', 'achieved', 'dropped'].includes(b.status))
      return reply.code(400).send({ error: 'status must be active, achieved or dropped' })
    if ('text' in b && !String(b.text || '').trim())
      return reply.code(400).send({ error: 'Describe the goal in your own words' })
    if (b.targetCents != null && (!Number.isInteger(b.targetCents) || b.targetCents < 0))
      return reply.code(400).send({ error: 'targetCents must be a whole number of cents' })
    if (b.byDate && !/^\d{4}-\d{2}-\d{2}$/.test(b.byDate))
      return reply.code(400).send({ error: 'byDate must be YYYY-MM-DD' })
    if (b.accountId && !(await q('SELECT 1 FROM accounts WHERE id = $1', [b.accountId])).rows.length)
      return reply.code(400).send({ error: 'Unknown account' })
    const r = await q(
      `UPDATE budget_goals SET text = $1, target_cents = $2, by_date = $3, status = $4, account_id = $5
       WHERE id = $6 RETURNING *`,
      [b.text != null ? String(b.text).trim() : prev.text,
       'targetCents' in b ? b.targetCents : prev.target_cents,
       'byDate' in b ? b.byDate : prev.by_date,
       b.status || prev.status,
       'accountId' in b ? b.accountId : prev.account_id, req.params.id])
    await audit('update', 'budget_goal', req.params.id, prev, r.rows[0])
    return r.rows[0]
  })

  app.delete('/budget-goals/:id', async (req) => {
    const prev = (await q('DELETE FROM budget_goals WHERE id = $1 RETURNING *', [req.params.id])).rows[0]
    if (prev) await audit('delete', 'budget_goal', req.params.id, prev, null)
    return { ok: true }
  })

  // ---- Planning ----------------------------------------------------------
  app.post('/budgets/plan', async (req, reply) => {
    const cfg = await aiConfig()
    if (!cfg.enabled || !cfg.apiKey) return reply.code(400).send({ error: 'AI is disabled or no API key is set' })
    const months = Math.min(Math.max(+req.body?.months || 6, 2), 24)
    const month = isMonth(req.body?.month) ? req.body.month : new Date().toISOString().slice(0, 7)
    const note = String(req.body?.note || '').trim().slice(0, 1000)
    const feedback = String(req.body?.feedback || '').trim().slice(0, 1000)
    // Refining means the model sees what it last proposed and what you thought of it
    const priorPlan = req.body?.previousPlanId
      ? (await q('SELECT proposals, summary FROM budget_plans WHERE id = $1', [req.body.previousPlanId])).rows[0]
      : null
    const { from: monthFrom } = monthBounds(month)

    const [history, targets, goals, commitments, income] = await Promise.all([
      // Per category per month, so the model sees variance rather than one average
      q(`SELECT c.id AS category_id, c.name, pc.name AS parent, c.is_income,
                to_char(date_trunc('month', t.date), 'YYYY-MM') AS month,
                abs(SUM(t.amount_cents))::bigint AS cents
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories pc ON pc.id = c.parent_id
         WHERE ${COUNTS}
           AND t.date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1)
           AND t.date < date_trunc('month', CURRENT_DATE)
         GROUP BY 1,2,3,4,5 ORDER BY 2,5`, [months]),
      q(`SELECT DISTINCT ON (category_id) category_id, period, amount_cents
         FROM budgets WHERE effective_from <= $1 ORDER BY category_id, effective_from DESC`, [monthFrom]),
      q(`SELECT g.id, g.text, g.target_cents, g.by_date, g.account_id, a.name AS account_name,
                CASE WHEN a.id IS NULL THEN NULL ELSE (${BALANCE_SQL.replace(' AS balance_cents', '')}) END AS account_balance_cents
         FROM budget_goals g LEFT JOIN accounts a ON a.id = g.account_id
         WHERE g.status = 'active' ORDER BY g.created_at`),
      // Contractual money — the floor a plan must not cut below
      q(`SELECT COALESCE(r.nickname, r.payee) AS name, r.expected_amount_cents, r.frequency,
                c.name AS category, c.id AS category_id
         FROM recurring r LEFT JOIN categories c ON c.id = r.category_id
         WHERE r.status = 'active' AND r.expected_amount_cents < 0`),
      q(`SELECT to_char(date_trunc('month', t.date), 'YYYY-MM') AS month, SUM(t.amount_cents)::bigint AS cents
         FROM transactions t
         WHERE ${COUNTS} AND t.amount_cents > 0
           AND t.date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1)
           AND t.date < date_trunc('month', CURRENT_DATE)
         GROUP BY 1 ORDER BY 1`, [months]),
    ])

    const goalFloors = await accountFloors([...new Set(goals.rows.map(g => g.account_id).filter(Boolean))], FLOOR_MONTHS)

    if (!history.rows.length)
      return reply.code(400).send({ error: 'No categorised spending in the last few months to plan from' })

    // Everything the plan is allowed to touch, with its current target
    const cats = await q(`SELECT c.id, c.name, pc.name AS parent, c.is_income
                          FROM categories c LEFT JOIN categories pc ON pc.id = c.parent_id
                          WHERE NOT c.archived AND NOT c.excluded
                            AND (pc.id IS NULL OR NOT pc.excluded)`)
    const targetBy = new Map(targets.rows.filter(t => t.amount_cents != null)
      .map(t => [t.category_id, { period: t.period, amount_cents: Number(t.amount_cents) }]))

    // Dollars throughout, so the model has no cent figure available to quote at
    // the household. Amounts come back as dollars too and are converted on arrival.
    const d = cents => Math.round(Number(cents)) / 100
    const payload = {
      currency: 'AUD dollars',
      planningMonth: month,
      categories: cats.rows.map(c => ({
        id: c.id, name: c.parent ? `${c.parent} › ${c.name}` : c.name,
        kind: c.is_income ? 'income' : 'expense',
        currentTarget: targetBy.get(c.id)
          ? { period: targetBy.get(c.id).period, amount: d(targetBy.get(c.id).amount_cents) } : null,
      })),
      monthlySpendByCategory: history.rows.map(r => ({ id: r.category_id, month: r.month, amount: d(r.cents) })),
      monthlyIncome: income.rows.map(r => ({ month: r.month, amount: d(r.cents) })),
      recurringCommitments: commitments.rows.map(r => ({
        name: r.name, categoryId: r.category_id, category: r.category,
        amount: d(Math.abs(Number(r.expected_amount_cents))), frequency: r.frequency,
      })),
      goals: goals.rows.map(g => {
        const saved = g.account_id ? Math.max(0, goalFloors.get(g.account_id) ?? 0) : 0
        return {
          text: g.text,
          target: g.target_cents ? d(g.target_cents) : null,
          byDate: g.by_date,
          alreadySaved: g.account_id ? d(saved) : null,
          savedIn: g.account_name ?? null,
          savedIsLowestBalanceOver: g.account_id ? `${FLOOR_MONTHS} months` : null,
          stillNeeded: g.target_cents ? d(Math.max(0, Number(g.target_cents) - saved)) : null,
        }
      }),
      extraInstruction: note || null,
      previousPlan: priorPlan ? {
        summary: priorPlan.summary?.summary ?? '',
        proposals: priorPlan.proposals.map(p => ({ categoryId: p.categoryId, name: p.name, proposedCents: p.proposedCents, period: p.period })),
      } : null,
      feedbackOnPreviousPlan: feedback || null,
    }

    let result
    try {
      result = extractJson(await callClaude('budget', cfg.budgetModel, cfg.apiKey, SYSTEM,
        JSON.stringify(payload), { effort: cfg.budgetEffort }))
    } catch (err) {
      req.log.error(err, 'Budget planning failed')
      return reply.code(502).send({ error: 'AI request failed: ' + err.message })
    }

    // Trust the reasoning, verify the data. Anything naming a category we didn't
    // offer, or an unusable number, is dropped and reported rather than shown.
    const known = new Map(payload.categories.map(c => [c.id, c]))
    const { proposals, rejected } = validateProposals(result.proposals, known, targetBy)

    // Arithmetic is ours, never the model's — a plan that doesn't add up is worse
    // than no plan, and the totals are the part a reader checks first.
    const spendByCategory = new Map()
    for (const h of history.rows) {
      if (!spendByCategory.has(h.category_id)) spendByCategory.set(h.category_id, [])
      spendByCategory.get(h.category_id).push(Number(h.cents))
    }
    const totals = planTotals(proposals, spendByCategory)
    const conflicts = commitmentConflicts(proposals, payload.recurringCommitments)

    // The verdict reconciles two numbers, and both are ours: what the goals need a
    // month, and what the plan actually frees against typical spending. The model
    // writes the prose around them; it never authors the figures.
    const goalsNeed = goals.rows.reduce((n, g) =>
      n + (goalNeedPerMonth(g, undefined, g.account_id ? Math.max(0, goalFloors.get(g.account_id) ?? 0) : 0) ?? 0), 0)
    const avgOf = id => {
      const seen = spendByCategory.get(id) || []
      return seen.length ? Math.round(seen.reduce((a, b) => a + b, 0) / seen.length) : null
    }
    for (const p of proposals) p.currentAvgCents = avgOf(p.categoryId)
    // Everything with real spending the plan chose to leave alone
    const touched = new Set(proposals.map(p => p.categoryId))
    const untouched = [...spendByCategory.keys()].filter(id => !touched.has(id))
    const untouchedNames = untouched
      .map(id => payload.categories.find(c => c.id === id)?.name)
      .filter(Boolean)

    const id = uuid()
    const summary = String(result.summary || '').slice(0, 2000)
    const stored = {
      summary,
      effort: cfg.budgetEffort,
      goalOutlook: Array.isArray(result.goalOutlook) ? result.goalOutlook.slice(0, 12) : [],
      warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 8).map(String) : [],
      rejected,
      // Checked against the recurring bills we know about, not taken on trust
      conflicts,
      totals: { ...totals, goals_need_per_month_cents: goalsNeed },
      untouched: { count: untouchedNames.length, names: untouchedNames.slice(0, 6) },
      window: `last ${months} months`,
      goalCount: goals.rows.length,
    }
    await q(
      `INSERT INTO budget_plans (id, month, model, thinking_tokens, goals, summary, proposals)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, monthFrom, cfg.budgetModel, null,
       JSON.stringify(payload.goals), JSON.stringify(stored), JSON.stringify(proposals)])
    return { id, month, model: cfg.budgetModel, created_at: new Date().toISOString(), applied_at: null, ...stored, proposals }
  })

  app.get('/budgets/plans', async () => {
    const r = await q(`SELECT id, month, model, summary, proposals, applied_at, applied_ids, created_at
                       FROM budget_plans ORDER BY created_at DESC LIMIT 20`)
    return r.rows.map(planResponse)
  })

  app.get('/budgets/plans/:id', async (req, reply) => {
    const r = await q('SELECT * FROM budget_plans WHERE id = $1', [req.params.id])
    if (!r.rows[0]) return reply.code(404).send({ error: 'Not found' })
    return planResponse(r.rows[0])
  })

  app.delete('/budgets/plans/:id', async (req, reply) => {
    const prev = (await q('DELETE FROM budget_plans WHERE id = $1 RETURNING id, applied_at', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    // Deleting the record does not undo targets it already wrote — those are
    // dated budget rows now, and are edited or cleared on the Targets tab.
    await audit('delete', 'budget_plan', req.params.id, prev, null)
    return { ok: true, wasApplied: !!prev.applied_at }
  })

  // Apply some or all of a plan. Targets are dated, so this writes from the chosen
  // month forward and leaves earlier months exactly as they were.
  app.post('/budgets/plans/:id/apply', async (req, reply) => {
    const plan = (await q('SELECT * FROM budget_plans WHERE id = $1', [req.params.id])).rows[0]
    if (!plan) return reply.code(404).send({ error: 'Not found' })
    const b = req.body || {}
    if (b.effectiveFrom && !isMonth(b.effectiveFrom)) return reply.code(400).send({ error: 'effectiveFrom must be YYYY-MM' })
    const from = monthBounds(b.effectiveFrom || new Date().toISOString().slice(0, 7)).from
    const pick = Array.isArray(b.categoryIds) ? new Set(b.categoryIds) : null
    const chosen = (plan.proposals || []).filter(p => !pick || pick.has(p.categoryId))
    if (!chosen.length) return reply.code(400).send({ error: 'Nothing selected to apply' })

    // Re-check against live categories: one may have been archived or excluded
    // between generating the plan and accepting it.
    const live = new Set((await q(
      `SELECT c.id FROM categories c LEFT JOIN categories pc ON pc.id = c.parent_id
       WHERE NOT c.archived AND NOT c.excluded AND (pc.id IS NULL OR NOT pc.excluded)
         AND c.id = ANY($1)`, [chosen.map(p => p.categoryId)])).rows.map(r => r.id))
    const applied = []
    const skipped = []
    for (const p of chosen) {
      if (!live.has(p.categoryId)) { skipped.push(p.name); continue }
      await q(
        `INSERT INTO budgets (id, category_id, period, amount_cents, effective_from)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (category_id, effective_from) DO UPDATE SET period = $3, amount_cents = $4`,
        [uuid(), p.categoryId, p.period, p.proposedCents, from])
      applied.push(p.categoryId)
    }
    await q('UPDATE budget_plans SET applied_at = now(), applied_ids = $1 WHERE id = $2',
      [JSON.stringify(applied), req.params.id])
    await audit('apply', 'budget_plan', req.params.id, null, { applied: applied.length, from })
    return { ok: true, applied: applied.length, skipped }
  })
}
