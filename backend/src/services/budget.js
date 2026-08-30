// Budget period maths — pure functions, so the window and pacing rules are
// testable without a database (test/budget.test.js).
//
// Every budget is compared over its OWN window: a monthly target against the
// month, a yearly target against the financial year containing it. That keeps
// lumpy annual costs (rego, insurance) honest — paying $900 of rego in July is
// not "900% over budget", it's the year's allowance spent early.

export const PERIODS = ['monthly', 'quarterly', 'yearly']

// How many of this period fit in a year — used for the monthly-equivalent totals
export const PER_YEAR = { monthly: 12, quarterly: 4, yearly: 1 }

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// 'YYYY-MM' → the first and last day of that month
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number)
  return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }
}

// The window a budget of this period is measured over, for a given month.
// Yearly means the Australian financial year (1 Jul – 30 Jun), matching the P&L.
export function windowFor(period, month) {
  const [y, m] = month.split('-').map(Number)
  if (period === 'quarterly') {
    const startMonth = Math.floor((m - 1) / 3) * 3
    return { from: iso(new Date(y, startMonth, 1)), to: iso(new Date(y, startMonth + 3, 0)), label: `Q${Math.floor((m - 1) / 3) + 1}` }
  }
  if (period === 'yearly') {
    const startYear = m >= 7 ? y : y - 1
    return { from: `${startYear}-07-01`, to: `${startYear + 1}-06-30`, label: `FY ${startYear}–${String((startYear + 1) % 100).padStart(2, '0')}` }
  }
  return { ...monthBounds(month), label: 'month' }
}

// How far through the window we are, as of `today` — the pace marker on the bar.
// A window entirely in the past is complete; one entirely ahead hasn't started.
export function elapsed(window, today) {
  const start = Date.parse(window.from), end = Date.parse(window.to), now = Date.parse(today)
  if (now >= end) return 1
  if (now < start) return 0
  // +1 day so the last day of the window counts as fully elapsed
  return (now - start + 86400000) / (end - start + 86400000)
}

// The status a row reports, and the colour the UI paints it.
// For an income category the target is something to REACH, so the polarity flips:
// passing it is good, and falling behind the calendar is what deserves a warning.
export function status(spentCents, targetCents, elapsedFraction, isIncome = false) {
  if (targetCents == null) return 'none'
  if (isIncome) {
    if (targetCents === 0) return 'on_track'
    if (spentCents >= targetCents) return 'met'
    // Only flag a shortfall once enough of the window has run to mean anything
    return elapsedFraction > 0.5 && spentCents < targetCents * (elapsedFraction - 0.1) ? 'behind' : 'on_track'
  }
  if (targetCents === 0) return spentCents > 0 ? 'over' : 'on_track'
  const used = spentCents / targetCents
  if (used > 1) return 'over'
  // Ahead of where the calendar says you should be, with the window still running
  if (elapsedFraction < 1 && used > elapsedFraction + 0.1) return 'ahead'
  return 'on_track'
}

// Monthly-equivalent of a target, for the "budgeted per month" headline
export const perMonth = (amountCents, period) =>
  amountCents == null ? null : Math.round((amountCents * PER_YEAR[period]) / 12)

// A goal's monthly cost: what's left to put aside, spread over the months up to its
// date (inclusive, minimum one). This is the number the plan's verdict reconciles
// against, so it is computed here rather than anywhere a model can reach.
export function goalNeedPerMonth(goal, today = new Date().toISOString().slice(0, 10), currentCents = 0) {
  const target = goal.target_cents == null ? null : Number(goal.target_cents)
  if (!target || !goal.by_date) return null
  // Money already set aside counts: solve for what's left, not the whole target.
  // A goal that's already met needs nothing more.
  const amount = Math.max(0, target - Math.max(0, Number(currentCents) || 0))
  if (amount === 0) return 0
  const due = String(goal.by_date).slice(0, 10)
  const [ty, tm, td] = today.split('-').map(Number)
  const [dy, dm, dd] = due.split('-').map(Number)
  // The deadline month only counts if the due date falls on or after today's day
  // of the month. Money wanted ON 1 January can't be saved during January.
  const months = Math.max(1, (dy - ty) * 12 + (dm - tm) + (dd >= td ? 1 : 0))
  return Math.round(amount / months)
}

// "Jun–Jul" / "Feb–Jul 2026" — the window an average was taken over, so a reference
// number is never shown without saying what it covers.
export function windowLabel(months) {
  const sorted = [...new Set(months)].sort()
  if (!sorted.length) return null
  const name = ym => new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1).toLocaleDateString('en-AU', { month: 'short' })
  return sorted.length === 1 ? name(sorted[0]) : `${name(sorted[0])}–${name(sorted[sorted.length - 1])}`
}
