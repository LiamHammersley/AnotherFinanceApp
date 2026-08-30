// Transactions — rebuilt to the "Transactions table redesign" handoff spec:
// 5-column fixed-height grid, day group headers with daily net, AI suggestions
// folded into the Category cell, view tabs, preset date ranges, floating bulk bar.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { get, patch, post, del } from '../lib/api'
import { Badge, Button, Input, Modal, Select, Spinner, cn } from '../components/ui'
import { CategoryPicker } from '../components/CategoryPicker'
import { RecurringForm, type RecurringSeed } from '../components/RecurringForm'
import { RuleEditor, type RuleSeed } from '../components/RuleEditor'
import { date, isoDate, isoToday, money } from '../lib/format'

import { categoryColour } from '../lib/categories'

// Mirrors the transaction type CHECK constraint in the schema
const TYPES = ['income', 'expense', 'transfer', 'adjustment', 'interest', 'excluded']

type View = '' | 'uncat' | 'ai' | 'transfers'
const TABS: { key: View; label: string; countKey: 'all' | 'uncat' | 'ai' | 'transfers' }[] = [
  { key: '', label: 'All', countKey: 'all' },
  { key: 'uncat', label: 'Needs a category', countKey: 'uncat' },
  { key: 'ai', label: 'AI-assigned', countKey: 'ai' },
  { key: 'transfers', label: 'Transfers', countKey: 'transfers' },
]

const RANGES: Record<string, () => { from?: string; to?: string }> = {
  '30d': () => ({ from: isoDate(new Date(Date.now() - 30 * 86400000)) }),
  month: () => ({ from: isoToday().slice(0, 8) + '01' }),
  lastMonth: () => {
    const now = new Date()
    return { from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)) }
  },
  all: () => ({}),
}

// Signed amount per spec: only money in is coloured; U+2212 minus, not a hyphen
function Amt({ cents }: { cents: number | string }) {
  const n = Number(cents)
  const s = money(Math.abs(n)).replace('$', '')
  return n > 0
    ? <span className="font-semibold tabular-nums tracking-tight text-emerald-700">+${s}</span>
    : <span className="font-medium tabular-nums tracking-tight text-[#171b22]">−${s}</span>
}

// Weekday for orientation, then the same DD/MM/YYYY form used everywhere else
const dayLabel = (d: string) =>
  `${new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short' })} ${date(d)}`

type Prefs = { account: boolean; details: boolean; dayNet: boolean; compact: boolean }
const DEFAULT_PREFS: Prefs = { account: true, details: true, dayNet: true, compact: false }

