import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { get } from './lib/api'
import { Spinner } from './components/ui'
import Layout from './components/Layout'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import Transactions from './pages/Transactions'
import ImportPage from './pages/Import'
import PnL from './pages/PnL'
import Budgets from './pages/Budgets'
import Accounts from './pages/Accounts'
import { ErrorBoundary } from './components/ErrorBoundary'
import NetWorth from './pages/NetWorth'
import Recurring from './pages/Recurring'
import Categories from './pages/Categories'
import Rules from './pages/Rules'
import Settings from './pages/Settings'

export default function App() {
  const [state, setState] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading')
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    get('/setup/status').then(async s => {
      if (s.needsSetup) return setState('setup')
      try { await get('/auth/me'); setState('ready') } catch { setState('login') }
    }).catch(() => setState('login'))
  }, [])

  if (state === 'loading') return <Spinner />
  if (state === 'setup') return <Setup onDone={() => { setState('ready'); navigate('/') }} />
  if (state === 'login') return <Login onLogin={() => { setState('ready'); navigate('/') }} />

  return (
    <Layout onLogout={() => setState('login')}>
      {/* Keyed on the path so navigating away from a broken page clears the error */}
      <ErrorBoundary key={location.pathname}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/accounts/:id" element={<Accounts />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/pnl" element={<PnL />} />
        <Route path="/budgets" element={<Budgets />} />
        <Route path="/networth" element={<NetWorth />} />
        <Route path="/recurring" element={<Recurring />} />
        <Route path="/categories" element={<Categories />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
      </ErrorBoundary>
    </Layout>
  )
}
