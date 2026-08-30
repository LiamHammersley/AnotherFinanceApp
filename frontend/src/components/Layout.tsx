import { useEffect, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { get, post } from '../lib/api'
import { Button, cn } from './ui'

// Sentence case per the redesign spec ("Net worth", not "Net Worth")
const NAV = [
  ['/', 'Dashboard'], ['/accounts', 'Accounts'], ['/transactions', 'Transactions'], ['/import', 'Import'],
  ['/pnl', 'P&L'], ['/budgets', 'Budgets'], ['/networth', 'Net worth'], ['/recurring', 'Recurring'],
  ['/categories', 'Categories'], ['/rules', 'Rules'], ['/settings', 'Settings'],
] as const

type Alert = { id: string; type: string; message: string; created_at: string }

export default function Layout({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [open, setOpen] = useState(false)

  const refresh = () => get('/alerts').then(setAlerts).catch(() => {})
  useEffect(() => { refresh(); const t = setInterval(refresh, 60_000); return () => clearInterval(t) }, [])

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[#e8ebf0] bg-white/[0.92] pt-[env(safe-area-inset-top)] backdrop-blur-[10px]">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-6 sm:gap-7">
          <span className="shrink-0 text-[15.5px] font-bold tracking-[-0.01em] text-[#2563eb]">Finance</span>
          {/* On narrow screens the nav scrolls horizontally instead of wrapping or collapsing */}
          <nav className="no-scrollbar flex flex-1 gap-0.5 overflow-x-auto">
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'}
                className={({ isActive }) => cn('shrink-0 whitespace-nowrap rounded-lg px-[11px] py-1.5 text-[13.5px]',
                  isActive ? 'bg-[#eef3ff] font-semibold text-[#2563eb]' : 'text-[#5d6674] hover:bg-[#f1f3f7] hover:text-[#171b22]')}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="flex shrink-0 items-center gap-3.5">
            <button onClick={() => setOpen(!open)} className="relative flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-lg text-[#6b7380] hover:bg-[#f1f3f7]" title="Alerts">
              🔔
              {alerts.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{alerts.length}</span>
              )}
            </button>
            {/* top-full anchors the panel under the header — without it it sits at its
                static position mid-header and grows off the top of the screen */}
            {open && (
              <div className="absolute right-2 top-full mt-1 w-96 max-w-[calc(100vw-1rem)] rounded-lg border border-gray-200 bg-white shadow-lg">
                <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
                  <span className="text-sm font-semibold">Alerts</span>
                  {alerts.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => post('/alerts/dismiss', { all: true }).then(refresh)}>Dismiss all</Button>
                  )}
                </div>
                <div className="max-h-[min(24rem,calc(100vh-9rem))] overflow-auto">
                  {alerts.length === 0 && <p className="p-4 text-sm text-gray-500">No alerts.</p>}
                  {alerts.map(a => (
                    <div key={a.id} className="flex items-start gap-2 border-b border-gray-50 px-3 py-2">
                      <p className="flex-1 text-sm">{a.message}</p>
                      <Button size="sm" variant="ghost" onClick={() => post('/alerts/dismiss', { id: a.id }).then(refresh)}>✕</Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <span className="h-5 w-px bg-[#e8ebf0]" />
            <button onClick={() => post('/auth/logout').then(onLogout)}
              className="cursor-pointer text-[13px] text-[#5d6674] hover:text-[#171b22]">Log out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">{children}</main>
    </div>
  )
}
