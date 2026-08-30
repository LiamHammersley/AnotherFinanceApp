// Two derived strings, one source: the vendor name shown (and sorted) in the list,
// and the "payee contains" text a rule starts from. The rule text must be a real
// substring of the raw bank description or the rule silently matches nothing.
import assert from 'node:assert'
import { ruleSuggestion, vendorFrom } from '../src/services/vendor.js'

const cases = [
  ['VISA DEBIT PURCHASE CARD 4321 FUEL DEPOT 0119 RIVERTON', 'FUEL DEPOT'],
  ['VISA DEBIT PURCHASE CARD 4321 SUPERMART ONLINE NORTHFIELD', 'SUPERMART'],
  ['EFTPOS DD *QUICKEATS CITYVILLE AU', 'QUICKEATS'],
  ['PAYPAL *PIXEL PLAY 1234567890', 'PIXEL PLAY'],
  ['STREAMCO.COM CITYVILLE AU', 'STREAMCO.COM'],
  ['DIRECT DEBIT EAST BAY WATER RATES', 'EAST BAY WATER'],
  ['EFTPOS THE PET VETS 59 RIVERTON RAU', 'THE PET VETS'],
  ['PAY/SALARY FROM ACMECORP BUSINESS WAGES', 'ACMECORP'],
]

for (const [payee, expected] of cases) {
  const got = ruleSuggestion(payee)
  assert.equal(got, expected, `ruleSuggestion(${JSON.stringify(payee)}) → ${JSON.stringify(got)}`)
}

// The two contracts that matter, across every format including reference-only lines:
// the suggestion must match the transaction it came from, and must never be so short
// that it matches half the file.
const all = [...cases.map(c => c[0]),
  'INTERNET BANKING FUNDS TFER TRANSFER 100200 TO 999888777666555',
  'SQ *CORNER FISH AND CH RIVERTON AU',
  '12345 67890']
for (const payee of all) {
  const got = ruleSuggestion(payee)
  assert.ok(payee.toLowerCase().includes(got.toLowerCase()),
    `suggestion ${JSON.stringify(got)} is not a substring of ${JSON.stringify(payee)}`)
  assert.ok(got.length >= 3, `suggestion ${JSON.stringify(got)} is too broad to be a safe default`)
}
assert.equal(ruleSuggestion(''), '')

// vendorFrom drives both the Payee column and its sort order, so the cleaned name
// must be stable and free of the bank's boilerplate.
const vendors = [
  ['VISA DEBIT PURCHASE CARD 4321 FUEL DEPOT 0442 RIVERTON', 'Fuel Depot Riverton'],
  ['VISA DEBIT PURCHASE CARD 4321 SUPERMART ONLINE NORTHFIELD', 'Supermart Online Northfield'],
  ['EFTPOS DD *QUICKEATS CITYVILLE AU', 'DD *Quickeats Cityville'],
  ['PAY/SALARY FROM ACMECORP BUSINESS WAGES', 'Acmecorp Business Wages'],
  ['STREAMCO.COM CITYVILLE AU', 'Streamco.com Cityville'],
]
for (const [payee, expected] of vendors) {
  assert.equal(vendorFrom(payee), expected, `vendorFrom(${JSON.stringify(payee)}) → ${JSON.stringify(vendorFrom(payee))}`)
}
// Sorting by vendor must not fall back to the raw string's leading boilerplate:
// two cards from different banks should order by merchant, not by "EFTPOS"/"VISA".
const sorted = ['VISA DEBIT PURCHASE CARD 4321 ZEBRA CAFE', 'EFTPOS ALPHA STORE CITYVILLE']
  .map(vendorFrom).sort()
assert.deepEqual(sorted, ['Alpha Store Cityville', 'Zebra Cafe'])

console.log('vendor.test.js: all assertions passed')
