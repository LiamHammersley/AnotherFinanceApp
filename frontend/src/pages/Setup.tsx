// First-run wizard: create user → API key (skippable) → accounts → optional first import.
import { useState } from 'react'
import { post } from '../lib/api'
import { Button, Card, Input, Select } from '../components/ui'
import { isoToday } from '../lib/format'

type Draft = { name: string; type: string; openingBalance: string; openingDate: string }
const emptyAccount: Draft = { name: '', type: 'standard', openingBalance: '0', openingDate: isoToday() }

export default function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(1)
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [accounts, setAccounts] = useState<Draft[]>([{ ...emptyAccount }])

  const createUser = async () => {
    setError('')
    try { await post('/setup/create-user', { username, password }); setStep(2) }
    catch (err) { setError((err as Error).message) }
  }

  const saveKey = async (skip: boolean) => {
    setError('')
    try { await post('/setup/api-key', { apiKey: skip ? null : apiKey }); setStep(3) }
    catch (err) { setError((err as Error).message) }
  }

  const createAccounts = async () => {
    setError('')
    try {
      for (const a of accounts.filter(a => a.name.trim())) {
        await post('/accounts', {
          name: a.name, type: a.type, openingDate: a.openingDate,
          openingBalanceCents: Math.round(parseFloat(a.openingBalance || '0') * 100),
        })
      }
      setStep(4)
    } catch (err) { setError((err as Error).message) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-xl" title={`First-run setup — step ${step} of 4`}>
        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Create your account. This wizard only appears once.</p>
            <Input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} />
            <Input type="password" placeholder="Password (minimum 10 characters)" value={password} onChange={e => setPassword(e.target.value)} />
            <Button onClick={createUser} disabled={!username || password.length < 10}>Continue</Button>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Add your Anthropic API key to enable AI categorisation and spending analysis. You can skip this and add it later in Settings — AI features stay disabled until then.</p>
            <Input placeholder="sk-ant-…" value={apiKey} onChange={e => setApiKey(e.target.value)} />
            <div className="flex gap-2">
              <Button onClick={() => saveKey(false)} disabled={!apiKey}>Save key</Button>
              <Button variant="outline" onClick={() => saveKey(true)}>Skip</Button>
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Add your bank accounts. For credit cards and mortgages, enter the amount owed as the opening balance.</p>
            {accounts.map((a, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Input placeholder="Account name" value={a.name} onChange={e => setAccounts(x => x.map((v, j) => j === i ? { ...v, name: e.target.value } : v))} />
                <Select value={a.type} onChange={e => setAccounts(x => x.map((v, j) => j === i ? { ...v, type: e.target.value } : v))}>
                  <option value="standard">Standard</option>
                  <option value="credit_card">Credit Card</option>
                  <option value="mortgage">Mortgage</option>
                </Select>
                <Input type="number" step="0.01" placeholder="Opening balance" value={a.openingBalance} onChange={e => setAccounts(x => x.map((v, j) => j === i ? { ...v, openingBalance: e.target.value } : v))} />
                <Input type="date" value={a.openingDate} onChange={e => setAccounts(x => x.map((v, j) => j === i ? { ...v, openingDate: e.target.value } : v))} />
              </div>
            ))}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setAccounts(x => [...x, { ...emptyAccount }])}>+ Another account</Button>
              <Button onClick={createAccounts} disabled={!accounts.some(a => a.name.trim())}>Continue</Button>
            </div>
          </div>
        )}
        {step === 4 && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">All set. You can import a CSV into one of your new accounts now, or do it any time from the Import page.</p>
            <div className="flex gap-2">
              <Button onClick={() => { onDone(); window.location.href = '/import' }}>Import a CSV now</Button>
              <Button variant="outline" onClick={onDone}>Finish</Button>
            </div>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </Card>
    </div>
  )
}
