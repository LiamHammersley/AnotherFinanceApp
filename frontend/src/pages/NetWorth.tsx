import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { get, patch, post } from '../lib/api'
import { money, isZeroCents, signedDollars, wholeDollars, longDate } from '../lib/format'
import { Spinner, cn } from '../components/ui'

const CARD = 'rounded-[12px] border border-[#e8ebf0] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]'
const LABEL = 'text-[11px] font-[600] uppercase tracking-[0.055em] text-[#8b93a1]'
const RANGES = ['1M', '3M', '6M', '1Y', 'All'] as const
const RANGE_DAYS: Record<string, number> = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365 }

const GOOD = '#0f7a52'
const BAD = '#c2540a'

// Zero, sign and whole-dollar rules live in lib/format so they can be unit tested —
// the old screen's red "-$0.00" credit card was a formatting bug, not a data one.
const isZero = isZeroCents
const signed = signedDollars
const plain = wholeDollars

const TYPE_LABEL: Record<string, string> = {
  standard: 'bank', credit_card: 'credit card', mortgage: 'mortgage',
  property: 'property', loan: 'loan', vehicle: 'vehicle', investment: 'investment', other: 'other',
}

export default function NetWorth() {
  const [range, setRange] = useState<typeof RANGES[number]>('1M')
  const [archived, setArchived] = useState(false)
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    get(`/networth?range=${range}&includeArchived=${archived}`).then(setData).catch(e => setError(e.message))
  }, [range, archived])
  useEffect(() => { load() }, [load])

  if (error) return <p className="text-red-600">{error}</p>
  if (!data) return <Spinner />

  const { totals, snapshots, movement, accounts } = data
  const grid: number[] = data.gridlines ?? []
  const assets = accounts.filter((a: any) => a.side === 'asset')
  const liabilities = accounts.filter((a: any) => a.side === 'liability')
  const property = assets.find((a: any) => a.kind === 'holding' && a.type === 'property')
  const cash = totals.cash_cents
  const assetShare = totals.assets_cents + totals.liabilities_cents > 0
    ? totals.assets_cents / (totals.assets_cents + totals.liabilities_cents) : 1
  const delta = movement?.total_cents ?? 0
  const deltaPct = snapshots?.[0]?.net_cents ? (delta / Math.abs(snapshots[0].net_cents)) * 100 : 0
  // Loan-to-value: the one figure the account list can't state
  const lvr = property && property.balance_cents
    ? (totals.liabilities_cents / property.balance_cents) * 100 : null

  return (
    <div className="space-y-3">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="mb-1 text-[22px] font-[650] tracking-[-0.02em] text-[#171b22]">Net worth</h1>
          <p className="text-[13px] text-[#79818f]">
            {assets.length} asset{assets.length === 1 ? '' : 's'} · {liabilities.length} liabilit{liabilities.length === 1 ? 'y' : 'ies'}
            {data.earliest && <> · history since {longDate(data.earliest)}</>}
          </p>
        </div>
      </header>

      {/* Summary: only the net card carries colour — the labels already say
          assets and liabilities, so painting those green and red restates them */}
      <div className="grid gap-3 md:grid-cols-[1.3fr_1fr_1fr]">
        <div className={cn(CARD, 'p-4')}>
          <div className="flex items-baseline justify-between">
            <span className={LABEL}>Net worth</span>
            <span className="text-[11.5px] text-[#a4abb8]">{movement ? `since ${longDate(movement.from)}` : 'today'}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-[9px]">
            <span className="text-[29px] font-[650] tabular-nums tracking-[-0.025em] text-[#171b22]">{money(totals.net_cents)}</span>
            {movement && (
              <span className="text-[12.5px] font-[550] tabular-nums" style={{ color: delta >= 0 ? GOOD : BAD }}>
                {signed(delta)} ({delta >= 0 ? '+' : '−'}{Math.abs(deltaPct).toFixed(1)}%)
              </span>
            )}
          </div>
          <div className="mt-3 flex h-[6px] overflow-hidden rounded-full bg-[#f1f3f7]">
            <div style={{ width: `${assetShare * 100}%`, backgroundColor: '#0f9d6e' }} />
            <div style={{ width: `${(1 - assetShare) * 100}%`, backgroundColor: '#e0722f' }} />
          </div>
          <p className="mt-[7px] text-[11.5px] text-[#9aa2af]">
            {lvr != null
              ? `Home loan sits at ${lvr.toFixed(0)}% of the property value`
              : `${(assetShare * 100).toFixed(0)}% of the balance sheet is assets`}
          </p>
        </div>

        <Summary label="Assets" value={totals.assets_cents}
          caption={property
            ? `${money(cash)} in cash · property ${plain(property.balance_cents)}`
            : `${money(cash)} in cash`} />
        <Summary label="Liabilities" value={totals.liabilities_cents}
          caption={liabilities.length === 0 ? 'Nothing owed'
            : liabilities.filter((l: any) => !isZero(l.balance_cents)).length === 1
              ? `All ${liabilities.find((l: any) => !isZero(l.balance_cents))?.name}${liabilities.some((l: any) => isZero(l.balance_cents)) ? ' — the credit card is paid to $0.00' : ''}`
              : `Across ${liabilities.length} accounts`} />
      </div>

      <Chart snapshots={snapshots} movement={movement} grid={grid} range={range} onRange={setRange}
        historyDays={data.earliest ? Math.round((Date.parse(`${data.today}T00:00:00Z`) - Date.parse(`${data.earliest}T00:00:00Z`)) / 86400000) : 0}
        archived={archived} onArchived={setArchived} />

      <div className="grid gap-3 xl:grid-cols-2">
        <AccountList title="Assets" rows={assets} balanceHeader="Balance" side="asset" onChanged={load} />
        <AccountList title="Liabilities" rows={liabilities} balanceHeader="Owing" side="liability" onChanged={load} />
      </div>
    </div>
  )
}

