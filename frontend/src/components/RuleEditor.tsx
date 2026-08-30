// The rule editor, shared by the Rules page and the Transactions row menu
// ("Create rule from this…"), so both entry points get the full condition
// builder and live preview rather than two different creators.
import { useEffect, useMemo, useState } from 'react'
import { get, patch, post } from '../lib/api'
import { Button, Input, Modal, Select } from './ui'
import { CategoryPicker } from './CategoryPicker'
import { date, money } from '../lib/format'

export type Cond = { field: string; op: string; value: any; value2?: any }

const OPS: Record<string, [string, string][]> = {
  payee: [['contains', 'contains'], ['not_contains', 'does not contain'], ['starts_with', 'starts with'],
    ['ends_with', 'ends with'], ['equals', 'is exactly']],
  amount: [['gt', 'is over'], ['gte', 'is at least'], ['lt', 'is under'], ['lte', 'is at most'],
    ['eq', 'is exactly'], ['between', 'is between']],
  account: [['is', 'is'], ['is_not', 'is not']],
  direction: [['is', 'is']],
}
const FIELD_LABELS: [string, string][] = [
  ['payee', 'Description'], ['amount', 'Amount'], ['account', 'Account'], ['direction', 'Money in / out'],
]
export const opLabel = (field: string, op: string) => OPS[field]?.find(([v]) => v === op)?.[1] ?? op

// Amounts live as cents in the rule and as dollars in the inputs
const toCents = (v: string) => (v.trim() === '' ? null : Math.round(parseFloat(v) * 100))
const toDollars = (c: any) => (c == null || c === '' ? '' : String(Math.abs(Number(c)) / 100))

const blankCond = (field: string): Cond =>
  field === 'amount' ? { field, op: 'gt', value: 0 }
    : field === 'account' ? { field, op: 'is', value: '' }
      : field === 'direction' ? { field, op: 'is', value: 'out' }
        : { field: 'payee', op: 'contains', value: '' }

// The plain-English summary shown in the rules list
export function describeConditions(rule: any, accountName: (id: string) => string) {
  return (rule.conditions || []).map((c: Cond) => {
    const op = opLabel(c.field, c.op)
    if (c.field === 'payee') return `description ${op} “${c.value}”`
    if (c.field === 'amount') return `amount ${op} ${money(Math.abs(Number(c.value)))}` +
      (c.op === 'between' ? ` and ${money(Math.abs(Number(c.value2)))}` : '')
    if (c.field === 'account') return `account ${op} ${accountName(c.value)}`
    return `it is money ${c.value}`
  }).join(rule.match_all === false ? ' or ' : ' and ')
}

export type RuleSeed = {
  name?: string
  conditions?: Cond[]
  categoryId?: string | null
  prepend?: boolean       // corrections jump to the top of the priority list
  fromPayee?: string      // shown as context, and used to suggest the match text
}

