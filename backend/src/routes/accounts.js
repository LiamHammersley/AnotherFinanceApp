import { q, uuid, audit } from '../db.js'
import { withRunningBalance, windowTotals } from '../services/register.js'

// Balance is never stored — computed from opening balance + sum of live transactions.
export const BALANCE_SQL = `
  a.opening_balance_cents + COALESCE((
    SELECT SUM(t.amount_cents) FROM transactions t
    WHERE t.account_id = a.id AND t.deleted_at IS NULL
  ), 0) AS balance_cents`

// The lowest the balance ever fell over a window — the money that is genuinely
// never spent, as opposed to float passing through. For a working account (bills
// in, bills out) the current balance says more about where you are in the billing
// cycle than about what you have put aside.
export async function accountFloors(accountIds, months = 3) {
  if (!accountIds?.length) return new Map()
  const r = await q(`
    WITH tx AS (
      SELECT account_id, date, SUM(amount_cents) AS cents
      FROM transactions
      WHERE account_id = ANY($1) AND deleted_at IS NULL
      GROUP BY account_id, date
    ),
    -- Balance as it stood entering the window: everything before it still counts
    opening AS (
      SELECT a.id AS account_id,
             a.opening_balance_cents
               + COALESCE((SELECT SUM(cents) FROM tx WHERE tx.account_id = a.id
                           AND tx.date < (CURRENT_DATE - make_interval(months => $2))), 0) AS bal
      FROM accounts a WHERE a.id = ANY($1)
    ),
    run AS (
      SELECT tx.account_id,
             o.bal + SUM(tx.cents) OVER (PARTITION BY tx.account_id ORDER BY tx.date) AS bal
      FROM tx JOIN opening o ON o.account_id = tx.account_id
      WHERE tx.date >= CURRENT_DATE - make_interval(months => $2)
    )
    SELECT o.account_id,
           LEAST(o.bal, COALESCE((SELECT MIN(bal) FROM run WHERE run.account_id = o.account_id), o.bal)) AS floor_cents,
           o.bal AS window_start_cents
    FROM opening o`, [accountIds, months])
  return new Map(r.rows.map(x => [x.account_id, Number(x.floor_cents)]))
}

