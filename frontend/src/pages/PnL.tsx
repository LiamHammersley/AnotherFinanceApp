// P&L — rebuilt to the "P&L redesign" handoff spec: Income and Expenses sections
// with unsigned amounts (a sign only where a value contradicts its section), section
// totals, share-of-total bars, colour dots, and figures as clickable chips.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { get } from '../lib/api'
import { Spinner, cn } from '../components/ui'
import { date, financialYear, isoDate, money, monthLabel, signedMoney } from '../lib/format'
import { groupColour } from '../lib/categories'

const CARD = 'rounded-xl border border-[#e8ebf0] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]'
const LABEL = 'text-[11px] font-semibold uppercase tracking-[0.055em] text-[#8b93a1]'
const SELECT = 'h-8 cursor-pointer appearance-none rounded-[9px] border border-[#dfe3ea] bg-white bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2010%206%27%3E%3Cpath%20d=%27M1%201l4%204%204-4%27%20stroke=%27%239aa2af%27%20stroke-width=%271.5%27%20fill=%27none%27%20stroke-linecap=%27round%27/%3E%3C/svg%3E")] bg-[length:10px_6px] bg-[right_10px_center] bg-no-repeat py-0 pl-[11px] pr-7 text-[12.5px] text-[#39404b] focus:outline-none focus:ring-2 focus:ring-brand/30'
const NEG = '#c2540a'
const POS = '#0f7a52'

function rolling12() {
  const now = new Date()
  const from = new Date(now.getFullYear() - 1, now.getMonth() + 1, 1)
  return { from: isoDate(from), to: isoDate(now) }
}

const calendarYear = () => {
  const y = new Date().getFullYear()
  return { from: `${y}-01-01`, to: `${y}-12-31` }
}

// Period presets as tabs — exactly one active, "Custom range" is a peer that
// reveals the date inputs rather than a parallel always-visible mechanism.
const PRESETS = [
  { label: 'Rolling 12 months', range: rolling12 },
  { label: financialYear().label, range: () => financialYear() },
  { label: financialYear(-1).label, range: () => financialYear(-1) },
  { label: `Calendar ${new Date().getFullYear()}`, range: calendarYear },
  { label: 'Custom range', range: null },
]

