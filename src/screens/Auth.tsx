import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, ErrorNote, Screen } from '../components/ui'

export function Auth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    const fn = mode === 'signin' ? supabase.auth.signInWithPassword : supabase.auth.signUp
    const { error } = await fn.call(supabase.auth, { email, password })
    if (error) setError(error.message)
    else if (mode === 'signup') setNotice('Account created. If confirmation is on, check your email.')
    setBusy(false)
  }

  return (
    <Screen>
      <div className="flex flex-1 flex-col justify-center gap-6 py-12">
        <div>
          <h1 className="text-4xl font-bold">Scrip</h1>
          <p className="mt-2 text-gray-400">Earn the screen time. Prove the work.</p>
        </div>
        <Card>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <input
              type="email"
              required
              autoComplete="email"
              placeholder="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded border border-gray-600 bg-gray-900 px-3 py-3 text-base"
            />
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              placeholder="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded border border-gray-600 bg-gray-900 px-3 py-3 text-base"
            />
            <ErrorNote>{error}</ErrorNote>
            {notice && <p className="text-sm text-emerald-300">{notice}</p>}
            <Button type="submit" disabled={busy}>
              {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
            >
              {mode === 'signin' ? 'No account yet?' : 'Already have an account?'}
            </Button>
          </form>
        </Card>
      </div>
    </Screen>
  )
}
