// Duplicate detection for CSV import. Pure functions — no DB access — so the
// pairing rules can be tested directly (test/dedupe.test.js).
//
// A duplicate is same account, same date, same amount. Different dates are never
// a match: banks re-export the same day's rows verbatim, so a date that moved
// means a different transaction, and a genuine repeat purchase must import.
//
// Every candidate (an already-stored transaction, or an earlier row of the same
// file) is consumed by at most ONE csv row. Without that, two genuine $5.00
// coffees on the same day would both match the single stored one and both get
// discarded.

// Compare descriptions ignoring case, punctuation and padding — banks are not
// byte-stable between exports. The stored payee itself is never rewritten.
const norm = s => (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()

// A bank that appends a reference number to the same transaction between exports
// leaves one description a prefix of the other. 12 chars keeps "PAYMENT" and other
// generic openings from colliding.
const PREFIX_MIN = 12
const samePrefix = (a, b) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= PREFIX_MIN && long.startsWith(short)
}

// Ordered strongest first — only the description varies, the date and amount must
// match exactly for any of them to apply.
const TIERS = [
  { match: (row, c) => c.payeeKey === norm(row.payee), reason: 'already imported' },
  { match: (row, c) => !!c.vendorKey && c.vendorKey === norm(row.vendor), reason: 'same merchant, amount and date — description differs' },
  { match: (row, c) => samePrefix(c.payeeKey, norm(row.payee)), reason: 'same amount and date — description has extra text this time' },
]

function tierFor(row, cand) {
  if (row.amount !== cand.amount || row.date !== cand.date) return null
  return TIERS.find(t => t.match(row, cand)) ?? null
}

/**
 * @param rows     parsed csv rows: { line, date, payee, amount, valid } plus a derived `vendor`
 * @param existing stored transactions: { id, date, payee, vendor, amount_cents }
 * @returns Map of line → { status, reason, match } for every matched row
 */
export function classifyRows(rows, existing) {
  const pool = existing.map(t => ({
    amount: Number(t.amount_cents), date: t.date, payee: t.payee, vendor: t.vendor,
    payeeKey: norm(t.payee), vendorKey: norm(t.vendor),
    used: false, source: 'existing', id: t.id,
  }))
  const out = new Map()
  for (const row of rows) {
    if (!row.valid) continue
    // Same date and amount makes candidates interchangeable, so the first unused
    // one that matches on any tier is as good as any other.
    let hit = null
    for (const c of pool) {
      const tier = c.used ? null : tierFor(row, c)
      if (tier) { hit = { cand: c, tier }; break }
    }
    if (hit) {
      const { cand, tier } = hit
      cand.used = true
      out.set(row.line, {
        status: 'duplicate',
        reason: cand.source === 'file' ? 'the same transaction appears earlier in this file' : tier.reason,
        match: {
          source: cand.source, id: cand.id, line: cand.line,
          date: cand.date, payee: cand.payee, amount_cents: cand.amount,
        },
      })
      continue
    }
    // A row that will be imported becomes a candidate for later rows, so a file
    // containing the same transaction twice doesn't insert it twice.
    pool.push({
      amount: row.amount, date: row.date, payee: row.payee, vendor: row.vendor,
      payeeKey: norm(row.payee), vendorKey: norm(row.vendor),
      used: false, source: 'file', line: row.line,
    })
  }
  return out
}

// The date window the import needs to load candidates from, given the csv's own span
export function candidateWindow(rows) {
  const dates = rows.filter(r => r.valid).map(r => r.date).sort()
  return dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null
}
