import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, ErrorNote } from '../components/ui'
import * as api from '../lib/api'
import { formatClock } from '../lib/day'
import type { Session } from '../lib/types'

/**
 * Full-screen countdown. Time remaining is derived from started_at, not from a
 * ticking counter, so backgrounding the app or reloading it doesn't hand you
 * free minutes.
 */
export function ActiveSession({
  session,
  refresh,
}: {
  session: Session
  refresh: () => Promise<void>
}) {
  const navigate = useNavigate()
  const endsAt = new Date(session.started_at).getTime() + session.minutes * 60_000
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])

  const remaining = Math.max(0, endsAt - now)
  const expired = remaining === 0

  useEffect(() => {
    if (!expired) return
    if (navigator.vibrate) navigator.vibrate([200, 100, 200])
  }, [expired])

  async function acknowledge() {
    setBusy(true)
    setError(null)
    try {
      await api.endSession(session.id)
      await refresh()
      navigate('/')
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div
      className={`flex min-h-full flex-col items-center justify-center gap-6 px-6 text-center safe-top safe-bottom ${
        expired ? 'bg-red-700 text-white' : 'bg-gray-900 text-gray-100'
      }`}
    >
      {expired ? (
        <>
          <p className="text-2xl font-semibold">Time's up.</p>
          <p className="text-7xl font-bold tabular-nums">0:00</p>
          <p className="max-w-xs text-white/80">
            Close {session.app_name}. Tap below to log the session — no session, no scrolling.
          </p>
          <ErrorNote>{error}</ErrorNote>
          <Button variant="secondary" onClick={acknowledge} disabled={busy} className="w-full max-w-xs">
            {busy ? '…' : 'I closed it'}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm uppercase tracking-wide text-gray-500">{session.app_name}</p>
          <p className="text-8xl font-bold tabular-nums text-emerald-400">
            {formatClock(remaining / 1000)}
          </p>
          <p className="text-sm text-gray-500">
            {session.from_bonus ? 'Bonus time — everything was done' : `${session.minutes} min spent`}
          </p>
          <ErrorNote>{error}</ErrorNote>
          <Button variant="ghost" onClick={acknowledge} disabled={busy}>
            End early — no refund
          </Button>
        </>
      )}
    </div>
  )
}
