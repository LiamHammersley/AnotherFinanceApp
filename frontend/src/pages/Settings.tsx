import { useEffect, useState } from 'react'
import { get, patch, post, put, upload } from '../lib/api'
import { Badge, Button, Card, FileInput, Input, Modal, Select } from '../components/ui'
import { date, dateLocal, dateTimeLocal, isoToday, money } from '../lib/format'

function SoftwareUpdate() {
  const [version, setVersion] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [state, setState] = useState<'idle' | 'installing' | 'restarting' | 'done' | 'error'>('idle')
  const [note, setNote] = useState('')
  useEffect(() => { get('/system/version').then(r => setVersion(r.version)).catch(() => {}) }, [])

  const busy = state === 'installing' || state === 'restarting'
  const install = async () => {
    if (!file || busy) return
    setState('installing'); setNote('Uploading and installing — the app stays up during this step…')
    try {
      const r = await upload('/system/update', file)
      setState('restarting'); setNote(`Installed ${r.to} (was ${r.from}) — restarting the service…${r.warning ? ` ⚠ ${r.warning}` : ''}`)
      const t0 = Date.now()
      const poll = async () => {
        try {
          const v = await get('/system/version')
          if (v.version === r.to) { setVersion(v.version); setState('done'); setNote(`Updated to ${v.version} ✓${r.warning ? ` ⚠ ${r.warning}` : ''}`); setFile(null); return }
        } catch { /* service still restarting */ }
        if (Date.now() - t0 > 120_000) { setState('error'); setNote('Still waiting after 2 minutes — check `journalctl -u finance-api` on the server.'); return }
        setTimeout(poll, 2000)
      }
      setTimeout(poll, 2500)
    } catch (e) { setState('error'); setNote((e as Error).message) }
  }

  return (
    <Card title="Software update">
      <div className="space-y-2 text-sm">
        <p>Current version <Badge>{version || '…'}</Badge></p>
        <div className="flex flex-wrap items-center gap-2">
          <FileInput className="min-w-0" accept=".tar.gz,.tgz,application/gzip" onChange={e => setFile(e.target.files?.[0] || null)} />
          <Button size="sm" disabled={!file || busy} onClick={install}>
            {state === 'installing' ? 'Installing…' : state === 'restarting' ? 'Restarting…' : 'Upload & install'}
          </Button>
        </div>
        {note && <p className={state === 'error' ? 'text-red-600' : state === 'done' ? 'text-emerald-700' : 'text-gray-600'}>{note}</p>}
        <p className="text-xs text-gray-500">
          Upload a finance-app release package (.tar.gz, built with <code>npm run package</code>). The running
          version is snapshotted on the server first (roll back by re-uploading an older package), and database
          migrations run automatically on restart. Only install packages you built or trust — they run with the
          app's permissions.
        </p>
      </div>
    </Card>
  )
}

