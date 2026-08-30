// One "add recurring entry" form, two entry points: the Recurring page's manual
// button, and a transaction's ⋯ menu (which prefills from the row).
import { useEffect, useState } from 'react'
import { post } from '../lib/api'
import { Button, Input, Modal, Select } from './ui'
import { CategoryPicker } from './CategoryPicker'
import { isoDate } from '../lib/format'

export const FREQS = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly']
const FREQ_DAYS: Record<string, number> = { weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91, yearly: 365 }

export type RecurringSeed = {
  payee?: string
  nickname?: string
  amount?: string      // dollars, as typed
  categoryId?: string | null
  lastSeen?: string    // the transaction's date, when seeded from one
}

// next_due is only a starting guess — refreshRecurring() corrects it from the
// first matching transaction that turns up.
const dueAfter = (from: string | undefined, frequency: string) =>
  from ? isoDate(new Date(new Date(from + 'T12:00:00').getTime() + FREQ_DAYS[frequency] * 86400000)) : ''

export function RecurringForm({ open, onClose, cats, onSaved, seed }: {
  open: boolean; onClose: () => void; cats: any[]; onSaved: () => void; seed?: RecurringSeed
}) {
  const [f, setF] = useState<any>({ frequency: 'monthly' })
  const [busy, setBusy] = useState(false)

  // Reload the form whenever it opens, so a second row doesn't inherit the first's values
  useEffect(() => {
    if (!open) return
    setF({
      frequency: 'monthly', ...seed,
      nextDue: dueAfter(seed?.lastSeen, 'monthly'),
    })
  }, [open, seed])

  const setFrequency = (frequency: string) =>
    setF((p: any) => ({ ...p, frequency, nextDue: dueAfter(seed?.lastSeen, frequency) || p.nextDue }))

  const save = async () => {
    setBusy(true)
    try {
      await post('/recurring', {
        payee: f.payee, nickname: f.nickname || null, frequency: f.frequency,
        expectedAmountCents: Math.round(parseFloat(f.amount) * 100),
        categoryId: f.categoryId || null, lastSeen: seed?.lastSeen || null,
        nextDue: f.nextDue || null, isSubscription: !!f.isSubscription,
      })
      onSaved(); onClose()
    } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add recurring entry">
      <div className="space-y-2">
        <label className="block text-xs text-gray-500">Bank description — new transactions are matched on this
          <Input className="mt-1" placeholder="Payee" value={f.payee || ''} onChange={e => setF({ ...f, payee: e.target.value })} />
        </label>
        <label className="block text-xs text-gray-500">Name (optional)
          <Input className="mt-1" placeholder="e.g. Streaming service" value={f.nickname || ''} onChange={e => setF({ ...f, nickname: e.target.value })} />
        </label>
        <Input type="number" step="0.01" placeholder="Expected amount (negative for expense)" value={f.amount || ''} onChange={e => setF({ ...f, amount: e.target.value })} />
        <Select className="w-full" value={f.frequency} onChange={e => setFrequency(e.target.value)}>
          {FREQS.map(x => <option key={x} value={x}>{x}</option>)}
        </Select>
        <CategoryPicker cats={cats} value={f.categoryId || null} onSelect={id => setF({ ...f, categoryId: id })}
          triggerClassName="w-full" clearLabel="No category"
          trigger={
            <span className="flex h-9 w-full items-center rounded-md border border-gray-300 bg-white px-3 text-sm">
              {f.categoryId ? (cats.find((c: any) => c.id === f.categoryId)?.name ?? '?') : 'No category'}
            </span>
          } />
        <label className="block text-xs text-gray-500">Next due
          <Input className="mt-1" type="date" value={f.nextDue || ''} onChange={e => setF({ ...f, nextDue: e.target.value })} />
        </label>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={!!f.isSubscription} onChange={e => setF({ ...f, isSubscription: e.target.checked })} /> Subscription</label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!f.payee || !f.amount || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </Modal>
  )
}
