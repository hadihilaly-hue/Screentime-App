import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as api from '../lib/api'
import { Button, Card, ErrorNote, Screen, TierBadge } from '../components/ui'
import type { AppConfig, Task, Tier } from '../lib/types'
import { transcriptKey } from './MorningGate'

const TIERS: Tier[] = [1, 2, 3]

export function TaskReview({
  userId,
  date,
  tasks,
  config,
  confirmed,
  refresh,
}: {
  userId: string
  date: string
  tasks: Task[]
  config: AppConfig
  confirmed: boolean
  refresh: () => Promise<void>
}) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newTier, setNewTier] = useState<Tier>(2)
  const [dragging, setDragging] = useState<string | null>(null)

  const potential = tasks.reduce((sum, t) => sum + api.minutesForTier(config, t.tier), 0)
  const capped = Math.min(potential, config.daily_cap_minutes)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const setTier = (task: Task, tier: Tier) => run(() => api.updateTask(task.id, { tier }))
  const rename = (task: Task, title: string) =>
    title.trim() && title !== task.title ? run(() => api.updateTask(task.id, { title: title.trim() })) : undefined

  function move(from: number, to: number) {
    if (to < 0 || to >= tasks.length || from === to) return
    const next = [...tasks]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    void run(() => api.reorderTasks(next))
  }

  async function addTask() {
    const title = newTitle.trim()
    if (!title) return
    await run(() =>
      api.insertTasks(
        userId,
        date,
        [{ title, tier: newTier, proof_hint: '', self_report_only: false, claude_suggested_tier: newTier }],
        confirmed,
        tasks.length,
      ),
    )
    setNewTitle('')
  }

  async function confirm() {
    await run(async () => {
      await api.confirmDay(date, localStorage.getItem(transcriptKey(date)))
    })
    navigate('/')
  }

  return (
    <Screen>
      <div className="flex flex-1 flex-col gap-4 py-8">
        <div>
          <p className="text-sm uppercase tracking-wide text-gray-500">
            {confirmed ? 'Editing a confirmed list' : 'Task review'}
          </p>
          <h1 className="mt-1 text-2xl font-bold">
            {confirmed ? "Today's list" : 'Check the list before you commit'}
          </h1>
          <p className="mt-2 text-sm text-gray-400">
            Worth <span className="font-bold text-emerald-400">{capped} min</span> if you finish
            and prove all of it
            {potential > config.daily_cap_minutes && ` (${potential} before the ${config.daily_cap_minutes} min daily cap)`}
            .
          </p>
          {confirmed && (
            <p className="mt-2 text-sm text-amber-300">
              You already confirmed today. Anything you add now is flagged as a late addition in
              Sunday's review.
            </p>
          )}
        </div>

        <ErrorNote>{error}</ErrorNote>

        <ul className="flex flex-col gap-2">
          {tasks.map((task, i) => {
            const overridden =
              task.claude_suggested_tier !== null && task.claude_suggested_tier !== task.tier
            return (
              <li
                key={task.id}
                draggable
                onDragStart={() => setDragging(task.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const from = tasks.findIndex((t) => t.id === dragging)
                  if (from >= 0) move(from, i)
                  setDragging(null)
                }}
              >
                <Card className={dragging === task.id ? 'opacity-50' : ''}>
                  <div className="flex items-start gap-2">
                    <div className="flex flex-col gap-1 pt-1">
                      <button
                        aria-label="Move up"
                        className="text-gray-500 hover:text-gray-200"
                        onClick={() => move(i, i - 1)}
                      >
                        ▲
                      </button>
                      <button
                        aria-label="Move down"
                        className="text-gray-500 hover:text-gray-200"
                        onClick={() => move(i, i + 1)}
                      >
                        ▼
                      </button>
                    </div>
                    <div className="flex-1">
                      <input
                        defaultValue={task.title}
                        onBlur={(e) => rename(task, e.target.value)}
                        className="w-full rounded bg-transparent text-base font-medium focus:bg-gray-900 focus:px-2 focus:py-1"
                      />
                      {task.proof_hint && (
                        <p className="mt-1 text-xs text-gray-500">Proof: {task.proof_hint}</p>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        {TIERS.map((tier) => (
                          <button
                            key={tier}
                            onClick={() => setTier(task, tier)}
                            disabled={busy}
                            className={`rounded px-2 py-1 text-xs font-bold ${
                              task.tier === tier
                                ? 'bg-emerald-500 text-gray-900'
                                : 'bg-gray-700 text-gray-300'
                            }`}
                          >
                            T{tier} · {api.minutesForTier(config, tier)}m
                          </button>
                        ))}
                        {!confirmed && (
                          <button
                            onClick={() => run(() => api.deleteTask(task.id))}
                            disabled={busy}
                            className="ml-auto text-xs text-red-400"
                          >
                            delete
                          </button>
                        )}
                      </div>
                      {overridden && (
                        <p className="mt-2 text-xs text-amber-300">
                          Claude said T{task.claude_suggested_tier}. Your override is logged.
                        </p>
                      )}
                    </div>
                    <TierBadge tier={task.tier} overridden={overridden} />
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>

        {tasks.length === 0 && (
          <p className="text-sm text-gray-500">
            Nothing here yet. Add tasks below, or go back and let Claude structure your ramble.
          </p>
        )}

        <Card className="flex flex-col gap-2">
          <label className="text-sm text-gray-400" htmlFor="new-task">
            Add a task
          </label>
          <input
            id="new-task"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTask()}
            placeholder="e.g. Annotate chapter 7"
            className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-base"
          />
          <div className="flex gap-2">
            {TIERS.map((tier) => (
              <button
                key={tier}
                onClick={() => setNewTier(tier)}
                className={`flex-1 rounded px-2 py-2 text-xs font-bold ${
                  newTier === tier ? 'bg-emerald-500 text-gray-900' : 'bg-gray-700 text-gray-300'
                }`}
              >
                T{tier} · {api.minutesForTier(config, tier)}m
              </button>
            ))}
          </div>
          <Button variant="secondary" onClick={addTask} disabled={busy || !newTitle.trim()}>
            Add
          </Button>
        </Card>

        <div className="mt-auto flex flex-col gap-2 pt-4">
          {confirmed ? (
            <Button onClick={() => navigate('/')}>Back to dashboard</Button>
          ) : (
            <>
              <Button onClick={confirm} disabled={busy || tasks.length === 0}>
                Confirm — lock in today
              </Button>
              <Button variant="ghost" onClick={() => navigate('/gate')}>
                Back to the gate
              </Button>
            </>
          )}
        </div>
      </div>
    </Screen>
  )
}
