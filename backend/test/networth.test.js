import assert from 'node:assert/strict'
import { rangeWindow, sampleDates, toSnapshots, buildMovement, gridlines, daysBetween } from '../src/services/networth.js'

// --- window ---
assert.deepEqual(rangeWindow('1M', '2026-08-06', null), { from: '2026-07-07', to: '2026-08-06' })
assert.deepEqual(rangeWindow('1Y', '2026-08-06', null).from, '2025-08-06')
// A window can't reach back past the data — a year of flat zero hides the real month
assert.equal(rangeWindow('1Y', '2026-08-06', '2026-07-01').from, '2026-07-01')
assert.equal(rangeWindow('All', '2026-08-06', '2026-01-15').from, '2026-01-15')
// Crossing a month boundary must not drift; August has 31 days
assert.equal(rangeWindow('1M', '2026-03-01', null).from, '2026-01-30')

// --- sampling ---
{
  const d = sampleDates('2026-07-07', '2026-08-06', 14)
  assert.equal(d[0], '2026-07-07', 'starts at the window start')
  assert.equal(d.at(-1), '2026-08-06', 'always ends at today')
  assert.ok(d.length <= 14, `capped, got ${d.length}`)
  assert.deepEqual([...d].sort(), d, 'ascending')
  assert.equal(new Set(d).size, d.length, 'no duplicate dates')
}
// A five-year window must not ask for 1,800 balance sums
assert.ok(sampleDates('2021-08-06', '2026-08-06', 14).length <= 14)
// Degenerate windows still yield a usable series
assert.deepEqual(sampleDates('2026-08-06', '2026-08-06'), ['2026-08-06'])
assert.equal(sampleDates('2026-08-05', '2026-08-06').length, 2)
assert.equal(daysBetween('2026-07-07', '2026-08-06'), 30)

// --- snapshots ---
{
  const snaps = toSnapshots([
    { date: '2026-07-01', cash_cents: 426900, manual_asset_cents: 46000000, debt_cents: 25319077, manual_liability_cents: 0 },
    { date: '2026-08-06', cash_cents: 467595, manual_asset_cents: 46000000, debt_cents: 25205877, manual_liability_cents: 0 },
  ])
  assert.equal(snaps[1].assets_cents, 46467595)
  assert.equal(snaps[1].liabilities_cents, 25205877)
  assert.equal(snaps[1].net_cents, 46467595 - 25205877)

  // --- movement: the parts' EFFECTS must reconcile with the headline ---
  const m = buildMovement(snaps)
  assert.equal(m.total_cents, snaps[1].net_cents - snaps[0].net_cents)
  assert.equal(m.parts.reduce((n, p) => n + p.effect_cents, 0), m.total_cents,
    'effects sum to the headline delta')

  const loan = m.parts.find(p => p.label === 'loan principal')
  assert.ok(loan.amount_cents < 0, 'the loan balance literally went down')
  assert.ok(loan.effect_cents > 0, 'and that helped net worth')
  assert.equal(loan.effect_cents, -loan.amount_cents)

  const cash = m.parts.find(p => p.label === 'cash')
  assert.equal(cash.amount_cents, cash.effect_cents, 'an asset moves net worth its own way')
  // Property did not move, so it earns no line in the footer
  assert.equal(m.parts.find(p => p.label === 'property'), undefined)
}

// A single snapshot is not a movement — the footer must not invent one
assert.equal(buildMovement([{ date: '2026-08-06', net_cents: 1, cash_cents: 1, property_cents: 0, debt_cents: 0 }]), null)
assert.equal(buildMovement([]), null)

// --- gridlines: fitted to the data, never zero-anchored ---
{
  const g = gridlines([21070000, 21320000])
  assert.ok(g.length >= 2 && g.length <= 5, `sensible count, got ${g.length}`)
  assert.ok(g.every(v => v >= 21070000 && v <= 21320000), 'all inside the data range')
  assert.ok(g[0] > 0, 'not anchored at zero')
  assert.deepEqual([...g].sort((a, b) => a - b), g, 'ascending')
}
// A narrow range is where the naive "round the step up" rule collapses to one
// gridline — the real chart's range is a few thousand dollars on a $212k figure
{
  const g = gridlines([21107823, 21261718])
  assert.ok(g.length >= 2, `narrow range still gets an axis, got ${g.length}`)
  assert.ok(g.every(v => v >= 21107823 && v <= 21261718))
  assert.equal(new Set(g).size, g.length, 'no duplicate gridline values')
}
// A dead-flat series must not divide by zero or loop forever
assert.deepEqual(gridlines([500, 500]), [500])
// Negative net worth is a real state and still needs an axis
assert.ok(gridlines([-500000, -100000]).length >= 2)

console.log('networth.test.js: all assertions passed')
