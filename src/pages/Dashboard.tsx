import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  completeTask,
  getActiveSession,
  getBalance,
  listTasks,
  startSession,
  type Balance,
  type Task,
} from '../lib/db'
import { DAILY_CAP_MINUTES, SESSION_LENGTHS, TIER_MINUTES, TRACKED_APPS } from '../lib/constants'

const STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'todo',
  pending: 'pending proof',
  verified: 'verified',
  rejected: 'rejected',
  cancelled: 'cancelled',
}

/** Spec section 4 screen 3. */
export default function Dashboard({ userId }: { userId: string }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [balance, setBalance] = useState<Balance | null>(null)
  const [app, setApp] = useState(TRACKED_APPS[0])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const reload = useCallback(async () => {
    try {
      const active = await getActiveSession(userId)
      if (active) {
        navigate('/session')
        return
      }
      setTasks(await listTasks(userId))
      setBalance(await getBalance(userId))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [userId, navigate])

  useEffect(() => {
    void reload()
  }, [reload])

  async function onComplete(task: Task) {
    setBusy(true)
    setError(null)
    try {
      await completeTask(userId, task)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  async function onStart(minutes: number) {
    setBusy(true)
    setError(null)
    try {
      await startSession(userId, app, minutes)
      navigate('/session')
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  if (!balance) return <p>Loading...</p>

  const open = tasks.filter((t) => t.status === 'todo')

  return (
    <section>
      <p className="text-6xl font-bold">{balance.minutes_available}</p>
      <p className="text-gray-600">minutes available</p>
      <p className="mt-1 text-sm text-gray-500">
        Earned today: {balance.minutes_earned_total} / {DAILY_CAP_MINUTES}
      </p>

      <h2 className="mt-6 text-xl font-bold">Today's tasks</h2>
      <ul className="mt-2 flex flex-col gap-2">
        {tasks.map((task) => (
          <li key={task.id} className="flex flex-wrap items-center gap-2 border p-2">
            <span className={task.status === 'verified' || task.status === 'cancelled' ? 'line-through' : ''}>
              {task.title}
            </span>
            <span className="text-sm text-gray-500">
              T{task.tier} · {TIER_MINUTES[task.tier]}m · {STATUS_LABEL[task.status]}
            </span>
            {task.created_after_confirmation && <span className="text-sm text-amber-700">added late</span>}
            {task.status === 'todo' && (
              <button disabled={busy} onClick={() => onComplete(task)} className="ml-auto border px-2 py-1 text-sm">
                Mark done
              </button>
            )}
          </li>
        ))}
      </ul>
      <button onClick={() => navigate('/review')} className="mt-2 text-sm underline">
        Edit list
      </button>
      {open.length === 0 && tasks.length > 0 && (
        <p className="mt-2 text-sm text-gray-500">Nothing open. Full-completion bonus lands in Weekend 2.</p>
      )}

      <h2 className="mt-6 text-xl font-bold">Spend minutes</h2>
      <select value={app} onChange={(e) => setApp(e.target.value)} className="mt-2 border p-2">
        {TRACKED_APPS.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <div className="mt-2 flex flex-wrap gap-2">
        {SESSION_LENGTHS.map((minutes) => (
          <button
            key={minutes}
            disabled={busy || balance.minutes_available < minutes}
            onClick={() => onStart(minutes)}
            className="border px-3 py-2 disabled:opacity-40"
          >
            {minutes} min
          </button>
        ))}
      </div>

      {error && <p className="mt-4 text-red-600">{error}</p>}
    </section>
  )
}
