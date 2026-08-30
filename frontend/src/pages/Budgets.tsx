// Budgets — rebuilt to the "Budgets redesign" handoff spec. Two tabs: Targets
// (pace-notched bars, averages as the reference number, inline editing) and Plan
// with AI. Targets are per-month values carried forward, so the month stepper
// changes what you're looking at without rewriting history.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { get, post, put } from '../lib/api'
import { Spinner, cn } from '../components/ui'
import { money, dollars } from '../lib/format'
import { groupColour } from '../lib/categories'
import { BudgetPlanner } from '../components/BudgetPlanner'

const CARD = 'rounded-xl border border-[#e8ebf0] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]'
const LABEL = 'text-[11px] font-semibold uppercase tracking-[0.055em] text-[#8b93a1]'
// Ahead of pace once spending outruns the calendar by a third — a product constant
const AHEAD_MULTIPLIER = 1.35

const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + by, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const monthLabel = (month: string, opts: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' }) => {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-AU', opts)
}

// A bar plus the shared "today" notch. Every row's notch sits at the same fraction,
// so they line up into a vertical today line down the card.
function PaceBar({ spent, target, colour, pace, label }: {
  spent: number; target: number; colour: string; pace: number; label: string
}) {
  const used = target > 0 ? spent / target : 0
  return (
    <div className="relative h-1.5 rounded-full bg-[#f1f3f7]" role="img" aria-label={label}>
      <span className="block h-1.5 rounded-full"
        style={{ width: `${Math.min(Math.max(used * 100, spent > 0 ? 0.5 : 0), 100)}%`, backgroundColor: colour }} />
      {pace > 0 && pace < 1 && (
        <span aria-hidden className="absolute -top-[3px] -bottom-[3px] w-0.5 bg-[#8b93a1]"
          style={{ left: `${pace * 100}%` }} />
      )}
    </div>
  )
}

const rowStatus = (spent: number, target: number, pace: number) => {
  if (target > 0 && spent >= target) return { text: 'Over budget', cls: 'text-[#a33b37]' }
  if (target > 0 && pace > 0 && (spent / target) > pace * AHEAD_MULTIPLIER) return { text: 'Ahead of pace', cls: 'text-[#c2540a]' }
  return { text: 'On track', cls: 'text-[#79818f]' }
}

