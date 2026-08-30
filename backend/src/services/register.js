// The account register: every row that moves an account's balance, in the order the
// balance actually moved, each carrying the balance as it stood after it.
//
// Deliberately NOT the P&L view of the world. Reconciling against a bank statement
// means every live transaction counts — transfers, adjustments, excluded rows and
// all — because the bank counted them. IN_PNL() has no business here.

// Two transactions on the same day have no natural order, but a running balance
// needs one, and it has to be the SAME one every time the page loads or the
// balances shuffle between refreshes. created_at then id is arbitrary but stable.
export function orderKey(t) {
  return [t.date, t.created_at ?? '', t.id]
}

export function sortForRegister(rows) {
  return [...rows].sort((a, b) => {
    const [ad, ac, ai] = orderKey(a), [bd, bc, bi] = orderKey(b)
    return ad < bd ? -1 : ad > bd ? 1 : ac < bc ? -1 : ac > bc ? 1 : ai < bi ? -1 : ai > bi ? 1 : 0
  })
}

// `opening` is the balance entering the window — the account's opening balance plus
// everything before it. Without that the column is a running total, not a balance.
export function withRunningBalance(rows, opening) {
  let balance = Number(opening)
  return sortForRegister(rows).map(t => {
    balance += Number(t.amount_cents)
    return { ...t, balance_cents: balance }
  })
}

// What the window did, for the header. Money in and out are reported separately
// because "net -$40" hides a $3,000 salary landing next to $3,040 of spending.
export function windowTotals(rows) {
  let in_cents = 0, out_cents = 0
  for (const t of rows) {
    const c = Number(t.amount_cents)
    if (c >= 0) in_cents += c
    else out_cents += -c
  }
  return { in_cents, out_cents, count: rows.length }
}
