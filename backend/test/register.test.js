import assert from 'node:assert/strict'
import { withRunningBalance, windowTotals, sortForRegister } from '../src/services/register.js'

const tx = (id, date, cents, created_at = '') => ({ id, date, amount_cents: cents, created_at })

// The balance is anchored to what came before the window, not to zero
{
  const rows = withRunningBalance([tx('a', '2026-08-02', -1000), tx('b', '2026-08-03', 2500)], 10000)
  assert.deepEqual(rows.map(r => r.balance_cents), [9000, 11500])
}

// Rows arriving out of order still produce a monotonic date sequence
{
  const rows = withRunningBalance([tx('b', '2026-08-03', 2500), tx('a', '2026-08-02', -1000)], 0)
  assert.deepEqual(rows.map(r => r.id), ['a', 'b'])
  assert.deepEqual(rows.map(r => r.balance_cents), [-1000, 1500])
}

// Same-day rows must land in the same order every time, or the balance column
// shuffles between page loads and nothing reconciles twice
{
  const same = [tx('z', '2026-08-02', -500, '2026-08-02T09:00:00Z'), tx('a', '2026-08-02', -700, '2026-08-02T08:00:00Z')]
  const first = sortForRegister(same).map(r => r.id)
  const second = sortForRegister([...same].reverse()).map(r => r.id)
  assert.deepEqual(first, ['a', 'z'], 'earlier created_at comes first')
  assert.deepEqual(first, second, 'order is independent of input order')
}

// Ties on date AND created_at still resolve, rather than falling back to input order
{
  const rows = sortForRegister([tx('b', '2026-08-02', -100), tx('a', '2026-08-02', -100)])
  assert.deepEqual(rows.map(r => r.id), ['a', 'b'])
}

// A zero-amount row must not be dropped — it still occupies a line on the statement
{
  const rows = withRunningBalance([tx('a', '2026-08-02', 0)], 5000)
  assert.deepEqual(rows.map(r => r.balance_cents), [5000])
}

// Closing balance is opening plus the net of the window
{
  const opening = 250000
  const rows = withRunningBalance([tx('a', '2026-08-01', -12345), tx('b', '2026-08-09', 50000), tx('c', '2026-08-20', -7)], opening)
  const totals = windowTotals(rows)
  assert.equal(totals.in_cents, 50000)
  assert.equal(totals.out_cents, 12352)
  assert.equal(totals.count, 3)
  assert.equal(rows.at(-1).balance_cents, opening + totals.in_cents - totals.out_cents)
}

// Credit cards carry a negative balance; the arithmetic must not special-case sign
{
  const rows = withRunningBalance([tx('a', '2026-08-02', -5000), tx('b', '2026-08-15', 20000)], -150000)
  assert.deepEqual(rows.map(r => r.balance_cents), [-155000, -135000])
}

console.log('register.test.js: all assertions passed')
