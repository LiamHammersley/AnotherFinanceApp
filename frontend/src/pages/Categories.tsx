import { useEffect, useState } from 'react'
import { del, get, patch, post } from '../lib/api'
import { Badge, Button, Card, Input, Modal, Select } from '../components/ui'
import { CategoryPicker } from '../components/CategoryPicker'
import { groupColour } from '../lib/categories'

type Conflict = { id: string; name: string; count: number; reason: 'transactions' | 'children' }

// Marks a category as "real money, but not income or spending" — a mortgage
// principal repayment, an owner drawing. Set it on a group to cover every
// sub-category under it.
// `compact` keeps the dense sub-category rows to a single glyph
function ExcludeToggle({ c, onChange, compact }: { c: any; onChange: () => void; compact?: boolean }) {
  const label = c.excluded ? 'Not in the P&L — click to include again' : 'Exclude from the P&L and budgets'
  return (
    <Button size="sm" variant="ghost" title={label} aria-label={label}
      className={c.excluded ? 'text-gray-700' : 'text-gray-400'}
      onClick={() => patch(`/categories/${c.id}`, { excluded: !c.excluded }).then(onChange)}>
      {compact ? '⊘' : c.excluded ? '⊘ Not in P&L' : 'Exclude from P&L'}
    </Button>
  )
}

