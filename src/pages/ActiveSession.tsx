import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { endSession, getActiveSession, type AppSession } from '../lib/db'
import { Spinner } from '../ui'

function format(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const RADIUS = 132
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

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

  if (error)
    return (
      <div className="fixed inset-0 flex items-center justify-center p-6">
        <p className="banner banner-error">{error}</p>
      </div>
    )
  if (!session) return <Spinner />

  const total = session.minutes * 60_000
  const endsAt = new Date(session.started_at).getTime() + total
  const remaining = endsAt - now

  if (remaining <= 0) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-alert px-6 text-center safe-bottom">
        <p className="breathe text-[3.25rem] leading-none font-extrabold tracking-[-0.05em] text-white">
          TIME'S UP
        </p>
        <p className="text-lg font-semibold text-white/80">{session.app_name} — put it down.</p>
        <button
          onClick={acknowledge}
          disabled={busy}
          className="press btn mt-2 w-full max-w-xs bg-white font-bold text-alert"
        >
          {busy ? 'Logging…' : 'OK'}
        </button>
      </div>
    )
  }

  // Depletes clockwise from full as the session burns down.
  const left = Math.max(0, remaining) / total

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-ink px-6 safe-top safe-bottom">
      <div className="pt-6 text-center">
        <p className="eyebrow">Session running</p>
        <p className="mt-2 text-lg font-bold tracking-[-0.02em]">{session.app_name}</p>
      </div>

      <div className="relative flex items-center justify-center">
        <svg viewBox="0 0 300 300" className="h-[19rem] w-[19rem] max-w-[82vw] -rotate-90">
          <circle
            cx="150"
            cy="150"
            r={RADIUS}
            fill="none"
            stroke="var(--color-panel-hi)"
            strokeWidth="10"
          />
          <circle
            cx="150"
            cy="150"
            r={RADIUS}
            fill="none"
            stroke="var(--color-acid)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - left)}
            style={{ transition: 'stroke-dashoffset 1s linear' }}
          />
        </svg>
        <div className="absolute flex flex-col items-center">
          <span className="numeral text-[4.5rem] text-fg">{format(remaining)}</span>
          <span className="mt-1 text-[0.8125rem] font-semibold text-faint">
            of {session.minutes} min
          </span>
        </div>
      </div>

      <button
        onClick={acknowledge}
        disabled={busy}
        className="press btn btn-ghost mb-2 w-full max-w-xs"
      >
        {busy ? 'Logging…' : 'End early'}
      </button>
    </div>
  )
}
