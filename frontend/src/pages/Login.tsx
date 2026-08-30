import { useState, type FormEvent } from 'react'
import { post } from '../lib/api'
import { Button, Card, Input } from '../components/ui'

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try { await post('/auth/login', { username, password }); onLogin() }
    catch (err) { setError((err as Error).message) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-80" title="Sign in">
        <form onSubmit={submit} className="space-y-3">
          <Input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} autoFocus />
          <Input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button className="w-full" type="submit">Sign in</Button>
        </form>
      </Card>
    </div>
  )
}