function Summary({ label, value, caption }: { label: string; value: number; caption: string }) {
  return (
    <div className={cn(CARD, 'p-4')}>
      <span className={LABEL}>{label}</span>
      <p className="mt-1 text-[22px] font-[650] tabular-nums text-[#171b22]">{money(value)}</p>
      <p className="mt-[7px] text-[11.5px] text-[#9aa2af]">{caption}</p>
    </div>
  )
}

function Chart({ snapshots, movement, grid, range, onRange, historyDays, archived, onArchived }: any) {
  const [hover, setHover] = useState<number | null>(null)
  const values: number[] = snapshots.map((s: any) => s.net_cents)
  const lo = Math.min(...values), hi = Math.max(...values)
  // Fitted domain, never zero-anchored: a net-worth line drawn from $0 is a flat
  // line and hides every real month of movement. Pad a flat series so it centres.
  const pad = hi === lo ? Math.max(Math.abs(hi) * 0.01, 100) : (hi - lo) * 0.12
  const [min, max] = [lo - pad, hi + pad]
  const W = 1000, H = 260
  const x = (i: number) => snapshots.length < 2 ? W / 2 : (i / (snapshots.length - 1)) * W
  const y = (v: number) => H - ((v - min) / (max - min)) * H

  const lines: number[] = grid.length ? grid : []
  // With gridlines a few hundred dollars apart, "$212k" twice tells you nothing —
  // the label's precision has to follow the gap between the lines
  const gap = lines.length > 1 ? lines[1] - lines[0] : 0
  const decimals = gap > 0 && gap < 100_000 ? 1 : 0
  const pts = snapshots.map((s: any, i: number) => `${x(i)},${y(s.net_cents)}`).join(' ')
  const label = movement
    ? `Net worth over the last ${range === 'All' ? 'period' : range}, ${movement.total_cents >= 0 ? 'up' : 'down'} ${plain(movement.total_cents)} to ${money(values.at(-1) ?? 0)}`
    : `Net worth ${money(values.at(-1) ?? 0)}`

  return (
    <div className={cn(CARD, 'overflow-hidden')}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <p className="text-[13.5px] font-[650]">Net worth over time</p>
        <div className="ml-auto flex items-center gap-3.5">
          <div role="radiogroup" aria-label="Chart range" className="flex gap-0.5">
            {RANGES.map(r => {
              // A window longer than the data itself just clamps back to the same
              // start as "All" — a tab that can't change the chart shouldn't invite
              // the click that proves it.
              const dead = RANGE_DAYS[r] != null && historyDays > 0 && RANGE_DAYS[r] >= historyDays
              return (
                <button key={r} role="radio" aria-checked={range === r} disabled={dead}
                  onClick={() => onRange(r)}
                  title={dead ? `Only ${historyDays} days of history so far — this is the same as All` : undefined}
                  className={cn('h-7 rounded-lg px-2.5 text-[12px]',
                    dead ? 'cursor-not-allowed font-[450] text-[#c2c8d2]'
                      : range === r ? 'cursor-pointer bg-[#f1f3f7] font-[600] text-[#171b22]'
                        : 'cursor-pointer font-[450] text-[#5d6674] hover:bg-[#f7f8fa]')}>
                  {r}
                </button>
              )
            })}
          </div>
          <span className="h-[18px] w-px bg-[#e8ebf0]" />
          <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[#5d6674]">
            <input type="checkbox" checked={archived} onChange={e => onArchived(e.target.checked)}
              className="h-4 w-4 cursor-pointer rounded-[5px] border-[1.5px] border-[#cdd3dd] accent-[#2563eb]" />
            Include archived
          </label>
        </div>
      </div>

      {snapshots.length < 2 ? (
        <p className="px-4 pb-6 pt-2 text-center text-[13px] text-[#9aa2af]">
          History starts today — check back after your next import.
        </p>
      ) : (
        <>
          <div className="relative h-[200px] px-4 sm:h-[260px]"
            onPointerMove={e => {
              const b = e.currentTarget.getBoundingClientRect()
              const frac = (e.clientX - b.left - 16) / Math.max(1, b.width - 32)
              setHover(Math.min(snapshots.length - 1, Math.max(0, Math.round(frac * (snapshots.length - 1)))))
            }}
            onPointerLeave={() => setHover(null)}>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" role="img" aria-label={label}>
              {lines.map(v => <line key={v} x1="0" x2={W} y1={y(v)} y2={y(v)} stroke="#eef0f4" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
              <polygon points={`0,${H} ${pts} ${W},${H}`} fill="rgba(37,99,235,0.07)" />
              <polyline points={pts} fill="none" stroke="#2563eb" strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              {/* Dots only while each one is still a distinct thing you could point at */}
              {snapshots.length <= 20 && snapshots.map((sn: any, i: number) => (
                <circle key={sn.date} cx={x(i)} cy={y(sn.net_cents)} r={hover === i ? 4 : 3}
                  fill={hover === i ? '#2563eb' : '#fff'} stroke="#2563eb" strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke" />
              ))}
              {hover != null && (
                <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="#cdd3dd" strokeWidth="1"
                  strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
            {hover != null && (
              // Flips to the left of the crosshair past halfway so it never runs off
              <div className="pointer-events-none absolute z-10 -translate-y-1/2 whitespace-nowrap rounded-lg border border-[#e8ebf0] bg-white px-2.5 py-1.5 text-[12px] shadow-[0_2px_8px_rgba(16,24,40,0.08)]"
                style={{
                  // The plot is inset by the card's 16px padding on each side, so the
                  // point's position is a fraction of (width − 32px), not of width
                  left: `calc(16px + (100% - 32px) * ${(x(hover) / W).toFixed(4)})`,
                  top: `${(y(snapshots[hover].net_cents) / H) * 100}%`,
                  transform: `translate(${x(hover) > W / 2 ? '-100%' : '0'}, -50%) translateX(${x(hover) > W / 2 ? '-10px' : '10px'})`,
                }}>
                <span className="block text-[11px] text-[#9aa2af]">{longDate(snapshots[hover].date)}</span>
                <span className="block font-[600] tabular-nums text-[#171b22]">{money(snapshots[hover].net_cents)}</span>
              </div>
            )}
            {lines.map(v => (
              <span key={v} className="pointer-events-none absolute left-4 -translate-y-1/2 rounded bg-white px-1 text-[10.5px] text-[#a4abb8]"
                style={{ top: `${(y(v) / H) * 100}%` }}>{shortMoney(v, decimals)}</span>
            ))}
          </div>
          <div className="flex justify-between px-4 pb-3 pt-2 text-[11px] text-[#9aa2af]">
            {axisLabels(snapshots).map((s, i) => <span key={i}>{s}</span>)}
          </div>
        </>
      )}

      {/* The text alternative to the chart, and the only place that says WHY */}
      {movement && (
        <p className="border-t border-[#eef0f4] px-4 py-[11px] text-[12px] text-[#79818f]">
          {movement.total_cents >= 0 ? 'Up' : 'Down'} {plain(movement.total_cents)} since {longDate(movement.from)}
          {movement.parts.length > 0 && ' — '}
          {movement.parts.map((p: any, i: number) => (
            <span key={p.label}>
              {i > 0 && ' · '}{p.label}{' '}
              {/* Direction is literal — a loan paid down reads −$1,132 — while the
                  colour carries whether it helped or hurt */}
              <span className="font-[550] tabular-nums" style={{ color: p.effect_cents >= 0 ? GOOD : BAD }}>{signed(p.amount_cents)}</span>
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

function AccountList({ title, rows, balanceHeader, side, onChanged }: any) {
  const navigate = useNavigate()
  const [adding, setAdding] = useState(false)
  const total = rows.reduce((n: number, r: any) => n + Number(r.balance_cents), 0)
  return (
    <div className={cn(CARD, 'flex flex-col overflow-hidden')}>
      <div className="flex items-center justify-between px-4 py-3">
        <p className="text-[13.5px] font-[650]">{title} <span className="font-[450] text-[#9aa2af]">· {rows.length}</span></p>
        <button onClick={() => setAdding(a => !a)}
          className="h-[30px] cursor-pointer rounded-lg border border-dashed border-[#d8dde5] px-[11px] text-[12.5px] text-[#8b93a1] hover:border-[#93b4fb] hover:text-[#2563eb]">
          ＋ Add {side}
        </button>
      </div>
      {adding && <AddHolding side={side} onDone={() => { setAdding(false); onChanged() }} onCancel={() => setAdding(false)} />}
      <div className="grid h-[30px] grid-cols-[1fr_130px_32px] items-center gap-3 border-y border-[#eef0f4] bg-[#fbfcfd] px-4 text-[11px] font-[600] uppercase text-[#8b93a1] sm:grid-cols-[1fr_92px_130px_32px]">
        <span>Account</span>
        <span className="hidden text-right sm:block">30 days</span>
        <span className="text-right">{balanceHeader}</span>
        <span />
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-[#9aa2af]">
          Track a property, loan or account to build your net worth. Debts held outside
          the app — a private loan, say — go here.
        </p>
      ) : rows.map((r: any) => (
        <Row key={r.id} r={r} onChanged={onChanged} onView={() => {
          sessionStorage.setItem('tx-filter', JSON.stringify({ account: r.id }))
          navigate('/transactions')
        }} />
      ))}
      {rows.length > 0 && (
        <div className="mt-auto flex items-center justify-between bg-[#fcfcfd] px-4 py-3">
          <span className="text-[13px] font-[650]">Total {title.toLowerCase()}</span>
          <span className="pr-[44px] text-[13px] font-[650] tabular-nums">{money(total)}</span>
        </div>
      )}
    </div>
  )
}

// Manual holdings are how anything the bank feed can't see — a house, a private
// loan — reaches net worth. This is the flow the redesign's ＋ button opens.
function AddHolding({ side, onDone, onCancel }: any) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState(side === 'asset' ? 'property' : 'loan')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const cents = Math.round(parseFloat(value) * 100)
    if (!name.trim() || !Number.isFinite(cents) || cents <= 0) return setError('A name and a value above zero are required')
    setBusy(true); setError('')
    try {
      await post('/holdings', { name: name.trim(), side, kind, valueCents: cents, asOf: new Date().toISOString().slice(0, 10) })
      onDone()
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  const KINDS = side === 'asset'
    ? ['property', 'vehicle', 'investment', 'other']
    : ['loan', 'other']

  return (
    <div className="border-y border-[#eef0f4] bg-[#fbfcfd] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel() }}
          placeholder={side === 'asset' ? 'e.g. 9 Beamish Street' : 'e.g. Loan from Mum'}
          aria-label={`Name of the ${side}`}
          className="h-8 min-w-[160px] flex-1 rounded-lg border border-[#dfe3ea] px-2.5 text-[13px] focus:border-[#93b4fb] focus:outline-none" />
        <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Type"
          className="h-8 cursor-pointer rounded-lg border border-[#dfe3ea] px-2 text-[13px]">
          {KINDS.map(k => <option key={k} value={k}>{TYPE_LABEL[k] ?? k}</option>)}
        </select>
        <input type="number" min="0" step="1" value={value} onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel() }}
          placeholder="Value" aria-label={`Current value of the ${side}`}
          className="h-8 w-[110px] rounded-lg border border-[#dfe3ea] px-2.5 text-right text-[13px] focus:border-[#93b4fb] focus:outline-none" />
        <button onClick={submit} disabled={busy}
          className="h-8 cursor-pointer rounded-lg bg-[#2563eb] px-3 text-[12.5px] font-[550] text-white hover:bg-[#1d4ed8] disabled:opacity-60">
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button onClick={onCancel} aria-label="Cancel"
          className="h-8 w-8 cursor-pointer rounded-lg text-[#c2c8d2] hover:bg-[#f1f3f7] hover:text-[#5d6674]">✕</button>
      </div>
      {error && <p className="mt-2 text-[12.5px] text-red-600">{error}</p>}
    </div>
  )
}

// Accounts and manual holdings live in different tables but answer the same two
// verbs, so the menu doesn't need to know which it is beyond the path.
const basePath = (r: any) => r.kind === 'holding' ? `/holdings/${r.id}` : `/accounts/${r.id}`

function Row({ r, onChanged, onView }: any) {
  const [editing, setEditing] = useState(false)

  const rename = async () => {
    const name = window.prompt('Rename', r.name)
    if (!name || name.trim() === r.name) return
    await patch(basePath(r), { name: name.trim() })
    onChanged()
  }

  const setArchived = async (archived: boolean) => {
    if (archived && !window.confirm(
      `Archive ${r.name}?\n\nIt drops out of net worth and the lists. Nothing is deleted — ` +
      `tick "Include archived" to see it again and restore it.`)) return
    await patch(basePath(r), { archived })
    onChanged()
  }
  const zero = isZero(r.balance_cents)
  const canRevalue = r.kind === 'holding'
  // A liability shrinking is good news; an asset shrinking is not
  const good = r.side === 'liability' ? (r.change30d_cents ?? 0) < 0 : (r.change30d_cents ?? 0) > 0

  return (
    <div className="grid min-h-12 grid-cols-[1fr_130px_32px] items-center gap-3 border-b border-[#f4f6f8] px-4 py-2 hover:bg-[#fafbfe] sm:grid-cols-[1fr_92px_130px_32px]">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[13.5px] font-[600] text-[#171b22]">{r.name}</span>
        <span className="shrink-0 rounded-full bg-[#f1f3f7] px-[7px] py-0.5 text-[10.5px] font-[550] text-[#5d6674]">
          {TYPE_LABEL[r.type] ?? r.type}
        </span>
        {r.side === 'liability' && zero &&
          <span className="shrink-0 rounded-full bg-[#e8f5ee] px-1.5 py-px text-[10.5px] font-[550] text-[#0f7a52]">paid off</span>}
        {r.archived &&
          <span className="shrink-0 rounded-full bg-[#f1f3f7] px-1.5 py-px text-[10.5px] font-[550] text-[#9aa2af]">archived</span>}
      </span>

      {/* Property value only ever moves by revaluation, so the cell offers the
          action rather than a fake $0 change */}
      {/* Revalue also lives in the row menu, so hiding this column costs no action */}
      <span className="hidden justify-self-end text-[12.5px] tabular-nums sm:block">
        {canRevalue
          ? <button onClick={() => setEditing(true)} className="cursor-pointer text-[#2563eb] hover:underline">Revalue</button>
          : r.change30d_cents == null || isZero(r.change30d_cents)
            ? <span className="text-[#c2c8d2]">—</span>
            : <span style={{ color: good ? GOOD : BAD }}>{signed(r.change30d_cents)}</span>}
      </span>

      <span className="justify-self-end text-right">
        {editing
          ? <Revaluer r={r} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
          : <>
            <span className={cn('block text-[13.5px] font-[600] tabular-nums tracking-[-0.01em]', zero ? 'text-[#c2c8d2]' : 'text-[#171b22]')}>
              {money(Math.abs(Number(r.balance_cents)))}
            </span>
            {r.valued_at && <span className="block text-[11px] text-[#9aa2af]">as at {longDate(r.valued_at)}</span>}
          </>}
      </span>

      <RowMenu name={r.name} onView={onView} onEdit={rename}
        archived={r.archived} onArchive={() => setArchived(!r.archived)}
        onRevalue={canRevalue ? () => setEditing(true) : null} />
    </div>
  )
}

function Revaluer({ r, onDone, onCancel }: any) {
  const [v, setV] = useState(String(Math.round(Number(r.balance_cents) / 100)))
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])

  const save = async () => {
    const cents = Math.round(parseFloat(v) * 100)
    if (!Number.isFinite(cents) || cents <= 0) return onCancel()
    setBusy(true)
    try {
      await post(`/holdings/${r.id}/values`, { valueCents: cents, asOf: new Date().toISOString().slice(0, 10) })
      onDone()
    } catch { setBusy(false); onCancel() }
  }

  return (
    <span className="flex items-center justify-end gap-1.5">
      <input ref={ref} type="number" min="0" step="1" disabled={busy}
        aria-label={`Current value of ${r.name}`} value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel() }}
        className="h-7 w-[104px] rounded-lg border border-[#93b4fb] px-2 text-right text-[12.5px] focus:outline-none focus:ring-[3px] focus:ring-[rgba(37,99,235,0.10)]" />
      <button onClick={save} disabled={busy}
        className="h-7 cursor-pointer rounded-lg bg-[#2563eb] px-2.5 text-[12px] font-[550] text-white hover:bg-[#1d4ed8] disabled:opacity-60">Set</button>
      <button onClick={onCancel} aria-label="Cancel"
        className="h-6 w-6 cursor-pointer rounded text-[#c2c8d2] hover:bg-[#f1f3f7] hover:text-[#5d6674]">✕</button>
    </span>
  )
}

function RowMenu({ name, onView, onEdit, onRevalue, archived, onArchive }: any) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pos) return
    const close = () => setPos(null)
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setPos(null) }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', close, true)
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('scroll', close, true) }
  }, [pos])
  const item = 'block w-full cursor-pointer px-3 py-1.5 text-left text-[13px] text-[#3f4753] hover:bg-gray-50'
  return (
    <div ref={ref} className="justify-self-end">
      <button aria-label={`Actions for ${name}`} onClick={e => {
        if (pos) return setPos(null)
        const b = e.currentTarget.getBoundingClientRect()
        const h = 32 * (2 + (onRevalue ? 1 : 0) + (onArchive ? 1 : 0))
        setPos({ top: window.innerHeight - b.bottom > h + 8 ? b.bottom + 4 : b.top - h - 4, left: Math.max(8, b.right - 176) })
      }}
        className="h-[26px] w-[26px] cursor-pointer rounded-[7px] text-[#c2c8d2] hover:bg-[#f1f3f7] hover:text-[#4b5462]">⋯</button>
      {pos && (
        <div style={{ top: pos.top, left: pos.left, width: 176 }}
          className="fixed z-50 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {onRevalue && <button className={item} onClick={() => { setPos(null); onRevalue() }}>Revalue</button>}
          <button className={item} onClick={() => { setPos(null); onEdit() }}>Rename</button>
          <button className={item} onClick={() => { setPos(null); onView() }}>View transactions</button>
          {onArchive && <button className={cn(item, !archived && 'text-red-600')}
            onClick={() => { setPos(null); onArchive() }}>{archived ? 'Restore' : 'Archive'}</button>}
        </div>
      )}
    </div>
  )
}

// --- chart helpers -----------------------------------------------------------
const shortMoney = (cents: number, decimals = 0) => {
  const d = Math.abs(cents) / 100
  const sign = cents < 0 ? '−' : ''
  if (d >= 1_000_000) return `${sign}$${(d / 1_000_000).toFixed(Math.max(decimals, 1))}m`
  if (d >= 1000) return `${sign}$${(d / 1000).toFixed(decimals)}k`
  return `${sign}$${d.toFixed(0)}`
}

// Six labels at most, evenly spread, so they never collide
function axisLabels(snapshots: any[]) {
  const n = Math.min(6, snapshots.length)
  const step = (snapshots.length - 1) / (n - 1 || 1)
  return Array.from({ length: n }, (_, i) => {
    const s = snapshots[Math.round(i * step)]
    const d = new Date(`${s.date}T00:00:00`)
    return `${d.getDate()} ${d.toLocaleDateString('en-AU', { month: 'short' })}`
  })
}
