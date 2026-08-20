import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  completeTask,
  getActiveSession,
  getBalance,
  listTasks,
  type Balance,
  type Task,
} from '../lib/db'
import {
  DAILY_CAP_MINUTES,
  SESSION_LENGTHS,
  TIER_LABELS,
  TIER_MINUTES,
  type Tier,
} from '../lib/constants'
import { clockLabel, phaseAt, spendOpensAt, untilLabel } from '../lib/schedule'
import { IconCheck, Spinner } from '../ui'

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
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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

  // The window and the countdown to it are read off the clock, so the clock has
  // to tick: at 6:00pm this screen has to stop saying "spendable at 6:00 PM"
  // without anyone reloading it.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [])

  async function onComplete(task: Task) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const granted = await completeTask(userId, task)
      // Silently not moving the balance is the expected end state of a
      // productive day, so it has to be said out loud rather than looking broken.
      if (granted === 0) {
        setNotice(`Done — but you have hit the ${DAILY_CAP_MINUTES} minute daily cap, so no minutes were added.`)
      } else if (granted < TIER_MINUTES[task.tier]) {
        setNotice(`Done — ${granted} min added instead of ${TIER_MINUTES[task.tier]}, the daily cap is close.`)
      }
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  if (!balance) return <Spinner />

  const open = tasks.filter((t) => t.status === 'todo')
  const capPct = Math.min(100, (balance.minutes_earned_total / DAILY_CAP_MINUTES) * 100)
  const phase = phaseAt(now)
  // "Spendable" is the balance *and* the window, per spec section 3A. Before
  // 6pm a growing number that buys nothing has to say so, or it reads as a bug.
  const spendableNow = phase.kind === 'spend' && balance.minutes_available > 0
  const opensAt = spendOpensAt(now)

  return (
    <section className="fade-up">
      {/* --- balance ------------------------------------------------------
          The one number the whole app exists to move. */}
      <div className="pt-2 pb-7">
        <p className="eyebrow">Balance</p>
        <div className="mt-2 flex items-end gap-3">
          <span
            className={`numeral text-[5.5rem] ${spendableNow ? 'text-acid' : 'text-fg'}`}
          >
            {balance.minutes_available}
          </span>
          <span className="pb-3 text-[0.9375rem] leading-tight font-semibold text-muted">
            {phase.kind === 'spend' ? (
              <>
                minutes
                <br />
                available
              </>
            ) : (
              <>
                minutes
                <br />
                <span className="text-ember">spendable at {clockLabel(opensAt)}</span>
              </>
            )}
          </span>
        </div>

        {phase.kind !== 'spend' && (
          <p className="mt-3 text-[0.8125rem] leading-snug text-faint">
            {phase.kind === 'open'
              ? `Open window — nothing is blocked until ${clockLabel(phase.endsAt)}. The spend window is ${clockLabel(opensAt)} to midnight.`
              : `Locked until ${clockLabel(phase.endsAt)}. Minutes you earn now are waiting for you — spending opens in ${untilLabel(opensAt, now)}.`}
          </p>
        )}

        <div className="mt-5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-hi">
            <div
              className="h-full rounded-full bg-acid transition-[width] duration-500 ease-out"
              style={{ width: `${capPct}%` }}
            />
          </div>
          <p className="mt-2 text-[0.8125rem] font-medium text-faint">
            Earned today {balance.minutes_earned_total} / {DAILY_CAP_MINUTES}
          </p>
        </div>
      </div>

      {notice && <p className="banner banner-warn mb-4">{notice}</p>}
      {error && <p className="banner banner-error mb-4">{error}</p>}

      {/* --- tasks --------------------------------------------------------- */}
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold tracking-[-0.02em]">Today's tasks</h2>
        <button onClick={() => navigate('/review')} className="press text-sm font-semibold text-muted">
          Edit list
        </button>
      </div>

      {/* Grouped by tier, per spec section 2 step 3. */}
      {([1, 2, 3] as Tier[]).map((tier) => {
        const inTier = tasks.filter((t) => t.tier === tier)
        if (inTier.length === 0) return null
        return (
          <div key={tier} className="mt-5">
            <h3 className="eyebrow">{TIER_LABELS[tier]}</h3>
            <ul className="mt-2.5 flex flex-col gap-2">
              {inTier.map((task) => {
                const done = task.status === 'verified' || task.status === 'cancelled'
                return (
                  <li
                    key={task.id}
                    className={`card flex items-center gap-3 px-4 py-3.5 ${done ? 'opacity-55' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-[0.9375rem] font-semibold leading-snug ${
                          done ? 'line-through decoration-faint' : ''
                        }`}
                      >
                        {task.title}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[0.75rem] font-bold text-acid">
                          {TIER_MINUTES[task.tier]}m
                        </span>
                        <span className="text-[0.75rem] text-faint">
                          · {STATUS_LABEL[task.status]}
                        </span>
                        {task.created_after_confirmation && (
                          <span className="tag tag-warn">added late</span>
                        )}
                        {task.edited_after_confirmation && (
                          <span className="tag tag-warn">edited late</span>
                        )}
                      </div>
                    </div>
                    {task.status === 'todo' && (
                      <button
                        aria-label={`Mark "${task.title}" done`}
                        disabled={busy}
                        onClick={() => onComplete(task)}
                        className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-faint disabled:opacity-40 active:border-acid active:bg-acid active:text-ink"
                      >
                        <IconCheck />
                      </button>
                    )}
                    {task.status === 'verified' && (
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-acid/15 text-acid">
                        <IconCheck />
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}

      {open.length === 0 && tasks.length > 0 && (
        <p className="mt-4 text-[0.8125rem] text-faint">
          Nothing open. Full-completion bonus lands in Weekend 2.
        </p>
      )}

      {/* --- spend ---------------------------------------------------------
          Read-only since spec section 3A: the open IS the session start, so
          this panel explains where and when, and starts nothing. The lengths
          are shown because knowing what a session costs is what makes the
          balance mean anything before you are standing at the door. */}
      <div className="mt-9">
        <h2 className="text-lg font-bold tracking-[-0.02em]">Spending</h2>

        <div className="card mt-3 px-4 py-4">
          <p className="text-[0.9375rem] leading-snug font-semibold">
            {phase.kind === 'spend'
              ? `Open a tracked site. Pick a length there — the window closes at ${clockLabel(phase.endsAt)}.`
              : `Locked until ${clockLabel(opensAt)}.`}
          </p>
          <p className="mt-1.5 text-[0.8125rem] leading-snug text-muted">
            {phase.kind === 'spend'
              ? 'The block page is where sessions start now. Choosing at the door, with the balance in front of you, is the same decision with the cost attached.'
              : 'Earning works at every hour — finish a task now and the minutes are there when the window opens.'}
          </p>

          <div className="mt-3.5 flex gap-2">
            {SESSION_LENGTHS.map((minutes) => (
              <span
                key={minutes}
                className={`flex flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl border border-line py-3 ${
                  phase.kind === 'spend' && balance.minutes_available >= minutes
                    ? 'text-fg'
                    : 'text-faint opacity-45'
                }`}
              >
                <span className="numeral text-xl">{minutes}</span>
                <span className="text-[0.625rem] font-semibold tracking-wide text-faint">MIN</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
