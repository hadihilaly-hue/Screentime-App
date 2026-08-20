import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as api from '../lib/api'
import { Button, Card, ErrorNote } from './ui'
import { SESSION_LENGTHS, TRACKED_APPS } from '../lib/types'

export function StartSession({
  date,
  available,
  unlimited,
  refresh,
}: {
  date: string
  available: number
  unlimited: boolean
  refresh: () => Promise<void>
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [app, setApp] = useState<string>(TRACKED_APPS[0])
  const [minutes, setMinutes] = useState<number>(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canAfford = (m: number) => unlimited || m <= available

  async function start() {
    setBusy(true)
    setError(null)
    try {
      await api.startSession(date, app, minutes)
      await refresh()
      navigate('/session')
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} disabled={!unlimited && available < SESSION_LENGTHS[0]}>
        {!unlimited && available < SESSION_LENGTHS[0] ? 'Nothing to spend yet' : 'Start a session'}
      </Button>
    )
  }

  return (
    <Card className="flex flex-col gap-3">
      <p className="text-sm text-gray-400">Which app?</p>
      <div className="grid grid-cols-2 gap-2">
        {TRACKED_APPS.map((name) => (
          <button
            key={name}
            onClick={() => setApp(name)}
            className={`rounded px-2 py-2 text-sm font-medium ${
              app === name ? 'bg-emerald-500 text-gray-900' : 'bg-gray-700 text-gray-200'
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      <p className="text-sm text-gray-400">How long?</p>
      <div className="grid grid-cols-4 gap-2">
        {SESSION_LENGTHS.map((m) => (
          <button
            key={m}
            onClick={() => setMinutes(m)}
            disabled={!canAfford(m)}
            className={`rounded px-2 py-2 text-sm font-bold disabled:opacity-30 ${
              minutes === m ? 'bg-emerald-500 text-gray-900' : 'bg-gray-700 text-gray-200'
            }`}
          >
            {m}m
          </button>
        ))}
      </div>

      <ErrorNote>{error}</ErrorNote>

      <Button onClick={start} disabled={busy || !canAfford(minutes)}>
        {busy ? 'Starting…' : `Spend ${minutes} min on ${app}`}
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <p className="text-xs text-gray-500">
        Honor system: the timer doesn't block anything. Only open {app} while it's running — that
        promise is the experiment.
      </p>
    </Card>
  )
}
