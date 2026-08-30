import { q, uuid, audit } from '../db.js'
import { transferFragment } from '../services/csv.js'
import { vendorFrom } from '../services/vendor.js'
import { parseAmountTerm, parseDateTerm } from '../services/search.js'

// Sorting by payee uses the cleaned vendor name — the column the list actually shows.
// COALESCE covers rows the startup backfill hasn't reached yet.
const SORTABLE = { date: 't.date', amount: 't.amount_cents', payee: 'COALESCE(t.vendor, t.payee)', category: 'c.name' }
const TYPES = ['income', 'expense', 'transfer', 'adjustment', 'interest', 'excluded']
// Types that are real money movement but not income or spending — kept out of the
// money-in/money-out views the same way transfers are.
const NOT_PNL = "('transfer','excluded')"

export default async function (app) {
  // View-tab predicates ("Needs a category" / "AI-assigned" / "Transfers"). Counts for
  // the tab strip are computed over the base filters, independent of the active view.
  const VIEWS = {
    uncat: "t.category_id IS NULL AND t.type IN ('income','expense')",
    ai: "t.assign_source = 'ai'",
    transfers: "t.type = 'transfer'",
  }

  app.get('/transactions', async (req) => {
    const params = []
    const where = ['t.deleted_at IS NULL']
    const qs = req.query
    const add = (sql, val) => { params.push(val); where.push(sql.replaceAll('?', `$${params.length}`)) }
    if (qs.account) add('t.account_id = ?', qs.account)
    if (qs.category) add('(t.category_id = ? OR c.parent_id = ?)', qs.category)
    if (qs.type) add('t.type = ?', qs.type)
    if (qs.direction === 'out') where.push(`t.amount_cents < 0 AND t.type NOT IN ${NOT_PNL}`)
    if (qs.direction === 'in') where.push(`t.amount_cents > 0 AND t.type NOT IN ${NOT_PNL}`)
    if (qs.direction === 'transfers') where.push("t.type = 'transfer'")
    if (qs.from) add('t.date >= ?', qs.from)
    if (qs.to) add('t.date <= ?', qs.to)
    if (qs.reviewed === 'true') where.push('t.reviewed')
    if (qs.reviewed === 'false') where.push('NOT t.reviewed')
    if (qs.ai === 'true') where.push(VIEWS.ai)
    if (qs.uncategorised === 'true') where.push(VIEWS.uncat)
    if (qs.import) add('t.import_id = ?', qs.import)
    if (qs.search) {
      // Text always searches payee/vendor/notes/category. A term that reads as an
      // amount ("124.53", "124", ">500", "100-200") or a date also matches those.
      const term = String(qs.search).trim()
      const clauses = ["t.payee ILIKE '%'||?||'%'", "t.vendor ILIKE '%'||?||'%'",
        "t.notes ILIKE '%'||?||'%'", "c.name ILIKE '%'||?||'%'"]
      params.push(term)
      const textIdx = params.length

      const amount = parseAmountTerm(term)
      if (amount) {
        const bounds = []
        if (amount.min != null) { params.push(amount.min); bounds.push(`abs(t.amount_cents) >= $${params.length}`) }
        if (amount.max != null) { params.push(amount.max); bounds.push(`abs(t.amount_cents) <= $${params.length}`) }
        if (bounds.length) clauses.push(`(${bounds.join(' AND ')})`)
      }
      const isoDate = parseDateTerm(term)
      if (isoDate) { params.push(isoDate); clauses.push(`t.date = $${params.length}::date`) }

      where.push('(' + clauses.map(c => c.replaceAll('?', `$${textIdx}`)).join(' OR ') + ')')
    }
    const joins = `FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN categories pc ON pc.id = c.parent_id
      JOIN accounts a ON a.id = t.account_id`
    const counts = await q(`
      SELECT count(*)::int AS all_n,
             count(*) FILTER (WHERE ${VIEWS.uncat})::int AS uncat,
             count(*) FILTER (WHERE ${VIEWS.ai})::int AS ai,
             count(*) FILTER (WHERE ${VIEWS.transfers})::int AS transfers
      ${joins} WHERE ${where.join(' AND ')}`, params)
    if (VIEWS[qs.view]) where.push(VIEWS[qs.view])
    const sort = SORTABLE[qs.sort] || 't.date'
    const dir = qs.dir === 'asc' ? 'ASC' : 'DESC'
    const pageSize = Math.min(+qs.pageSize || 50, 200)
    const page = Math.max(+qs.page || 1, 1)
    const base = `${joins} WHERE ${where.join(' AND ')}`
    const count = await q(`SELECT count(*)::int AS n ${base}`, params)
    const rows = await q(
      `SELECT t.*, c.name AS category_name, pc.name AS parent_category_name, a.name AS account_name, a.type AS account_type
       ${base} ORDER BY ${sort} ${dir}, t.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)
    const c0 = counts.rows[0]
    return {
      total: count.rows[0].n, page, pageSize, rows: rows.rows,
      counts: { all: c0.all_n, uncat: c0.uncat, ai: c0.ai, transfers: c0.transfers },
    }
  })

  app.post('/transactions', async (req, reply) => {
    const { accountId, date, payee, amountCents, type, categoryId = null, notes = null } = req.body || {}
    if (!accountId || !date || !payee || amountCents == null || !type) return reply.code(400).send({ error: 'accountId, date, payee, amountCents, type required' })
    const id = uuid()
    const r = await q(
      `INSERT INTO transactions (id, account_id, date, payee, vendor, amount_cents, type, category_id, notes, assign_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual') RETURNING *`,
      [id, accountId, date, payee, vendorFrom(payee), amountCents, type, categoryId, notes])
    await audit('create', 'transaction', id, null, r.rows[0])
    return r.rows[0]
  })

  app.patch('/transactions/:id', async (req, reply) => {
    const prev = (await q('SELECT * FROM transactions WHERE id = $1 AND deleted_at IS NULL', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    const b = req.body || {}
    // Confirm keeps the AI attribution (+confidence); dismiss clears the suggestion
    if (b.confirmSuggestion && prev.assign_source?.startsWith('ai_suggested:')) {
      const catId = prev.assign_source.slice('ai_suggested:'.length)
      const r = await q(`UPDATE transactions SET category_id=$1, assign_source='ai', updated_at=now() WHERE id=$2 RETURNING *`, [catId, req.params.id])
      await audit('update', 'transaction', req.params.id, prev, r.rows[0])
      return r.rows[0]
    }
    if (b.dismissSuggestion) {
      const r = await q(`UPDATE transactions SET assign_source=NULL, ai_confidence=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id])
      return r.rows[0]
    }
    // Validate what the edit dialog can change — this is a trust boundary
    if ('date' in b && !/^\d{4}-\d{2}-\d{2}$/.test(b.date || ''))
      return reply.code(400).send({ error: 'date must be YYYY-MM-DD' })
    if ('payee' in b && !String(b.payee || '').trim())
      return reply.code(400).send({ error: 'payee cannot be empty' })
    if ('amountCents' in b && !Number.isInteger(b.amountCents))
      return reply.code(400).send({ error: 'amountCents must be a whole number of cents' })
    if ('type' in b && !TYPES.includes(b.type))
      return reply.code(400).send({ error: `type must be one of: ${TYPES.join(', ')}` })
    if ('accountId' in b && b.accountId !== prev.account_id) {
      const acct = await q('SELECT 1 FROM accounts WHERE id = $1', [b.accountId])
      if (!acct.rows.length) return reply.code(400).send({ error: 'Unknown account' })
    }

    const next = {
      date: b.date ?? prev.date, payee: (b.payee ?? prev.payee).trim(),
      account_id: b.accountId ?? prev.account_id,
      amount_cents: b.amountCents ?? prev.amount_cents, type: b.type ?? prev.type,
      category_id: 'categoryId' in b ? b.categoryId : prev.category_id,
      notes: 'notes' in b ? b.notes : prev.notes, reviewed: b.reviewed ?? prev.reviewed,
      assign_source: 'categoryId' in b && b.categoryId !== prev.category_id ? 'manual' : prev.assign_source,
    }
    // The two legs of a linked transfer mirror each other, so an amount or account
    // change on one side would silently desync the pair — require an unlink first.
    if (prev.linked_transaction_id && next.type === 'transfer' &&
        (String(next.amount_cents) !== String(prev.amount_cents) || next.account_id !== prev.account_id)) {
      return reply.code(400).send({
        error: 'This is one leg of a linked transfer — unlink it before changing the amount or account.',
      })
    }
    // Transfers are a linked pair: changing one leg's type away from 'transfer' would
    // orphan the other, so break the link on both sides instead.
    if (prev.linked_transaction_id && next.type !== 'transfer') {
      await q(`UPDATE transactions SET linked_transaction_id = NULL, transfer_group = NULL,
               type = CASE WHEN amount_cents >= 0 THEN 'income' ELSE 'expense' END, updated_at = now()
               WHERE id = $1`, [prev.linked_transaction_id])
      await q('UPDATE transactions SET linked_transaction_id = NULL, transfer_group = NULL WHERE id = $1', [req.params.id])
    }
    const r = await q(
      `UPDATE transactions SET date=$1, payee=$2, vendor=$3, account_id=$4, amount_cents=$5, type=$6,
       category_id=$7, notes=$8, reviewed=$9, assign_source=$10, updated_at=now()
       WHERE id=$11 RETURNING *`,
      [next.date, next.payee, vendorFrom(next.payee), next.account_id, next.amount_cents, next.type,
       next.category_id, next.notes, next.reviewed, next.assign_source, req.params.id])
    await audit('update', 'transaction', req.params.id, prev, r.rows[0])
    // Learning from corrections: overriding an AI category prompts a rule (spec 7.3)
    const suggestRule = prev.assign_source === 'ai' && 'categoryId' in b && b.categoryId !== prev.category_id
    return { ...r.rows[0], suggest_rule: suggestRule }
  })

  app.delete('/transactions/:id', async (req, reply) => {
    const prev = (await q('SELECT * FROM transactions WHERE id = $1 AND deleted_at IS NULL', [req.params.id])).rows[0]
    if (!prev) return reply.code(404).send({ error: 'Not found' })
    await q('UPDATE transactions SET deleted_at = now() WHERE id = $1', [req.params.id]) // soft delete, 30-day window
    await audit('delete', 'transaction', req.params.id, prev, null)
    return { ok: true }
  })

  // Soft-deleted rows are recoverable for 30 days (spec 5.2), then cleanup() purges them
  app.get('/transactions/deleted', async () => {
    const r = await q(`
      SELECT t.id, t.date, t.payee, t.vendor, t.amount_cents, t.type, t.deleted_at,
             30 - EXTRACT(DAY FROM now() - t.deleted_at)::int AS days_left,
             c.name AS category_name, a.name AS account_name
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC LIMIT 200`)
    return r.rows
  })

  app.post('/transactions/:id/restore', async (req, reply) => {
    const r = await q('UPDATE transactions SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *',
      [req.params.id])
    if (!r.rows[0]) return reply.code(404).send({ error: 'Not found, or not deleted' })
    await audit('restore', 'transaction', req.params.id, null, r.rows[0])
    return { ok: true }
  })

  // Bulk actions: reassign category, delete, mark reviewed, link as transfer,
  // exclude from / include in the P&L. All undoable.
  app.post('/transactions/bulk', async (req, reply) => {
    const { ids, action, categoryId } = req.body || {}
    if (!Array.isArray(ids) || !ids.length) return reply.code(400).send({ error: 'ids required' })
    const prev = (await q('SELECT * FROM transactions WHERE id = ANY($1) AND deleted_at IS NULL', [ids])).rows
    if (!prev.length) return reply.code(404).send({ error: 'No matching transactions' })
    const undoId = uuid()
    let description
    let undoRows = prev // actions that touch rows beyond the selection widen this
    if (action === 'category') {
      // Categorising a transfer means "this isn't a transfer" — a category alone
      // would be invisible (the row still renders as a transfer) and ignored by the
      // P&L, which excludes transfers. So convert those rows to a real income/expense
      // and break the pair; the other leg comes back as an uncategorised expense too.
      const transfers = prev.filter(t => t.type === 'transfer')
      const partnerIds = transfers.map(t => t.linked_transaction_id).filter(id => id && !ids.includes(id))
      const partners = partnerIds.length
        ? (await q('SELECT * FROM transactions WHERE id = ANY($1) AND deleted_at IS NULL', [partnerIds])).rows
        : []
      undoRows = [...prev, ...partners] // undo must be able to restore the links too

      await q(`UPDATE transactions SET category_id = $1, assign_source = 'manual',
               type = CASE WHEN type = 'transfer' THEN (CASE WHEN amount_cents >= 0 THEN 'income' ELSE 'expense' END) ELSE type END,
               linked_transaction_id = NULL, transfer_group = NULL, updated_at = now()
               WHERE id = ANY($2)`, [categoryId, ids])
      if (partners.length) {
        // The other leg is only unlinked, never converted. Turning a mortgage
        // repayment landing in the loan account into "income" would inflate the
        // P&L; left as an (unmatched) transfer it stays out of the P&L, keeps
        // affecting the account balance, and is flagged for the user to resolve.
        await q(`UPDATE transactions SET linked_transaction_id = NULL, transfer_group = NULL, updated_at = now()
                 WHERE id = ANY($1)`, [partners.map(p => p.id)])
      }
      description = `Reassigned category on ${prev.length} transaction${prev.length === 1 ? '' : 's'}`
      if (transfers.length) {
        description += ` (${transfers.length} converted from transfer${transfers.length === 1 ? '' : 's'}`
          + (partners.length ? `, ${partners.length} matching leg${partners.length === 1 ? '' : 's'} unlinked` : '') + ')'
      }
    } else if (action === 'delete') {
      await q('UPDATE transactions SET deleted_at = now() WHERE id = ANY($1)', [ids])
      description = `Deleted ${prev.length} transactions`
    } else if (action === 'exclude' || action === 'include') {
      // Excluding drops the category and breaks any transfer link — the row is no
      // longer classified at all. Including reverts to income/expense by sign.
      const partnerIds = prev.map(t => t.linked_transaction_id).filter(id => id && !ids.includes(id))
      if (partnerIds.length) {
        undoRows = [...prev, ...(await q('SELECT * FROM transactions WHERE id = ANY($1)', [partnerIds])).rows]
        await q('UPDATE transactions SET linked_transaction_id = NULL, transfer_group = NULL, updated_at = now() WHERE id = ANY($1)', [partnerIds])
      }
      await q(`UPDATE transactions SET
                 type = ${action === 'exclude' ? "'excluded'" : "CASE WHEN amount_cents >= 0 THEN 'income' ELSE 'expense' END"},
                 ${action === 'exclude' ? 'category_id = NULL, assign_source = NULL,' : ''}
                 linked_transaction_id = NULL, transfer_group = NULL, updated_at = now()
               WHERE id = ANY($1)`, [ids])
      description = action === 'exclude'
        ? `Excluded ${prev.length} transaction${prev.length === 1 ? '' : 's'} from the P&L`
        : `Returned ${prev.length} transaction${prev.length === 1 ? '' : 's'} to the P&L`
    } else if (action === 'accept_suggestions') {
      // Each row carries its OWN suggested category in assign_source, so this can't
      // be one UPDATE with a single categoryId — the category is per row.
      const pending = prev.filter(t => t.assign_source?.startsWith('ai_suggested:'))
      if (!pending.length) return reply.code(400).send({ error: 'None of those have a pending suggestion' })
      undoRows = pending
      await q(`UPDATE transactions AS t SET
                 category_id = split_part(t.assign_source, ':', 2)::uuid,
                 assign_source = 'ai', updated_at = now()
               WHERE t.id = ANY($1) AND t.assign_source LIKE 'ai_suggested:%'`, [pending.map(t => t.id)])
      description = `Accepted ${pending.length} AI suggestion${pending.length === 1 ? '' : 's'}`
    } else if (action === 'dismiss_suggestions') {
      const pending = prev.filter(t => t.assign_source?.startsWith('ai_suggested:'))
      if (!pending.length) return reply.code(400).send({ error: 'None of those have a pending suggestion' })
      undoRows = pending
      await q(`UPDATE transactions SET assign_source = NULL, ai_confidence = NULL, updated_at = now()
               WHERE id = ANY($1)`, [pending.map(t => t.id)])
      description = `Dismissed ${pending.length} AI suggestion${pending.length === 1 ? '' : 's'}`
    } else if (action === 'reviewed') {
      await q('UPDATE transactions SET reviewed = TRUE, updated_at = now() WHERE id = ANY($1)', [ids])
      description = `Marked ${prev.length} transactions reviewed`
    } else if (action === 'link_transfer') {
      if (prev.length !== 2) return reply.code(400).send({ error: 'Select exactly 2 transactions to link as a transfer' })
      const group = uuid()
      const [x, y] = prev
      await q(`UPDATE transactions SET type='transfer', category_id=NULL, linked_transaction_id=$1, transfer_group=$2, updated_at=now() WHERE id=$3`, [y.id, group, x.id])
      await q(`UPDATE transactions SET type='transfer', category_id=NULL, linked_transaction_id=$1, transfer_group=$2, updated_at=now() WHERE id=$3`, [x.id, group, y.id])
      description = 'Linked 2 transactions as a transfer'
    } else return reply.code(400).send({ error: 'Unknown action' })
    await q('INSERT INTO undo_history (id, action, description, payload) VALUES ($1,$2,$3,$4)',
      [undoId, action, description, JSON.stringify({ rows: undoRows })])
    await audit('bulk_' + action, 'transaction', null, { ids }, { action, categoryId })
    return { ok: true, count: prev.length, undoId, description }
  })

  app.post('/undo/:id', async (req, reply) => {
    const r = await q('SELECT * FROM undo_history WHERE id = $1 AND NOT undone AND created_at > now() - interval \'24 hours\'', [req.params.id])
    const entry = r.rows[0]
    if (!entry) return reply.code(404).send({ error: 'Undo entry expired or already undone' })
    for (const t of entry.payload.rows) {
      await q(
        `UPDATE transactions SET type=$1, category_id=$2, reviewed=$3, assign_source=$4,
         linked_transaction_id=$5, transfer_group=$6, vendor=$7, deleted_at=NULL, updated_at=now() WHERE id=$8`,
        [t.type, t.category_id, t.reviewed, t.assign_source, t.linked_transaction_id, t.transfer_group,
         t.vendor, t.id])
    }
    await q('UPDATE undo_history SET undone = TRUE WHERE id = $1', [req.params.id])
    return { ok: true, restored: entry.payload.rows.length }
  })

  // Transfer suggestions: same amount, opposite direction, within 3 days, across accounts.
  // TO/FROM account-number fragments in the description strengthen confidence. A categorised leg is
  // a decision already made — it's spending or income, not an internal transfer — so
  // a pair is only suggested while both legs are still uncategorised.
  app.get('/transfers/suggestions', async () => {
    const r = await q(`
      SELECT o.id AS out_id, o.date AS out_date, o.payee AS out_payee, o.amount_cents, o.account_id AS out_account,
             i.id AS in_id, i.date AS in_date, i.payee AS in_payee, i.account_id AS in_account,
             oa.name AS out_account_name, ia.name AS in_account_name
      FROM transactions o
      JOIN transactions i ON i.amount_cents = -o.amount_cents
        AND i.account_id <> o.account_id
        AND abs(i.date - o.date) <= 3
        AND i.deleted_at IS NULL AND i.linked_transaction_id IS NULL AND i.type NOT IN ('adjustment','excluded')
        AND i.category_id IS NULL
      JOIN accounts oa ON oa.id = o.account_id
      JOIN accounts ia ON ia.id = i.account_id
      WHERE o.deleted_at IS NULL AND o.linked_transaction_id IS NULL
        AND o.amount_cents < 0 AND o.type NOT IN ('adjustment','excluded')
        AND o.category_id IS NULL
      ORDER BY o.date DESC LIMIT 50`)
    return r.rows.map(s => ({
      ...s,
      confidence: (transferFragment(s.out_payee) || transferFragment(s.in_payee)) ? 'high' : 'medium',
    }))
  })

  app.post('/transfers/unlink', async (req, reply) => {
    const t = (await q('SELECT * FROM transactions WHERE id = $1', [req.body?.id])).rows[0]
    if (!t?.linked_transaction_id) return reply.code(400).send({ error: 'Not a linked transfer' })
    // Both legs revert to unmatched income/expense pending categorisation
    for (const [id, amt] of [[t.id, t.amount_cents], [t.linked_transaction_id, -t.amount_cents]]) {
      await q(`UPDATE transactions SET linked_transaction_id=NULL, transfer_group=NULL,
               type = CASE WHEN $2::bigint >= 0 THEN 'income' ELSE 'expense' END, updated_at=now() WHERE id=$1`, [id, amt])
    }
    await audit('unlink_transfer', 'transaction', t.id, t, null)
    return { ok: true }
  })

  app.get('/undo', async () => {
    const r = await q("SELECT id, action, description, undone, created_at FROM undo_history WHERE created_at > now() - interval '24 hours' ORDER BY created_at DESC")
    return r.rows
  })
}
