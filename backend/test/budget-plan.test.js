import assert from 'node:assert/strict'
import { validateProposals, planTotals, commitmentConflicts, median, planResponse } from '../src/services/budget-plan.js'

const known = new Map([
  ['a', { id: 'a', name: 'Food & Drink › Groceries', kind: 'expense' }],
  ['b', { id: 'b', name: 'Food & Drink › Eating Out', kind: 'expense' }],
  ['w', { id: 'w', name: 'Income › Wages', kind: 'income' }],
])
const current = new Map([['a', { period: 'monthly', amount_cents: 60000 }]])

// The model is untrusted input — every one of these has been seen from a model
{
  const { proposals, rejected } = validateProposals([
    { categoryId: 'a', proposedCents: 55000, period: 'monthly', reason: 'trim 8%', confidence: 'high' },
    { categoryId: 'ghost', proposedCents: 10000, period: 'monthly' },      // invented category
    { categoryId: 'a', proposedCents: 40000, period: 'monthly' },          // duplicate
    { categoryId: 'b', proposedCents: 'about $200', period: 'monthly' },   // prose where cents belong
    { categoryId: 'b', proposedCents: -5000, period: 'monthly' },          // negative
    { categoryId: 'b', proposedCents: 20000, period: 'fortnightly' },      // period we don't support
  ], known, current)

  assert.equal(proposals.length, 2, 'one valid Groceries and one salvaged Eating Out')
  assert.equal(rejected.length, 4)
  assert.match(rejected.join(' '), /unknown category/)
  assert.match(rejected.join(' '), /second proposal/)
  assert.match(rejected.join(' '), /unusable amount/)

  const [gro, out] = proposals
  assert.equal(gro.currentCents, 60000, 'current target comes from us, not the model')
  assert.equal(gro.currentPerMonthCents, 60000)
  assert.equal(gro.confidence, 'high')
  assert.equal(out.currentCents, null, 'no target yet')
  assert.equal(out.period, 'monthly', 'an unsupported period falls back rather than being stored')
  assert.equal(out.confidence, 'medium', 'missing confidence defaults')
}

// The model is asked for dollars, so the household never reads a cent figure in
// its prose. Cents still validate, for plans made by an earlier release.
{
  const { proposals, rejected } = validateProposals([
    { categoryId: 'a', proposedDollars: 250, period: 'monthly' },
    { categoryId: 'b', proposedDollars: 12.5, period: 'monthly' },
  ], known, new Map())
  assert.equal(proposals[0].proposedCents, 25000)
  assert.equal(proposals[1].proposedCents, 1250, 'part-dollar amounts survive the conversion')
  assert.equal(rejected.length, 0)

  const legacy = validateProposals([{ categoryId: 'a', proposedCents: 25000, period: 'monthly' }], known, new Map())
  assert.equal(legacy.proposals[0].proposedCents, 25000)

  // Prose where a number belongs is still rejected, in either unit
  assert.equal(validateProposals([{ categoryId: 'a', proposedDollars: 'about $200' }], known, new Map()).proposals.length, 0)
}

// A yearly proposal is normalised for comparison
{
  const { proposals } = validateProposals(
    [{ categoryId: 'a', proposedCents: 120000, period: 'yearly' }], known, new Map())
  assert.equal(proposals[0].proposedPerMonthCents, 10000)
}

// Totals are ours. If the model's summary disagrees, ours is the one on screen —
// so ours had better be right.
{
  const { proposals } = validateProposals([
    { categoryId: 'a', proposedCents: 50000, period: 'monthly' },
    { categoryId: 'b', proposedCents: 15000, period: 'monthly' },
    { categoryId: 'w', proposedCents: 500000, period: 'monthly' },  // income must not skew spend totals
  ], known, current)
  const spend = new Map([['a', [62000, 58000, 60000]], ['b', [30000, 20000, 25000]]])
  const t = planTotals(proposals, spend)
  assert.equal(t.proposed_per_month_cents, 65000, 'income is excluded from the spending total')
  assert.equal(t.typical_per_month_cents, 85000, 'median of each, summed')
  assert.equal(t.frees_per_month_cents, 20000, '$100 off groceries plus $100 off eating out')
  assert.equal(t.change_per_month_cents, -20000, 'the plan spends $200 a month less')
  assert.equal(t.current_per_month_cents, 60000, 'only Groceries had a target')
  assert.equal(t.cuts, 2)
  assert.equal(t.raises, 0)
}