export default async function (app) {
  app.get('/accounts', async (req) => {
    const includeArchived = req.query.archived === 'true'
    const r = await q(
      `SELECT a.*, ${BALANCE_SQL} FROM accounts a ${includeArchived ? '' : 'WHERE NOT a.archived'} ORDER BY a.sort_order, a.created_at`)
    return r.rows
  })

  app.post('/accounts', async (req, reply) => {
    const { name, type, openingBalanceCents = 0, openingDate, colour, icon } = req.body || {}
    if (!name || !['standard', 'credit_card', 'mortgage'].includes(type) || !openingDate)
      return reply.code(400).send({ error: 'name, type and openingDate are required' })
    // Liability accounts: user enters the amount owed as a positive number; stored negative
    // so balance arithmetic is uniform (payments are positive rows, charges negative).
    const opening = type === 'standard' ? openingBalanceCents : -Math.abs(openingBalanceCents)
    const id = uuid()
    // New accounts land at the end of the dashboard row
    const pos = (await q('SELECT COALESCE(MAX(sort_order),-1)+1 AS p FROM accounts')).rows[0].p
    const r = await q(
      `INSERT INTO accounts (id, name, type, opening_balance_cents, opening_date, colour, icon, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, name, type, opening, openingDate, colour || '#2563eb', icon || 'bank', pos])
    await audit('create', 'account', id, null, r.rows[0])
    return r.rows[0]
  })

  // Drag reorder on the dashboard: client sends the full ordered id list
  app.post('/accounts/reorder', async (req, reply) => {
    const { ids } = req.body || {}
    if (!Array.isArray(ids)) return reply.code(400).send({ error: 'ids required' })
    await q(`UPDATE accounts a SET sort_order = u.ord - 1
             FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, ord) WHERE a.id = u.id`, [ids])
    return { ok: true }
  })

  app.patch('/accounts/:id', async (req, reply) => {
    const prev = (await q('SELECT * FROM accounts WHERE id = $1', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    const { name = prev.name, colour = prev.colour, icon = prev.icon, archived = prev.archived } = req.body || {}
    const r = await q('UPDATE accounts SET name=$1, colour=$2, icon=$3, archived=$4 WHERE id=$5 RETURNING *',
      [name, colour, icon, archived, req.params.id])
    await audit('update', 'account', req.params.id, prev, r.rows[0])
    return r.rows[0]
  })

  // The register for one account over one statement period: every live transaction
  // in balance order, each with the balance as it stood after it. This is the view
  // you hold next to a bank statement, so nothing is filtered out for being a
  // transfer or an excluded row — the bank counted those too.
  app.get('/accounts/:id/register', async (req, reply) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7)
    const [y, m] = month.split('-').map(Number)
    const from = `${month}-01`
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)

    const acc = await q(`SELECT a.*, ${BALANCE_SQL} FROM accounts a WHERE a.id = $1`, [req.params.id])
    if (!acc.rows[0]) return reply.code(404).send({ error: 'Not found' })
    const account = acc.rows[0]

    // Everything before the window collapses into a single opening figure, so the
    // first row's balance is a real balance rather than a running total from zero.
    const before = await q(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM transactions
       WHERE account_id = $1 AND deleted_at IS NULL AND date < $2`, [req.params.id, from])
    const opening_cents = Number(account.opening_balance_cents) + Number(before.rows[0].cents)

    const r = await q(
      `SELECT t.*, c.name AS category_name, pc.name AS parent_category_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories pc ON pc.id = c.parent_id
       WHERE t.account_id = $1 AND t.deleted_at IS NULL AND t.date BETWEEN $2 AND $3`,
      [req.params.id, from, to])

    const rows = withRunningBalance(r.rows, opening_cents)
    const totals = windowTotals(rows)
    return {
      account: {
        id: account.id, name: account.name, type: account.type, colour: account.colour,
        balance_cents: Number(account.balance_cents),
        opening_date: account.opening_date,
      },
      month, from, to, opening_cents,
      closing_cents: rows.length ? rows.at(-1).balance_cents : opening_cents,
      // Newest first to read like a statement; the balance on each row is still
      // the balance *after* that transaction
      rows: rows.reverse(),
      totals,
    }
  })

  // Balance adjustment: a distinct transaction type reconciling book balance to the bank's.
  app.post('/accounts/:id/adjust', async (req, reply) => {
    const { targetBalanceCents, date } = req.body || {}
    if (targetBalanceCents == null || !date) return reply.code(400).send({ error: 'targetBalanceCents and date required' })
    // As of `date`, not as of today. Reconciling to a statement dated the 31st must
    // not be thrown off by transactions that have landed since — sizing the
    // correction against the current balance would bake those into the adjustment.
    const cur = await q(
      `SELECT a.opening_balance_cents + COALESCE((
         SELECT SUM(t.amount_cents) FROM transactions t
         WHERE t.account_id = a.id AND t.deleted_at IS NULL AND t.date <= $2
       ), 0) AS balance_cents
       FROM accounts a WHERE a.id = $1`, [req.params.id, date])
    if (!cur.rows[0]) return reply.code(404).send({ error: 'Not found' })
    const delta = targetBalanceCents - +cur.rows[0].balance_cents
    if (delta === 0) return { ok: true, adjusted: 0 }
    const id = uuid()
    const r = await q(
      `INSERT INTO transactions (id, account_id, date, payee, amount_cents, type, reviewed, assign_source)
       VALUES ($1,$2,$3,'Balance adjustment',$4,'adjustment',TRUE,'manual') RETURNING *`,
      [id, req.params.id, date, delta])
    await audit('create', 'transaction', id, null, r.rows[0])
    return r.rows[0]
  })
}
