// Rules run at import time, before any AI call: a named set of conditions
// (all/any) that assigns a category and/or renames the displayed vendor.
// Evaluated top-down, first enabled match wins — drag to reorder.
import { useEffect, useRef, useState } from 'react'
import { del, get, patch, post } from '../lib/api'
import { Badge, Button, Card, cn } from '../components/ui'
import { RuleEditor, describeConditions } from '../components/RuleEditor'

export default function Rules() {
  const [rules, setRules] = useState<any[]>([])
  const [cats, setCats] = useState<any[]>([])
  const [accounts, setAccounts] = useState<any[]>([])
  const [editing, setEditing] = useState<any>(null) // rule being edited, or {} for new
  const [applied, setApplied] = useState('')
  const [error, setError] = useState('')
  const dragIndex = useRef<number | null>(null)

  const load = () => get('/rules').then(setRules)
  useEffect(() => { load(); get('/categories').then(setCats); get('/accounts').then(setAccounts) }, [])

  const accountName = (id: string) => accounts.find(a => a.id === id)?.name ?? 'an account'
  const describe = (r: any) => describeConditions(r, accountName)

  const drop = (to: number) => {
    const from = dragIndex.current
    if (from == null || from === to) return
    const next = [...rules]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setRules(next)
    post('/rules/reorder', { ids: next.map(r => r.id) })
  }

  const applyNow = async (r: any) => {
    setError(''); setApplied('')
    try {
      const res = await post(`/rules/${r.id}/apply`)
      setApplied(res.applied ? `${res.description}.` : `“${r.name}” matched nothing new.`)
      load()
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <div className="space-y-4">
      <Card title={`Rules (${rules.length})`} actions={<Button size="sm" onClick={() => setEditing({})}>+ New rule</Button>}>
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        {applied && (
          <p className="mb-2 flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {applied}<button className="cursor-pointer" onClick={() => setApplied('')}>✕</button>
          </p>
        )}
        {rules.length === 0 && <p className="text-sm text-gray-500">No rules yet. A rule watches for transactions matching your conditions and files them automatically.</p>}
        {rules.map((r, i) => (
          <div key={r.id} draggable
            onDragStart={() => { dragIndex.current = i }}
            onDragOver={e => e.preventDefault()}
            onDrop={() => drop(i)}
            className={cn('flex cursor-grab items-start gap-2 border-b border-gray-50 py-2 text-sm active:cursor-grabbing',
              !r.enabled && 'opacity-55')}>
            <span className="mt-0.5 text-gray-300">⠿</span>
            <span className="mt-0.5 w-5 shrink-0 text-xs text-gray-400">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{r.name}</span>
                {!r.enabled && <Badge className="bg-gray-200 text-gray-600">off</Badge>}
                {r.rename_to && <Badge className="bg-sky-100 text-sky-700">renames</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-gray-500">
                If {describe(r)} → {r.category_id
                  ? <>file as <b>{r.parent_category_name ? `${r.parent_category_name} › ` : ''}{r.category_name}</b></>
                  : 'leave the category alone'}
                {r.rename_to && <> and show as <b>{r.rename_to}</b></>}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="ghost" title="Run this rule over existing transactions" onClick={() => applyNow(r)}>Run</Button>
              <Button size="sm" variant="ghost" onClick={() => patch(`/rules/${r.id}`, { enabled: !r.enabled }).then(load)}>
                {r.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Button>
              <Button size="sm" variant="ghost" className="text-red-600"
                onClick={() => window.confirm(`Delete the rule “${r.name}”?`) && del(`/rules/${r.id}`).then(load)}>Delete</Button>
            </span>
          </div>
        ))}
        <p className="mt-3 text-xs text-gray-500">
          Rules are evaluated top-down and the first enabled match wins, so put the most specific first.
          They run on import before any AI call, and only ever fill in a blank category — nothing you set by hand is overwritten.
        </p>
      </Card>

      {editing && (
        <RuleEditor rule={editing} cats={cats} accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}