// The bug real data exposed: a proposal for a category with NO history — typically
// the savings line, where the freed money is going. Counting its target as extra
// spending reported "$0 freed" beside prose describing $500 of cuts.
{
  const withSavings = new Map(known)
  withSavings.set('s', { id: 's', name: 'Financial › Savings Transfers', kind: 'expense' })
  const { proposals } = validateProposals([
    { categoryId: 'a', proposedCents: 25000, period: 'monthly' },   // 60000 → 25000, frees 35000
    { categoryId: 's', proposedCents: 71500, period: 'monthly' },   // brand new, no history
  ], withSavings, new Map())
  const spend = new Map([['a', [60000, 60000, 60000]]])             // no entry for 's'
  const t = planTotals(proposals, spend)

  assert.equal(t.frees_per_month_cents, 35000, 'the real cut is not cancelled by the savings line')
  assert.equal(t.typical_per_month_cents, 60000, 'only categories with history form the baseline')
  assert.equal(t.change_per_month_cents, -35000, 'net movement is measured on comparable categories only')
  assert.equal(t.newly_budgeted_per_month_cents, 71500)
  assert.deepEqual(t.newly_budgeted, ['Financial › Savings Transfers'])
  assert.equal(t.cuts, 1)
  assert.equal(t.raises, 0, 'a category with no history is not a "raise"')
}

// Medians, including the even-length case
assert.equal(median([]), 0)
assert.equal(median([500]), 500)
assert.equal(median([300, 100, 200]), 200)
assert.equal(median([100, 200, 300, 500]), 250)

// A plan that cuts below contractual bills is flagged, not applied silently
{
  const { proposals } = validateProposals([
    { categoryId: 'a', proposedCents: 20000, period: 'monthly' },
    { categoryId: 'b', proposedCents: 40000, period: 'monthly' },
  ], known, new Map())
  const conflicts = commitmentConflicts(proposals, [
    { categoryId: 'a', cents: 12000, frequency: 'fortnightly' },   // $120 a fortnight = $260/mo
    { categoryId: 'b', cents: 1000, frequency: 'monthly' },
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].categoryId, 'a')
  assert.equal(conflicts[0].committedPerMonthCents, 26000)
  assert.equal(conflicts[0].proposedPerMonthCents, 20000)
}

// Nothing at all from the model is handled like anything else
{
  assert.deepEqual(validateProposals(undefined, known, new Map()), { proposals: [], rejected: [] })
  assert.deepEqual(validateProposals('nope', known, new Map()), { proposals: [], rejected: [] })
  assert.equal(planTotals([], new Map()).proposed_per_month_cents, 0)
}

// A stored plan must always come back complete. The page reads plan.totals.* and
// plan.proposals.* unguarded, so a row written by an earlier build — or one whose
// summary never made it — has to be filled in here, not blow up the browser.
{
  const bare = planResponse({ id: 'p1', proposals: null, summary: null })
  assert.deepEqual(bare.proposals, [])
  assert.deepEqual(bare.goalOutlook, [])
  assert.deepEqual(bare.warnings, [])
  assert.deepEqual(bare.conflicts, [])
  assert.equal(bare.summary, '')
  assert.equal(bare.totals.typical_per_month_cents, 0, 'totals is always an object with numbers')
  assert.equal(bare.totals.change_per_month_cents, 0)

  // A summary stored as a bare string (rather than the blob) still reads
  assert.equal(planResponse({ summary: 'just words' }).summary, 'just words')

  // The real bug: summary lived in a TEXT column holding serialised JSON, so the
  // whole payload was rendered into the history row. It must parse, never leak.
  const serialised = planResponse({
    summary: JSON.stringify({ summary: 'This plan leaves all essentials untouched.', totals: { proposed_per_month_cents: 900 } }),
    proposals: [],
  })
  assert.equal(serialised.summary, 'This plan leaves all essentials untouched.')
  assert.equal(serialised.totals.proposed_per_month_cents, 900)
  assert.ok(!serialised.summary.startsWith('{'), 'a serialised payload must never reach the UI')

  // Valid JSON that isn't an object (a bare quoted string) is not a blob
  assert.equal(planResponse({ summary: '"hello"' }).summary, '')
  assert.equal(planResponse({ summary: '[1,2]' }).summary, '')

  // Partial totals from an older build are topped up, not replaced
  const partial = planResponse({ summary: { summary: 'hi', totals: { proposed_per_month_cents: 500 } } })
  assert.equal(partial.totals.proposed_per_month_cents, 500)
  assert.equal(partial.totals.typical_per_month_cents, 0)
  assert.equal(partial.summary, 'hi')

  assert.equal(planResponse(null), null, 'a missing row stays missing, for the 404')

  // The full modern shape passes through untouched
  const full = planResponse({
    id: 'p2', proposals: [{ categoryId: 'a' }],
    summary: { summary: 's', goalOutlook: [{ goal: 'g' }], warnings: ['w'], rejected: ['r'],
      conflicts: [{ name: 'c' }], effort: 'high', totals: { proposed_per_month_cents: 1, typical_per_month_cents: 2, change_per_month_cents: -1, current_per_month_cents: 3, cuts: 1, raises: 0 } },
  })
  assert.equal(full.effort, 'high')
  assert.equal(full.goalOutlook.length, 1)
  assert.equal(full.totals.change_per_month_cents, -1)
  assert.equal(full.proposals.length, 1)
}

console.log('budget-plan.test.js: all assertions passed')
