// The rule condition engine. Pure functions — no DB access — so the same
// definition can be evaluated in JS (during import, one transaction at a time)
// and compiled to SQL (for previews and bulk application), with tests proving
// the two agree (test/rules-engine.test.js).
//
// A condition is { field, op, value, value2? }. Amounts are integer cents and
// always compared on the ABSOLUTE value, so "is over $1,000" reads the same for
// money in and money out — direction is its own field.

export const FIELDS = ['payee', 'amount', 'account', 'direction']

export const OPS = {
  payee: ['contains', 'not_contains', 'starts_with', 'ends_with', 'equals'],
  amount: ['gt', 'gte', 'lt', 'lte', 'eq', 'between'],
  account: ['is', 'is_not'],
  direction: ['is'],
}

// Labels the UI renders, and the plain-English rule summary in the list
export const OP_LABELS = {
  contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with',
  ends_with: 'ends with', equals: 'is exactly',
  gt: 'is over', gte: 'is at least', lt: 'is under', lte: 'is at most',
  eq: 'is exactly', between: 'is between',
  is: 'is', is_not: 'is not',
}

const norm = s => (s == null ? '' : String(s)).toLowerCase().trim()

export function validateCondition(c) {
  if (!c || !FIELDS.includes(c.field)) return 'Unknown condition field'
  if (!OPS[c.field].includes(c.op)) return `"${c.op}" is not valid for ${c.field}`
  if (c.field === 'payee' && !norm(c.value)) return 'Text conditions need something to match on'
  if (c.field === 'amount') {
    if (!Number.isFinite(Number(c.value))) return 'Amount conditions need a number'
    if (c.op === 'between' && !Number.isFinite(Number(c.value2))) return 'A "between" amount needs both bounds'
    if (c.op === 'between' && Math.abs(Number(c.value)) > Math.abs(Number(c.value2)))
      return 'The lower amount must not exceed the upper one'
  }
  if (c.field === 'account' && !c.value) return 'Account conditions need an account'
  if (c.field === 'direction' && !['in', 'out'].includes(c.value)) return 'Direction must be in or out'
  return null
}

export function validateConditions(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return 'A rule needs at least one condition'
  for (const c of conditions) {
    const err = validateCondition(c)
    if (err) return err
  }
  return null
}

function matchOne(c, t) {
  const payee = norm(t.payee)
  const needle = norm(c.value)
  switch (c.field) {
    case 'payee':
      switch (c.op) {
        case 'contains': return payee.includes(needle)
        case 'not_contains': return !payee.includes(needle)
        case 'starts_with': return payee.startsWith(needle)
        case 'ends_with': return payee.endsWith(needle)
        case 'equals': return payee === needle
      }
      return false
    case 'amount': {
      if (t.amount_cents == null) return false
      const abs = Math.abs(Number(t.amount_cents))
      const a = Math.abs(Number(c.value))
      switch (c.op) {
        case 'gt': return abs > a
        case 'gte': return abs >= a
        case 'lt': return abs < a
        case 'lte': return abs <= a
        case 'eq': return abs === a
        case 'between': return abs >= a && abs <= Math.abs(Number(c.value2))
      }
      return false
    }
    case 'account':
      // A rule scoped to an account can't be judged without knowing the account
      if (!t.account_id) return false
      return c.op === 'is' ? t.account_id === c.value : t.account_id !== c.value
    case 'direction': {
      if (t.amount_cents == null) return false
      return (Number(t.amount_cents) >= 0 ? 'in' : 'out') === c.value
    }
  }
  return false
}

// matchAll: every condition must hold (AND); otherwise any one will do (OR)
export function matchesRule(rule, t) {
  const conditions = rule.conditions || []
  if (!conditions.length) return false
  return rule.match_all === false
    ? conditions.some(c => matchOne(c, t))
    : conditions.every(c => matchOne(c, t))
}

// The same logic as SQL. `params` is appended to in place, mirroring the pattern
// used by the transaction list filters.
export function conditionsSql(params, conditions, matchAll = true) {
  const parts = (conditions || []).map(c => {
    const p = v => { params.push(v); return `$${params.length}` }
    switch (c.field) {
      case 'payee': {
        const v = String(c.value)
        switch (c.op) {
          case 'contains': return `payee ILIKE '%'||${p(v)}||'%'`
          case 'not_contains': return `payee NOT ILIKE '%'||${p(v)}||'%'`
          case 'starts_with': return `payee ILIKE ${p(v)}||'%'`
          case 'ends_with': return `payee ILIKE '%'||${p(v)}`
          case 'equals': return `lower(btrim(payee)) = lower(btrim(${p(v)}))`
        }
        return 'FALSE'
      }
      case 'amount': {
        const a = Math.abs(Number(c.value))
        switch (c.op) {
          case 'gt': return `abs(amount_cents) > ${p(a)}`
          case 'gte': return `abs(amount_cents) >= ${p(a)}`
          case 'lt': return `abs(amount_cents) < ${p(a)}`
          case 'lte': return `abs(amount_cents) <= ${p(a)}`
          case 'eq': return `abs(amount_cents) = ${p(a)}`
          case 'between': return `abs(amount_cents) BETWEEN ${p(a)} AND ${p(Math.abs(Number(c.value2)))}`
        }
        return 'FALSE'
      }
      case 'account':
        return c.op === 'is' ? `account_id = ${p(c.value)}` : `account_id <> ${p(c.value)}`
      case 'direction':
        return c.value === 'in' ? 'amount_cents >= 0' : 'amount_cents < 0'
    }
    return 'FALSE'
  })
  if (!parts.length) return 'FALSE'
  return '(' + parts.join(matchAll ? ' AND ' : ' OR ') + ')'
}

// First enabled rule whose conditions hold, in priority order
export function matchRule(rules, txOrPayee) {
  const t = typeof txOrPayee === 'string' ? { payee: txOrPayee } : (txOrPayee || {})
  return (rules || []).find(r => r.enabled !== false && matchesRule(r, t)) || null
}

// "payee contains SUPERMART and amount is over $50" — for the rules list and audit trail
export function describeRule(rule, { accountName = () => 'an account', money = c => `$${(c / 100).toFixed(2)}` } = {}) {
  const parts = (rule.conditions || []).map(c => {
    const op = OP_LABELS[c.op] ?? c.op
    switch (c.field) {
      case 'payee': return `description ${op} “${c.value}”`
      case 'amount': return `amount ${op} ${money(Math.abs(Number(c.value)))}` +
        (c.op === 'between' ? ` and ${money(Math.abs(Number(c.value2)))}` : '')
      case 'account': return `account ${op} ${accountName(c.value)}`
      case 'direction': return `it is money ${c.value}`
    }
    return ''
  })
  return parts.join(rule.match_all === false ? ' or ' : ' and ')
}
