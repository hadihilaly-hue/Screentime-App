import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { endSession, getActiveSession, type AppSession } from '../lib/db'

function format(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Spec section 4 screen 6. The countdown is derived from started_at, so
 * reloading or backgrounding the app cannot add time back.
 */
export default function ActiveSession({ userId }: { userId: string }) {
  const [session, setSession] = useState<AppSession | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    getActiveSession(userId)
      .then((s) => {
        if (!s) navigate('/dashboard')
        else setSession(s)
      })
      .catch((e: Error) => setError(e.message))
  }, [userId, navigate])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  async function acknowledge() {
    if (!session) return
    setBusy(true)
    try {
      await endSession(session.id)
      navigate('/dashboard')
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  if (error) return <p className="text-red-600">{error}</p>
  if (!session) return <p>Loading...</p>

  const endsAt = new Date(session.started_at).getTime() + session.minutes * 60_000
  const remaining = endsAt - now

  if (remaining <= 0) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-red-600 p-4 text-white">
        <p className="text-4xl font-bold">TIME'S UP</p>
        <p>{session.app_name} — put it down.</p>
        <button onClick={acknowledge} disabled={busy} className="border border-white px-4 py-2">
          {busy ? 'Logging...' : 'OK'}
        </button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-gray-900 p-4 text-white">
      <p className="text-7xl font-bold tabular-nums">{format(remaining)}</p>
      <p>{session.app_name}</p>
      <button onClick={acknowledge} disabled={busy} className="border border-white px-4 py-2 text-sm">
        End early
      </button>
    </div>
  )
}
