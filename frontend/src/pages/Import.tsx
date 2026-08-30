// CSV import: pick account + file → (first time) map columns → preview with duplicate
// detection → commit. History with rollback below.
import { useEffect, useState } from 'react'
import { get, post } from '../lib/api'
import { Amount, Badge, Button, Card, FileInput, Select } from '../components/ui'
import { date, dateLocal, money } from '../lib/format'


type Mapping = { dateCol: number; payeeCol: number; amountCol?: number; debitCol?: number; creditCol?: number }

export default function ImportPage() {
  const [accounts, setAccounts] = useState<any[]>([])
  const [accountId, setAccountId] = useState('')
  const [file, setFile] = useState<{ name: string; content: string } | null>(null)
  const [preview, setPreview] = useState<any>(null)
  const [mapping, setMapping] = useState<Mapping | null>(null)
  const [format, setFormat] = useState<'signed' | 'debitcredit'>('signed')
  const [draft, setDraft] = useState<any>({ dateCol: 0, payeeCol: 2, amountCol: 1, debitCol: 2, creditCol: 3 })
  const [included, setIncluded] = useState<Set<number>>(new Set())
  const [history, setHistory] = useState<any[]>([])
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadHistory = () => get('/imports').then(setHistory).catch(() => {})
  useEffect(() => { get('/accounts').then(a => { setAccounts(a); if (a[0]) setAccountId(a[0].id) }); loadHistory() }, [])

  const pickFile = (f: File) => {
    const reader = new FileReader()
    reader.onload = () => setFile({ name: f.name, content: String(reader.result) })
    reader.readAsText(f)
    setPreview(null); setResult(null); setMapping(null)
  }

  const runPreview = async (m?: Mapping) => {
    if (!file || !accountId) return
    setBusy(true); setError('')
    try {
      const p = await post('/imports/preview', { accountId, content: file.content, mapping: m })
      setPreview(p)
      if (!p.needsMapping) {
        setMapping(p.mapping)
        setIncluded(new Set(p.rows.filter((r: any) => r.status === 'new').map((r: any) => r.line))) // duplicates pre-unchecked
      }
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  const commit = async () => {
    if (!file || !mapping) return
    setBusy(true); setError('')
    try {
      const r = await post('/imports/commit', { accountId, filename: file.name, content: file.content, mapping, includeLines: [...included] })
      setResult(r); setPreview(null); setFile(null); loadHistory()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  const applyDraftMapping = () => {
    const m: Mapping = format === 'signed'
      ? { dateCol: +draft.dateCol, payeeCol: +draft.payeeCol, amountCol: +draft.amountCol }
      : { dateCol: +draft.dateCol, payeeCol: +draft.payeeCol, debitCol: +draft.debitCol, creditCol: +draft.creditCol }
    runPreview(m)
  }

  const cols = preview?.needsMapping ? Math.max(...preview.sample.map((r: string[]) => r.length)) : 0
  const colOptions = Array.from({ length: cols }, (_, i) => (
    <option key={i} value={i}>{preview?.header?.[i] ? `${preview.header[i]} (col ${i + 1})` : `Column ${i + 1}`}</option>
  ))

  return (
    <div className="space-y-4">
      <Card title="Import CSV">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={accountId} onChange={e => { setAccountId(e.target.value); setPreview(null) }}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <FileInput accept=".csv,text/csv" onChange={e => e.target.files?.[0] && pickFile(e.target.files[0])} />
          <Button onClick={() => runPreview()} disabled={!file || !accountId || busy}>{busy ? 'Working…' : 'Preview'}</Button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        {result && <p className="mt-2 text-sm text-emerald-700">Imported {result.inserted} new transactions ({result.duplicates} duplicates discarded). Run AI categorisation from the Transactions page or <Button size="sm" variant="outline" onClick={() => post('/ai/categorise', { importId: result.importId }).then(r => alert(`Rules: ${r.ruleAssigned}, AI applied: ${r.aiApplied ?? 0}, suggested: ${r.aiSuggested ?? 0}`)).catch(e => setError(e.message))}>categorise now</Button></p>}
      </Card>

      {/* Column mapping (first import for the account) */}
      {preview?.needsMapping && (
        <Card title={`Map columns — ${preview.hasHeader ? 'header row detected' : 'no header row detected'}`}>
          <div className="mb-3 overflow-auto">
            <table className="text-xs">
              <tbody>
                {preview.sample.map((r: string[], i: number) => (
                  <tr key={i} className={i === 0 && preview.hasHeader ? 'font-semibold' : ''}>
                    {r.map((c, j) => <td key={j} className="border border-gray-100 px-2 py-1">{c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label>Amount format<br />
              <Select value={format} onChange={e => setFormat(e.target.value as any)}>
                <option value="signed">Single signed amount column</option>
                <option value="debitcredit">Separate Debit / Credit columns</option>
              </Select>
            </label>
            <label>Date<br /><Select value={draft.dateCol} onChange={e => setDraft({ ...draft, dateCol: e.target.value })}>{colOptions}</Select></label>
            <label>Description<br /><Select value={draft.payeeCol} onChange={e => setDraft({ ...draft, payeeCol: e.target.value })}>{colOptions}</Select></label>
            {format === 'signed'
              ? <label>Amount<br /><Select value={draft.amountCol} onChange={e => setDraft({ ...draft, amountCol: e.target.value })}>{colOptions}</Select></label>
              : <>
                  <label>Debit<br /><Select value={draft.debitCol} onChange={e => setDraft({ ...draft, debitCol: e.target.value })}>{colOptions}</Select></label>
                  <label>Credit<br /><Select value={draft.creditCol} onChange={e => setDraft({ ...draft, creditCol: e.target.value })}>{colOptions}</Select></label>
                </>}
            <Button onClick={applyDraftMapping}>Apply mapping</Button>
          </div>
          <p className="mt-2 text-xs text-gray-500">The mapping is saved to this account after import and reused automatically next time.</p>
        </Card>
      )}

      {/* Preview table */}
      {preview && !preview.needsMapping && (
        <Card title="Preview" actions={<Button onClick={commit} disabled={busy || included.size === 0}>Import {included.size} rows</Button>}>
          {(() => {
            const n = (s: string) => preview.rows.filter((r: any) => r.status === s).length
            return (
              <p className="mb-2 text-xs text-gray-500">
                {n('new')} new · {n('duplicate')} duplicate{n('duplicate') === 1 ? '' : 's'} held back
                {n('invalid') > 0 && ` · ${n('invalid')} unreadable`}
              </p>
            )
          })()}
          <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500"><th></th><th>Line</th><th>Date</th><th>Vendor</th><th>Description</th><th className="px-3 text-right">Amount</th><th className="pl-3">Status</th></tr></thead>
            <tbody>
              {preview.rows.map((r: any) => (
                <tr key={r.line} className="border-b border-gray-50">
                  <td className="py-1">
                    <input type="checkbox" disabled={!r.valid} checked={included.has(r.line)}
                      onChange={e => setIncluded(prev => { const n = new Set(prev); e.target.checked ? n.add(r.line) : n.delete(r.line); return n })} />
                  </td>
                  <td className="text-gray-400">{r.line}</td>
                  <td>{r.date ? date(r.date) : '—'}</td>
                  <td className="max-w-48 truncate font-medium">{r.vendor || '—'}</td>
                  <td className="max-w-72 truncate text-gray-500">{r.payee}</td>
                  <td className="px-3 text-right">{r.amount != null ? <Amount cents={r.amount} /> : '—'}</td>
                  <td className="max-w-[26rem] py-1 pl-3 align-top">
                    {r.status === 'new' && <Badge className="bg-emerald-100 text-emerald-700">new</Badge>}
                    {r.status === 'duplicate' && <Badge className="bg-amber-100 text-amber-800">duplicate</Badge>}
                    {r.status === 'invalid' && <Badge className="bg-red-100 text-red-700">invalid — excluded</Badge>}
                    {r.reason && <p className="mt-0.5 text-xs text-gray-500">{r.reason}</p>}
                    {/* Show what it was matched against, so the tick is an informed one */}
                    {r.match && (
                      <p className="mt-0.5 text-xs text-gray-500">
                        matches {r.match.source === 'file' ? `line ${r.match.line}` : 'existing'}: {date(r.match.date)}
                        {' · '}<span className="tabular-nums">{money(r.match.amount_cents)}</span>
                        {' · '}<span className="text-gray-400">{r.match.payee}</span>
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}

      <Card title="Import history">
        {history.length === 0 && <p className="text-sm text-gray-500">No imports yet.</p>}
        {history.length > 0 && (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500"><th>Date</th><th>File</th><th>Account</th><th>Rows</th><th>Duplicates</th><th>New</th><th></th></tr></thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id} className="border-b border-gray-50">
                  <td className="py-1.5">{dateLocal(h.created_at)}</td>
                  <td>{h.filename}</td><td>{h.account_name}</td>
                  <td>{h.row_count}</td><td>{h.duplicates_discarded}</td><td>{h.new_count}</td>
                  <td>
                    {h.rolled_back
                      ? <Button size="sm" variant="outline" onClick={() => post(`/imports/${h.id}/restore`).then(loadHistory)}>Restore</Button>
                      : <Button size="sm" variant="ghost" onClick={() => window.confirm('Roll back this import? Its transactions can be restored for 30 days.') && post(`/imports/${h.id}/rollback`).then(loadHistory)}>Roll back</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>
    </div>
  )
}
