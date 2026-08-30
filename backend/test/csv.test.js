import assert from 'node:assert'
import { parseCsv, parseDate, parseAmount, detectHeader, mapRows, transferFragment } from '../src/services/csv.js'

// Format A: no header row, quoted signed amount, CRLF line endings, transfer fragments
const signed = '15/06/2026,"-174.90",SUPERMART 0088 NORTHFIELD\r\n16/06/2026,"2500.00",SALARY ACME PTY LTD\r\n17/06/2026,"-500.00",FUNDS TFER TRANSFER TO 999888777666555\r\n'
let rows = parseCsv(signed)
assert.equal(rows.length, 3)
assert.equal(detectHeader(rows), false)
let mapped = mapRows(rows, { dateCol: 0, amountCol: 1, payeeCol: 2 }, false)
assert.deepEqual(mapped[0], { line: 1, date: '2026-06-15', payee: 'SUPERMART 0088 NORTHFIELD', amount: -17490, valid: true })
assert.equal(mapped[1].amount, 250000)
assert.equal(transferFragment(mapped[2].payee), '999888777666555')
assert.equal(transferFragment('FUNDS TFER TRANSFER FROM 777666555'), '777666555')
assert.equal(transferFragment('SUPERMART'), null)

// Format B: header row, separate Debit/Credit columns, trailing comma
const debitCredit = 'Date,Description,Debit,Credit,\r\n01/06/2026,GROCERCO 0099,45.20,,\r\n05/06/2026,Payment - BPAY,,300.00,\r\n'
rows = parseCsv(debitCredit)
assert.equal(detectHeader(rows), true)
mapped = mapRows(rows, { dateCol: 0, payeeCol: 1, debitCol: 2, creditCol: 3 }, true)
assert.equal(mapped[0].amount, -4520) // Debit → negative (owed increases)
assert.equal(mapped[1].amount, 30000) // Credit → positive (payment)
assert.equal(mapped[0].valid, true)

// Invalid rows flagged
mapped = mapRows(parseCsv('banana,,x\n'), { dateCol: 0, amountCol: 1, payeeCol: 2 }, false)
assert.equal(mapped[0].valid, false)

// Edge cases
assert.equal(parseDate('31/12/2025'), '2025-12-31')
assert.equal(parseDate('2025-12-31'), null)
assert.equal(parseAmount('"1,234.56"'), 123456)
assert.equal(parseAmount(''), null)
assert.equal(parseCsv('a,"b ""quoted"", c",d')[0][1], 'b "quoted", c')

console.log('csv.test.js: all assertions passed')
