import { useState, type FormEvent } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setBusy(false)
  }

  return (
    <section>
      <h1 className="text-2xl font-bold">Sign in</h1>
      {!isSupabaseConfigured && (
        <p className="mt-2 text-red-600">Supabase is not configured. Fill in .env first.</p>
      )}
      <form onSubmit={onSubmit} className="mt-4 flex max-w-sm flex-col gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email"
          className="border p-2"
        />
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          className="border p-2"
        />
        <button
          type="submit"
          disabled={busy || !isSupabaseConfigured}
          className="border bg-gray-900 p-2 text-white disabled:opacity-40"
        >
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
        {error && <p className="text-red-600">{error}</p>}
      </form>
      <p className="mt-4 text-sm text-gray-400">
        No signup flow by design — the one account is created in the Supabase dashboard.
      </p>
    </section>
  )
}
