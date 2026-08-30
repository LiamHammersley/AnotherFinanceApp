import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from './ui'
import { categoryColour, categoryGroup, groupColour } from '../lib/categories'

export function CategoryChip({ cats, category, className }: { cats: any[]; category: any; className?: string }) {
  const col = categoryColour(cats, category)
  // ⊘ marks a category the P&L ignores, so it's obvious the moment it's assigned
  const cat = cats.find(c => c.id === category.id) ?? category
  const excluded = cat?.excluded || categoryGroup(cats, cat)?.excluded
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', className)}
      style={{ backgroundColor: col.bg, color: col.text }}
      title={excluded ? 'Not counted in the P&L' : undefined}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: col.dot }} />
      {category.name}{category.archived ? ' (archived)' : ''}{excluded ? ' ⊘' : ''}
    </span>
  )
}

// Searchable category dropdown, grouped and colour-coded by category group.
// Default trigger: the current category as a coloured chip (click to change),
// or a dashed "＋ Categorise" button when unset; pass `trigger` to override.
export function CategoryPicker({ cats, value, valueName, onSelect, trigger, triggerClassName, align = 'left', up = false,
  clearLabel, allowGroups = false }: {
  cats: any[]
  value?: string | null
  valueName?: string // fallback label while cats are loading
  onSelect: (id: string | null) => void
  trigger?: ReactNode
  triggerClassName?: string
  align?: 'left' | 'right'
  up?: boolean // open above the trigger (for controls near the bottom of the viewport)
  // The "no category" row: omit for the default (shown once a value is set), pass a
  // label to always show it (filters use "All categories"), or null where clearing
  // is meaningless — a rule or a merge target must resolve to a real category.
  clearLabel?: string | null
  allowGroups?: boolean // let a whole group be picked, not just its sub-categories
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const current = value ? cats.find(c => c.id === value) ?? { id: value, name: valueName || '…' } : null
  const needle = q.trim().toLowerCase()
  const groups = cats
    .filter(c => !c.parent_id && !c.archived)
    .map(g => ({
      g,
      subs: cats.filter(c => c.parent_id === g.id && !c.archived &&
        (!needle || c.name.toLowerCase().includes(needle) || g.name.toLowerCase().includes(needle))),
    }))
    .filter(x => x.subs.length > 0)

  const pick = (id: string | null) => {
    setOpen(false); setQ('')
    if (id !== (value ?? null)) onSelect(id)
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" className={cn('cursor-pointer', triggerClassName)} title="Change category"
        onClick={() => { setOpen(o => !o); setQ('') }}>
        {trigger ?? (current
          ? <CategoryChip cats={cats} category={current} className="transition-shadow hover:ring-2 hover:ring-brand/30" />
          : <span className="inline-flex items-center rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-xs text-gray-500 hover:border-brand hover:text-brand">＋ Categorise</span>)}
      </button>
      {open && (
        <div className={cn('absolute z-20 w-64 rounded-md border border-gray-200 bg-white shadow-lg',
          up ? 'bottom-full mb-1' : 'top-full mt-1', align === 'right' ? 'right-0' : 'left-0')}>
          <input
            autoFocus
            className="w-full rounded-t-md border-b border-gray-100 px-3 py-2 text-sm focus:outline-none"
            placeholder="Search categories…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setOpen(false); setQ('') }
              if (e.key === 'Enter' && groups[0]?.subs[0]) pick(groups[0].subs[0].id)
            }}
          />
          <div className="max-h-72 overflow-auto py-1">
            {clearLabel !== null && (clearLabel || current) && (
              <button type="button" className="block w-full cursor-pointer px-3 py-1.5 text-left text-xs text-gray-500 hover:bg-gray-50" onClick={() => pick(null)}>
                {clearLabel ?? '✕ Clear — mark uncategorised'}
              </button>
            )}
            {groups.map(({ g, subs }) => {
              const col = groupColour(g.name, g.colour)
              // As a filter the group itself is a valid choice ("everything in Housing")
              const Header = allowGroups ? 'button' : 'div'
              return (
                <div key={g.id}>
                  <Header
                    type={allowGroups ? 'button' : undefined}
                    onClick={allowGroups ? () => pick(g.id) : undefined}
                    className={cn('flex w-full items-center gap-1.5 px-3 pb-0.5 pt-2 text-left text-[11px] font-semibold uppercase tracking-wide',
                      allowGroups && 'cursor-pointer hover:bg-gray-50', g.id === value && 'bg-gray-50')}
                    style={{ color: col.text }}>
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: col.dot }} />
                    {g.name}{allowGroups && <span className="ml-1 normal-case tracking-normal text-gray-400">(all)</span>}
                  </Header>
                  {subs.map(c => (
                    <button key={c.id} type="button" onClick={() => pick(c.id)}
                      className={cn('block w-full cursor-pointer px-3 py-1.5 pl-7 text-left text-sm hover:bg-gray-50', c.id === value && 'font-semibold')}
                      style={c.id === value ? { color: col.text } : undefined}>
                      {c.name}
                    </button>
                  ))}
                </div>
              )
            })}
            {groups.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">No matching categories</p>}
          </div>
        </div>
      )}
    </div>
  )
}
