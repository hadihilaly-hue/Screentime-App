import { useState, type FormEvent } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { IconBolt } from '../ui'

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
    <section className="fade-up flex min-h-[88dvh] flex-col justify-center">
      <div className="mb-10">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-acid text-ink">
          <IconBolt className="h-7 w-7" />
        </span>
        <h1 className="mt-6 text-[2.25rem] leading-none font-extrabold tracking-[-0.04em]">
          EarnedTime
        </h1>
        <p className="mt-3 text-[0.9375rem] text-muted">Do the work. Unlock the screen.</p>
      </div>

      {!isSupabaseConfigured && (
        <p className="banner banner-error mb-4">Supabase is not configured. Fill in .env first.</p>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="field"
        />
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="field"
        />
        <button
          type="submit"
          disabled={busy || !isSupabaseConfigured}
          className="press btn btn-primary mt-2 w-full"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p className="banner banner-error">{error}</p>}
      </form>

      <p className="mt-8 text-[0.8125rem] leading-snug text-faint">
        No signup flow by design — the one account is created in the Supabase dashboard.
      </p>
    </section>
  )
}
