// Net worth regression: the phantom cliff.
//
// NOT part of `npm test` — it needs a throwaway Postgres, which the app's install
// deliberately doesn't carry. To run it:
//
//   npm i --no-save embedded-postgres
//   node test/networth-db.test.js
//
// It exists because live data broke the chart in a way no pure test could see:
// Reproduces the live data shape that broke the Net worth chart: accounts whose
// transactions predate the day the account was created in the app, and a property
// valued only once, recently. Both used to blink into existence mid-window and read
// as a quarter-million-dollar loss.
import EmbeddedPostgres from 'embedded-postgres'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const pg = new EmbeddedPostgres({ databaseDir: process.env.PGTEST_DIR || './.pgtest', user: 'postgres', password: 'pw', port: 5478, persistent: true })
await pg.start().catch(async () => { await pg.initialise(); await pg.start() })
try { await pg.createDatabase('nwcliff') } catch {}
process.env.DATABASE_URL = 'postgresql://postgres:pw@127.0.0.1:5478/nwcliff'
process.env.SESSION_SECRET = 'x'.repeat(32)

const { q } = await import(`${DIR}/src/db.js`)
await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
for (const f of readdirSync(`${DIR}/migrations`).sort()) {
  const up = readFileSync(`${DIR}/migrations/${f}`, 'utf8').split('-- Down Migration')[0].replace('-- Up Migration', '')
  await q(up)
}

const today = (await q('SELECT CURRENT_DATE::text AS d')).rows[0].d
const ago = n => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }

const acct = async (name, type, openingDate) => {
  const id = crypto.randomUUID()
  await q(`INSERT INTO accounts (id,name,type,opening_balance_cents,opening_date) VALUES ($1,$2,$3,0,$4)`, [id, name, type, openingDate])
  return id
}
const tx = (accountId, date, cents, type = 'expense') =>
  q(`INSERT INTO transactions (id,account_id,date,payee,amount_cents,type) VALUES ($1,$2,$3,'X',$4,$5)`,
    [crypto.randomUUID(), accountId, date, cents, type])

// The account is "opened" 10 days ago but its imported history goes back 80
const cash = await acct('Everyday', 'standard', ago(10))
const loan = await acct('Home Loan', 'mortgage', ago(9))
for (let d = 80; d >= 0; d -= 5) {
  await tx(cash, ago(d), 5000, 'income')
  await tx(loan, ago(d), -1_000_00, 'interest')     // a big, long-standing debt
  await tx(loan, ago(d), 20_00, 'income')
}
// A property entered into the app only today
const hid = crypto.randomUUID()
await q(`INSERT INTO holdings (id,name,side,kind) VALUES ($1,'House','asset','property')`, [hid])
await q(`INSERT INTO holding_values (id,holding_id,as_of,value_cents) VALUES ($1,$2,$3,$4)`,
  [crypto.randomUUID(), hid, today, 460_000_00])

const mod = await import(`${DIR}/src/routes/views.js`)
const routes = []
const rec = m => (path, handler) => routes.push({ m, path, handler })
await mod.default({ get: rec('GET'), post: rec('POST'), patch: rec('PATCH'), put: rec('PUT'), delete: rec('DELETE') })
const handler = routes.find(r => r.m === 'GET' && r.path === '/networth').handler
const res = await handler({ query: { range: '3M' }, params: {}, body: {} }, { code() { return this }, send(b) { return b } })

const nets = res.snapshots.map(s => s.net_cents)
assert.ok(res.snapshots.length >= 5, `expected a real series, got ${res.snapshots.length}`)

// 1. The loan is present in the FIRST snapshot. Before the fix it was absent until
//    its opening_date, then appeared whole.
assert.ok(res.snapshots[0].debt_cents > 0, 'the debt exists at the start of the window')

// 2. The property never arrives as a step — it is carried back at its first value
const props = res.snapshots.map(s => s.property_cents)
assert.equal(new Set(props).size, 1, 'property is flat across the window')
assert.equal(props[0], 460_000_00, 'and carried at its known value from the start')

// 3. No cliff: no single step is anywhere near the size of the house or the loan
const steps = nets.slice(1).map((v, i) => Math.abs(v - nets[i]))
const biggest = Math.max(...steps)
assert.ok(biggest < 100_000_00, `a ${(biggest / 100).toFixed(0)} dollar step is a data artefact, not a movement`)

// 4. The footer still reconciles with the headline
const summed = res.movement.parts.reduce((n, p) => n + p.effect_cents, 0)
assert.equal(summed, res.movement.total_cents, 'movement parts sum to the headline delta')

// 5. The last snapshot equals the totals the cards show
assert.equal(res.snapshots.at(-1).net_cents, res.totals.net_cents)
assert.equal(res.totals.net_cents, res.totals.assets_cents - res.totals.liabilities_cents)

// 6. A window longer than the data clamps to where the data starts, rather than
//    inventing months of zero net worth
const all = await handler({ query: { range: '1Y' }, params: {}, body: {} }, { code() { return this }, send(b) { return b } })
assert.ok(all.snapshots[0].net_cents !== 0, 'no phantom zero-worth history')

console.log('networth-cliff: all assertions passed')
await pg.stop()
