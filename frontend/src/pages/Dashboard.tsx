// Dashboard — rebuilt to the "Dashboard redesign" handoff spec: money row with an
// in/out proportion bar and interpreted sparklines, an attention strip, spending vs
// last month, a 14-day forward view, 7 rows of recent activity, and the AI analysis
// as a ranked findings list rather than a report.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { get, patch, post } from '../lib/api'
import { Spinner, cn } from '../components/ui'
import { CategoryPicker } from '../components/CategoryPicker'
import { date, dateTimeLocal, dollars, isoDate, isoToday, money, signedMoney } from '../lib/format'

import { categoryColour, groupColour } from '../lib/categories'

const CARD = 'rounded-xl border border-[#e8ebf0] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]'
const LABEL = 'text-[11px] font-semibold uppercase tracking-[0.055em] text-[#8b93a1]'
const UP_BAD = '#c2540a'
const DOWN_GOOD = '#0f7a52'

const TONES: Record<string, string> = {
  warm: 'bg-[#fdf2e9] text-[#a8500f]',
  alert: 'bg-[#fdeeee] text-[#a33b37]',
  ai: 'bg-[#f4f1ff] text-[#5b4bd6]',
  neutral: 'bg-[#f1f3f7] text-[#4b5462]',
}

// Deep-link into Transactions with a view and/or search pre-applied
function useTxLink() {
  const navigate = useNavigate()
  return (filter: Record<string, unknown>) => {
    sessionStorage.setItem('tx-filter', JSON.stringify(filter))
    navigate('/transactions')
  }
}

