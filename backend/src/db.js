import pg from 'pg'
import { randomUUID } from 'node:crypto'

// DATE columns come back as plain 'YYYY-MM-DD' strings — a JS Date at local midnight
// shifts a day when serialized to UTC ISO in JSON.
pg.types.setTypeParser(1082, v => v)

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
export const q = (text, params) => pool.query(text, params)
export const uuid = randomUUID

// Run fn inside a single transaction; fn receives a query function bound to the client.
export async function tx(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn((text, params) => client.query(text, params))
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function audit(action, entityType, entityId, previous, next) {
  await q(
    'INSERT INTO audit_log (id, action, entity_type, entity_id, previous, next) VALUES ($1,$2,$3,$4,$5,$6)',
    [uuid(), action, entityType, entityId, previous ? JSON.stringify(previous) : null, next ? JSON.stringify(next) : null]
  )
}

export async function getSetting(key) {
  const r = await q('SELECT value FROM settings WHERE key=$1', [key])
  return r.rows[0]?.value ?? null
}

export async function setSetting(key, value) {
  await q('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value])
}

// Rows written before the vendor column existed (or by an older release) get their
// display name filled in once, on startup.
export async function backfillVendors() {
  const { vendorFrom } = await import('./services/vendor.js')
  let total = 0
  for (;;) {
    const r = await q('SELECT id, payee FROM transactions WHERE vendor IS NULL LIMIT 2000')
    if (!r.rows.length) break
    await q(
      `UPDATE transactions t SET vendor = u.vendor
       FROM unnest($1::uuid[], $2::text[]) AS u(id, vendor) WHERE t.id = u.id`,
      [r.rows.map(x => x.id), r.rows.map(x => vendorFrom(x.payee))])
    total += r.rows.length
    if (r.rows.length < 2000) break
  }
  return total
}

// Housekeeping per spec: hard-delete after 30d, audit kept 12mo, dismissed alerts kept 30d, undo 24h.
export async function cleanup() {
  // A surviving transfer leg may still reference a transaction about to be purged —
  // clear those links first or the self-referencing FK aborts the delete.
  await q(`UPDATE transactions SET linked_transaction_id = NULL
           WHERE linked_transaction_id IN (SELECT id FROM transactions WHERE deleted_at < now() - interval '30 days')`)
  await q(`DELETE FROM transactions WHERE deleted_at < now() - interval '30 days'`)
  await q(`DELETE FROM audit_log WHERE created_at < now() - interval '12 months'`)
  await q(`DELETE FROM alerts WHERE dismissed_at < now() - interval '30 days'`)
  await q(`DELETE FROM undo_history WHERE created_at < now() - interval '24 hours'`)
}
