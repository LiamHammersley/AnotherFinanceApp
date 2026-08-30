// Run with: node src/lib/format.test.ts  (node strips the types itself)
import assert from 'node:assert/strict'
import { isZeroCents, signedDollars, wholeDollars } from './format.ts'

// The bug this exists to prevent: a paid-off card rendering as "-$0.00"
assert.equal(signedDollars(0), '$0')
assert.equal(signedDollars(-0), '$0')
assert.equal(signedDollars(-4), '$0', 'rounds to zero, so it IS zero — not "−$0"')
assert.equal(signedDollars(4), '$0')
assert.ok(!signedDollars(-0).includes('−'), 'no minus on zero')
assert.ok(!signedDollars(-49).includes('−'), 'no minus on a value that rounds to zero')

assert.equal(isZeroCents(0), true)
assert.equal(isZeroCents(-0), true)
assert.equal(isZeroCents('0'), true)
assert.equal(isZeroCents(-1), false, 'one cent owing is not paid off')

// Sign and magnitude
assert.equal(signedDollars(153895), '+$1,539')
assert.equal(signedDollars(-113200), '−$1,132')
assert.equal(signedDollars(-113200)[0], '−', 'U+2212 minus, not a hyphen')
assert.equal(wholeDollars(-113200), '$1,132', 'unsigned: the column header carries direction')
assert.equal(wholeDollars(46000000), '$460,000')

console.log('format.test.ts: all assertions passed')
