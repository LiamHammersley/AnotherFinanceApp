import assert from 'node:assert/strict'
import { windowFor, monthBounds, elapsed, status, perMonth, goalNeedPerMonth, windowLabel } from '../src/services/budget.js'

// Month windows, including a leap February
assert.deepEqual(monthBounds('2026-08'), { from: '2026-08-01', to: '2026-08-31' })
assert.deepEqual(monthBounds('2026-02'), { from: '2026-02-01', to: '2026-02-28' })
assert.deepEqual(monthBounds('2028-02'), { from: '2028-02-01', to: '2028-02-29' })

// Quarters
{
  const q = windowFor('quarterly', '2026-08')
  assert.deepEqual({ from: q.from, to: q.to, label: q.label }, { from: '2026-07-01', to: '2026-09-30', label: 'Q3' })
  assert.equal(windowFor('quarterly', '2026-01').from, '2026-01-01')
  assert.equal(windowFor('quarterly', '2026-12').to, '2026-12-31')
}

// Yearly means the Australian financial year, so July starts a new one
{
  const jul = windowFor('yearly', '2026-07')
  assert.deepEqual({ from: jul.from, to: jul.to }, { from: '2026-07-01', to: '2027-06-30' })
  const jun = windowFor('yearly', '2026-06')
  assert.deepEqual({ from: jun.from, to: jun.to }, { from: '2025-07-01', to: '2026-06-30' })
  assert.equal(jul.label, 'FY 2026–27')
}

// Pace through a window
{
  const aug = windowFor('monthly', '2026-08')
  assert.equal(elapsed(aug, '2026-07-31'), 0, 'not started')
  assert.equal(elapsed(aug, '2026-09-05'), 1, 'finished')
  assert.equal(Math.round(elapsed(aug, '2026-08-31') * 100), 100, 'last day is fully elapsed')
  assert.equal(Math.round(elapsed(aug, '2026-08-15') * 100), 48)
  assert.equal(Math.round(elapsed(aug, '2026-08-01') * 100), 3, 'day one is 1/31')
}

// Status
{
  assert.equal(status(0, null, 0.5), 'none', 'no target set')
  assert.equal(status(5000, 10000, 0.5), 'on_track', 'half spent, half the month gone')
  assert.equal(status(9000, 10000, 0.3), 'ahead', 'burning it faster than the calendar')
  assert.equal(status(10001, 10000, 0.3), 'over')
  assert.equal(status(9000, 10000, 1), 'on_track', 'under target at period end is fine, not "ahead"')
  // A zero target means "spend nothing here"
  assert.equal(status(0, 0, 0.5), 'on_track')
  assert.equal(status(1, 0, 0.5), 'over')
}

// Monthly equivalents drive the "budgeted per month" headline
assert.equal(perMonth(30000, 'monthly'), 30000)
assert.equal(perMonth(30000, 'quarterly'), 10000)
assert.equal(perMonth(90000, 'yearly'), 7500)
assert.equal(perMonth(null, 'monthly'), null)

// A goal's monthly cost — the figure the plan's verdict is measured against
{
  // $5,000 by 28 Feb 2027, from 5 Aug 2026 = 7 months inclusive
  assert.equal(goalNeedPerMonth({ target_cents: 500000, by_date: '2027-02-28' }, '2026-08-05'), 71429)
  // Due this month still needs the whole amount, never a divide-by-zero
  assert.equal(goalNeedPerMonth({ target_cents: 120000, by_date: '2026-08-31' }, '2026-08-05'), 120000)
  // A date already past doesn't invert the sign
  assert.equal(goalNeedPerMonth({ target_cents: 120000, by_date: '2026-06-30' }, '2026-08-05'), 120000)
  // Goals without a number or a date have no monthly cost, and that's fine
  assert.equal(goalNeedPerMonth({ target_cents: null, by_date: '2027-01-01' }), null)
  assert.equal(goalNeedPerMonth({ target_cents: 100000, by_date: null }), null)

  // Money already in a linked account counts toward the goal — the whole point of
  // linking one. $5,000 by Feb 2027 with $4,292 already saved is $101/mo, not $714.
  assert.equal(goalNeedPerMonth({ target_cents: 500000, by_date: '2027-02-28' }, '2026-08-05', 429244), 10108)
  // Already met needs nothing more, and never goes negative
  assert.equal(goalNeedPerMonth({ target_cents: 500000, by_date: '2027-02-28' }, '2026-08-05', 600000), 0)
  // A negative balance (an overdrawn account) can't count as progress
  assert.equal(goalNeedPerMonth({ target_cents: 700000, by_date: '2027-02-28' }, '2026-08-05', -20000), 100000)

  // Money wanted ON the 1st can't be saved during that month: 5 Aug to 1 Jan is
  // five saving months (Aug-Dec), not six. $5,000 is $1,000/mo, not $833.
  assert.equal(goalNeedPerMonth({ target_cents: 500000, by_date: '2027-01-01' }, '2026-08-05'), 100000)
  // Late in the deadline month it still counts, because there is time left in it
  assert.equal(goalNeedPerMonth({ target_cents: 500000, by_date: '2027-01-31' }, '2026-08-05'), 83333)
}

// An average is never shown without saying what window it covers
assert.equal(windowLabel([]), null)
assert.equal(windowLabel(['2026-07']), 'Jul')
assert.equal(windowLabel(['2026-06', '2026-07']), 'Jun–Jul')
assert.equal(windowLabel(['2026-07', '2026-02', '2026-06']), 'Feb–Jul')

console.log('budget.test.js: all assertions passed')
