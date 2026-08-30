// The search box quietly changes meaning depending on what you type, so the
// parsers decide it once, here, rather than in SQL.
import assert from 'node:assert'
import { parseAmountTerm, parseDateTerm } from '../src/services/search.js'

const amount = (term, expected, why) =>
  assert.deepEqual(parseAmountTerm(term), expected, `${why}: ${JSON.stringify(term)} → ${JSON.stringify(parseAmountTerm(term))}`)

// Explicit cents means exactly that amount
amount('124.53', { min: 12453, max: 12453 }, 'exact amount')
amount('$1,234.56', { min: 123456, max: 123456 }, 'currency formatting stripped')
amount('0.99', { min: 99, max: 99 }, 'sub-dollar')

// A bare dollar figure covers that whole dollar — typing 124 should find $124.53
amount('124', { min: 12400, max: 12499 }, 'whole dollars')
amount('0', { min: 0, max: 99 }, 'zero dollars')

// Comparisons, inclusive in both directions
amount('>500', { min: 50000, max: null }, 'greater than')
amount('>=500', { min: 50000, max: null }, 'at least')
amount('<20', { min: null, max: 2000 }, 'less than')
amount('<=20', { min: null, max: 2000 }, 'at most')

// Ranges, order-insensitive
amount('100-200', { min: 10000, max: 20000 }, 'range')
amount('200-100', { min: 10000, max: 20000 }, 'reversed range normalised')

// Sign is ignored: money in and money out search the same way
amount('-45.30', { min: 4530, max: 4530 }, 'negative reads as its magnitude')

// Anything else is a text search, not an amount
for (const t of ['', 'SUPERMART', 'FUEL 0119', '12.345', 'abc', '>', '10-']) {
  assert.equal(parseAmountTerm(t), null, `should not parse as an amount: ${JSON.stringify(t)}`)
}

// Dates: as displayed (dd/mm/yyyy) and as stored (yyyy-mm-dd)
assert.equal(parseDateTerm('28/07/2026'), '2026-07-28')
assert.equal(parseDateTerm('5/7/2026'), '2026-07-05', 'unpadded input still resolves')
assert.equal(parseDateTerm('2026-07-28'), '2026-07-28')
assert.equal(parseDateTerm('32/07/2026'), null, 'impossible day rejected')
assert.equal(parseDateTerm('28/13/2026'), null, 'impossible month rejected')
assert.equal(parseDateTerm('SUPERMART'), null)

// A 4-digit year is also a valid dollar amount — both clauses apply, which only
// ever widens the result set, never hides a match.
assert.deepEqual(parseAmountTerm('2026'), { min: 202600, max: 202699 })

console.log('search.test.js: all assertions passed')
