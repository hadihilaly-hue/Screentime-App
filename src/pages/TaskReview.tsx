import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { addTasks, cancelTask, confirmList, deleteTask, listTasks, updateTask, type DailyState, type Task } from '../lib/db'
import { TIER_MINUTES, type Tier } from '../lib/constants'

/**
 * Spec section 4 screen 2. Re-tier, edit, delete, add, then confirm — which
 * locks the list. After confirmation tasks can still be added, but they are
 * flagged, and they can only be cancelled, never deleted.
 */
export default function TaskReview({
  userId,
  day,
  onConfirmed,
}: {
  userId: string
  day: DailyState
  onConfirmed: (day: DailyState) => void
}) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const reload = useCallback(() => {
    listTasks(userId)
      .then(setTasks)
      .catch((e: Error) => setError(e.message))
  }, [userId])

  useEffect(reload, [reload])

  const confirmed = day.list_confirmed

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title) return
    await run(async () => {
      await addTasks(userId, [title], confirmed)
      setNewTitle('')
    })
  }

  async function onConfirm() {
    await run(async () => {
      const next = await confirmList(userId)
      onConfirmed(next)
      navigate("/dashboard")
    })
  }

  return (
    <section>
      <h1 className="text-2xl font-bold">Today's list</h1>
      <p className="mt-2 text-gray-600">
        {confirmed
          ? 'Locked in. Anything added now is flagged, and tasks can only be cancelled.'
          : 'Set a tier for each one. Confirming locks the list for the day.'}
      </p>

      <ul className="mt-4 flex flex-col gap-3">
        {tasks.map((task) => (
          <li key={task.id} className="border p-2">
            <input
              defaultValue={task.title}
              onBlur={(e) => {
                const title = e.target.value.trim()
                if (title && title !== task.title) {
                  run(() => updateTask(task.id, { title }, confirmed))
                }
              }}
              className="w-full border p-1"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              {confirmed ? (
                // Re-tiering after confirmation would let a Tier 3 task be bumped to
                // Tier 1 for four times the minutes. This is a UI lock only —
                // tasks_update has no tier or confirmation guard, so the console
                // still gets through. Per spec section 7, Phase 1 measures
                // cheating rather than preventing it.
                <span className="border px-2 py-1">
                  T{task.tier} · {TIER_MINUTES[task.tier]}m
                </span>
              ) : (
                ([1, 2, 3] as Tier[]).map((tier) => (
                  <button
                    key={tier}
                    disabled={busy}
                    onClick={() => run(() => updateTask(task.id, { tier }))}
                    className={`border px-2 py-1 ${task.tier === tier ? 'bg-gray-900 text-white' : ''}`}
                  >
                    T{tier} · {TIER_MINUTES[tier]}m
                  </button>
                ))
              )}
              {confirmed ? (
                // Only open work can be cancelled. Cancelling a verified task would
                // erase the record while its minutes stayed banked.
                task.status === 'todo' && (
                  <button disabled={busy} onClick={() => run(() => cancelTask(task.id))} className="underline">
                    cancel
                  </button>
                )
              ) : (
                <button disabled={busy} onClick={() => run(() => deleteTask(task.id))} className="underline">
                  delete
                </button>
              )}
              {task.created_after_confirmation && <span className="text-amber-700">added late</span>}
              {task.edited_after_confirmation && <span className="text-amber-700">edited late</span>}
              {task.status !== 'todo' && <span className="text-gray-500">{task.status}</span>}
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={onAdd} className="mt-4 flex gap-2">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="add another task"
          className="flex-1 border p-2"
        />
        <button type="submit" disabled={busy} className="border px-3">
          Add
        </button>
      </form>

      {!confirmed && (
        <button
          onClick={onConfirm}
          disabled={busy || tasks.length === 0}
          className="mt-6 w-full border bg-gray-900 p-2 text-white disabled:opacity-40"
        >
          Confirm today's list
        </button>
      )}
      {confirmed && (
        <button onClick={() => navigate('/dashboard')} className="mt-6 underline">
          Back to dashboard
        </button>
      )}
      {error && <p className="mt-4 text-red-600">{error}</p>}
    </section>
  )
}