// Recover a transaction deleted in the last 30 days (spec 5.2). After that
// cleanup() purges it for good.
function RecentlyDeleted() {
  const [rows, setRows] = useState<any[] | null>(null)
  const load = () => get('/transactions/deleted').then(setRows).catch(() => setRows([]))
  useEffect(() => { load() }, [])
  return (
    <Card title="Recently deleted (30 days)" actions={<Button size="sm" variant="outline" onClick={load}>Refresh</Button>}>
      {rows === null && <p className="text-sm text-gray-500">Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-gray-500">Nothing deleted in the last 30 days.</p>}
      {rows?.map(t => (
        <div key={t.id} className="flex flex-wrap items-center gap-3 border-b border-gray-50 py-1.5 text-sm">
          <span className="w-20 text-gray-500">{date(t.date)}</span>
          <span className="min-w-0 flex-1 truncate" title={t.payee}>{t.vendor || t.payee}</span>
          <span className="tabular-nums">{money(t.amount_cents)}</span>
          <span className="text-xs text-gray-400">{t.account_name}</span>
          <Badge className={t.days_left <= 5 ? 'bg-red-100 text-red-700' : ''}>
            {t.days_left > 0 ? `${t.days_left}d left` : 'purging soon'}
          </Badge>
          <Button size="sm" variant="outline" onClick={() => post(`/transactions/${t.id}/restore`).then(load)}>Restore</Button>
        </div>
      ))}
    </Card>
  )
}

// Icons are stored as a single emoji — no icon font, renders everywhere
const ICONS = ['🏦', '💳', '🏠', '💰', '🐖', '📈', '🚗', '✈️', '🎓', '🧾', '💼', '🌱']

function IconPicker({ value, onSelect }: { value: string; onSelect: (icon: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative">
      <button onClick={() => setOpen(o => !o)} title="Account icon"
        className="h-7 w-8 cursor-pointer rounded border border-gray-200 text-base leading-none hover:bg-gray-50">
        {ICONS.includes(value) ? value : '🏦'}
      </button>
      {open && (
        <span className="absolute left-0 top-full z-20 mt-1 grid w-40 grid-cols-6 gap-1 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
          {ICONS.map(i => (
            <button key={i} onClick={() => { onSelect(i); setOpen(false) }}
              className="cursor-pointer rounded p-1 text-base leading-none hover:bg-gray-100">{i}</button>
          ))}
        </span>
      )}
    </span>
  )
}

function AddAccount({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState<any>({ type: 'standard', openingDate: isoToday(), openingBalance: '0', colour: '#2563eb' })
  const [error, setError] = useState('')
  const save = async () => {
    setError('')
    try {
      await post('/accounts', {
        name: f.name, type: f.type, openingDate: f.openingDate, colour: f.colour,
        openingBalanceCents: Math.round(parseFloat(f.openingBalance || '0') * 100),
      })
      setOpen(false); setF({ type: 'standard', openingDate: isoToday(), openingBalance: '0', colour: '#2563eb' })
      onSaved()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>+ Add account</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add account">
        <div className="space-y-2">
          <Input placeholder="Account name" value={f.name || ''} onChange={e => setF({ ...f, name: e.target.value })} autoFocus />
          <Select className="w-full" value={f.type} onChange={e => setF({ ...f, type: e.target.value })}>
            <option value="standard">Standard (everyday / savings)</option>
            <option value="credit_card">Credit Card</option>
            <option value="mortgage">Mortgage</option>
          </Select>
          <label className="block text-sm text-gray-600">
            Opening balance{f.type !== 'standard' && ' — enter the amount owed as a positive number'}
            <Input type="number" step="0.01" value={f.openingBalance} onChange={e => setF({ ...f, openingBalance: e.target.value })} />
          </label>
          <label className="block text-sm text-gray-600">
            Balance effective from
            <Input type="date" value={f.openingDate} onChange={e => setF({ ...f, openingDate: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            Colour
            <input type="color" value={f.colour} onChange={e => setF({ ...f, colour: e.target.value })} className="h-7 w-10 cursor-pointer border-0 bg-transparent" />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={!f.name?.trim()}>Create account</Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

export default function Settings() {
  const [s, setS] = useState<any>(null)
  const [accounts, setAccounts] = useState<any[]>([])
  const [sessions, setSessions] = useState<any[]>([])
  const [usage, setUsage] = useState<any[]>([])
  const [undoHistory, setUndoHistory] = useState<any[]>([])
  const [auditRows, setAuditRows] = useState<any[] | null>(null)
  const [auditFilter, setAuditFilter] = useState({ entity: '', from: '', to: '' })
  const [alertLog, setAlertLog] = useState<any[] | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [pwError, setPwError] = useState('')
  const [msg, setMsg] = useState('')

  const load = () => {
    get('/settings').then(setS)
    get('/accounts?archived=true').then(setAccounts)
    get('/auth/sessions').then(setSessions)
    get('/ai/usage').then(setUsage)
    get('/undo').then(setUndoHistory)
  }
  useEffect(() => { load() }, [])

  const save = async (body: any) => { await put('/settings', body); setMsg('Saved.'); load() }

  if (!s) return null
  return (
    <div className="space-y-4">
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}

      <Card title="AI">
        <div className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.aiEnabled} onChange={e => save({ aiEnabled: e.target.checked })} />
            AI features enabled {!s.aiEnabled && <span className="text-gray-500">(rules-only categorisation)</span>}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-44">Anthropic API key</span>
            <Badge className={s.apiKeySet ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}>{s.apiKeySet ? 'set' : 'not set'}</Badge>
            <Input className="max-w-72" placeholder="Replace key…" value={apiKey} onChange={e => setApiKey(e.target.value)} />
            <Button size="sm" disabled={!apiKey} onClick={() => { save({ apiKey }); setApiKey('') }}>Save</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-44">Categorisation model</span>
            <Input className="max-w-72" defaultValue={s.categorisationModel} onBlur={e => e.target.value !== s.categorisationModel && save({ categorisationModel: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-44">Analysis model</span>
            <Input className="max-w-72" defaultValue={s.analysisModel} onBlur={e => e.target.value !== s.analysisModel && save({ analysisModel: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="w-44">Budget planning model</span>
            <Input className="max-w-72" defaultValue={s.budgetModel} onBlur={e => e.target.value !== s.budgetModel && save({ budgetModel: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="w-44">Budget thinking</span>
            <Select value={s.budgetEffort} onChange={e => save({ budgetEffort: e.target.value })}>
              {['off', 'low', 'medium', 'high'].map(v => <option key={v} value={v}>{v}</option>)}
            </Select>
            <span className="text-xs text-gray-500">how hard the planner thinks — costs more, reasons better</span>
          </label>
          <p className="text-xs text-gray-500">Model changes take effect on the next request — no restart needed.</p>
          <div>
            <h4 className="mb-1 font-semibold">Monthly usage</h4>
            {usage.length === 0 ? <p className="text-gray-500">No AI calls yet.</p> : (
              <div className="overflow-x-auto">
              <table className="text-xs">
                <thead><tr className="text-left text-gray-500"><th className="pr-4">Month</th><th className="pr-4">Type</th><th className="pr-4">Model</th><th className="pr-4">Calls</th><th className="pr-4">Tokens in/out</th><th>Est. cost</th></tr></thead>
                <tbody>{usage.map((u, i) => (
                  <tr key={i}><td className="pr-4">{u.month}</td><td className="pr-4">{u.request_type}</td><td className="pr-4">{u.model}</td><td className="pr-4">{u.calls}</td><td className="pr-4">{u.input_tokens}/{u.output_tokens}</td>
                    <td title={u.pricing_known ? 'Priced from this model’s published rate' : 'Unknown model — assumed mid-tier pricing'}>
                      ≈ US${u.est_cost_usd}{!u.pricing_known && ' *'}
                    </td></tr>
                ))}</tbody>
              </table>
              </div>
            )}
          </div>
        </div>
      </Card>

      <Card title="Accounts" actions={<AddAccount onSaved={load} />}>
        {accounts.map(a => (
          <div key={a.id} className="flex flex-wrap items-center gap-3 border-b border-gray-50 py-1.5 text-sm">
            <input type="color" value={a.colour} onChange={e => patch(`/accounts/${a.id}`, { colour: e.target.value }).then(load)} className="h-6 w-8 cursor-pointer border-0 bg-transparent" title="Account colour" />
            <IconPicker value={a.icon} onSelect={icon => patch(`/accounts/${a.id}`, { icon }).then(load)} />
            <span className="w-52">{a.name} <span className="text-xs text-gray-400">({a.type.replace('_', ' ')})</span></span>
            <span className="tabular-nums">{money(a.balance_cents)}</span>
            {a.archived && <Badge>archived</Badge>}
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => {
                const v = window.prompt(`Reconcile ${a.name}: enter the actual bank balance in dollars${a.type !== 'standard' ? ' (negative for amount owed)' : ''}`)
                if (v != null) post(`/accounts/${a.id}/adjust`, { targetBalanceCents: Math.round(parseFloat(v) * 100), date: isoToday() }).then(load)
              }}>Reconcile</Button>
              <Button size="sm" variant="ghost" onClick={() => patch(`/accounts/${a.id}`, { archived: !a.archived }).then(load)}>{a.archived ? 'Unarchive' : 'Archive'}</Button>
            </span>
          </div>
        ))}
      </Card>

      <Card title="Sessions">
        {sessions.map(x => (
          <p key={x.id} className="border-b border-gray-50 py-1 text-sm">
            {x.device_hint} — last active {dateLocal(x.last_active)} {x.current && <Badge className="bg-emerald-100 text-emerald-700">this device</Badge>}
          </p>
        ))}
        <Button className="mt-2" size="sm" variant="destructive" onClick={() => post('/auth/sessions/revoke-all').then(() => (window.location.href = '/'))}>Revoke all sessions</Button>
      </Card>

      <Card title="Change password">
        <div className="flex max-w-3xl flex-col gap-2 sm:flex-row">
          <Input type="password" placeholder="Current password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} />
          <Input type="password" placeholder="New password (10+ chars)" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} />
          <Input type="password" placeholder="Confirm new password" value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} />
          <Button onClick={async () => {
            setPwError('')
            if (!pw.current) return setPwError('Enter your current password.')
            if (pw.next.length < 10) return setPwError('New password must be at least 10 characters.')
            if (pw.next !== pw.confirm) return setPwError('New passwords do not match.')
            try { await post('/auth/change-password', { currentPassword: pw.current, newPassword: pw.next }); window.location.href = '/' }
            catch (e) { setPwError((e as Error).message) }
          }}>Change</Button>
        </div>
        {pwError && <p className="mt-1 text-sm text-red-600">{pwError}</p>}
        <p className="mt-1 text-xs text-gray-500">All sessions are signed out after a password change — you'll be asked to log in with the new password.</p>
      </Card>

      <Card title="Undo history (last 24 hours)">
        {undoHistory.length === 0 && <p className="text-sm text-gray-500">No bulk actions in the last 24 hours.</p>}
        {undoHistory.map(u => (
          <div key={u.id} className="flex items-center justify-between border-b border-gray-50 py-1 text-sm">
            <span>{u.description} {u.undone && <Badge>undone</Badge>}</span>
            {!u.undone && <Button size="sm" variant="outline" onClick={() => post(`/undo/${u.id}`).then(load)}>Undo</Button>}
          </div>
        ))}
      </Card>

      <Card title="Alert log (30 days)" actions={<Button size="sm" variant="outline" onClick={() => get('/alerts?log=true').then(setAlertLog)}>Load</Button>}>
        {alertLog?.map(a => (
          <p key={a.id} className="border-b border-gray-50 py-1 text-sm">
            <span className="text-gray-400">{dateLocal(a.created_at)}</span> {a.message} {a.dismissed_at && <Badge>dismissed</Badge>}
          </p>
        ))}
      </Card>

      <Card title="Audit log" actions={
        <div className="flex flex-wrap justify-end gap-2">
          <Select value={auditFilter.entity} onChange={e => setAuditFilter({ ...auditFilter, entity: e.target.value })}>
            <option value="">All entities</option>
            {['transaction', 'account', 'category', 'rule', 'recurring', 'import'].map(x => <option key={x} value={x}>{x}</option>)}
          </Select>
          <Input type="date" value={auditFilter.from} onChange={e => setAuditFilter({ ...auditFilter, from: e.target.value })} />
          <Input type="date" value={auditFilter.to} onChange={e => setAuditFilter({ ...auditFilter, to: e.target.value })} />
          <Button size="sm" variant="outline" onClick={() => {
            const qs = Object.entries(auditFilter).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('&')
            get(`/audit?${qs}`).then(setAuditRows)
          }}>Load</Button>
        </div>
      }>
        {auditRows && (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-500"><th className="pr-3">When</th><th className="pr-3">Action</th><th className="pr-3">Entity</th><th>Change</th></tr></thead>
              <tbody>{auditRows.map(r => (
                <tr key={r.id} className="border-t border-gray-50 align-top">
                  <td className="whitespace-nowrap pr-3">{dateTimeLocal(r.created_at)}</td>
                  <td className="pr-3">{r.action}</td>
                  <td className="pr-3">{r.entity_type}</td>
                  <td className="max-w-md truncate text-gray-500" title={JSON.stringify({ previous: r.previous, next: r.next })}>
                    {JSON.stringify(r.next ?? r.previous)?.slice(0, 120)}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <RecentlyDeleted />

      <Card title="Backup">
        <p className="text-sm text-gray-700">
          Download a complete snapshot of the database — every account, transaction, category, rule and
          analysis — as a gzipped SQL dump you can restore with the runbook in <code>docs/restore.md</code>.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => { window.location.href = '/api/system/backup' }}>Download backup</Button>
          <span className="text-xs text-gray-500">Scheduled backups still run on the server via <code>docs/backup.sh</code>.</span>
        </div>
      </Card>

      <SoftwareUpdate />
    </div>
  )
}
