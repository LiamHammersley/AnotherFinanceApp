import { useEffect, useState } from 'react'
import { del, get, patch, post } from '../lib/api'
import { Badge, Button, Card, Select, Spinner } from '../components/ui'
import { FREQS, RecurringForm } from '../components/RecurringForm'
import { date, isoToday, money } from '../lib/format'

export default function Recurring() {
  const [items, setItems] = useState<any[] | null>(null)
  const [dismissed, setDismissed] = useState<any[]>([])
  const [candidates, setCandidates] = useState<any[] | null>(null)
  const [cats, setCats] = useState<any[]>([])
  const [subsOnly, setSubsOnly] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = () => {
    get('/recurring').then(setItems)
    get('/recurring?status=dismissed').then(setDismissed).catch(() => setDismissed([]))
  }
  useEffect(() => { load(); get('/categories').then(setCats) }, [])

  // Nickname is display only — the payee stays as the bank wrote it, because that's
  // what new transactions are matched against. Blank clears it.
  const rename = (r: any) => {
    const nickname = window.prompt(`Name for "${r.payee}"`, r.nickname || r.vendor || r.payee)
    if (nickname !== null) patch(`/recurring/${r.id}`, { nickname }).then(load)
  }

  const detect = async () => {
    setBusy(true)
    setCandidates(await post('/recurring/detect'))
    setBusy(false)
  }

  const confirm = async (c: any) => {
    await post('/recurring', {
      payee: c.payee, frequency: c.frequency, expectedAmountCents: c.expected_amount_cents,
      categoryId: c.category_id, lastSeen: c.last_seen, nextDue: c.next_due, isSubscription: c.is_subscription,
    })
    setCandidates(cs => cs!.filter(x => x !== c)); load()
  }

  if (!items) return <Spinner />
  const shown = subsOnly ? items.filter(i => i.is_subscription) : items
  const today = isoToday()

  return (
    <div className="space-y-4">
      <Card title="Recurring transactions" actions={
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={subsOnly} onChange={e => setSubsOnly(e.target.checked)} /> Subscriptions only</label>
          <Button size="sm" variant="outline" onClick={() => setManualOpen(true)}>+ Manual entry</Button>
          <Button size="sm" onClick={detect} disabled={busy}>{busy ? 'Scanning…' : 'Scan for patterns'}</Button>
        </div>
      }>
        {shown.length === 0 && <p className="text-sm text-gray-500">Nothing confirmed yet — scan your transaction history for patterns.</p>}
        {shown.length > 0 && (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500">
              <th className="py-2">Name</th><th>Category</th><th className="px-3 text-right">Expected</th><th className="pr-3">Frequency</th><th>Last seen</th><th>Next due</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>
              {shown.map(r => {
                const overdue = r.next_due && r.next_due.slice(0, 10) < today
                return (
                  <tr key={r.id} className="border-b border-gray-50">
                    <td className="py-1.5">
                      <span className="flex items-center gap-1.5">
                        <span className="font-medium">{r.nickname || r.payee}</span>
                        {r.is_subscription && <Badge className="bg-indigo-100 text-indigo-700">subscription</Badge>}
                        <button onClick={() => rename(r)} title="Rename" aria-label={`Rename ${r.nickname || r.payee}`}
                          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-gray-200 px-1.5 text-[11px] text-gray-500 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-800">
                          ✎ <span className="hidden sm:inline">Rename</span>
                        </button>
                      </span>
                      {/* The raw description stays visible — it's what transactions match on */}
                      {r.nickname && <span className="block text-xs text-gray-400">{r.payee}</span>}
                    </td>
                    <td className="text-gray-500">{r.category_name || '—'}</td>
                    <td className="px-3 text-right tabular-nums">{money(r.expected_amount_cents)}</td>
                    <td className="pr-3">
                      <Select className="h-7 text-xs" value={r.frequency} onChange={e => patch(`/recurring/${r.id}`, { frequency: e.target.value }).then(load)}>
                        {FREQS.map(f => <option key={f} value={f}>{f}</option>)}
                      </Select>
                    </td>
                    <td className="text-gray-500">{r.last_seen ? date(r.last_seen.slice(0, 10)) : '—'}</td>
                    <td>{r.next_due ? date(r.next_due.slice(0, 10)) : '—'}</td>
                    <td>{overdue ? <Badge className="bg-red-100 text-red-700">overdue</Badge> : <Badge className="bg-emerald-100 text-emerald-700">active</Badge>}</td>
                    <td><Button size="sm" variant="ghost" onClick={() => patch(`/recurring/${r.id}`, { status: 'dismissed' }).then(load)}>Dismiss</Button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      {candidates && (
        <Card title={`Detected patterns (${candidates.length})`} actions={<Button size="sm" variant="ghost" onClick={() => setCandidates(null)}>✕</Button>}>
          {candidates.length === 0 && <p className="text-sm text-gray-500">No new recurring patterns found.</p>}
          {candidates.map(c => (
            <div key={c.payee} className="flex items-center justify-between border-b border-gray-50 py-2 text-sm">
              <span>{c.payee} — {money(c.expected_amount_cents)} {c.frequency} ({c.occurrences} occurrences){c.is_subscription && <Badge className="ml-1 bg-indigo-100 text-indigo-700">subscription</Badge>}</span>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => confirm(c)}>Accept</Button>
                <Button size="sm" variant="ghost" onClick={() => setCandidates(cs => cs!.filter(x => x !== c))}>Dismiss</Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      {dismissed.length > 0 && (
        <Card title={`Dismissed (${dismissed.length})`}>
          <p className="mb-2 text-xs text-gray-500">
            Dismissed patterns aren't tracked or alerted on. Restore one to start watching it again, or delete it
            permanently — deleting lets the detector propose it afresh next time you scan.
          </p>
          {dismissed.map(r => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 border-b border-gray-50 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{r.nickname || r.payee}</span>
              <span className="tabular-nums">{money(r.expected_amount_cents)}</span>
              <span className="text-xs text-gray-400">{r.frequency}</span>
              <Button size="sm" variant="outline" onClick={() => patch(`/recurring/${r.id}`, { status: 'active' }).then(load)}>Restore</Button>
              <Button size="sm" variant="ghost" onClick={() => window.confirm(`Delete the recurring entry for ${r.nickname || r.payee}?`) && del(`/recurring/${r.id}`).then(load)}>Delete</Button>
            </div>
          ))}
        </Card>
      )}

      {/* Full list: the picker builds its groups from the parent categories */}
      <RecurringForm open={manualOpen} onClose={() => setManualOpen(false)} cats={cats} onSaved={load} />
    </div>
  )
}

