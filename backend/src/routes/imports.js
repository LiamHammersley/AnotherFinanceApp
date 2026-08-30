import { q, uuid, audit, tx } from '../db.js'
import { parseCsv, detectHeader, mapRows } from '../services/csv.js'
import { vendorFrom } from '../services/vendor.js'
import { candidateWindow, classifyRows } from '../services/dedupe.js'
import { loadRules, ruleEffects } from './rules.js'
import { matchRule } from '../services/rules.js'

// Loads every stored transaction that could pair with a row of this file — same
// account, an amount the file contains, inside the file's own date span — then
// lets the pure classifier do the pairing. A match needs the same date, so the
// span needs no padding.
async function findDuplicates(accountId, rows) {
  const valid = rows.filter(r => r.valid)
  const span = candidateWindow(valid)
  if (!span) return new Map()
  const r = await q(
    `SELECT id, date, payee, vendor, amount_cents FROM transactions
     WHERE account_id = $1 AND deleted_at IS NULL
       AND amount_cents = ANY($2::bigint[])
       AND date BETWEEN $3 AND $4`,
    [accountId, [...new Set(valid.map(x => x.amount))], span.from, span.to])
  return classifyRows(valid, r.rows)
}

export default async function (app) {
  // Body: { accountId, content, mapping? } — mapping falls back to the account's saved one.
  app.post('/imports/preview', async (req, reply) => {
    const { accountId, content, mapping } = req.body || {}
    const account = (await q('SELECT * FROM accounts WHERE id = $1', [accountId])).rows[0]
    if (!account || !content) return reply.code(400).send({ error: 'accountId and content required' })
    const rows = parseCsv(content)
    const hasHeader = detectHeader(rows)
    const effectiveMapping = mapping || account.csv_mapping
    if (!effectiveMapping) {
      // First import for this account: return raw columns so the UI can offer the mapping step
      return { needsMapping: true, hasHeader, header: hasHeader ? rows[0] : null, sample: rows.slice(0, 6) }
    }
    // vendor is derived up front — the classifier uses it to catch a re-import
    // whose description the bank has reworded since last time
    const mapped = mapRows(rows, effectiveMapping, hasHeader)
      .map(r => ({ ...r, vendor: r.payee ? vendorFrom(r.payee) : '' }))
    const verdicts = await findDuplicates(accountId, mapped)
    return {
      needsMapping: false, hasHeader, mapping: effectiveMapping,
      rows: mapped.map(r => ({
        ...r, status: r.valid ? verdicts.get(r.line)?.status ?? 'new' : 'invalid',
        reason: verdicts.get(r.line)?.reason, match: verdicts.get(r.line)?.match,
      })),
    }
  })

  // Body: { accountId, filename, content, mapping, includeLines: number[] } —
  // includeLines are the row lines the user ticked (duplicates are pre-unchecked client-side).
  app.post('/imports/commit', async (req, reply) => {
    const { accountId, filename, content, mapping, includeLines } = req.body || {}
    const account = (await q('SELECT * FROM accounts WHERE id = $1', [accountId])).rows[0]
    if (!account || !content || !mapping) return reply.code(400).send({ error: 'accountId, content, mapping required' })
    const rows = parseCsv(content)
    const mapped = mapRows(rows, mapping, detectHeader(rows))
    const include = new Set(includeLines || [])
    const importId = uuid()
    const toInsert = mapped.filter(r => r.valid && include.has(r.line))
    const duplicates = mapped.filter(r => r.valid && !include.has(r.line)).length
    const rules = await loadRules()
    const records = toInsert.map(row => {
      const isInterest = /interest/i.test(row.payee) && account.type !== 'standard'
      const rule = matchRule(rules, { payee: row.payee, amount_cents: row.amount, account_id: accountId })
      const fx = rule ? ruleEffects(rule) : null
      return {
        id: uuid(), date: row.date, payee: row.payee,
        // A rule's rename only replaces the derived display name, never the payee
        vendor: fx?.vendor || vendorFrom(row.payee), amount: row.amount,
        type: isInterest ? 'interest' : row.amount >= 0 ? 'income' : 'expense',
        categoryId: fx?.categoryId ?? null, source: fx?.categoryId ? fx.source : null,
      }
    })
    // Atomic: the import row and its transactions land together or not at all
    await tx(async (cq) => {
      await cq('INSERT INTO imports (id, account_id, filename, row_count, duplicates_discarded, new_count) VALUES ($1,$2,$3,$4,$5,$6)',
        [importId, accountId, filename || 'import.csv', mapped.length, duplicates, records.length])
      if (records.length) await cq(
        `INSERT INTO transactions (id, account_id, date, payee, vendor, amount_cents, type, category_id, assign_source, import_id)
         SELECT u.id, $1, u.date, u.payee, u.vendor, u.amount, u.type, u.category_id, u.assign_source, $2
         FROM unnest($3::uuid[], $4::date[], $5::text[], $6::text[], $7::bigint[], $8::text[], $9::uuid[], $10::text[])
           AS u(id, date, payee, vendor, amount, type, category_id, assign_source)`,
        [accountId, importId, records.map(r => r.id), records.map(r => r.date), records.map(r => r.payee),
         records.map(r => r.vendor), records.map(r => r.amount), records.map(r => r.type),
         records.map(r => r.categoryId), records.map(r => r.source)])
    })
    const inserted = records.length
    await q('UPDATE accounts SET csv_mapping = $1 WHERE id = $2', [JSON.stringify(mapping), accountId]) // reused next import
    await q('INSERT INTO alerts (id, type, message, dedupe_key) VALUES ($1,$2,$3,$4)',
      [uuid(), 'import_complete', `Import of ${filename || 'CSV'} into ${account.name} finished: ${inserted} new, ${duplicates} duplicates discarded.`, `import:${importId}`])
    await audit('import', 'import', importId, null, { filename, inserted, duplicates })
    return { importId, inserted, duplicates }
  })

  app.get('/imports', async () => {
    const r = await q(`SELECT i.*, a.name AS account_name FROM imports i JOIN accounts a ON a.id = i.account_id ORDER BY i.created_at DESC LIMIT 100`)
    return r.rows
  })

  app.post('/imports/:id/rollback', async (req, reply) => {
    const imp = (await q('SELECT * FROM imports WHERE id = $1 AND NOT rolled_back', [req.params.id])).rows[0]
    if (!imp) return reply.code(404).send({ error: 'Import not found or already rolled back' })
    // Soft-delete: restorable within 30 days like any other delete
    await q('UPDATE transactions SET deleted_at = now() WHERE import_id = $1 AND deleted_at IS NULL', [req.params.id])
    await q('UPDATE imports SET rolled_back = TRUE WHERE id = $1', [req.params.id])
    await audit('rollback', 'import', req.params.id, imp, null)
    return { ok: true }
  })

  app.post('/imports/:id/restore', async (req, reply) => {
    const imp = (await q('SELECT * FROM imports WHERE id = $1 AND rolled_back', [req.params.id])).rows[0]
    if (!imp) return reply.code(404).send({ error: 'Import not rolled back' })
    await q('UPDATE transactions SET deleted_at = NULL WHERE import_id = $1', [req.params.id])
    await q('UPDATE imports SET rolled_back = FALSE WHERE id = $1', [req.params.id])
    return { ok: true }
  })
}