export function RuleEditor({ rule = {}, seed, cats, accounts, onClose, onSaved }: {
  rule?: any; seed?: RuleSeed; cats: any[]; accounts: any[]; onClose: () => void; onSaved: (r?: any) => void
}) {
  const isNew = !rule.id
  const [name, setName] = useState(rule.name || seed?.name || '')
  const [matchAll, setMatchAll] = useState(rule.match_all !== false)
  const [conds, setConds] = useState<Cond[]>(
    rule.conditions?.length ? rule.conditions : seed?.conditions?.length ? seed.conditions : [blankCond('payee')])
  const [categoryId, setCategoryId] = useState<string | null>(rule.category_id ?? seed?.categoryId ?? null)
  const [renameTo, setRenameTo] = useState(rule.rename_to || '')
  // Opened from a transaction, the point is usually to file the matches — default it on
  const [applyExisting, setApplyExisting] = useState(!!seed)
  const [preview, setPreview] = useState<any>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // The suggested match text is derived server-side, by the same module that
  // produces the vendor name, so it always matches the row it came from.
  useEffect(() => {
    if (!seed?.fromPayee || seed.conditions?.length) return
    get(`/rules/suggest?payee=${encodeURIComponent(seed.fromPayee)}`)
      .then(r => {
        setConds([{ field: 'payee', op: 'contains', value: r.matchText }])
        setName((n: string) => n || r.matchText)
      })
      .catch(() => setConds([{ field: 'payee', op: 'contains', value: seed.fromPayee! }]))
  }, [seed?.fromPayee])

  const setCond = (i: number, patchC: Partial<Cond>) =>
    setConds(cs => cs.map((c, j) => (j === i ? { ...c, ...patchC } : c)))

  // Live preview, debounced — the same endpoint the rule itself will match on
  const payload = useMemo(() => JSON.stringify(conds), [conds])
  useEffect(() => {
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ conditions: payload, matchAll: String(matchAll) })
      get(`/rules/preview?${qs}`).then(setPreview).catch(() => setPreview(null))
    }, 300)
    return () => clearTimeout(t)
  }, [payload, matchAll])

  const save = async () => {
    setBusy(true); setError('')
    const body = { name, conditions: conds, matchAll, categoryId, renameTo,
      prepend: seed?.prepend ?? false, applyTo: applyExisting ? 'uncategorised' : 'none' }
    try {
      if (isNew) {
        // The created rule carries applied/undoId, which the caller may surface
        onSaved(await post('/rules', body))
      } else {
        // PATCH only edits; running it over existing rows is a separate step
        await patch(`/rules/${rule.id}`, body)
        if (applyExisting) await post(`/rules/${rule.id}/apply`)
        onSaved()
      }
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? 'New rule' : 'Edit rule'}>
      <div className="space-y-3">
        {seed?.fromPayee && <p className="text-xs text-gray-500">From: <span className="text-gray-700">{seed.fromPayee}</span></p>}
        <label className="block text-xs text-gray-500">Rule name
          <Input className="mt-1" placeholder="e.g. Supermarket → Groceries" value={name} onChange={e => setName(e.target.value)} />
        </label>

        <div className="rounded-md border border-gray-200 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span>Apply when</span>
            <Select className="h-7 text-xs" value={matchAll ? 'all' : 'any'} onChange={e => setMatchAll(e.target.value === 'all')}>
              <option value="all">all conditions match</option>
              <option value="any">any condition matches</option>
            </Select>
          </div>
          {conds.map((c, i) => (
            <div key={i} className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Select className="h-8 text-xs" value={c.field}
                onChange={e => setConds(cs => cs.map((x, j) => (j === i ? blankCond(e.target.value) : x)))}>
                {FIELD_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
              <Select className="h-8 text-xs" value={c.op} onChange={e => setCond(i, { op: e.target.value })}>
                {OPS[c.field].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
              {c.field === 'payee' && (
                <Input className="h-8 max-w-56 text-xs" placeholder="text to match" value={c.value ?? ''}
                  onChange={e => setCond(i, { value: e.target.value })} />
              )}
              {c.field === 'amount' && (
                <>
                  <Input className="h-8 max-w-28 text-xs" type="number" step="0.01" min="0" placeholder="0.00"
                    value={toDollars(c.value)} onChange={e => setCond(i, { value: toCents(e.target.value) ?? 0 })} />
                  {c.op === 'between' && (
                    <>
                      <span className="text-xs text-gray-400">and</span>
                      <Input className="h-8 max-w-28 text-xs" type="number" step="0.01" min="0" placeholder="0.00"
                        value={toDollars(c.value2)} onChange={e => setCond(i, { value2: toCents(e.target.value) ?? 0 })} />
                    </>
                  )}
                </>
              )}
              {c.field === 'account' && (
                <Select className="h-8 text-xs" value={c.value || ''} onChange={e => setCond(i, { value: e.target.value })}>
                  <option value="">select an account…</option>
                  {accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              )}
              {c.field === 'direction' && (
                <Select className="h-8 text-xs" value={c.value} onChange={e => setCond(i, { value: e.target.value })}>
                  <option value="out">money out</option>
                  <option value="in">money in</option>
                </Select>
              )}
              <button onClick={() => setConds(cs => cs.filter((_, j) => j !== i))} disabled={conds.length === 1}
                aria-label="Remove condition"
                className="h-7 w-7 cursor-pointer rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30">✕</button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setConds(cs => [...cs, blankCond('payee')])}>+ Add condition</Button>
        </div>

        <div className="space-y-2 rounded-md border border-gray-200 p-3">
          <p className="text-sm font-medium">Then</p>
          <div className="flex items-center gap-2 text-sm">
            <span className="w-28 shrink-0 text-gray-500">File as</span>
            <CategoryPicker cats={cats} value={categoryId} onSelect={setCategoryId} clearLabel="Don't set a category"
              triggerClassName="flex-1"
              trigger={
                <span className="flex h-9 w-full items-center rounded-md border border-gray-300 bg-white px-3 text-sm">
                  {categoryId ? (cats.find((c: any) => c.id === categoryId)?.name ?? '?') : 'Don’t set a category'}
                </span>
              } />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="w-28 shrink-0 text-gray-500">Show name as</span>
            <Input placeholder="leave blank to keep the derived name" value={renameTo} onChange={e => setRenameTo(e.target.value)} />
          </label>
          <p className="text-xs text-gray-500">
            Renaming changes the display name only — the bank’s description is kept as-is and still searchable.
          </p>
        </div>

        {/* What this rule catches right now */}
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs">
          {!preview ? <p className="text-gray-400">Finish the conditions to see what this catches.</p> : (
            <>
              <p className="text-gray-700">
                Matches <b>{preview.total}</b> existing transaction{preview.total === 1 ? '' : 's'}
                {preview.uncategorised > 0 && <> · <b>{preview.uncategorised}</b> still uncategorised</>}
              </p>
              {preview.samples?.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-gray-500">
                  {preview.samples.map((s: any, i: number) => (
                    <li key={i} className="truncate">{date(s.date)} · {s.payee} · <span className="tabular-nums">{money(s.amount_cents)}</span></li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={applyExisting} onChange={e => setApplyExisting(e.target.checked)} />
          Apply to matching transactions now {isNew ? '' : '(you can also use Run later)'}
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save rule'}</Button>
        </div>
      </div>
    </Modal>
  )
}
