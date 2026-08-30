// Net worth over time. Balances are derivable at any date from opening balance +
// transactions, so history is COMPUTED rather than stored — there is no snapshot
// table to have gaps in, and a range tab can ask for any window.

export const RANGES = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365 }

const iso = d => d.toISOString().slice(0, 10)
const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return iso(d)
}
export const daysBetween = (a, b) =>
  Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000)

// `earliest` bounds 'All' and also stops a 1Y window reaching back before the data
// starts — a chart with a year of flat zero says nothing about the last month.
export function rangeWindow(range, today, earliest) {
  const days = RANGES[range]
  const from = days ? addDays(today, -days) : (earliest || addDays(today, -30))
  return { from: earliest && from < earliest ? earliest : from, to: today }
}

// Evenly spaced dates across the window, always including both ends. Capped so a
// five-year window doesn't ask the database for eighteen hundred balance sums.
export function sampleDates(from, to, maxPoints = 14) {
  const span = daysBetween(from, to)
  if (span <= 0) return [to]
  const step = Math.max(1, Math.ceil(span / (maxPoints - 1)))
  const dates = []
  for (let d = 0; d < span; d += step) dates.push(addDays(from, d))
  dates.push(to)
  return dates
}

const num = v => Number(v ?? 0)

// One snapshot per sampled date. Assets and liabilities are both positive
// magnitudes; net is the difference.
export function toSnapshots(rows) {
  return rows.map(r => {
    const assets = num(r.cash_cents) + num(r.manual_asset_cents)
    const liabilities = num(r.debt_cents) + num(r.manual_liability_cents)
    return {
      date: r.date,
      assets_cents: assets,
      liabilities_cents: liabilities,
      net_cents: assets - liabilities,
      cash_cents: num(r.cash_cents),
      property_cents: num(r.manual_asset_cents),
      debt_cents: liabilities,
    }
  })
}

// Why net worth moved, split by class. `amount_cents` is the literal change in that
// class's own figure — a loan paid down reads −$1,132, because that is what the loan
// balance did. `effect_cents` is its contribution to net worth, which for a debt is
// the opposite sign. The EFFECTS are what sum to the headline; showing the literal
// amount with the effect's colour is the whole point of the footer.
export function buildMovement(snapshots) {
  const first = snapshots[0], last = snapshots.at(-1)
  if (!first || !last || snapshots.length < 2) return null
  const part = (label, key, isLiability) => {
    const amount = last[key] - first[key]
    return { label, amount_cents: amount, effect_cents: isLiability ? -amount : amount }
  }
  const parts = [
    part('cash', 'cash_cents', false),
    part('property', 'property_cents', false),
    part('loan principal', 'debt_cents', true),
  ].filter(p => p.amount_cents !== 0)

  const total = last.net_cents - first.net_cents
  const summed = parts.reduce((n, p) => n + p.effect_cents, 0)
  // A footer whose parts disagree with the headline is worse than no footer. If the
  // two ever diverge the difference is surfaced rather than quietly swallowed.
  if (summed !== total) parts.push({ label: 'other', amount_cents: total - summed, effect_cents: total - summed })

  return { from: first.date, to: last.date, total_cents: total, parts }
}

// Round gridline values inside the data's own range. A net-worth axis anchored at
// zero would render every real month as a flat line.
export function gridlines(values, count = 3) {
  const lo = Math.min(...values), hi = Math.max(...values)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
  if (hi === lo) return [hi]
  const mag = Math.pow(10, Math.floor(Math.log10((hi - lo) / count)))
  // Try a spread of nice steps and keep whichever actually lands closest to `count`
  // lines. Rounding the ideal step up to the next nice number can overshoot the
  // whole range on a narrow domain and leave a single lonely gridline.
  let best = null
  for (const m of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10]) {
    const step = m * mag
    if (step <= 0) continue
    const lines = []
    for (let v = Math.ceil(lo / step) * step; v <= hi && lines.length < 40; v += step) lines.push(Math.round(v))
    if (lines.length < 2) continue
    const score = Math.abs(lines.length - count)
    if (!best || score < best.score) best = { score, lines }
  }
  return best ? best.lines : [Math.round((lo + hi) / 2)]
}