export default function Categories() {
  const [cats, setCats] = useState<any[]>([])
  const [newSub, setNewSub] = useState<Record<string, string>>({})
  const [newParent, setNewParent] = useState('')
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [target, setTarget] = useState('')
  const [error, setError] = useState('')

  const load = () => get('/categories').then(setCats)
  useEffect(() => { load() }, [])

  // Delete goes straight through when the category is unused; otherwise the
  // dialog offers merge (reassign + delete) or archive (hide going forward).
  const remove = async (c: any) => {
    setError('')
    try { await del(`/categories/${c.id}`); load() }
    catch (e) {
      const msg = (e as Error).message
      const m = /^(\d+) transactions/.exec(msg)
      if (m) setConflict({ id: c.id, name: c.name, count: +m[1], reason: 'transactions' })
      else if (msg.startsWith('Delete sub-categories')) setConflict({ id: c.id, name: c.name, count: 0, reason: 'children' })
      else setError(msg)
    }
  }

  const archive = (id: string, archived = true) => patch(`/categories/${id}`, { archived }).then(() => { setConflict(null); setTarget(''); load() })

  // Re-parenting only moves the category. Its transactions carry the category id,
  // so they follow it into the new heading without being rewritten.
  const move = (c: any, parentId: string) => {
    if (!parentId) return
    setError('')
    patch(`/categories/${c.id}`, { parentId }).then(load).catch(e => setError((e as Error).message))
  }

  const rename = (c: any) => {
    const name = window.prompt('Rename category', c.name)
    if (name && name !== c.name) patch(`/categories/${c.id}`, { name }).then(load)
  }

  const active = cats.filter(c => !c.archived)
  const parents = active.filter(c => !c.parent_id)
  const subs = active.filter(c => c.parent_id)
  const archivedCats = cats.filter(c => c.archived)
  const movesFor = (c: any, p: any) => parents.filter(x => x.id !== p.id && x.is_income === c.is_income)
  const archivedParents = archivedCats.filter(c => !c.parent_id)
  // Subs archived on their own (their parent is still active)
  const archivedLooseSubs = archivedCats.filter(c => c.parent_id && !archivedParents.some(p => p.id === c.parent_id))

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {parents.map(p => (
          <Card key={p.id} title={
            <span className="flex items-center gap-2">
              {/* ponytail: native colour input — no picker library */}
              <input type="color" title="Group colour" className="swatch h-4 w-4 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0"
                value={groupColour(p.name, p.colour).dot}
                onChange={e => patch(`/categories/${p.id}`, { colour: e.target.value }).then(load)} />
              {p.name} {p.is_income && <span className="text-xs text-emerald-600">(income)</span>}
            </span>}
            actions={<span className="flex items-center gap-1">
              <ExcludeToggle c={p} onChange={load} />
              <Button size="sm" variant="ghost" onClick={() => rename(p)}>Rename</Button>
              <Button size="sm" variant="ghost" onClick={() => archive(p.id)}>Archive</Button>
              <Button size="sm" variant="ghost" onClick={() => remove(p)}>Delete</Button>
            </span>}>
            {p.excluded && (
              <p className="mb-2 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-500">
                Everything in this group is kept out of the P&amp;L and dashboard spending. Balances and net worth still include it.
              </p>
            )}
            {subs.filter(c => c.parent_id === p.id).map(c => (
              <div key={c.id} className="flex items-center justify-between border-b border-gray-50 py-1 text-sm">
                <span className="flex items-center gap-1.5">
                  {c.name}
                  {(c.excluded || p.excluded) && <Badge className="bg-gray-200 text-gray-600">not in P&amp;L</Badge>}
                </span>
                <span className="flex items-center gap-1">
                  {!p.excluded && <ExcludeToggle c={c} onChange={load} compact />}
                  {/* Only headings on the same side of the P&L — an expense can't move
                      under an income group without changing what it means. With nowhere
                      to go the control is hidden rather than shown empty. */}
                  {movesFor(c, p).length > 0 && (
                    <Select className="h-7 w-[92px] px-1.5 text-xs" value=""
                      aria-label={`Move ${c.name} under a different category`}
                      onChange={e => { move(c, e.target.value); e.target.value = '' }}>
                      <option value="">Move…</option>
                      {movesFor(c, p).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </Select>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => rename(c)}>Rename</Button>
                  <Button size="sm" variant="ghost" title="Archive" onClick={() => archive(c.id)}>Hide</Button>
                  <Button size="sm" variant="ghost" title="Delete" onClick={() => remove(c)}>✕</Button>
                </span>
              </div>
            ))}
            <div className="mt-2 flex gap-2">
              <Input className="h-7 text-xs" placeholder="New sub-category" value={newSub[p.id] || ''} onChange={e => setNewSub(s => ({ ...s, [p.id]: e.target.value }))} />
              <Button size="sm" variant="outline" disabled={!newSub[p.id]?.trim()}
                onClick={() => post('/categories', { name: newSub[p.id], parentId: p.id, isIncome: p.is_income }).then(() => { setNewSub(s => ({ ...s, [p.id]: '' })); load() })}>Add</Button>
            </div>
          </Card>
        ))}
      </div>
      <Card title="New top-level category">
        <div className="flex max-w-md gap-2">
          <Input placeholder="Category name" value={newParent} onChange={e => setNewParent(e.target.value)} />
          <Button disabled={!newParent.trim()} onClick={() => post('/categories', { name: newParent }).then(() => { setNewParent(''); load() })}>Add</Button>
        </div>
      </Card>

      {archivedCats.length > 0 && (
        <Card title={`Archived (${archivedCats.length})`}>
          <p className="mb-2 text-xs text-gray-500">Hidden from category pickers everywhere. Existing transactions keep these categories and still appear in P&L history.</p>
          {archivedParents.map(p => (
            <div key={p.id} className="border-b border-gray-50 py-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-gray-500">{p.name} <Badge>group</Badge></span>
                <Button size="sm" variant="outline" onClick={() => archive(p.id, false)}>Restore</Button>
              </div>
              <p className="text-xs text-gray-400">{archivedCats.filter(c => c.parent_id === p.id).map(c => c.name).join(', ')}</p>
            </div>
          ))}
          {archivedLooseSubs.map(c => (
            <div key={c.id} className="flex items-center justify-between border-b border-gray-50 py-1.5 text-sm">
              <span className="text-gray-500">{cats.find(p => p.id === c.parent_id)?.name} › {c.name}</span>
              <Button size="sm" variant="outline" onClick={() => archive(c.id, false)}>Restore</Button>
            </div>
          ))}
        </Card>
      )}

      {/* Merge or archive when the category is still in use */}
      <Modal open={!!conflict} onClose={() => { setConflict(null); setTarget('') }} title={`"${conflict?.name}" is still in use`}>
        {conflict?.reason === 'transactions' ? (
          <>
            <p className="text-sm text-gray-700">{conflict.count} transaction{conflict.count === 1 ? ' uses' : 's use'} this category. You can:</p>
            <div className="mt-3 rounded border border-gray-200 p-3">
              <p className="text-sm font-medium">Merge into another category</p>
              <p className="text-xs text-gray-500">Moves the transactions, then deletes “{conflict.name}”.</p>
              <div className="mt-2 flex gap-2">
                <CategoryPicker cats={cats.filter(c => c.id !== conflict.id)} value={target || null} clearLabel={null}
                  onSelect={id => setTarget(id || '')} triggerClassName="w-full"
                  trigger={
                    <span className="flex h-9 w-full items-center rounded-md border border-gray-300 bg-white px-3 text-sm">
                      {target ? (cats.find(c => c.id === target)?.name ?? '?') : 'Select a category…'}
                    </span>
                  } />
                <Button variant="destructive" disabled={!target}
                  onClick={() => del(`/categories/${conflict.id}?reassignTo=${target}`).then(() => { setConflict(null); setTarget(''); load() })}>Merge &amp; delete</Button>
              </div>
            </div>
            <div className="mt-2 rounded border border-gray-200 p-3">
              <p className="text-sm font-medium">Archive instead</p>
              <p className="text-xs text-gray-500">Keeps the transactions as they are, but hides the category from pickers going forward. Restorable from the Archived section.</p>
              <Button className="mt-2" variant="outline" onClick={() => archive(conflict.id)}>Archive “{conflict.name}”</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-700">This group still has sub-categories. Delete or merge them first — or archive the whole group to hide it (and its sub-categories) going forward.</p>
            <Button className="mt-3" variant="outline" onClick={() => conflict && archive(conflict.id)}>Archive group</Button>
          </>
        )}
      </Modal>
    </div>
  )
}