export default function Transactions() {
  const [accounts, setAccounts] = useState<any[]>([])
  const [cats, setCats] = useState<any[]>([])
  const [data, setData] = useState<any>(null)
  // P&L drill-through and dashboard deep-links hand over a view + filters here.
  // Reading is idempotent so StrictMode's double render is harmless; the key is
  // cleared in an effect rather than during render.
  const handoff = useMemo(() => {
    try { const raw = sessionStorage.getItem('tx-filter'); return raw ? JSON.parse(raw) : null }
    catch { return null }
  }, [])
  useEffect(() => { sessionStorage.removeItem('tx-filter') }, [])
  const [view, setView] = useState<View>(handoff?.view || '')
  const [searchInput, setSearchInput] = useState(handoff?.search || '')
  const [range, setRange] = useState(handoff?.view || handoff?.search ? 'all' : '30d')
  const [filters, setFilters] = useState<any>(() => {
    const { view: _v, ...rest } = handoff || {}
    return { page: 1, pageSize: 50, sort: 'date', dir: 'desc', ...(handoff ? rest : RANGES['30d']()) }
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClicked = useRef<number | null>(null)
  const [confirm, setConfirm] = useState<{ action: string; categoryId?: string } | null>(null)
  const [undo, setUndo] = useState<{ id: string; description: string } | null>(null)
  // One editor serves both entry points: the AI-override prompt and "Create rule" on a row
  const [ruleSeed, setRuleSeed] = useState<RuleSeed | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null) // transaction being edited
  const [noteFor, setNoteFor] = useState<any>(null)
  const [recurringSeed, setRecurringSeed] = useState<RecurringSeed | null>(null)
  const [suggestions, setSuggestions] = useState<any[] | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [notice, setNotice] = useState('') // one dismissible banner: AI results, recurring added, …
  const [error, setError] = useState('')
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('tx-view-prefs') || '{}') } }
    catch { return DEFAULT_PREFS }
  })
  const setPref = (k: keyof Prefs, v: boolean) => setPrefs(p => {
    const next = { ...p, [k]: v }
    localStorage.setItem('tx-view-prefs', JSON.stringify(next))
    return next
  })

  useEffect(() => {
    if (filters.from || filters.to) {
      const inHandoff = !Object.entries(RANGES).some(([k, fn]) => k !== 'all' && JSON.stringify(fn()) === JSON.stringify({ from: filters.from, to: filters.to }))
      if (inHandoff) setRange('custom')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Search debounced ~250ms into the server-side filter
  useEffect(() => {
    const t = setTimeout(() => setFilters((f: any) => (f.search || '') === searchInput ? f : { ...f, search: searchInput, page: 1 }), 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const load = useCallback(() => {
    const qs = Object.entries({ ...filters, view })
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
    get(`/transactions?${qs}`).then(setData).catch(e => setError(e.message))
  }, [filters, view])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    get('/accounts?archived=true').then(setAccounts)
    get('/categories').then(setCats)
  }, [])

  const setF = (k: string, v: any) => setFilters((f: any) => ({ ...f, [k]: v, page: k === 'page' ? v : 1 }))
  const setRangePreset = (key: string) => {
    setRange(key)
    if (key !== 'custom') setFilters((f: any) => ({ ...f, from: undefined, to: undefined, ...RANGES[key](), page: 1 }))
  }

  const toggle = (id: string, index: number, shift: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (shift && lastClicked.current != null && data) {
        const [a, b] = [Math.min(lastClicked.current, index), Math.min(Math.max(lastClicked.current, index), data.rows.length - 1)]
        for (let i = a; i <= b; i++) next.add(data.rows[i].id)
      } else next.has(id) ? next.delete(id) : next.add(id)
      lastClicked.current = index
      return next
    })
  }

  const runBulk = async () => {
    if (!confirm) return
    try {
      const r = await post('/transactions/bulk', { ids: [...selected], action: confirm.action, categoryId: confirm.categoryId })
      setUndo({ id: r.undoId, description: r.description })
      setTimeout(() => setUndo(u => (u?.id === r.undoId ? null : u)), 30_000)
      setSelected(new Set()); setConfirm(null); load()
    } catch (e) { setError((e as Error).message); setConfirm(null) }
  }

  const suggestCategories = async () => {
    setAiBusy(true); setError(''); setNotice('')
    try {
      const r = await post('/ai/categorise', { suggestOnly: true })
      setNotice(r.aiSkipped
        ? `Rules assigned ${r.ruleAssigned} transaction${r.ruleAssigned === 1 ? '' : 's'}. AI is disabled or no API key is set — add one in Settings for suggestions.`
        : `Rules assigned ${r.ruleAssigned} · AI suggested ${r.aiSuggested} (✓ to accept, ✕ to dismiss) · ${r.low} too uncertain.`)
      load()
    } catch (e) { setError((e as Error).message) }
    setAiBusy(false)
  }

  // A pending suggestion holds its category in assign_source, not category_id
  const suggestedId = (t: any): string | null =>
    t.assign_source?.startsWith('ai_suggested:') ? t.assign_source.slice('ai_suggested:'.length) : null

  const confirmSuggestion = (t: any) => patch(`/transactions/${t.id}`, { confirmSuggestion: true }).then(load).catch(e => setError(e.message))
  const dismissSuggestion = (t: any) => patch(`/transactions/${t.id}`, { dismissSuggestion: true }).then(load).catch(e => setError(e.message))
  const inlineCategory = async (t: any, categoryId: string | null) => {
    try {
      const r = await patch(`/transactions/${t.id}`, { categoryId })
      if (r.suggest_rule && categoryId) setRuleSeed({ fromPayee: t.payee, categoryId, prepend: true })
      load()
    } catch (e) { setError((e as Error).message) }
  }

  const catName = (id: string) => cats.find(c => c.id === id)?.name || '?'
  const selectedRows = (data?.rows || []).filter((t: any) => selected.has(t.id))
  const selectedTransfers = selectedRows.filter((t: any) => t.type === 'transfer')
  // The bulk button flips to "Return to P&L" only when everything picked is already out
  const allSelectedExcluded = selectedRows.length > 0 && selectedRows.every((t: any) => t.type === 'excluded')
  const selectedSuggestions = selectedRows.filter((t: any) => t.assign_source?.startsWith('ai_suggested:')).length
  const counts = data?.counts || { all: 0, uncat: 0, ai: 0, transfers: 0 }
  // Group by day only when the loaded rows really are in date order. After a sort
  // click there's one render where filters say "date" but the rows on screen are
  // still sorted the old way — grouping those would emit duplicate day keys.
  const byDate = useMemo(() => {
    if (filters.sort !== 'date') return false
    if (!data) return true
    const ds = data.rows.map((t: any) => t.date)
    const asc = filters.dir === 'asc'
    for (let i = 1; i < ds.length; i++) if (asc ? ds[i] < ds[i - 1] : ds[i] > ds[i - 1]) return false
    return true
  }, [filters.sort, filters.dir, data])
  const gridCols = [
    '34px',
    !byDate ? '96px' : null, // flat mode inserts a Date column (spec §1.4c caveat)
    'minmax(230px,1fr)', '262px',
    prefs.account ? '150px' : null,
    '130px', '40px',
  ].filter(Boolean).join(' ')

  // Day groups (only meaningful in date order): [{ day, rows, net }]
  const groups = useMemo(() => {
    if (!data) return []
    if (!byDate) return [{ day: null as string | null, rows: data.rows, net: 0 }]
    const out: { day: string | null; rows: any[]; net: number }[] = []
    for (const t of data.rows) {
      const day = t.date.slice(0, 10)
      const g = out[out.length - 1]
      if (g && g.day === day) { g.rows.push(t); g.net += Number(t.amount_cents) }
      else out.push({ day, rows: [t], net: Number(t.amount_cents) })
    }
    return out
  }, [data, byDate])

  const sortBy = (key: string) =>
    setFilters((f: any) => ({ ...f, sort: key, dir: f.sort === key && f.dir === 'desc' ? 'asc' : 'desc', page: 1 }))
  const sortMark = (key: string) => filters.sort === key ? (filters.dir === 'desc' ? ' ↓' : ' ↑') : ''
  // Row index across groups for shift-click ranges — precomputed so render stays pure
  const rowIndexOf = useMemo(() => {
    const m = new Map<string, number>()
    data?.rows.forEach((t: any, i: number) => m.set(t.id, i))
    return m
  }, [data])

  return (
    <div className="space-y-0">
      {/* Page header */}
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="mb-1 text-[22px] font-[650] tracking-[-0.02em]">Transactions</h1>
          <p className="text-[13px] text-[#79818f]" aria-live="polite">
            {counts.all} transaction{counts.all === 1 ? '' : 's'}
            {counts.uncat > 0 && <> · <span className="font-[550] text-[#6d5ae6]">{counts.uncat} need{counts.uncat === 1 ? 's' : ''} a category</span></>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={suggestCategories} disabled={aiBusy}
            className="flex h-9 cursor-pointer items-center gap-[7px] rounded-[9px] border border-[#ddd8f7] bg-white px-[13px] text-[13px] font-[550] text-[#5b4bd6] hover:border-[#c7bef2] hover:bg-[#f7f5ff] disabled:opacity-60">
            <span className="text-[11px]">✦</span>{aiBusy ? 'Suggesting…' : 'Suggest categories'}
          </button>
          <button onClick={() => get('/transfers/suggestions').then(setSuggestions)}
            className="h-9 cursor-pointer rounded-[9px] border border-[#dfe3ea] bg-white px-[13px] text-[13px] text-[#4b5462] hover:bg-[#f7f8fa] hover:text-[#171b22]">
            Transfer matches
          </button>
          <button onClick={() => setAddOpen(true)}
            className="h-9 cursor-pointer rounded-[9px] bg-[#2563eb] px-[15px] text-[13px] font-semibold text-white hover:bg-[#1d4ed8]">
            Add transaction
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-[14px] flex flex-wrap items-center gap-2 rounded-xl border border-[#e8ebf0] bg-white p-[12px_14px] shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
        <div className="relative min-w-[220px] flex-[0_1_300px]">
          <span className="pointer-events-none absolute left-[11px] top-1/2 -translate-y-1/2 text-[13px] text-[#a4abb8]">◌</span>
          <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
            placeholder="Search payee, amount, date…"
            title={'Payee, bank description, notes and category.\nAmounts: 124.53 · 124 (any $124) · >500 · <20 · 100-200\nDates: 28/07/2026'}
            className="h-9 w-full rounded-[9px] border border-[#dfe3ea] pl-[30px] pr-3 text-[13px] placeholder:text-[#a4abb8] focus:border-[#93b4fb] focus:outline-none focus:ring-[3px] focus:ring-[rgba(37,99,235,0.10)]" />
        </div>
        <FilterSelect value={filters.account || ''} onChange={v => setF('account', v)}>
          <option value="">All accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.archived ? ' (archived)' : ''}</option>)}
        </FilterSelect>
        {/* Same searchable, grouped picker as the rows use — filtering by a whole group is allowed */}
        <CategoryPicker cats={cats} value={filters.category || null} allowGroups clearLabel="All categories"
          onSelect={id => setF('category', id || '')}
          trigger={
            <span className="relative flex h-9 items-center rounded-[9px] border border-[#dfe3ea] bg-white pl-3 pr-[30px] text-[13px] text-[#39404b]">
              {filters.category ? (cats.find(c => c.id === filters.category)?.name ?? 'Category') : 'All categories'}
              <span className="pointer-events-none absolute right-[11px] text-[9px] text-[#9aa2af]">▼</span>
            </span>
          } />
        <FilterSelect value={filters.direction || ''} onChange={v => setF('direction', v)}>
          <option value="">Money in &amp; out</option>
          <option value="out">Money out</option>
          <option value="in">Money in</option>
          <option value="transfers">Transfers</option>
        </FilterSelect>
        <FilterSelect value={range} onChange={setRangePreset}>
          <option value="30d">Last 30 days</option>
          <option value="month">This month</option>
          <option value="lastMonth">Last month</option>
          <option value="all">All time</option>
          <option value="custom">Custom range…</option>
        </FilterSelect>
        {range === 'custom' && (
          <>
            <Input type="date" className="h-9 max-w-40 rounded-[9px] border-[#dfe3ea] text-[13px]" value={filters.from || ''} onChange={e => setF('from', e.target.value)} />
            <Input type="date" className="h-9 max-w-40 rounded-[9px] border-[#dfe3ea] text-[13px]" value={filters.to || ''} onChange={e => setF('to', e.target.value)} />
          </>
        )}
        {/* Say it once, where someone typing a number will see it */}
        {searchInput.trim() !== '' && /[\d><-]/.test(searchInput) && (
          <span className="text-[11.5px] text-[#9aa2af]">Amounts: <code>124.53</code> · <code>124</code> · <code>&gt;500</code> · <code>100-200</code></span>
        )}
        <span className="ml-auto text-[12.5px] text-[#9aa2af]">{data ? `Showing ${data.rows.length} of ${data.total}` : '…'}</span>
      </div>

      {/* What's narrowing this list right now — arriving from a P&L drill-through
          or the dashboard should never look like "my transactions disappeared". */}
      {(() => {
        const chips: string[] = []
        if (view) chips.push(TABS.find(t => t.key === view)?.label ?? view)
        if (filters.search) chips.push(`matching “${filters.search}”`)
        if (filters.account) chips.push(accounts.find(a => a.id === filters.account)?.name ?? 'one account')
        if (filters.category) chips.push(cats.find(c => c.id === filters.category)?.name ?? 'one category')
        if (filters.direction) chips.push({ out: 'money out', in: 'money in', transfers: 'transfers' }[filters.direction as string] ?? '')
        // The default "Last 30 days" isn't worth announcing — only a chosen range is
        if (range !== '30d' && (filters.from || filters.to))
          chips.push(`${filters.from ? date(filters.from) : 'start'} – ${filters.to ? date(filters.to) : 'today'}`)
        if (filters.reviewed === 'true') chips.push('reviewed')
        if (filters.reviewed === 'false') chips.push('unreviewed')
        if (chips.length === 0) return null
        return (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#dfe3ea] bg-white px-3 py-2 text-[12.5px]">
            <span className="text-[#79818f]">Filtered to</span>
            {chips.filter(Boolean).map(c => (
              <span key={c} className="rounded-full bg-[#eef3ff] px-2 py-0.5 font-[550] text-[#2563eb]">{c}</span>
            ))}
            <button onClick={() => { setView(''); setSearchInput(''); setRange('30d'); setFilters({ page: 1, pageSize: filters.pageSize, sort: 'date', dir: 'desc', ...RANGES['30d']() }) }}
              className="ml-auto cursor-pointer text-[#5d6674] underline hover:text-[#171b22]">Clear filters</button>
          </div>
        )
      })()}

      {/* Notices */}
      {notice && (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-[#ddd8f7] bg-[#faf8ff] px-3 py-2 text-sm text-[#5b4bd6]">
          <span>{notice}</span>
          <Button size="sm" variant="ghost" onClick={() => setNotice('')}>✕</Button>
        </div>
      )}
      {undo && (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
          <span>{undo.description}</span>
          <Button size="sm" variant="outline" onClick={() => post(`/undo/${undo.id}`).then(() => { setUndo(null); load() })}>Undo</Button>
        </div>
      )}
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {/* Table card */}
      {!data ? <Spinner /> : (
        <div className="overflow-visible rounded-xl border border-[#e8ebf0] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
          {/* View tabs */}
          <div className="flex items-center gap-1.5 border-b border-[#eef0f4] px-[14px] py-[10px]">
            {TABS.map(t => (
              <button key={t.key} onClick={() => { setView(t.key); setF('page', 1) }}
                className={cn('flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg px-[11px] text-[13px]',
                  view === t.key ? 'bg-[#f1f3f7] font-semibold text-[#171b22]' : 'font-[450] text-[#5d6674] hover:bg-[#f7f8fa]')}>
                {t.label}
                <span className="text-[11.5px] tabular-nums text-[#98a0ad]">{counts[t.countKey]}</span>
              </button>
            ))}
            <ViewOptions prefs={prefs} setPref={setPref} />
          </div>

          {/* Column header */}
          <div className="sticky top-[52px] z-10 grid h-[38px] items-center gap-3 border-b border-[#eef0f4] bg-[#fbfcfd] px-4"
            style={{ gridTemplateColumns: gridCols }}>
            <Checkbox checked={data.rows.length > 0 && data.rows.every((t: any) => selected.has(t.id))}
              onChange={v => setSelected(v ? new Set(data.rows.map((t: any) => t.id)) : new Set())} ariaLabel="Select all rows" />
            {!byDate && <ColHead onClick={() => sortBy('date')}>Date{sortMark('date')}</ColHead>}
            <ColHead onClick={() => sortBy('payee')}>Payee{sortMark('payee')}</ColHead>
            <ColHead onClick={() => sortBy('category')}>Category{sortMark('category')}</ColHead>
            {prefs.account && <ColHead>Account</ColHead>}
            <ColHead className="text-right" onClick={() => sortBy('amount')}>Amount{sortMark('amount')}</ColHead>
            <span />
          </div>

          {/* Rows, grouped by day (date order) or flat (any other sort) */}
          {data.rows.length === 0 && (
            <div className="px-6 py-14 text-center">
              <p className="text-sm font-semibold text-[#3f4753]">No transactions match</p>
              <p className="mt-1 text-[13px] text-[#9aa2af]">Try a different search or clear the filters.</p>
            </div>
          )}
          {groups.map(g => (
            <div key={g.day ?? 'flat'}>
              {g.day && (
                <div className="flex h-[34px] items-center gap-2.5 border-b border-[#f1f3f6] bg-[#fafbfc] px-4">
                  <span className="text-xs font-[650] text-[#3f4753]">{dayLabel(g.day)}</span>
                  <span className="text-[11.5px] text-[#a4abb8]">{g.rows.length} transaction{g.rows.length === 1 ? '' : 's'}</span>
                  {prefs.dayNet && (
                    <span className="ml-auto text-xs tabular-nums text-[#79818f]">
                      Net {g.net < 0 ? '−' : ''}{money(Math.abs(g.net)).replace('$', '$')}
                    </span>
                  )}
                </div>
              )}
              {g.rows.map((t: any) => {
                const i = rowIndexOf.get(t.id) ?? 0
                const isSel = selected.has(t.id)
                return (
                  <div key={t.id}
                    className={cn('grid items-center gap-3 border-b border-[#f4f6f8] px-4',
                      prefs.compact ? 'min-h-10' : 'min-h-[54px]',
                      isSel ? 'bg-[#f6f9ff]' : 'bg-white hover:bg-[#fafbfe]')}
                    style={{ gridTemplateColumns: gridCols }}>
                    <Checkbox checked={isSel} onChange={() => {}} onClick={e => toggle(t.id, i, e.shiftKey)} ariaLabel={`Select ${t.vendor}`} />
                    {!byDate && <span className="whitespace-nowrap text-[12.5px] text-[#79818f]">{date(t.date)}</span>}
                    <div className="min-w-0">
                      <div className="flex items-center gap-[7px] overflow-hidden">
                        <span className="truncate text-[13.5px] font-semibold tracking-[-0.005em] text-[#171b22]">{t.vendor}</span>
                        {t.notes && (
                          <button title={t.notes} aria-label="Edit note" onClick={() => setNoteFor(t)}
                            className="shrink-0 cursor-pointer text-[10px] text-[#b0b7c3] hover:text-[#5d6674]">✎</button>
                        )}
                        {t.type === 'transfer' && !t.linked_transaction_id && <Badge className="shrink-0 bg-red-100 text-red-700">⚠ unmatched</Badge>}
                        {t.type === 'adjustment' && <Badge className="shrink-0 bg-amber-100 text-amber-800">adjustment</Badge>}
                        {t.type === 'interest' && <Badge className="shrink-0 bg-purple-100 text-purple-800">interest</Badge>}
                      </div>
                      {prefs.details && !prefs.compact && (
                        <p className="mt-0.5 truncate text-[11.5px] text-[#9aa2af]">{t.payee}</p>
                      )}
                    </div>
                    <CategoryCell t={t} cats={cats} catName={catName}
                      onPick={id => inlineCategory(t, id)}
                      onAccept={() => confirmSuggestion(t)}
                      onDismiss={() => dismissSuggestion(t)} />
                    {prefs.account && <span className="truncate whitespace-nowrap text-[12.5px] text-[#79818f]">{t.account_name}</span>}
                    <span className="text-right text-[13.5px]"><Amt cents={t.amount_cents} /></span>
                    <RowMenu t={t} onChanged={load} onNote={() => setNoteFor(t)} onError={setError}
                      onEdit={() => setEditing(t)}
                      onCreateRule={() => setRuleSeed({ fromPayee: t.payee, categoryId: t.category_id || suggestedId(t) })}
                      onAddRecurring={() => setRecurringSeed({
                        payee: t.payee, nickname: t.vendor || '',
                        amount: (Number(t.amount_cents) / 100).toFixed(2),
                        categoryId: t.category_id, lastSeen: t.date,
                      })} />
                  </div>
                )
              })}
            </div>
          ))}

          {/* Footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#eef0f4] bg-[#fcfcfd] px-4 py-3">
            <span className="text-[12.5px] text-[#79818f]">Showing {data.rows.length} of {data.total}</span>
            <div className="flex items-center gap-2">
              <select value={filters.pageSize} onChange={e => setF('pageSize', +e.target.value)}
                className="h-[30px] cursor-pointer rounded-lg border border-[#e5e8ee] bg-white pl-2.5 pr-1 text-[12.5px] text-[#4b5462]">
                {[50, 100, 200].map(n => <option key={n} value={n}>{n} per page</option>)}
              </select>
              <PageBtn disabled={filters.page <= 1} onClick={() => setF('page', filters.page - 1)} label="Previous page">‹</PageBtn>
              <span className="text-[12.5px] tabular-nums text-[#4b5462]">Page {data.page} of {Math.max(1, Math.ceil(data.total / filters.pageSize))}</span>
              <PageBtn disabled={data.page * filters.pageSize >= data.total} onClick={() => setF('page', filters.page + 1)} label="Next page">›</PageBtn>
            </div>
          </div>
        </div>
      )}

      {/* Floating bulk bar */}
      {selected.size > 0 && (
        <div className="animate-pop-in fixed bottom-[26px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-[#171b22] py-[9px] pl-4 pr-2.5 shadow-[0_12px_32px_rgba(16,24,40,0.28)]">
          <span className="text-[13px] font-[550] tabular-nums text-white">{selected.size} selected</span>
          <span className="mx-1 h-5 w-px bg-[#343b46]" />
          <CategoryPicker cats={cats} up align="left" clearLabel={null} onSelect={id => id && setConfirm({ action: 'category', categoryId: id })}
            trigger={<span className="flex h-[30px] items-center rounded-lg bg-[#262c36] px-[11px] text-[12.5px] text-[#e8eaee] hover:bg-[#333a45]">Categorise</span>} />
          <button onClick={() => setConfirm({ action: allSelectedExcluded ? 'include' : 'exclude' })}
            className="h-[30px] cursor-pointer rounded-lg bg-[#262c36] px-[11px] text-[12.5px] text-[#e8eaee] hover:bg-[#333a45]">
            {allSelectedExcluded ? 'Return to P&L' : 'Exclude from P&L'}</button>
          {selectedSuggestions > 0 && (
            <>
              <button onClick={() => setConfirm({ action: 'accept_suggestions' })}
                className="h-[30px] cursor-pointer rounded-lg bg-[#3b3363] px-[11px] text-[12.5px] font-[550] text-[#d9d1ff] hover:bg-[#4a3f7d]">
                ✦ Accept {selectedSuggestions} suggestion{selectedSuggestions === 1 ? '' : 's'}
              </button>
              <button onClick={() => setConfirm({ action: 'dismiss_suggestions' })}
                className="h-[30px] cursor-pointer rounded-lg bg-[#262c36] px-[11px] text-[12.5px] text-[#e8eaee] hover:bg-[#333a45]">Dismiss</button>
            </>
          )}
          <button onClick={() => setConfirm({ action: 'reviewed' })}
            className="h-[30px] cursor-pointer rounded-lg bg-[#262c36] px-[11px] text-[12.5px] text-[#e8eaee] hover:bg-[#333a45]">Mark reviewed</button>
          <button onClick={() => setConfirm({ action: 'delete' })}
            className="h-[30px] cursor-pointer rounded-lg bg-[#262c36] px-[11px] text-[12.5px] text-[#ffb4ac] hover:bg-[#3a2b2b]">Delete</button>
          <button onClick={() => setSelected(new Set())} aria-label="Clear selection"
            className="h-[30px] w-[30px] cursor-pointer rounded-lg text-[#8b93a1] hover:bg-[#262c36] hover:text-white">✕</button>
        </div>
      )}

      {/* Confirm bulk */}
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title="Confirm bulk action">
        <p className="text-sm text-gray-700">
          {confirm?.action === 'category' && `Reassign ${selected.size} transaction${selected.size === 1 ? '' : 's'} to ${catName(confirm.categoryId!)}?`}
          {confirm?.action === 'accept_suggestions' && `Apply the AI's suggested category to ${selectedSuggestions} transaction${selectedSuggestions === 1 ? '' : 's'}? Each keeps its own suggestion — they aren't all set to the same category.`}
          {confirm?.action === 'dismiss_suggestions' && `Clear the suggestion on ${selectedSuggestions} transaction${selectedSuggestions === 1 ? '' : 's'}? They go back to needing a category.`}
          {confirm?.action === 'delete' && `Delete ${selected.size} transactions? They can be restored for 30 days.`}
          {confirm?.action === 'reviewed' && `Mark ${selected.size} transactions as reviewed?`}
          {confirm?.action === 'link_transfer' && 'Link these 2 transactions as an internal transfer? They will be excluded from P&L.'}
          {confirm?.action === 'exclude' && `Exclude ${selected.size} transaction${selected.size === 1 ? '' : 's'} from the P&L? They keep affecting account balances and net worth, but stop counting as income or spending. Any category is cleared. Undoable for 24 hours.`}
          {confirm?.action === 'include' && `Return ${selected.size} transaction${selected.size === 1 ? '' : 's'} to the P&L as income or expenses?`}
        </p>
        {/* Categorising a transfer necessarily stops it being a transfer — say so up front */}
        {confirm?.action === 'category' && selectedTransfers.length > 0 && (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            {selectedTransfers.length} of these {selectedTransfers.length === 1 ? 'is a transfer' : 'are transfers'} and will become
            {' '}income or expenses so the category counts in your P&amp;L. The matching leg on the other account is unlinked but
            left as a transfer — it stays out of the P&amp;L and is flagged “unmatched” so you can categorise or re-link it yourself.
            Undoable for 24 hours.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button onClick={runBulk}>Confirm</Button>
        </div>
      </Modal>

      {/* Same form as the Recurring page's manual entry, prefilled from the row */}
      <RecurringForm open={!!recurringSeed} seed={recurringSeed ?? undefined} cats={cats}
        onClose={() => setRecurringSeed(null)}
        onSaved={() => setNotice(`“${recurringSeed?.nickname || recurringSeed?.payee}” is now tracked on the Recurring page.`)} />

      {/* Rule creation — from the row menu, or prompted after an AI override (spec 7.3) */}
      {ruleSeed && (
        <RuleEditor seed={ruleSeed} cats={cats} accounts={accounts} onClose={() => setRuleSeed(null)}
          onSaved={r => {
            setRuleSeed(null)
            if (r?.applied > 0) {
              setUndo({ id: r.undoId, description: r.description })
              setTimeout(() => setUndo(u => (u?.id === r.undoId ? null : u)), 30_000)
            }
            load()
          }} />
      )}

      {/* Note editor */}
      <NoteEditor t={noteFor} onClose={() => setNoteFor(null)} onSaved={load} />

      {/* Transfer suggestions */}
      <Modal open={!!suggestions} onClose={() => setSuggestions(null)} title="Suggested transfer matches">
        {suggestions?.length === 0 && <p className="text-sm text-gray-500">No suggestions found.</p>}
        {suggestions?.map(s => (
          <div key={s.out_id + s.in_id} className="mb-2 rounded border border-gray-100 p-2 text-sm">
            <p>{date(s.out_date)} · {s.out_account_name} → {s.in_account_name} · <Amt cents={s.amount_cents} /> <Badge className={s.confidence === 'high' ? 'bg-emerald-100 text-emerald-700' : ''}>{s.confidence}</Badge></p>
            <p className="truncate text-xs text-gray-500">{s.out_payee} ⇄ {s.in_payee}</p>
            <div className="mt-1 flex gap-2">
              <Button size="sm" onClick={() => post('/transactions/bulk', { ids: [s.out_id, s.in_id], action: 'link_transfer' }).then(() => { get('/transfers/suggestions').then(setSuggestions); load() })}>Confirm link</Button>
              <Button size="sm" variant="ghost" onClick={() => setSuggestions(suggestions.filter(x => x !== s))}>Reject</Button>
            </div>
          </div>
        ))}
      </Modal>

      <TransactionModal open={addOpen} accounts={accounts.filter(a => !a.archived)} cats={cats}
        onClose={() => setAddOpen(false)} onSaved={load} />
      <TransactionModal open={!!editing} tx={editing} accounts={accounts} cats={cats}
        onClose={() => setEditing(null)} onSaved={load} />
    </div>
  )
}

function ColHead({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button onClick={onClick} disabled={!onClick}
      className={cn('select-none truncate text-left text-[11px] font-semibold uppercase tracking-[0.055em] text-[#8b93a1]',
        onClick && 'cursor-pointer hover:text-[#4b5462]', className)}>
      {children}
    </button>
  )
}

// Custom-styled checkbox with a real input underneath for accessibility
function Checkbox({ checked, onChange, onClick, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; onClick?: (e: React.MouseEvent) => void; ariaLabel: string }) {
  return (
    <label className="relative flex h-[17px] w-[17px] cursor-pointer items-center justify-center" onClick={onClick}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} aria-label={ariaLabel}
        className="peer absolute inset-0 cursor-pointer opacity-0" />
      <span className={cn('flex h-[17px] w-[17px] items-center justify-center rounded-[5px] border-[1.5px] bg-white text-[10px] font-bold text-white',
        checked ? 'border-[#2563eb] bg-[#2563eb]' : 'border-[#cdd3dd] hover:border-[#93b4fb]')}>
        {checked && '✓'}
      </span>
    </label>
  )
}

// Category cell — exactly one of: assigned pill / transfer pill / AI suggestion chip / categorise ghost
function CategoryCell({ t, cats, catName, onPick, onAccept, onDismiss }: {
  t: any; cats: any[]; catName: (id: string) => string
  onPick: (id: string | null) => void; onAccept: () => void; onDismiss: () => void
}) {
  // Types the P&L never sees have no category to pick — say what they are instead
  const UNCATEGORISABLE: Record<string, string> = { transfer: '⇄ Transfer', excluded: '⊘ Not in P&L' }
  if (UNCATEGORISABLE[t.type]) {
    return (
      <span className="flex min-w-0 items-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e6e9ef] bg-white px-2.5 py-1 text-[12.5px] text-[#79818f]">
          {UNCATEGORISABLE[t.type]}
        </span>
      </span>
    )
  }
  const src = t.assign_source || ''
  if (src.startsWith('ai_suggested:')) {
    const sugId = src.slice('ai_suggested:'.length)
    const conf = t.ai_confidence != null ? Math.round(t.ai_confidence * 100) : null
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <button onClick={onAccept} title="Apply this category"
          className="inline-flex max-w-[196px] cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-[#cabff5] bg-[#faf8ff] px-2.5 py-1 text-[12.5px] font-[550] text-[#5b4bd6] hover:border-solid hover:bg-[#f2eeff]">
          <span className="shrink-0 text-[10px]">✦</span>
          <span className="truncate">{catName(sugId)}</span>
          {conf != null && <span className="shrink-0 text-[11px] tabular-nums text-[#9c93cf]">{conf}%</span>}
        </button>
        {/* The chip itself accepts, but a lone ✕ next to it reads as "reject only" —
            an explicit tick makes accepting as visible as dismissing */}
        <button onClick={onAccept} title="Accept suggestion" aria-label={`Accept ${catName(sugId)}`}
          className="h-[22px] w-[22px] shrink-0 cursor-pointer rounded-md text-[12px] font-[650] text-[#5b4bd6] hover:bg-[#efeaff]">✓</button>
        <button onClick={onDismiss} title="Dismiss suggestion" aria-label="Dismiss suggestion"
          className="h-[22px] w-[22px] shrink-0 cursor-pointer rounded-md text-[11px] text-[#b0b7c3] hover:bg-[#f1f3f7] hover:text-[#5d6674]">✕</button>
      </span>
    )
  }
  if (t.category_id) {
    const cat = cats.find(c => c.id === t.category_id) ?? { id: t.category_id, name: t.category_name }
    const col = categoryColour(cats, cat)
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <CategoryPicker cats={cats} value={t.category_id} valueName={t.category_name} onSelect={onPick}
          trigger={
            <span className="inline-flex max-w-full items-center gap-[7px] rounded-full border border-[#edeff3] bg-[#f6f7f9] px-2.5 py-1 text-[12.5px] text-[#3f4753] hover:border-[#dfe3ea]">
              <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: col.dot }} />
              <span className="truncate">{t.category_name}{cat.archived ? ' (archived)' : ''}</span>
            </span>
          } />
        {src === 'ai' && (
          <span className="shrink-0 cursor-default text-[10px] text-[#a99ff0]"
            title={`Categorised by AI${t.ai_confidence != null ? ` · ${Math.round(t.ai_confidence * 100)}% confidence` : ''}`}>✦</span>
        )}
      </span>
    )
  }
  return (
    <span className="flex min-w-0 items-center">
      <CategoryPicker cats={cats} onSelect={onPick}
        trigger={
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-[#d8dde5] bg-white px-[11px] py-1 text-[12.5px] text-[#8b93a1] hover:border-[#93b4fb] hover:text-[#2563eb]">
            <span className="text-xs">＋</span>Categorise
          </span>
        } />
    </span>
  )
}

// Row ⋯ menu: the rare/destructive actions (spec §1.4d.6)
function RowMenu({ t, onChanged, onNote, onError, onEdit, onCreateRule, onAddRecurring }: { t: any; onChanged: () => void; onNote: () => void; onError: (m: string) => void; onEdit: () => void; onCreateRule: () => void; onAddRecurring: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const act = (fn: () => Promise<any>) => () => { setOpen(false); fn().then(onChanged).catch(e => onError(e.message)) }
  return (
    <div ref={ref} className="relative justify-self-end">
      <button onClick={() => setOpen(o => !o)} aria-label="Row actions"
        className="h-[26px] w-[26px] cursor-pointer rounded-[7px] text-[13px] text-[#c2c8d2] hover:bg-[#f1f3f7] hover:text-[#4b5462]">⋯</button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          <MenuItem onClick={() => { setOpen(false); onEdit() }}>Edit transaction…</MenuItem>
          <MenuItem onClick={act(() => patch(`/transactions/${t.id}`, { reviewed: !t.reviewed }))}>
            {t.reviewed ? 'Mark unreviewed' : 'Mark reviewed'}
          </MenuItem>
          <MenuItem onClick={() => { setOpen(false); onNote() }}>{t.notes ? 'Edit note' : 'Add note'}</MenuItem>
          {t.type !== 'transfer' && <MenuItem onClick={() => { setOpen(false); onCreateRule() }}>Create rule from this…</MenuItem>}
          {t.type !== 'transfer' && <MenuItem onClick={() => { setOpen(false); onAddRecurring() }}>Track as recurring…</MenuItem>}
          {/* Money that moved but isn't income or spending — a mortgage principal leg,
              an owner drawing. Goes through the bulk endpoint so it's undoable. */}
          <MenuItem onClick={act(() => post('/transactions/bulk', { ids: [t.id], action: t.type === 'excluded' ? 'include' : 'exclude' }))}>
            {t.type === 'excluded' ? 'Return to P&L' : 'Exclude from P&L'}
          </MenuItem>
          {t.type === 'transfer' && t.linked_transaction_id && (
            <MenuItem onClick={act(() => post('/transfers/unlink', { id: t.id }))}>Unlink transfer</MenuItem>
          )}
          <MenuItem className="text-red-600" onClick={act(() => del(`/transactions/${t.id}`))}>Delete</MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({ children, onClick, className }: { children: ReactNode; onClick: () => void; className?: string }) {
  return (
    <button onClick={onClick} className={cn('block w-full cursor-pointer px-3 py-1.5 text-left text-[13px] text-[#3f4753] hover:bg-gray-50', className)}>
      {children}
    </button>
  )
}

function ViewOptions({ prefs, setPref }: { prefs: Prefs; setPref: (k: keyof Prefs, v: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const OPTIONS: { key: keyof Prefs; label: string }[] = [
    { key: 'account', label: 'Account column' },
    { key: 'details', label: 'Bank description line' },
    { key: 'dayNet', label: 'Daily net' },
    { key: 'compact', label: 'Compact rows' },
  ]
  return (
    <div ref={ref} className="relative ml-auto">
      <button onClick={() => setOpen(o => !o)}
        className="h-[30px] cursor-pointer rounded-lg border border-[#e5e8ee] px-[11px] text-[12.5px] text-[#5d6674] hover:bg-[#f7f8fa]">Columns</button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {OPTIONS.map(o => (
            <label key={o.key} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] hover:bg-gray-50">
              <input type="checkbox" checked={prefs[o.key]} onChange={e => setPref(o.key, e.target.checked)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function PageBtn({ children, disabled, onClick, label }: { children: ReactNode; disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label}
      className={cn('h-[30px] w-[30px] rounded-lg border border-[#e5e8ee]',
        disabled ? 'cursor-not-allowed text-[#c2c8d2]' : 'cursor-pointer text-[#4b5462] hover:bg-[#f7f8fa]')}>
      {children}
    </button>
  )
}

function NoteEditor({ t, onClose, onSaved }: { t: any; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('')
  useEffect(() => { setText(t?.notes || '') }, [t])
  if (!t) return null
  return (
    <Modal open onClose={onClose} title={`Note — ${t.vendor}`}>
      <Input value={text} onChange={e => setText(e.target.value)} placeholder="Note…" autoFocus />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => patch(`/transactions/${t.id}`, { notes: text || null }).then(() => { onSaved(); onClose() })}>Save</Button>
      </div>
    </Modal>
  )
}

function FilterSelect({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <div className="relative">
      <select value={value} onChange={e => onChange(e.target.value)}
        className="h-9 cursor-pointer appearance-none rounded-[9px] border border-[#dfe3ea] bg-white pl-3 pr-[30px] text-[13px] text-[#39404b] focus:border-[#93b4fb] focus:outline-none focus:ring-[3px] focus:ring-[rgba(37,99,235,0.10)]">
        {children}
      </select>
      <span className="pointer-events-none absolute right-[11px] top-1/2 -translate-y-1/2 text-[9px] text-[#9aa2af]">▼</span>
    </div>
  )
}

// Create a categorisation rule from a real transaction. The match text starts from
// the payee but is editable, and a live preview shows exactly what it would catch
// before anything is saved.
function TransactionModal({ open, tx, accounts, cats, onClose, onSaved }: {
  open: boolean
  tx?: any // present when editing
  accounts: any[]
  cats: any[]
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!tx
  const blank = () => ({ date: isoToday(), type: 'expense', direction: 'out', accountId: accounts[0]?.id ?? '', amount: '', payee: '', notes: '', categoryId: null })
  const [form, setForm] = useState<any>(blank)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (!open) return
    setError('')
    setForm(tx
      ? {
          date: String(tx.date).slice(0, 10), payee: tx.payee, type: tx.type,
          direction: Number(tx.amount_cents) >= 0 ? 'in' : 'out',
          amount: (Math.abs(Number(tx.amount_cents)) / 100).toFixed(2),
          accountId: tx.account_id, categoryId: tx.category_id, notes: tx.notes || '',
        }
      : blank())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tx])

  // Picking a type implies a direction for the unambiguous cases; adjustments and
  // interest can go either way, so the choice is left alone there.
  const setType = (t: string) => setForm((f: any) => ({
    ...f, type: t, direction: t === 'income' ? 'in' : t === 'expense' ? 'out' : f.direction,
  }))

  const linkedTransfer = editing && !!tx.linked_transaction_id
  const cents = Math.round(parseFloat(form.amount || '0') * 100)
  const signed = form.direction === 'out' ? -Math.abs(cents) : Math.abs(cents)

  const save = async () => {
    setBusy(true); setError('')
    const body = {
      accountId: form.accountId || accounts[0]?.id, date: form.date, payee: form.payee.trim(),
      amountCents: signed, type: form.type,
      categoryId: form.type === 'transfer' ? null : (form.categoryId || null),
      notes: form.notes?.trim() || null,
    }
    try {
      if (editing) await patch(`/transactions/${tx.id}`, body)
      else await post('/transactions', body)
      onSaved(); onClose()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  if (!open) return null
  const cat = cats.find((c: any) => c.id === form.categoryId)
  return (
    <Modal open onClose={onClose} title={editing ? 'Edit transaction' : 'Add transaction'}>
      <div className="space-y-3">
        {editing && (
          <p className="truncate text-xs text-gray-500" title={tx.payee}>
            Imported as: <span className="text-gray-700">{tx.payee}</span>
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-gray-600">Date
            <Input type="date" value={form.date} onChange={e => set('date', e.target.value)} />
          </label>
          <label className="block text-sm text-gray-600">Account
            <Select className="w-full" value={form.accountId || ''} disabled={linkedTransfer}
              onChange={e => set('accountId', e.target.value)}>
              {accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </label>
        </div>
        <label className="block text-sm text-gray-600">Payee
          <Input value={form.payee || ''} onChange={e => set('payee', e.target.value)} />
        </label>
        <div className="grid grid-cols-[1fr_auto_1fr] gap-3">
          <label className="block text-sm text-gray-600">Amount
            <Input type="number" step="0.01" min="0" value={form.amount} disabled={linkedTransfer}
              onChange={e => set('amount', e.target.value)} />
          </label>
          <label className="block text-sm text-gray-600">Direction
            <Select value={form.direction} disabled={linkedTransfer} onChange={e => set('direction', e.target.value)}>
              <option value="out">Money out</option>
              <option value="in">Money in</option>
            </Select>
          </label>
          <label className="block text-sm text-gray-600">Type
            <Select className="w-full" value={form.type} disabled={linkedTransfer} onChange={e => setType(e.target.value)}>
              {(editing && tx.type === 'transfer' ? TYPES : TYPES.filter((t: string) => t !== 'transfer')).map((t: string) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </label>
        </div>
        <p className="text-xs text-gray-500">
          Will be stored as <span className="font-medium tabular-nums text-gray-700">{money(signed)}</span>
          {form.direction === 'out' ? ' (money out)' : ' (money in)'}
        </p>
        {form.type !== 'transfer' && (
          <div className="text-sm text-gray-600">Category
            <div className="mt-1">
              <CategoryPicker cats={cats} value={form.categoryId} onSelect={id => set('categoryId', id)}
                triggerClassName="w-full"
                trigger={<span className="flex h-9 w-full items-center rounded-md border border-gray-300 bg-white px-3 text-sm">
                  {cat ? cat.name : 'Uncategorised'}
                </span>} />
            </div>
          </div>
        )}
        <label className="block text-sm text-gray-600">Notes
          <Input value={form.notes || ''} onChange={e => set('notes', e.target.value)} />
        </label>

        {linkedTransfer && (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            This is one leg of a linked transfer. Unlink it from the row menu to change the amount, account or type.
          </p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={busy || !form.payee?.trim() || !form.amount}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add transaction'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