function Sparkline({ series, kind }: { series: number[]; kind: 'asset' | 'liability' }) {
  if (!series || series.length < 2) return <div className="h-10" />
  const min = Math.min(...series), max = Math.max(...series), range = max - min || 1
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * 240},${40 - ((v - min) / range) * 34}`)
  const stroke = kind === 'liability' ? '#8b93a1' : '#2563eb'
  const fill = kind === 'liability' ? 'rgba(139,147,161,0.09)' : 'rgba(37,99,235,0.07)'
  const label = `Balance over 30 days, ranged ${money(min)} to ${money(max)}, currently ${money(series[series.length - 1])}`
  return (
    <svg viewBox="0 0 240 44" preserveAspectRatio="none" className="mt-auto h-10 w-full" role="img" aria-label={label}>
      <polygon points={`0,44 ${pts.join(' ')} 240,44`} fill={fill} />
      <polyline points={pts.join(' ')} fill="none" stroke={stroke} strokeWidth="1.75"
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// Cumulative net across the month. Unlike the account sparklines this is signed,
// so the zero line is drawn and the fill is coloured by which side it ends on.
function NetTrend({ series, prev, daysInMonth }: { series: number[]; prev: number[]; daysInMonth: number }) {
  if (!series?.length) return <div className="h-14" />
  const all = [...series, ...(prev || []), 0]
  const min = Math.min(...all), max = Math.max(...all), range = max - min || 1
  const W = 240, H = 54
  // Each month is scaled over its own length, so a 30-day month lines up with a 31-day one
  const x = (i: number, of: number) => (i / Math.max(of - 1, 1)) * W
  const y = (v: number) => H - ((v - min) / range) * (H - 4) - 2
  const path = (s: number[], of: number) => s.map((v, i) => `${x(i, of)},${y(v)}`).join(' ')
  const end = series[series.length - 1]
  const colour = end < 0 ? UP_BAD : DOWN_GOOD
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-14 w-full" role="img"
      aria-label={`Running net through the month, currently ${money(end)}`}>
      {/* last month, ghosted */}
      {prev?.length > 1 && (
        <polyline points={path(prev, prev.length)} fill="none" stroke="#c2c8d2" strokeWidth="1.25"
          strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="#e8ebf0" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <polygon points={`0,${y(0)} ${path(series, daysInMonth)} ${x(series.length - 1, daysInMonth)},${y(0)}`} fill={colour} opacity="0.08" />
      <polyline points={path(series, daysInMonth)} fill="none" stroke={colour} strokeWidth="1.75"
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(series.length - 1, daysInMonth)} cy={y(end)} r="2.5" fill={colour} />
    </svg>
  )
}

function Delta({ cents, invert = false, className }: { cents: number; invert?: boolean; className?: string }) {
  const n = Number(cents)
  if (!n) return <span className={cn('text-[#c2c8d2]', className)}>—</span>
  const bad = invert ? n > 0 : n < 0
  return <span className={cn('tabular-nums', className)} style={{ color: bad ? UP_BAD : DOWN_GOOD }}>{signedMoney(n)}</span>
}

export default function Dashboard() {
  const [data, setData] = useState<any>(null)
  const [cats, setCats] = useState<any[]>([])
  const [error, setError] = useState('')
  const [order, setOrder] = useState<string[] | null>(null) // optimistic account order
  const dragIndex = useRef<number | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<any>(null)
  const [queryBusy, setQueryBusy] = useState(false)
  const txLink = useTxLink()
  const navigate = useNavigate()
  // "Where the money went" is this-month-to-date, so drill-through uses the same span
  const monthStart = isoDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

  const loadDashboard = () => get('/dashboard').then(setData).catch(e => setError(e.message))
  useEffect(() => {
    loadDashboard()
    get('/categories').then(setCats).catch(() => {})
  }, [])

  const runQuery = async () => {
    if (!question.trim()) return
    setQueryBusy(true)
    try { setAnswer(await post('/ai/query', { question })) }
    catch (e) { setAnswer({ error: (e as Error).message }) }
    setQueryBusy(false)
  }

  if (error && !data) return <p className="text-red-600">{error}</p>
  if (!data) return <Spinner />

  const { period, cashFlow, topSpending, movers, upcoming, attention, recent } = data
  // The server returns accounts in saved order; `order` only overrides it between a
  // drop and the next dashboard refresh, so the card moves the instant you release it.
  const accounts = order
    ? [...data.accounts].sort((a: any, b: any) => order.indexOf(a.id) - order.indexOf(b.id))
    : data.accounts

  const dropAccount = (to: number) => {
    const from = dragIndex.current
    dragIndex.current = null
    if (from == null || from === to) return
    const next = [...accounts]
    next.splice(to, 0, ...next.splice(from, 1))
    const ids = next.map((a: any) => a.id)
    setOrder(ids)
    post('/accounts/reorder', { ids }).catch(e => setError(e.message))
  }
  const inCents = Number(cashFlow.income_cents)
  const outCents = Math.abs(Number(cashFlow.expense_cents))
  const flowTotal = inCents + outCents || 1
  const netDelta = Number(cashFlow.net_cents) - Number(cashFlow.prev_net_cents)
  // Scale the bars to whichever is larger, spend or target, so a budget notch is
  // never off the end of its own bar
  const maxSpend = Math.max(...topSpending.flatMap((s: any) => [Number(s.amount_cents), Number(s.target_cents || 0)]), 1)

  return (
    <div className="space-y-3">
      {/* Header: period on the left, ask bar on the right */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="mb-1 text-[22px] font-[650] tracking-[-0.02em]">{period.label}</h1>
          <p className="text-[13px] text-[#79818f]">
            {period.payCycles} pay cycle{period.payCycles === 1 ? '' : 's'} this month · {period.txCount} transactions
            {period.syncedAt && <> · synced {dateTimeLocal(period.syncedAt)}</>}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative w-[430px] max-w-full">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-[#a99ff0]">✦</span>
            <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === 'Enter' && runQuery()}
              placeholder={'Ask about your money — "how much on groceries last month?"'}
              className="h-9 w-full rounded-[9px] border border-[#dfe3ea] pl-[30px] pr-3 text-[13px] placeholder:text-[#a4abb8] focus:border-[#93b4fb] focus:outline-none focus:ring-[3px] focus:ring-[rgba(37,99,235,0.10)]" />
          </div>
          <button onClick={runQuery} disabled={queryBusy}
            className="h-9 shrink-0 cursor-pointer rounded-[9px] bg-[#2563eb] px-[15px] text-[13px] font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-60">
            {queryBusy ? '…' : 'Ask'}
          </button>
        </div>
      </div>

      {/* The answer lands in place, under the bar */}
      {answer && (
        <div className={cn(CARD, 'p-4')}>
          <div className="mb-1 flex items-start justify-between">
            <h3 className="text-[13.5px] font-[650]">Answer</h3>
            <button onClick={() => setAnswer(null)} aria-label="Dismiss answer" className="cursor-pointer text-[#b0b7c3] hover:text-[#5d6674]">✕</button>
          </div>
          {answer.error && <p className="text-[13px] text-[#5d6674]">{answer.error}</p>}
          {answer.answerCents != null && (
            <p className="text-[26px] font-[650] tabular-nums tracking-[-0.025em]">{money(Math.abs(answer.answerCents))}
              <span className="ml-2 text-[13px] font-normal text-[#79818f]">across {answer.count} transactions</span></p>
          )}
          {answer.rows && (
            <ul className="mt-2 space-y-1 text-[13px]">
              {answer.rows.map((r: any) => (
                <li key={r.category} className="flex justify-between"><span>{r.category}</span>
                  <span className="tabular-nums">{money(r.cents)}</span></li>
              ))}
            </ul>
          )}
          {answer.transactions?.length > 0 && (
            <table className="mt-2 w-full text-[13px]">
              <tbody>{answer.transactions.map((t: any) => (
                <tr key={t.id} className="border-t border-[#f4f6f8]">
                  <td className="py-1 text-[#79818f]">{date(t.date)}</td>
                  <td className="truncate">{t.vendor}</td>
                  <td className="text-right tabular-nums">{signedMoney(t.amount_cents)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}

      {/* Money row: accounts sit in a 2x2 grid, the net card fills the column beside
          them. Drag an account card to change the order (persisted per account). */}
      <div className="grid gap-3 md:grid-cols-2 lg:auto-rows-fr lg:grid-cols-[1.4fr_1fr_1fr]">
        <div className={cn(CARD, 'flex flex-col justify-between gap-3 p-4 md:col-span-2 lg:col-span-1 lg:row-span-2')}>
          <div>
            <div className="flex items-center justify-between">
              <span className={LABEL}>Net this month</span>
              <span className="text-[11.5px] text-[#a4abb8]" title={`Same 1–${cashFlow.dayOfMonth} window last month, so the comparison is like for like`}>
                vs same point last month
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
              <span className="text-[29px] font-[650] tabular-nums tracking-[-0.025em]">{signedMoney(cashFlow.net_cents)}</span>
              <span className="text-[12.5px] font-[550] tabular-nums" style={{ color: netDelta < 0 ? UP_BAD : DOWN_GOOD }}>
                {signedMoney(netDelta)}
              </span>
              <span className="text-[11.5px] text-[#a4abb8]">
                day {cashFlow.dayOfMonth} of {cashFlow.daysInMonth}
              </span>
            </div>
          </div>

          {/* Running net through the month, with last month ghosted behind it */}
          <NetTrend series={cashFlow.trend} prev={cashFlow.prevTrend} daysInMonth={cashFlow.daysInMonth} />

          <div>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-[#f1f3f7]">
              <span style={{ width: `${(inCents / flowTotal) * 100}%`, backgroundColor: '#0f9d6e' }} />
              <span style={{ width: `${(outCents / flowTotal) * 100}%`, backgroundColor: '#e0722f' }} />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-[18px]">
              {[['In', inCents, cashFlow.income_n, '#0f9d6e'], ['Out', outCents, cashFlow.expense_n, '#e0722f']].map(([label, val, n, colour]) => (
                <span key={label as string} className="flex items-center gap-1.5">
                  <span className="h-[7px] w-[7px] rounded-full" style={{ backgroundColor: colour as string }} />
                  <span className="text-[12px] text-[#79818f]">{label as string}</span>
                  <span className="text-[13px] font-semibold tabular-nums">{money(val as number)}</span>
                  <span className="text-[11.5px] tabular-nums text-[#a4abb8]">({n as number})</span>
                </span>
              ))}
            </div>
            {/* Where the month lands: scheduled commitments where they exist, pace otherwise */}
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-[#9aa2af]">
              {cashFlow.dueCount > 0 && (
                <>{money(Math.abs(cashFlow.billsDue_cents))} of bills
                  {cashFlow.incomeDue_cents > 0 && <> and {money(cashFlow.incomeDue_cents)} of income</>}
                  {' '}still due · </>
              )}
              tracking to <span className="font-[550] tabular-nums" style={{ color: cashFlow.projected_cents < 0 ? UP_BAD : DOWN_GOOD }}>
                {signedMoney(cashFlow.projected_cents)}</span> by {new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)
                  .toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
              {cashFlow.projectedFrom === 'pace' && ' at this pace'}
            </p>
          </div>
        </div>

        {accounts.map((a: any, i: number) => (
          <div key={a.id} draggable
            onDragStart={e => { dragIndex.current = i; e.dataTransfer.effectAllowed = 'move' }}
            onDragOver={e => e.preventDefault()}
            onDrop={() => dropAccount(i)}
            title="Drag to reorder"
            className={cn(CARD, 'flex cursor-grab flex-col p-4 active:cursor-grabbing')}>
            {/* Only the title navigates — the rest of the card stays a drag handle */}
            <button onClick={() => navigate(`/accounts/${a.id}`)}
              title={`Open the ${a.name} register`}
              className={cn(LABEL, 'cursor-pointer self-start text-left hover:text-[#2563eb]')}>
              {a.name}{a.kind === 'liability' && ' · owing'}
            </button>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-[22px] font-[650] tabular-nums tracking-[-0.02em]"
                style={a.kind === 'liability' ? { color: '#3f4753' } : undefined}>
                {a.kind === 'liability' ? signedMoney(a.balance_cents) : money(a.balance_cents)}
              </span>
              <Delta cents={a.delta30d_cents} invert={a.kind === 'liability'} className="text-[12px] font-[550]" />
            </div>
            <Sparkline series={a.series} kind={a.kind} />
            <p className="mt-1 text-[11.5px] text-[#9aa2af]">{a.footnote}</p>
          </div>
        ))}
      </div>

      {/* Attention strip — hidden entirely when nothing needs a decision */}
      {attention.length > 0 && (
        <div className={cn(CARD, 'flex flex-wrap items-stretch overflow-hidden')} aria-live="polite">
          {attention.map((item: any, i: number) => {
            const tint = item.severity === 'alert' ? 'bg-[#fdeeee] text-[#a33b37]'
              : item.severity === 'ai' ? 'bg-[#f4f1ff] text-[#5b4bd6]' : 'bg-[#eef3ff] text-[#2563eb]'
            const glyph = item.severity === 'alert' ? '!' : item.severity === 'ai' ? '✦' : '⇄'
            const n = item.count
            const title = item.kind === 'duplicate'
              ? `${item.vendor} billed ${n === 2 ? 'twice' : `${n} times`} this month`
              : item.kind === 'uncategorised'
                ? `${n} transaction${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a category`
                : item.kind === 'over_budget'
                  ? `${n} categor${n === 1 ? 'y is' : 'ies are'} over budget`
                  : `${n} transfer${n === 1 ? '' : 's'} unmatched`
            return (
              <div key={i} className={cn('flex min-w-[260px] flex-1 items-center gap-[11px] p-[13px_16px] hover:bg-[#fafbfe]', i > 0 && 'border-l border-[#eef0f4]')}>
                <span className={cn('grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg text-[11px]', tint)}>{glyph}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold" title={title}>{title}</span>
                  <span className="mt-px block truncate text-[11.5px] text-[#9aa2af]">{item.detail}</span>
                </span>
                <button onClick={() => (item.href ? navigate(item.href) : txLink({ view: item.view, search: item.search }))}
                  className="shrink-0 cursor-pointer text-[12.5px] font-[550] text-[#2563eb] hover:underline">{item.action}</button>
              </div>
            )
          })}
        </div>
      )}

      {/* Where the money went · Coming up */}
      <div className={cn('grid gap-3', upcoming.length > 0 ? 'lg:grid-cols-2' : 'grid-cols-1')}>
        <div className={cn(CARD, 'flex flex-col')}>
          <div className="flex items-center justify-between p-[14px_16px_10px]">
            <h3 className="text-[13.5px] font-[650] tracking-[-0.005em]">Where the money went</h3>
            <button onClick={() => txLink({})} className="cursor-pointer text-[12.5px] text-[#2563eb] hover:underline">Breakdown</button>
          </div>
          {topSpending.length === 0 && <p className="px-4 pb-4 text-[13px] text-[#9aa2af]">No spending recorded this month.</p>}
          {topSpending.map((s: any) => {
            const colour = groupColour(s.name, s.colour).dot
            const delta = Number(s.amount_cents) - Number(s.prev_cents)
            const over = s.target_cents > 0 && Number(s.amount_cents) > s.target_cents
            // Click through to the transactions behind the figure, this month only.
            // Uncategorised has no id, so it lands on the "Needs a category" view.
            const open = () => txLink(s.category_id
              ? { category: s.category_id, from: monthStart, to: isoToday() }
              : { view: 'uncat', from: monthStart, to: isoToday() })
            return (
              <button key={s.name} onClick={open} title={`View ${s.name} transactions this month`}
                className="grid w-full cursor-pointer grid-cols-[1fr_88px_74px] items-center gap-3 px-4 py-[7px] text-left hover:bg-[#fafbfe]">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: colour }} />
                    <span className="truncate text-[12.5px] text-[#3f4753]">{s.name}</span>
                  </span>
                  <span className="relative mt-1 block h-[5px] rounded-full bg-[#f1f3f7]">
                    <span className="block h-[5px] rounded-full"
                      style={{ width: `${(Number(s.amount_cents) / maxSpend) * 100}%`,
                        backgroundColor: over ? UP_BAD : colour }} />
                    {/* Where the monthly target sits on the same scale */}
                    {s.target_cents > 0 && (
                      <span className="absolute top-[-2px] h-[9px] w-px bg-[#79818f]"
                        style={{ left: `${(s.target_cents / maxSpend) * 100}%` }}
                        title={`Budget ${money(s.target_cents)}`} />
                    )}
                  </span>
                </span>
                <span className="text-right text-[13px] font-[550] tabular-nums tracking-[-0.01em]">{money(s.amount_cents)}</span>
                <Delta cents={delta} invert className="text-right text-[12px]" />
              </button>
            )
          })}
          {movers.length > 0 && (
            <p className="mt-auto border-t border-[#eef0f4] p-[11px_16px] text-[11.5px] text-[#9aa2af]">
              Biggest movers vs last month —{' '}
              {movers.map((m: any, i: number) => (
                <span key={m.name}>
                  {i > 0 && ' · '}{m.name}{' '}
                  {/* More income is good; more spending is not */}
                  <span style={{ color: (m.is_income ? m.delta < 0 : m.delta > 0) ? UP_BAD : DOWN_GOOD }}>{signedMoney(m.delta)}</span>
                </span>
              ))}
            </p>
          )}
        </div>

        {upcoming.length > 0 && (
          <div className={cn(CARD, 'flex flex-col')}>
            <div className="flex items-center justify-between p-[14px_16px_8px]">
              <h3 className="text-[13.5px] font-[650] tracking-[-0.005em]">Coming up <span className="font-[450] text-[#9aa2af]">· next 14 days</span></h3>
              <button onClick={() => window.location.assign('/recurring')} className="cursor-pointer text-[12.5px] text-[#2563eb] hover:underline">All recurring</button>
            </div>
            {upcoming.map((u: any) => (
              <div key={u.id} className="grid h-[41px] grid-cols-[92px_1fr_96px] items-center gap-3 border-t border-[#f4f6f8] px-4 hover:bg-[#fafbfe]">
                <span className="text-[12px] tabular-nums text-[#79818f]">{date(u.next_due)}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px]">{u.vendor}</span>
                  {u.is_new && <span className="shrink-0 rounded-full bg-[#f7f5ff] px-1.5 py-px text-[10.5px] font-[550] text-[#5b4bd6]">new</span>}
                </span>
                <span className={cn('text-right text-[13px] tabular-nums tracking-[-0.01em]',
                  Number(u.expected_amount_cents) > 0 ? 'font-semibold text-[#0f7a52]' : 'font-medium')}>
                  {signedMoney(u.expected_amount_cents)}
                </span>
              </div>
            ))}
            <div className="mt-auto flex items-center justify-between border-t border-[#eef0f4] bg-[#fcfcfd] p-[11px_16px]">
              <span className="text-[12px] text-[#79818f]">Net over 14 days</span>
              <span className="text-[13px] font-semibold tabular-nums"
                style={{ color: Number(data.upcomingNet_cents) < 0 ? UP_BAD : DOWN_GOOD }}>
                {signedMoney(data.upcomingNet_cents)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Recent activity — reports that activity exists; the work happens in Transactions */}
      <div className={CARD}>
        <div className="flex items-center justify-between p-[14px_16px_12px]">
          <h3 className="flex items-center gap-2 text-[13.5px] font-[650] tracking-[-0.005em]">
            Recent activity
            {data.uncategorised > 0 && (
              <button onClick={() => txLink({ view: 'uncat' })} className="cursor-pointer text-[12px] font-[550] text-[#6d5ae6] hover:underline">
                {data.uncategorised} need a category
              </button>
            )}
          </h3>
          <button onClick={() => txLink({})} className="cursor-pointer text-[12.5px] text-[#2563eb] hover:underline">View all</button>
        </div>
        {/* Narrow screens drop the Account column, then the raw bank line (spec §Responsive) */}
        {recent.map((t: any) => (
          <div key={t.id} className="grid min-h-[46px] grid-cols-[1fr_130px_96px] items-center gap-3 border-t border-[#f4f6f8] px-4 hover:bg-[#fafbfe] lg:grid-cols-[1fr_210px_150px_118px]">
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] font-semibold tracking-[-0.005em]">{t.vendor}</span>
              <span className="mt-px hidden truncate text-[11.5px] text-[#9aa2af] sm:block">{t.payee}</span>
            </span>
            <span className="min-w-0">
              {t.type === 'transfer' ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e6e9ef] bg-white px-2.5 py-1 text-[12.5px] text-[#79818f]">
                  <span className="text-[11px]">⇄</span>Transfer
                </span>
              ) : t.category_id ? (
                <CategoryPicker cats={cats} value={t.category_id} valueName={t.category_name}
                  onSelect={id => patch(`/transactions/${t.id}`, { categoryId: id }).then(loadDashboard)}
                  trigger={
                    <span className="inline-flex max-w-full items-center gap-[7px] rounded-full border border-[#edeff3] bg-[#f6f7f9] px-2.5 py-1 text-[12.5px] text-[#3f4753] hover:border-[#dfe3ea]">
                      <span className="h-[7px] w-[7px] shrink-0 rounded-full"
                        style={{ backgroundColor: categoryColour(cats, cats.find(c => c.id === t.category_id)).dot }} />
                      <span className="truncate">{t.category_name}</span>
                    </span>
                  } />
              ) : (
                <CategoryPicker cats={cats} onSelect={id => patch(`/transactions/${t.id}`, { categoryId: id }).then(loadDashboard)}
                  trigger={
                    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-[#d8dde5] bg-white px-[11px] py-1 text-[12.5px] text-[#8b93a1] hover:border-[#93b4fb] hover:text-[#2563eb]">
                      <span className="text-xs">＋</span>Categorise
                    </span>
                  } />
              )}
            </span>
            <span className="hidden truncate text-[12.5px] text-[#79818f] lg:block">{t.account_name}</span>
            <span className={cn('text-right text-[13.5px] tabular-nums tracking-[-0.01em]',
              Number(t.amount_cents) > 0 ? 'font-semibold text-[#0f7a52]' : 'font-medium')}>
              {signedMoney(t.amount_cents)}
            </span>
          </div>
        ))}
      </div>

      <SpendingAnalysis onOpenTransactions={txLink} />
    </div>
  )
}

// ---- Spending analysis: ranked findings with a savings banner ----

function SpendingAnalysis({ onOpenTransactions }: { onOpenTransactions: (f: Record<string, unknown>) => void }) {
  const [entry, setEntry] = useState<any>(null) // { id, created_at, months, model, report, dismissed_findings }
  const [history, setHistory] = useState<any[]>([])
  const [months, setMonths] = useState(3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState(false)

  const loadHistory = () => get('/ai/analyses').then(setHistory).catch(() => {})
  // Expand the first finding the user can actually see — dismissed ones are filtered out
  const showEntry = (e: any) => {
    setEntry(e); setShowAll(false)
    const first = (e?.report?.findings || []).find((f: any) => !(e.dismissed_findings || []).includes(f.id))
    setOpen(first ? { [first.id]: true } : {})
  }
  useEffect(() => {
    get('/ai/analysis/latest').then(r => { if (r) showEntry(r) }).catch(() => {})
    loadHistory()
  }, [])

  const run = async () => {
    setBusy(true); setError('')
    try {
      const r = await post('/ai/analysis', { months })
      if (!r?.report) throw new Error('The AI returned an unexpected response — try again.')
      showEntry(r)
      loadHistory()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  const dismiss = async (findingId: string) => {
    if (!entry) return
    setEntry({ ...entry, dismissed_findings: [...(entry.dismissed_findings || []), findingId] })
    post(`/ai/analyses/${entry.id}/dismiss`, { findingId }).catch(() => {})
  }

  const report = entry?.report
  const dismissed: string[] = entry?.dismissed_findings || []
  const findings = useMemo(
    () => (report?.findings || []).filter((f: any) => !dismissed.includes(f.id)),
    [report, dismissed])
  const totalSaving = findings.reduce((s: number, f: any) => s + (Number(f.annualSaving) || 0), 0)
  const shown = showAll ? findings : findings.slice(0, 4)
  const hidden = findings.slice(4)
  const hiddenValue = hidden.reduce((s: number, f: any) => s + (Number(f.annualSaving) || 0), 0)

  const selectCls = 'h-8 cursor-pointer appearance-none rounded-[9px] border border-[#dfe3ea] bg-white pl-[11px] pr-7 text-[12.5px] text-[#39404b]'

  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-3 p-[14px_16px]">
        <h3 className="flex items-center gap-1.5 text-[13.5px] font-[650] tracking-[-0.005em]">
          <span className="text-[11px] text-[#a99ff0]">✦</span>Spending analysis
        </h3>
        {entry && (
          <span className="text-[11.5px] text-[#a4abb8]" title={entry.model}>
            {dateTimeLocal(entry.created_at)} · last {entry.months} month{entry.months === 1 ? '' : 's'}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {history.length > 0 && (
            <div className="relative">
              <select className={selectCls} value={entry?.id ?? ''}
                onChange={e => { const h = history.find(x => x.id === e.target.value); if (h) showEntry(h) }}>
                <option value="">Past analyses…</option>
                {history.map(h => <option key={h.id} value={h.id}>{dateTimeLocal(h.created_at)} · {h.months}mo</option>)}
              </select>
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-[#9aa2af]">▼</span>
            </div>
          )}
          <div className="relative">
            <select className={selectCls} value={months} onChange={e => setMonths(+e.target.value)}>
              {[1, 3, 6, 12].map(m => <option key={m} value={m}>Last {m} month{m > 1 ? 's' : ''}</option>)}
            </select>
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-[#9aa2af]">▼</span>
          </div>
          <button onClick={run} disabled={busy}
            className="h-8 cursor-pointer rounded-[9px] border border-[#ddd8f7] bg-white px-3 text-[12.5px] font-[550] text-[#5b4bd6] hover:border-[#c7bef2] hover:bg-[#f7f5ff] disabled:opacity-60">
            {busy ? 'Analysing…' : 'Run analysis'}
          </button>
        </div>
      </div>

      {error && <p className="border-t border-[#eef0f4] px-4 py-3 text-[13px] text-red-600">{error}</p>}
      {busy && <p className="border-t border-[#eef0f4] px-4 py-3 text-[13px] text-[#79818f]">Analysing your spending — this can take up to a minute…</p>}

      {!entry && !busy && !error && (
        <p className="border-t border-[#eef0f4] px-4 py-8 text-center text-[13px] text-[#9aa2af]">
          Run an analysis to find savings across your recent spending.
        </p>
      )}

      {/* Legacy reports (section format) still render, so history stays readable */}
      {report && !report.findings && report.sections && (
        <div className="border-t border-[#eef0f4] p-4">
          {report.sections.map((s: any) => (
            <details key={s.title} className="mb-2 rounded border border-[#eef0f4] p-2" open>
              <summary className="cursor-pointer text-[13px] font-semibold">{s.title}</summary>
              {s.body && <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-[#5d6674]">{s.body}</p>}
              {s.items && <ul className="mt-1 list-disc pl-5 text-[12.5px] text-[#5d6674]">{s.items.map((it: string, i: number) => <li key={i}>{it}</li>)}</ul>}
            </details>
          ))}
        </div>
      )}

      {report?.findings && (
        <>
          <div className="flex flex-wrap items-center gap-6 border-y border-[#eef0f4] bg-[#faf9ff] p-[14px_16px]">
            <div>
              <p className="text-[26px] font-[650] tabular-nums tracking-[-0.025em] text-[#4b3cc4]">
                {dollars(totalSaving || report.totalAnnualSaving || 0)}<span className="ml-0.5 text-[15px] font-[550] text-[#8177c9]">/yr</span>
              </p>
              <p className="text-[11.5px] text-[#8177c9]">identified across {findings.length} finding{findings.length === 1 ? '' : 's'}</p>
            </div>
            {report.summary && <p className="flex-1 text-[13px] leading-[1.5] text-[#3f4753] [text-wrap:pretty]">{report.summary}</p>}
          </div>

          {shown.map((f: any) => {
            const isOpen = !!open[f.id]
            return (
              <div key={f.id} className={cn('border-t border-[#f4f6f8]', isOpen && 'bg-[#fafbfe]')}>
                <button onClick={() => setOpen(o => ({ ...o, [f.id]: !o[f.id] }))} aria-expanded={isOpen}
                  className="grid min-h-[50px] w-full cursor-pointer grid-cols-[1fr_92px_24px] items-center gap-3.5 px-4 text-left hover:bg-[#fafbfe] sm:grid-cols-[1fr_106px_92px_24px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn('shrink-0 rounded-md px-[7px] py-0.5 text-[10.5px] font-semibold', TONES[f.tone] || TONES.neutral)}>{f.tag}</span>
                    <span className="truncate text-[13px] font-[550]">{f.title}</span>
                  </span>
                  <span className="hidden truncate text-[12px] text-[#9aa2af] sm:block">{f.now}</span>
                  <span className="text-right text-[13px] font-semibold tabular-nums text-[#0f7a52]">{dollars(Number(f.annualSaving) || 0)}/yr</span>
                  <span className={cn('justify-self-end text-[9px] text-[#b0b7c3] transition-transform', isOpen && 'rotate-180')}>▼</span>
                </button>
                {isOpen && (
                  <div className="animate-slide-down px-4 pb-[15px]">
                    {f.detail && <p className="max-w-[760px] text-[12.5px] leading-[1.55] text-[#5d6674] [text-wrap:pretty]">{f.detail}</p>}
                    {f.evidence?.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-x-2 gap-y-1.5">
                        {f.evidence.map((e: string, i: number) => (
                          <span key={i} className="rounded-[7px] border border-[#eef0f4] bg-[#fbfcfd] px-2.5 py-[3px] text-[11.5px] tabular-nums text-[#5d6674]">{e}</span>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {f.action && (
                        <button onClick={() => onOpenTransactions(f.search ? { search: f.search } : {})}
                          className="h-[30px] cursor-pointer rounded-lg bg-[#2563eb] px-3 text-[12.5px] font-[550] text-white hover:bg-[#1d4ed8]">{f.action}</button>
                      )}
                      <button onClick={() => onOpenTransactions(f.search ? { search: f.search } : {})}
                        className="h-[30px] cursor-pointer rounded-lg border border-[#dfe3ea] px-3 text-[12.5px] text-[#4b5462] hover:bg-[#f7f8fa]">Show transactions</button>
                      <button onClick={() => dismiss(f.id)}
                        className="h-[30px] cursor-pointer rounded-lg px-3 text-[12.5px] text-[#9aa2af] hover:bg-[#f1f3f7]">Dismiss</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {hidden.length > 0 && (
            <button onClick={() => setShowAll(s => !s)}
              className="flex w-full cursor-pointer items-center justify-center gap-[7px] border-t border-[#eef0f4] bg-[#fcfcfd] p-[12px_16px] text-[12.5px] font-[550] text-[#4b5462] hover:bg-[#f7f8fa]">
              {showAll ? 'Show fewer findings' : `${hidden.length} more finding${hidden.length === 1 ? '' : 's'} · ${dollars(hiddenValue)}/yr`}
              <span className={cn('text-[9px] transition-transform', showAll && 'rotate-180')}>▼</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}
