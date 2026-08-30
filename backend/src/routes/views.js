import { q } from '../db.js'
import { vendorFrom } from '../services/vendor.js'
import { BALANCE_SQL } from './accounts.js'
import { RANGES, rangeWindow, sampleDates, toSnapshots, buildMovement, gridlines } from '../services/networth.js'
import { budgetBreaches, monthlyTargets } from './budgets.js'

// P&L rows exclude transfers and adjustments; interest counts as expense-side.
const PNL_TYPES = "('income','expense','interest')"

// Two ways a transaction stays out of the P&L: its own type, or a category (or
// category group) the user has marked excluded — a mortgage principal leg, an
// owner drawing. Either way it still moves account balances and net worth.
// Written as NOT EXISTS so it drops into any query without needing a join.
const IN_PNL = (t = 't') => `${t}.type IN ${PNL_TYPES} AND NOT EXISTS (
      SELECT 1 FROM categories xc LEFT JOIN categories xp ON xp.id = xc.parent_id
      WHERE xc.id = ${t}.category_id AND (xc.excluded OR xp.excluded))`

export default async function (app) {
  // One composite payload — the dashboard renders in a single round trip.
  app.get('/dashboard', async () => {
    const [cash, dailyNet, committed, balances, spending, recent, upcoming, alerts, meta, uncat, suggested, unmatched, dupes] = await Promise.all([
      // This month vs last. The comparison is like-for-like — last month only up to
      // the same day — because on the 4th, 4 days against a full 31 always flatters.
      q(`SELECT
           COALESCE(SUM(amount_cents) FILTER (WHERE amount_cents > 0 AND date >= date_trunc('month', CURRENT_DATE)), 0) AS income_cents,
           COALESCE(SUM(amount_cents) FILTER (WHERE amount_cents < 0 AND date >= date_trunc('month', CURRENT_DATE)), 0) AS expense_cents,
           count(*) FILTER (WHERE amount_cents > 0 AND date >= date_trunc('month', CURRENT_DATE))::int AS income_n,
           count(*) FILTER (WHERE amount_cents < 0 AND date >= date_trunc('month', CURRENT_DATE))::int AS expense_n,
           COALESCE(SUM(amount_cents) FILTER (
             WHERE date < date_trunc('month', CURRENT_DATE)
               AND extract(day from date) <= extract(day from CURRENT_DATE)), 0) AS prev_net_cents,
           COALESCE(SUM(amount_cents) FILTER (WHERE date < date_trunc('month', CURRENT_DATE)), 0) AS prev_full_cents,
           extract(day from CURRENT_DATE)::int AS day_of_month,
           extract(day from (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day'))::int AS days_in_month
         FROM transactions
         WHERE deleted_at IS NULL AND ${IN_PNL('transactions')}
           AND date >= date_trunc('month', CURRENT_DATE) - interval '1 month'`),
      // Daily net for this month and last, cumulated below into the card's trend line
      q(`SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
                extract(day from date)::int AS day, SUM(amount_cents) AS cents
         FROM transactions
         WHERE deleted_at IS NULL AND ${IN_PNL('transactions')}
           AND date >= date_trunc('month', CURRENT_DATE) - interval '1 month'
         GROUP BY 1, 2 ORDER BY 1, 2`),
      // Scheduled money not yet spent: confirmed recurring still due before month end
      q(`SELECT COALESCE(SUM(expected_amount_cents) FILTER (WHERE expected_amount_cents < 0), 0) AS bills_cents,
                COALESCE(SUM(expected_amount_cents) FILTER (WHERE expected_amount_cents > 0), 0) AS income_cents,
                count(*)::int AS n
         FROM recurring
         WHERE status = 'active' AND next_due IS NOT NULL
           AND next_due > CURRENT_DATE
           AND next_due <= (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date`),
      // Daily balance for the last 30 days, per active account (grouped into series below)
      q(`SELECT a.id, a.name, a.type, a.colour, a.opening_balance_cents, d.d::date AS day,
                a.opening_balance_cents + COALESCE((
                  SELECT SUM(t.amount_cents) FROM transactions t
                  WHERE t.account_id = a.id AND t.deleted_at IS NULL AND t.date <= d.d), 0) AS bal
         FROM accounts a
         CROSS JOIN generate_series(CURRENT_DATE - 29, CURRENT_DATE, interval '1 day') AS d(d)
         WHERE NOT a.archived
         ORDER BY a.sort_order, a.created_at, a.id, d.d`),
      // Spend by category group, this month and last, so every row carries a delta
      q(`SELECT COALESCE(pc.name, c.name, 'Uncategorised') AS name,
                MAX(COALESCE(pc.colour, c.colour)) AS colour,
                MAX(COALESCE(pc.id, c.id)::text) AS category_id,
                COALESCE(SUM(-t.amount_cents) FILTER (WHERE t.date >= date_trunc('month', CURRENT_DATE)), 0) AS amount_cents,
                COALESCE(SUM(-t.amount_cents) FILTER (WHERE t.date < date_trunc('month', CURRENT_DATE)), 0) AS prev_cents,
                COALESCE(bool_or(COALESCE(pc.is_income, c.is_income, FALSE)), FALSE) AS is_income
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories pc ON pc.id = c.parent_id
         WHERE t.deleted_at IS NULL AND ${IN_PNL()}
           AND t.date >= date_trunc('month', CURRENT_DATE) - interval '1 month'
         GROUP BY 1`),
      q(`SELECT t.id, t.date, t.payee, t.vendor, t.amount_cents, t.type, t.category_id, t.notes,
                c.name AS category_name, c.archived AS category_archived, a.name AS account_name
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id JOIN accounts a ON a.id = t.account_id
         WHERE t.deleted_at IS NULL ORDER BY t.date DESC, t.created_at DESC LIMIT 7`),
      // Next 14 days of confirmed recurring; never-seen entries are flagged new
      q(`SELECT r.id, COALESCE(r.nickname, r.payee) AS payee, r.expected_amount_cents, r.next_due, r.last_seen IS NULL AS is_new,
                c.name AS category_name
         FROM recurring r LEFT JOIN categories c ON c.id = r.category_id
         WHERE r.status = 'active' AND r.next_due IS NOT NULL
           AND r.next_due <= CURRENT_DATE + 14
         ORDER BY r.next_due`),
      q('SELECT count(*)::int AS n FROM alerts WHERE dismissed_at IS NULL'),
      q(`SELECT (SELECT count(*)::int FROM transactions WHERE deleted_at IS NULL) AS tx_count,
                GREATEST(
                  (SELECT MAX(created_at) FROM imports),
                  (SELECT MAX(created_at) FROM transactions WHERE deleted_at IS NULL)
                ) AS synced_at,
                -- Pay cycles: income hits matching a confirmed recurring income this month
                (SELECT count(*)::int FROM transactions t WHERE t.deleted_at IS NULL AND t.type = 'income'
                   AND t.date >= date_trunc('month', CURRENT_DATE)
                   AND EXISTS (SELECT 1 FROM recurring r WHERE r.status = 'active'
                               AND r.expected_amount_cents > 0 AND r.payee = t.payee)) AS pay_cycles,
                (SELECT count(DISTINCT date)::int FROM transactions WHERE deleted_at IS NULL AND type = 'income'
                   AND date >= date_trunc('month', CURRENT_DATE)) AS income_days`),
      q(`SELECT count(*)::int AS n FROM transactions
         WHERE deleted_at IS NULL AND category_id IS NULL AND type IN ('income','expense')`),
      q(`SELECT count(*)::int AS n FROM transactions
         WHERE deleted_at IS NULL AND assign_source LIKE 'ai_suggested:%'`),
      q(`SELECT count(*)::int AS n FROM transactions
         WHERE deleted_at IS NULL AND type = 'transfer' AND linked_transaction_id IS NULL`),
      // Monthly recurring seen more than once this month — the "billed twice" anomaly
      q(`SELECT r.payee, count(*)::int AS n, SUM(-t.amount_cents) AS total_cents,
                array_agg(to_char(t.date, 'DD Mon') ORDER BY t.date) AS days
         FROM recurring r
         JOIN transactions t ON t.payee = r.payee AND t.deleted_at IS NULL
           AND t.date >= date_trunc('month', CURRENT_DATE) AND t.amount_cents < 0
         WHERE r.status = 'active' AND r.frequency = 'monthly'
         GROUP BY r.payee HAVING count(*) > 1
         ORDER BY 3 DESC LIMIT 1`),
    ])

    // Group the flat day rows into one series per account, and derive its footnote
    const accounts = []
    for (const row of balances.rows) {
      let acct = accounts.find(a => a.id === row.id)
      if (!acct) {
        acct = { id: row.id, name: row.name, type: row.type, colour: row.colour,
          kind: row.type === 'standard' ? 'asset' : 'liability', series: [], days: [] }
        accounts.push(acct)
      }
      acct.series.push(Number(row.bal))
      acct.days.push(row.day)
    }
    const monthMove = await q(`
      SELECT account_id,
             COALESCE(SUM(-amount_cents) FILTER (WHERE amount_cents < 0), 0) AS charged_cents,
             COALESCE(SUM(amount_cents) FILTER (WHERE amount_cents > 0), 0) AS repaid_cents
      FROM transactions WHERE deleted_at IS NULL AND date >= date_trunc('month', CURRENT_DATE)
      GROUP BY account_id`)
    const fmt = c => '$' + (Math.abs(Number(c)) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const dayLabel = d => new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
    for (const a of accounts) {
      a.balance_cents = a.series[a.series.length - 1] ?? 0
      a.delta30d_cents = a.balance_cents - (a.series[0] ?? 0)
      const move = monthMove.rows.find(m => m.account_id === a.id)
      if (a.kind === 'liability') {
        const label = a.type === 'mortgage' ? 'Interest' : 'Charges'
        a.footnote = `${label} ${fmt(move?.charged_cents ?? 0)} · repaid ${fmt(move?.repaid_cents ?? 0)}`
      } else {
        const low = Math.min(...a.series)
        a.footnote = `Low of ${fmt(low)} on ${dayLabel(a.days[a.series.indexOf(low)])}`
      }
      delete a.days
    }

    // Budget targets ride along on the spending bars the dashboard already draws
    const [targets, breaches] = await Promise.all([monthlyTargets(), budgetBreaches()])
    const spendRows = spending.rows.map(r => ({
      name: r.name, colour: r.colour, category_id: r.category_id,
      target_cents: r.category_id ? targets.get(r.category_id) ?? null : null,
      amount_cents: Number(r.amount_cents), prev_cents: Number(r.prev_cents), is_income: r.is_income,
    }))
    const topSpending = spendRows.filter(r => !r.is_income && r.amount_cents > 0)
      .sort((a, b) => b.amount_cents - a.amount_cents).slice(0, 6)
    // Biggest movers reads across everything, income included
    const movers = spendRows.map(r => ({ ...r, delta: r.amount_cents - r.prev_cents }))
      .filter(r => r.prev_cents !== 0 || r.amount_cents !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4)

    // Attention items, ranked by urgency, capped at 3
    const attention = []
    const d = dupes.rows[0]
    if (d) attention.push({ severity: 'alert', kind: 'duplicate', payee: d.payee, vendor: vendorFrom(d.payee), count: d.n,
      detail: `${fmt(d.total_cents)} across ${d.days.join(' and ')}`, action: 'Inspect', search: d.payee })
    if (uncat.rows[0].n > 0) attention.push({ severity: 'ai', kind: 'uncategorised', count: uncat.rows[0].n,
      detail: suggested.rows[0].n > 0 ? `${suggested.rows[0].n} have an AI suggestion ready to accept` : 'Run Suggest categories to get proposals',
      action: 'Review', view: 'uncat' })
    if (unmatched.rows[0].n > 0) attention.push({ severity: 'info', kind: 'unmatched', count: unmatched.rows[0].n,
      detail: 'Transfer legs with no matching pair', action: 'Match', view: 'transfers' })
    if (breaches.length) attention.push({ severity: 'alert', kind: 'over_budget', count: breaches.length,
      detail: breaches.slice(0, 3).map(b => `${b.name} ${fmt(b.over)} over`).join(' · '),
      action: 'Budgets', href: '/budgets' })

    const m = meta.rows[0]
    const c = cash.rows[0]
    const netSoFar = Number(c.income_cents) + Number(c.expense_cents)

    // Running net per day. Last month runs its full length so both lines share a
    // 1..31 axis. This month runs to today, or later if it holds future-dated rows —
    // the line must always end on the headline figure.
    const thisMonth = new Date().toISOString().slice(0, 7)
    const cumulate = (month, upTo) => {
      const byDay = new Map(dailyNet.rows.filter(r => r.month === month).map(r => [r.day, Number(r.cents)]))
      const out = []
      let running = 0
      for (let day = 1; day <= upTo; day++) { running += byDay.get(day) || 0; out.push(running) }
      return out
    }
    const prevStart = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d })()
    const prevMonth = prevStart.toISOString().slice(0, 7)
    // Last month's own length — a 30-day month must not grow a flat 31st day
    const prevDays = new Date(prevStart.getFullYear(), prevStart.getMonth() + 1, 0).getDate()
    const lastDayWithData = Math.max(0, ...dailyNet.rows.filter(r => r.month === thisMonth).map(r => r.day))
    const trend = cumulate(thisMonth, Math.max(c.day_of_month, lastDayWithData))
    const prevTrend = cumulate(prevMonth, prevDays)

    // Where the month lands: what's actually scheduled beats extrapolating a few
    // days of spending. Only when nothing recurring is set up do we fall back to pace.
    const committedRest = Number(committed.rows[0].bills_cents) + Number(committed.rows[0].income_cents)
    const projected = committed.rows[0].n > 0
      ? netSoFar + committedRest
      : Math.round((netSoFar / Math.max(c.day_of_month, 1)) * c.days_in_month)

    return {
      period: {
        label: new Date().toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
        payCycles: m.pay_cycles || m.income_days, txCount: m.tx_count, syncedAt: m.synced_at,
      },
      cashFlow: {
        income_cents: Number(c.income_cents), expense_cents: Number(c.expense_cents),
        income_n: c.income_n, expense_n: c.expense_n,
        net_cents: netSoFar, prev_net_cents: Number(c.prev_net_cents), prev_full_cents: Number(c.prev_full_cents),
        dayOfMonth: c.day_of_month, daysInMonth: c.days_in_month,
        // Running net per day, this month so far against the whole of last month
        trend, prevTrend,
        // Scheduled but not yet spent, so the projection is grounded in real
        // commitments; with nothing recurring set up it falls back to pace.
        billsDue_cents: Number(committed.rows[0].bills_cents),
        incomeDue_cents: Number(committed.rows[0].income_cents),
        dueCount: committed.rows[0].n,
        projected_cents: projected,
        projectedFrom: committed.rows[0].n > 0 ? 'committed' : 'pace',
      },
      accounts, topSpending, movers,
      upcoming: upcoming.rows.map(u => ({ ...u, vendor: vendorFrom(u.payee) })),
      upcomingNet_cents: upcoming.rows.reduce((s, r) => s + Number(r.expected_amount_cents), 0),
      attention: attention.slice(0, 3), attentionTotal: attention.length,
      recent: recent.rows,
      uncategorised: uncat.rows[0].n,
      alertCount: alerts.rows[0].n,
    }
  })

  // Rows: category > sub-category, columns: months (or quarters/years). from/to inclusive.
  const PERIODS = { month: 'month', quarter: 'quarter', year: 'year' }
  app.get('/pnl', async (req) => {
    const { from, to, includeArchived } = req.query
    const unit = PERIODS[req.query.groupBy] || 'month'
    const params = [from, to]
    // Optional account filter — the P&L toolbar and its drill-through both use it
    let accountFilter = ''
    if (req.query.account) { params.push(req.query.account); accountFilter = `AND t.account_id = $${params.length}` }
    // Period label is sortable and self-describing: 2026-07 / 2026-Q3 / 2026
    const label = unit === 'month' ? `to_char(date_trunc('month', t.date), 'YYYY-MM')`
      : unit === 'quarter' ? `to_char(date_trunc('quarter', t.date), 'YYYY') || '-Q' || to_char(date_trunc('quarter', t.date), 'Q')`
        : `to_char(date_trunc('year', t.date), 'YYYY')`
    const r = await q(`
      SELECT COALESCE(pc.id, c.id) AS category_id, COALESCE(pc.name, c.name) AS category,
             COALESCE(pc.colour, c.colour) AS colour,
             COALESCE(pc.is_income, c.is_income, t.amount_cents > 0) AS is_income,
             c.id AS sub_id, CASE WHEN pc.id IS NULL THEN NULL ELSE c.name END AS sub_category,
             ${label} AS month,
             SUM(t.amount_cents) AS amount_cents
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN categories pc ON pc.id = c.parent_id
      JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL AND ${IN_PNL()}
        AND t.date >= $1 AND t.date <= $2
        ${accountFilter}
        ${includeArchived === 'true' ? '' : 'AND NOT a.archived'}
      GROUP BY 1,2,3,4,5,6,7 ORDER BY 4 DESC, 2, 6`, params)
    return r.rows
  })

  // Net worth: assets (standard accounts + manual assets) vs liabilities (credit
  // card + mortgage accounts + manual liabilities), sampled across a chosen window.
  // Balances are computed from transactions at each sampled date, so the history is
  // exact rather than dependent on snapshots having been taken.
  app.get('/networth', async (req) => {
    const includeArchived = req.query.includeArchived === 'true' || req.query.archived === 'true'
    const range = (RANGES[req.query.range] || req.query.range === 'All') ? req.query.range : '1M'
    const notArchived = includeArchived ? '' : 'AND NOT a.archived'
    const notArchivedH = includeArchived ? '' : 'WHERE NOT h.archived'

    const bounds = await q(`
      SELECT LEAST(
        COALESCE((SELECT MIN(opening_date) FROM accounts), CURRENT_DATE),
        COALESCE((SELECT MIN(date) FROM transactions WHERE deleted_at IS NULL), CURRENT_DATE),
        COALESCE((SELECT MIN(as_of) FROM holding_values), CURRENT_DATE))::text AS earliest,
        CURRENT_DATE::text AS today`)
    const today = bounds.rows[0].today
    const earliest = bounds.rows[0].earliest
    const win = rangeWindow(range, today, earliest)
    const dates = sampleDates(win.from, win.to)

    // One pass per sampled date: every class of thing summed as at that date.
    // Debts are stored negative, so they are negated into a positive "owing".
    const seriesRows = await q(`
      SELECT d.date::text AS date,
        COALESCE((SELECT SUM(a.opening_balance_cents + COALESCE((
            SELECT SUM(t.amount_cents) FROM transactions t
            WHERE t.account_id = a.id AND t.deleted_at IS NULL AND t.date <= d.date), 0))
          FROM accounts a WHERE a.type = 'standard' ${notArchived}), 0) AS cash_cents,
        COALESCE((SELECT SUM(-(a.opening_balance_cents + COALESCE((
            SELECT SUM(t.amount_cents) FROM transactions t
            WHERE t.account_id = a.id AND t.deleted_at IS NULL AND t.date <= d.date), 0)))
          FROM accounts a WHERE a.type <> 'standard' ${notArchived}), 0) AS debt_cents,
        COALESCE((SELECT SUM(v.value_cents) FROM holdings h
          LEFT JOIN LATERAL (SELECT COALESCE(
            (SELECT value_cents FROM holding_values hv
             WHERE hv.holding_id = h.id AND hv.as_of <= d.date ORDER BY hv.as_of DESC LIMIT 1),
            -- Before its first valuation, a holding is carried at that first value.
            -- You owned the house last month too; the day you typed it in is not a
            -- day your net worth rose by the price of a house.
            (SELECT value_cents FROM holding_values hv
             WHERE hv.holding_id = h.id ORDER BY hv.as_of ASC LIMIT 1)) AS value_cents) v ON TRUE
          WHERE h.side = 'asset' ${includeArchived ? '' : 'AND NOT h.archived'}), 0) AS manual_asset_cents,
        COALESCE((SELECT SUM(v.value_cents) FROM holdings h
          LEFT JOIN LATERAL (SELECT COALESCE(
            (SELECT value_cents FROM holding_values hv
             WHERE hv.holding_id = h.id AND hv.as_of <= d.date ORDER BY hv.as_of DESC LIMIT 1),
            -- Before its first valuation, a holding is carried at that first value.
            -- You owned the house last month too; the day you typed it in is not a
            -- day your net worth rose by the price of a house.
            (SELECT value_cents FROM holding_values hv
             WHERE hv.holding_id = h.id ORDER BY hv.as_of ASC LIMIT 1)) AS value_cents) v ON TRUE
          WHERE h.side = 'liability' ${includeArchived ? '' : 'AND NOT h.archived'}), 0) AS manual_liability_cents
      FROM unnest($1::date[]) AS d(date) ORDER BY d.date`, [dates])

    const snapshots = toSnapshots(seriesRows.rows)

    // Per-account rows for the two lists. The 30-day change is always 30 days,
    // independent of the chart range — it is the column header's promise.
    const accountRows = await q(`
      SELECT a.id, a.name, a.type, a.archived, ${BALANCE_SQL},
        a.opening_balance_cents + COALESCE((
          SELECT SUM(t.amount_cents) FROM transactions t
          WHERE t.account_id = a.id AND t.deleted_at IS NULL
            AND t.date <= CURRENT_DATE - INTERVAL '30 days'), 0) AS balance_30d_ago_cents
      FROM accounts a WHERE TRUE ${notArchived} ORDER BY a.type, a.name`)

    const holdingRows = await q(`
      SELECT h.id, h.name, h.side, h.kind, h.archived, v.value_cents, v.as_of,
        (SELECT value_cents FROM holding_values hv
         WHERE hv.holding_id = h.id AND hv.as_of <= CURRENT_DATE - INTERVAL '30 days'
         ORDER BY hv.as_of DESC LIMIT 1) AS value_30d_ago_cents
      FROM holdings h
      LEFT JOIN LATERAL (SELECT value_cents, as_of FROM holding_values
        WHERE holding_id = h.id ORDER BY as_of DESC LIMIT 1) v ON TRUE
      ${notArchivedH} ORDER BY h.side, h.name`)

    const accounts = [
      ...accountRows.rows.map(a => {
        const isDebt = a.type !== 'standard'
        const bal = Number(a.balance_cents)
        const prev = Number(a.balance_30d_ago_cents)
        return {
          id: a.id, name: a.name, kind: 'account', type: a.type,
          side: isDebt ? 'liability' : 'asset',
          // Both lists show positive magnitudes; the side carries the direction
          balance_cents: isDebt ? -bal : bal,
          change30d_cents: (isDebt ? -bal : bal) - (isDebt ? -prev : prev),
          valued_at: null, archived: a.archived,
        }
      }),
      ...holdingRows.rows.map(h => {
        const val = Number(h.value_cents ?? 0)
        // A holding with no earlier valuation has not "changed" — it was simply not
        // valued before, which is not a movement worth colouring.
        const prev = h.value_30d_ago_cents == null ? null : Number(h.value_30d_ago_cents)
        return {
          id: h.id, name: h.name, kind: 'holding', type: h.kind,
          side: h.side, balance_cents: val,
          change30d_cents: prev == null ? null : val - prev,
          valued_at: h.as_of, archived: h.archived,
        }
      }),
    ]

    const last = snapshots.at(-1) || { assets_cents: 0, liabilities_cents: 0, net_cents: 0, cash_cents: 0, property_cents: 0 }
    return {
      range, includeArchived, window: win, today, earliest,
      snapshots, movement: buildMovement(snapshots), accounts,
      gridlines: gridlines(snapshots.map(s => s.net_cents)),
      totals: {
        assets_cents: last.assets_cents, liabilities_cents: last.liabilities_cents,
        net_cents: last.net_cents, cash_cents: last.cash_cents, property_cents: last.property_cents,
      },
    }
  })

  app.get('/audit', async (req) => {
    const params = []
    const where = []
    if (req.query.entity) { params.push(req.query.entity); where.push(`entity_type = $${params.length}`) }
    if (req.query.from) { params.push(req.query.from); where.push(`created_at >= $${params.length}`) }
    if (req.query.to) { params.push(req.query.to); where.push(`created_at <= $${params.length}::date + 1`) }
    const r = await q(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`, params)
    return r.rows
  })
}
