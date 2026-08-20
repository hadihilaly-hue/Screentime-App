import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { addTasks, cancelTask, confirmList, deleteTask, listTasks, updateTask, type DailyState, type Task } from '../lib/db'
import { TIER_MINUTES, type Tier } from '../lib/constants'
import { IconBack, IconClose, IconPlus, IconTrash, Screen } from '../ui'

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

  const potential = tasks
    .filter((t) => t.status !== 'cancelled')
    .reduce((sum, t) => sum + TIER_MINUTES[t.tier], 0)

  return (
    <Screen
      eyebrow={confirmed ? 'Locked in' : 'Step 2 of 2'}
      title="Today's list"
      subtitle={
        confirmed
          ? 'Anything added now is flagged, and tasks can only be cancelled.'
          : 'Set a tier for each one. Confirming locks the list for the day.'
      }
    >
      <div className="card mb-5 flex items-baseline gap-2 px-4 py-3">
        <span className="numeral text-2xl text-acid">{potential}</span>
        <span className="text-sm text-muted">minutes on the table today</span>
      </div>

      <ul className="flex flex-col gap-3">
        {tasks.map((task) => {
          const dead = task.status === 'cancelled' || task.status === 'rejected'
          return (
            <li key={task.id} className={`card px-4 py-3.5 ${dead ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-3">
                <input
                  defaultValue={task.title}
                  onBlur={(e) => {
                    const title = e.target.value.trim()
                    if (title && title !== task.title) {
                      run(() => updateTask(task.id, { title }, confirmed))
                    }
                  }}
                  className="field-bare flex-1 py-0.5"
                />
                {confirmed
                  ? // Only open work can be cancelled. Cancelling a verified task would
                    // erase the record while its minutes stayed banked.
                    task.status === 'todo' && (
                      <button
                        aria-label="Cancel task"
                        disabled={busy}
                        onClick={() => run(() => cancelTask(task.id))}
                        className="press -mr-1 -mt-1 rounded-lg p-1.5 text-faint active:text-alert"
                      >
                        <IconClose className="h-4 w-4" />
                      </button>
                    )
                  : (
                    <button
                      aria-label="Delete task"
                      disabled={busy}
                      onClick={() => run(() => deleteTask(task.id))}
                      className="press -mr-1 -mt-1 rounded-lg p-1.5 text-faint active:text-alert"
                    >
                      <IconTrash className="h-4 w-4" />
                    </button>
                  )}
              </div>

              <div className="mt-3">
                {confirmed ? (
                  // Re-tiering after confirmation would let a Tier 3 task be bumped to
                  // Tier 1 for four times the minutes. This is a UI lock only —
                  // tasks_update has no tier or confirmation guard, so the console
                  // still gets through. Per spec section 7, Phase 1 measures
                  // cheating rather than preventing it.
                  <span className="tag tag-good">
                    T{task.tier} · {TIER_MINUTES[task.tier]}m
                  </span>
                ) : (
                  <div className="grid grid-cols-3 gap-1 rounded-xl bg-panel-hi p-1">
                    {([1, 2, 3] as Tier[]).map((tier) => (
                      <button
                        key={tier}
                        disabled={busy}
                        onClick={() => run(() => updateTask(task.id, { tier }))}
                        className={`press rounded-lg py-2 text-[0.8125rem] font-semibold disabled:opacity-50 ${
                          task.tier === tier ? 'bg-acid text-ink' : 'text-muted'
                        }`}
                      >
                        T{tier} · {TIER_MINUTES[tier]}m
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {(task.created_after_confirmation ||
                task.edited_after_confirmation ||
                task.status !== 'todo') && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {task.created_after_confirmation && <span className="tag tag-warn">added late</span>}
                  {task.edited_after_confirmation && <span className="tag tag-warn">edited late</span>}
                  {task.status !== 'todo' && <span className="tag">{task.status}</span>}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <form onSubmit={onAdd} className="mt-4 flex gap-2">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add another task"
          className="field flex-1"
        />
        <button
          type="submit"
          aria-label="Add task"
          disabled={busy || !newTitle.trim()}
          className="press btn btn-secondary aspect-square min-h-0 w-[3.25rem] px-0"
        >
          <IconPlus />
        </button>
      </form>

      {!confirmed && (
        <div className="sticky bottom-0 -mx-5 mt-6 bg-gradient-to-t from-ink via-ink to-transparent px-5 pt-6 pb-2">
          <button
            onClick={onConfirm}
            disabled={busy || tasks.length === 0}
            className="press btn btn-primary w-full"
          >
            {busy ? 'Locking…' : "Confirm today's list"}
          </button>
        </div>
      )}
      {confirmed && (
        <button onClick={() => navigate('/dashboard')} className="press btn btn-ghost mt-5 w-full">
          <IconBack className="h-4 w-4" />
          Back to dashboard
        </button>
      )}
      {error && <p className="banner banner-error mt-4">{error}</p>}
    </Screen>
  )
}
