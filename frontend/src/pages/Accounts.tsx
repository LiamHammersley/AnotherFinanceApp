import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { get, post } from '../lib/api'
import { money, monthLabel, dateLocal } from '../lib/format'
import { Badge, Spinner, cn } from '../components/ui'

const CARD = 'rounded-[14px] border border-[#e8ebf0] bg-white'
const LABEL = 'text-[11px] font-[550] uppercase tracking-[0.06em] text-[#9aa2af]'

const shiftMonth = (ym: string, by: number) => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + by, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// A credit card or mortgage in credit is a debt shrinking, not money in the bank.
// Colour follows the arithmetic, the wording follows what the account is.
const balanceWord = (type: string, cents: number) =>
  type === 'standard' ? (cents < 0 ? 'overdrawn' : '') : cents < 0 ? 'owing' : 'in credit'

export default function Accounts() {
  const { id } = useParams()
  return id ? <Register id={id} /> : <AccountList />
}

function AccountList() {
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState<any[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { get('/accounts').then(setAccounts).catch(e => setError(e.message)) }, [])

  if (error) return <p className="text-red-600">{error}</p>
  if (!accounts) return <Spinner />

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[22px] font-[650] tracking-[-0.02em] text-[#171b22]">Accounts</h1>
        <p className="mt-1 text-[13px] text-[#79818f]">Open an account to check its running balance against your statement.</p>
      </div>
      <div className={cn(CARD, 'overflow-hidden')}>
        {accounts.map(a => (
          <button key={a.id} onClick={() => navigate(`/accounts/${a.id}`)}
            className="flex w-full cursor-pointer items-center gap-3 border-t border-[#f4f6f8] px-4 py-3 text-left first:border-t-0 hover:bg-[#fafbfe]">
            <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ backgroundColor: a.colour || '#2563eb' }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold">{a.name}</span>
              <span className="block text-[12px] text-[#9aa2af]">{a.type.replace('_', ' ')}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className={cn('block text-[14px] font-semibold tabular-nums',
                Number(a.balance_cents) < 0 ? 'text-[#b4232a]' : 'text-[#171b22]')}>
                {money(a.balance_cents)}
              </span>
              {balanceWord(a.type, Number(a.balance_cents)) &&
                <span className="block text-[11.5px] text-[#9aa2af]">{balanceWord(a.type, Number(a.balance_cents))}</span>}
            </span>
            <span className="shrink-0 text-[#c2c8d2]">›</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Register({ id }: { id: string }) {
  const navigate = useNavigate()
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    get(`/accounts/${id}/register?month=${month}`).then(setData).catch(e => setError(e.message))
  }, [id, month])
  useEffect(() => { setData(null); load() }, [load])

  if (error) return <p className="text-red-600">{error}</p>
  if (!data) return <Spinner />
  const { account, rows, totals, opening_cents, closing_cents } = data

  return (
    <div className="space-y-3">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <button onClick={() => navigate('/accounts')}
            className="mb-1 cursor-pointer text-[12.5px] text-[#79818f] hover:text-[#2563eb]">‹ All accounts</button>
          <h1 className="flex items-center gap-2 text-[22px] font-[650] tracking-[-0.02em] text-[#171b22]">
            <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ backgroundColor: account.colour || '#2563eb' }} />
            <span className="truncate">{account.name}</span>
          </h1>
          <p className="mt-1 text-[13px] text-[#79818f]">
            Balance today {money(account.balance_cents)}
            {balanceWord(account.type, account.balance_cents) && ` ${balanceWord(account.type, account.balance_cents)}`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <StepButton label="Previous month" onClick={() => setMonth(m => shiftMonth(m, -1))}>‹</StepButton>
          <span className="min-w-[118px] text-center text-[13.5px] font-semibold">{monthLabel(month)}</span>
          <StepButton label="Next month" onClick={() => setMonth(m => shiftMonth(m, 1))}>›</StepButton>
        </div>
      </div>

      {/* Opening, what moved, closing — the three numbers a statement is checked against */}
      <div className={cn(CARD, 'grid grid-cols-2 gap-4 p-4 sm:grid-cols-4')}>
        <Figure label="Opening balance" value={money(opening_cents)} />
        <Figure label="Money in" value={money(totals.in_cents)} className="text-[#0f7a52]" />
        <Figure label="Money out" value={money(totals.out_cents)} className="text-[#b4232a]" />
        <Figure label="Closing balance" value={money(closing_cents)} strong />
      </div>

      <Reconcile account={account} closing={closing_cents} to={data.to} onDone={load} />

      <div className={cn(CARD, 'overflow-hidden')}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2.5 pt-3.5">
          <p className="text-[13.5px] font-[650]">
            {monthLabel(month)} <span className="font-[450] text-[#9aa2af]">· {totals.count} transaction{totals.count === 1 ? '' : 's'}</span>
          </p>
          <p className="text-[12px] text-[#9aa2af]">Newest first · balance is after each transaction</p>
        </div>

        {rows.length === 0 ? (
          <p className="border-t border-[#f4f6f8] px-4 py-6 text-center text-[13px] text-[#9aa2af]">
            Nothing moved in this account during {monthLabel(month)}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse sm:min-w-[640px]">
              <thead>
                <tr className="border-t border-[#f4f6f8] text-left text-[11px] uppercase tracking-[0.05em] text-[#9aa2af]">
                  <th className="px-2 py-2 font-[550] sm:px-4">Date</th>
                  <th className="px-2 py-2 font-[550] sm:px-4">Description</th>
                  <th className="px-2 py-2 text-right font-[550] sm:px-4">Amount</th>
                  <th className="px-2 py-2 text-right font-[550] sm:px-4">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t: any) => (
                  <tr key={t.id} className="border-t border-[#f4f6f8] hover:bg-[#fafbfe]">
                    <td className="whitespace-nowrap px-2 py-2 text-[12.5px] tabular-nums text-[#5d6674] sm:px-4">
                      <span className="sm:hidden">{t.date.slice(8, 10)}/{t.date.slice(5, 7)}</span>
                      <span className="hidden sm:inline">{dateLocal(t.date)}</span>
                    </td>
                    {/* max-w-0 lets a long payee truncate instead of forcing the table wide */}
                    <td className="max-w-0 px-2 py-2 sm:px-4">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate text-[13px] text-[#171b22]">{t.vendor || t.payee}</span>
                        {t.category_name && (
                          <span className="hidden text-[11.5px] text-[#9aa2af] sm:inline">
                            {t.parent_category_name ? `${t.parent_category_name} · ` : ''}{t.category_name}
                          </span>
                        )}
                        {t.type === 'transfer' && <Badge className="bg-slate-100 text-slate-700">transfer</Badge>}
                        {t.type === 'adjustment' && <Badge className="bg-amber-100 text-amber-800">adjustment</Badge>}
                        {t.type === 'excluded' && <Badge className="bg-slate-100 text-slate-600">excluded</Badge>}
                      </span>
                    </td>
                    <td className={cn('whitespace-nowrap px-2 py-2 text-right text-[13px] font-[550] tabular-nums sm:px-4',
                      Number(t.amount_cents) < 0 ? 'text-[#b4232a]' : 'text-[#0f7a52]')}>
                      {money(t.amount_cents)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right text-[13px] tabular-nums text-[#3f4753] sm:px-4">
                      {money(t.balance_cents)}
                    </td>
                  </tr>
                ))}
                {/* The opening figure sits at the bottom because the list runs backwards */}
                <tr className="border-t border-[#f4f6f8] bg-[#fcfdff]">
                  <td className="whitespace-nowrap px-2 py-2 text-[12.5px] text-[#9aa2af] sm:px-4">
                    <span className="sm:hidden">{data.from.slice(8, 10)}/{data.from.slice(5, 7)}</span>
                    <span className="hidden sm:inline">{dateLocal(data.from)}</span>
                  </td>
                  <td className="px-2 py-2 text-[12.5px] text-[#9aa2af] sm:px-4">Opening balance</td>
                  <td />
                  <td className="whitespace-nowrap px-2 py-2 text-right text-[13px] tabular-nums text-[#9aa2af] sm:px-4">{money(opening_cents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function Figure({ label, value, className, strong }: any) {
  return (
    <div>
      <p className={LABEL}>{label}</p>
      <p className={cn('mt-0.5 tabular-nums tracking-[-0.02em]', strong ? 'text-[20px] font-[650]' : 'text-[18px] font-[600]', className)}>{value}</p>
    </div>
  )
}

// Reconciling is one question: does the bank agree? Type in what the statement says
// and the difference is either zero or it is the thing you have to go and find.
function Reconcile({ account, closing, to, onDone }: any) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const entered = value.trim() === '' ? null : Math.round(parseFloat(value.replace(/[$,]/g, '')) * 100)
  const valid = entered != null && Number.isFinite(entered)
  const diff = valid ? entered - closing : 0

  const adjust = async () => {
    if (!valid || diff === 0) return
    if (!window.confirm(
      `Add a balance adjustment of ${money(diff)} dated ${dateLocal(to)}?\n\n` +
      `This books the difference as an "adjustment" transaction so ${account.name} matches your statement. ` +
      `It won't appear in the P&L. Only do this once you've checked the difference isn't a missing import.`)) return
    setBusy(true); setError('')
    try {
      await post(`/accounts/${account.id}/adjust`, { targetBalanceCents: entered, date: to })
      setValue(''); setOpen(false); onDone()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  if (!open) return (
    <button onClick={() => setOpen(true)}
      className="cursor-pointer rounded-lg border border-[#e5e8ee] bg-white px-[13px] py-[7px] text-[12.5px] text-[#5d6674] hover:bg-[#f7f8fa]">
      Reconcile against a statement
    </button>
  )

  return (
    <div className={cn(CARD, 'p-4')}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className={LABEL}>Statement balance on {dateLocal(to)}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[#9aa2af]">$</span>
            <input autoFocus type="text" inputMode="decimal" value={value} onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && diff !== 0) adjust() }}
              placeholder="0.00" aria-label="Statement closing balance"
              className="h-9 w-[140px] rounded-lg border border-[#93b4fb] px-2.5 text-right text-[13.5px] tabular-nums focus:outline-none focus:ring-[3px] focus:ring-[rgba(37,99,235,0.10)]" />
          </div>
          {/* On a card or a loan the statement quotes what you OWE. Entering that as a
              positive number books an adjustment twice the size of the debt. */}
          {account.type !== 'standard' && (
            <p className="mt-1.5 text-[12px] text-[#79818f]">Money owed goes in as a negative — a $254,000 loan is <span className="tabular-nums">-254000</span>.</p>
          )}
        </div>
        <button onClick={() => { setOpen(false); setValue(''); setError('') }}
          className="h-8 cursor-pointer rounded-lg px-2.5 text-[12.5px] text-[#79818f] hover:bg-[#f1f3f7]">Close</button>
      </div>

      {valid && (
        <p className={cn('mt-3 text-[13px]', diff === 0 ? 'text-[#0f7a52]' : 'text-[#b4232a]')}>
          {diff === 0
            ? `Matches — this app and your bank both say ${money(closing)} on ${dateLocal(to)}.`
            : <>Out by <span className="font-semibold tabular-nums">{money(Math.abs(diff))}</span>
              {' — '}the app says {money(closing)}, your statement says {money(entered!)}.</>}
        </p>
      )}
      {valid && diff !== 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button disabled={busy} onClick={adjust}
            className="h-[30px] cursor-pointer rounded-lg bg-[#2563eb] px-3 text-[12.5px] font-[550] text-white hover:bg-[#1d4ed8] disabled:opacity-60">
            {busy ? 'Adjusting…' : `Book the ${money(Math.abs(diff))} difference`}
          </button>
          <span className="text-[12px] text-[#9aa2af]">Check for a missing or duplicated import first.</span>
        </div>
      )}
      {error && <p className="mt-2 text-[13px] text-red-600">{error}</p>}
    </div>
  )
}

function StepButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button aria-label={label} onClick={onClick}
      className="grid h-9 w-9 cursor-pointer place-items-center rounded-[9px] border border-[#dfe3ea] text-[#4b5462] hover:bg-[#f7f8fa]">
      {children}
    </button>
  )
}
