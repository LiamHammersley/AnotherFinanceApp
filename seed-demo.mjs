// Demo data for screenshots. Entirely fictional — invented merchants, invented
// employer, invented balances. Run against a THROWAWAY database only:
//   DATABASE_URL=postgresql://... node seed-demo.mjs
import bcrypt from 'bcryptjs'
import { q, pool } from './backend/src/db.js'
import { vendorFrom } from './backend/src/services/vendor.js'

const uuid = () => crypto.randomUUID()
const iso = d => d.toISOString().slice(0, 10)
const D = (y, m, day) => new Date(Date.UTC(y, m - 1, day))

// ─── reset ────────────────────────────────────────────────────────────────────
await q(`TRUNCATE transactions, imports, budgets, budget_goals, budget_plans,
         holding_values, holdings, recurring, rules, alerts, audit_log,
         undo_history, ai_usage, sessions, users RESTART IDENTITY CASCADE`)
await q(`DELETE FROM accounts`)

// ─── user ─────────────────────────────────────────────────────────────────────
await q('INSERT INTO users (id, username, password_hash) VALUES ($1,$2,$3)',
  [uuid(), 'demo', await bcrypt.hash('demo-password-2026', 12)])

// ─── accounts ─────────────────────────────────────────────────────────────────
const acct = async (name, type, opening, cents, order, colour) => {
  const id = uuid()
  await q(`INSERT INTO accounts (id, name, type, opening_balance_cents, opening_date, colour, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, name, type, cents, opening, colour, order])
  return id
}
const OPEN = '2025-09-01'
const everyday = await acct('Everyday', 'standard', OPEN, 284000, 0, '#2563eb')
const savings = await acct('Savings', 'standard', OPEN, 1240000, 1, '#10b981')
const card = await acct('Credit Card', 'credit_card', OPEN, -96000, 2, '#f43f5e')
const loan = await acct('Home Loan', 'mortgage', OPEN, -38450000, 3, '#6366f1')

// ─── categories ───────────────────────────────────────────────────────────────
const cats = new Map((await q('SELECT id, name FROM categories')).rows.map(r => [r.name, r.id]))
const C = n => cats.get(n) ?? null

// ─── transactions ─────────────────────────────────────────────────────────────
const rows = []
const tx = (account, date, payee, cents, type, category, opts = {}) => rows.push({
  id: uuid(), account, date: iso(date), payee, cents, type, category,
  vendor: vendorFrom(payee), source: opts.source ?? 'rule:auto', ...opts,
})

// A little variation so charts don't look synthetic
let seed = 7
const jitter = pct => { seed = (seed * 1103515245 + 12345) % 2147483648; return 1 + ((seed / 2147483648) - 0.5) * 2 * pct }
const vary = (cents, pct = 0.18) => Math.round(cents * jitter(pct) / 10) * 10

const MONTHS = []
for (let m = 9; m <= 12; m++) MONTHS.push([2025, m])
for (let m = 1; m <= 8; m++) MONTHS.push([2026, m])

for (const [y, m] of MONTHS) {
  // Income — fortnightly wages, plus a quarterly dividend
  for (const day of [4, 18]) {
    tx(everyday, D(y, m, day), 'PAY/SALARY FROM ACMECORP BUSINESS WAGES', 384500, 'income', C('Employment'))
  }
  if (m % 3 === 0) tx(savings, D(y, m, 22), 'DIRECT CREDIT MERIDIAN INDEX FUND DISTRIBUTION', vary(41500, 0.3), 'income', C('Investment Income'))

  // Housing — the repayment is a transfer (it moves debt, not spending); only the
  // interest the lender charges is a real cost, so only that reaches the P&L.
  tx(everyday, D(y, m, 2), 'TRANSFER TO HOME LOAN', -190000, 'transfer', null)
  tx(loan, D(y, m, 2), 'TRANSFER FROM EVERYDAY', 190000, 'transfer', null)
  tx(loan, D(y, m, 3), 'HOME LOAN INTEREST CHARGED', -128900, 'interest', C('Mortgage / Rent'))

  // Utilities
  tx(everyday, D(y, m, 8), 'DIRECT DEBIT NORTHFIELD ENERGY ELECTRICITY', vary(-18400, 0.35), 'expense', C('Electricity'))
  tx(everyday, D(y, m, 11), 'DIRECT DEBIT EAST BAY WATER RATES', vary(-9600, 0.12), 'expense', C('Water'))
  tx(everyday, D(y, m, 15), 'DIRECT DEBIT CLEARLINE BROADBAND', -8900, 'expense', C('Internet'))
  tx(everyday, D(y, m, 15), 'DIRECT DEBIT CLEARLINE MOBILE', -4500, 'expense', C('Mobile Phone'))

  // Groceries — weekly-ish
  for (const day of [3, 10, 17, 24]) {
    tx(card, D(y, m, day), `VISA DEBIT PURCHASE CARD 4321 SUPERMART 0088 NORTHFIELD`, vary(-21500, 0.3), 'expense', C('Groceries'))
  }
  tx(card, D(y, m, 27), 'VISA DEBIT PURCHASE CARD 4321 GROCERCO 0099 RIVERTON', vary(-8700, 0.4), 'expense', C('Groceries'))

  // Eating out / coffee
  for (const day of [6, 20]) tx(card, D(y, m, day), 'EFTPOS DD *QUICKEATS CITYVILLE AU', vary(-5400, 0.45), 'expense', C('Eating Out'))
  for (const day of [5, 12, 19, 26]) tx(card, D(y, m, day), 'EFTPOS ZEBRA CAFE RIVERTON', vary(-1250, 0.3), 'expense', C('Coffee & Snacks'))

  // Transport
  for (const day of [9, 23]) tx(card, D(y, m, day), 'VISA DEBIT PURCHASE CARD 4321 FUEL DEPOT 0442 RIVERTON', vary(-9200, 0.25), 'expense', C('Fuel'))
  tx(everyday, D(y, m, 14), 'DIRECT DEBIT SAFEGUARD CAR INSURANCE', -7300, 'expense', C('Car Insurance'))

  // Entertainment
  tx(card, D(y, m, 7), 'STREAMCO.COM CITYVILLE AU', -1899, 'expense', C('Streaming Services'))
  tx(card, D(y, m, 13), 'PAYPAL *PIXEL PLAY 1234567890', -1499, 'expense', C('Games'))

  // Health / personal — occasional
  if (m % 2 === 0) tx(card, D(y, m, 16), 'EFTPOS THE PET VETS 59 RIVERTON RAU', vary(-14500, 0.4), 'expense', C('Prescriptions'))
  if (m % 3 === 1) tx(card, D(y, m, 21), 'EFTPOS ALPHA STORE CITYVILLE', vary(-11200, 0.5), 'expense', C('Clothing & Footwear'))
  tx(everyday, D(y, m, 6), 'DIRECT DEBIT IRONSIDE FITNESS', -6500, 'expense', C('Gym & Fitness'))

  // Savings + card payment
  tx(everyday, D(y, m, 19), 'TRANSFER TO SAVINGS', -60000, 'transfer', null)
  tx(savings, D(y, m, 19), 'TRANSFER FROM EVERYDAY', 60000, 'transfer', null)
  tx(everyday, D(y, m, 25), 'PAYMENT TO CREDIT CARD', -95000, 'transfer', null)
  tx(card, D(y, m, 25), 'PAYMENT RECEIVED THANK YOU', 95000, 'transfer', null)

  // Gifts, occasional
  if ([12, 5].includes(m)) tx(card, D(y, m, 18), 'EFTPOS CORNER FISH AND CH RIVERTON', vary(-6800, 0.3), 'expense', C('Gifts'))
}

// A couple of uncategorised rows so the "needs review" state is visible
tx(card, D(2026, 8, 26), 'EFTPOS SQ *MARKET STALL RIVERTON', -3450, 'expense', null, { source: null })
tx(card, D(2026, 8, 28), 'VISA DEBIT PURCHASE CARD 4321 HARBOUR HARDWARE', -8790, 'expense', null, { source: null })

for (const r of rows) {
  await q(`INSERT INTO transactions (id, account_id, date, payee, vendor, amount_cents, type, category_id, reviewed, assign_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [r.id, r.account, r.date, r.payee, r.vendor, r.cents, r.type, r.category, r.category != null, r.source])
}

// ─── transfer pairing ─────────────────────────────────────────────────────────
await q(`UPDATE transactions o SET transfer_group = gen_random_uuid()
         WHERE o.type = 'transfer' AND o.amount_cents < 0`)
await q(`UPDATE transactions i SET transfer_group = o.transfer_group, linked_transaction_id = o.id
         FROM transactions o
         WHERE i.type = 'transfer' AND i.amount_cents > 0 AND o.amount_cents = -i.amount_cents
           AND o.date = i.date AND o.transfer_group IS NOT NULL AND i.transfer_group IS NULL`)
// Both legs point at each other — the dashboard counts a leg with a NULL
// linked_transaction_id as unmatched, so linking only one side leaves half of them flagged.
await q(`UPDATE transactions o SET linked_transaction_id = i.id
         FROM transactions i
         WHERE i.linked_transaction_id = o.id AND o.linked_transaction_id IS NULL`)

// ─── holdings ─────────────────────────────────────────────────────────────────
const holding = async (name, side, kind, series) => {
  const id = uuid()
  await q('INSERT INTO holdings (id, name, side, kind) VALUES ($1,$2,$3,$4)', [id, name, side, kind])
  for (const [as_of, cents] of series) {
    await q('INSERT INTO holding_values (id, holding_id, as_of, value_cents) VALUES ($1,$2,$3,$4)', [uuid(), id, as_of, cents])
  }
}
const quarterly = (start, step) => MONTHS.filter((_, i) => i % 3 === 0)
  .map(([y, m], i) => [iso(D(y, m, 1)), start + step * i])

await holding('Superannuation', 'asset', 'super', quarterly(9420000, 310000))
await holding('Home', 'asset', 'property', quarterly(71500000, 450000))
await holding('Car', 'asset', 'vehicle', quarterly(2140000, -85000))
await holding('Car Loan', 'liability', 'loan', quarterly(1380000, -190000))

// ─── budgets ──────────────────────────────────────────────────────────────────
const budget = (name, cents, from = '2025-09-01', period = 'monthly') =>
  q('INSERT INTO budgets (id, category_id, period, amount_cents, effective_from) VALUES ($1,$2,$3,$4,$5)',
    [uuid(), C(name), period, cents, from])
await budget('Groceries', 95000)
await budget('Eating Out', 18000)
await budget('Coffee & Snacks', 6000)
await budget('Fuel', 20000)
await budget('Streaming Services', 4000)
await budget('Clothing & Footwear', 12000)
await budget('Groceries', 88000, '2026-06-01')   // a later revision, to show the dated series

// ─── goals ────────────────────────────────────────────────────────────────────
const goal = (text, target, by) =>
  q('INSERT INTO budget_goals (id, text, target_cents, by_date, account_id) VALUES ($1,$2,$3,$4,$5)',
    [uuid(), text, target, by, target ? savings : null])
await goal('Build an emergency fund worth three months of expenses', 1800000, '2027-06-30')
await goal('Clear the car loan early without touching savings', null, null)

// ─── recurring ────────────────────────────────────────────────────────────────
const recur = (payee, nickname, cents, freq, cat, sub) =>
  q(`INSERT INTO recurring (id, payee, nickname, expected_amount_cents, frequency, category_id,
       last_seen, next_due, is_subscription) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uuid(), payee, nickname, cents, freq, C(cat), '2026-08-07', '2026-09-07', sub])
await recur('STREAMCO.COM CITYVILLE AU', 'Streamco', -1899, 'monthly', 'Streaming Services', true)
await recur('DIRECT DEBIT CLEARLINE BROADBAND', 'Broadband', -8900, 'monthly', 'Internet', true)
await recur('DIRECT DEBIT IRONSIDE FITNESS', 'Gym', -6500, 'monthly', 'Gym & Fitness', true)
await recur('DIRECT DEBIT SAFEGUARD CAR INSURANCE', 'Car insurance', -7300, 'monthly', 'Car Insurance', false)
await recur('PAY/SALARY FROM ACMECORP BUSINESS WAGES', 'Wages', 384500, 'fortnightly', 'Employment', false)

// ─── rules ────────────────────────────────────────────────────────────────────
const rule = (priority, name, value, cat, rename) =>
  q(`INSERT INTO rules (id, priority, name, conditions, category_id, rename_to)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [uuid(), priority, name, JSON.stringify([{ field: 'payee', op: 'contains', value }]), C(cat), rename ?? null])
await rule(1, 'Supermart → Groceries', 'SUPERMART', 'Groceries', null)
await rule(2, 'Fuel Depot → Fuel', 'FUEL DEPOT', 'Fuel', null)
await rule(3, 'Streamco → Streaming', 'STREAMCO', 'Streaming Services', 'Streamco')
await rule(4, 'Acmecorp → Employment', 'ACMECORP', 'Employment', 'Acmecorp Wages')

const n = (await q('SELECT count(*)::int c FROM transactions')).rows[0].c
console.log(`Seeded ${n} transactions, 4 accounts, 4 holdings, 7 budgets, 2 goals, 5 recurring, 4 rules.`)
console.log('Login: demo / demo-password-2026')
await pool.end()
