import assert from 'node:assert/strict'
import { classifyRows, candidateWindow } from '../src/services/dedupe.js'

const row = (line, date, payee, amount, vendor = payee) => ({ line, date, payee, amount, vendor, valid: true })
const stored = (id, date, payee, amount_cents, vendor = payee) => ({ id, date, payee, vendor, amount_cents })

// Re-importing an overlapping month: every row already there is held back
{
  const v = classifyRows(
    [row(1, '2026-07-01', 'SUPERMART ONLINE', -12345), row(2, '2026-07-08', 'FUEL DEPOT', -8700)],
    [stored('a', '2026-07-01', 'SUPERMART ONLINE', -12345), stored('b', '2026-07-08', 'FUEL DEPOT', -8700)])
  assert.equal(v.get(1).status, 'duplicate')
  assert.equal(v.get(2).status, 'duplicate')
  assert.equal(v.get(1).match.id, 'a')
  assert.equal(v.get(1).match.date, '2026-07-01')
}

// One stored coffee, two genuine ones in the file: only ONE row is held back
{
  const v = classifyRows(
    [row(1, '2026-07-01', 'CAFE X', -500), row(2, '2026-07-01', 'CAFE X', -500)],
    [stored('a', '2026-07-01', 'CAFE X', -500)])
  assert.equal(v.get(1).status, 'duplicate')
  assert.equal(v.get(2), undefined, 'second genuine purchase must stay importable')
}

// The same transaction listed twice in one file inserts once
{
  const v = classifyRows(
    [row(1, '2026-07-01', 'CAFE X', -500), row(2, '2026-07-01', 'CAFE X', -500)], [])
  assert.equal(v.get(1), undefined)
  assert.equal(v.get(2).status, 'duplicate')
  assert.equal(v.get(2).match.source, 'file')
  assert.match(v.get(2).reason, /appears earlier in this file/)
}

// Description reworded between exports — caught on vendor + amount + date
{
  const v = classifyRows(
    [row(1, '2026-07-01', 'DIRECT DEBIT FUEL DEPOT', -8700, 'Fuel Depot')],
    [stored('a', '2026-07-01', 'EFTPOS FUEL DEPOT 0442', -8700, 'Fuel Depot')])
  assert.equal(v.get(1).status, 'duplicate')
  assert.match(v.get(1).reason, /description differs/)
}

// Bank appended a reference number this time — caught on the shared prefix
{
  const v = classifyRows(
    [row(1, '2026-07-08', 'EFTPOS FUEL DEPOT 0442 RIVERTON REF 99812', -8700, 'Fuel Depot Riverton Ref')],
    [stored('a', '2026-07-08', 'EFTPOS FUEL DEPOT 0442 RIVERTON', -8700, 'Fuel Depot Riverton')])
  assert.equal(v.get(1).status, 'duplicate')
  assert.match(v.get(1).reason, /extra text/)
}

// A short shared opening is not enough to call it the same transaction
{
  const v = classifyRows(
    [row(1, '2026-07-08', 'BPAY WATER', -8700, 'Water')],
    [stored('a', '2026-07-08', 'BPAY WATER CORP LAKESIDE', -8700, 'Water Corp Lakeside')])
  assert.equal(v.get(1), undefined)
}

// Case and padding changes are not a new transaction
{
  const v = classifyRows(
    [row(1, '2026-07-01', 'supermart   online', -12345)],
    [stored('a', '2026-07-01', 'SUPERMART ONLINE', -12345)])
  assert.equal(v.get(1).status, 'duplicate')
}

// A repeat on another date is a real transaction, however identical the wording
{
  for (const d of ['2026-07-02', '2026-07-15', '2026-06-30']) {
    assert.equal(classifyRows([row(1, d, 'SUPERMART ONLINE', -12345)],
      [stored('a', '2026-07-01', 'SUPERMART ONLINE', -12345)]).size, 0, `${d} must not match 2026-07-01`)
  }
}

// A different amount on the same day is not a match either
{
  assert.equal(classifyRows([row(1, '2026-07-01', 'SUPERMART ONLINE', -12344)],
    [stored('a', '2026-07-01', 'SUPERMART ONLINE', -12345)]).size, 0)
}

// Only the same-day candidate is eligible, whatever else is nearby
{
  const v = classifyRows(
    [row(1, '2026-07-05', 'CAFE X', -500)],
    [stored('a', '2026-07-01', 'CAFE X', -500), stored('b', '2026-07-05', 'CAFE X', -500)])
  assert.equal(v.get(1).match.id, 'b')
  assert.equal(v.get(1).status, 'duplicate')
}

// A fuzzy description on another date is nothing at all
{
  const v = classifyRows(
    [row(1, '2026-07-10', 'DIRECT DEBIT FUEL DEPOT', -8700, 'Fuel Depot')],
    [stored('a', '2026-07-08', 'EFTPOS FUEL DEPOT 0442', -8700, 'Fuel Depot')])
  assert.equal(v.get(1), undefined)
}

assert.deepEqual(candidateWindow([row(1, '2026-07-08', 'A', -1), row(2, '2026-07-01', 'B', -2)]),
  { from: '2026-07-01', to: '2026-07-08' })
assert.equal(candidateWindow([]), null)

console.log('dedupe.test.js: all assertions passed')