export default function Budgets() {
  const [params, setParams] = useSearchParams()
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [data, setData] = useState<any>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('budget-collapsed') || '[]')) } catch { return new Set() }
  })
  const toggleCollapse = (id: string) => setCollapsed(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    localStorage.setItem('budget-collapsed', JSON.stringify([...next]))
    return next
  })
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const tab = params.get('tab') === 'plan' ? 'plan' : 'targets'
  const setTab = (t: string) => setParams(t === 'plan' ? { tab: 'plan' } : {}, { replace: true })

  const load = useCallback(() => {
    get(`/budgets?month=${month}`).then(setData).catch(e => setError(e.message))
  }, [month])
  useEffect(() => { load() }, [load])

  const save = async (categoryId: string, amountCents: number | null) => {
    setError('')
    try { await put('/budgets', { categoryId, amountCents, period: 'monthly', effectiveFrom: month }); load() }
    catch (e) { setError((e as Error).message) }
  }

  // Open the transactions behind a figure, over the same window the figure counts.
  // A monthly target means this month; a yearly one means the financial year.
  const drill = (categoryId: string, from?: string, to?: string) => {
    sessionStorage.setItem('tx-filter', JSON.stringify({
      category: categoryId, from: from ?? data.monthFrom, to: to ?? data.monthTo,
    }))
    navigate('/transactions')
  }

  if (!data) return error ? <p className="text-red-600">{error}</p> : <Spinner />

  const { rows, totals, pace } = data
  const paceFraction = pace?.fraction ?? 0
  // A target can sit on a category or on one of its sub-categories, so the list is
  // a hierarchy, not a flat set: sub-rows nest under their parent and the parent
  // heading carries the roll-up. A parent's own target is authoritative for
  // everything beneath it, so when it has one the sub-targets are limits inside
  // it and the two are never summed.
  const sections = rows.map((g: any) => {
    const tag = (r: any) => ({ ...r, groupName: g.name, groupColour: g.colour })
    const subs = g.subs.map(tag)
    const budgetedSubs = subs.filter((s: any) => s.target_cents != null)
    return {
      g: tag(g), budgetedSubs, openSubs: subs.filter((s: any) => s.target_cents == null),
      // In the budgeted card either as a target of its own, or as a roll-up of its subs
      inBudgeted: g.target_cents != null || budgetedSubs.length > 0,
      // Settable in the not-budgeted card only when it isn't already represented above
      parentOpen: g.target_cents == null && budgetedSubs.length === 0,
    }
  })
  const budgetedSections = sections.filter((s: any) => s.inBudgeted)
  const openSections = sections.filter((s: any) => s.parentOpen || s.openSubs.length > 0)

  const flat: any[] = rows.flatMap((g: any) => [g, ...g.subs])
  const budgeted = flat.filter(r => r.target_cents != null)
  // What the card below actually lists — a parent shown above as a roll-up isn't
  // "not budgeted", even though it carries no target of its own
  const openCount = openSections.reduce((n: number, s: any) => n + (s.parentOpen ? 1 : 0) + s.openSubs.length, 0)

  const spentPct = totals.target_per_month_cents ? totals.month_spent_cents / totals.target_per_month_cents : 0
  const aheadNames = budgeted
    .filter(r => !r.is_income && rowStatus(r.spent_cents, r.target_cents, paceFraction).text === 'Ahead of pace')
    .map(r => r.name)

  const subtitle = totals.budgeted_count > 0
    ? `${totals.budgeted_count} categor${totals.budgeted_count === 1 ? 'y' : 'ies'} with a target · ${dollars(totals.target_per_month_cents / 100)}/mo budgeted`
    : `No targets set for ${monthLabel(month, { month: 'long' })} · ${flat.length} categories available`

  return (
    <div className="space-y-3">
      {/* Header: the month stepper sits next to what it controls */}
      <div className="mb-1 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-[650] tracking-[-0.02em] text-[#171b22]">Budgets</h1>
          <p className="mt-1 text-[13px] text-[#79818f]">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1">
          <StepButton label="Previous month" onClick={() => setMonth(m => shiftMonth(m, -1))}>‹</StepButton>
          <span className="min-w-[118px] text-center text-[13.5px] font-semibold">{monthLabel(month)}</span>
          <StepButton label="Next month" onClick={() => setMonth(m => shiftMonth(m, 1))}>›</StepButton>
        </div>
      </div>

      <div className="mb-1 flex gap-1" role="tablist">
        {([['targets', 'Targets'], ['plan', 'Plan with AI']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('flex h-8 cursor-pointer items-center gap-[7px] rounded-lg px-[13px] text-[13px]',
              tab === k ? 'bg-[#f1f3f7] font-semibold text-[#171b22]' : 'font-[450] text-[#5d6674] hover:bg-[#f7f8fa]')}>
            {k === 'plan' && <span className="text-[11px] text-[#a99ff0]">✦</span>}{l}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {tab === 'plan' ? (
        <BudgetPlanner month={month} onApplied={() => { load(); setTab('targets') }} onAdjust={() => setTab('targets')} />
      ) : (
        <>
          {/* Summary: one bar, the notch on it, pace explained in words */}
          <div className={cn(CARD, 'p-4')}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className={LABEL}>Budgeted per month</p>
                <p className="text-[26px] font-[650] tabular-nums tracking-[-0.025em]">{money(totals.target_per_month_cents)}</p>
              </div>
              <div className="text-right">
                <p className={LABEL}>Spent so far</p>
                <p className="text-[26px] font-[650] tabular-nums tracking-[-0.025em] text-[#3f4753]">{money(totals.month_spent_cents)}</p>
              </div>
            </div>
            <div className="mt-3">
              <PaceBar spent={totals.month_spent_cents} target={totals.target_per_month_cents} colour="#2563eb"
                pace={paceFraction}
                label={`${money(totals.month_spent_cents)} spent of ${money(totals.target_per_month_cents)} budgeted, ${Math.round(paceFraction * 100)}% of the month elapsed`} />
            </div>
            <p className="mt-2.5 text-[12px] text-[#79818f]">
              {totals.target_per_month_cents === 0
                ? 'No targets yet — fill them from your averages below, or let the planner propose a set.'
                : <>
                  {(spentPct * 100).toFixed(1)}% spent with {(paceFraction * 100).toFixed(1)}% of the month gone
                  {' — '}{spentPct > paceFraction * AHEAD_MULTIPLIER ? 'running ahead overall' : 'on pace overall'}.
                  {aheadNames.length > 0 && ` ${aheadNames.slice(0, 3).join(', ')} ${aheadNames.length === 1 ? 'is' : 'are'} running ahead.`}
                </>}
            </p>
          </div>

          {/* Only rendered when something is budgeted — an empty card is worse than none */}
          {budgeted.length > 0 && (
            <div className={cn(CARD, 'overflow-hidden')}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2.5 pt-3.5">
                <p className="text-[13.5px] font-[650]">Budgeted <span className="font-[450] text-[#9aa2af]">· {budgeted.length} of {flat.length} categories</span></p>
                <p className="text-[12px] text-[#9aa2af]">The notch marks today — {Math.round(paceFraction * 100)}% through the month</p>
              </div>
              {budgetedSections.map(({ g, budgetedSubs }: any) => {
                const row = (r: any, indent?: boolean) => (
                  <BudgetedRow key={r.id} r={r} pace={paceFraction} indent={indent} onEdit={() => setEditing(r.id)}
                    editing={editing === r.id} onCancel={() => setEditing(null)}
                    onSave={(cents: number) => { setEditing(null); save(r.id, cents) }}
                    onRemove={() => save(r.id, null)}
                    onView={(from?: string, to?: string) => drill(r.id, from, to)} />
                )
                const open = !collapsed.has(g.id)
                const caret = budgetedSubs.length
                  ? <Caret open={open} name={g.name} count={budgetedSubs.length} onClick={() => toggleCollapse(g.id)} />
                  : null
                return (
                  <div key={g.id}>
                    {g.target_cents != null
                      ? <BudgetedRow r={g} pace={paceFraction} caret={caret} onEdit={() => setEditing(g.id)}
                        editing={editing === g.id} onCancel={() => setEditing(null)}
                        onSave={(cents: number) => { setEditing(null); save(g.id, cents) }}
                        onRemove={() => save(g.id, null)}
                        onView={(from?: string, to?: string) => drill(g.id, from, to)} />
                      : <RollupHeader g={g} subs={budgetedSubs} pace={paceFraction} caret={caret}
                        onSetTarget={() => setEditing(g.id)} editing={editing === g.id}
                        onCancel={() => setEditing(null)}
                        onSave={(cents: number) => { setEditing(null); save(g.id, cents) }}
                        onView={() => drill(g.id)} />}
                    {open && budgetedSubs.map((s: any) => row(s, true))}
                  </div>
                )
              })}
            </div>
          )}

          {openCount > 0 && (
            <div className={cn(CARD, 'overflow-hidden')}>
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2.5 pt-3.5">
                <p className="text-[13.5px] font-[650]">Not budgeted <span className="font-[450] text-[#9aa2af]">· {openCount} categories</span></p>
                <span className="flex items-center gap-2">
                  <button disabled={busy} onClick={async () => {
                    // Parents only — a parent target already covers its subs, so filling
                    // both would set two competing numbers for the same spending.
                    const fillable = openSections.filter((s: any) => s.parentOpen && !s.g.is_income && s.g.avg_per_month_cents).map((s: any) => s.g)
                    if (!fillable.length) { setError('No spending history to fill from yet.'); return }
                    if (!window.confirm(`Set ${fillable.length} target${fillable.length === 1 ? '' : 's'} from your ${fillable[0].avg_window ?? 'recent'} averages?`)) return
                    setBusy(true)
                    try {
                      for (const r of fillable) await put('/budgets', { categoryId: r.id, amountCents: roundTo(r.avg_per_month_cents), period: 'monthly', effectiveFrom: month })
                      load()
                    } catch (e) { setError((e as Error).message) }
                    setBusy(false)
                  }}
                    className="h-[30px] cursor-pointer rounded-lg border border-[#e5e8ee] px-[11px] text-[12.5px] text-[#5d6674] hover:bg-[#f7f8fa] disabled:opacity-60">
                    {busy ? 'Setting…' : 'Fill from my averages'}
                  </button>
                  {budgeted.length === 0 && (
                    <button onClick={() => setTab('plan')}
                      className="flex h-[30px] cursor-pointer items-center gap-[7px] rounded-lg border border-[#ddd8f7] px-[11px] text-[12.5px] font-[550] text-[#5b4bd6] hover:bg-[#f7f5ff]">
                      <span className="text-[11px]">✦</span>Plan with AI
                    </button>
                  )}
                </span>
              </div>
              {openSections.map(({ g, openSubs, parentOpen }: any) => {
                const row = (r: any, indent?: boolean) => (
                  <UnbudgetedRow key={r.id} r={r} indent={indent} editing={editing === r.id} onView={() => drill(r.id)}
                    onEdit={() => setEditing(r.id)} onCancel={() => setEditing(null)}
                    onSave={(cents: number) => { setEditing(null); save(r.id, cents) }} />
                )
                const open = !collapsed.has(g.id)
                const caret = openSubs.length
                  ? <Caret open={open} name={g.name} count={openSubs.length} onClick={() => toggleCollapse(g.id)} />
                  : null
                return (
                  <div key={g.id}>
                    {/* Already budgeted above, but its sub-categories still need a home */}
                    {parentOpen
                      ? <UnbudgetedRow r={g} caret={caret} editing={editing === g.id} onView={() => drill(g.id)}
                        onEdit={() => setEditing(g.id)} onCancel={() => setEditing(null)}
                        onSave={(cents: number) => { setEditing(null); save(g.id, cents) }} />
                      : <ParentCaption r={g} caret={caret} hidden={open ? 0 : openSubs.length} />}
                    {open && openSubs.map((s: any) => row(s, true))}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Targets are round numbers — nobody budgets $317.43
const roundTo = (cents: number) => Math.round(cents / 500) * 500

function StepButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button aria-label={label} onClick={onClick}
      className="grid h-9 w-9 cursor-pointer place-items-center rounded-[9px] border border-[#dfe3ea] text-[#4b5462] hover:bg-[#f7f8fa]">
      {children}
    </button>
  )
}

function AmountEditor({ initial, name, onSave, onCancel }: {
  initial: number | null; name: string; onSave: (cents: number) => void; onCancel: () => void
}) {
  const [v, setV] = useState(initial != null ? String(Math.round(initial / 100)) : '')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const commit = () => {
    const cents = Math.round(parseFloat(v) * 100)
    if (Number.isFinite(cents) && cents >= 0) onSave(cents)
    else onCancel()
  }
  return (
    <span className="flex items-center justify-end gap-1.5">
      <input ref={ref} type="number" min="0" step="1" aria-label={`Monthly target for ${name}`}
        value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onCancel() }}
        className="h-7 w-[92px] rounded-lg border border-[#93b4fb] px-2 text-right text-[12.5px] focus:outline-none focus:ring-[3px] focus:ring-[rgba(37,99,235,0.10)]" />
      <button onClick={commit} className="h-7 cursor-pointer rounded-lg bg-[#2563eb] px-2.5 text-[12px] font-[550] text-white hover:bg-[#1d4ed8]">Set</button>
      <button onClick={onCancel} aria-label="Cancel" className="h-6 w-6 cursor-pointer rounded text-[#c2c8d2] hover:bg-[#f1f3f7] hover:text-[#5d6674]">✕</button>
    </span>
  )
}

function BudgetedRow({ r, pace, indent, caret, editing, onEdit, onCancel, onSave, onRemove, onView }: any) {
  const colour = groupColour(r.groupName ?? r.name, r.groupColour ?? r.colour).dot
  const st = rowStatus(r.spent_cents, r.target_cents, pace)
  return (
    <div className={cn('grid min-h-12 grid-cols-[minmax(104px,2.2fr)_1fr_auto_auto] items-center gap-2.5 lg:gap-3.5 border-t border-[#f4f6f8] pr-4 py-2 hover:bg-[#fafbfe] lg:grid-cols-[minmax(190px,300px)_1fr_170px_104px_32px]',
      indent ? 'pl-14' : 'pl-4')}>
      <span className="flex min-w-0 items-center gap-2">
        <CaretSlot caret={caret} indent={indent} />
        <Dot colour={colour} indent={indent} />
        <span className={cn('truncate text-[13px]', indent ? 'font-[450] text-[#3f4753]' : 'font-semibold')}>{r.name}</span>
      </span>
      <PaceBar spent={r.spent_cents} target={r.target_cents} colour={colour} pace={pace}
        label={`${r.name}: ${money(r.spent_cents)} spent of ${money(r.target_cents)} target, ${Math.round((r.spent_cents / (r.target_cents || 1)) * 100)}% used, ${Math.round(pace * 100)}% of month elapsed`} />
      {editing ? (
        <span className="col-span-3 justify-self-end lg:col-span-3">
          <AmountEditor initial={r.target_cents} name={r.name} onSave={onSave} onCancel={onCancel} />
        </span>
      ) : (
        <>
          <button onClick={() => onView(r.window?.from, r.window?.to)}
            title={`See the ${r.name} transactions behind this figure (${r.window?.label === 'month' ? 'this month' : r.window?.label})`}
            className="cursor-pointer justify-self-end whitespace-nowrap rounded-md px-1.5 py-0.5 text-[13px] tabular-nums hover:bg-[#eef3ff] hover:text-[#2563eb]">
            <span className="font-semibold">{money(r.spent_cents)}</span>
            <span className="text-[#9aa2af]"> / {dollars(r.target_cents / 100)}</span>
          </button>
          <span className={cn('hidden justify-self-end text-[12px] font-[550] lg:block', st.cls)}>{st.text}</span>
          <RowMenu onEdit={onEdit} onRemove={onRemove} onView={onView} name={r.name} />
        </>
      )}
    </div>
  )
}

function UnbudgetedRow({ r, indent, caret, editing, onEdit, onCancel, onSave, onView }: any) {
  const colour = groupColour(r.groupName ?? r.name, r.groupColour ?? r.colour).dot
  return (
    <div className={cn('grid min-h-11 grid-cols-[minmax(150px,1fr)_auto] items-center gap-3.5 border-t border-[#f4f6f8] pr-4 py-2 hover:bg-[#fafbfe] lg:grid-cols-[minmax(190px,300px)_1fr_150px_130px]',
      indent ? 'pl-14' : 'pl-4')}>
      <span className="flex min-w-0 items-center gap-2">
        <CaretSlot caret={caret} indent={indent} />
        <Dot colour={colour} indent={indent} />
        <span className={cn('truncate text-[13px]', indent && 'text-[#3f4753]')}>{r.name}</span>
        {r.is_income && <span className="shrink-0 rounded-full bg-[#e8f5ee] px-1.5 py-px text-[10.5px] font-[550] text-[#0f7a52]">money in</span>}
      </span>
      {/* The average is what makes "Set target" answerable; this month's spend is not */}
      <span className="hidden text-[12px] tabular-nums text-[#9aa2af] lg:block">
        {r.avg_per_month_cents ? `avg ${dollars(r.avg_per_month_cents / 100)}/mo over ${r.avg_window}` : 'no history yet'}
      </span>
      <span className="hidden justify-self-end text-[13px] tabular-nums lg:block">
        {r.month_spent_cents > 0
          ? <button onClick={() => onView()} title={`See the ${r.name} transactions behind this figure (this month)`}
            className="cursor-pointer rounded-md px-1.5 py-0.5 text-[#3f4753] hover:bg-[#eef3ff] hover:text-[#2563eb]">
            {money(r.month_spent_cents)} so far
          </button>
          : <span className="text-[#c2c8d2]">—</span>}
      </span>
      <span className="justify-self-end">
        {editing
          ? <AmountEditor initial={r.avg_per_month_cents ? roundTo(r.avg_per_month_cents) : null} name={r.name} onSave={onSave} onCancel={onCancel} />
          : <button onClick={onEdit}
            className="cursor-pointer rounded-full border border-dashed border-[#d8dde5] px-[11px] py-1 text-[12.5px] text-[#8b93a1] hover:border-[#93b4fb] hover:text-[#2563eb]">
            ＋ Set target
          </button>}
      </span>
    </div>
  )
}

// The empty slot on childless parents is deliberate: without it their names sit
// 16px left of everything else and the column stops reading as a column.
function Caret({ open, count, name, onClick }: { open: boolean; count: number; name: string; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${name} (${count} sub-categor${count === 1 ? 'y' : 'ies'})`}
      className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded text-[8px] text-[#b6bcc7] hover:bg-[#eceff4] hover:text-[#4b5462]">
      <span className={cn('transition-transform', open && 'rotate-90')}>▶</span>
    </button>
  )
}
const CaretSlot = ({ caret, indent }: any) => indent ? null : (caret ?? <span className="h-4 w-4 shrink-0" />)

// Parent solid, child hollow — the hierarchy survives the row being scanned, not read
function Dot({ colour, indent }: { colour: string; indent?: boolean }) {
  return indent
    ? <span className="h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]" style={{ borderColor: colour }} />
    : <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: colour }} />
}

// A category with no target of its own but targets on its sub-categories. The
// heading is the roll-up of those subs — it is not a target you set, so there is
// nothing to remove, only a group-wide cap to add.
function RollupHeader({ g, subs, pace, caret, editing, onSetTarget, onCancel, onSave, onView }: any) {
  const colour = groupColour(g.name, g.colour).dot
  // Monthly-equivalent, because a yearly sub-target and a monthly one can't be
  // added as-is — $6,000/yr next to $300/mo is not $6,300 of anything.
  const target = subs.reduce((n: number, s: any) => n + (s.target_per_month_cents ?? 0), 0)
  const spent = subs.reduce((n: number, s: any) => n + s.month_spent_cents, 0)
  return (
    <div className="grid min-h-12 grid-cols-[minmax(104px,2.2fr)_1fr_auto_auto] items-center gap-2.5 lg:gap-3.5 border-t border-[#f4f6f8] bg-[#fcfdff] px-4 py-2 lg:grid-cols-[minmax(190px,300px)_1fr_170px_104px_32px]">
      <span className="flex min-w-0 items-center gap-2">
        <CaretSlot caret={caret} />
        <Dot colour={colour} />
        <span className="truncate text-[13px] font-semibold">{g.name}</span>
      </span>
      <PaceBar spent={spent} target={target} colour={colour} pace={pace}
        label={`${g.name}: ${money(spent)} spent of ${money(target)} across ${subs.length} sub-targets, ${Math.round(pace * 100)}% of month elapsed`} />
      {editing ? (
        <span className="col-span-3 justify-self-end">
          <AmountEditor initial={null} name={g.name} onSave={onSave} onCancel={onCancel} />
        </span>
      ) : (
        <>
          <button onClick={onView} title={`See every ${g.name} transaction behind this figure (this month)`}
            className="cursor-pointer justify-self-end whitespace-nowrap rounded-md px-1.5 py-0.5 text-[13px] tabular-nums hover:bg-[#eef3ff] hover:text-[#2563eb]">
            <span className="font-semibold">{money(spent)}</span>
            <span className="text-[#9aa2af]"> / {dollars(target / 100)}</span>
          </button>
          <span className="hidden justify-self-end text-[12px] text-[#9aa2af] lg:block">
            {subs.length} sub-target{subs.length === 1 ? '' : 's'}
          </span>
          <RowMenu name={g.name} editLabel="Set a target for the whole group"
            onEdit={onSetTarget} onView={onView} />
        </>
      )}
    </div>
  )
}

// The parent is budgeted (so it lives in the card above), but its remaining
// sub-categories still need to say where they belong.
function ParentCaption({ r, caret, hidden }: any) {
  return (
    <div className="flex items-center gap-2 border-t border-[#f4f6f8] px-4 pb-1 pt-2.5">
      <CaretSlot caret={caret} />
      <Dot colour={groupColour(r.name, r.colour).dot} />
      <span className="truncate text-[11.5px] font-[550] uppercase tracking-[0.04em] text-[#9aa2af]">{r.name}</span>
      {/* Collapsed, this caption would otherwise be a heading over nothing */}
      {hidden > 0 && <span className="shrink-0 text-[11.5px] text-[#c2c8d2]">· {hidden} hidden</span>}
    </div>
  )
}

const MENU_W = 176 // w-44

// The list card clips its contents (overflow-hidden, for the rounded corners), so
// an absolutely-positioned menu on the last row gets cut in half. Fixed position
// escapes that clip entirely — it just has to close on scroll, since it no longer
// travels with the row.
function RowMenu({ onEdit, onRemove, onView, name, editLabel = 'Edit target' }: any) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const open = pos != null
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setPos(null) }
    const close = () => setPos(null)
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (open) return setPos(null)
    const b = e.currentTarget.getBoundingClientRect()
    const height = onRemove ? 104 : 76
    // Flip above the row when there isn't room below it
    const below = window.innerHeight - b.bottom > height + 8
    setPos({ top: below ? b.bottom + 4 : b.top - height - 4, left: Math.max(8, b.right - MENU_W) })
  }
  const item = 'block w-full cursor-pointer px-3 py-1.5 text-left text-[13px] text-[#3f4753] hover:bg-gray-50'
  return (
    <div ref={ref} className="justify-self-end">
      <button onClick={toggle} aria-label={`Actions for ${name}`}
        className="h-[26px] w-[26px] cursor-pointer rounded-[7px] text-[#c2c8d2] hover:bg-[#f1f3f7] hover:text-[#4b5462]">⋯</button>
      {open && (
        <div style={{ top: pos.top, left: pos.left, width: MENU_W }}
          className="fixed z-50 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          <button className={item} onClick={() => { setPos(null); onEdit() }}>{editLabel}</button>
          <button className={item} onClick={() => { setPos(null); onView() }}>View transactions</button>
          {onRemove && <button className={cn(item, 'text-red-600')} onClick={() => { setPos(null); onRemove() }}>Remove target</button>}
        </div>
      )}
    </div>
  )
}
