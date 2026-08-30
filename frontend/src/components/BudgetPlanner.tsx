// Plan with AI — rebuilt to the "Budgets redesign" handoff spec.
//
// The shape of the feature: goals state what you're working toward and what that
// costs a month; the planner reads your actual spending and proposes targets; the
// result gets a real surface — a verdict that reconciles the two and is allowed to
// say the goals don't fit, then per-category changes you apply in one click.
//
// Every figure on this screen is computed server-side. The model writes the prose
// around them and nothing else, so a number can never disagree with its own total.
import { useEffect, useState } from 'react'
import { del, get, patch, post } from '../lib/api'
import { Button, Input, Select, cn } from './ui'
import { dollars, money } from '../lib/format'
import { groupColour } from '../lib/categories'

const CARD = 'rounded-xl border border-[#e8ebf0] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]'

const longDate = (iso?: string | null) => (iso
  ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  : '')
const dateTime = (iso: string) => {
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`
}

export function BudgetPlanner({ month, onApplied, onAdjust }: { month: string; onApplied: () => void; onAdjust: () => void }) {
  const [goals, setGoals] = useState<any[]>([])
  const [plan, setPlan] = useState<any>(null)
  const [history, setHistory] = useState<any[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<any[]>([])
  const [note, setNote] = useState('')
  const [months, setMonths] = useState(3)
  const [ai, setAi] = useState<any>(null)
  // Goals edited after a run would silently re-verdict an existing plan, so the
  // plan card says it's stale rather than quietly changing meaning.
  const [goalsChanged, setGoalsChanged] = useState(false)

  const loadGoals = () => get('/budget-goals').then(setGoals).catch(() => {})
  const loadHistory = () => get('/budgets/plans').then(setHistory).catch(() => {})
  useEffect(() => {
    loadGoals(); loadHistory()
    get('/settings').then(setAi).catch(() => {})
    get('/accounts').then(setAccounts).catch(() => {})
  }, [])
  const aiReady = !ai || (ai.aiEnabled && ai.apiKeySet)

  const goalsNeed = goals.reduce((n, g) => n + (g.needs_per_month_cents ?? 0), 0)

  const run = async () => {
    setRunning(true); setError(''); setGoalsChanged(false)
    try {
      setPlan(await post('/budgets/plan', { months, note, month }))
      loadHistory()
    } catch (e) { setError((e as Error).message) }
    setRunning(false)
  }

  const apply = async () => {
    setError('')
    try {
      const r = await post(`/budgets/plans/${plan.id}/apply`, { effectiveFrom: month })
      setPlan(null); loadHistory()
      if (r.skipped?.length) setError(`Skipped ${r.skipped.join(', ')} — no longer budgetable.`)
      onApplied()   // reloads targets and switches to the Targets tab
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <div className="space-y-3">
      {/* Goals */}
      <div className={cn(CARD, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2.5 pt-3.5">
          <p className="text-[13.5px] font-[650]">Goals
            <span className="ml-2 text-[12px] font-[450] text-[#9aa2af]">The planner reads these before it proposes anything</span></p>
          <button onClick={() => setAdding(true)}
            className="h-[30px] cursor-pointer rounded-lg border border-dashed border-[#d8dde5] px-[11px] text-[12.5px] text-[#5d6674] hover:border-[#93b4fb] hover:text-[#2563eb]">
            ＋ Add a goal
          </button>
        </div>

        {goals.length === 0 && !adding && (
          <p className="border-t border-[#f4f6f8] px-4 py-5 text-center text-[13px] text-[#9aa2af]">
            Add a goal so the planner knows what it's working toward — or run it anyway to just trim spending.
          </p>
        )}

        {goals.map(g => (editing === g.id ? (
          <GoalForm key={g.id} goal={g} accounts={accounts} onCancel={() => setEditing(null)}
            onSaved={() => { setEditing(null); loadGoals(); setGoalsChanged(true) }} onError={setError} />
        ) : (
          <div key={g.id} className="grid grid-cols-[minmax(120px,1fr)_auto] items-center gap-3 border-t border-[#f4f6f8] px-4 py-2.5 hover:bg-[#fafbfe] sm:grid-cols-[minmax(160px,280px)_1fr_150px_58px]">
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold">{g.text}</span>
              {g.account_name && (
                <span className="mt-0.5 block truncate text-[11.5px] text-[#9aa2af]">
                  saving in {g.account_name}{g.counted_from ? ` · ${g.counted_from}` : ''}
                </span>
              )}
            </span>
            <span className="hidden min-w-0 sm:block">
              <span className="block text-[12.5px] tabular-nums text-[#79818f]">
                {g.target_cents ? dollars(g.target_cents / 100) : ''}{g.target_cents && g.by_date ? ' by ' : ''}{longDate(g.by_date)}
              </span>
              {/* Progress from the linked account — the reason for linking one */}
              {g.progress != null && (
                <span className="mt-1 flex items-center gap-2">
                  <span className="h-1.5 w-full max-w-[180px] rounded-full bg-[#f1f3f7]">
                    <span className="block h-1.5 rounded-full bg-[#0f9d6e]" style={{ width: `${Math.max(g.progress * 100, 1)}%` }} />
                  </span>
                  <span className="whitespace-nowrap text-[11.5px] tabular-nums text-[#0f7a52]"
                    title={g.account_balance_cents != null
                      ? `Counts the ${g.counted_from} in ${g.account_name} — the money that never gets spent. The balance today is ${dollars(g.account_balance_cents / 100)}.`
                      : undefined}>
                    {dollars(g.current_cents / 100)} counted · {Math.round(g.progress * 100)}%
                  </span>
                </span>
              )}
            </span>
            <span className="justify-self-end whitespace-nowrap text-[12.5px] font-[550] tabular-nums text-[#5b4bd6]">
              {g.needs_per_month_cents === 0 ? <span className="text-[#0f7a52]">fully funded</span>
                : g.needs_per_month_cents ? `needs ${dollars(g.needs_per_month_cents / 100)}/mo` : ''}
            </span>
            <span className="hidden justify-self-end sm:flex">
              <button aria-label={`Edit ${g.text}`} onClick={() => setEditing(g.id)}
                className="h-[26px] w-[26px] cursor-pointer rounded text-[#c2c8d2] hover:bg-[#f1f3f7] hover:text-[#5d6674]">✎</button>
              <button aria-label={`Remove ${g.text}`}
                onClick={() => { if (window.confirm(`Remove the goal “${g.text}”?`)) del(`/budget-goals/${g.id}`).then(() => { loadGoals(); setGoalsChanged(true) }) }}
                className="h-[26px] w-[26px] cursor-pointer rounded text-[#c2c8d2] hover:bg-[#f1f3f7] hover:text-[#5d6674]">✕</button>
            </span>
          </div>
        )))}

        {adding && <GoalForm accounts={accounts} onCancel={() => setAdding(false)}
          onSaved={() => { setAdding(false); loadGoals(); setGoalsChanged(true) }} onError={setError} />}

        {goalsNeed > 0 && (
          <p className="border-t border-[#eef0f4] bg-[#fcfcfd] px-4 py-2.5 text-[12px] text-[#79818f]">
            Together these need <span className="font-semibold tabular-nums text-[#3f4753]">{dollars(goalsNeed / 100)}/mo</span>
          </p>
        )}
      </div>

      {/* Run card: a long job gets a progress surface, not a disabled button */}
      <div className={cn(CARD, running ? 'overflow-hidden' : 'p-3.5')}>
        {running ? (
          <div role="status" aria-live="polite" className="flex items-start gap-3 bg-[#faf9ff] px-4 py-3.5">
            <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#ddd8f7] border-t-[#5b4bd6]" />
            <span>
              <span className="block text-[13px] font-semibold text-[#4b3cc4]">
                Reading {months} months of spending and weighing it against your goals
              </span>
              <span className="mt-0.5 block text-[11.5px] text-[#8177c9]">Takes about a minute.</span>
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Input className="min-w-[15rem] flex-1" value={note} onChange={e => setNote(e.target.value)}
              placeholder={'Anything it should know — "don\'t touch groceries, we\'re feeding four"'} />
            <Select value={months} onChange={e => setMonths(+e.target.value)}>
              {[3, 6, 12].map(m => <option key={m} value={m}>Read {m} months</option>)}
            </Select>
            <button onClick={run} disabled={!aiReady}
              className="flex h-9 cursor-pointer items-center gap-[7px] rounded-[9px] border border-[#ddd8f7] px-[13px] text-[13px] font-[550] text-[#5b4bd6] hover:bg-[#f7f5ff] disabled:opacity-60">
              <span className="text-[11px]">✦</span>{plan ? 'Run again' : 'Run the planner'}
            </button>
          </div>
        )}
        {!aiReady && (
          <p className="mt-2 rounded-md border border-[#f5c9a8] bg-[#fdf2e9] px-3 py-2 text-[12.5px] text-[#a8500f]">
            {ai.apiKeySet ? 'AI is switched off in Settings.' : 'No Anthropic API key is set.'} Add one in Settings to use the planner —
            you can still set targets by hand on the Targets tab.
          </p>
        )}
        {/* A failure gets an error and a retry, never a dead control */}
        {error && !running && (
          <p className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
            {error}
            <button onClick={run} className="cursor-pointer font-[550] underline">Retry</button>
          </p>
        )}
      </div>

      {plan && <PlanCard plan={plan} month={month} goalsChanged={goalsChanged}
        onApply={apply} onAdjust={onAdjust} onDismiss={() => setPlan(null)}
        onDelete={() => {
          if (!window.confirm('Delete this plan? Any targets it already applied stay on the Targets tab.')) return
          del(`/budgets/plans/${plan.id}`).then(() => { setPlan(null); loadHistory() })
        }} />}

      {history.length > 0 && (
        <div className={cn(CARD, 'overflow-hidden')}>
          <p className="px-4 pb-2.5 pt-3.5 text-[13.5px] font-[650]">Earlier plans <span className="font-[450] text-[#9aa2af]">· {history.length}</span></p>
          {history.slice(0, 8).map(h => (
            <div key={h.id} className="grid grid-cols-[74px_1fr_auto_auto] items-center gap-3 border-t border-[#f4f6f8] px-4 py-2.5 text-[12.5px] hover:bg-[#fafbfe]">
              <span className="text-[12px] text-[#79818f]">{longDate(h.created_at)}</span>
              {/* Extracted prose only — a malformed payload falls back, never leaks */}
              <span className="truncate text-[#5d6674]">{h.summary || `Plan from ${longDate(h.created_at)}`}</span>
              <span className={cn('justify-self-end rounded-full px-2.5 py-[3px] text-[11px] font-[550]',
                h.applied_at ? 'bg-[#e8f5ee] text-[#0f7a52]' : 'bg-[#f1f3f7] text-[#5d6674]')}>
                {h.applied_at ? 'applied' : 'not applied'}
              </span>
              <span className="flex items-center gap-2 justify-self-end">
                <button onClick={() => get(`/budgets/plans/${h.id}`).then(p => { setPlan(p); setGoalsChanged(false) })}
                  className="cursor-pointer text-[12.5px] text-[#2563eb] hover:underline">View</button>
                {/* Deleting the record leaves any targets it already wrote in place */}
                <button aria-label={`Delete the plan from ${longDate(h.created_at)}`}
                  onClick={() => {
                    const warn = h.applied_at
                      ? 'Delete this plan? The targets it applied stay on the Targets tab — clear them there if you want them gone.'
                      : 'Delete this plan?'
                    if (!window.confirm(warn)) return
                    del(`/budgets/plans/${h.id}`).then(() => { if (plan?.id === h.id) setPlan(null); loadHistory() })
                  }}
                  className="h-[22px] w-[22px] cursor-pointer rounded text-[#c2c8d2] hover:bg-[#f1f3f7] hover:text-[#5d6674]">✕</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PlanCard({ plan, month, goalsChanged, onApply, onAdjust, onDismiss, onDelete }: any) {
  const t = plan.totals || {}
  const changes = plan.proposals || []
  return (
    <div className={cn(CARD, 'animate-pop-in overflow-hidden')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2.5 pt-3.5">
        <p className="flex items-center gap-[7px] text-[13.5px] font-[650]">
          <span className="text-[11px] text-[#a99ff0]">✦</span>Proposed plan
        </p>
        <p className="text-[11.5px] text-[#a4abb8]">
          {dateTime(plan.created_at)}{plan.window && ` · ${plan.window}`}
          {plan.goalCount ? ` · ${plan.goalCount} goal${plan.goalCount === 1 ? '' : 's'}` : ''}
        </p>
      </div>

      {goalsChanged && (
        <p className="border-y border-[#f5e6c9] bg-[#fdf6e3] px-4 py-2 text-[12px] text-[#8a6516]">
          Goals changed since this plan ran — run it again to re-check the verdict.
        </p>
      )}

      {/* Verdict: two computed figures, and prose that is allowed to say no */}
      <div className="flex flex-wrap items-start gap-5 border-y border-[#eef0f4] bg-[#faf9ff] px-4 py-3.5">
        {t.goals_need_per_month_cents > 0 && (
          <Stat label="Goals need" cents={t.goals_need_per_month_cents} colour="#4b3cc4" />
        )}
        <Stat label="This plan frees" cents={t.frees_per_month_cents ?? 0} colour="#0f7a52" />
        <p className="min-w-[16rem] flex-1 text-[13px] leading-relaxed text-[#3f4753] [text-wrap:pretty]">
          {plan.summary || 'No summary came back with this plan.'}
          {/* Where the freed money is being sent, when the plan names a new line for it */}
          {t.newly_budgeted_per_month_cents > 0 && (
            <span className="mt-1.5 block text-[12px] text-[#79818f]">
              Plus {dollars(t.newly_budgeted_per_month_cents / 100)}/mo newly budgeted
              {t.newly_budgeted?.length ? ` for ${t.newly_budgeted.join(', ')}` : ''} — no spending history to compare against.
            </span>
          )}
        </p>
      </div>

      {changes.length === 0 && (
        <p className="px-4 py-8 text-center text-[13px] text-[#9aa2af]">This plan proposes no changes.</p>
      )}
      {changes.map((c: any) => {
        const from = c.currentAvgCents ?? c.currentPerMonthCents
        const frees = from != null ? from - c.proposedPerMonthCents : null
        return (
          <div key={c.categoryId} className="grid min-h-[52px] grid-cols-1 items-center gap-x-3.5 gap-y-1 border-t border-[#f4f6f8] px-4 py-2.5 hover:bg-[#fafbfe] lg:grid-cols-[minmax(170px,260px)_1fr_200px_110px]">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: groupColour(String(c.name).split(' › ')[0], null).dot }} />
              <span className="truncate text-[13px] font-semibold">{c.name}</span>
            </span>
            <span className="text-[12px] leading-snug text-[#79818f] [text-wrap:pretty]">{c.reason}</span>
            <span className="whitespace-nowrap text-[13px] tabular-nums lg:justify-self-end">
              {from != null && <><span className="text-[#9aa2af]">avg {dollars(from / 100)}</span> <span className="text-[#c2c8d2]">→</span> </>}
              <span className="font-semibold">{dollars(c.proposedCents / 100)}</span>
              {c.period !== 'monthly' && <span className="text-[#9aa2af]">/{c.period === 'yearly' ? 'yr' : 'qtr'}</span>}
            </span>
            <span className="text-[13px] font-semibold tabular-nums lg:justify-self-end"
              style={{ color: frees != null && frees > 0 ? '#0f7a52' : '#9aa2af' }}>
              {frees != null && frees !== 0 ? `${frees > 0 ? '−' : '+'}${dollars(Math.abs(frees) / 100)}/mo` : ''}
            </span>
          </div>
        )
      })}

      {plan.conflicts?.length > 0 && (
        <div className="border-t border-[#f4f6f8] bg-[#fdf2e9] px-4 py-2.5 text-[12.5px] text-[#a8500f]">
          {plan.conflicts.map((c: any) => (
            <p key={c.categoryId}>{c.name}: proposed {money(c.proposedPerMonthCents)}/mo, but recurring bills already commit {money(c.committedPerMonthCents)}/mo.</p>
          ))}
        </div>
      )}

      {changes.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#eef0f4] bg-[#fcfcfd] px-4 py-3">
          <span className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onApply}>Apply {changes.length} target{changes.length === 1 ? '' : 's'}</Button>
            {/* Leaves the plan intact on this tab — you can come back and apply it */}
            <Button size="sm" variant="outline" onClick={onAdjust}>Adjust in Targets first</Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
            <Button size="sm" variant="ghost" className="text-red-600" onClick={onDelete}>Delete</Button>
          </span>
          <p className="text-[12px] text-[#9aa2af]">
            {plan.untouched?.count > 0
              ? `Leaves ${plan.untouched.count} categor${plan.untouched.count === 1 ? 'y' : 'ies'} untouched${plan.untouched.names?.length ? ` — ${plan.untouched.names.slice(0, 4).join(', ')}` : ''}`
              : `Applies from ${month}, earlier months are untouched`}
          </p>
        </div>
      )}
    </div>
  )
}

function Stat({ label, cents, colour }: { label: string; cents: number; colour: string }) {
  return (
    <span className="shrink-0">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.055em] text-[#8177c9]">{label}</span>
      <span className="text-[20px] font-[650] tabular-nums" style={{ color: colour }}>
        {dollars(cents / 100)}<span className="text-[13px] font-[550] text-[#8177c9]">/mo</span>
      </span>
    </span>
  )
}

// One form, used to add a goal and to edit one in place.
function GoalForm({ goal, accounts, onCancel, onSaved, onError }: {
  goal?: any; accounts: any[]; onCancel: () => void; onSaved: () => void; onError: (m: string) => void
}) {
  const [text, setText] = useState(goal?.text ?? '')
  const [amount, setAmount] = useState(goal?.target_cents != null ? String(goal.target_cents / 100) : '')
  const [by, setBy] = useState(goal?.by_date ? String(goal.by_date).slice(0, 10) : '')
  const [accountId, setAccountId] = useState(goal?.account_id ?? '')
  const [busy, setBusy] = useState(false)
  const field = 'h-8 rounded-lg border border-[#dfe3ea] px-2.5 text-[12.5px] focus:border-[#93b4fb] focus:outline-none focus:ring-[3px] focus:ring-[rgba(37,99,235,0.10)]'

  const save = async () => {
    setBusy(true)
    const body = {
      text,
      targetCents: amount.trim() ? Math.round(parseFloat(amount) * 100) : null,
      byDate: by || null,
      accountId: accountId || null,
    }
    try {
      if (goal) await patch(`/budget-goals/${goal.id}`, body)
      else await post('/budget-goals', body)
      onSaved()
    } catch (e) { onError((e as Error).message) }
    setBusy(false)
  }

  return (
    <div className="border-t border-[#f4f6f8] bg-[#fbfcfd] px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input autoFocus className={cn(field, 'max-w-[260px] flex-1')} placeholder="Emergency fund" aria-label="Goal name"
          value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && text.trim()) save(); if (e.key === 'Escape') onCancel() }} />
        <input className={cn(field, 'w-[130px]')} type="number" min="0" step="0.01" placeholder="Amount" aria-label="Goal amount"
          value={amount} onChange={e => setAmount(e.target.value)} />
        <input className={field} type="date" aria-label="Goal date" value={by} onChange={e => setBy(e.target.value)} />
        {/* Linking an account makes its balance count toward the goal */}
        <select className={cn(field, 'cursor-pointer')} aria-label="Account holding this money"
          value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">Not linked to an account</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <Button size="sm" disabled={!text.trim() || busy} onClick={save}>{goal ? 'Save' : 'Add'}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <p className="mt-1.5 text-[11.5px] text-[#9aa2af]">
        Link the account you're saving into and it counts toward this goal, so the monthly figure solves
        for what's left. It counts the <strong className="font-[550]">lowest balance over the last 3 months</strong> — the money that
        never gets spent — so bills moving in and out of a working account don't make the progress jump around.
      </p>
    </div>
  )
}