export default function PnL() {
  const [preset, setPreset] = useState(0)
  const [range, setRange] = useState(rolling12())
  const [groupBy, setGroupBy] = useState<'month' | 'quarter' | 'year'>('month')
  const [account, setAccount] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [side, setSide] = useState<'all' | 'income' | 'expense'>('all')
  const [accounts, setAccounts] = useState<any[]>([])
  const [rows, setRows] = useState<any[] | null>(null)
  // Expand state survives navigating away and back within the session
  const [open, setOpen] = useState<Set<string>>(() => new Set(JSON.parse(sessionStorage.getItem('pnl-open') || '[]')))
  const navigate = useNavigate()

  useEffect(() => { sessionStorage.setItem('pnl-open', JSON.stringify([...open])) }, [open])
  useEffect(() => { get('/accounts?archived=true').then(setAccounts).catch(() => {}) }, [])
  useEffect(() => {
    setRows(null)
    const qs = new URLSearchParams({ from: range.from, to: range.to, groupBy })
    if (account) qs.set('account', account)
    if (includeArchived) qs.set('includeArchived', 'true')
    get(`/pnl?${qs}`).then(setRows)
  }, [range, groupBy, account, includeArchived])

  const { periods, income, expenses, totals, summary } = useMemo(() => {
    const empty = { periods: [] as string[], income: [] as any[], expenses: [] as any[], totals: {} as Record<string, number>, summary: { income: 0, expense: 0 } }
    if (!rows) return empty
    // Newest period on the left — the month you care about shouldn't need a scroll
    const periods = [...new Set(rows.map(r => r.month))].sort().reverse()
    const byCat = new Map<string, any>()
    for (const r of rows) {
      const key = r.category ?? 'Uncategorised'
      if (!byCat.has(key)) byCat.set(key, { name: key, id: r.category_id, colour: r.colour, is_income: r.is_income, cells: {}, total: 0, subs: new Map() })
      const c = byCat.get(key)
      const cents = Number(r.amount_cents)
      c.cells[r.month] = (c.cells[r.month] || 0) + cents
      c.total += cents
      if (r.sub_category) {
        const s = c.subs.get(r.sub_category) || { name: r.sub_category, id: r.sub_id, cells: {}, total: 0 }
        s.cells[r.month] = (s.cells[r.month] || 0) + cents
        s.total += cents
        c.subs.set(r.sub_category, s)
      }
    }
    const all = [...byCat.values()].sort((a, b) => a.name.localeCompare(b.name))
    const totals: Record<string, number> = {}
    for (const p of periods) totals[p] = all.reduce((sum, c) => sum + (c.cells[p] || 0), 0)
    const sum = (cats: any[]) => cats.reduce((n, c) => n + c.total, 0)
    const income = all.filter(c => c.is_income)
    const expenses = all.filter(c => !c.is_income)
    return { periods, income, expenses, totals, summary: { income: sum(income), expense: sum(expenses) } }
  }, [rows])

  // Column header: 2026-07 → Jul 2026, 2026-Q3 → Q3 2026, 2026 → 2026
  const periodLabel = (p: string) =>
    /^\d{4}-\d{2}$/.test(p) ? monthLabel(p) : p.replace(/^(\d{4})-(Q\d)$/, '$2 $1')

  const unit = groupBy === 'month' ? 'month' : groupBy === 'quarter' ? 'quarter' : 'year'

  // How many columns the range *could* have — the difference against the columns
  // actually returned is what the toolbar reports as hidden.
  const periodsInRange = useMemo(() => {
    const [fy, fm] = range.from.split('-').map(Number)
    const [ty, tm] = range.to.split('-').map(Number)
    if (!ty) return 0
    if (groupBy === 'year') return ty - fy + 1
    if (groupBy === 'quarter') return (ty * 4 + Math.ceil(tm / 3)) - (fy * 4 + Math.ceil(fm / 3)) + 1
    return (ty - fy) * 12 + (tm - fm) + 1
  }, [range, groupBy])
  const hidden = Math.max(0, periodsInRange - periods.length)

  // CSV of exactly what's on screen — signed cents in dollars, so a spreadsheet
  // can sum a column without unpicking the display sign convention.
  const exportCsv = () => {
    const esc = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`
    const dollars = (c?: number) => (c ? (c / 100).toFixed(2) : '')
    const lines = [['Category', 'Sub-category', ...periods.map(periodLabel), 'Total'].map(esc).join(',')]
    for (const c of [...income, ...expenses]) {
      lines.push([c.name, '', ...periods.map(p => dollars(c.cells[p])), dollars(c.total)].map(esc).join(','))
      for (const s of c.subs.values()) {
        lines.push([c.name, s.name, ...periods.map(p => dollars(s.cells[p])), dollars(s.total)].map(esc).join(','))
      }
    }
    lines.push(['Net position', '', ...periods.map(p => dollars(totals[p])), dollars(summary.income + summary.expense)].map(esc).join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `profit-and-loss-${range.from}-to-${range.to}-by-${groupBy}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // First and last day of a column, whichever grouping produced it:
  // 2026-07 → July, 2026-Q3 → Jul–Sep, 2026 → the whole year.
  const periodRange = (p: string) => {
    if (/^\d{4}$/.test(p)) return { from: `${p}-01-01`, to: `${p}-12-31` }
    const quarter = /^(\d{4})-Q(\d)$/.exec(p)
    if (quarter) {
      const y = +quarter[1], startMonth = (+quarter[2] - 1) * 3
      return { from: isoDate(new Date(y, startMonth, 1)), to: isoDate(new Date(y, startMonth + 3, 0)) }
    }
    const [y, m] = p.split('-').map(Number)
    return { from: `${p}-01`, to: isoDate(new Date(y, m, 0)) }
  }

  // Click any figure to see the transactions behind it. `period` omitted means the
  // row total, i.e. the whole range currently on screen.
  const drill = (categoryId: string | null, period?: string) => {
    sessionStorage.setItem('tx-filter', JSON.stringify({
      category: categoryId, account: account || undefined,
      ...(period ? periodRange(period) : { from: range.from, to: range.to }),
    }))
    navigate('/transactions')
  }

  const expandable = [...income, ...expenses].filter(c => c.subs.size > 0)
  const allOpen = expandable.length > 0 && expandable.every(c => open.has(c.name))
  const toggle = (name: string) => setOpen(p => { const n = new Set(p); n.has(name) ? n.delete(name) : n.add(name); return n })

  const net = summary.income + summary.expense
  const avg = (cents: number) => periods.length ? money(Math.abs(cents) / periods.length) : '—'
  const inOut = Math.abs(summary.income) + Math.abs(summary.expense)
  const sections = [
    { key: 'income', label: 'Income', totalLabel: 'Total income', cats: income, sign: 1, total: summary.income },
    { key: 'expense', label: 'Expenses', totalLabel: 'Total expenses', cats: expenses, sign: -1, total: summary.expense },
  ].filter(s => side === 'all' || side === s.key)

  const cols = periods.length + 3

  return (
    <div className="space-y-3">
      {/* Page header — Export CSV is a page action, not a filter */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-[650] tracking-[-0.02em] text-[#171b22]">Profit &amp; loss</h1>
          <p className="mt-1 text-[13px] text-[#79818f]">
            {date(range.from)} – {date(range.to)}
            {rows && (periods.length === 0 ? ' · no activity'
              : periods.length <= 3 ? ` · activity in ${periods.map(periodLabel).join(', ')}`
                : ` · activity in ${periods.length} of ${periodsInRange} ${unit}s`)}
          </p>
        </div>
        <button onClick={exportCsv} disabled={!rows?.length}
          className="h-9 cursor-pointer rounded-[9px] border border-[#dfe3ea] bg-white px-[13px] text-[13px] text-[#4b5462] hover:bg-[#f7f8fa] hover:text-[#171b22] disabled:opacity-50">
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className={cn(CARD, 'px-3.5 py-3')}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p, i) => (
              <button key={p.label} onClick={() => { setPreset(i); if (p.range) setRange(p.range()) }}
                className={cn('h-8 cursor-pointer rounded-lg px-3 text-[12.5px]',
                  preset === i ? 'bg-[#f1f3f7] font-semibold text-[#171b22]' : 'font-[450] text-[#5d6674] hover:bg-[#f7f8fa] hover:text-[#171b22]')}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <select className={SELECT} value={groupBy} onChange={e => setGroupBy(e.target.value as any)}>
              <option value="month">Monthly columns</option>
              <option value="quarter">Quarterly columns</option>
              <option value="year">Yearly columns</option>
            </select>
            <select className={SELECT} value={side} onChange={e => setSide(e.target.value as any)}>
              <option value="all">Income &amp; expenses</option>
              <option value="income">Income only</option>
              <option value="expense">Expenses only</option>
            </select>
            <select className={SELECT} value={account} onChange={e => setAccount(e.target.value)}>
              <option value="">All accounts</option>
              {accounts.filter(a => !a.archived).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-[#5d6674]">
            <input type="checkbox" className="peer sr-only" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)} />
            <span className={cn('flex h-4 w-4 items-center justify-center rounded-[5px] border-[1.5px] text-[9px] font-bold text-white',
              includeArchived ? 'border-[#2563eb] bg-[#2563eb]' : 'border-[#cdd3dd] hover:border-[#93b4fb]')}>
              {includeArchived && '✓'}
            </span>
            Include archived accounts
          </label>
          {/* Custom dates exist only while the Custom range tab is active */}
          {preset === PRESETS.length - 1 && (
            <div className="flex items-center gap-2">
              <input type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
                className="h-8 rounded-[9px] border border-[#dfe3ea] px-2.5 text-[12.5px] text-[#39404b] focus:border-[#93b4fb] focus:outline-none focus:ring-[3px] focus:ring-[rgba(37,99,235,0.10)]" />
              <span className="text-[12.5px] text-[#9aa2af]">to</span>
              <input type="date" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
                className="h-8 rounded-[9px] border border-[#dfe3ea] px-2.5 text-[12.5px] text-[#39404b] focus:border-[#93b4fb] focus:outline-none focus:ring-[3px] focus:ring-[rgba(37,99,235,0.10)]" />
            </div>
          )}
        </div>
      </div>

      {/* Summary — only the net position carries colour; the other two are inputs */}
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_1.3fr]">
        <div className={cn(CARD, 'p-4')}>
          <p className={LABEL}>Total income</p>
          <p className="text-[22px] font-[650] tabular-nums tracking-[-0.02em] text-[#171b22]">{rows ? money(Math.abs(summary.income)) : '—'}</p>
          <p className="mt-[5px] text-[11.5px] text-[#9aa2af]">avg {avg(summary.income)} a {unit}</p>
        </div>
        <div className={cn(CARD, 'p-4')}>
          <p className={LABEL}>Total expenses</p>
          <p className="text-[22px] font-[650] tabular-nums tracking-[-0.02em] text-[#171b22]">{rows ? money(Math.abs(summary.expense)) : '—'}</p>
          <p className="mt-[5px] text-[11.5px] text-[#9aa2af]">avg {avg(summary.expense)} a {unit}</p>
        </div>
        <div className={cn(CARD, 'p-4')}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className={LABEL}>Net position</p>
            <p className="text-[11.5px] text-[#a4abb8]">
              {periods.slice(0, 3).map((p, i) => (
                <span key={p}>{i > 0 && ' · '}{periodLabel(p)} <span className="tabular-nums" style={{ color: totals[p] < 0 ? NEG : POS }}>{signedMoney(totals[p])}</span></span>
              ))}
            </p>
          </div>
          <p className="text-[22px] font-[650] tabular-nums tracking-[-0.02em]" style={{ color: net < 0 ? NEG : POS }}>
            {rows ? signedMoney(net) : '—'}
          </p>
          <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-[#f1f3f7]">
            <div style={{ width: `${inOut ? (Math.abs(summary.income) / inOut) * 100 : 0}%`, backgroundColor: '#0f9d6e' }} />
            <div style={{ width: `${inOut ? (Math.abs(summary.expense) / inOut) * 100 : 0}%`, backgroundColor: '#e0722f' }} />
          </div>
          <p className="mt-[7px] text-[11.5px] text-[#9aa2af]">
            {net === 0 ? 'Income and expenses balanced over the period'
              : net < 0 ? `Expenses ran ${money(-net)} ahead of income over the period`
                : `Income ran ${money(net)} ahead of expenses over the period`}
          </p>
        </div>
      </div>

      {!rows ? <Spinner /> : (
        <div className={cn(CARD, 'overflow-hidden')}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <p className="text-xs text-[#9aa2af]">
              Click any figure to open its transactions
              {hidden > 0 && ` · ${hidden} ${unit}${hidden === 1 ? '' : 's'} with no activity ${hidden === 1 ? 'is' : 'are'} hidden`}
            </p>
            {expandable.length > 0 && (
              <button onClick={() => setOpen(allOpen ? new Set() : new Set(expandable.map(c => c.name)))}
                className="h-[30px] cursor-pointer rounded-lg border border-[#e5e8ee] px-[11px] text-[12.5px] text-[#5d6674] hover:bg-[#f7f8fa]">
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>
          {periods.length === 0 ? (
            <div className="border-t border-[#eef0f4] px-4 py-14 text-center">
              <p className="text-sm font-semibold text-[#3f4753]">No activity in this period</p>
              <p className="mt-1 text-[13px] text-[#9aa2af]">Try a wider date range, or import some transactions.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className={cn('h-[38px] border-y border-[#eef0f4] bg-[#fbfcfd]', LABEL)}>
                    <th scope="col" className="sticky left-0 min-w-[240px] bg-[#fbfcfd] px-4 text-left font-semibold">Category</th>
                    <th scope="col" className="hidden w-full px-2 text-left font-semibold xl:table-cell">Share of total</th>
                    {periods.map(p => <th key={p} scope="col" className="w-[160px] px-2 text-right font-semibold">{periodLabel(p)}</th>)}
                    <th scope="col" className="w-[176px] px-4 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                {sections.map(s => (
                  <tbody key={s.key}>
                    <tr className="h-[34px] border-b border-[#f1f3f6] bg-[#fafbfc]">
                      <td colSpan={cols} className="px-4">
                        <span className="text-xs font-[650] text-[#3f4753]">{s.label}</span>
                        <span className="ml-2 text-[11.5px] text-[#a4abb8]">{s.cats.length} categor{s.cats.length === 1 ? 'y' : 'ies'}</span>
                      </td>
                    </tr>
                    {s.cats.length === 0 && (
                      <tr className="h-11 border-b border-[#f4f6f8]"><td colSpan={cols} className="px-4 text-[#c2c8d2]">—</td></tr>
                    )}
                    {s.cats.map(c => (
                      <Row key={c.name} c={c} periods={periods} periodLabel={periodLabel} sign={s.sign} sectionTotal={s.total}
                        open={open.has(c.name)} toggle={() => toggle(c.name)} drill={drill} />
                    ))}
                    <tr className="h-[42px] border-y border-t-[#e8ebf0] border-b-[#eef0f4] bg-[#fbfcfd]">
                      <td className="sticky left-0 bg-[#fbfcfd] px-4 text-[13px] font-[650] text-[#171b22]">{s.totalLabel}</td>
                      <td className="hidden xl:table-cell" />
                      {periods.map(p => (
                        <td key={p} className="px-2 pr-[15px] text-right">
                          <Figure cents={s.cats.reduce((n, c) => n + (c.cells[p] || 0), 0)} sign={s.sign} className="font-semibold text-[#171b22]" />
                        </td>
                      ))}
                      <td className="px-4 pr-[23px] text-right"><Figure cents={s.total} sign={s.sign} className="font-[650] text-[#171b22]" /></td>
                    </tr>
                  </tbody>
                ))}
                {/* Net reconciles only when both sections are on screen */}
                {side === 'all' && (
                  <tfoot>
                    <tr className="h-12 bg-[#fcfcfd]">
                      <td className="sticky left-0 bg-[#fcfcfd] px-4 text-[13.5px] font-[650] text-[#171b22]">Net position</td>
                      <td className="hidden xl:table-cell" />
                      {periods.map(p => (
                        <td key={p} className="px-2 text-right">
                          <button onClick={() => drill(null, p)} title="View transactions"
                            className="cursor-pointer rounded-md px-[7px] py-[3px] text-[13.5px] font-semibold tabular-nums hover:bg-[#eef3ff]"
                            style={{ color: (totals[p] || 0) < 0 ? NEG : POS }}>
                            {signedMoney(totals[p] || 0)}
                          </button>
                        </td>
                      ))}
                      <td className="px-4 pr-[23px] text-right text-[13.5px] font-[650] tabular-nums" style={{ color: net < 0 ? NEG : POS }}>
                        {signedMoney(net)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Within a section amounts are unsigned — the section says which way the money went.
// A sign appears only when a value contradicts its section (a refund inside expenses,
// negative income), and then it carries colour. Zero renders as an em dash, never $0.00.
function Figure({ cents, sign, onClick, label, className }: {
  cents?: number; sign: number; onClick?: () => void; label?: string; className?: string
}) {
  if (!cents) return <span className={cn('font-[450] text-[#c2c8d2]', onClick && 'pr-[7px]', className)}>—</span>
  const contra = Math.sign(cents) !== sign
  const text = contra ? signedMoney(cents) : money(Math.abs(cents))
  const style = contra ? { color: cents > 0 ? POS : NEG } : undefined
  if (!onClick) return <span className={cn('tabular-nums', className)} style={style}>{text}</span>
  return (
    <button onClick={e => { e.stopPropagation(); onClick() }} title="View transactions" aria-label={label}
      className={cn('cursor-pointer rounded-md px-[7px] py-[3px] tabular-nums hover:bg-[#eef3ff] hover:text-[#2563eb]', className)}
      style={style}>
      {text}
    </button>
  )
}

const Name = ({ as: As, children, ...rest }: any) => (
  <As type={As === 'button' ? 'button' : undefined} className="flex w-full items-center gap-2 text-left" {...rest}>{children}</As>
)

function Row({ c, periods, periodLabel, sign, sectionTotal, open, toggle, drill }: any) {
  const dot = groupColour(c.name, c.colour).dot
  const share = sectionTotal ? Math.abs(c.total / sectionTotal) * 100 : 0
  const expandable = c.subs.size > 0
  return (
    <>
      <tr className={cn('h-11 border-b border-[#f4f6f8] bg-white hover:bg-[#fafbfe]', expandable && 'cursor-pointer')}
        onClick={expandable ? toggle : undefined}>
        <td className="sticky left-0 bg-inherit px-4">
          {/* The whole row toggles, but the name is the real button so screen
              readers get an aria-expanded control rather than a clickable row */}
          <Name as={expandable ? 'button' : 'div'} aria-expanded={expandable ? open : undefined}
            aria-label={expandable ? `${c.name} — ${open ? 'collapse' : 'expand'} sub-categories` : undefined}>
            {/* Fixed caret slot — leaf rows keep it empty so names stay aligned */}
            <span className="w-[14px] shrink-0 text-[9px] text-[#b0b7c3]" aria-hidden>
              {expandable && <span className={cn('inline-block transition-transform', open ? 'rotate-0' : '-rotate-90')}>▼</span>}
            </span>
            <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: dot }} />
            <span className="truncate font-semibold tracking-[-0.005em] text-[#171b22]">{c.name}</span>
          </Name>
        </td>
        <td className="hidden px-2 xl:table-cell">
          <div className="flex items-center gap-2">
            <div className="h-[5px] w-[150px] overflow-hidden rounded-full bg-[#f1f3f7]" aria-hidden>
              <div className="h-full rounded-full" style={{ width: `${Math.max(0.7, share)}%`, backgroundColor: dot }} />
            </div>
            <span className="text-[11.5px] tabular-nums text-[#9aa2af]">{share < 0.1 ? '0' : share.toFixed(1)}%</span>
          </div>
        </td>
        {periods.map((p: string) => (
          <td key={p} className="px-2 text-right">
            <Figure cents={c.cells[p]} sign={sign} className="font-medium text-[#171b22]"
              label={`${c.name}, ${periodLabel(p)} — view transactions`} onClick={() => drill(c.id, p)} />
          </td>
        ))}
        <td className="px-4 text-right">
          <Figure cents={c.total} sign={sign} className="font-semibold text-[#171b22]"
            label={`${c.name}, whole period — view transactions`} onClick={() => drill(c.id)} />
        </td>
      </tr>
      {open && [...c.subs.values()].map((s: any) => (
        <tr key={s.name} className="h-9 border-b border-[#f4f6f8] bg-white hover:bg-[#fafbfe]">
          <td className="sticky left-0 bg-inherit px-4">
            <span className="ml-[29px] truncate text-[12.5px] text-[#5d6674]">{s.name}</span>
          </td>
          <td className="hidden xl:table-cell" />
          {periods.map((p: string) => (
            <td key={p} className="px-2 text-right">
              <Figure cents={s.cells[p]} sign={sign} className="text-[12.5px] font-[450] text-[#79818f]"
                label={`${s.name}, ${periodLabel(p)} — view transactions`} onClick={() => drill(s.id, p)} />
            </td>
          ))}
          <td className="px-4 text-right">
            <Figure cents={s.total} sign={sign} className="text-[12.5px] text-[#5d6674]"
              label={`${s.name}, whole period — view transactions`} onClick={() => drill(s.id)} />
          </td>
        </tr>
      ))}
    </>
  )
}
