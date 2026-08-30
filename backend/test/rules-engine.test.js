import assert from 'node:assert/strict'
import { conditionsSql, matchRule, matchesRule, describeRule, validateConditions } from '../src/services/rules.js'

const ACC_A = '11111111-1111-1111-1111-111111111111'
const ACC_B = '22222222-2222-2222-2222-222222222222'
const rule = (conditions, extra = {}) => ({ conditions, match_all: true, enabled: true, ...extra })
const tx = (payee, amount_cents, account_id = ACC_A) => ({ payee, amount_cents, account_id })

// Text operators
{
  const t = tx('VISA DEBIT PURCHASE CARD 4321 SUPERMART ONLINE', -12345)
  const on = (op, value) => matchesRule(rule([{ field: 'payee', op, value }]), t)
  assert.equal(on('contains', 'supermart'), true, 'case-insensitive contains')
  assert.equal(on('contains', 'grocerco'), false)
  assert.equal(on('not_contains', 'grocerco'), true)
  assert.equal(on('not_contains', 'supermart'), false)
  assert.equal(on('starts_with', 'visa debit'), true)
  assert.equal(on('starts_with', 'supermart'), false)
  assert.equal(on('ends_with', 'ONLINE'), true)
  assert.equal(on('equals', ' visa debit purchase card 4321 supermart online '), true, 'equals trims and folds case')
}

// Amount operators compare the absolute value, so they read the same either way
{
  for (const cents of [-5000, 5000]) {
    const t = tx('ANYTHING', cents)
    const on = (op, value, value2) => matchesRule(rule([{ field: 'amount', op, value, value2 }]), t)
    assert.equal(on('gt', 4999), true)
    assert.equal(on('gt', 5000), false)
    assert.equal(on('gte', 5000), true)
    assert.equal(on('lt', 5001), true)
    assert.equal(on('lte', 5000), true)
    assert.equal(on('eq', 5000), true)
    assert.equal(on('between', 4000, 6000), true)
    assert.equal(on('between', 5001, 6000), false)
  }
}

// Direction is its own field, since amounts are compared unsigned
{
  assert.equal(matchesRule(rule([{ field: 'direction', op: 'is', value: 'out' }]), tx('X', -100)), true)
  assert.equal(matchesRule(rule([{ field: 'direction', op: 'is', value: 'out' }]), tx('X', 100)), false)
  assert.equal(matchesRule(rule([{ field: 'direction', op: 'is', value: 'in' }]), tx('X', 100)), true)
}

// Account scoping
{
  const c = (op, value) => matchesRule(rule([{ field: 'account', op, value }]), tx('X', -100, ACC_A))
  assert.equal(c('is', ACC_A), true)
  assert.equal(c('is', ACC_B), false)
  assert.equal(c('is_not', ACC_B), true)
}

// all vs any
{
  const conditions = [
    { field: 'payee', op: 'contains', value: 'uber' },
    { field: 'amount', op: 'gt', value: 10000 },
  ]
  const t = tx('UBER EATS CITYVILLE', -2500)
  assert.equal(matchesRule(rule(conditions), t), false, 'all: the amount fails')
  assert.equal(matchesRule(rule(conditions, { match_all: false }), t), true, 'any: the payee is enough')
}

// Priority order, and a disabled rule is skipped entirely
{
  const rules = [
    { id: 'a', enabled: false, match_all: true, conditions: [{ field: 'payee', op: 'contains', value: 'uber' }] },
    { id: 'b', enabled: true, match_all: true, conditions: [{ field: 'payee', op: 'contains', value: 'uber eats' }] },
    { id: 'c', enabled: true, match_all: true, conditions: [{ field: 'payee', op: 'contains', value: 'uber' }] },
  ]
  assert.equal(matchRule(rules, tx('UBER EATS CITYVILLE', -2500)).id, 'b', 'first enabled match wins')
  assert.equal(matchRule(rules, tx('UBER TRIP', -1800)).id, 'c')
  assert.equal(matchRule(rules, tx('GROCERCO', -1800)), null)
}

// Validation rejects what the UI must not be able to save
{
  assert.match(validateConditions([]), /at least one condition/)
  assert.match(validateConditions([{ field: 'nope', op: 'is', value: 1 }]), /Unknown condition field/)
  assert.match(validateConditions([{ field: 'payee', op: 'gt', value: 'x' }]), /not valid for payee/)
  assert.match(validateConditions([{ field: 'payee', op: 'contains', value: '  ' }]), /something to match on/)
  assert.match(validateConditions([{ field: 'amount', op: 'between', value: 500 }]), /both bounds/)
  assert.match(validateConditions([{ field: 'amount', op: 'between', value: 900, value2: 100 }]), /must not exceed/)
  assert.equal(validateConditions([{ field: 'amount', op: 'between', value: 100, value2: 900 }]), null)
  assert.equal(validateConditions([{ field: 'direction', op: 'is', value: 'out' }]), null)
}

// The SQL builder emits one placeholder per value, in order, joined by the right operator
{
  const params = []
  const sql = conditionsSql(params, [
    { field: 'payee', op: 'contains', value: 'uber' },
    { field: 'amount', op: 'between', value: 100, value2: 900 },
    { field: 'account', op: 'is', value: ACC_A },
    { field: 'direction', op: 'is', value: 'out' },
  ])
  assert.deepEqual(params, ['uber', 100, 900, ACC_A], 'direction needs no parameter')
  assert.match(sql, /ILIKE '%'\|\|\$1\|\|'%'/)
  assert.match(sql, /BETWEEN \$2 AND \$3/)
  assert.match(sql, /account_id = \$4/)
  assert.match(sql, /amount_cents < 0/)
  assert.equal(sql.includes(' OR '), false, 'match_all joins with AND')

  const anyParams = []
  assert.match(conditionsSql(anyParams, [
    { field: 'payee', op: 'contains', value: 'a' },
    { field: 'payee', op: 'contains', value: 'b' },
  ], false), / OR /)
}

// An empty condition list must never compile to something that matches everything
assert.equal(conditionsSql([], []), 'FALSE')
assert.equal(matchesRule(rule([]), tx('X', -1)), false)

// Plain-English summary drives the rules list
{
  const text = describeRule(rule([
    { field: 'payee', op: 'contains', value: 'SUPERMART' },
    { field: 'amount', op: 'gt', value: 5000 },
  ]), { money: c => `$${(c / 100).toFixed(2)}` })
  assert.equal(text, 'description contains “SUPERMART” and amount is over $50.00')

  const any = describeRule(rule([
    { field: 'payee', op: 'contains', value: 'A' },
    { field: 'direction', op: 'is', value: 'in' },
  ], { match_all: false }))
  assert.match(any, / or it is money in$/)
}

console.log('rules-engine.test.js: all assertions passed')
